import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildFinalEvaluationFreezes,
  jsonFileBytes,
  sha256Bytes,
  sha256Json,
  type CorpusBinding,
} from "../src/evaluation/final-freeze.js";
import { generatedSynthesisCorpus } from "./generate-complementary-evaluation.js";
import {
  generatedFormalCorpus,
  generatedFormalFreeze,
  generatedRegulatorySourceBindings,
} from "./generate-evaluation-corpus.js";
import { sustainabilitySynthesisRecords } from "./lib/sustainability-evidence.js";

// The final package reuses the canonical formal corpus verbatim. Its freeze path,
// evaluation-set identifier, and source binding identify the package without
// changing case IDs, record contents, or resource identifiers.
const primary = structuredClone(generatedFormalCorpus) as PrimaryCorpus;

const originalSynthesis = structuredClone(generatedSynthesisCorpus) as SynthesisCorpus;
const synthesisCases = originalSynthesis.cases.map((item, index) => {
  const expectedOutcome = synthesisOutcome(item.stratum);
  if (item.stratum !== "route-comparison")
    return {
      ...item,
      expected_outcome: expectedOutcome,
    };
  const variant = index - 19;
  const evaluated = sustainabilitySynthesisRecords(variant, item.case_id);
  return {
    ...item,
    expected_conclusion: "continued-compatible-ev-use-preferred",
    expected_outcome: "answer",
    records: evaluated.records.map((record, recordIndex) => ({
      ...record,
      resource_id: `urn:evllm:assessment:00000000-0000-4000-8006-${String((index + 101) * 10 + recordIndex).padStart(12, "0")}`,
      resource_version: 1,
      status: "active",
    })),
    raw_record_operations: evaluated.records.length,
    sequential_deterministic_operations: evaluated.records.length + 1,
    evllm_operations: 1,
  };
});
const synthesisUnsigned = {
  ...originalSynthesis,
  generated_from_seed: "evllm-final-synthesis-v2-2026-08-27",
  generator: "scripts/generate-final-evaluation.ts",
  cases: synthesisCases,
};
delete (synthesisUnsigned as Partial<SynthesisCorpus>).corpus_sha256;
const synthesis = { ...synthesisUnsigned, corpus_sha256: sha256Json(synthesisUnsigned) };

const primaryBytes = jsonFileBytes(primary);
const synthesisBytes = jsonFileBytes(synthesis);
const freezes = buildFinalEvaluationFreezes(
  corpusBinding("evaluation/final/primary-corpus.json", primary, primaryBytes),
  corpusBinding("evaluation/final/synthesis-corpus.json", synthesis, synthesisBytes),
  generatedRegulatorySourceBindings,
  generatedFormalFreeze.sampleDesign,
);
const primaryFreezeBytes = jsonFileBytes(freezes.primary);
const synthesisFreezeBytes = jsonFileBytes(freezes.synthesis);

await mkdir(resolve("evaluation/final"), { recursive: true });
await Promise.all([
  writeFile(resolve("evaluation/final/primary-corpus.json"), primaryBytes),
  writeFile(resolve("evaluation/final/synthesis-corpus.json"), synthesisBytes),
  writeFile(resolve("evaluation/final/primary-freeze.json"), primaryFreezeBytes),
  writeFile(resolve("evaluation/final/synthesis-freeze.json"), synthesisFreezeBytes),
]);
process.stdout.write(
  `${JSON.stringify(
    {
      evaluation_set_id: freezes.evaluationSetId,
      primary: {
        cases: primary.cases.length,
        logical_digest: primary.corpus_sha256,
        file_digest: sha256Bytes(primaryBytes),
        freeze_digest: sha256Bytes(primaryFreezeBytes),
      },
      synthesis: {
        cases: synthesis.cases.length,
        logical_digest: synthesis.corpus_sha256,
        file_digest: sha256Bytes(synthesisBytes),
        freeze_digest: sha256Bytes(synthesisFreezeBytes),
      },
    },
    null,
    2,
  )}\n`,
);

interface PrimaryCorpus {
  corpus_sha256: string;
  case_count: number;
  strata: string[];
  cases: Array<Record<string, unknown> & { case_id: string }>;
  [key: string]: unknown;
}
interface SynthesisCorpus {
  corpus_sha256: string;
  case_count: number;
  strata: string[];
  cases: Array<
    Record<string, unknown> & {
      case_id: string;
      stratum: string;
      prompt: string;
    }
  >;
  [key: string]: unknown;
}

type SynthesisOutcome = "answer" | "abstain" | "requires_external_decision";

function synthesisOutcome(stratum: string): SynthesisOutcome {
  if (stratum === "missing-evidence") return "abstain";
  if (stratum === "conflicting-evidence") return "requires_external_decision";
  return "answer";
}

function corpusBinding(
  path: string,
  corpus: PrimaryCorpus | SynthesisCorpus,
  bytes: Uint8Array,
): CorpusBinding {
  if (corpus.case_count !== corpus.cases.length) throw new Error(`Case count mismatch for ${path}`);
  if (corpus.strata.length === 0 || corpus.case_count % corpus.strata.length !== 0)
    throw new Error(`Unbalanced corpus cannot be frozen at ${path}`);
  return {
    path,
    caseCount: corpus.case_count,
    strataCount: corpus.strata.length,
    casesPerStratum: corpus.case_count / corpus.strata.length,
    logicalCorpusSha256: corpus.corpus_sha256,
    corpusFileSha256: sha256Bytes(bytes),
  };
}
