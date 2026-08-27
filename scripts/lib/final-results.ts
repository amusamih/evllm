import { z } from "zod";

import {
  FINAL_PRIMARY_CONDITIONS,
  FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES,
  FINAL_SYNTHESIS_CONDITIONS,
} from "../../src/evaluation/final-freeze.js";

const probability = z.number().min(0).max(1);
const count = z.number().int().nonnegative();
const evaluationBindingFields = {
  evaluation_set_id: z.string().min(1),
  source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  freeze_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
  corpus_file_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
  logical_corpus_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
} as const;

const clusteredProportion = z
  .object({
    numerator: count,
    denominator: count,
    estimate: probability,
    ci_lower: probability,
    ci_upper: probability,
    case_clusters: z.number().int().positive(),
    ci_method: z.string().min(1),
  })
  .passthrough();

const primaryCondition = z
  .object({
    condition: z.string().min(1),
    observations: z.number().int().positive(),
    successful_model_invocations: count,
    model_invoked_observations: count,
    task_success: clusteredProportion,
    model_invoked_task_success: clusteredProportion.nullable(),
    released_typed_decision_fidelity: clusteredProportion,
    appropriate_abstention_f1: probability,
    required_record_coverage_mean: probability.nullable(),
    required_record_coverage_eligible_observations: count,
    citation_validity_mean: probability.nullable(),
    citation_validity_count: z.object({ numerator: count, denominator: count }).strict(),
    unsupported_claim_rate_mean: probability.nullable(),
    unsupported_claim_count: z.object({ numerator: count, denominator: count }).strict(),
    unsupported_claim_response_rate: clusteredProportion,
    authorization_accuracy: clusteredProportion.nullable(),
    prohibited_disclosure_events: clusteredProportion,
    released_response_validation_failure_event: clusteredProportion,
    prohibited_disclosure_count: count,
  })
  .passthrough();

const primaryContrastOutcome = z.enum([
  "task_success",
  "required_record_coverage",
  "unsupported_claim_response_rate",
  "released_response_validation_failure_event",
  "authorization_accuracy",
  "prohibited_disclosure_event",
  "appropriate_abstention_f1",
  "released_typed_decision_fidelity",
]);

const contrast = z
  .object({
    comparator: z.string().min(1),
    outcome: primaryContrastOutcome,
    paired_cases: z.number().int().positive(),
    estimate: z.number().min(-1).max(1),
    ci_lower: z.number().min(-1).max(1),
    ci_upper: z.number().min(-1).max(1),
    p_value: probability,
    holm_p_value: probability,
  })
  .passthrough();

export const primaryAnalysisSchema = z
  .object({
    schema: z.literal("EVLLM_FORMAL_STATISTICAL_ANALYSIS_V2"),
    confidence_level: probability,
    resampling_unit: z.literal("case_id"),
    integrity: z
      .object({
        ...evaluationBindingFields,
        analysis_source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
        planned_observations: z.number().int().positive(),
        observations: z.number().int().positive(),
        unique_observation_ids: z.number().int().positive(),
        observations_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
        planned_model_bearing_observations: z.number().int().positive(),
        planned_model_invocations: z.number().int().positive(),
        successful_model_invocations: count,
        model_transport_attempts: count,
        model_transport_retries: count,
        transport_attempt_journal_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
        observations_requiring_retry: count,
      })
      .passthrough(),
    condition_summaries: z.array(primaryCondition).min(1),
    contrasts: z.array(contrast),
  })
  .passthrough()
  .superRefine((value, context) => {
    const responseWideFields = [
      "task_success",
      "unsupported_claim_response_rate",
      "prohibited_disclosure_events",
      "released_response_validation_failure_event",
    ] as const;
    for (const [index, item] of value.condition_summaries.entries()) {
      for (const field of responseWideFields) {
        if (item[field].denominator !== item.observations) {
          context.addIssue({
            code: "custom",
            path: ["condition_summaries", index, field, "denominator"],
            message: `${field} must include every observation in the condition`,
          });
        }
      }
      if (
        item.model_invoked_task_success !== null &&
        item.model_invoked_task_success.denominator !== item.model_invoked_observations
      ) {
        context.addIssue({
          code: "custom",
          path: ["condition_summaries", index, "model_invoked_task_success", "denominator"],
          message: "Model-invoked task success must include every model-invoked observation",
        });
      }
    }

    const expectedComparators = FINAL_PRIMARY_CONDITIONS.filter(
      (condition) => condition !== "governed-evllm",
    );
    const expectedContrastKeys = new Set(
      FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES.flatMap((outcome) =>
        expectedComparators.map((comparator) => `${outcome}\u0000${comparator}`),
      ),
    );
    const actualContrastKeys = value.contrasts.map(
      ({ outcome, comparator }) => `${outcome}\u0000${comparator}`,
    );
    if (
      actualContrastKeys.length !== expectedContrastKeys.size ||
      new Set(actualContrastKeys).size !== actualContrastKeys.length ||
      actualContrastKeys.some((key) => !expectedContrastKeys.has(key))
    ) {
      context.addIssue({
        code: "custom",
        path: ["contrasts"],
        message:
          "Contrasts must contain exactly one governed-versus-comparator result for every frozen inferential outcome",
      });
    }
  });

const synthesisCondition = z
  .object({
    condition: z.string().min(1),
    observations: z.number().int().positive(),
    case_clusters: z.number().int().positive(),
    operation_count_median: z.number().nonnegative(),
    required_record_coverage_mean: probability.nullable(),
    recorded_decision_and_outcome_accuracy: clusteredProportion.nullable(),
    pipeline_validation_accuracy: clusteredProportion.nullable(),
    citation_validity_mean: probability.nullable(),
    unsupported_claim_rate_mean: probability.nullable(),
    unsupported_claims: z
      .object({ numerator: count, denominator: count, estimate: probability })
      .strict()
      .nullable(),
    unsupported_claim_response_rate: clusteredProportion.nullable(),
    missing_information_detection: clusteredProportion.nullable(),
    conflicting_information_detection: clusteredProportion.nullable(),
    synthesis_success: clusteredProportion.nullable(),
  })
  .passthrough();

const rawGenerationSummary = z
  .object({
    observations: z.number().int().positive(),
    case_clusters: z.number().int().positive(),
    required_record_coverage_mean: probability,
    all_required_records_covered: clusteredProportion,
    deterministic_record_binding: clusteredProportion,
    decision_code_accuracy: clusteredProportion,
    structured_outcome_accuracy: clusteredProportion,
    required_reason_accuracy: clusteredProportion,
    raw_candidate_validation_accuracy: clusteredProportion,
    generation_success: clusteredProportion,
    claims: count,
  })
  .passthrough();

export const synthesisAnalysisSchema = z
  .object({
    schema: z.literal("EVLLM_COMPLEMENTARY_SYNTHESIS_ANALYSIS_V2"),
    resampling_unit: z.literal("case_id"),
    integrity: z
      .object({
        ...evaluationBindingFields,
        analysis_source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
        planned_observations: z.number().int().positive(),
        observations: z.number().int().positive(),
        unique_observation_ids: z.number().int().positive(),
        observations_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
        planned_model_bearing_observations: z.number().int().positive(),
        planned_model_invocations: z.number().int().positive(),
        successful_model_invocations: count,
        model_transport_attempts: count,
        model_transport_retries: count,
        transport_attempt_journal_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
        observations_requiring_retry: count,
      })
      .passthrough(),
    condition_summaries: z.array(synthesisCondition).min(1),
    raw_generation_summary: rawGenerationSummary,
    raw_generation_strata: z.array(rawGenerationSummary.extend({ stratum: z.string().min(1) })),
  })
  .passthrough();

export const evaluationRunSummarySchema = z
  .object({
    ...evaluationBindingFields,
    completed_observations: z.number().int().positive(),
    planned_observations: z.number().int().positive(),
    planned_model_bearing_observations: z.number().int().positive(),
    planned_model_invocations: z.number().int().positive(),
    successful_model_invocations: count,
    model_transport_attempts: count,
    model_transport_retries: count,
    transport_attempt_journal_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    complete: z.literal(true),
  })
  .passthrough();

const totals = z
  .object({
    passed: count,
    failed: count,
    skipped: count,
    total: count,
  })
  .strict()
  .refine((value) => value.passed + value.failed + value.skipped === value.total, {
    message: "Assurance totals do not add up",
  });

const assuranceTestCommand = z
  .object({
    id: z.enum(["unit", "postgresql-integration"]),
    command: z.string().min(1),
    status: z.literal("passed"),
    test_files: totals,
    tests: totals,
  })
  .strict();
const assuranceTypecheckCommand = z
  .object({
    id: z.literal("typecheck"),
    command: z.string().min(1),
    status: z.literal("passed"),
  })
  .strict();

export const applicationAssuranceSchema = z
  .object({
    schema: z.literal("APPLICATION_ASSURANCE_SUMMARY_V2"),
    generated_at: z.string().min(1),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    status: z.literal("passed"),
    commands: z
      .array(z.discriminatedUnion("id", [assuranceTestCommand, assuranceTypecheckCommand]))
      .length(3),
    test_files: totals,
    tests: totals,
    groups: z
      .array(
        z
          .object({
            name: z.string().min(1),
            files: z.array(z.string().min(1)).min(1),
            test_files: totals,
            tests: totals,
          })
          .strict(),
      )
      .min(1),
    typecheck: z
      .object({
        command: z.string().min(1),
        status: z.literal("passed"),
        errors: z.literal(0),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.test_files.failed !== 0 || value.tests.failed !== 0) {
      context.addIssue({
        code: "custom",
        message: "A passed assurance artifact cannot contain failed tests",
      });
    }
    const commandIds = new Set(value.commands.map((item) => item.id));
    if (commandIds.size !== 3) {
      context.addIssue({ code: "custom", message: "Assurance command IDs must be unique" });
    }
    const groupedFiles = value.groups.flatMap((group) => group.files);
    if (new Set(groupedFiles).size !== groupedFiles.length) {
      context.addIssue({ code: "custom", message: "Assurance group file paths must be unique" });
    }
    for (const group of value.groups) {
      if (group.files.length !== group.test_files.total) {
        context.addIssue({
          code: "custom",
          message: `Assurance group ${group.name} file list does not match its total`,
        });
      }
    }
    for (const key of ["passed", "failed", "skipped", "total"] as const) {
      const groupFileTotal = value.groups.reduce((sum, group) => sum + group.test_files[key], 0);
      const groupTestTotal = value.groups.reduce((sum, group) => sum + group.tests[key], 0);
      const commandFileTotal = value.commands.reduce(
        (sum, command) => (command.id === "typecheck" ? sum : sum + command.test_files[key]),
        0,
      );
      const commandTestTotal = value.commands.reduce(
        (sum, command) => (command.id === "typecheck" ? sum : sum + command.tests[key]),
        0,
      );
      if (groupFileTotal !== value.test_files[key] || commandFileTotal !== value.test_files[key]) {
        context.addIssue({
          code: "custom",
          message: `Assurance test-file ${key} totals do not match groups and commands`,
        });
      }
      if (groupTestTotal !== value.tests[key] || commandTestTotal !== value.tests[key]) {
        context.addIssue({
          code: "custom",
          message: `Assurance test ${key} totals do not match groups and commands`,
        });
      }
    }
    const typecheckCommand = value.commands.find((item) => item.id === "typecheck");
    if (typecheckCommand?.command !== value.typecheck.command) {
      context.addIssue({
        code: "custom",
        message: "Assurance typecheck command differs between command records",
      });
    }
  });

export const sustainabilityValidationSchema = z
  .object({
    schema: z.string().min(1),
    method: z.string().min(1),
    routes: z.array(z.string().min(1)).min(1),
    componentOrder: z.array(z.string().min(1)).min(1),
    overallScorePresent: z.literal(false),
    scenarios: z
      .object({
        nominal: z
          .object({
            decisionState: z.string().min(1),
            preferredRoute: z.string().min(1),
            reproductionHash: z.object({ value: z.string().min(1) }).passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
    assertions: z.record(z.string(), z.boolean()),
  })
  .passthrough();

export type PrimaryAnalysis = z.infer<typeof primaryAnalysisSchema>;
export type SynthesisAnalysis = z.infer<typeof synthesisAnalysisSchema>;
export type EvaluationRunSummary = z.infer<typeof evaluationRunSummarySchema>;
export type ApplicationAssurance = z.infer<typeof applicationAssuranceSchema>;
export type SustainabilityValidation = z.infer<typeof sustainabilityValidationSchema>;

export interface FinalResultsInput {
  readonly evaluationSetId: string;
  readonly sourceCommit: string;
  readonly primary: PrimaryAnalysis;
  readonly primaryRun: EvaluationRunSummary;
  readonly synthesis: SynthesisAnalysis;
  readonly synthesisRun: EvaluationRunSummary;
  readonly sustainability: SustainabilityValidation;
  readonly application: ApplicationAssurance;
}

const primaryConditionLabels: Readonly<Record<string, string>> = {
  "ungrounded-model": "Question-only LLM",
  "ordinary-rag": "Plain-context RAG",
  "governed-evllm": "Governed decision support",
  "ablation-access-enforcement": "Without access enforcement",
  "ablation-source-status-integrity": "Without source-status and integrity checks",
  "ablation-conflict-precondition": "Without conflict precondition",
  "ablation-deterministic-rules": "Without deterministic-rule precondition",
  "ablation-output-validation": "Without output validation",
};

const primaryOutcomeLabels: Readonly<Record<string, string>> = {
  task_success: "Task success",
  required_record_coverage: "Required-record coverage",
  unsupported_claim_response_rate: "Responses with unsupported claims",
  released_response_validation_failure_event: "Released-response validation failures",
  appropriate_abstention_f1: "Appropriate abstention F1",
  authorization_accuracy: "Authorization accuracy",
  prohibited_disclosure_event: "Responses with prohibited disclosure",
  released_typed_decision_fidelity: "Decision code and outcome agreement",
};

const lowerIsFavorableOutcomes = new Set([
  "unsupported_claim_response_rate",
  "released_response_validation_failure_event",
  "prohibited_disclosure_event",
]);

const synthesisConditionLabels: Readonly<Record<string, string>> = {
  "raw-structured-record-access": "Raw structured records",
  "sequential-deterministic-query": "Sequential deterministic queries",
  "governed-evllm-synthesis": "Governed conversational synthesis",
};

const assertionLabels: Readonly<Record<string, string>> = {
  nominalAnswers: "Nominal case returns a supported route preference",
  failedGateCannotBePreferred:
    "A route that does not meet technical and safety eligibility is not selected",
  missingCriticalEvidenceAbstains: "Missing critical information produces abstention",
  conflictRequiresExternalDecision:
    "Conflicting critical information requires an external decision",
  contextChangesEnvironmentalIndicator:
    "A changed context factor changes the environmental indicator",
  contextPreservesCircularity: "The same context change preserves circularity",
  contextPreservesEconomics: "The same context change preserves economics",
  unstableRankingAbstains: "An unstable scenario ranking produces abstention",
  deterministicReplay: "Exact replay reproduces the complete result",
};

export function assertFinalResultsInputs(input: FinalResultsInput): void {
  assertConditionSequence(
    "Primary analysis",
    input.primary.condition_summaries.map(({ condition }) => condition),
    FINAL_PRIMARY_CONDITIONS,
  );
  assertConditionSequence(
    "Synthesis analysis",
    input.synthesis.condition_summaries.map(({ condition }) => condition),
    FINAL_SYNTHESIS_CONDITIONS,
  );
  const branches = [
    ["primary", input.primary.integrity, input.primaryRun],
    ["synthesis", input.synthesis.integrity, input.synthesisRun],
  ] as const;
  for (const [label, integrity, run] of branches) {
    if (run.completed_observations !== run.planned_observations) {
      throw new Error(`${label} evaluation run is incomplete`);
    }
    if (integrity.planned_observations !== run.planned_observations) {
      throw new Error(`${label} analysis and run summary planned observation counts differ`);
    }
    if (integrity.observations !== run.completed_observations) {
      throw new Error(`${label} analysis and run summary observation counts differ`);
    }
    if (integrity.unique_observation_ids !== integrity.observations) {
      throw new Error(`${label} analysis contains duplicate observation IDs`);
    }
    if (integrity.analysis_source_commit !== input.sourceCommit) {
      throw new Error(`${label} analysis source commit differs from the evaluation evidence`);
    }
    if (integrity.planned_model_bearing_observations !== run.planned_model_bearing_observations) {
      throw new Error(`${label} planned model-bearing observation counts differ`);
    }
    if (integrity.planned_model_invocations !== run.planned_model_invocations) {
      throw new Error(`${label} planned model invocation counts differ`);
    }
    if (integrity.successful_model_invocations !== run.successful_model_invocations) {
      throw new Error(`${label} successful model invocation counts differ`);
    }
    if (integrity.successful_model_invocations > integrity.observations) {
      throw new Error(`${label} successful model invocations exceed collected observations`);
    }
    if (
      integrity.model_transport_attempts - integrity.successful_model_invocations !==
      integrity.model_transport_retries
    ) {
      throw new Error(`${label} model transport attempts and retries do not reconcile`);
    }
    if (integrity.transport_attempt_journal_sha256 !== run.transport_attempt_journal_sha256) {
      throw new Error(`${label} analysis and run summary use different attempt journals`);
    }
  }
  if (
    input.synthesis.raw_generation_summary.observations !== input.synthesis.integrity.observations
  ) {
    throw new Error("Raw-generation diagnostics do not cover every synthesis observation");
  }
  if (input.application.source_commit !== input.sourceCommit) {
    throw new Error("Application assurance source commit differs from the evaluation evidence");
  }
  if (Object.values(input.sustainability.assertions).some((passed) => !passed)) {
    throw new Error("Sustainability validation contains a failed assertion");
  }
  if (!input.primary.condition_summaries.some((item) => item.condition === "governed-evllm")) {
    throw new Error("Primary analysis lacks the governed-system condition");
  }
  if (
    !input.synthesis.condition_summaries.some(
      (item) => item.condition === "governed-evllm-synthesis",
    )
  ) {
    throw new Error("Synthesis analysis lacks the governed synthesis condition");
  }
}

function assertConditionSequence(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} condition sequence differs from the prespecified protocol`);
  }
}

export function renderFinalResults(input: FinalResultsInput): string {
  assertFinalResultsInputs(input);
  const governedSynthesis = input.synthesis.condition_summaries.find(
    (item) => item.condition === "governed-evllm-synthesis",
  )!;
  const rawGeneration = input.synthesis.raw_generation_summary;
  const applicationGroups = input.application.groups
    .map(
      (group) =>
        `| ${group.name} | ${formatCountTotal(group.test_files)} | ${formatCountTotal(group.tests)} |`,
    )
    .join("\n");
  const primaryReliabilityRows = input.primary.condition_summaries
    .map(
      (item) =>
        `| ${primaryConditionLabels[item.condition] ?? item.condition} | ${item.observations.toLocaleString("en-US")} | ${formatIntervalWithCount(item.task_success)} | ${formatNullableIntervalWithCount(item.model_invoked_task_success)} | ${formatIntervalWithCount(item.released_typed_decision_fidelity)} | ${item.required_record_coverage_mean === null ? "N/A" : `${formatRate(item.required_record_coverage_mean)} (${item.required_record_coverage_eligible_observations.toLocaleString("en-US")} eligible)`} | ${item.appropriate_abstention_f1.toFixed(3)} |`,
    )
    .join("\n");
  const primarySafetyRows = input.primary.condition_summaries
    .map(
      (item) =>
        `| ${primaryConditionLabels[item.condition] ?? item.condition} | ${formatCountRate(item.citation_validity_count)} | ${formatCountRate(item.unsupported_claim_count)} | ${formatIntervalWithCount(item.unsupported_claim_response_rate)} | ${formatNullableIntervalWithCount(item.authorization_accuracy)} | ${formatIntervalWithCount(item.prohibited_disclosure_events)} | ${item.prohibited_disclosure_count.toLocaleString("en-US")} | ${formatIntervalWithCount(item.released_response_validation_failure_event)} |`,
    )
    .join("\n");
  const contrastOutcomeOrder = new Map(
    FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES.map((outcome, index) => [outcome, index]),
  );
  const contrastComparatorOrder = new Map<string, number>(
    FINAL_PRIMARY_CONDITIONS.filter((condition) => condition !== "governed-evllm").map(
      (condition, index) => [condition, index],
    ),
  );
  const contrastRows = [...input.primary.contrasts]
    .sort(
      (left, right) =>
        (contrastOutcomeOrder.get(left.outcome) ?? Number.MAX_SAFE_INTEGER) -
          (contrastOutcomeOrder.get(right.outcome) ?? Number.MAX_SAFE_INTEGER) ||
        (contrastComparatorOrder.get(left.comparator) ?? Number.MAX_SAFE_INTEGER) -
          (contrastComparatorOrder.get(right.comparator) ?? Number.MAX_SAFE_INTEGER),
    )
    .map(
      (item) =>
        `| ${primaryOutcomeLabels[item.outcome] ?? item.outcome} | ${primaryConditionLabels[item.comparator] ?? item.comparator} | ${item.paired_cases.toLocaleString("en-US")} | ${formatSignedPoints(item.estimate)} (${formatSignedPoints(item.ci_lower)} to ${formatSignedPoints(item.ci_upper)}) | ${lowerIsFavorableOutcomes.has(item.outcome) ? "Lower" : "Higher"} | ${formatP(item.holm_p_value)} |`,
    )
    .join("\n");
  const synthesisRows = input.synthesis.condition_summaries
    .map(
      (item) =>
        `| ${synthesisConditionLabels[item.condition] ?? item.condition} | ${item.operation_count_median.toLocaleString("en-US")} | ${formatNullableRate(item.required_record_coverage_mean)} | ${formatNullableInterval(item.recorded_decision_and_outcome_accuracy)} | ${formatNullableRate(item.citation_validity_mean)} | ${formatNullableRate(item.unsupported_claim_rate_mean)} | ${formatNullableInterval(item.missing_information_detection)} | ${formatNullableInterval(item.conflicting_information_detection)} | ${formatNullableInterval(item.synthesis_success)} |`,
    )
    .join("\n");
  const assertionRows = Object.entries(input.sustainability.assertions)
    .map(
      ([name, passed]) =>
        `| ${assertionLabels[name] ?? humanize(name)} | ${passed ? "PASS" : "FAIL"} |`,
    )
    .join("\n");
  if (
    governedSynthesis.unsupported_claims === null ||
    governedSynthesis.unsupported_claim_response_rate === null
  ) {
    throw new Error("Governed synthesis lacks observed response-quality metrics");
  }
  const zeroUnsupportedBoundary =
    governedSynthesis.unsupported_claims.numerator === 0
      ? " An observed zero is not interpreted as zero risk."
      : "";

  return `# System evaluation results

This report is generated from the checksum-bound primary and complementary analyses, deterministic route validation, and application assurance records. The evaluation set is \`${input.evaluationSetId}\`. Collection, metric derivation, and report generation all use source commit \`${input.sourceCommit}\`.

## Evidence integrity

| Item | Value |
|---|---:|
| Primary observations planned | ${input.primaryRun.planned_observations.toLocaleString("en-US")} |
| Primary observations collected | ${input.primaryRun.completed_observations.toLocaleString("en-US")} |
| Primary model-bearing observations planned | ${input.primary.integrity.planned_model_bearing_observations.toLocaleString("en-US")} |
| Primary model invocations planned | ${input.primary.integrity.planned_model_invocations.toLocaleString("en-US")} |
| Primary successful model invocations | ${input.primary.integrity.successful_model_invocations.toLocaleString("en-US")} |
| Primary model transport attempts | ${input.primary.integrity.model_transport_attempts.toLocaleString("en-US")} |
| Primary model transport retries | ${input.primary.integrity.model_transport_retries.toLocaleString("en-US")} |
| Complementary observations planned | ${input.synthesisRun.planned_observations.toLocaleString("en-US")} |
| Complementary observations collected | ${input.synthesisRun.completed_observations.toLocaleString("en-US")} |
| Complementary model-bearing observations planned | ${input.synthesis.integrity.planned_model_bearing_observations.toLocaleString("en-US")} |
| Complementary model invocations planned | ${input.synthesis.integrity.planned_model_invocations.toLocaleString("en-US")} |
| Complementary successful model invocations | ${input.synthesis.integrity.successful_model_invocations.toLocaleString("en-US")} |
| Complementary model transport attempts | ${input.synthesis.integrity.model_transport_attempts.toLocaleString("en-US")} |
| Complementary model transport retries | ${input.synthesis.integrity.model_transport_retries.toLocaleString("en-US")} |
| Application test files | ${formatCountTotal(input.application.test_files)} |
| Application tests | ${formatCountTotal(input.application.tests)} |
| TypeScript check | ${input.application.typecheck.status} |

### Application test groups

| Group | Test files (passed/total) | Tests (passed/total) |
|---|---:|---:|
${applicationGroups}

## Primary reliability and safety comparison

Task success requires the released outcome to match the frozen expected outcome, the decision code to agree with the active typed decision when one is present, and the released reason-code set to agree exactly with the frozen expected reasons. It also requires every required active record to be covered by a semantically supported claim, no unsupported claim, no released-response validation failure under the predefined field, value, entity, numeric, polarity, conjunction, and incompatible-status checks, no prohibited disclosure, and correct denied-access behavior where applicable. Citation-ID validity is calculated only for responses containing citations and records whether cited identifiers resolve to active supplied records. It is descriptive rather than inferential because its eligible denominator depends on which responses contain citations. Decision code and outcome agreement is calculated only for observations whose case carries an active typed decision; the matched and eligible observation counts are shown explicitly. The unsupported-claim response rate counts all released responses and records whether each contains at least one unsupported claim. The released-response validation-failure rate counts every released response and records whether it fails one or more of the predefined response-level checks. The exact fixed notice returned after fail-closed validation is treated as a safe released notice rather than as a failed released response; altered or partial forms do not receive this exception. These measures do not establish real-world truth or semantic entailment. The support checks are designed to detect specified contradictions and attribution errors; they do not replace expert verification of real-world claims.

| Condition | Observations | Overall task success | Model-invoked task success | Decision code and outcome agreement | Mean required-record coverage | Abstention F1 |
|---|---:|---:|---:|---:|---:|---:|
${primaryReliabilityRows}

All intervals in the two condition tables are 95% case-cluster intervals. Citation-ID validity and the claim-level unsupported-claim rate are descriptive because their denominators depend on the citations and claims emitted by each condition. The corresponding response-event measures retain every released response in their denominator.

| Condition | Valid citation IDs | Unsupported claims | Responses with unsupported claims | Authorization accuracy | Responses with prohibited disclosure | Disclosure matches | Released responses failing validation |
|---|---:|---:|---:|---:|---:|---:|---:|
${primarySafetyRows}

A disclosure match is one detected prohibited item; one response can contain more than one match. A released-response validation failure means that the user-visible response fails at least one frozen response-validation check. The exact fixed fail-closed validation notice is a safe released notice and is excluded; a near match or any response containing additional unsupported content is not excluded.

The primary comparison evaluates eight model conditions over the same frozen case-condition cells. The paired effects below are the governed condition minus each comparator. Confidence intervals resample cases while retaining the repetitions within a case. Raw p values use paired case-cluster randomization, followed by Holm adjustment within each outcome family. Positive differences favor the governed condition when higher values are desirable; negative differences favor it when lower values are desirable.

| Outcome | Comparator | Paired cases | Difference (95% CI) | Favorable direction | Holm-adjusted p |
|---|---|---:|---:|---:|---:|
${contrastRows}

## Complementary conversational synthesis

Recorded-decision preservation compares the released structured decision code and outcome with the typed decision attached to the final deterministic record. Missing-information detection requires the missing-evidence reason, while conflicting-information detection requires the conflicting-evidence reason. Required-reason agreement is assessed separately through deterministic binding and pipeline validation. Complete one-response synthesis also requires full required-record coverage, citation-ID validity, no unsupported statement, the applicable information-problem detection, and a response accepted by the governed service validator. Raw-record and sequential-query references do not generate responses, so their response-quality entries are not applicable.

| Condition | Median user-visible operations | Required-record coverage | Recorded decision and outcome (95% case-cluster CI) | Citation-ID validity | Unsupported-claim rate | Missing-information detection (95% case-cluster CI) | Conflicting-information detection (95% case-cluster CI) | Complete one-response synthesis (95% case-cluster CI) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${synthesisRows}

The governed synthesis condition produced ${governedSynthesis.unsupported_claims.numerator.toLocaleString("en-US")} unsupported claims among ${governedSynthesis.unsupported_claims.denominator.toLocaleString("en-US")} checked claims. The case-cluster 95% interval for the rate of responses containing an unsupported claim is ${formatRate(governedSynthesis.unsupported_claim_response_rate.ci_lower)} to ${formatRate(governedSynthesis.unsupported_claim_response_rate.ci_upper)}.${zeroUnsupportedBoundary} These metrics are machine-observed interface properties, not subjective usability measurements.

The retained raw model candidate is analyzed separately before deterministic binding and fail-closed validation. Because the model receives the typed deterministic record, decision-code, outcome, and required-reason agreement compare its structured fields with that supplied record rather than measuring independent decision accuracy.

| Raw generation observations | Required-record coverage | All records covered | Decision metadata agreement | Decision-code agreement | Outcome agreement | Required reason-code agreement | Raw validation passed | Complete raw synthesis |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ${rawGeneration.observations.toLocaleString("en-US")} | ${formatRate(rawGeneration.required_record_coverage_mean)} | ${formatInterval(rawGeneration.all_required_records_covered)} | ${formatInterval(rawGeneration.deterministic_record_binding)} | ${formatInterval(rawGeneration.decision_code_accuracy)} | ${formatInterval(rawGeneration.structured_outcome_accuracy)} | ${formatInterval(rawGeneration.required_reason_accuracy)} | ${formatInterval(rawGeneration.raw_candidate_validation_accuracy)} | ${formatInterval(rawGeneration.generation_success)} |

## Contextual route assessment

The \`${input.sustainability.method}\` evaluates ${input.sustainability.routes.length.toLocaleString("en-US")} declared routes through the separate components ${input.sustainability.componentOrder.map((item) => `\`${item}\``).join(", ")}. It does not calculate an overall sustainability score. The nominal case returned \`${input.sustainability.scenarios.nominal.preferredRoute}\` with decision state \`${input.sustainability.scenarios.nominal.decisionState}\` and reproduction hash \`${input.sustainability.scenarios.nominal.reproductionHash.value}\`.

| Deterministic check | Result |
|---|---|
${assertionRows}

These route checks verify the implemented calculations and decision behavior for controlled inputs. They are not a universal sustainability certification, an empirical lifecycle assessment of all batteries, or evidence of realized environmental benefits.
`;
}

function formatRate(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNullableRate(value: number | null): string {
  return value === null ? "N/A" : formatRate(value);
}

function formatInterval(value: z.infer<typeof clusteredProportion>): string {
  return `${formatRate(value.estimate)} (${formatRate(value.ci_lower)} to ${formatRate(value.ci_upper)})`;
}

function formatNullableInterval(value: z.infer<typeof clusteredProportion> | null): string {
  return value === null ? "N/A" : formatInterval(value);
}

function formatIntervalWithCount(value: z.infer<typeof clusteredProportion>): string {
  return `${value.numerator.toLocaleString("en-US")}/${value.denominator.toLocaleString("en-US")}, ${formatInterval(value)}`;
}

function formatNullableIntervalWithCount(
  value: z.infer<typeof clusteredProportion> | null,
): string {
  return value === null ? "N/A" : formatIntervalWithCount(value);
}

function formatCountRate(value: {
  readonly numerator: number;
  readonly denominator: number;
}): string {
  return value.denominator === 0
    ? "N/A"
    : `${value.numerator.toLocaleString("en-US")}/${value.denominator.toLocaleString("en-US")}, ${formatRate(value.numerator / value.denominator)}`;
}

function formatSignedPoints(value: number): string {
  const points = value * 100;
  return `${points >= 0 ? "+" : ""}${points.toFixed(1)} pp`;
}

function formatP(value: number): string {
  if (value < 0.001) return "<0.001";
  return value.toFixed(3);
}

function formatCountTotal(value: z.infer<typeof totals>): string {
  const skipped = value.skipped === 0 ? "" : `; ${value.skipped.toLocaleString("en-US")} skipped`;
  return `${value.passed.toLocaleString("en-US")}/${value.total.toLocaleString("en-US")}${skipped}`;
}

function humanize(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replaceAll("_", " ")
    .replace(/^./u, (character) => character.toUpperCase());
}
