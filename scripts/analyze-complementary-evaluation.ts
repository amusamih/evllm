import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  clusteredBootstrapMean,
  mean,
  quantiles,
  wilsonInterval,
} from "../src/evaluation/statistics.js";
import {
  complementaryAnalyticReference,
  scoreComplementaryRawGeneration,
  scoreComplementarySynthesis,
  validateComplementaryRawGeneration,
  type ComplementaryRawGenerationScore,
  type ComplementarySynthesisCase,
  type ComplementarySynthesisObservation,
  type ComplementarySynthesisScore,
} from "../src/evaluation/complementary.js";
import { assertComplementaryRawDiagnosticFreeze } from "../src/evaluation/complementary-metrics.js";
import { assertSynthesisFreezeProtocol } from "../src/evaluation/final-freeze-validation.js";
import {
  assertExactObservationPlan,
  assertObservationEvaluationBinding,
  type EvaluationBinding,
} from "../src/evaluation/final-integrity.js";
import {
  complementarySynthesisObservationSchema,
  type ComplementarySynthesisStoredObservation,
} from "../src/evaluation/live.js";
import { TransportAttemptJournal } from "../src/evaluation/transport-attempt-journal.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";

const finalRun = process.argv.includes("--final");
const relativeDirectory = finalRun
  ? "evaluation/final/results/synthesis"
  : "evaluation/complementary/results/run-v2";
const allowedResultDirectories = finalRun
  ? ["evaluation/final/results/primary", "evaluation/final/results/synthesis"]
  : [relativeDirectory];
const directory = resolve(relativeDirectory);
const observationPath = resolve(directory, "observations.jsonl");
const observationBytes = await readFile(observationPath);
const configManifest = JSON.parse(
  await readFile(resolve(directory, "evaluation-config-manifest.json"), "utf8"),
) as EvaluationBinding & {
  schema?: string;
  planned_observations?: number;
  planned_model_bearing_observations?: number;
  planned_model_invocations?: number;
  planned_transport_attempts_maximum?: number;
  plan_sha256?: string;
  model?: string;
  temperature?: number;
  max_output_tokens?: number;
  provider_internal_retries?: number;
  store?: boolean;
  maximum_transport_retries_per_invocation?: number;
  conditions?: unknown;
  primary_metrics?: unknown;
  transport_attempt_journal?: string;
};
if (configManifest.transport_attempt_journal !== "transport-attempts.jsonl")
  throw new Error("Complementary configuration manifest has an unexpected attempt-journal path");
const currentSource = assertCommittedEvaluationSource(allowedResultDirectories, {
  expectedSourceCommit: configManifest.source_commit,
  operation: "Complementary statistical analysis",
});
const observations = observationBytes
  .toString("utf8")
  .trim()
  .split("\n")
  .map((line, index) => {
    try {
      return complementarySynthesisObservationSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid complementary observation JSONL at line ${String(index + 1)}`, {
        cause: error,
      });
    }
  });
if (new Set(observations.map((item) => item.observation_id)).size !== observations.length)
  throw new Error("Complementary observation IDs are not unique");
for (const observation of observations) {
  assertObservationEvaluationBinding(observation.observation_id, observation, configManifest);
}
const transportJournal = new TransportAttemptJournal(
  resolve(directory, "transport-attempts.jsonl"),
  {
    evaluation_set_id: configManifest.evaluation_set_id,
    source_commit: configManifest.source_commit,
    freeze_sha256: configManifest.freeze_sha256,
    corpus_file_sha256: configManifest.corpus_file_sha256,
    logical_corpus_sha256: configManifest.logical_corpus_sha256,
  },
);
await transportJournal.initialize();
transportJournal.assertReconciled(observations);
const transportSummary = transportJournal.summary();
if (transportSummary.open_attempts !== 0 || transportSummary.interrupted_attempts !== 0)
  throw new Error("Complementary analysis refuses an incomplete or interrupted transport journal");

const corpusPath = resolve(
  finalRun
    ? "evaluation/final/synthesis-corpus.json"
    : "evaluation/complementary/synthesis-corpus-v2.json",
);
const freezePath = resolve(
  finalRun
    ? "evaluation/final/synthesis-freeze.json"
    : "evaluation/complementary/synthesis-freeze-v2.json",
);
const [corpusBytes, freezeBytes] = await Promise.all([readFile(corpusPath), readFile(freezePath)]);
const corpus = JSON.parse(corpusBytes.toString("utf8")) as Corpus;
const freeze = JSON.parse(freezeBytes.toString("utf8")) as {
  evaluation_set_id?: string;
  rawGenerationDiagnostics: unknown;
  rawGenerationDiagnosticFieldMap: unknown;
  conditions: unknown;
  primaryMetrics: unknown;
  corpus: { caseCount: number; logicalCorpusSha256: string; corpusFileSha256: string };
  model: {
    provider: string;
    api: string;
    model: string;
    temperature: number;
    maxOutputTokens: number;
    providerMaxRetries: number;
    store: boolean;
    repetitionsPerCase: number;
    plannedMaximumModelResponses: number;
    transportRetries: number;
  };
};
assertComplementaryRawDiagnosticFreeze(freeze);
assertSynthesisFreezeProtocol(freeze);
const plan = corpus.cases.flatMap((item) =>
  Array.from({ length: freeze.model.repetitionsPerCase }, (_, index) => ({
    observation_id: `${item.case_id}:governed-evllm-synthesis:${String(index + 1)}`,
    case_id: item.case_id,
    repetition: index + 1,
  })),
);
if (observations.length !== plan.length)
  throw new Error("Complementary observation set is incomplete");
assertComplementaryEffectiveConfiguration();
assertExactObservationPlan("Complementary evaluation", observations, plan);
if (configManifest.planned_observations !== plan.length) {
  throw new Error("Complementary configuration manifest has a different planned observation count");
}
for (const observation of observations) {
  if (!observation.model_invoked) {
    throw new Error(`Synthesis observation ${observation.observation_id} did not invoke the model`);
  }
  if (observation.transport_attempts > freeze.model.transportRetries + 1) {
    throw new Error(
      `Synthesis observation ${observation.observation_id} exceeds the frozen transport-attempt budget`,
    );
  }
  if (observation.provider !== freeze.model.provider) {
    throw new Error(`Observation ${observation.observation_id} has a mismatched model provider`);
  }
  if (observation.model !== freeze.model.model) {
    throw new Error(`Observation ${observation.observation_id} has a mismatched model name`);
  }
}
const cases = new Map(corpus.cases.map((item) => [item.case_id, item]));
const scored = observations.map((observation) =>
  score(observation, requiredCase(observation.case_id)),
);
const rawGenerated = observations.map((observation) => {
  if (observation.raw_model_candidate === null) {
    throw new Error(`Observation ${observation.observation_id} lacks its raw model candidate`);
  }
  const item = requiredCase(observation.case_id);
  const recomputedValidationCodes = validateComplementaryRawGeneration(
    observation.raw_model_candidate,
    item,
  );
  if (
    JSON.stringify(recomputedValidationCodes) !==
    JSON.stringify([...observation.raw_validation_codes].sort())
  ) {
    throw new Error(
      `Observation ${observation.observation_id} has mismatched raw validation codes`,
    );
  }
  return {
    ...scoreComplementaryRawGeneration(observation.raw_model_candidate, item),
    case_id: item.case_id,
    stratum: item.stratum,
  };
});
const raw = corpus.cases.map((item) => baseline(item, "raw-structured-record-access"));
const deterministic = corpus.cases.map((item) => baseline(item, "sequential-deterministic-query"));

const conditionSummaries = [
  summarize("raw-structured-record-access", raw),
  summarize("sequential-deterministic-query", deterministic),
  summarize("governed-evllm-synthesis", scored),
];
// Raw-record and sequential-query conditions are analytic interface references.
// Their prescribed step counts are reported descriptively; no response-quality
// values or inferential tests are fabricated for interfaces that generated no response.
const contrasts: never[] = [];
const rawGenerationSummary = summarizeRawGeneration(rawGenerated);
const rawGenerationStrata = corpus.strata.map((stratum) =>
  summarizeRawGeneration(
    rawGenerated.filter((item) => item.stratum === stratum),
    stratum,
  ),
);

const strata = corpus.strata.map((stratum) => {
  const values = scored.filter(
    (item): item is Score & ReturnTypeNarrowed =>
      item.stratum === stratum && hasObservedResponseMetrics(item),
  );
  return {
    stratum,
    observations: values.length,
    record_coverage: mean(values.map((item) => item.required_record_coverage)),
    recorded_decision_and_outcome_accuracy: mean(
      values.map((item) => item.recorded_decision_and_outcome_accuracy),
    ),
    citation_validity: mean(values.map((item) => item.citation_validity)),
    unsupported_claim_rate: mean(values.map((item) => item.unsupported_claim_rate)),
    missing_information_detection: nullableMean(
      values
        .map((item) => item.missing_information_detection)
        .filter((value): value is number => value !== null),
    ),
    conflicting_information_detection: nullableMean(
      values
        .map((item) => item.conflicting_information_detection)
        .filter((value): value is number => value !== null),
    ),
    synthesis_success: mean(values.map((item) => item.single_response_supported_synthesis_success)),
  };
});

const sourceCommits = new Set(observations.map((item) => item.source_commit));
if (sourceCommits.size !== 1) throw new Error("Complementary results span source commits");
const evaluationSetIds = new Set(observations.map((item) => item.evaluation_set_id));
if (evaluationSetIds.size !== 1)
  throw new Error("Complementary results span evaluation set identifiers");
if (configManifest.source_commit !== [...sourceCommits][0])
  throw new Error("Complementary source commit differs from its configuration manifest");
if (configManifest.evaluation_set_id !== [...evaluationSetIds][0])
  throw new Error("Complementary evaluation set differs from its configuration manifest");
const analysis = {
  schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_ANALYSIS_V2",
  generated_at: new Date().toISOString(),
  interpretation_boundary:
    "Machine-measured interface behavior only; no subjective usefulness, comprehension, preference or cognitive-effort claim.",
  resampling_unit: "case_id",
  case_clusters: corpus.cases.length,
  resampling_method:
    "Resample cases with replacement while retaining all five governed repetitions from each sampled case; the corresponding prescribed interaction count remains paired with its case.",
  integrity: {
    planned_observations: plan.length,
    observations: observations.length,
    unique_observation_ids: new Set(observations.map((item) => item.observation_id)).size,
    source_commit: [...sourceCommits][0],
    analysis_source_commit: currentSource.sourceCommit,
    evaluation_set_id: [...evaluationSetIds][0],
    freeze_sha256: configManifest.freeze_sha256,
    corpus_file_sha256: configManifest.corpus_file_sha256,
    logical_corpus_sha256: configManifest.logical_corpus_sha256,
    observations_sha256: `0x${createHash("sha256").update(observationBytes).digest("hex")}`,
    score_derivation:
      "Released-pipeline metrics were recomputed from the checksum-bound released response and validation fields; raw-generation diagnostics were recomputed separately from the retained pre-binding model candidate.",
    planned_model_bearing_observations: plan.length,
    planned_model_invocations: plan.length,
    successful_model_invocations: transportSummary.successful_invocations,
    model_transport_attempts: transportSummary.transport_attempts,
    model_transport_retries: transportSummary.retry_attempts,
    failed_model_transport_attempts: transportSummary.failed_attempts,
    interrupted_model_transport_attempts: transportSummary.interrupted_attempts,
    transport_attempt_journal_sha256: await transportJournal.fileSha256(),
    observations_requiring_retry: observations.filter((item) => item.transport_attempts > 1).length,
    maximum_transport_attempts: Math.max(...observations.map((item) => item.transport_attempts)),
    input_tokens: transportSummary.input_tokens,
    output_tokens: transportSummary.output_tokens,
    latency_ms: quantiles(observations.map((item) => item.duration_ms)),
  },
  condition_summaries: conditionSummaries,
  raw_generation_summary: rawGenerationSummary,
  raw_generation_strata: rawGenerationStrata,
  paired_case_level_contrasts: contrasts,
  evllm_strata: strata,
};

await Promise.all([
  writeFile(resolve(directory, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`),
  writeFile(resolve(directory, "condition-summary.csv"), csv(conditionSummaries)),
  writeFile(resolve(directory, "raw-generation-summary.csv"), csv([rawGenerationSummary])),
  writeFile(resolve(directory, "raw-generation-stratum-summary.csv"), csv(rawGenerationStrata)),
  writeFile(resolve(directory, "stratum-summary.csv"), csv(strata)),
  writeFile(resolve(directory, "summary.md"), markdownSummary()),
  writeFile(resolve(directory, "interaction-burden.svg"), interactionSvg()),
]);
process.stdout.write(
  `${JSON.stringify({ schema: analysis.schema, integrity: analysis.integrity, condition_summaries: conditionSummaries }, null, 2)}\n`,
);

function assertComplementaryEffectiveConfiguration(): void {
  const { corpus_sha256: recordedLogicalDigest, ...unsignedCorpus } = corpus;
  const actualLogicalDigest = sha256Json(unsignedCorpus);
  const actualCorpusFileDigest = sha256Bytes(corpusBytes);
  const actualFreezeDigest = sha256Bytes(freezeBytes);
  for (const [label, actual, expected] of [
    ["manifest schema", configManifest.schema, "EVLLM_COMPLEMENTARY_SYNTHESIS_CONFIG_MANIFEST_V2"],
    ["evaluation set", configManifest.evaluation_set_id, freeze.evaluation_set_id],
    ["freeze digest", configManifest.freeze_sha256, actualFreezeDigest],
    ["corpus file digest", configManifest.corpus_file_sha256, actualCorpusFileDigest],
    ["frozen corpus file digest", freeze.corpus.corpusFileSha256, actualCorpusFileDigest],
    ["logical corpus digest", configManifest.logical_corpus_sha256, actualLogicalDigest],
    ["recorded logical corpus digest", recordedLogicalDigest, actualLogicalDigest],
    ["frozen logical corpus digest", freeze.corpus.logicalCorpusSha256, actualLogicalDigest],
    ["model provider", freeze.model.provider, "openai"],
    ["model API", freeze.model.api, "responses"],
    ["model", configManifest.model, freeze.model.model],
    ["temperature", configManifest.temperature, freeze.model.temperature],
    ["output-token limit", configManifest.max_output_tokens, freeze.model.maxOutputTokens],
    [
      "provider internal retries",
      configManifest.provider_internal_retries,
      freeze.model.providerMaxRetries,
    ],
    ["frozen provider internal retries", freeze.model.providerMaxRetries, 0],
    ["provider storage", configManifest.store, freeze.model.store],
    [
      "transport retry policy",
      configManifest.maximum_transport_retries_per_invocation,
      freeze.model.transportRetries,
    ],
    ["planned observations", configManifest.planned_observations, plan.length],
    [
      "planned model-bearing observations",
      configManifest.planned_model_bearing_observations,
      plan.length,
    ],
    ["planned model invocations", configManifest.planned_model_invocations, plan.length],
    ["plan digest", configManifest.plan_sha256, sha256Json(plan)],
    ["frozen planned observations", freeze.model.plannedMaximumModelResponses, plan.length],
    [
      "planned transport-attempt maximum",
      configManifest.planned_transport_attempts_maximum,
      plan.length * (freeze.model.transportRetries + 1),
    ],
    ["frozen case count", freeze.corpus.caseCount, corpus.cases.length],
  ] as const) {
    if (actual !== expected) {
      throw new Error(
        `Complementary effective configuration has a mismatched ${label}: expected ${String(expected)}, received ${String(actual)}`,
      );
    }
  }
  if (JSON.stringify(configManifest.conditions) !== JSON.stringify(freeze.conditions)) {
    throw new Error("Complementary configuration manifest has a mismatched condition list");
  }
  if (JSON.stringify(configManifest.primary_metrics) !== JSON.stringify(freeze.primaryMetrics)) {
    throw new Error("Complementary configuration manifest has a mismatched primary metric list");
  }
}

function sha256Bytes(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Json(value: unknown): string {
  return sha256Bytes(Buffer.from(JSON.stringify(value), "utf8"));
}

interface Corpus {
  corpus_sha256: string;
  strata: string[];
  cases: SynthesisCase[];
}

type ReturnTypeNarrowed = {
  required_record_coverage: number;
  deterministic_record_binding: number;
  recorded_decision_preservation: number;
  structured_outcome_accuracy: number;
  recorded_decision_and_outcome_accuracy: number;
  citation_validity: number;
  unsupported_claim_rate: number;
  unsupported_claim_count: number;
  claim_count: number;
  missing_information_detection: number | null;
  conflicting_information_detection: number | null;
  pipeline_validation_accuracy: number;
  single_response_supported_synthesis_success: number;
};
interface SynthesisCase extends ComplementarySynthesisCase {
  raw_record_operations: number;
  sequential_deterministic_operations: number;
}
type Observation = ComplementarySynthesisStoredObservation & ComplementarySynthesisObservation;
interface RawGenerationScore extends ComplementaryRawGenerationScore {
  readonly case_id: string;
  readonly stratum: string;
}
interface Score extends Omit<
  ComplementarySynthesisScore,
  | "required_record_coverage"
  | "deterministic_record_binding"
  | "recorded_decision_preservation"
  | "structured_outcome_accuracy"
  | "recorded_decision_and_outcome_accuracy"
  | "citation_validity"
  | "unsupported_claim_rate"
  | "unsupported_claim_count"
  | "claim_count"
  | "pipeline_validation_accuracy"
  | "single_response_supported_synthesis_success"
> {
  condition: string;
  case_id: string;
  stratum: string;
  required_record_coverage: number | null;
  deterministic_record_binding: number | null;
  recorded_decision_preservation: number | null;
  structured_outcome_accuracy: number | null;
  recorded_decision_and_outcome_accuracy: number | null;
  citation_validity: number | null;
  unsupported_claim_rate: number | null;
  unsupported_claim_count: number | null;
  claim_count: number | null;
  pipeline_validation_accuracy: number | null;
  single_response_supported_synthesis_success: number | null;
}

function score(observation: Observation, item: SynthesisCase): Score {
  return {
    ...scoreComplementarySynthesis(observation, item),
    condition: "governed-evllm-synthesis",
    case_id: item.case_id,
    stratum: item.stratum,
  };
}

function baseline(
  item: SynthesisCase,
  condition: "raw-structured-record-access" | "sequential-deterministic-query",
): Score {
  return complementaryAnalyticReference(item, condition);
}

function summarize(condition: string, values: readonly Score[]): Record<string, unknown> {
  const missingDetections = values
    .filter((item) => item.missing_information_detection !== null)
    .map((item) => item.missing_information_detection!);
  const conflictingDetections = values
    .filter((item) => item.conflicting_information_detection !== null)
    .map((item) => item.conflicting_information_detection!);
  const responseValues = values.filter(hasObservedResponseMetrics);
  const unsupportedClaimCount = responseValues.reduce(
    (total, item) => total + item.unsupported_claim_count,
    0,
  );
  const claimCount = responseValues.reduce((total, item) => total + item.claim_count, 0);
  return {
    condition,
    observations: values.length,
    case_clusters: new Set(values.map((item) => item.case_id)).size,
    operation_count_median: quantiles(values.map((item) => item.operation_count)).median,
    required_record_coverage_mean: nullableMean(
      responseValues.map((item) => item.required_record_coverage),
    ),
    deterministic_record_binding:
      responseValues.length === 0
        ? null
        : clusteredBinary(
            responseValues,
            `${condition}:deterministic-record-binding`,
            (item) => item.deterministic_record_binding,
          ),
    recorded_decision_and_outcome_accuracy:
      responseValues.length === 0
        ? null
        : clusteredBinary(
            responseValues,
            `${condition}:recorded-decision-and-outcome-accuracy`,
            (item) => item.recorded_decision_and_outcome_accuracy,
          ),
    recorded_decision_preservation:
      responseValues.length === 0
        ? null
        : clusteredBinary(
            responseValues,
            `${condition}:recorded-decision-preservation`,
            (item) => item.recorded_decision_preservation,
          ),
    structured_outcome_accuracy:
      responseValues.length === 0
        ? null
        : clusteredBinary(
            responseValues,
            `${condition}:structured-outcome-accuracy`,
            (item) => item.structured_outcome_accuracy,
          ),
    pipeline_validation_accuracy:
      responseValues.length === 0
        ? null
        : clusteredBinary(
            responseValues,
            `${condition}:pipeline-validation-accuracy`,
            (item) => item.pipeline_validation_accuracy,
          ),
    citation_validity_mean: nullableMean(responseValues.map((item) => item.citation_validity)),
    unsupported_claim_rate_mean: nullableMean(
      responseValues.map((item) => item.unsupported_claim_rate),
    ),
    unsupported_claims:
      responseValues.length === 0
        ? null
        : {
            numerator: unsupportedClaimCount,
            denominator: claimCount,
            estimate: claimCount === 0 ? 0 : unsupportedClaimCount / claimCount,
          },
    unsupported_claim_response_rate:
      responseValues.length === 0
        ? null
        : clusteredBinary(responseValues, `${condition}:unsupported-claim-response-rate`, (item) =>
            (item.unsupported_claim_count ?? 0) > 0 ? 1 : 0,
          ),
    missing_information_detection:
      missingDetections.length === 0
        ? null
        : clusteredBinary(
            values,
            `${condition}:missing-information-detection`,
            (item) => item.missing_information_detection,
          ),
    conflicting_information_detection:
      conflictingDetections.length === 0
        ? null
        : clusteredBinary(
            values,
            `${condition}:conflicting-information-detection`,
            (item) => item.conflicting_information_detection,
          ),
    synthesis_success:
      responseValues.length === 0
        ? null
        : clusteredBinary(
            responseValues,
            `${condition}:synthesis-success`,
            (item) => item.single_response_supported_synthesis_success,
          ),
  };
}

function summarizeRawGeneration(
  values: readonly RawGenerationScore[],
  stratum?: string,
): Record<string, unknown> {
  if (values.length === 0) throw new Error("Raw-generation summary requires observations");
  const prefix = stratum === undefined ? "raw-generation" : `raw-generation:${stratum}`;
  return {
    ...(stratum === undefined ? {} : { stratum }),
    observations: values.length,
    case_clusters: new Set(values.map((item) => item.case_id)).size,
    required_record_coverage_mean: mean(values.map((item) => item.required_record_coverage)),
    all_required_records_covered: clusteredBinary(
      values,
      `${prefix}:all-required-records-covered`,
      (item) => item.all_required_records_covered,
    ),
    deterministic_record_binding: clusteredBinary(
      values,
      `${prefix}:deterministic-record-binding`,
      (item) => item.deterministic_record_binding,
    ),
    decision_code_accuracy: clusteredBinary(
      values,
      `${prefix}:decision-code-accuracy`,
      (item) => item.decision_code_accuracy,
    ),
    structured_outcome_accuracy: clusteredBinary(
      values,
      `${prefix}:structured-outcome-accuracy`,
      (item) => item.structured_outcome_accuracy,
    ),
    required_reason_accuracy: clusteredBinary(
      values,
      `${prefix}:required-reason-accuracy`,
      (item) => item.required_reason_accuracy,
    ),
    raw_candidate_validation_accuracy: clusteredBinary(
      values,
      `${prefix}:candidate-validation-accuracy`,
      (item) => item.raw_candidate_validation_accuracy,
    ),
    generation_success: clusteredBinary(
      values,
      `${prefix}:generation-success`,
      (item) => item.generation_success,
    ),
    claims: values.reduce((total, item) => total + item.claim_count, 0),
  };
}

function clusteredBinary<T extends { readonly case_id: string }>(
  values: readonly T[],
  seedLabel: string,
  outcome: (item: T) => number | null,
): Record<string, number | string> {
  const grouped = new Map<string, number[]>();
  for (const item of values) {
    const result = outcome(item);
    if (result === null) continue;
    const cluster = grouped.get(item.case_id) ?? [];
    cluster.push(result);
    grouped.set(item.case_id, cluster);
  }
  const clusters = [...grouped.values()];
  if (clusters.length === 0) throw new Error(`No eligible clusters for ${seedLabel}`);
  const total = clusters.reduce((count, cluster) => count + cluster.length, 0);
  const successes = clusters.reduce(
    (count, cluster) => count + cluster.reduce((sum, value) => sum + value, 0),
    0,
  );
  const boundary = successes === 0 || successes === total;
  const interval = boundary
    ? wilsonInterval(successes === 0 ? 0 : clusters.length, clusters.length)
    : clusteredBootstrapMean(clusters, 10_000, seedFromLabel(seedLabel));
  return {
    numerator: successes,
    denominator: total,
    estimate: successes / total,
    ci_lower: interval.lower,
    ci_upper: interval.upper,
    case_clusters: clusters.length,
    ci_method: boundary ? "case-cluster-boundary-wilson" : "case-cluster-bootstrap",
  };
}

function requiredCase(caseId: string): SynthesisCase {
  const item = cases.get(caseId);
  if (item === undefined) throw new Error(`Missing case ${caseId}`);
  return item;
}

function nullableMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : mean(values);
}

function hasObservedResponseMetrics(item: Score): item is Score & {
  required_record_coverage: number;
  deterministic_record_binding: number;
  recorded_decision_preservation: number;
  structured_outcome_accuracy: number;
  recorded_decision_and_outcome_accuracy: number;
  citation_validity: number;
  unsupported_claim_rate: number;
  unsupported_claim_count: number;
  claim_count: number;
  pipeline_validation_accuracy: number;
  single_response_supported_synthesis_success: number;
} {
  return item.claim_count !== null;
}

function markdownSummary(): string {
  const conditionLabels: Record<string, string> = {
    "raw-structured-record-access": "Raw structured records",
    "sequential-deterministic-query": "Sequential deterministic queries",
    "governed-evllm-synthesis": "Governed conversational synthesis",
  };
  const row = (summary: Record<string, unknown>): string => {
    const decision = summary.recorded_decision_and_outcome_accuracy as Record<
      string,
      number
    > | null;
    const missingDetection = summary.missing_information_detection as Record<string, number> | null;
    const conflictDetection = summary.conflicting_information_detection as Record<
      string,
      number
    > | null;
    const synthesis = summary.synthesis_success as Record<string, number> | null;
    const condition = summary.condition as string;
    return `| ${conditionLabels[condition] ?? condition} | ${String(summary.operation_count_median)} | ${nullablePct(summary.required_record_coverage_mean)} | ${decision === null ? "N/A" : pct(decision.estimate!)} | ${nullablePct(summary.citation_validity_mean)} | ${nullablePct(summary.unsupported_claim_rate_mean)} | ${missingDetection === null ? "N/A" : pct(missingDetection.estimate!)} | ${conflictDetection === null ? "N/A" : pct(conflictDetection.estimate!)} | ${synthesis === null ? "N/A" : pct(synthesis.estimate!)} |`;
  };
  const governed = conditionSummaries.find(
    (item) => item.condition === "governed-evllm-synthesis",
  )!;
  const unsupported = governed.unsupported_claims as Record<string, number>;
  const unsupportedResponses = governed.unsupported_claim_response_rate as Record<string, number>;
  const rawMetric = (name: string): Record<string, number> =>
    rawGenerationSummary[name] as Record<string, number>;
  return `# Complementary conversational synthesis results\n\nThe released-pipeline results are the end-to-end system outcomes. Recorded-decision preservation compares the structured decision code and outcome with the typed decision attached to the final deterministic record. Citation-ID validity records whether citation IDs resolve to active supplied records, while the predefined lexical, numeric, polarity, and incompatible-status checks reject specified contradictions. Missing- and conflicting-information detection are reported separately over the cases to which each requirement applies. Complete synthesis requires those properties in one pipeline-validated response. Raw-record and sequential-query conditions are analytic interface references, so only their prescribed operation counts are reported; response-quality entries are not applicable.\n\n| Condition | Median user-visible operations | Required-record coverage | Recorded decision and outcome | Citation-ID validity | Unsupported claim rate | Missing-information detection | Conflicting-information detection | Complete one-response synthesis |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|\n${conditionSummaries.map(row).join("\n")}\n\nThe unsupported-claim count is ${String(unsupported.numerator)}/${String(unsupported.denominator)}. The case-cluster 95% upper bound for a governed response containing an unsupported claim is ${pct(unsupportedResponses.ci_upper!)}.\n\n## Raw model-generation diagnostics\n\nThese diagnostics describe the retained structured model candidate before deterministic decision binding and fail-closed response validation. Because the model receives the typed deterministic record, they measure explanatory fidelity to supplied decision metadata rather than independent decision accuracy.\n\n| Observations | Required-record coverage | All records covered | Decision metadata fidelity | Decision-code fidelity | Outcome fidelity | Reason-code fidelity | Raw validation passed | Complete raw synthesis |\n|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n| ${String(rawGenerationSummary.observations)} | ${pct(rawGenerationSummary.required_record_coverage_mean as number)} | ${pct(rawMetric("all_required_records_covered").estimate!)} | ${pct(rawMetric("deterministic_record_binding").estimate!)} | ${pct(rawMetric("decision_code_accuracy").estimate!)} | ${pct(rawMetric("structured_outcome_accuracy").estimate!)} | ${pct(rawMetric("required_reason_accuracy").estimate!)} | ${pct(rawMetric("raw_candidate_validation_accuracy").estimate!)} | ${pct(rawMetric("generation_success").estimate!)} |\n\nThese are machine-observed interface properties rather than subjective usability ratings.\n`;
}

function nullablePct(value: unknown): string {
  return typeof value === "number" ? pct(value) : "N/A";
}

function seedFromLabel(label: string): number {
  return createHash("sha256").update(label).digest().readUInt32BE(0);
}

function interactionSvg(): string {
  const rows = conditionSummaries.map((summary, index) => {
    const value = summary.operation_count_median as number;
    const y = 55 + index * 55;
    return `<text x="280" y="${y + 17}" text-anchor="end">${summary.condition as string}</text><rect x="290" y="${y}" width="${value * 80}" height="25" fill="#315b7d"/><text x="${300 + value * 80}" y="${y + 17}">${String(value)}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="250"><style>text{font:14px system-ui,sans-serif}</style><rect width="100%" height="100%" fill="white"/><text x="290" y="25" font-size="18" font-weight="600">Median user-visible operations per case</text>${rows.join("")}</svg>`;
}

function csv(rows: ReadonlyArray<Record<string, unknown>>): string {
  const headers = Object.keys(rows[0]!);
  return `${headers.join(",")}\n${rows.map((row) => headers.map((header) => csvValue(row[header])).join(",")).join("\n")}\n`;
}
function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "object") text = JSON.stringify(value);
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    text = String(value);
  else throw new Error("Unsupported CSV value");
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
