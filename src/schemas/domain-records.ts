import { z } from "zod";

import {
  base64Url,
  bytes32Hex,
  canonicalAddress,
  digest,
  positiveSafeInteger,
  semver,
  uint256Hex,
  urn,
} from "./common.js";
import { weiAmount } from "./numeric.js";
import { protectedBundleRef } from "./protected-bundle.js";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().min(1).max(256);
const text = z.string().min(1).max(16_384);
const ref = z.object({ id: z.string().min(1), version: positiveSafeInteger }).strict();
const signatureRef = z
  .object({ record_id: urn("assertion"), signature_digest: digest, typed_data_digest: bytes32Hex })
  .strict();
const chainLocator = z
  .object({
    chain_id: positiveSafeInteger,
    transaction_hash: bytes32Hex,
    block_number: z.number().int().nonnegative(),
    log_index: z.number().int().nonnegative(),
  })
  .strict();

export const authoritativeSource = z
  .object({
    schema: z.literal("EVLLM_AUTHORITATIVE_SOURCE_V1"),
    source_id: urn("source"),
    source_version: positiveSafeInteger,
    predecessor_source_version: positiveSafeInteger.optional(),
    successor_source_version: positiveSafeInteger.optional(),
    public_metadata_ref: ref.optional(),
    licensed_payload_ref: ref.optional(),
    domain_signature_record_id: urn("assertion").optional(),
    source_class: z.enum(["legal", "technical"]),
    access_state: z.enum(["public", "licensed", "metadata-only"]),
    licence_state: z.enum(["permitted", "restricted", "unavailable"]),
    review_due_at: timestamp,
    lifecycle: z.enum(["pending", "active", "unavailable", "superseded", "withdrawn", "expired"]),
    transition_actor_id: urn("actor"),
    transition_reason: shortText,
    effective_at: timestamp,
    reviewed_at: timestamp,
    permitted_rule_ids: z.array(urn("rule")).max(256),
    dependent_rule_ids: z.array(urn("rule")).max(256),
  })
  .strict();

export const ruleProfile = z
  .object({
    schema: z.literal("EVLLM_RULE_PROFILE_V1"),
    rule_id: urn("rule"),
    rule_version: positiveSafeInteger,
    source_clauses: z.array(ref).min(1).max(256),
    jurisdiction: shortText,
    effective_from: timestamp,
    effective_until: timestamp.optional(),
    subject_scope: z.array(shortText).min(1).max(128),
    predicates: z.array(shortText).min(1).max(256),
    required_evidence: z.array(shortText).max(256),
    outcomes: z.array(shortText).min(1).max(128),
    reason_codes: z.array(shortText).min(1).max(128),
    status: z.enum(["pending", "active", "disabled", "superseded", "retired"]),
    review_due_at: timestamp,
  })
  .strict();

export const routeAssessmentProfile = z
  .object({
    schema: z.literal("EVLLM_ROUTE_ASSESSMENT_PROFILE_V1"),
    assessment_result_id: urn("assessment"),
    assessment_result_version: positiveSafeInteger,
    result_payload_ref: ref,
    domain_signature_record_id: urn("assertion"),
    input_basis_id: urn("assessment"),
    input_basis_version: positiveSafeInteger,
    resolved_evidence: z.array(ref).min(1).max(512),
    issuer_status: z.enum(["active", "superseded", "revoked"]),
    protected_bundle_state: z.enum(["confirmed", "reorganized", "unavailable"]),
    summary_reason_codes: z.array(shortText).max(128),
  })
  .strict();

export const listing = z
  .object({
    schema: z.literal("EVLLM_LISTING_V1"),
    listing_id: urn("listing"),
    listing_version: z.literal(1),
    terms_payload_ref: ref,
    domain_signature_record_id: urn("assertion"),
    state: z.enum([
      "active",
      "matched",
      "withdrawn",
      "expired",
      "closed-settled",
      "closed-cancelled",
    ]),
    accepted_offer_id: urn("offer").optional(),
    history: z.array(urn("transition")).max(256),
    chain_locators: z.array(chainLocator).max(256),
  })
  .strict();

export const offer = z
  .object({
    schema: z.literal("EVLLM_OFFER_V1"),
    offer_id: urn("offer"),
    offer_version: z.literal(1),
    listing_id: urn("listing"),
    listing_version: z.literal(1),
    buyer_organization_id: urn("org"),
    amount: weiAmount,
    buyer_refund_address: canonicalAddress,
    binding_actor_id: urn("actor"),
    binding_time: timestamp,
    expires_at: timestamp,
    terms_commitment: digest,
    state: z.enum(["submitted", "accepted", "rejected", "withdrawn", "expired"]),
  })
  .strict();

export const agreement = z
  .object({
    schema: z.literal("EVLLM_AGREEMENT_V1"),
    agreement_id: urn("agreement"),
    agreement_version: z.literal(1),
    terms_payload_ref: ref,
    domain_signature_record_id: urn("assertion"),
    seller_selection_id: urn("transition"),
    buyer_confirmation_id: urn("transition").optional(),
    escrow_amount: weiAmount,
    seller_credit: weiAmount,
    buyer_credit: weiAmount,
    confirmation_deadline: timestamp,
    delivery_deadline: timestamp,
    state: z.enum([
      "awaiting-buyer-confirmation",
      "awaiting-funding",
      "funded",
      "in-delivery",
      "delivered",
      "accepted",
      "settled",
      "cancelled",
      "refund-and-cancel",
      "disputed",
      "timed-out-referred",
      "release-and-transfer",
    ]),
    chain_locators: z.array(chainLocator).max(256),
  })
  .strict();

export const deliveryRecord = z
  .object({
    schema: z.literal("EVLLM_DELIVERY_RECORD_V1"),
    delivery_id: urn("delivery"),
    delivery_version: positiveSafeInteger,
    logistics_payload_refs: z.array(ref).min(1).max(256),
    domain_signature_record_ids: z.array(urn("assertion")).min(1).max(256),
    recipient_response: z.enum(["pending", "accepted", "rejected"]),
    state: z.enum(["dispatched", "delivered", "disputed", "closed"]),
    dispute_id: urn("dispute").optional(),
    chain_locators: z.array(chainLocator).max(256),
  })
  .strict();

export const disputeRecord = z
  .object({
    schema: z.literal("EVLLM_DISPUTE_RECORD_V1"),
    dispute_id: urn("dispute"),
    dispute_version: positiveSafeInteger,
    submission_payload_refs: z.array(ref).min(1).max(256),
    domain_signature_record_ids: z.array(urn("assertion")).min(1).max(256),
    state: z.enum(["open", "under-review", "resolved", "rejected", "withdrawn"]),
    resolver_actor_id: urn("actor").optional(),
    outcome: z.enum(["upheld", "rejected", "settled", "withdrawn"]).optional(),
    opened_at: timestamp,
    resolved_at: timestamp.optional(),
    chain_locators: z.array(chainLocator).max(256),
  })
  .strict();

const eip712Domain = z
  .object({
    name: shortText,
    version: shortText,
    chain_id: positiveSafeInteger,
    verifying_contract: canonicalAddress,
  })
  .strict();

export const commandIntent = z
  .object({
    schema: z.literal("EVLLM_COMMAND_INTENT_V1"),
    command_id: urn("command"),
    command_type: shortText,
    command_version: positiveSafeInteger,
    kind: z.enum(["on-chain-transaction", "off-chain-signed"]),
    origin_type: z.enum(["registered-actor", "permissionless-wallet", "service-process"]),
    caller_address: canonicalAddress.optional(),
    caller_process: shortText.optional(),
    actor_id: urn("actor").optional(),
    organization_id: urn("org").optional(),
    resource_id: z.string().startsWith("urn:evllm:"),
    resource_version: positiveSafeInteger,
    purpose_id: urn("policy"),
    preconditions: z.array(shortText).max(256),
    policy_result: z.enum(["allow", "deny"]),
    nonce: uint256Hex,
    issued_at: timestamp,
    expires_at: timestamp,
    idempotency_key_hash: bytes32Hex,
    eip712_domain: eip712Domain.optional(),
    eip712_type: shortText.optional(),
    eip712_payload_digest: bytes32Hex.optional(),
    signer_actor_id: urn("actor").optional(),
    signer_organization_id: urn("org").optional(),
    signer_credential_id: urn("credential").optional(),
    signer_address: canonicalAddress.optional(),
    signature: base64Url.optional(),
    typed_data_digest: bytes32Hex.optional(),
    signature_digest: digest.optional(),
    state: z.enum([
      "prepared",
      "signature-accepted",
      "executing",
      "executed",
      "failed-retryable",
      "failed-terminal",
      "expired",
      "transaction-submitted",
      "transaction-confirmed",
      "transaction-orphaned",
      "transaction-replaced",
      "rejected",
    ]),
    correlation_id: z.uuid(),
    resulting_event_ids: z.array(urn("event")).max(256),
  })
  .strict();

export const auditEvent = z
  .object({
    schema: z.literal("EVLLM_AUDIT_EVENT_V1"),
    correlation_id: z.uuid(),
    event_id: urn("event"),
    event_version: z.literal(1),
    sequence: positiveSafeInteger,
    process: shortText,
    origin_type: z.enum(["registered-actor", "permissionless-wallet", "service-process"]),
    caller_address: canonicalAddress.optional(),
    caller_process: shortText.optional(),
    actor_id: urn("actor").optional(),
    organization_id: urn("org").optional(),
    purpose_id: urn("policy"),
    operation: shortText,
    resource_refs: z.array(ref).max(256),
    policy_result: z.enum(["allow", "deny", "not-applicable"]),
    result_status: shortText,
    permitted_digests: z.array(digest).max(256),
    recorded_at: timestamp,
    previous_event_hash: digest.optional(),
    event_hash: digest,
    privacy_class: z.enum(["public", "minimized", "restricted-reference"]),
  })
  .strict();

export const auditBatchAnchor = z
  .object({
    schema: z.literal("EVLLM_AUDIT_BATCH_ANCHOR_V1"),
    batch_id: urn("batch"),
    batch_version: positiveSafeInteger,
    first_event_sequence: positiveSafeInteger,
    last_event_sequence: positiveSafeInteger,
    event_count: positiveSafeInteger,
    final_event_hash: digest,
    batch_commitment: digest,
    preceding_closed_batch_commitment: digest.optional(),
    profile_id: urn("profile"),
    profile_version: positiveSafeInteger,
    closed_at: timestamp,
    anchor_attempt_ids: z.array(urn("attempt")).max(256),
    confirmation_state: z.enum(["closed", "submitted", "confirmed", "orphaned"]),
    open_tail_first_sequence: positiveSafeInteger.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.last_event_sequence < value.first_event_sequence) {
      context.addIssue({ code: "custom", message: "Invalid event boundary" });
    }
  });

export const assistantRequest = z
  .object({
    schema: z.literal("EVLLM_ASSISTANT_REQUEST_V1"),
    request_id: urn("assistant"),
    request_version: positiveSafeInteger,
    requesting_actor_id: urn("actor"),
    requesting_organization_id: urn("org"),
    minimized_question_metadata: z.array(shortText).max(64),
    minimized_result_metadata: z.array(shortText).max(64),
    response_state: z.enum(["completed", "refused", "failed"]),
    validation_event_ids: z.array(urn("event")).max(256),
    audit_event_id: urn("event"),
    created_at: timestamp,
  })
  .strict();

export const assistantSupportRetentionLink = z
  .object({
    schema: z.literal("EVLLM_ASSISTANT_SUPPORT_RETENTION_LINK_V1"),
    link_id: urn("link"),
    link_version: positiveSafeInteger,
    assistant_request_id: urn("assistant"),
    assistant_request_version: positiveSafeInteger,
    assistant_support_id: urn("assistant"),
    assistant_support_version: positiveSafeInteger,
    protected_bundle_ref: protectedBundleRef,
    attribution_signature_ref: signatureRef,
    finalization_command_id: urn("command"),
    retention_purpose_id: urn("policy"),
    created_at: timestamp,
  })
  .strict();

export const sensitiveAuditRetentionLink = z
  .object({
    schema: z.literal("EVLLM_SENSITIVE_AUDIT_RETENTION_LINK_V1"),
    link_id: urn("link"),
    link_version: positiveSafeInteger,
    source_audit_event_id: urn("event"),
    source_audit_event_version: z.literal(1),
    sensitive_audit_id: urn("audit"),
    sensitive_audit_version: positiveSafeInteger,
    protected_bundle_ref: protectedBundleRef,
    attribution_signature_ref: signatureRef,
    finalization_command_id: urn("command"),
    retention_purpose_id: urn("policy"),
    created_at: timestamp,
  })
  .strict();

export const evaluationCase = z
  .object({
    schema: z.literal("EVLLM_EVALUATION_CASE_V1"),
    case_id: urn("case"),
    case_version: positiveSafeInteger,
    source_class: z.enum(["public-data-replay", "synthetic-generator", "scripted-report"]),
    licence: shortText,
    actor_id: urn("actor"),
    task: text,
    fixture_refs: z.array(ref).min(1).max(256),
    adverse_condition: shortText.optional(),
    expected_state: shortText,
    adjudication_basis: text,
    allowed_outputs: z.array(shortText).min(1).max(256),
    metrics: z.array(shortText).min(1).max(256),
    exclusion_flags: z.array(shortText).max(256),
    schema_version: semver,
  })
  .strict();

export const domainRecordSchemas = {
  authoritativeSource,
  ruleProfile,
  routeAssessmentProfile,
  listing,
  offer,
  agreement,
  deliveryRecord,
  disputeRecord,
  commandIntent,
  auditEvent,
  auditBatchAnchor,
  assistantRequest,
  assistantSupportRetentionLink,
  sensitiveAuditRetentionLink,
  evaluationCase,
};
