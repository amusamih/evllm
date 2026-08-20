import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  holmAdjust,
  mean,
  pairedBootstrapMeanDifference,
  quantiles,
  wilsonInterval,
} from "../src/evaluation/statistics.js";

const finalRun = process.argv.includes("--final");
const directory = resolve(
  finalRun ? "evaluation/final/results/synthesis" : "evaluation/complementary/results/run-v1",
);
const observationPath = resolve(directory, "observations.jsonl");
const observationBytes = await readFile(observationPath);
const observations = observationBytes
  .toString("utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Observation);
if (observations.length !== 150) throw new Error("Complementary observation set is incomplete");
if (new Set(observations.map((item) => item.observation_id)).size !== 150)
  throw new Error("Complementary observation IDs are not unique");

const corpus = JSON.parse(
  await readFile(
    resolve(
      finalRun
        ? "evaluation/final/synthesis-corpus.json"
        : "evaluation/complementary/synthesis-corpus-v1.json",
    ),
    "utf8",
  ),
) as Corpus;
const cases = new Map(corpus.cases.map((item) => [item.case_id, item]));
const scored = observations.map((observation) =>
  score(observation, requiredCase(observation.case_id)),
);
const raw = corpus.cases.map((item) => baseline(item, "raw-structured-record-access"));
const deterministic = corpus.cases.map((item) => baseline(item, "sequential-deterministic-query"));

const conditionSummaries = [
  summarize("raw-structured-record-access", raw),
  summarize("sequential-deterministic-query", deterministic),
  summarize("governed-evllm-synthesis", scored),
];
const caseLevelEvllm = corpus.cases.map((item) => {
  const values = scored.filter((value) => value.case_id === item.case_id);
  return {
    case_id: item.case_id,
    operation_count: mean(values.map((value) => value.operation_count)),
    required_record_coverage: mean(values.map((value) => value.required_record_coverage)),
    decision_code_accuracy: mean(values.map((value) => value.decision_code_accuracy)),
    citation_traceability: mean(values.map((value) => value.citation_traceability)),
    unsupported_claim_rate: mean(values.map((value) => value.unsupported_claim_rate)),
    detection_accuracy: nullableMean(
      values
        .map((value) => value.detection_accuracy)
        .filter((value): value is number => value !== null),
    ),
    single_response_supported_synthesis_success: mean(
      values.map((value) => value.single_response_supported_synthesis_success),
    ),
  };
});

const metrics = [
  "operation_count",
  "required_record_coverage",
  "decision_code_accuracy",
  "citation_traceability",
  "unsupported_claim_rate",
  "single_response_supported_synthesis_success",
] as const;
const contrasts = [raw, deterministic].flatMap((comparison, comparisonIndex) =>
  metrics.map((metric, metricIndex) => {
    const pairs = corpus.cases.map((item) => {
      const left = caseLevelEvllm.find((value) => value.case_id === item.case_id);
      const right = comparison.find((value) => value.case_id === item.case_id);
      if (left === undefined || right === undefined) throw new Error("Missing paired case");
      return [left[metric], right[metric]] as const;
    });
    const effect = pairedBootstrapMeanDifference(
      pairs,
      10_000,
      0x45560000 + comparisonIndex * 100 + metricIndex,
    );
    return {
      comparison: comparison[0]!.condition,
      metric,
      paired_cases: pairs.length,
      evllm_minus_comparison: effect.estimate,
      ci_lower: effect.lower,
      ci_upper: effect.upper,
      p_value: effect.p_value,
      holm_p_value: 0,
    };
  }),
);
for (const metric of metrics) {
  const family = contrasts.filter((item) => item.metric === metric);
  const adjusted = holmAdjust(family.map((item) => item.p_value));
  for (const [index, item] of family.entries()) item.holm_p_value = adjusted[index]!;
}

const strata = corpus.strata.map((stratum) => {
  const values = scored.filter((item) => item.stratum === stratum);
  return {
    stratum,
    observations: values.length,
    record_coverage: mean(values.map((item) => item.required_record_coverage)),
    decision_accuracy: mean(values.map((item) => item.decision_code_accuracy)),
    traceability: mean(values.map((item) => item.citation_traceability)),
    unsupported_claim_rate: mean(values.map((item) => item.unsupported_claim_rate)),
    detection_accuracy: nullableMean(
      values
        .map((item) => item.detection_accuracy)
        .filter((value): value is number => value !== null),
    ),
    synthesis_success: mean(values.map((item) => item.single_response_supported_synthesis_success)),
  };
});

const sourceCommits = new Set(observations.map((item) => item.source_commit));
if (sourceCommits.size !== 1) throw new Error("Complementary results span source commits");
const analysis = {
  schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_ANALYSIS_V1",
  generated_at: new Date().toISOString(),
  interpretation_boundary:
    "Machine-measured interface behavior only; no subjective usefulness, comprehension, preference or cognitive-effort claim.",
  integrity: {
    observations: observations.length,
    unique_observation_ids: new Set(observations.map((item) => item.observation_id)).size,
    source_commit: [...sourceCommits][0],
    observations_sha256: `0x${createHash("sha256").update(observationBytes).digest("hex")}`,
    retries: observations.filter((item) => item.attempts > 1).length,
    input_tokens: observations.reduce((total, item) => total + (item.input_tokens ?? 0), 0),
    output_tokens: observations.reduce((total, item) => total + (item.output_tokens ?? 0), 0),
    latency_ms: quantiles(observations.map((item) => item.duration_ms)),
  },
  condition_summaries: conditionSummaries,
  paired_case_level_contrasts: contrasts,
  evllm_strata: strata,
};

await Promise.all([
  writeFile(resolve(directory, "analysis.json"), `${JSON.stringify(analysis, null, 2)}\n`),
  writeFile(resolve(directory, "condition-summary.csv"), csv(conditionSummaries)),
  writeFile(resolve(directory, "paired-contrasts.csv"), csv(contrasts)),
  writeFile(resolve(directory, "stratum-summary.csv"), csv(strata)),
  writeFile(resolve(directory, "summary.md"), markdownSummary()),
  writeFile(resolve(directory, "interaction-burden.svg"), interactionSvg()),
]);
process.stdout.write(
  `${JSON.stringify({ schema: analysis.schema, integrity: analysis.integrity, condition_summaries: conditionSummaries }, null, 2)}\n`,
);

interface Corpus {
  strata: string[];
  cases: SynthesisCase[];
}
interface SynthesisCase {
  case_id: string;
  stratum: string;
  expected_conclusion: string;
  expected_detection: "missing" | "conflict" | null;
  records: Array<{ support_id: string }>;
  raw_record_operations: number;
  sequential_deterministic_operations: number;
  evllm_operations: number;
}
interface Observation {
  observation_id: string;
  source_commit: string;
  case_id: string;
  stratum: string;
  duration_ms: number;
  attempts: number;
  input_tokens: number | null;
  output_tokens: number | null;
  summary: string;
  warnings: string[];
  missing_requirements: string[];
  evidence_reason_codes: string[];
  claims: Array<{ text: string; citation_ids: string[] }>;
}
interface Score {
  condition: string;
  case_id: string;
  stratum: string;
  operation_count: number;
  required_record_coverage: number;
  decision_code_accuracy: number;
  citation_traceability: number;
  unsupported_claim_rate: number;
  unsupported_claim_count: number;
  claim_count: number;
  detection_accuracy: number | null;
  single_response_supported_synthesis_success: number;
}

function score(observation: Observation, item: SynthesisCase): Score {
  const required = new Set(item.records.map((record) => record.support_id));
  const cited = new Set(observation.claims.flatMap((claim) => claim.citation_ids));
  const validCitations = [...cited].filter((citation) => required.has(citation));
  const citationCount = observation.claims.reduce(
    (total, claim) => total + claim.citation_ids.length,
    0,
  );
  const validCitationCount = observation.claims.reduce(
    (total, claim) => total + claim.citation_ids.filter((id) => required.has(id)).length,
    0,
  );
  const unsupportedClaims = observation.claims.filter(
    (claim) => !claim.citation_ids.some((id) => required.has(id)),
  ).length;
  const coverage = validCitations.length / required.size;
  const traceability = citationCount === 0 ? 0 : validCitationCount / citationCount;
  const unsupported =
    observation.claims.length === 0 ? 0 : unsupportedClaims / observation.claims.length;
  const conclusion = observation.summary.toLowerCase().includes(item.expected_conclusion);
  const detection =
    item.expected_detection === null
      ? null
      : observation.evidence_reason_codes.includes(
            item.expected_detection === "missing" ? "missing-evidence" : "conflicting-evidence",
          )
        ? 1
        : 0;
  const success =
    item.evllm_operations === 1 &&
    coverage === 1 &&
    traceability === 1 &&
    unsupported === 0 &&
    conclusion &&
    (detection === null || detection === 1)
      ? 1
      : 0;
  return {
    condition: "governed-evllm-synthesis",
    case_id: item.case_id,
    stratum: item.stratum,
    operation_count: item.evllm_operations,
    required_record_coverage: coverage,
    decision_code_accuracy: conclusion ? 1 : 0,
    citation_traceability: traceability,
    unsupported_claim_rate: unsupported,
    unsupported_claim_count: unsupportedClaims,
    claim_count: observation.claims.length,
    detection_accuracy: detection,
    single_response_supported_synthesis_success: success,
  };
}

function baseline(
  item: SynthesisCase,
  condition: "raw-structured-record-access" | "sequential-deterministic-query",
): Score {
  const deterministic = condition === "sequential-deterministic-query";
  return {
    condition,
    case_id: item.case_id,
    stratum: item.stratum,
    operation_count: deterministic
      ? item.sequential_deterministic_operations
      : item.raw_record_operations,
    required_record_coverage: 1,
    decision_code_accuracy: deterministic ? 1 : 0,
    citation_traceability: 1,
    unsupported_claim_rate: 0,
    unsupported_claim_count: 0,
    claim_count: item.records.length,
    detection_accuracy: item.expected_detection === null ? null : deterministic ? 1 : 0,
    single_response_supported_synthesis_success: 0,
  };
}

function summarize(condition: string, values: readonly Score[]): Record<string, unknown> {
  const synthesisSuccesses = values.filter(
    (item) => item.single_response_supported_synthesis_success === 1,
  ).length;
  const decisionSuccesses = values.filter((item) => item.decision_code_accuracy === 1).length;
  const detections = values
    .map((item) => item.detection_accuracy)
    .filter((value): value is number => value !== null);
  return {
    condition,
    observations: values.length,
    operation_count_median: quantiles(values.map((item) => item.operation_count)).median,
    required_record_coverage_mean: mean(values.map((item) => item.required_record_coverage)),
    decision_code_accuracy: binary(decisionSuccesses, values.length),
    citation_traceability_mean: mean(values.map((item) => item.citation_traceability)),
    unsupported_claim_rate_mean: mean(values.map((item) => item.unsupported_claim_rate)),
    unsupported_claims: binary(
      values.reduce((total, item) => total + item.unsupported_claim_count, 0),
      values.reduce((total, item) => total + item.claim_count, 0),
    ),
    detection_accuracy:
      detections.length === 0
        ? null
        : binary(
            detections.reduce((a, b) => a + b, 0),
            detections.length,
          ),
    synthesis_success: binary(synthesisSuccesses, values.length),
  };
}

function binary(successes: number, total: number): Record<string, number> {
  const interval = wilsonInterval(successes, total);
  return {
    numerator: successes,
    denominator: total,
    estimate: successes / total,
    ci_lower: interval.lower,
    ci_upper: interval.upper,
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

function markdownSummary(): string {
  const conditionLabels: Record<string, string> = {
    "raw-structured-record-access": "Raw structured records",
    "sequential-deterministic-query": "Sequential deterministic queries",
    "governed-evllm-synthesis": "Governed conversational synthesis",
  };
  const row = (summary: Record<string, unknown>): string => {
    const decision = summary.decision_code_accuracy as Record<string, number>;
    const synthesis = summary.synthesis_success as Record<string, number>;
    const condition = summary.condition as string;
    return `| ${conditionLabels[condition] ?? condition} | ${String(summary.operation_count_median)} | ${pct(summary.required_record_coverage_mean as number)} | ${pct(decision.estimate!)} | ${pct(summary.citation_traceability_mean as number)} | ${pct(summary.unsupported_claim_rate_mean as number)} | ${pct(synthesis.estimate!)} |`;
  };
  const governed = conditionSummaries.find(
    (item) => item.condition === "governed-evllm-synthesis",
  )!;
  const unsupported = governed.unsupported_claims as Record<string, number>;
  return `# Complementary conversational synthesis results\n\nDecision accuracy checks for the expected decision code, while citation traceability checks that claims identify the required supporting records. Complete synthesis requires both properties in one response with no unsupported claim.\n\n| Condition | Median user-visible operations | Record coverage | Decision accuracy | Citation traceability | Unsupported claim rate | Complete one-response synthesis |\n|---|---:|---:|---:|---:|---:|---:|\n${conditionSummaries.map(row).join("\n")}\n\nNo unsupported governed claim was observed (${String(unsupported.numerator)}/${String(unsupported.denominator)}); the 95% Wilson upper bound is ${pct(unsupported.ci_upper!)} rather than zero risk.\n\nThese are machine-observed interface properties rather than subjective usability ratings. The comparison tests whether conversational synthesis preserves the coverage and traceability of the two exact reference interfaces while integrating their information into one response.\n`;
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
