import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import dotenv from "dotenv";

import {
  assertOpenAIAssistantConfig,
  effectiveOpenAIAssistantConfig,
  OpenAIAssistantModel,
  validateAssistantCandidate,
  validateAssistantExplanationCandidate,
  type AssistantCandidate,
} from "../src/assistant/index.js";
import {
  createFormalModelConditionAdapters,
  deriveGovernedFormalReference,
} from "../src/evaluation/conditions.js";
import {
  buildFormalPlan,
  formalCorpus,
  scoreFormalObservation,
  sha256Json,
  type FormalCase,
  type FormalPlanItem,
} from "../src/evaluation/formal.js";
import { assertObservationEvaluationBinding } from "../src/evaluation/final-integrity.js";
import { assertPrimaryFreezeProtocol } from "../src/evaluation/final-freeze-validation.js";
import {
  JsonlObservationStore,
  prepareEvaluationRunDirectory,
  sha256CanonicalJson,
  withBoundedTransportRetries,
  type CandidateSnapshot,
  type StoredObservation,
} from "../src/evaluation/live.js";
import {
  JournaledAssistantModel,
  TransportAttemptJournal,
} from "../src/evaluation/transport-attempt-journal.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";

dotenv.config({ path: resolve(".env/local.env"), quiet: true });
const allowedArguments = new Set(["--final", "--resume"]);
const unexpectedArguments = process.argv
  .slice(2)
  .filter((argument) => !allowedArguments.has(argument));
if (unexpectedArguments.length > 0)
  throw new Error(`Unknown formal collection arguments: ${unexpectedArguments.join(", ")}`);
const finalRun = process.argv.includes("--final");
const resumeRun = process.argv.includes("--resume");
if (resumeRun && !finalRun) throw new Error("--resume is reserved for a source-bound final run");

const apiKey = required("OPENAI_API_KEY");
const runtimeConfig = effectiveOpenAIAssistantConfig(required("OPENAI_MODEL"));

const concurrency = boundedInteger(process.env.FORMAL_EVALUATION_CONCURRENCY ?? "5", 1, 10);
const outputDirectory = resolve(
  finalRun ? "evaluation/final/results/primary" : "evaluation/formal/results/run-v2",
);
const observationsPath = resolve(outputDirectory, "observations.jsonl");
const manifestPath = resolve(outputDirectory, "evaluation-config-manifest.json");
const summaryPath = resolve(outputDirectory, "progress.json");
const runSummaryPath = resolve(outputDirectory, "run-summary.json");
const transportJournalPath = resolve(outputDirectory, "transport-attempts.jsonl");
const { sourceCommit } = assertCommittedEvaluationSource(
  finalRun
    ? ["evaluation/final/results/primary", "evaluation/final/results/synthesis"]
    : ["evaluation/formal/results/run-v2"],
  finalRun ? { publicRemoteTrackingRef: "origin/main" } : {},
);

const [freezeBytes, corpusBytes] = await Promise.all([
  readFile(
    resolve(
      finalRun
        ? "evaluation/final/primary-freeze.json"
        : "evaluation/formal/evaluation-freeze-v2.json",
    ),
  ),
  readFile(
    resolve(
      finalRun ? "evaluation/final/primary-corpus.json" : "evaluation/formal/task-corpus-v2.json",
    ),
  ),
]);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as {
  schema: string;
  evaluation_set_id?: string;
  formalOutputsCollected: boolean;
  model: {
    provider: string;
    api: string;
    model: string;
    temperature: number;
    maxOutputTokens: number;
    store: boolean;
    repetitionsPerStochasticCondition: number;
    maximumTransportRetriesPerInvocation: number;
  };
  conditions: unknown;
  primaryOutcomes: unknown;
  taskSuccessReasonSemantics: unknown;
  analysis: {
    pairedContrastOutcomes: unknown;
    descriptiveOutcomes: unknown;
  };
  sampleDesign: {
    plannedModelBearingObservations: number;
    plannedModelInvocations: number;
    plannedModelInvocationsByCondition: Record<string, number>;
    plannedTransportAttemptsMinimum: number;
    plannedTransportAttemptsMaximum: number;
    totalObservationsPlanned: number;
  };
  taskCorpus: { corpusFileSha256: string; logicalCorpusSha256: string };
};
const allowedSchemas = finalRun
  ? ["EVLLM_FINAL_PRIMARY_EVALUATION_FREEZE_V2"]
  : ["EVLLM_FORMAL_EVALUATION_FREEZE_V2"];
if (!allowedSchemas.includes(freeze.schema)) throw new Error("Wrong freeze");
if (freeze.formalOutputsCollected) throw new Error("Freeze already marks outputs collected");
if (freeze.model.provider !== "openai") throw new Error("Frozen model provider mismatch");
if (freeze.model.api !== "responses") throw new Error("Frozen model API mismatch");
assertOpenAIAssistantConfig(freeze.model, runtimeConfig, "Formal evaluation freeze");
assertPrimaryFreezeProtocol(freeze);
const evaluationSetId =
  freeze.evaluation_set_id ??
  `development-primary-${freeze.taskCorpus.logicalCorpusSha256.slice(2, 18)}`;
if (finalRun && freeze.evaluation_set_id === undefined)
  throw new Error("Final primary freeze lacks an evaluation set ID");
if (finalRun) {
  const synthesisFreeze = JSON.parse(
    await readFile(resolve("evaluation/final/synthesis-freeze.json"), "utf8"),
  ) as { evaluation_set_id?: string };
  if (synthesisFreeze.evaluation_set_id !== evaluationSetId)
    throw new Error("Primary and synthesis freezes use different evaluation set IDs");
}

const corpus = formalCorpus.parse(JSON.parse(corpusBytes.toString("utf8")));
const corpusFileSha256 = `0x${createHash("sha256").update(corpusBytes).digest("hex")}`;
if (corpusFileSha256 !== freeze.taskCorpus.corpusFileSha256)
  throw new Error("Frozen corpus file digest mismatch");
const { corpus_sha256: recordedLogicalSha256, ...unsignedCorpus } = corpus;
const logicalCorpusSha256 = sha256Json(unsignedCorpus);
if (
  recordedLogicalSha256 !== logicalCorpusSha256 ||
  freeze.taskCorpus.logicalCorpusSha256 !== logicalCorpusSha256
)
  throw new Error("Frozen corpus logical digest mismatch");
const plan = buildFormalPlan(corpus);
const planByObservationId = new Map(plan.map((item) => [item.observation_id, item]));
const cases = new Map(corpus.cases.map((item) => [item.case_id, item]));
const adapters = createFormalModelConditionAdapters();
const plannedModelInvocationsByCondition = new Map<string, number>();
for (const planItem of plan) {
  const item = cases.get(planItem.case_id);
  const adapter = adapters.get(planItem.configuration_id);
  if (item === undefined || adapter === undefined)
    throw new Error("Formal plan cannot be resolved");
  if (
    adapter.willInvokeModel(item, {
      purposeId: item.access_request.purpose_id,
      session: {
        sessionId: urn("session", planItem.repetition),
        actorId: urn("actor", 1),
        organizationId: item.access_request.organization_id,
        credentialId: urn("credential", 1),
        address: "0x1111111111111111111111111111111111111111",
        issuedAt: 100,
        expiresAt: 300,
      },
    })
  ) {
    plannedModelInvocationsByCondition.set(
      planItem.configuration_id,
      (plannedModelInvocationsByCondition.get(planItem.configuration_id) ?? 0) + 1,
    );
  }
}
const plannedModelInvocations = [...plannedModelInvocationsByCondition.values()].reduce(
  (total, value) => total + value,
  0,
);
if (
  plan.filter((item) => item.model_bearing).length !==
    freeze.sampleDesign.plannedModelBearingObservations ||
  plan.length !== freeze.sampleDesign.totalObservationsPlanned ||
  plannedModelInvocations !== freeze.sampleDesign.plannedModelInvocations ||
  JSON.stringify(Object.fromEntries(plannedModelInvocationsByCondition)) !==
    JSON.stringify(freeze.sampleDesign.plannedModelInvocationsByCondition)
)
  throw new Error("Frozen model-bearing observation or invocation plan mismatch");

const configManifest = {
  schema: "EVLLM_EVALUATION_CONFIG_MANIFEST_V2",
  formal_evidence: true,
  evaluation_set_id: evaluationSetId,
  source_commit: sourceCommit,
  source_remote: "https://github.com/amusamih/evllm.git",
  freeze_sha256: `0x${createHash("sha256").update(freezeBytes).digest("hex")}`,
  corpus_file_sha256: corpusFileSha256,
  logical_corpus_sha256: logicalCorpusSha256,
  plan_sha256: sha256Json(plan),
  model: runtimeConfig.model,
  temperature: runtimeConfig.temperature,
  store: runtimeConfig.store,
  max_output_tokens: runtimeConfig.maxOutputTokens,
  provider_internal_retries: runtimeConfig.providerMaxRetries,
  planned_observations: plan.length,
  planned_model_bearing_observations: freeze.sampleDesign.plannedModelBearingObservations,
  planned_model_invocations: freeze.sampleDesign.plannedModelInvocations,
  planned_transport_attempts_minimum: freeze.sampleDesign.plannedTransportAttemptsMinimum,
  planned_transport_attempts_maximum: freeze.sampleDesign.plannedTransportAttemptsMaximum,
  maximum_transport_retries_per_invocation: freeze.model.maximumTransportRetriesPerInvocation,
  concurrency,
  transport_attempt_journal: "transport-attempts.jsonl",
};

await prepareEvaluationRunDirectory({
  directory: outputDirectory,
  manifestPath,
  expectedManifest: configManifest,
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
const store = new JsonlObservationStore(observationsPath);
await store.initialize();
for (const record of store.values()) {
  if (!record.formal_evidence)
    throw new Error(`Stored observation ${record.observation_id} is not formal evidence`);
  assertObservationEvaluationBinding(record.observation_id, record, configManifest);
}
const transportJournal = new TransportAttemptJournal(transportJournalPath, {
  evaluation_set_id: evaluationSetId,
  source_commit: sourceCommit,
  freeze_sha256: configManifest.freeze_sha256,
  corpus_file_sha256: corpusFileSha256,
  logical_corpus_sha256: logicalCorpusSha256,
});
await transportJournal.initialize();
const interruptedAttempts = await transportJournal.markOpenAttemptsInterrupted();
if (interruptedAttempts > 0)
  throw new Error(
    `Final-safe collection stopped because ${String(interruptedAttempts)} provider attempt(s) ended without a terminal journal event`,
  );
transportJournal.assertReconciled(store.values());

const model = new OpenAIAssistantModel(apiKey, runtimeConfig.model);
assertOpenAIAssistantConfig(
  model.effectiveConfig,
  runtimeConfig,
  "Formal evaluation model instance",
);
let appendTail = Promise.resolve();
let completedThisInvocation = 0;
let nextIndex = 0;
const pending = plan.filter((item) => store.get(item.observation_id) === undefined);
for (const item of pending) {
  if (transportJournal.attemptsFor(item.observation_id) > 0)
    transportJournal.assertCanResumeObservation(
      item.observation_id,
      freeze.model.maximumTransportRetriesPerInvocation + 1,
    );
}

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
      0,
      false,
      "evllm",
      "deterministic-formal-baseline-v1",
      null,
      null,
      null,
      null,
      item.supports.map(({ support_id: supportId }) => supportId),
      null,
      [],
      candidate.outcome,
      candidate.decisionCode,
      candidate.summary,
      candidate.warnings,
      candidate.missingRequirements,
      candidate.evidenceReasonCodes,
      candidate.validationCodes,
      candidate.claims,
    );
  }
  const adapter = adapters.get(planItem.configuration_id);
  if (adapter === undefined) throw new Error(`Missing adapter ${planItem.configuration_id}`);
  const capturingModel = new JournaledAssistantModel(model, transportJournal, {
    observation_id: planItem.observation_id,
    case_id: planItem.case_id,
    configuration_id: planItem.configuration_id,
    repetition: planItem.repetition,
    provider: "openai",
    model: runtimeConfig.model,
  });
  const remainingAttempts = transportJournal.remainingAttemptBudget(
    planItem.observation_id,
    freeze.model.maximumTransportRetriesPerInvocation + 1,
  );
  if (remainingAttempts < 1)
    throw new Error(`No transport-attempt budget remains for ${planItem.observation_id}`);
  const execution = await withBoundedTransportRetries(
    () =>
      adapter.execute(item, {
        model: capturingModel,
        purposeId: item.access_request.purpose_id,
        asOf: 200,
        session: {
          sessionId: urn("session", planItem.repetition),
          actorId: urn("actor", 1),
          organizationId: item.access_request.organization_id,
          credentialId: urn("credential", 1),
          address: "0x1111111111111111111111111111111111111111",
          issuedAt: 100,
          expiresAt: 300,
        },
      }),
    undefined,
    remainingAttempts,
  );
  const result = execution.value.result;
  const invocation = execution.value.model_invocation;
  const modelInput = capturingModel.lastInput;
  if (execution.value.model_invoked !== (invocation !== null && modelInput !== null)) {
    throw new Error(`Model invocation provenance is incomplete for ${planItem.observation_id}`);
  }
  const rawValidationCodes =
    invocation === null || modelInput === null
      ? []
      : validateAssistantExplanationCandidate(invocation.candidate, modelInput.supports);
  const appliedValidationCodes =
    execution.value.validation_candidate === null || modelInput === null
      ? []
      : validateAssistantCandidate(
          execution.value.validation_candidate,
          modelInput.supports,
          modelInput.question,
        );
  if (
    invocation !== null &&
    adapter.controls.output_validation &&
    JSON.stringify(appliedValidationCodes) !== JSON.stringify(execution.value.validation_codes)
  ) {
    throw new Error(
      `Applied validation codes differ from the released execution for ${planItem.observation_id}`,
    );
  }
  return observation(
    planItem,
    item,
    startedAt,
    before,
    execution.attempts,
    execution.value.model_invoked ? transportJournal.attemptsFor(planItem.observation_id) : 0,
    execution.value.model_invoked,
    invocation?.provider ?? result.provider,
    invocation?.model ?? result.model,
    invocation?.responseId ?? result.responseId,
    invocation?.inputTokens ?? result.inputTokens,
    invocation?.outputTokens ?? result.outputTokens,
    invocation === null ? null : snapshotCandidate(invocation.candidate),
    [...execution.value.presented_support_ids],
    modelInput === null ? null : sha256CanonicalJson(modelInput),
    rawValidationCodes,
    result.candidate.outcome,
    result.candidate.decision_code,
    result.candidate.summary,
    [...result.candidate.warnings],
    [...result.candidate.missing_requirements],
    [...result.candidate.evidence_reason_codes],
    [...execution.value.validation_codes],
    result.candidate.claims.map((claim) => ({
      claim_id: claim.claim_id,
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
  transportAttempts: number,
  modelInvoked: boolean,
  provider: string,
  modelName: string,
  responseId: string | null,
  inputTokens: number | null,
  outputTokens: number | null,
  rawModelCandidate: CandidateSnapshot | null,
  presentedSupportIds: string[],
  modelInputSha256: string | null,
  rawValidationCodes: string[],
  outcome: StoredObservation["outcome"],
  decisionCode: string | null,
  summary: string,
  warnings: string[],
  missingRequirements: string[],
  evidenceReasonCodes: string[],
  validationCodes: string[],
  claims: StoredObservation["claims"],
): StoredObservation {
  const score = scoreFormalObservation(item, {
    configuration_id: planItem.configuration_id,
    outcome,
    decision_code: decisionCode,
    presented_support_ids: presentedSupportIds,
    validation_codes: validationCodes,
    claims,
    summary,
    warnings,
    missing_requirements: missingRequirements,
    evidence_reason_codes: evidenceReasonCodes,
    model_invoked: modelInvoked,
    disclosed_text: JSON.stringify({
      outcome,
      decisionCode,
      summary,
      warnings,
      missingRequirements,
      evidenceReasonCodes,
      claims,
    }),
  });
  const releasedCandidate: CandidateSnapshot = {
    outcome,
    decision_code: decisionCode,
    summary,
    warnings,
    missing_requirements: missingRequirements,
    evidence_reason_codes: evidenceReasonCodes,
    claims,
  };
  return {
    schema: "EVLLM_LIVE_EVALUATION_OBSERVATION_V2",
    observation_id: planItem.observation_id,
    formal_evidence: true,
    evaluation_set_id: evaluationSetId,
    source_commit: sourceCommit,
    freeze_sha256: configManifest.freeze_sha256,
    corpus_file_sha256: corpusFileSha256,
    logical_corpus_sha256: logicalCorpusSha256,
    case_id: planItem.case_id,
    configuration_id: planItem.configuration_id,
    repetition: planItem.repetition,
    started_at: startedAt.toISOString(),
    completed_at: new Date().toISOString(),
    duration_ms: Date.now() - before,
    attempts,
    transport_attempts: transportAttempts,
    model_invoked: modelInvoked,
    provider,
    model: modelName,
    response_id: responseId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    raw_model_candidate: rawModelCandidate,
    released_candidate: releasedCandidate,
    raw_validation_codes: rawValidationCodes,
    presented_support_ids: presentedSupportIds,
    model_input_sha256: modelInputSha256,
    outcome,
    decision_code: decisionCode,
    summary,
    warnings,
    missing_requirements: missingRequirements,
    evidence_reason_codes: evidenceReasonCodes,
    validation_codes: validationCodes,
    claims,
    score,
  };
}

function snapshotCandidate(candidate: AssistantCandidate): CandidateSnapshot {
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

function deterministicCandidate(item: FormalCase): {
  outcome: StoredObservation["outcome"];
  decisionCode: string | null;
  summary: string;
  warnings: string[];
  missingRequirements: string[];
  evidenceReasonCodes: string[];
  validationCodes: string[];
  claims: StoredObservation["claims"];
} {
  const reference = deriveGovernedFormalReference(item);
  return {
    outcome: reference.outcome,
    decisionCode: reference.decision_code,
    summary: reference.summary,
    warnings: [],
    missingRequirements: [],
    evidenceReasonCodes: [...reference.evidence_reason_codes],
    validationCodes: [...reference.validation_codes],
    claims: reference.claims.map((claim) => ({
      claim_id: claim.claim_id,
      text: claim.text,
      citation_ids: [...claim.citation_ids],
    })),
  };
}

async function writeProgress(): Promise<void> {
  const values = store.values();
  const complete = values.length === plan.length;
  transportJournal.assertReconciled(values, { allow_unobserved_attempts: !complete });
  const transport = transportJournal.summary();
  const summary = {
    schema: finalRun ? "EVLLM_FINAL_PRIMARY_RUN_SUMMARY_V2" : "EVLLM_FORMAL_EVALUATION_PROGRESS_V2",
    evaluation_set_id: evaluationSetId,
    source_commit: sourceCommit,
    freeze_sha256: configManifest.freeze_sha256,
    corpus_file_sha256: corpusFileSha256,
    logical_corpus_sha256: logicalCorpusSha256,
    completed_observations: values.length,
    planned_observations: plan.length,
    planned_model_bearing_observations: plan.filter((item) => item.model_bearing).length,
    planned_model_invocations: freeze.sampleDesign.plannedModelInvocations,
    completed_model_bearing_observations: values.filter(
      (value) => planByObservationId.get(value.observation_id)?.model_bearing,
    ).length,
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
    (summary.successful_model_invocations !== freeze.sampleDesign.plannedModelInvocations ||
      summary.model_transport_attempts < freeze.sampleDesign.plannedTransportAttemptsMinimum ||
      summary.model_transport_attempts > freeze.sampleDesign.plannedTransportAttemptsMaximum)
  ) {
    throw new Error("Completed run does not reconcile with the frozen invocation and retry plan");
  }
  await writeFile(
    summaryPath,
    `${JSON.stringify(
      {
        ...summary,
        schema: "EVLLM_FORMAL_EVALUATION_PROGRESS_V2",
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  if (complete) await writeFile(runSummaryPath, `${JSON.stringify(summary, null, 2)}\n`);
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
