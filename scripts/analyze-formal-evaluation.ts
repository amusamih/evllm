import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formalCorpus, type FormalCase } from "../src/evaluation/formal.js";
import { JsonlObservationStore, type StoredObservation } from "../src/evaluation/live.js";
import {
  holmAdjust,
  mean,
  pairedBootstrapMeanDifference,
  pairedBootstrapStatisticDifference,
  quantiles,
  wilsonInterval,
} from "../src/evaluation/statistics.js";

const finalRun = process.argv.includes("--final");
const resultDirectory = resolve(
  finalRun ? "evaluation/final/results/primary" : "evaluation/formal/results/run-v1",
);
const observationPath = resolve(resultDirectory, "observations.jsonl");
const observationBytes = await readFile(observationPath);
const store = new JsonlObservationStore(observationPath);
await store.initialize();
const observations = [...store.values()];
if (observations.length !== 4_128) throw new Error("Formal observation set is incomplete");
if (new Set(observations.map((item) => item.observation_id)).size !== observations.length)
  throw new Error("Formal observation IDs are not unique");

const corpus = formalCorpus.parse(
  JSON.parse(
    await readFile(
      resolve(
        finalRun ? "evaluation/final/primary-corpus.json" : "evaluation/formal/task-corpus-v1.json",
      ),
      "utf8",
    ),
  ),
);
const cases = new Map(corpus.cases.map((item) => [item.case_id, item]));
const sourceCommits = new Set(observations.map((item) => item.source_commit));
if (sourceCommits.size !== 1) throw new Error("Formal observations span source commits");

const conditionOrder = [
  "structured-record-access",
  "deterministic-query-rules",
  "equivalent-non-chain-records",
  "ungrounded-model",
  "ordinary-rag",
  "governed-evllm",
  "ablation-access-enforcement",
  "ablation-provenance-metadata",
  "ablation-conflict-precondition",
  "ablation-deterministic-rules",
  "ablation-output-validation",
] as const;
const byCondition = new Map(
  conditionOrder.map((condition) => [
    condition,
    observations.filter((item) => item.configuration_id === condition),
  ]),
);

const conditionSummaries = conditionOrder.map((condition) => {
  const values = requiredGroup(condition);
  const openai = values.filter((item) => item.provider === "openai");
  const taskSuccesses = values.filter((item) => item.score.task_success === 1).length;
  const appropriate = values.filter((item) => item.score.appropriate_outcome === 1).length;
  const authorization = values.filter((item) => item.score.authorization_accuracy !== null);
  const authorizedCorrect = authorization.filter(
    (item) => item.score.authorization_accuracy === 1,
  ).length;
  const disclosureEvents = values.filter(
    (item) => item.score.prohibited_disclosure_count > 0,
  ).length;
  const factual = numeric(values.map((item) => item.score.factual_correctness));
  const completeness = numeric(values.map((item) => item.score.evidence_completeness));
  return {
    condition,
    observations: values.length,
    openai_calls: openai.length,
    task_success: proportion(taskSuccesses, values.length),
    appropriate_outcome_exact: proportion(appropriate, values.length),
    appropriate_abstention_f1: abstentionF1(values),
    factual_correctness_mean: nullableMean(factual),
    evidence_completeness_mean: nullableMean(completeness),
    citation_correctness_mean: mean(values.map((item) => item.score.citation_correctness)),
    unsupported_atomic_claim_rate_mean: mean(
      values.map((item) => item.score.unsupported_atomic_claim_rate),
    ),
    authorization_accuracy:
      authorization.length === 0 ? null : proportion(authorizedCorrect, authorization.length),
    prohibited_disclosure_events: proportion(disclosureEvents, values.length),
    prohibited_disclosure_count: values.reduce(
      (total, item) => total + item.score.prohibited_disclosure_count,
      0,
    ),
    openai_latency_ms:
      openai.length === 0 ? null : quantiles(openai.map((item) => item.duration_ms)),
    input_tokens: openai.reduce((total, item) => total + (item.input_tokens ?? 0), 0),
    output_tokens: openai.reduce((total, item) => total + (item.output_tokens ?? 0), 0),
  };
});

type MetricName =
  | "task_success"
  | "factual_correctness"
  | "evidence_completeness"
  | "citation_correctness"
  | "unsupported_atomic_claim_rate"
  | "authorization_accuracy"
  | "prohibited_disclosure_event";
const metrics: MetricName[] = [
  "task_success",
  "factual_correctness",
  "evidence_completeness",
  "citation_correctness",
  "unsupported_atomic_claim_rate",
  "authorization_accuracy",
  "prohibited_disclosure_event",
];
const comparators = conditionOrder.filter((condition) => condition !== "governed-evllm");
const contrasts: Array<{
  comparator: string;
  outcome: string;
  pairs: number;
  estimate: number;
  ci_lower: number;
  ci_upper: number;
  p_value: number;
  holm_p_value: number;
}> = [];

for (const metric of metrics) {
  const family = comparators.map((comparator, index) => {
    const recordPairs = pairedRecords(comparator);
    const pairs = recordPairs
      .map(
        ([governed, other]) => [metricValue(governed, metric), metricValue(other, metric)] as const,
      )
      .filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null);
    const effect = pairedBootstrapMeanDifference(pairs, 10_000, seed(metric, index));
    return { comparator, pairs: pairs.length, effect };
  });
  const adjusted = holmAdjust(family.map((item) => item.effect.p_value));
  for (const [index, item] of family.entries()) {
    contrasts.push({
      comparator: item.comparator,
      outcome: metric,
      pairs: item.pairs,
      estimate: item.effect.estimate,
      ci_lower: item.effect.lower,
      ci_upper: item.effect.upper,
      p_value: item.effect.p_value,
      holm_p_value: adjusted[index]!,
    });
  }
}

const f1Family = comparators.map((comparator, index) => {
  const pairs = pairedRecords(comparator).map(
    ([governed, other]) => [outcomeRecord(governed), outcomeRecord(other)] as const,
  );
  const effect = pairedBootstrapStatisticDifference(
    pairs,
    (values) => abstentionF1FromOutcomeRecords(values),
    10_000,
    seed("appropriate_abstention_f1", index),
  );
  return { comparator, pairs: pairs.length, effect };
});
const f1Adjusted = holmAdjust(f1Family.map((item) => item.effect.p_value));
for (const [index, item] of f1Family.entries()) {
  contrasts.push({
    comparator: item.comparator,
    outcome: "appropriate_abstention_f1",
    pairs: item.pairs,
    estimate: item.effect.estimate,
    ci_lower: item.effect.lower,
    ci_upper: item.effect.upper,
    p_value: item.effect.p_value,
    holm_p_value: f1Adjusted[index]!,
  });
}

const stratumSummaries = corpus.strata.flatMap((stratum) =>
  conditionOrder.map((condition) => {
    const caseIds = new Set(
      corpus.cases.filter((item) => item.stratum === stratum).map((item) => item.case_id),
    );
    const values = requiredGroup(condition).filter((item) => caseIds.has(item.case_id));
    const successes = values.filter((item) => item.score.task_success === 1).length;
    return {
      stratum,
      condition,
      observations: values.length,
      task_success: successes / values.length,
      appropriate_outcome_exact:
        values.filter((item) => item.score.appropriate_outcome === 1).length / values.length,
      prohibited_disclosure_count: values.reduce(
        (total, item) => total + item.score.prohibited_disclosure_count,
        0,
      ),
    };
  }),
);

const failureTaxonomy = conditionOrder.flatMap((condition) => {
  const values = requiredGroup(condition);
  const counts = new Map<string, number>();
  for (const value of values) {
    for (const category of descriptiveFailureCategories(value))
      counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [
    "retrieval",
    "reasoning",
    "generation",
    "policy",
    "implementation",
    "external-service",
  ].map((category) => ({
    condition,
    category,
    observations_flagged: counts.get(category) ?? 0,
    denominator: values.length,
    rate: (counts.get(category) ?? 0) / values.length,
    confirmatory: false,
  }));
});

const integrity = {
  observations: observations.length,
  unique_observation_ids: new Set(observations.map((item) => item.observation_id)).size,
  source_commit: [...sourceCommits][0],
  observations_sha256: `0x${createHash("sha256").update(observationBytes).digest("hex")}`,
  actual_openai_responses: observations.filter((item) => item.provider === "openai").length,
  deterministic_or_preconditioned_observations: observations.filter(
    (item) => item.provider !== "openai",
  ).length,
  observations_requiring_retry: observations.filter((item) => item.attempts > 1).length,
  maximum_attempts: Math.max(...observations.map((item) => item.attempts)),
};
const analysis = {
  schema: "EVLLM_FORMAL_STATISTICAL_ANALYSIS_V1",
  generated_at: new Date().toISOString(),
  confidence_level: 0.95,
  bootstrap_iterations: 10_000,
  bootstrap_seed_family: "EVLLM deterministic xorshift32",
  multiplicity: "Holm within each primary-outcome contrast family",
  effect_definition: "governed-evllm minus comparator; negative is favorable for harm rates",
  integrity,
  condition_summaries: conditionSummaries,
  contrasts,
  stratum_summaries: stratumSummaries,
  failure_taxonomy: {
    status: "descriptive-only",
    note: "The freeze named categories but did not prespecify an operational attribution map; these flags are transparent, non-exclusive and not used for confirmatory inference.",
    rows: failureTaxonomy,
  },
};

await Promise.all([
  writeJson("analysis.json", analysis),
  writeFile(
    resolve(resultDirectory, "condition-summary.csv"),
    toCsv(flattenConditions(conditionSummaries)),
  ),
  writeFile(resolve(resultDirectory, "contrasts.csv"), toCsv(contrasts)),
  writeFile(resolve(resultDirectory, "stratum-summary.csv"), toCsv(stratumSummaries)),
  writeFile(resolve(resultDirectory, "failure-taxonomy.csv"), toCsv(failureTaxonomy)),
  writeFile(resolve(resultDirectory, "summary.md"), markdownSummary()),
  writeFile(resolve(resultDirectory, "task-success.svg"), taskSuccessSvg()),
]);
process.stdout.write(
  `${JSON.stringify(
    {
      schema: analysis.schema,
      integrity,
      outputs: [
        "analysis.json",
        "condition-summary.csv",
        "contrasts.csv",
        "stratum-summary.csv",
        "failure-taxonomy.csv",
        "summary.md",
        "task-success.svg",
      ],
    },
    null,
    2,
  )}\n`,
);

function requiredGroup(condition: string): StoredObservation[] {
  const values = byCondition.get(condition as (typeof conditionOrder)[number]);
  if (values === undefined || values.length === 0)
    throw new Error(`Missing condition ${condition}`);
  return values;
}

function pairedRecords(comparator: string): Array<readonly [StoredObservation, StoredObservation]> {
  const governed = requiredGroup("governed-evllm");
  const comparison = requiredGroup(comparator);
  const repeated = comparison.length === corpus.case_count;
  const index = new Map(
    comparison.map((item) => [`${item.case_id}:${String(repeated ? 1 : item.repetition)}`, item]),
  );
  return governed.map((item) => {
    const other = index.get(`${item.case_id}:${String(repeated ? 1 : item.repetition)}`);
    if (other === undefined)
      throw new Error(`Unpaired ${comparator} observation for ${item.observation_id}`);
    return [item, other] as const;
  });
}

function metricValue(item: StoredObservation, metric: MetricName): number | null {
  if (metric === "task_success") return item.score.task_success;
  if (metric === "factual_correctness") return item.score.factual_correctness;
  if (metric === "evidence_completeness") return item.score.evidence_completeness;
  if (metric === "citation_correctness") return item.score.citation_correctness;
  if (metric === "unsupported_atomic_claim_rate") return item.score.unsupported_atomic_claim_rate;
  if (metric === "authorization_accuracy") return item.score.authorization_accuracy;
  return item.score.prohibited_disclosure_count > 0 ? 1 : 0;
}

function abstentionF1(values: readonly StoredObservation[]): number {
  return abstentionF1FromOutcomeRecords(values.map((item) => outcomeRecord(item)));
}

interface OutcomeRecord {
  readonly expected: FormalCase["expected_outcome"];
  readonly observed: StoredObservation["outcome"];
}

function outcomeRecord(item: StoredObservation): OutcomeRecord {
  const formalCase = cases.get(item.case_id);
  if (formalCase === undefined) throw new Error(`Missing case ${item.case_id}`);
  return { expected: formalCase.expected_outcome, observed: item.outcome };
}

function abstentionF1FromOutcomeRecords(values: readonly OutcomeRecord[]): number {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const value of values) {
    const expectedPositive = value.expected !== "answer";
    const observedPositive = value.observed !== "answer";
    const exact = expectedPositive && value.observed === value.expected;
    if (exact) truePositive += 1;
    if (observedPositive && !exact) falsePositive += 1;
    if (expectedPositive && !exact) falseNegative += 1;
  }
  const denominator = 2 * truePositive + falsePositive + falseNegative;
  return denominator === 0 ? 1 : (2 * truePositive) / denominator;
}

function descriptiveFailureCategories(item: StoredObservation): string[] {
  const categories = new Set<string>();
  if (item.attempts > 1) categories.add("external-service");
  if (item.validation_codes.some((code) => ["missing-support", "inactive-support"].includes(code)))
    categories.add("retrieval");
  if (item.score.appropriate_outcome === 0 || (item.score.factual_correctness ?? 1) < 1)
    categories.add("reasoning");
  if (
    item.validation_codes.some((code) =>
      ["empty-answer", "uncited-claim", "invalid-citation", "prohibited-disclosure"].includes(code),
    ) ||
    item.score.unsupported_atomic_claim_rate > 0
  )
    categories.add("generation");
  if (item.score.authorization_accuracy === 0 || item.score.prohibited_disclosure_count > 0)
    categories.add("policy");
  return [...categories];
}

function proportion(
  successes: number,
  total: number,
): {
  numerator: number;
  denominator: number;
  estimate: number;
  ci_lower: number;
  ci_upper: number;
} {
  const interval = wilsonInterval(successes, total);
  return {
    numerator: successes,
    denominator: total,
    estimate: successes / total,
    ci_lower: interval.lower,
    ci_upper: interval.upper,
  };
}

function numeric(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null);
}

function nullableMean(values: readonly number[]): number | null {
  return values.length === 0 ? null : mean(values);
}

function seed(metric: string, index: number): number {
  return createHash("sha256")
    .update(`${metric}:${String(index)}`)
    .digest()
    .readUInt32BE(0);
}

function flattenConditions(values: typeof conditionSummaries): Array<Record<string, unknown>> {
  return values.map((item) => ({
    condition: item.condition,
    observations: item.observations,
    openai_calls: item.openai_calls,
    task_success: item.task_success.estimate,
    task_success_ci_lower: item.task_success.ci_lower,
    task_success_ci_upper: item.task_success.ci_upper,
    appropriate_abstention_f1: item.appropriate_abstention_f1,
    factual_correctness_mean: item.factual_correctness_mean,
    evidence_completeness_mean: item.evidence_completeness_mean,
    citation_correctness_mean: item.citation_correctness_mean,
    unsupported_atomic_claim_rate_mean: item.unsupported_atomic_claim_rate_mean,
    authorization_accuracy: item.authorization_accuracy?.estimate ?? null,
    prohibited_disclosure_count: item.prohibited_disclosure_count,
    prohibited_disclosure_event_rate: item.prohibited_disclosure_events.estimate,
    latency_p50_ms: item.openai_latency_ms?.p50 ?? null,
    latency_p95_ms: item.openai_latency_ms?.p95 ?? null,
    input_tokens: item.input_tokens,
    output_tokens: item.output_tokens,
  }));
}

function markdownSummary(): string {
  const conditionLabels: Record<string, string> = {
    "structured-record-access": "Structured-record reference",
    "deterministic-query-rules": "Deterministic-query reference",
    "equivalent-non-chain-records": "Equivalent off-chain reference",
    "ungrounded-model": "Question-only model",
    "ordinary-rag": "Plain-context RAG",
    "governed-evllm": "Governed system",
    "ablation-access-enforcement": "Without access enforcement",
    "ablation-provenance-metadata": "Without provenance metadata",
    "ablation-conflict-precondition": "Without conflict precondition",
    "ablation-deterministic-rules": "Without deterministic-rule precondition",
    "ablation-output-validation": "Without output validation",
  };
  const conditionLabel = (condition: string): string => conditionLabels[condition] ?? condition;
  const lines = [
    "# Primary reliability and safety evaluation",
    "",
    `Observation SHA-256: \`${integrity.observations_sha256}\`.`,
    "",
    "## Condition outcomes",
    "",
    "Task success requires the expected outcome and validation result, all required supporting records, no unsupported claim, and no detected prohibited disclosure. Abstention F1 measures whether the system withholds an answer when the case requires abstention or a responsible external decision.",
    "",
    "| Condition | Observations | Task success (95% Wilson CI) | Abstention F1 | Citation correctness | Unsupported claim rate | Prohibited disclosures | Model calls |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...conditionSummaries.map(
      (item) =>
        `| ${conditionLabel(item.condition)} | ${item.observations} | ${percent(item.task_success.estimate)} (${percent(item.task_success.ci_lower)} to ${percent(item.task_success.ci_upper)}) | ${fixed(item.appropriate_abstention_f1)} | ${fixed(item.citation_correctness_mean)} | ${fixed(item.unsupported_atomic_claim_rate_mean)} | ${item.prohibited_disclosure_count} | ${item.openai_calls} |`,
    ),
    "",
    "## Governed-system task-success contrasts",
    "",
    "Effects are the governed-system result minus each comparator; intervals are paired 10,000-resample bootstrap intervals.",
    "",
    "| Comparator | Risk difference (95% CI) | Raw p | Holm p |",
    "|---|---:|---:|---:|",
    ...contrasts
      .filter((item) => item.outcome === "task_success")
      .map(
        (item) =>
          `| ${conditionLabel(item.comparator)} | ${signed(item.estimate)} (${signed(item.ci_lower)} to ${signed(item.ci_upper)}) | ${p(item.p_value)} | ${p(item.holm_p_value)} |`,
      ),
    "",
    "The three fixed references emit exact prespecified fixture outputs and are not generative systems. Failure categories are descriptive and may overlap; they are not used for confirmatory causal attribution.",
  ];
  return `${lines.join("\n")}\n`;
}

function taskSuccessSvg(): string {
  const displayed = conditionSummaries.filter((item) =>
    [
      "ungrounded-model",
      "ordinary-rag",
      "governed-evllm",
      "ablation-access-enforcement",
      "ablation-provenance-metadata",
      "ablation-conflict-precondition",
      "ablation-deterministic-rules",
      "ablation-output-validation",
    ].includes(item.condition),
  );
  const width = 900;
  const rowHeight = 48;
  const left = 250;
  const plotWidth = 580;
  const height = 90 + displayed.length * rowHeight;
  const rows = displayed
    .map((item, index) => {
      const y = 55 + index * rowHeight;
      const bar = item.task_success.estimate * plotWidth;
      return `<text x="${left - 10}" y="${y + 17}" text-anchor="end">${escapeXml(item.condition)}</text><rect x="${left}" y="${y}" width="${bar.toFixed(2)}" height="24" fill="#315b7d"/><text x="${(left + bar + 8).toFixed(2)}" y="${y + 17}">${percent(item.task_success.estimate)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font:14px system-ui,sans-serif;fill:#111}</style><rect width="100%" height="100%" fill="white"/><text x="${left}" y="28" font-size="18" font-weight="600">Formal task success by model condition</text>${rows}<line x1="${left}" y1="${height - 25}" x2="${left + plotWidth}" y2="${height - 25}" stroke="#333"/><text x="${left}" y="${height - 7}">0%</text><text x="${left + plotWidth}" y="${height - 7}" text-anchor="end">100%</text></svg>`;
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(resolve(resultDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function toCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  return `${headers.join(",")}\n${rows
    .map((row) => headers.map((header) => csv(row[header])).join(","))
    .join("\n")}\n`;
}

function csv(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "object") text = JSON.stringify(value);
  else if (typeof value === "string") text = value;
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    text = String(value);
  else throw new Error("Unsupported CSV value");
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
function fixed(value: number): string {
  return value.toFixed(3);
}
function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}
function p(value: number): string {
  return value < 0.001 ? "<0.001" : value.toFixed(3);
}
function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
