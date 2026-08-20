import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import dotenv from "dotenv";

import { OpenAIAssistantModel } from "../src/assistant/index.js";
import {
  createFormalModelConditionAdapters,
  type ModelConditionId,
} from "../src/evaluation/conditions.js";
import {
  buildFormalPlan,
  formalCorpus,
  scoreFormalObservation,
  sha256Json,
  type FormalCase,
  type FormalPlanItem,
} from "../src/evaluation/formal.js";
import {
  JsonlObservationStore,
  withBoundedTransportRetries,
  type StoredObservation,
} from "../src/evaluation/live.js";

dotenv.config({ path: resolve(".env/local.env"), quiet: true });
const finalRun = process.argv.includes("--final");

const apiKey = required("OPENAI_API_KEY");
const frozenModel = "gpt-4o-mini-2024-07-18";
if (required("OPENAI_MODEL") !== frozenModel) throw new Error("OPENAI_MODEL differs from freeze");

const concurrency = boundedInteger(process.env.FORMAL_EVALUATION_CONCURRENCY ?? "5", 1, 10);
const outputDirectory = resolve(
  finalRun ? "evaluation/final/results/primary" : "evaluation/formal/results/run-v1",
);
const observationsPath = resolve(outputDirectory, "observations.jsonl");
const manifestPath = resolve(outputDirectory, "evaluation-config-manifest.json");
const summaryPath = resolve(outputDirectory, "progress.json");
const sourceCommit = git("rev-parse", "HEAD");
if (git("status", "--porcelain").length !== 0)
  throw new Error("Formal collection requires a clean source worktree");
assertPublishedSource(sourceCommit);

const [freezeBytes, corpusBytes] = await Promise.all([
  readFile(
    resolve(
      finalRun
        ? "evaluation/final/primary-freeze.json"
        : "evaluation/formal/evaluation-freeze-v1.json",
    ),
  ),
  readFile(
    resolve(
      finalRun ? "evaluation/final/primary-corpus.json" : "evaluation/formal/task-corpus-v1.json",
    ),
  ),
]);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as {
  schema: string;
  formalOutputsCollected: boolean;
  model: { model: string; repetitionsPerStochasticCondition: number; maxOutputTokens: number };
  sampleDesign: { formalModelResponsesPlanned: number };
  taskCorpus: { corpusFileSha256: string };
};
if (
  !["EVLLM_FORMAL_EVALUATION_FREEZE_V1", "EVLLM_FINAL_PRIMARY_EVALUATION_FREEZE_V1"].includes(
    freeze.schema,
  )
)
  throw new Error("Wrong freeze");
if (freeze.formalOutputsCollected) throw new Error("Freeze already marks outputs collected");
if (freeze.model.model !== frozenModel) throw new Error("Frozen model mismatch");

const corpus = formalCorpus.parse(JSON.parse(corpusBytes.toString("utf8")));
const corpusFileSha256 = `0x${createHash("sha256").update(corpusBytes).digest("hex")}`;
if (corpusFileSha256 !== freeze.taskCorpus.corpusFileSha256)
  throw new Error("Frozen corpus file digest mismatch");
const plan = buildFormalPlan(corpus);
if (
  plan.filter((item) => item.model_bearing).length !==
  freeze.sampleDesign.formalModelResponsesPlanned
)
  throw new Error("Frozen model plan size mismatch");

const configManifest = {
  schema: "EVLLM_EVALUATION_CONFIG_MANIFEST_V1",
  formal_evidence: true,
  source_commit: sourceCommit,
  source_remote: "https://github.com/amusamih/evllm.git",
  freeze_sha256: `0x${createHash("sha256").update(freezeBytes).digest("hex")}`,
  corpus_file_sha256: corpusFileSha256,
  plan_sha256: sha256Json(plan),
  model: frozenModel,
  temperature: 0,
  store: false,
  max_output_tokens: freeze.model.maxOutputTokens,
  planned_observations: plan.length,
  planned_model_bearing_observations: freeze.sampleDesign.formalModelResponsesPlanned,
  concurrency,
};

await mkdir(outputDirectory, { recursive: true });
await establishManifest(manifestPath, configManifest);
const store = new JsonlObservationStore(observationsPath);
await store.initialize();
for (const record of store.values()) {
  if (record.source_commit !== sourceCommit || !record.formal_evidence)
    throw new Error(`Stored observation ${record.observation_id} belongs to another run`);
}

const cases = new Map(corpus.cases.map((item) => [item.case_id, item]));
const model = new OpenAIAssistantModel(apiKey, frozenModel);
const adapters = createFormalModelConditionAdapters();
let appendTail = Promise.resolve();
let completedThisInvocation = 0;
let nextIndex = 0;
const pending = plan.filter((item) => store.get(item.observation_id) === undefined);

const append = async (record: StoredObservation): Promise<void> => {
  const operation = appendTail.then(() => store.append(record));
  appendTail = operation.then(
    () => undefined,
    () => undefined,
  );
  await operation;
  completedThisInvocation += 1;
  if (completedThisInvocation % 25 === 0 || store.values().length === plan.length) {
    await writeProgress();
    process.stdout.write(
      `formal progress ${String(store.values().length)}/${String(plan.length)} observations\n`,
    );
  }
};

const worker = async (): Promise<void> => {
  while (true) {
    const index = nextIndex;
    nextIndex += 1;
    const planItem = pending[index];
    if (planItem === undefined) return;
    const item = cases.get(planItem.case_id);
    if (item === undefined) throw new Error(`Missing case ${planItem.case_id}`);
    await append(await collect(planItem, item));
  }
};

await writeProgress();
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
await appendTail;
await writeProgress();
process.stdout.write(
  `${JSON.stringify({ completed: store.values().length, planned: plan.length, resumed: plan.length - pending.length }, null, 2)}\n`,
);

async function collect(planItem: FormalPlanItem, item: FormalCase): Promise<StoredObservation> {
  const startedAt = new Date();
  const before = Date.now();
  if (!planItem.model_bearing) {
    const candidate = deterministicCandidate(item);
    return observation(
      planItem,
      item,
      startedAt,
      before,
      1,
      "evllm",
      "deterministic-formal-baseline-v1",
      null,
      null,
      null,
      candidate.outcome,
      candidate.summary,
      candidate.warnings,
      candidate.missingRequirements,
      candidate.evidenceReasonCodes,
      candidate.validationCodes,
      candidate.claims,
    );
  }
  const adapter = adapters.get(planItem.configuration_id as ModelConditionId);
  if (adapter === undefined) throw new Error(`Missing adapter ${planItem.configuration_id}`);
  const execution = await withBoundedTransportRetries(() =>
    adapter.execute(item, {
      model,
      purposeId: urn("policy", 1),
      asOf: 200,
      session: {
        sessionId: urn("session", planItem.repetition),
        actorId: urn("actor", 1),
        organizationId: urn("org", 1),
        credentialId: urn("credential", 1),
        address: "0x1111111111111111111111111111111111111111",
        issuedAt: 100,
        expiresAt: 300,
      },
    }),
  );
  const result = execution.value.result;
  return observation(
    planItem,
    item,
    startedAt,
    before,
    execution.attempts,
    result.provider,
    result.model,
    result.responseId,
    result.inputTokens,
    result.outputTokens,
    result.candidate.outcome,
    result.candidate.summary,
    [...result.candidate.warnings],
    [...result.candidate.missing_requirements],
    [...result.candidate.evidence_reason_codes],
    [...execution.value.validation_codes],
    result.candidate.claims.map((claim) => ({
      text: claim.text,
      citation_ids: [...claim.citation_ids],
    })),
  );
}

function observation(
  planItem: FormalPlanItem,
  item: FormalCase,
  startedAt: Date,
  before: number,
  attempts: number,
  provider: string,
  modelName: string,
  responseId: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  outcome: StoredObservation["outcome"],
  summary: string,
  warnings: string[],
  missingRequirements: string[],
  evidenceReasonCodes: string[],
  validationCodes: string[],
  claims: StoredObservation["claims"],
): StoredObservation {
  const score = scoreFormalObservation(item, {
    outcome,
    validation_codes: validationCodes,
    claims,
    disclosed_text: JSON.stringify({
      outcome,
      summary,
      warnings,
      missingRequirements,
      evidenceReasonCodes,
      claims,
    }),
  });
  return {
    schema: "EVLLM_LIVE_EVALUATION_OBSERVATION_V1",
    observation_id: planItem.observation_id,
    formal_evidence: true,
    source_commit: sourceCommit,
    case_id: planItem.case_id,
    configuration_id: planItem.configuration_id,
    repetition: planItem.repetition,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - before,
    attempts,
    provider,
    model: modelName,
    response_id: responseId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    outcome,
    summary,
    warnings,
    missing_requirements: missingRequirements,
    evidence_reason_codes: evidenceReasonCodes,
    validation_codes: validationCodes,
    claims,
    score,
  };
}

function deterministicCandidate(item: FormalCase): {
  outcome: StoredObservation["outcome"];
  summary: string;
  warnings: string[];
  missingRequirements: string[];
  evidenceReasonCodes: string[];
  validationCodes: string[];
  claims: StoredObservation["claims"];
} {
  return {
    outcome: item.expected_outcome,
    summary: `Deterministic ${item.expected_outcome} for ${item.case_id}.`,
    warnings: [],
    missingRequirements: [],
    evidenceReasonCodes:
      item.expected_validation_code === "missing-support"
        ? ["missing-evidence"]
        : item.expected_validation_code === "conflicting-support"
          ? ["conflicting-evidence"]
          : item.expected_validation_code === "inactive-support"
            ? ["inactive-evidence"]
            : [],
    validationCodes: item.expected_validation_code === null ? [] : [item.expected_validation_code],
    claims: item.expected_support_ids.map((supportId) => ({
      text: item.supports.find((support) => support.support_id === supportId)?.content ?? "",
      citation_ids: [supportId],
    })),
  };
}

async function writeProgress(): Promise<void> {
  const values = store.values();
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        schema: "EVLLM_FORMAL_EVALUATION_PROGRESS_V1",
        source_commit: sourceCommit,
        updated_at: new Date().toISOString(),
        completed_observations: values.length,
        planned_observations: plan.length,
        model_responses: values.filter((value) => value.provider === "openai").length,
        input_tokens: sum(values.map((value) => value.input_tokens)),
        output_tokens: sum(values.map((value) => value.output_tokens)),
        complete: values.length === plan.length,
      },
      null,
      2,
    )}\n`,
  );
}

async function establishManifest(path: string, expected: unknown): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (JSON.stringify(existing) !== JSON.stringify(expected))
      throw new Error("Existing formal run manifest differs from this source/configuration");
  } catch (error) {
    if (!isMissing(error)) throw error;
    await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
  }
}

function assertPublishedSource(commit: string): void {
  const remote = git("ls-remote", "origin", "refs/heads/main").split(/\s+/u)[0];
  if (remote !== commit)
    throw new Error("HEAD must equal the published origin/main formal snapshot");
}

function git(...arguments_: string[]): string {
  return execFileSync("git", arguments_, { encoding: "utf8" }).trim();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0 || value.includes("replace_with"))
    throw new Error(`${name} is missing`);
  return value;
}

function boundedInteger(value: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`Concurrency must be an integer from ${String(minimum)} to ${String(maximum)}`);
  return parsed;
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
