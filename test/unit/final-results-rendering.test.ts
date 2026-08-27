import { describe, expect, it } from "vitest";

import {
  applicationAssuranceSchema,
  assertFinalResultsInputs,
  evaluationRunSummarySchema,
  primaryAnalysisSchema,
  renderFinalResults,
  sustainabilityValidationSchema,
  synthesisAnalysisSchema,
  type FinalResultsInput,
} from "../../scripts/lib/final-results.js";
import {
  FINAL_PRIMARY_CONDITIONS,
  FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES,
} from "../../src/evaluation/final-freeze.js";

const sourceCommit = "a".repeat(40);
const hash = `0x${"1".repeat(64)}`;
const binding = {
  evaluation_set_id: "evaluation-set",
  source_commit: sourceCommit,
  freeze_sha256: hash,
  corpus_file_sha256: hash,
  logical_corpus_sha256: hash,
};

describe("final result rendering", () => {
  it("renders every result from validated inputs with honest support labels", () => {
    const output = renderFinalResults(fixture());

    expect(output).toContain("Citation-ID validity");
    expect(output).toContain("Decision code and outcome agreement");
    expect(output).toContain("Responses with unsupported claims");
    expect(output).toContain("Released responses failing validation");
    expect(output).not.toContain("Citation correctness");
    expect(output).toContain(
      "support checks are designed to detect specified contradictions and attribution errors",
    );
    expect(output).toContain(
      "Citation-ID validity is calculated only for responses containing citations",
    );
    expect(output).toContain("typed decision attached to the final deterministic record");
    expect(output).toContain("Raw generation observations");
    expect(output).toContain("Missing-information detection");
    expect(output).toContain("Conflicting-information detection");
    expect(output).toContain("62.5% (50.0% to 75.0%)");
    expect(output).toContain("+12.5 pp (+5.0 pp to +20.0 pp)");
    expect(output).toContain("-12.5 pp (-20.0 pp to -5.0 pp)");
    expect(output).toContain("| Released-response validation failures | Plain-context RAG |");
    expect(output).toContain("| Lower | 0.020 |");
    expect(output).toContain("Required reason-code agreement");
    expect(output).not.toContain("Reason-code fidelity");
    expect(output).toContain(
      "| Raw structured records | 4 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |",
    );
    expect(output).toContain(
      "| Sequential deterministic queries | 4 | N/A | N/A | N/A | N/A | N/A | N/A | N/A |",
    );
    expect(output).toContain("0 unsupported claims among 10 checked claims");
    expect(output).toContain("An observed zero is not interpreted as zero risk");
    expect(output).toContain("Protected records | 2/2 | 4/4");
    expect(output).toContain("continued-compatible-ev-use");
  });

  it("rejects assurance from a different source commit", () => {
    const input = fixture();
    expect(() =>
      assertFinalResultsInputs({
        ...input,
        application: { ...input.application, source_commit: "b".repeat(40) },
      }),
    ).toThrow(/Application assurance source commit differs/u);
  });

  it("rejects model transport totals that do not reconcile", () => {
    const input = fixture();
    expect(() =>
      assertFinalResultsInputs({
        ...input,
        primary: {
          ...input.primary,
          integrity: { ...input.primary.integrity, model_transport_retries: 0 },
        },
      }),
    ).toThrow(/model transport attempts and retries do not reconcile/u);
  });

  it("rejects the claim-conditional unsupported-rate contrast", () => {
    const primary = fixture().primary;
    expect(
      primaryAnalysisSchema.safeParse({
        ...primary,
        contrasts: [
          {
            ...primary.contrasts[0],
            outcome: "unsupported_claim_rate",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps citation validity descriptive rather than inferential", () => {
    const primary = fixture().primary;
    expect(
      primaryAnalysisSchema.safeParse({
        ...primary,
        contrasts: [
          {
            ...primary.contrasts[0],
            outcome: "citation_validity",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects an incomplete frozen contrast matrix", () => {
    const primary = fixture().primary;
    expect(
      primaryAnalysisSchema.safeParse({
        ...primary,
        contrasts: primary.contrasts.slice(1),
      }).success,
    ).toBe(false);
  });

  it("requires response-event denominators to include every condition observation", () => {
    const primary = fixture().primary;
    expect(
      primaryAnalysisSchema.safeParse({
        ...primary,
        condition_summaries: primary.condition_summaries.map((item, index) =>
          index === 0
            ? {
                ...item,
                released_response_validation_failure_event: {
                  ...item.released_response_validation_failure_event,
                  denominator: item.observations - 1,
                },
              }
            : item,
        ),
      }).success,
    ).toBe(false);
  });
});

function fixture(): FinalResultsInput {
  const primary = primaryAnalysisSchema.parse({
    schema: "EVLLM_FORMAL_STATISTICAL_ANALYSIS_V2",
    confidence_level: 0.95,
    resampling_unit: "case_id",
    integrity: {
      ...binding,
      analysis_source_commit: sourceCommit,
      planned_observations: 64,
      observations: 64,
      unique_observation_ids: 64,
      observations_sha256: hash,
      planned_model_bearing_observations: 64,
      planned_model_invocations: 32,
      successful_model_invocations: 32,
      model_transport_attempts: 33,
      model_transport_retries: 1,
      transport_attempt_journal_sha256: hash,
      observations_requiring_retry: 1,
    },
    condition_summaries: FINAL_PRIMARY_CONDITIONS.map((condition) =>
      primaryCondition(condition, condition === "governed-evllm" ? 0.625 : 0.5),
    ),
    contrasts: FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES.flatMap((outcome) =>
      FINAL_PRIMARY_CONDITIONS.filter((condition) => condition !== "governed-evllm").map(
        (comparator) => {
          const lowerIsFavorable = [
            "unsupported_claim_response_rate",
            "released_response_validation_failure_event",
            "prohibited_disclosure_event",
          ].includes(outcome);
          return {
            comparator,
            outcome,
            paired_cases: 4,
            estimate: lowerIsFavorable ? -0.125 : 0.125,
            ci_lower: lowerIsFavorable ? -0.2 : 0.05,
            ci_upper: lowerIsFavorable ? -0.05 : 0.2,
            p_value: 0.01,
            holm_p_value: 0.02,
          };
        },
      ),
    ),
  });
  const synthesis = synthesisAnalysisSchema.parse({
    schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_ANALYSIS_V2",
    resampling_unit: "case_id",
    integrity: {
      ...binding,
      analysis_source_commit: sourceCommit,
      planned_observations: 5,
      observations: 5,
      unique_observation_ids: 5,
      observations_sha256: hash,
      planned_model_bearing_observations: 5,
      planned_model_invocations: 5,
      successful_model_invocations: 5,
      model_transport_attempts: 5,
      model_transport_retries: 0,
      transport_attempt_journal_sha256: hash,
      observations_requiring_retry: 0,
    },
    condition_summaries: [
      synthesisCondition("raw-structured-record-access", 0, 0),
      synthesisCondition("sequential-deterministic-query", 1, 0),
      synthesisCondition("governed-evllm-synthesis", 1, 1),
    ],
    raw_generation_summary: rawGenerationSummary(),
    raw_generation_strata: [{ stratum: "complete", ...rawGenerationSummary() }],
  });
  const primaryRun = evaluationRunSummarySchema.parse({
    ...binding,
    completed_observations: 64,
    planned_observations: 64,
    planned_model_bearing_observations: 64,
    planned_model_invocations: 32,
    successful_model_invocations: 32,
    model_transport_attempts: 33,
    model_transport_retries: 1,
    transport_attempt_journal_sha256: hash,
    complete: true,
  });
  const synthesisRun = evaluationRunSummarySchema.parse({
    ...binding,
    completed_observations: 5,
    planned_observations: 5,
    planned_model_bearing_observations: 5,
    planned_model_invocations: 5,
    successful_model_invocations: 5,
    model_transport_attempts: 5,
    model_transport_retries: 0,
    transport_attempt_journal_sha256: hash,
    complete: true,
  });
  const sustainability = sustainabilityValidationSchema.parse({
    schema: "EVLLM_SUSTAINABILITY_VALIDATION_V1",
    method: "Contextual route assessment",
    routes: ["continued-compatible-ev-use", "stationary-storage-repurposing", "recycling"],
    componentOrder: ["G", "C", "I", "E", "A", "U"],
    overallScorePresent: false,
    scenarios: {
      nominal: {
        decisionState: "answer",
        preferredRoute: "continued-compatible-ev-use",
        reproductionHash: { value: "reproduction-hash" },
      },
    },
    assertions: { nominalAnswers: true, unstableRankingAbstains: true },
  });
  const application = applicationAssuranceSchema.parse({
    schema: "APPLICATION_ASSURANCE_SUMMARY_V2",
    generated_at: "2026-08-27T00:00:00.000Z",
    source_commit: sourceCommit,
    status: "passed",
    commands: [
      {
        id: "unit",
        command: "unit command",
        status: "passed",
        test_files: { passed: 2, failed: 0, skipped: 0, total: 2 },
        tests: { passed: 4, failed: 0, skipped: 0, total: 4 },
      },
      {
        id: "postgresql-integration",
        command: "integration command",
        status: "passed",
        test_files: { passed: 1, failed: 0, skipped: 0, total: 1 },
        tests: { passed: 2, failed: 0, skipped: 0, total: 2 },
      },
      { id: "typecheck", command: "npm run typecheck", status: "passed" },
    ],
    test_files: { passed: 3, failed: 0, skipped: 0, total: 3 },
    tests: { passed: 6, failed: 0, skipped: 0, total: 6 },
    groups: [
      {
        name: "Protected records",
        files: [
          "test/unit/protected-records.test.ts",
          "test/integration/protected-records.test.ts",
        ],
        test_files: { passed: 2, failed: 0, skipped: 0, total: 2 },
        tests: { passed: 4, failed: 0, skipped: 0, total: 4 },
      },
      {
        name: "Evaluation",
        files: ["test/unit/evaluation.test.ts"],
        test_files: { passed: 1, failed: 0, skipped: 0, total: 1 },
        tests: { passed: 2, failed: 0, skipped: 0, total: 2 },
      },
    ],
    typecheck: { command: "npm run typecheck", status: "passed", errors: 0 },
  });
  return {
    evaluationSetId: binding.evaluation_set_id,
    sourceCommit,
    primary,
    primaryRun,
    synthesis,
    synthesisRun,
    sustainability,
    application,
  };
}

function rawGenerationSummary() {
  return {
    observations: 5,
    case_clusters: 1,
    required_record_coverage_mean: 1,
    all_required_records_covered: interval(1),
    deterministic_record_binding: interval(0.8),
    decision_code_accuracy: interval(1),
    structured_outcome_accuracy: interval(0.8),
    required_reason_accuracy: interval(1),
    raw_candidate_validation_accuracy: interval(0.8),
    generation_success: interval(0.8),
    claims: 20,
  };
}

function primaryCondition(condition: string, estimate: number) {
  return {
    condition,
    observations: 8,
    successful_model_invocations: 4,
    model_invoked_observations: 8,
    task_success: interval(estimate),
    model_invoked_task_success: interval(estimate),
    released_typed_decision_fidelity: interval(estimate),
    appropriate_abstention_f1: 0.8,
    required_record_coverage_mean: 0.75,
    required_record_coverage_eligible_observations: 4,
    citation_validity_mean: 0.9,
    citation_validity_count: { numerator: 9, denominator: 10 },
    unsupported_claim_rate_mean: 0.1,
    unsupported_claim_count: { numerator: 1, denominator: 10 },
    unsupported_claim_response_rate: interval(0.1),
    authorization_accuracy: interval(1),
    prohibited_disclosure_events: interval(0),
    released_response_validation_failure_event: interval(0.25),
    prohibited_disclosure_count: 0,
  };
}

function synthesisCondition(condition: string, decision: number, success: number) {
  const observedResponse = condition === "governed-evllm-synthesis";
  return {
    condition,
    observations: 5,
    case_clusters: 1,
    operation_count_median: observedResponse ? 1 : 4,
    required_record_coverage_mean: observedResponse ? 1 : null,
    recorded_decision_and_outcome_accuracy: observedResponse ? interval(decision) : null,
    pipeline_validation_accuracy: observedResponse ? interval(success) : null,
    citation_validity_mean: observedResponse ? 1 : null,
    unsupported_claim_rate_mean: observedResponse ? 0 : null,
    unsupported_claims: observedResponse ? { numerator: 0, denominator: 10, estimate: 0 } : null,
    unsupported_claim_response_rate: observedResponse ? { ...interval(0), ci_upper: 0.2 } : null,
    missing_information_detection: observedResponse ? interval(1) : null,
    conflicting_information_detection: observedResponse ? interval(1) : null,
    synthesis_success: observedResponse ? interval(success) : null,
  };
}

function interval(estimate: number) {
  return {
    numerator: Math.round(estimate * 8),
    denominator: 8,
    estimate,
    ci_lower: Math.max(0, estimate - 0.125),
    ci_upper: Math.min(1, estimate + 0.125),
    case_clusters: 4,
    ci_method: "case-cluster-bootstrap",
  };
}
