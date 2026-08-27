import { performance } from "node:perf_hooks";
import { cpus, platform, release } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";
import { sha256Bytes } from "./lib/final-evidence-provenance.js";
import { evaluateNominalSustainability } from "./lib/sustainability-evidence.js";

const evaluationBindingSchema = z
  .object({
    evaluation_set_id: z.string().min(1),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
  })
  .passthrough();

const primaryBinding = evaluationBindingSchema.parse(
  JSON.parse(
    await readFile(
      resolve("evaluation/final/results/primary/evaluation-config-manifest.json"),
      "utf8",
    ),
  ),
);
const synthesisBinding = evaluationBindingSchema.parse(
  JSON.parse(
    await readFile(
      resolve("evaluation/final/results/synthesis/evaluation-config-manifest.json"),
      "utf8",
    ),
  ),
);
if (
  primaryBinding.source_commit !== synthesisBinding.source_commit ||
  primaryBinding.evaluation_set_id !== synthesisBinding.evaluation_set_id
) {
  throw new Error("Primary and synthesis evaluations do not share one source and evaluation set");
}
const currentSource = assertCommittedEvaluationSource(
  [
    "evaluation/final/results",
    "evaluation/final/assurance",
    "evaluation/final/demonstrations",
    "evaluation/final/sustainability-validation.json",
    "evaluation/final/SUSTAINABILITY_RESULTS.md",
    "evaluation/final/FINAL_RESULTS.md",
    "evaluation/final/RESOURCE_RESULTS.md",
    "evaluation/final/BLOCKCHAIN_RESULTS.md",
    "evaluation/final/evidence-manifest.json",
  ],
  {
    expectedSourceCommit: primaryBinding.source_commit,
    operation: "Resource characterization",
  },
);

const warmRuns = 1_000;
const firstStarted = performance.now();
const first = evaluateNominalSustainability(1);
const firstCallMs = performance.now() - firstStarted;
const warmDurations: number[] = [];
for (let index = 0; index < warmRuns; index += 1) {
  const started = performance.now();
  const result = evaluateNominalSustainability((index % 5) + 1);
  if (result.routes.length !== 3) throw new Error("Unexpected assessment result");
  warmDurations.push(performance.now() - started);
}
warmDurations.sort((a, b) => a - b);

const measuredFiles = [
  "evaluation/final/results/primary/observations.jsonl",
  "evaluation/final/results/synthesis/observations.jsonl",
  "evaluation/final/primary-corpus.json",
  "evaluation/final/synthesis-corpus.json",
  "evaluation/final/sustainability-validation.json",
];
const files = await Promise.all(
  measuredFiles.map(async (path) => {
    const content = await readFile(resolve(path));
    return { path, bytes: content.byteLength, sha256: sha256Bytes(content) };
  }),
);
const output = {
  schema: "EVLLM_RESOURCE_CHARACTERIZATION_V2",
  measured_at: new Date().toISOString(),
  source_commit: currentSource.sourceCommit,
  evaluation_set_id: primaryBinding.evaluation_set_id,
  source_scope: "controlled local deterministic assessment microbenchmark and exact artifact sizes",
  environment: {
    node: process.version,
    platform: platform(),
    release: release(),
    logical_cpu_count: cpus().length,
    cpu_model: cpus()[0]?.model ?? "unknown",
  },
  deterministic_assessment: {
    first_call_ms: firstCallMs,
    warm_runs: warmRuns,
    warm_p50_ms: quantile(warmDurations, 0.5),
    warm_p95_ms: quantile(warmDurations, 0.95),
    warm_min_ms: warmDurations[0],
    warm_max_ms: warmDurations.at(-1),
    first_reproduction_hash: first.reproductionHash,
  },
  artifact_storage: {
    files,
    total_bytes: files.reduce((total, item) => total + item.bytes, 0),
  },
  interpretation_boundary:
    "This is a local implementation characterization, not a production throughput or end-to-end network benchmark.",
};
await mkdir(resolve("evaluation/final/results/technical"), { recursive: true });
await writeFile(
  resolve("evaluation/final/results/technical/resource-characterization.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

function quantile(sorted: readonly number[], probability: number): number {
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}
