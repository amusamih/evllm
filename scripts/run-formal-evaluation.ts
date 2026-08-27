import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { assertOpenAIAssistantConfig, OPENAI_ASSISTANT_CONFIG } from "../src/assistant/model.js";
import {
  createFormalModelConditionAdapters,
  deriveGovernedFormalReference,
  MODEL_CONDITION_IDS,
} from "../src/evaluation/conditions.js";
import {
  buildFormalPlan,
  formalCorpus,
  scoreFormalObservation,
  sha256Json,
  type FormalCase,
} from "../src/evaluation/formal.js";
import { assertPrimaryFreezeProtocol } from "../src/evaluation/final-freeze-validation.js";

const arguments_ = process.argv.slice(2);
const finalRun = arguments_.includes("--final");
const freezePath = resolve(
  finalRun ? "evaluation/final/primary-freeze.json" : "evaluation/formal/evaluation-freeze-v2.json",
);
const corpusPath = resolve(
  finalRun ? "evaluation/final/primary-corpus.json" : "evaluation/formal/task-corpus-v2.json",
);
const strictPreflight = arguments_.includes("--preflight");
if (arguments_.some((argument) => !["--dry-run", "--preflight", "--final"].includes(argument))) {
  throw new Error("Usage: npm run evaluation:formal:dry-run or evaluation:formal:preflight");
}

const [freezeBytes, corpusBytes] = await Promise.all([readFile(freezePath), readFile(corpusPath)]);
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
  freeze.schema ===
    (finalRun ? "EVLLM_FINAL_PRIMARY_EVALUATION_FREEZE_V2" : "EVLLM_FORMAL_EVALUATION_FREEZE_V2"),
  "Wrong freeze schema",
);
if (finalRun)
  assert(freeze.evaluation_set_id !== undefined, "Final freeze lacks evaluation set ID");
assert(!freeze.formalOutputsCollected, "Freeze says formal outputs were already collected");
assert(corpus.case_count === freeze.taskCorpus.caseCount, "Frozen case count mismatch");
assert(recordedCorpusHash === logicalCorpusHash, "Corpus logical digest mismatch");
assert(
  freeze.taskCorpus.logicalCorpusSha256 === logicalCorpusHash,
  "Freeze logical digest mismatch",
);
assert(freeze.taskCorpus.corpusFileSha256 === corpusFileHash, "Freeze file digest mismatch");
assert(freeze.model.provider === "openai", "Frozen model provider mismatch");
assert(freeze.model.api === "responses", "Frozen model API mismatch");
assertOpenAIAssistantConfig(freeze.model, OPENAI_ASSISTANT_CONFIG, "Formal evaluation freeze");
assertPrimaryFreezeProtocol(freeze);
assert(freeze.model.repetitionsPerStochasticCondition === 5, "Frozen repetitions mismatch");

const plan = buildFormalPlan(corpus);
const modelPlan = plan.filter((item) => item.model_bearing);
assert(
  modelPlan.length === freeze.sampleDesign.plannedModelBearingObservations,
  "Frozen model-bearing observation count mismatch",
);
assert(plan.length === freeze.sampleDesign.totalObservationsPlanned, "Frozen plan size mismatch");
assert(plan.length === 3_840, "Formal observation count must be 3,840");
const casesById = new Map(corpus.cases.map((item) => [item.case_id, item]));
const adapters = createFormalModelConditionAdapters();
const invocationsByCondition = Object.fromEntries(
  MODEL_CONDITION_IDS.map((conditionId) => {
    const adapter = adapters.get(conditionId);
    if (adapter === undefined) throw new Error(`Missing formal adapter ${conditionId}`);
    const invocations = plan.filter((planItem) => {
      if (planItem.configuration_id !== conditionId) return false;
      const item = casesById.get(planItem.case_id);
      if (item === undefined) throw new Error(`Missing formal case ${planItem.case_id}`);
      return adapter.willInvokeModel(item, invocationContextForCase(item));
    }).length;
    return [conditionId, invocations];
  }),
);
assert(
  JSON.stringify(invocationsByCondition) ===
    JSON.stringify(freeze.sampleDesign.plannedModelInvocationsByCondition),
  "Frozen per-condition model-invocation plan mismatch",
);
const plannedModelInvocations = Object.values(invocationsByCondition).reduce(
  (total, count) => total + count,
  0,
);
assert(
  plannedModelInvocations === freeze.sampleDesign.plannedModelInvocations,
  "Frozen model-invocation count mismatch",
);
assert(
  freeze.sampleDesign.plannedTransportAttemptsMinimum === plannedModelInvocations &&
    freeze.sampleDesign.plannedTransportAttemptsMaximum ===
      plannedModelInvocations * (freeze.model.maximumTransportRetriesPerInvocation + 1),
  "Frozen transport-attempt bounds mismatch",
);

for (const item of corpus.cases) {
  const modelInvoked = adapters
    .get("governed-evllm")!
    .willInvokeModel(item, invocationContextForCase(item));
  const reference = deriveGovernedFormalReference(item);
  const perfect = scoreFormalObservation(item, {
    configuration_id: "governed-evllm",
    outcome: reference.outcome,
    decision_code: reference.decision_code,
    presented_support_ids: item.supports.map(({ support_id: supportId }) => supportId),
    validation_codes: item.expected_validation_code === null ? [] : [item.expected_validation_code],
    claims:
      item.expected_support_ids.length === 0
        ? []
        : item.expected_support_ids.map((supportId) => ({
            text: item.supports.find((support) => support.support_id === supportId)?.content ?? "",
            citation_ids: [supportId],
          })),
    summary:
      reference.decision_code === null
        ? item.expected_outcome === "answer"
          ? (item.supports[0]?.content ?? "Response supported")
          : "None"
        : reference.summary,
    warnings: [],
    missing_requirements: [],
    evidence_reason_codes: evidenceReasonCodes(item),
    model_invoked: modelInvoked,
  });
  assert(perfect.task_success === 1, `Scorer rejected perfect fixture for ${item.case_id}`);
}

const sourceCommit = git("rev-parse", "HEAD");
const sourceStatus = git("status", "--porcelain");
if (strictPreflight)
  assert(sourceStatus.length === 0, "Formal preflight requires a clean worktree");

const report = {
  schema: "EVLLM_FORMAL_EVALUATION_DRY_RUN_V2",
  mode: strictPreflight ? "preflight" : "development-dry-run",
  formal_outputs_collected: false,
  evaluation_set_id: freeze.evaluation_set_id ?? null,
  source_commit: sourceCommit,
  source_clean: sourceStatus.length === 0,
  frozen_model: freeze.model.model,
  effective_openai_config: OPENAI_ASSISTANT_CONFIG,
  cases: corpus.case_count,
  configurations: MODEL_CONDITION_IDS.length,
  conditions: freeze.conditions,
  primary_outcomes: freeze.primaryOutcomes,
  maximum_transport_retries_per_invocation: freeze.model.maximumTransportRetriesPerInvocation,
  provider_internal_retries: OPENAI_ASSISTANT_CONFIG.providerMaxRetries,
  model_bearing_observations: modelPlan.length,
  planned_model_invocations: plannedModelInvocations,
  planned_model_invocations_by_condition: invocationsByCondition,
  planned_transport_attempts: {
    minimum: freeze.sampleDesign.plannedTransportAttemptsMinimum,
    maximum: freeze.sampleDesign.plannedTransportAttemptsMaximum,
  },
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

function invocationContextForCase(item: FormalCase) {
  return {
    purposeId: item.access_request.purpose_id,
    session: {
      sessionId: "urn:evllm:session:00000000-0000-4000-8000-000000000001",
      actorId: "urn:evllm:actor:00000000-0000-4000-8000-000000000001",
      organizationId: item.access_request.organization_id,
      credentialId: "urn:evllm:credential:00000000-0000-4000-8000-000000000001",
      address: "0x1111111111111111111111111111111111111111",
      issuedAt: 100,
      expiresAt: 300,
    },
  } as const;
}

function evidenceReasonCodes(item: FormalCase) {
  if (item.expected_validation_code === "missing-support") return ["missing-evidence"] as const;
  if (item.expected_validation_code === "conflicting-support") {
    return ["conflicting-evidence", "external-decision-required"] as const;
  }
  if (item.expected_validation_code === "inactive-support") return ["inactive-evidence"] as const;
  if (item.expected_validation_code === "access-denied") return ["access-denied"] as const;
  if (item.expected_validation_code === "prompt-injection") return ["prompt-injection"] as const;
  if (item.expected_validation_code === "external-decision-boundary") {
    return ["external-decision-required"] as const;
  }
  return [] as const;
}
