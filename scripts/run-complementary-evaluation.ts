import { randomUUID } from "node:crypto";
import { open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import dotenv from "dotenv";

import {
  AssistantAuditLedger,
  AssistantRequestStore,
  AssistantToolRegistry,
  assertOpenAIAssistantConfig,
  effectiveOpenAIAssistantConfig,
  GovernedAssistantService,
  OpenAIAssistantModel,
  TypedQueryTool,
  type ActorSession,
  type ModelResult,
} from "../src/assistant/index.js";
import {
  parseAndVerifyComplementaryCorpus,
  supportsForSynthesisCase,
  validateComplementaryRawGeneration,
  type ComplementaryEvaluationCase,
} from "../src/evaluation/complementary.js";
import { assertComplementaryRawDiagnosticFreeze } from "../src/evaluation/complementary-metrics.js";
import { sha256Bytes, sha256Json } from "../src/evaluation/final-freeze.js";
import { assertSynthesisFreezeProtocol } from "../src/evaluation/final-freeze-validation.js";
import { assertObservationEvaluationBinding } from "../src/evaluation/final-integrity.js";
import {
  complementarySynthesisObservationSchema,
  prepareEvaluationRunDirectory,
  sha256CanonicalJson,
  withBoundedTransportRetries,
  type ComplementaryCandidateSnapshot,
  type ComplementarySynthesisStoredObservation,
} from "../src/evaluation/live.js";
import {
  JournaledAssistantModel,
  TransportAttemptJournal,
} from "../src/evaluation/transport-attempt-journal.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";

type Observation = ComplementarySynthesisStoredObservation;

dotenv.config({ path: resolve(".env/local.env"), quiet: true });
const allowedArguments = new Set(["--final", "--resume"]);
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => !allowedArguments.has(argument));
if (unexpectedArguments.length > 0)
  throw new Error(`Unknown complementary collection arguments: ${unexpectedArguments.join(", ")}`);
const finalRun = process.argv.includes("--final");
const resumeRun = process.argv.includes("--resume");
if (resumeRun && !finalRun) throw new Error("--resume is reserved for a source-bound final run");
const { sourceCommit } = assertCommittedEvaluationSource(
  finalRun
    ? ["evaluation/final/results/primary", "evaluation/final/results/synthesis"]
    : ["evaluation/complementary/results/run-v2"],
  finalRun ? { publicRemoteTrackingRef: "origin/main" } : {},
);

const freezeBytes = await readFile(
  resolve(
    finalRun
      ? "evaluation/final/synthesis-freeze.json"
      : "evaluation/complementary/synthesis-freeze-v2.json",
  ),
);
const corpusBytes = await readFile(
  resolve(
    finalRun
      ? "evaluation/final/synthesis-corpus.json"
      : "evaluation/complementary/synthesis-corpus-v2.json",
  ),
);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as Freeze;
const storedCorpus = JSON.parse(corpusBytes.toString("utf8")) as unknown;
const { corpus, logicalCorpusSha256 } = parseAndVerifyComplementaryCorpus(storedCorpus);
if (
  freeze.schema !==
  (finalRun
    ? "EVLLM_FINAL_SYNTHESIS_EVALUATION_FREEZE_V2"
    : "EVLLM_COMPLEMENTARY_SYNTHESIS_FREEZE_V2")
)
  throw new Error("Wrong complementary freeze schema");
if (freeze.outputsCollected)
  throw new Error("Complementary freeze already marks outputs collected");
if (freeze.model.provider !== "openai") throw new Error("Frozen model provider mismatch");
if (freeze.model.api !== "responses") throw new Error("Frozen model API mismatch");
assertComplementaryRawDiagnosticFreeze(freeze);
assertSynthesisFreezeProtocol(freeze);
if (sha256Bytes(corpusBytes) !== freeze.corpus.corpusFileSha256)
  throw new Error("Complementary corpus file digest mismatch");
if (freeze.corpus.logicalCorpusSha256 !== logicalCorpusSha256)
  throw new Error("Complementary corpus logical digest mismatch");
if (corpus.cases.length !== freeze.corpus.caseCount) throw new Error("Corpus case count mismatch");
const evaluationSetId =
  freeze.evaluation_set_id ?? `development-synthesis-${logicalCorpusSha256.slice(2, 18)}`;
if (finalRun && freeze.evaluation_set_id === undefined)
  throw new Error("Final synthesis freeze lacks an evaluation set ID");
if (finalRun) {
  const primaryFreeze = JSON.parse(
    await readFile(resolve("evaluation/final/primary-freeze.json"), "utf8"),
  ) as { evaluation_set_id?: string };
  if (primaryFreeze.evaluation_set_id !== evaluationSetId)
    throw new Error("Primary and synthesis freezes use different evaluation set IDs");
}
const apiKey = required("OPENAI_API_KEY");
const runtimeConfig = effectiveOpenAIAssistantConfig(required("OPENAI_MODEL"));
assertOpenAIAssistantConfig(freeze.model, runtimeConfig, "Complementary evaluation freeze");

const outputDirectory = resolve(
  finalRun ? "evaluation/final/results/synthesis" : "evaluation/complementary/results/run-v2",
);
const observationPath = resolve(outputDirectory, "observations.jsonl");
const progressPath = resolve(outputDirectory, "progress.json");
const manifestPath = resolve(outputDirectory, "evaluation-config-manifest.json");
const runSummaryPath = resolve(outputDirectory, "run-summary.json");
const transportJournalPath = resolve(outputDirectory, "transport-attempts.jsonl");
const plan = corpus.cases.flatMap((item) =>
  Array.from({ length: freeze.model.repetitionsPerCase }, (_, index) => ({
    observation_id: `${item.case_id}:governed-evllm-synthesis:${String(index + 1)}`,
    case: item,
    repetition: index + 1,
  })),
);
if (plan.length !== freeze.model.plannedMaximumModelResponses)
  throw new Error("Complementary plan count mismatch");

const manifest = {
  schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_CONFIG_MANIFEST_V2",
  evaluation_set_id: evaluationSetId,
  source_commit: sourceCommit,
  source_remote: "https://github.com/amusamih/evllm.git",
  freeze_sha256: sha256Bytes(freezeBytes),
  corpus_file_sha256: sha256Bytes(corpusBytes),
  logical_corpus_sha256: logicalCorpusSha256,
  execution_pipeline: "GovernedAssistantService",
  support_access: "authorized TypedQueryTool request",
  output_validation: "production assistant candidate validator",
  deterministic_decision_binding:
    "typed recorded decision metadata applied before release; raw model candidate retained separately",
  model: runtimeConfig.model,
  temperature: runtimeConfig.temperature,
  max_output_tokens: runtimeConfig.maxOutputTokens,
  provider_internal_retries: runtimeConfig.providerMaxRetries,
  store: runtimeConfig.store,
  planned_observations: plan.length,
  planned_model_bearing_observations: plan.length,
  planned_model_invocations: plan.length,
  planned_transport_attempts_minimum: plan.length,
  planned_transport_attempts_maximum: plan.length * (freeze.model.transportRetries + 1),
  maximum_transport_retries_per_invocation: freeze.model.transportRetries,
  conditions: freeze.conditions,
  primary_metrics: freeze.primaryMetrics,
  plan_sha256: sha256Json(
    plan.map(({ observation_id: observationId, case: item, repetition }) => ({
      observation_id: observationId,
      case_id: item.case_id,
      repetition,
    })),
  ),
  transport_attempt_journal: "transport-attempts.jsonl",
};
await prepareEvaluationRunDirectory({
  directory: outputDirectory,
  manifestPath,
  expectedManifest: manifest,
  finalRun,
  resume: resumeRun,
  allowedResumeEntries: [
    "evaluation-config-manifest.json",
    "observations.jsonl",
    "progress.json",
    "run-summary.json",
    "transport-attempts.jsonl",
  ],
});
const records = await loadRecords(observationPath);
for (const record of records.values()) {
  assertObservationEvaluationBinding(record.observation_id, record, manifest);
}
const transportJournal = new TransportAttemptJournal(transportJournalPath, {
  evaluation_set_id: evaluationSetId,
  source_commit: sourceCommit,
  freeze_sha256: manifest.freeze_sha256,
  corpus_file_sha256: manifest.corpus_file_sha256,
  logical_corpus_sha256: logicalCorpusSha256,
});
await transportJournal.initialize();
const interruptedAttempts = await transportJournal.markOpenAttemptsInterrupted();
if (interruptedAttempts > 0)
  throw new Error(
    `Final-safe collection stopped because ${String(interruptedAttempts)} provider attempt(s) ended without a terminal journal event`,
  );
transportJournal.assertReconciled([...records.values()]);

const model = new OpenAIAssistantModel(apiKey, runtimeConfig.model);
assertOpenAIAssistantConfig(
  model.effectiveConfig,
  runtimeConfig,
  "Complementary evaluation model instance",
);
const pending = plan.filter((item) => !records.has(item.observation_id));
for (const item of pending) {
  if (transportJournal.attemptsFor(item.observation_id) > 0)
    transportJournal.assertCanResumeObservation(
      item.observation_id,
      freeze.model.transportRetries + 1,
    );
}
let nextIndex = 0;
let appendTail = Promise.resolve();
const concurrency = 5;

const worker = async (): Promise<void> => {
  while (true) {
    const index = nextIndex++;
    const item = pending[index];
    if (item === undefined) return;
    const record = await collect(item.observation_id, item.case, item.repetition);
    const operation = appendTail.then(() => appendRecord(record));
    appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }
};

await writeProgress();
await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
await appendTail;
await writeProgress();
process.stdout.write(
  `${JSON.stringify({ completed: records.size, planned: plan.length, resumed: plan.length - pending.length }, null, 2)}\n`,
);

async function collect(
  observationId: string,
  item: SynthesisCase,
  repetition: number,
): Promise<Observation> {
  const started = new Date();
  const before = Date.now();
  const session = synthesisSession(repetition);
  const supports = supportsForSynthesisCase(item);
  const capturingModel = new JournaledAssistantModel(model, transportJournal, {
    observation_id: observationId,
    case_id: item.case_id,
    configuration_id: "governed-evllm-synthesis",
    repetition,
    provider: "openai",
    model: runtimeConfig.model,
  });
  const tools = new AssistantToolRegistry(
    [
      new TypedQueryTool("facts", (context) => {
        if (context.arguments.case_id !== item.case_id) return Promise.resolve([]);
        return Promise.resolve(supports);
      }),
    ],
    (requestingSession, purposeId, tool, arguments_) =>
      Promise.resolve(
        requestingSession.actorId === session.actorId &&
          requestingSession.organizationId === session.organizationId &&
          requestingSession.credentialId === session.credentialId &&
          requestingSession.issuedAt <= 200 &&
          requestingSession.expiresAt >= 200 &&
          purposeId === urn("policy", 2) &&
          tool === "facts" &&
          arguments_.case_id === item.case_id,
      ),
  );
  const service = new GovernedAssistantService(
    tools,
    capturingModel,
    new AssistantAuditLedger(),
    new AssistantRequestStore(),
    () => 200,
  );
  const remainingAttempts = transportJournal.remainingAttemptBudget(
    observationId,
    freeze.model.transportRetries + 1,
  );
  if (remainingAttempts < 1)
    throw new Error(`No transport-attempt budget remains for ${observationId}`);
  const execution = await withBoundedTransportRetries(
    () =>
      service.answer(
        {
          question: item.prompt,
          mode: "explain_recorded_decision",
          purpose_id: urn("policy", 2),
          as_of: 200,
          requests: [{ tool: "facts", arguments: { case_id: item.case_id } }],
        },
        session,
        randomUUID(),
      ),
    undefined,
    remainingAttempts,
  );
  const response = execution.value;
  const invocation = capturingModel.lastResult;
  const modelInput = capturingModel.lastInput;
  if ((invocation === null) !== (modelInput === null)) {
    throw new Error(`Model invocation provenance is incomplete for ${observationId}`);
  }
  const releasedCandidate: ComplementaryCandidateSnapshot = {
    outcome: response.outcome,
    decision_code: response.decision_code,
    summary: response.summary,
    warnings: [...response.warnings],
    missing_requirements: [...response.missing_requirements],
    evidence_reason_codes: [...response.evidence_reason_codes],
    claims: response.claims.map((claim) => ({
      claim_id: claim.claim_id,
      text: claim.text,
      citation_ids: [...claim.citation_ids],
    })),
  };
  return complementarySynthesisObservationSchema.parse({
    schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_OBSERVATION_V2",
    observation_id: observationId,
    evaluation_set_id: evaluationSetId,
    source_commit: sourceCommit,
    freeze_sha256: manifest.freeze_sha256,
    corpus_file_sha256: manifest.corpus_file_sha256,
    logical_corpus_sha256: logicalCorpusSha256,
    case_id: item.case_id,
    stratum: item.stratum,
    repetition,
    started_at: started.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - before,
    attempts: execution.attempts,
    transport_attempts: invocation === null ? 0 : transportJournal.attemptsFor(observationId),
    model_invoked: invocation !== null,
    provider: invocation?.provider ?? response.model.provider,
    model: invocation?.model ?? response.model.model,
    response_id: invocation?.responseId ?? response.model.response_id,
    input_tokens: invocation?.inputTokens ?? response.model.input_tokens,
    output_tokens: invocation?.outputTokens ?? response.model.output_tokens,
    raw_model_candidate: invocation === null ? null : snapshotCandidate(invocation.candidate),
    released_candidate: releasedCandidate,
    raw_validation_codes:
      invocation === null ? [] : validateComplementaryRawGeneration(invocation.candidate, item),
    presented_support_ids: modelInput?.supports.map(({ support_id: supportId }) => supportId) ?? [],
    model_input_sha256: modelInput === null ? null : sha256CanonicalJson(modelInput),
    outcome: response.outcome,
    decision_code: response.decision_code,
    summary: response.summary,
    warnings: [...response.warnings],
    missing_requirements: [...response.missing_requirements],
    evidence_reason_codes: [...response.evidence_reason_codes],
    validation_status: response.validation.status,
    validation_codes: [...response.validation.codes],
    claims: response.claims.map((claim) => ({
      claim_id: claim.claim_id,
      text: claim.text,
      citation_ids: [...claim.citation_ids],
    })),
  });
}

async function appendRecord(record: Observation): Promise<void> {
  if (records.has(record.observation_id)) throw new Error("Duplicate observation");
  const handle = await open(observationPath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  records.set(record.observation_id, record);
  if (records.size % 25 === 0 || records.size === plan.length) {
    await writeProgress();
    process.stdout.write(`complementary progress ${String(records.size)}/${String(plan.length)}\n`);
  }
}

async function writeProgress(): Promise<void> {
  const values = [...records.values()];
  const complete = records.size === plan.length;
  transportJournal.assertReconciled(values, { allow_unobserved_attempts: !complete });
  const transport = transportJournal.summary();
  const summary = {
    schema: finalRun
      ? "EVLLM_FINAL_SYNTHESIS_RUN_SUMMARY_V2"
      : "EVLLM_COMPLEMENTARY_SYNTHESIS_RUN_SUMMARY_V2",
    evaluation_set_id: evaluationSetId,
    source_commit: sourceCommit,
    freeze_sha256: manifest.freeze_sha256,
    corpus_file_sha256: manifest.corpus_file_sha256,
    logical_corpus_sha256: logicalCorpusSha256,
    completed_observations: records.size,
    planned_observations: plan.length,
    planned_model_bearing_observations: plan.length,
    planned_model_invocations: plan.length,
    completed_model_bearing_observations: records.size,
    successful_model_invocations: transport.successful_invocations,
    model_transport_attempts: transport.transport_attempts,
    model_transport_retries: transport.retry_attempts,
    failed_model_transport_attempts: transport.failed_attempts,
    interrupted_model_transport_attempts: transport.interrupted_attempts,
    open_model_transport_attempts: transport.open_attempts,
    input_tokens: transport.input_tokens,
    output_tokens: transport.output_tokens,
    transport_attempt_journal_sha256: await transportJournal.fileSha256(),
    complete,
  };
  if (
    complete &&
    (summary.successful_model_invocations !== plan.length ||
      summary.model_transport_attempts < plan.length ||
      summary.model_transport_attempts > plan.length * (freeze.model.transportRetries + 1))
  ) {
    throw new Error("Completed synthesis run does not reconcile with its invocation plan");
  }
  await writeFile(
    progressPath,
    `${JSON.stringify(
      {
        ...summary,
        schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_PROGRESS_V2",
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  if (complete) await writeFile(runSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}

async function loadRecords(path: string): Promise<Map<string, Observation>> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const output = new Map<string, Observation>();
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim().length === 0) continue;
    let record: Observation;
    try {
      record = complementarySynthesisObservationSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid complementary observation JSONL at line ${String(index + 1)}`, {
        cause: error,
      });
    }
    if (output.has(record.observation_id)) throw new Error("Duplicate stored observation");
    output.set(record.observation_id, record);
  }
  return output;
}

interface Freeze {
  schema: string;
  evaluation_set_id?: string;
  outputsCollected: boolean;
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
    store: boolean;
    repetitionsPerCase: number;
    plannedMaximumModelResponses: number;
    transportRetries: number;
  };
}
type SynthesisCase = ComplementaryEvaluationCase;
function snapshotCandidate(candidate: ModelResult["candidate"]): ComplementaryCandidateSnapshot {
  return {
    outcome: candidate.outcome,
    decision_code: candidate.decision_code,
    summary: candidate.summary,
    warnings: [...candidate.warnings],
    missing_requirements: [...candidate.missing_requirements],
    evidence_reason_codes: [...candidate.evidence_reason_codes],
    claims: candidate.claims.map((claim) => ({
      claim_id: claim.claim_id,
      text: claim.text,
      citation_ids: [...claim.citation_ids],
    })),
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0 || value.includes("replace_with"))
    throw new Error(`${name} missing`);
  return value;
}
function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
function synthesisSession(repetition: number): ActorSession {
  return {
    sessionId: urn("session", repetition),
    actorId: urn("actor", 1),
    organizationId: urn("org", 1),
    credentialId: urn("credential", 1),
    address: "0x1111111111111111111111111111111111111111",
    issuedAt: 100,
    expiresAt: 300,
  };
}
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
