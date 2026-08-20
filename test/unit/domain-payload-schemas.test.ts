import { describe, expect, it } from "vitest";

import {
  assessmentInputPayload,
  disputeSubmissionPayload,
  domainPayloadSchemas,
  listingTermsPayload,
} from "../../src/schemas/index.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const id = (kind: string) => `urn:evllm:${kind}:${uuid}`;
const versioned = { id: id("profile"), version: 1 };
const quantity = { value: "1", unit_id: id("unit"), unit_version: 1 };
const range = { lower: "1", upper: "2" };
const money = {
  amount: "1",
  currency: "USD",
  currency_profile_id: id("profile"),
  currency_profile_version: 1,
};

describe("protected domain payload schemas", () => {
  it("covers all ten protected-bundle types with distinct assessment input/result contracts", () => {
    expect(Object.keys(domainPayloadSchemas)).toHaveLength(11);
  });

  it("rejects a listing whose signed reference points at another bundle type", () => {
    const payload = {
      schema: "EVLLM_LISTING_TERMS_PAYLOAD_V1",
      listing_id: id("listing"),
      listing_version: 1,
      battery_id: id("battery"),
      owner_organization_id: id("org"),
      terms_commitment: sha256(),
      evidence_access_policy: versioned,
      test_price: `0x${"0".repeat(63)}1`,
      seller_payout_address: `0x${"a".repeat(40)}`,
      binding_actor_id: id("actor"),
      binding_time: 1,
      expires_at: 2,
      protected_bundle_ref: protectedRef("evidence", "evidence"),
    };
    expect(listingTermsPayload.safeParse(payload).success).toBe(false);
  });

  it("requires exactly one dispute scope selected by the signed discriminator", () => {
    const payload = {
      schema: "EVLLM_DISPUTE_SUBMISSION_PAYLOAD_V1",
      dispute_id: id("dispute"),
      dispute_version: 1,
      dispute_type: "evidence",
      claim_scope: { id: id("claim"), version: 1 },
      agreement_scope: { id: id("agreement"), version: 1 },
      opener_actor_id: id("actor"),
      opener_organization_id: id("org"),
      reason: "conflicting evidence",
      evidence_commitments: [sha256()],
      submitted_at: 1,
      protected_bundle_ref: protectedRef("dispute", "dispute"),
    };
    expect(disputeSubmissionPayload.safeParse(payload).success).toBe(false);
  });

  it("freezes the formal assessment route set and ordering", () => {
    const route = (route_id: string) => ({
      route_id,
      application: "test",
      location: "AE",
      functional_unit: quantity,
      duty_context: "bounded",
      service_life: range,
      transport_burden: quantity,
      testing_burden: quantity,
      energy_context: "profiled",
      displaced_alternative: "profiled",
      recovery_process: "profiled",
      inventories: [quantity],
      factors: [quantity],
      economic_assumptions: [money],
      uncertainty: [{ probability: "0.5", value: "1" }],
    });
    const payload = {
      schema: "EVLLM_ASSESSMENT_INPUT_PAYLOAD_V1",
      assessment_input_id: id("assessment"),
      assessment_input_version: 1,
      battery_id: id("battery"),
      jurisdiction: "AE",
      as_of: 1,
      evidence: [{ id: id("evidence"), version: 1 }],
      rules: [],
      method: versioned,
      calculation_inputs_digest: sha256(),
      candidate_routes: [
        route("continued-compatible-ev-use"),
        route("stationary-storage-repurposing"),
        route("recycling"),
      ],
      issuer_organization_id: id("org"),
      issuer_role_id: id("role"),
      issued_at: 1,
      protected_bundle_ref: protectedRef("assessment", "assessment"),
    };
    expect(assessmentInputPayload.safeParse(payload).success).toBe(true);
    expect(
      assessmentInputPayload.safeParse({
        ...payload,
        candidate_routes: [...payload.candidate_routes].reverse(),
      }).success,
    ).toBe(false);
  });
});

function protectedRef(bundle_type: string, kind: string) {
  return {
    schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
    bundle_id: id("bundle"),
    bundle_version: 1,
    bundle_type,
    domain_resource_id: id(kind),
    domain_resource_version: 1,
    custody_controller_org_id: id("org"),
    content_schema_id: id("schema"),
    content_schema_version: "1.0.0",
    initial_criticality_class: "decision-critical",
    criticality_profile_id: id("profile"),
    criticality_profile_version: 1,
  };
}

function sha256() {
  return { alg: "SHA-256", value: "A".repeat(43) };
}
