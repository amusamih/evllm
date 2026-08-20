import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const freezeBytes = readFileSync(resolve("evaluation/complementary/synthesis-freeze-v1.json"));
const corpusBytes = readFileSync(resolve("evaluation/complementary/synthesis-corpus-v1.json"));
const freeze = JSON.parse(freezeBytes.toString("utf8")) as {
  outputsCollected: boolean;
  conditions: unknown[];
  primaryMetrics: string[];
  corpus: { caseCount: number; logicalCorpusSha256: string; corpusFileSha256: string };
  model: { plannedMaximumModelResponses: number };
};
const corpus = JSON.parse(corpusBytes.toString("utf8")) as {
  case_count: number;
  strata: string[];
  corpus_sha256: string;
  cases: Array<{ stratum: string; records: unknown[]; evllm_operations: number }>;
};

describe("complementary synthesis evaluation freeze", () => {
  it("freezes a balanced fresh corpus and three complementary conditions", () => {
    expect(freeze.outputsCollected).toBe(false);
    expect(freeze.conditions).toHaveLength(3);
    expect(freeze.primaryMetrics).toHaveLength(8);
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
    const fileHash = `0x${createHash("sha256").update(corpusBytes).digest("hex")}`;
    expect(freeze.corpus.caseCount).toBe(corpus.case_count);
    expect(freeze.corpus.logicalCorpusSha256).toBe(corpus.corpus_sha256);
    expect(freeze.corpus.corpusFileSha256).toBe(fileHash);
  });
});
