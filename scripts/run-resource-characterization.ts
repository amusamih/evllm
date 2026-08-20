import { performance } from "node:perf_hooks";
import { cpus, platform, release } from "node:os";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { evaluateNominalSustainability } from "./lib/sustainability-evidence.js";

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
  measuredFiles.map(async (path) => ({ path, bytes: (await stat(resolve(path))).size })),
);
const output = {
  schema: "EVLLM_RESOURCE_CHARACTERIZATION_V1",
  measured_at: new Date().toISOString(),
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
