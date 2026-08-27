export interface FormalFailureTaxonomyInput {
  readonly raw_validation_codes: readonly string[];
  readonly validation_codes: readonly string[];
  readonly transport_attempts: number;
  readonly score: Readonly<{
    task_success: number;
    appropriate_outcome: number;
    decision_correct: number;
    required_record_coverage: number | null;
    unsupported_claim_rate: number | null;
    authorization_accuracy: number | null;
    prohibited_disclosure_count: number;
  }>;
}

export const FORMAL_FAILURE_CATEGORIES = [
  "retrieval",
  "reasoning",
  "generation",
  "policy",
  "external-service",
] as const;

export type FormalFailureCategory = (typeof FORMAL_FAILURE_CATEGORIES)[number];

/**
 * Assigns non-exclusive diagnostic categories only to unsuccessful observations.
 * Confirmatory outcomes and statistical tests do not depend on these labels.
 */
export function descriptiveFailureCategories(
  item: FormalFailureTaxonomyInput,
): FormalFailureCategory[] {
  if (item.score.task_success === 1) return [];

  const categories = new Set<FormalFailureCategory>();
  const codes = new Set([...item.raw_validation_codes, ...item.validation_codes]);

  if (codes.has("retrieval-verification-failed")) categories.add("retrieval");
  if (
    item.score.appropriate_outcome === 0 ||
    item.score.decision_correct === 0 ||
    (item.score.required_record_coverage ?? 1) < 1 ||
    codes.has("incoherent-reason-code") ||
    codes.has("deterministic-outcome-mismatch") ||
    [
      "missing-recorded-decision",
      "conflicting-recorded-decision",
      "recorded-decision-mismatch",
      "recorded-decision-contradiction",
      "recorded-decision-semantic-contradiction",
      "recorded-decision-user-visible-code-mismatch",
      "unexpected-decision-code",
      "unbound-decision-assertion",
    ].some((code) => codes.has(code))
  ) {
    categories.add("reasoning");
  }
  if (
    [
      "empty-answer",
      "uncited-claim",
      "invalid-citation",
      "unsupported-claim",
      "unsupported-user-visible-text",
      "prohibited-disclosure",
      "composite-score-claim",
      "recorded-decision-summary-code-missing",
      "recorded-decision-cited-claim-missing",
    ].some((code) => codes.has(code)) ||
    (item.score.unsupported_claim_rate ?? 0) > 0
  ) {
    categories.add("generation");
  }
  if (item.score.authorization_accuracy === 0 || item.score.prohibited_disclosure_count > 0) {
    categories.add("policy");
  }
  if (item.transport_attempts > 1) categories.add("external-service");

  return [...categories];
}
