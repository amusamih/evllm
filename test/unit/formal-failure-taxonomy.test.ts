import { describe, expect, it } from "vitest";

import {
  FORMAL_FAILURE_CATEGORIES,
  descriptiveFailureCategories,
  type FormalFailureTaxonomyInput,
} from "../../scripts/lib/formal-failure-taxonomy.js";

const failed: FormalFailureTaxonomyInput = {
  raw_validation_codes: [],
  validation_codes: [],
  transport_attempts: 1,
  score: {
    task_success: 0,
    appropriate_outcome: 1,
    decision_correct: 1,
    required_record_coverage: 1,
    unsupported_claim_rate: 0,
    authorization_accuracy: 1,
    prohibited_disclosure_count: 0,
  },
};

describe("formal failure taxonomy", () => {
  it("publishes only categories that have an operational attribution rule", () => {
    expect(FORMAL_FAILURE_CATEGORIES).toEqual([
      "retrieval",
      "reasoning",
      "generation",
      "policy",
      "external-service",
    ]);
    expect(FORMAL_FAILURE_CATEGORIES).not.toContain("implementation");
  });

  it("does not label successful evidence-state preconditions as failures", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        validation_codes: ["missing-support", "inactive-support"],
        score: { ...failed.score, task_success: 1 },
      }),
    ).toEqual([]);
  });

  it("reserves retrieval for a retrieval-verification failure", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        validation_codes: ["retrieval-verification-failed"],
      }),
    ).toEqual(["retrieval"]);
  });

  it("uses raw validator codes for a governed fallback", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        raw_validation_codes: ["unsupported-user-visible-text"],
        validation_codes: ["unsupported-user-visible-text"],
        score: { ...failed.score, appropriate_outcome: 0 },
      }),
    ).toEqual(["reasoning", "generation"]);
  });

  it("retains generation failures when output validation is disabled", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        raw_validation_codes: ["unsupported-claim"],
      }),
    ).toEqual(["generation"]);
  });

  it("categorizes typed-decision failures instead of leaving them unclassified", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        raw_validation_codes: [
          "recorded-decision-mismatch",
          "recorded-decision-summary-code-missing",
        ],
      }),
    ).toEqual(["reasoning", "generation"]);
    expect(
      descriptiveFailureCategories({
        ...failed,
        validation_codes: ["recorded-decision-semantic-contradiction"],
      }),
    ).toEqual(["reasoning"]);
    expect(
      descriptiveFailureCategories({
        ...failed,
        score: { ...failed.score, decision_correct: 0 },
      }),
    ).toEqual(["reasoning"]);
  });

  it("identifies authorization or disclosure failures as policy failures", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        score: {
          ...failed.score,
          authorization_accuracy: 0,
          prohibited_disclosure_count: 1,
        },
      }),
    ).toEqual(["policy"]);
  });

  it("does not classify a retry when the observation succeeds", () => {
    expect(
      descriptiveFailureCategories({
        ...failed,
        raw_validation_codes: ["unsupported-claim"],
        validation_codes: ["unsupported-claim"],
        transport_attempts: 2,
        score: { ...failed.score, task_success: 1 },
      }),
    ).toEqual([]);
  });
});
