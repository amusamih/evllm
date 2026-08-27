import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { generatedSynthesisCorpus } from "../../scripts/generate-complementary-evaluation.js";
import { assistantSupport } from "../../src/assistant/index.js";
import {
  parseAndValidateComplementaryCorpus,
  parseAndVerifyComplementaryCorpus,
  supportsForSynthesisCase,
} from "../../src/evaluation/complementary.js";

describe("complementary evaluation corpus preflight", () => {
  it("accepts the generated corpus before collection", () => {
    const corpus = parseAndValidateComplementaryCorpus(generatedSynthesisCorpus);
    expect(corpus.cases).toHaveLength(30);
  });

  it.each([
    "evaluation/complementary/synthesis-corpus-v2.json",
    "evaluation/final/synthesis-corpus.json",
  ])("accepts the stored source corpus %s", (path) => {
    const corpus = parseAndValidateComplementaryCorpus(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    expect(corpus.cases).toHaveLength(30);
  });

  it.each([
    [
      "evaluation/complementary/synthesis-corpus-v2.json",
      "evaluation/complementary/synthesis-freeze-v2.json",
    ],
    ["evaluation/final/synthesis-corpus.json", "evaluation/final/synthesis-freeze.json"],
  ])("reproduces the stored logical digest for %s", (corpusPath, freezePath) => {
    const storedCorpus = JSON.parse(readFileSync(corpusPath, "utf8")) as unknown;
    const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as {
      corpus: { logicalCorpusSha256: string };
    };
    const { corpus, logicalCorpusSha256 } = parseAndVerifyComplementaryCorpus(storedCorpus);

    expect(logicalCorpusSha256).toBe(corpus.corpus_sha256);
    expect(logicalCorpusSha256).toBe(freeze.corpus.logicalCorpusSha256);
  });

  it("rejects a stored corpus whose content no longer matches its logical digest", () => {
    const storedCorpus = JSON.parse(
      readFileSync("evaluation/final/synthesis-corpus.json", "utf8"),
    ) as { cases: Array<{ prompt: string }> };
    storedCorpus.cases[0]!.prompt += " Altered after the corpus was frozen.";

    expect(() => parseAndVerifyComplementaryCorpus(storedCorpus)).toThrow(
      "logical digest is not reproducible",
    );
  });

  it("rejects a decision that is not attached to the final active record", () => {
    const corpus = validCopy();
    const item = corpus.cases[0]!;
    const first = item.records[0]!;
    const final = item.records.at(-1)!;
    first.recorded_decision = final.recorded_decision;
    delete final.recorded_decision;
    expect(() => parseAndValidateComplementaryCorpus(corpus)).toThrow("final deterministic record");

    const inactive = validCopy();
    inactive.cases[0]!.records.at(-1)!.status = "stale";
    expect(() => parseAndValidateComplementaryCorpus(inactive)).toThrow(
      "final active recorded decision",
    );
  });

  it("rejects expected fields that disagree with the typed decision", () => {
    const corpus = validCopy();
    corpus.cases[0]!.expected_conclusion = "different-recorded-code";
    expect(() => parseAndValidateComplementaryCorpus(corpus)).toThrow(
      "typed decision code conflicts",
    );
  });

  it("requires each detection label to match its typed missing or conflicting reason", () => {
    const mislabeledMissing = validCopy();
    const missingCase = mislabeledMissing.cases.find(
      ({ stratum }) => stratum === "missing-evidence",
    )!;
    missingCase.expected_detection = "conflict";
    expect(() => parseAndValidateComplementaryCorpus(mislabeledMissing)).toThrow(
      "The typed decision lacks the expected conflicting-evidence reason",
    );

    const inventedDetection = validCopy();
    inventedDetection.cases[0]!.expected_detection = "missing";
    expect(() => parseAndValidateComplementaryCorpus(inventedDetection)).toThrow(
      "The typed decision lacks the expected missing-evidence reason",
    );
  });

  it("rejects prompts that expose an evaluation ID or name the wrong battery", () => {
    const exposed = validCopy();
    exposed.cases[0]!.prompt += ` Internal key ${exposed.cases[0]!.case_id}.`;
    expect(() => parseAndValidateComplementaryCorpus(exposed)).toThrow(
      "exposes its evaluation case ID",
    );

    const mismatched = validCopy();
    mismatched.cases[0]!.prompt = mismatched.cases[0]!.prompt.replace(
      "Battery SYN-101",
      "Battery SYN-999",
    );
    expect(() => parseAndValidateComplementaryCorpus(mismatched)).toThrow(
      "does not name its supported battery",
    );
  });

  it("rejects route prompts that omit the three-route or six-component scope", () => {
    const routes = validCopy();
    const routeCase = routes.cases.find(({ stratum }) => stratum === "route-comparison")!;
    routeCase.prompt = routeCase.prompt.replace("three recorded routes", "recorded routes");
    expect(() => parseAndValidateComplementaryCorpus(routes)).toThrow(
      "does not state three routes",
    );

    const components = validCopy();
    const componentCase = components.cases.find(({ stratum }) => stratum === "route-comparison")!;
    componentCase.prompt = componentCase.prompt.replace(
      "six components separately",
      "assessment components",
    );
    expect(() => parseAndValidateComplementaryCorpus(components)).toThrow(
      "does not state six components",
    );

    const definitions = validCopy();
    const definitionCase = definitions.cases.find(({ stratum }) => stratum === "route-comparison")!;
    definitionCase.prompt = definitionCase.prompt.replace(
      "G is the technical and safety gate",
      "G is governance",
    );
    expect(() => parseAndValidateComplementaryCorpus(definitions)).toThrow(
      "does not define all six components",
    );
  });

  it("rejects final record prose that contradicts or omits typed metadata", () => {
    const code = validCopy();
    code.cases[0]!.records.at(-1)!.content = code.cases[0]!.records.at(-1)!.content.replace(
      "is 'eligible-for-resale'",
      "is not 'eligible-for-resale'",
    );
    expect(() => parseAndValidateComplementaryCorpus(code)).toThrow(
      "does not affirm its typed decision code",
    );

    const outcome = validCopy();
    outcome.cases[0]!.records.at(-1)!.content = outcome.cases[0]!.records.at(-1)!.content.replace(
      "structured outcome answer",
      "structured outcome abstain",
    );
    expect(() => parseAndValidateComplementaryCorpus(outcome)).toThrow(
      "does not state its typed outcome",
    );

    const missing = validCopy();
    const missingCase = missing.cases.find(({ stratum }) => stratum === "missing-evidence")!;
    missingCase.records.at(-1)!.content = missingCase.records
      .at(-1)!
      .content.replace("is missing", "is required");
    expect(() => parseAndValidateComplementaryCorpus(missing)).toThrow(
      "does not state its missing evidence",
    );

    const conflict = validCopy();
    const conflictCase = conflict.cases.find(({ stratum }) => stratum === "conflicting-evidence")!;
    conflictCase.records.at(-1)!.content = conflictCase.records
      .at(-1)!
      .content.replace("materially disagree", "are aligned");
    conflictCase.records.at(-1)!.content = conflictCase.records
      .at(-1)!
      .content.replace("deterministic conflict check", "deterministic check");
    expect(() => parseAndValidateComplementaryCorpus(conflict)).toThrow(
      "does not state its conflicting evidence",
    );
  });

  it("binds typed metadata to the full decision-bearing support", () => {
    const item = validCopy().cases[0]!;
    const decisionSupport = supportsForSynthesisCase(item).at(-1)!;
    expect(assistantSupport.safeParse(decisionSupport).success).toBe(true);
    expect(
      assistantSupport.safeParse({
        ...decisionSupport,
        content: `${decisionSupport.content} Altered after commitment.`,
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed resource before collection", () => {
    const corpus = validCopy();
    corpus.cases[0]!.records[0]!.resource_id = "not-a-resource-urn";
    expect(() => parseAndValidateComplementaryCorpus(corpus)).toThrow();
  });
});

function validCopy() {
  return structuredClone(parseAndValidateComplementaryCorpus(generatedSynthesisCorpus));
}
