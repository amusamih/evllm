import { describe, expect, it } from "vitest";

import { formalCase } from "../../src/evaluation/formal.js";
import {
  isTypedDecisionCase,
  unsupportedClaimResponseEvent,
} from "../../scripts/lib/formal-analysis-metrics.js";

describe("formal analysis metric eligibility", () => {
  it("limits typed-decision fidelity to cases carrying an active typed decision", () => {
    const factual = baseCase();
    const typed = formalCase.parse({
      ...factual,
      query_mode: "explain_recorded_decision",
      supports: [
        {
          ...factual.supports[0],
          recorded_decision: {
            outcome: "answer",
            code: "eligible-for-resale",
            reason_codes: [],
          },
        },
      ],
    });

    expect(isTypedDecisionCase(factual)).toBe(false);
    expect(isTypedDecisionCase(typed)).toBe(true);
  });

  it("counts every response and flags only responses containing an unsupported claim", () => {
    expect(unsupportedClaimResponseEvent({ unsupported_claim_rate: null })).toBe(0);
    expect(unsupportedClaimResponseEvent({ unsupported_claim_rate: 0 })).toBe(0);
    expect(unsupportedClaimResponseEvent({ unsupported_claim_rate: 0.25 })).toBe(1);
    expect(unsupportedClaimResponseEvent({ unsupported_claim_rate: 1 })).toBe(1);
  });
});

function baseCase() {
  return formalCase.parse({
    case_id: "formal-001",
    stratum: "test",
    variant: "nominal",
    fixture_id: "urn:evllm:test:formal-analysis-metrics",
    prompt: "Explain the record.",
    expected_outcome: "answer",
    expected_support_ids: ["support-1"],
    expected_validation_code: null,
    supports: [
      {
        support_id: "support-1",
        resource_id: "urn:evllm:test:support-1",
        resource_version: 1,
        status: "active",
        content: "Battery B-2 has a recorded assessment.",
      },
    ],
    query_mode: "explain_records",
    access_request: {
      organization_id: "organization-requester",
      purpose_id: "second-life-assessment",
    },
    access_grants: [
      { organization_id: "organization-requester", purpose_id: "second-life-assessment" },
    ],
    applicable_conditions: [],
    formal_only: true,
  });
}
