import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertOpenAIAssistantConfig, OPENAI_ASSISTANT_CONFIG } from "../src/assistant/model.js";
import { parseAndVerifyComplementaryCorpus } from "../src/evaluation/complementary.js";
import { assertComplementaryRawDiagnosticFreeze } from "../src/evaluation/complementary-metrics.js";
import { sha256Bytes } from "../src/evaluation/final-freeze.js";
import { assertSynthesisFreezeProtocol } from "../src/evaluation/final-freeze-validation.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";

const [freezeBytes, corpusBytes, primaryFreezeBytes] = await Promise.all([
  readFile(resolve("evaluation/final/synthesis-freeze.json")),
  readFile(resolve("evaluation/final/synthesis-corpus.json")),
  readFile(resolve("evaluation/final/primary-freeze.json")),
]);
const freeze = JSON.parse(freezeBytes.toString("utf8")) as SynthesisFreeze;
const primaryFreeze = JSON.parse(primaryFreezeBytes.toString("utf8")) as {
  readonly evaluation_set_id?: string;
};
const { corpus, logicalCorpusSha256 } = parseAndVerifyComplementaryCorpus(
  JSON.parse(corpusBytes.toString("utf8")),
);

if (freeze.schema !== "EVLLM_FINAL_SYNTHESIS_EVALUATION_FREEZE_V2") {
  throw new Error("Wrong final synthesis freeze schema");
}
if (freeze.outputsCollected) throw new Error("Final synthesis freeze marks outputs as collected");
if (freeze.evaluation_set_id === undefined) {
  throw new Error("Final synthesis freeze lacks an evaluation set ID");
}
if (primaryFreeze.evaluation_set_id !== freeze.evaluation_set_id) {
  throw new Error("Primary and synthesis freezes use different evaluation set IDs");
}
if (freeze.model.provider !== "openai" || freeze.model.api !== "responses") {
  throw new Error("Final synthesis freeze has an unexpected model provider or API");
}
assertOpenAIAssistantConfig(freeze.model, OPENAI_ASSISTANT_CONFIG, "Synthesis preflight freeze");
assertSynthesisFreezeProtocol(freeze);
assertComplementaryRawDiagnosticFreeze(freeze);
if (sha256Bytes(corpusBytes) !== freeze.corpus.corpusFileSha256) {
  throw new Error("Final synthesis corpus file digest mismatch");
}
if (logicalCorpusSha256 !== freeze.corpus.logicalCorpusSha256) {
  throw new Error("Final synthesis logical corpus digest mismatch");
}
if (corpus.cases.length !== freeze.corpus.caseCount) {
  throw new Error("Final synthesis corpus case count mismatch");
}
const plannedResponses = corpus.cases.length * freeze.model.repetitionsPerCase;
if (plannedResponses !== freeze.model.plannedMaximumModelResponses) {
  throw new Error("Final synthesis response plan differs from its freeze");
}
const source = assertCommittedEvaluationSource([], {
  publicRemoteTrackingRef: "origin/main",
  operation: "Final synthesis preflight",
});

process.stdout.write(
  `${JSON.stringify(
    {
      schema: "EVLLM_FINAL_SYNTHESIS_PREFLIGHT_V1",
      evaluation_set_id: freeze.evaluation_set_id,
      source_commit: source.sourceCommit,
      source_clean: true,
      cases: corpus.cases.length,
      conditions: freeze.conditions,
      primary_metrics: freeze.primaryMetrics,
      repetitions_per_case: freeze.model.repetitionsPerCase,
      planned_model_responses: plannedResponses,
      maximum_transport_retries_per_invocation: freeze.model.transportRetries,
      provider_internal_retries: OPENAI_ASSISTANT_CONFIG.providerMaxRetries,
      model: freeze.model.model,
      temperature: freeze.model.temperature,
      max_output_tokens: freeze.model.maxOutputTokens,
      provider_storage: freeze.model.store,
      freeze_sha256: sha256Bytes(freezeBytes),
      corpus_file_sha256: sha256Bytes(corpusBytes),
      logical_corpus_sha256: logicalCorpusSha256,
    },
    null,
    2,
  )}\n`,
);

interface SynthesisFreeze {
  readonly schema: string;
  readonly evaluation_set_id?: string;
  readonly outputsCollected: boolean;
  readonly rawGenerationDiagnostics: unknown;
  readonly rawGenerationDiagnosticFieldMap: unknown;
  readonly conditions: unknown;
  readonly primaryMetrics: unknown;
  readonly corpus: {
    readonly caseCount: number;
    readonly logicalCorpusSha256: string;
    readonly corpusFileSha256: string;
  };
  readonly model: {
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly temperature: number;
    readonly maxOutputTokens: number;
    readonly store: boolean;
    readonly repetitionsPerCase: number;
    readonly plannedMaximumModelResponses: number;
    readonly transportRetries: number;
  };
}
