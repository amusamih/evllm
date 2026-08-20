import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("final evaluation freeze", () => {
  it("binds fresh primary and synthesis corpora before collection", () => {
    for (const [freezeName, corpusName, expectedCases] of [
      ["primary-freeze.json", "primary-corpus.json", 96],
      ["synthesis-freeze.json", "synthesis-corpus.json", 30],
    ] as const) {
      const freeze = JSON.parse(
        readFileSync(resolve(`evaluation/final/${freezeName}`), "utf8"),
      ) as Record<string, unknown> & {
        formalOutputsCollected?: boolean;
        outputsCollected?: boolean;
        taskCorpus?: { corpusFileSha256: string; logicalCorpusSha256: string };
        corpus?: { corpusFileSha256: string; logicalCorpusSha256: string };
      };
      const corpusBytes = readFileSync(resolve(`evaluation/final/${corpusName}`));
      const corpus = JSON.parse(corpusBytes.toString("utf8")) as {
        case_count: number;
        corpus_sha256: string;
      };
      const binding = freeze.taskCorpus ?? freeze.corpus;
      expect(freeze.formalOutputsCollected ?? freeze.outputsCollected).toBe(false);
      expect(corpus.case_count).toBe(expectedCases);
      expect(binding?.logicalCorpusSha256).toBe(corpus.corpus_sha256);
      expect(binding?.corpusFileSha256).toBe(
        `0x${createHash("sha256").update(corpusBytes).digest("hex")}`,
      );
    }
  });

  it("uses the implemented six-component route assessment rather than an overall score", () => {
    const corpus = JSON.parse(
      readFileSync(resolve("evaluation/final/synthesis-corpus.json"), "utf8"),
    ) as {
      cases: Array<{ stratum: string; prompt: string; records: Array<{ content: string }> }>;
    };
    const routeCases = corpus.cases.filter(({ stratum }) => stratum === "route-comparison");
    expect(routeCases).toHaveLength(5);
    for (const item of routeCases) {
      const text = [item.prompt, ...item.records.map(({ content }) => content)].join(" ");
      expect(text).toContain("continued compatible EV use");
      expect(text).toContain("stationary-storage repurposing");
      expect(text).toContain("recycling");
      expect(text).toContain("G=PASS");
      expect(text).toContain("C=");
      expect(text).toContain("I=[");
      expect(text).toContain("E=NPV");
      expect(text).toContain("A=coverage");
      expect(text).toContain("U=gate-pass");
      expect(text).toContain("no overall sustainability score");
      expect(text).not.toContain("remanufacturing route score");
    }
  });
});
