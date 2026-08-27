import { z } from "zod";

import { canonicalAddress, digest, positiveSafeInteger, urn } from "./common.js";
import {
  decimalQuantity,
  decimalRange,
  moneyValue,
  percentilePoint,
  weiAmount,
} from "./numeric.js";
import { type BundleType, protectedBundleRef } from "./protected-bundle.js";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(16_384);
const shortText = z.string().min(1).max(256);
const reference = z.object({ id: z.string().min(1), version: positiveSafeInteger }).strict();
const role = urn("role");

function bindReference<T extends z.ZodRawShape>(
  shape: T,
  bundleType: BundleType,
  resourceField: string,
) {
  return z
    .object({ ...shape, protected_bundle_ref: protectedBundleRef })
    .strict()
    .superRefine((value, context) => {
      const record = value as Record<string, unknown> & {
        protected_bundle_ref: z.infer<typeof protectedBundleRef>;
      };
      const resourceId = record[resourceField];
      if (
        record.protected_bundle_ref.bundle_type !== bundleType ||
        record.protected_bundle_ref.domain_resource_id !== resourceId
      ) {
        context.addIssue({ code: "custom", message: "Protected-bundle reference mismatch" });
      }
    });
}

const typedValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("quantity"), quantity: decimalQuantity }).strict(),
  z.object({ type: z.literal("text"), value: text }).strict(),
  z.object({ type: z.literal("boolean"), value: z.boolean() }).strict(),
]);

const uncertainty = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }).strict(),
  z.object({ type: z.literal("range"), range: decimalRange }).strict(),
]);

export const evidenceClaimPayload = bindReference(
  {
    schema: z.literal("EVLLM_EVIDENCE_CLAIM_PAYLOAD_V1"),
    evidence_id: urn("evidence"),
    evidence_version: positiveSafeInteger,
    claim_id: urn("claim"),
    claim_version: positiveSafeInteger,
    claim_type: shortText,
    subject_id: z.union([urn("battery"), urn("claim")]),
    subject_granularity: z.enum(["pack", "module", "cell"]),
    issuer_organization_id: urn("org"),
    issuer_role_id: role,
    observed_at: timestamp,
    submitted_at: timestamp,
    capture_method: reference,
    value: typedValue,
    uncertainty,
    source_class: z.enum(["primary", "secondary", "derived"]),
    provenance: z.array(reference).max(256),
  },
  "evidence",
  "evidence_id",
);

export const verificationPayload = bindReference(
  {
    schema: z.literal("EVLLM_VERIFICATION_PAYLOAD_V1"),
    verification_id: urn("verification"),
    verification_version: positiveSafeInteger,
    assertion_type: z.enum(["corroboration", "certification"]),
    claim_id: urn("claim"),
    claim_version: positiveSafeInteger,
    verifier_organization_id: urn("org"),
    verifier_role_id: role,
    verifier_credential_id: urn("credential"),
    basis_evidence: z.array(reference).min(1).max(256),
    method: reference,
    reason: text,
    verified_at: timestamp,
    valid_until: timestamp.optional(),
  },
  "verification",
  "verification_id",
);

const routeContext = (routeId: string) =>
  z
    .object({
      route_id: z.literal(routeId),
      application: shortText,
      location: shortText,
      functional_unit: decimalQuantity,
      duty_context: text,
      service_life: decimalRange,
      transport_burden: decimalQuantity,
      testing_burden: decimalQuantity,
      energy_context: text,
      displaced_alternative: text,
      recovery_process: text,
      inventories: z.array(decimalQuantity).max(512),
      factors: z.array(decimalQuantity).max(512),
      economic_assumptions: z.array(moneyValue).max(128),
      uncertainty: z.array(percentilePoint).max(101),
    })
    .strict();

export const assessmentInputPayload = bindReference(
  {
    schema: z.literal("EVLLM_ASSESSMENT_INPUT_PAYLOAD_V1"),
    assessment_input_id: urn("assessment"),
    assessment_input_version: positiveSafeInteger,
    battery_id: urn("battery"),
    jurisdiction: shortText,
    as_of: timestamp,
    evidence: z.array(reference).min(1).max(512),
    rules: z.array(reference).max(256),
    method: reference,
    calculation_inputs_digest: digest,
    candidate_routes: z.tuple([
      routeContext("continued-compatible-ev-use"),
      routeContext("stationary-storage-repurposing"),
      routeContext("recycling"),
    ]),
    issuer_organization_id: urn("org"),
    issuer_role_id: role,
    issued_at: timestamp,
  },
  "assessment",
  "assessment_input_id",
);

const routeResult = (routeId: string) =>
  z
    .object({
      route_id: z.literal(routeId),
      G: decimalRange,
      C: decimalRange,
      I: decimalRange,
      E: decimalRange,
      A: decimalRange,
      U: decimalRange,
      percentiles: z.array(percentilePoint).max(101),
      reason_codes: z.array(shortText).max(128),
      missing_inputs: z.array(shortText).max(128),
      conflicting_inputs: z.array(shortText).max(128),
    })
    .strict();

export const assessmentResultPayload = bindReference(
  {
    schema: z.literal("EVLLM_ASSESSMENT_RESULT_PAYLOAD_V1"),
    assessment_result_id: urn("assessment"),
    assessment_result_version: positiveSafeInteger,
    input_basis_id: urn("assessment"),
    input_basis_version: positiveSafeInteger,
    route_results: z.tuple([
      routeResult("continued-compatible-ev-use"),
      routeResult("stationary-storage-repurposing"),
      routeResult("recycling"),
    ]),
    dominance: z.array(shortText).max(128),
    rank_stability: z.array(shortText).max(128),
    arithmetic_profile: reference,
    rounding_profile: reference,
    unit_profile: reference,
    method: reference,
    reproduction_hash: digest,
    issuer_organization_id: urn("org"),
    issuer_role_id: role,
    supersedes: reference.optional(),
  },
  "assessment",
  "assessment_result_id",
);

export const listingTermsPayload = bindReference(
  {
    schema: z.literal("EVLLM_LISTING_TERMS_PAYLOAD_V1"),
    listing_id: urn("listing"),
    listing_version: z.literal(1),
    battery_id: urn("battery"),
    owner_organization_id: urn("org"),
    terms_commitment: digest,
    evidence_access_policy: reference,
    test_price: weiAmount,
    seller_payout_address: canonicalAddress,
    binding_actor_id: urn("actor"),
    binding_time: timestamp,
    expires_at: timestamp,
  },
  "listing",
  "listing_id",
);

export const agreementTermsPayload = bindReference(
  {
    schema: z.literal("EVLLM_AGREEMENT_TERMS_PAYLOAD_V1"),
    agreement_id: urn("agreement"),
    agreement_version: z.literal(1),
    accepted_offer_id: urn("offer"),
    accepted_offer_version: z.literal(1),
    buyer_organization_id: urn("org"),
    seller_organization_id: urn("org"),
    seller_binding_actor_id: urn("actor"),
    amount: weiAmount,
    terms_commitment: digest,
    seller_payout_address: canonicalAddress,
    buyer_refund_address: canonicalAddress,
    confirmation_deadline: timestamp,
    delivery_deadline: timestamp,
  },
  "agreement",
  "agreement_id",
);

export const logisticsReportPayload = bindReference(
  {
    schema: z.literal("EVLLM_LOGISTICS_REPORT_PAYLOAD_V1"),
    delivery_id: urn("delivery"),
    delivery_version: positiveSafeInteger,
    agreement_id: urn("agreement"),
    agreement_version: z.literal(1),
    issuer_actor_id: urn("actor"),
    issuer_organization_id: urn("org"),
    issuer_role_id: role,
    assertion: z.enum(["dispatch", "delivery"]),
    observed_at: timestamp,
    basis_evidence_commitment: digest,
  },
  "logistics",
  "delivery_id",
);

export const disputeSubmissionPayload = bindReference(
  {
    schema: z.literal("EVLLM_DISPUTE_SUBMISSION_PAYLOAD_V1"),
    dispute_id: urn("dispute"),
    dispute_version: positiveSafeInteger,
    dispute_type: z.enum(["evidence", "transaction"]),
    claim_scope: reference.optional(),
    agreement_scope: reference.optional(),
    opener_actor_id: urn("actor"),
    opener_organization_id: urn("org"),
    reason: text,
    evidence_commitments: z.array(digest).max(256),
    submitted_at: timestamp,
  },
  "dispute",
  "dispute_id",
).superRefine((value, context) => {
  const correctScope =
    value.dispute_type === "evidence"
      ? value.claim_scope !== undefined && value.agreement_scope === undefined
      : value.agreement_scope !== undefined && value.claim_scope === undefined;
  if (!correctScope) context.addIssue({ code: "custom", message: "Dispute scope mismatch" });
});

export const sensitiveAuditPayload = bindReference(
  {
    schema: z.literal("EVLLM_SENSITIVE_AUDIT_PAYLOAD_V1"),
    sensitive_audit_id: urn("audit"),
    sensitive_audit_version: positiveSafeInteger,
    source_audit_event_id: urn("event"),
    source_audit_event_version: z.literal(1),
    responsible_actor_id: urn("actor"),
    responsible_organization_id: urn("org"),
    purpose: shortText,
    sensitive_detail_commitment: digest,
    period_start: timestamp,
    period_end: timestamp,
  },
  "audit",
  "sensitive_audit_id",
);

export const assistantSupportPayload = bindReference(
  {
    schema: z.literal("EVLLM_ASSISTANT_SUPPORT_PAYLOAD_V1"),
    assistant_support_id: urn("assistant"),
    assistant_support_version: positiveSafeInteger,
    source_assistant_request_id: urn("assistant"),
    source_assistant_request_version: positiveSafeInteger,
    requesting_actor_id: urn("actor"),
    requesting_organization_id: urn("org"),
    purpose: shortText,
    question: text,
    allowed_tools: z.array(reference).max(64),
    configuration: reference,
    support_references: z.array(reference).max(512),
    deterministic_outputs: z.array(digest).max(512),
    response: text,
    validation_results: z.array(shortText).max(256),
    model: shortText,
    provider: shortText,
    token_count: positiveSafeInteger,
    latency_ms: positiveSafeInteger,
    audit_event_id: urn("event"),
  },
  "assistant-support",
  "assistant_support_id",
);

export const licensedSourcePayload = bindReference(
  {
    schema: z.literal("EVLLM_LICENSED_SOURCE_PAYLOAD_V1"),
    source_id: urn("source"),
    source_version: positiveSafeInteger,
    external_authority: text,
    source_profile_author_actor_id: urn("actor"),
    source_profile_author_organization_id: urn("org"),
    source_profile_author_role_id: role,
    external_title: text,
    external_version: shortText,
    external_edition: shortText,
    jurisdiction: shortText,
    url: z.url(),
    published_at: timestamp,
    in_force_at: timestamp,
    applies_at: timestamp,
    licence_terms: text,
    permitted_use: text,
    snapshot_at: timestamp,
  },
  "authoritative-source",
  "source_id",
);

export const domainPayloadSchemas = {
  evidenceClaimPayload,
  verificationPayload,
  assessmentInputPayload,
  assessmentResultPayload,
  listingTermsPayload,
  agreementTermsPayload,
  logisticsReportPayload,
  disputeSubmissionPayload,
  sensitiveAuditPayload,
  assistantSupportPayload,
  licensedSourcePayload,
};
