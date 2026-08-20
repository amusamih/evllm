import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildFormalPlan,
  formalCorpus,
  scoreFormalObservation,
  sha256Json,
} from "../src/evaluation/formal.js";

const arguments_ = process.argv.slice(2);
const finalRun = arguments_.includes("--final");
const freezePath = resolve(
  finalRun ? "evaluation/final/primary-freeze.json" : "evaluation/formal/evaluation-freeze-v1.json",
);
const corpusPath = resolve(
  finalRun ? "evaluation/final/primary-corpus.json" : "evaluation/formal/task-corpus-v1.json",
);
const strictPreflight = arguments_.includes("--preflight");
if (arguments_.some((argument) => !["--dry-run", "--preflight", "--final"].includes(argument))) {
  throw new Error("Usage: npm run evaluation:formal:dry-run or evaluation:formal:preflight");
}

const [freezeBytes, corpusBytes] = await Promise.all([readFile(freezePath), readFile(corpusPath)]);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as {
  schema: string;
  formalOutputsCollected: boolean;
  model: { model: string; repetitionsPerStochasticCondition: number };
  sampleDesign: { formalModelResponsesPlanned: number };
  taskCorpus: {
    caseCount: number;
    logicalCorpusSha256: string;
    corpusFileSha256: string;
  };
};
const corpus = formalCorpus.parse(JSON.parse(corpusBytes.toString("utf8")));
const { corpus_sha256: recordedCorpusHash, ...unsignedCorpus } = corpus;
const logicalCorpusHash = sha256Json(unsignedCorpus);
const corpusFileHash = `0x${createHash("sha256").update(corpusBytes).digest("hex")}`;

assert(
  ["EVLLM_FORMAL_EVALUATION_FREEZE_V1", "EVLLM_FINAL_PRIMARY_EVALUATION_FREEZE_V1"].includes(
    freeze.schema,
  ),
  "Wrong freeze schema",
);
assert(!freeze.formalOutputsCollected, "Freeze says formal outputs were already collected");
assert(corpus.case_count === freeze.taskCorpus.caseCount, "Frozen case count mismatch");
assert(recordedCorpusHash === logicalCorpusHash, "Corpus logical digest mismatch");
assert(
  freeze.taskCorpus.logicalCorpusSha256 === logicalCorpusHash,
  "Freeze logical digest mismatch",
);
assert(freeze.taskCorpus.corpusFileSha256 === corpusFileHash, "Freeze file digest mismatch");
assert(freeze.model.model === "gpt-4o-mini-2024-07-18", "Frozen model snapshot mismatch");
assert(freeze.model.repetitionsPerStochasticCondition === 5, "Frozen repetitions mismatch");

const plan = buildFormalPlan(corpus);
const modelPlan = plan.filter((item) => item.model_bearing);
const deterministicPlan = plan.filter((item) => !item.model_bearing);
assert(
  modelPlan.length === freeze.sampleDesign.formalModelResponsesPlanned,
  "Frozen model-response count mismatch",
);
assert(plan.length === 4_128, "Formal observation count must be 4,128");

for (const item of corpus.cases) {
  const perfect = scoreFormalObservation(item, {
    outcome: item.expected_outcome,
    validation_codes: item.expected_validation_code === null ? [] : [item.expected_validation_code],
    claims: item.expected_support_ids.map((supportId) => ({
      text: item.supports.find((support) => support.support_id === supportId)?.content ?? "",
      citation_ids: [supportId],
    })),
  });
  assert(perfect.task_success === 1, `Scorer rejected perfect fixture for ${item.case_id}`);
}

const sourceCommit = git("rev-parse", "HEAD");
const sourceStatus = git("status", "--porcelain");
if (strictPreflight)
  assert(sourceStatus.length === 0, "Formal preflight requires a clean worktree");

const report = {
  schema: "EVLLM_FORMAL_EVALUATION_DRY_RUN_V1",
  mode: strictPreflight ? "preflight" : "development-dry-run",
  formal_outputs_collected: false,
  source_commit: sourceCommit,
  source_clean: sourceStatus.length === 0,
  frozen_model: freeze.model.model,
  cases: corpus.case_count,
  configurations: 11,
  deterministic_observations: deterministicPlan.length,
  model_observations: modelPlan.length,
  total_observations: plan.length,
  logical_corpus_sha256: logicalCorpusHash,
  corpus_file_sha256: corpusFileHash,
  plan_sha256: sha256Json(plan),
  scorer_fixture_checks: corpus.case_count,
  paid_requests_made: 0,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function git(...arguments_: string[]): string {
  return execFileSync("git", arguments_, { encoding: "utf8" }).trim();
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
