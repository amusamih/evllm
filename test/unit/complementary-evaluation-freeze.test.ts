import { describe, expect, it } from "vitest";

import { OPENAI_ASSISTANT_CONFIG } from "../../src/assistant/model.js";
import {
  generatedSynthesisCorpus,
  generatedSynthesisFreeze,
} from "../../scripts/generate-complementary-evaluation.js";
import { jsonFileBytes, sha256Bytes } from "../../src/evaluation/final-freeze.js";
import {
  assertComplementaryRawDiagnosticFreeze,
  COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP,
  COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS,
} from "../../src/evaluation/complementary-metrics.js";

const freeze = generatedSynthesisFreeze;
const corpus = generatedSynthesisCorpus;

describe("complementary synthesis evaluation freeze", () => {
  it("freezes a balanced synthetic corpus and three complementary conditions", () => {
    expect(freeze.schema).toBe("EVLLM_COMPLEMENTARY_SYNTHESIS_FREEZE_V2");
    expect(corpus.schema).toBe("EVLLM_COMPLEMENTARY_SYNTHESIS_CORPUS_V2");
    expect(corpus.source_class).toBe("synthetic-generator");
    expect(freeze.outputsCollected).toBe(false);
    expect(freeze.conditions).toHaveLength(3);
    expect(freeze.primaryMetrics).toHaveLength(8);
    expect(freeze.rawGenerationDiagnostics).toEqual(COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS);
    expect(freeze.rawGenerationDiagnosticFieldMap).toEqual(COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP);
    expect(freeze.model).toMatchObject(OPENAI_ASSISTANT_CONFIG);
    expect(freeze.model.plannedMaximumModelResponses).toBe(150);
    expect(corpus.case_count).toBe(30);
    expect(corpus.cases).toHaveLength(30);
    expect(corpus.strata).toHaveLength(6);
    for (const stratum of corpus.strata)
      expect(corpus.cases.filter((item) => item.stratum === stratum)).toHaveLength(5);
    expect(
      corpus.cases.every((item) => item.records.length >= 4 && item.evllm_operations === 1),
    ).toBe(true);
  });

  it("binds the exact corpus before outputs", () => {
    const fileHash = sha256Bytes(jsonFileBytes(corpus));
    expect(freeze.corpus.caseCount).toBe(corpus.case_count);
    expect(freeze.corpus.logicalCorpusSha256).toBe(corpus.corpus_sha256);
    expect(freeze.corpus.corpusFileSha256).toBe(fileHash);
    expect(freeze.corpus.path).toBe("evaluation/complementary/synthesis-corpus-v2.json");
    expect(freeze.analysis.resamplingUnit).toBe("case_id");
  });

  it("rejects any drift between frozen diagnostic labels and artifact fields", () => {
    expect(() => assertComplementaryRawDiagnosticFreeze(freeze)).not.toThrow();
    expect(() =>
      assertComplementaryRawDiagnosticFreeze({
        ...freeze,
        rawGenerationDiagnosticFieldMap: {
          ...freeze.rawGenerationDiagnosticFieldMap,
          raw_outcome_fidelity: "generation_success",
        },
      }),
    ).toThrow(/field mapping/u);
  });

  it("keeps recorded decision codes in records rather than exposing them in prompts", () => {
    for (const item of corpus.cases) {
      expect(item.records.some(({ content }) => content.includes(item.expected_conclusion))).toBe(
        true,
      );
      expect(item.prompt).not.toContain(item.expected_conclusion);
      expect(item.prompt).toContain("Battery SYN-");
      expect(item.prompt).not.toContain(item.case_id);
      const decisionRecords = item.records.filter(
        ({ recorded_decision: decision }) => decision !== undefined,
      );
      expect(decisionRecords).toHaveLength(1);
      expect(decisionRecords[0]?.support_id).toBe(item.records.at(-1)?.support_id);
      expect(decisionRecords[0]?.recorded_decision).toMatchObject({
        outcome: item.expected_outcome,
        code: item.expected_conclusion,
      });
    }
  });

  it("states the route comparison scope without collapsing its six components", () => {
    const routeCases = corpus.cases.filter(({ stratum }) => stratum === "route-comparison");
    for (const item of routeCases) {
      expect(item.prompt).toContain("three recorded routes");
      expect(item.prompt).toContain("six components separately");
      expect(item.prompt).toContain("G is the technical and safety gate");
      expect(item.prompt).toContain("C is circularity");
      expect(item.prompt).toContain("I contains the environmental indicators");
      expect(item.prompt).toContain("E is economics");
      expect(item.prompt).toContain("A is information adequacy");
      expect(item.prompt).toContain("U is uncertainty");
      expect(item.prompt).toContain("overall sustainability score");
    }
  });
});
