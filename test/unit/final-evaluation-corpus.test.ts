import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generatedFormalCorpus } from "../../scripts/generate-evaluation-corpus.js";
import { formalCorpus } from "../../src/evaluation/formal.js";

describe("final primary corpus derivation", () => {
  it("packages the canonical V2 corpus without renaming or rewriting its cases", () => {
    expect(generatedFormalCorpus.schema).toBe("EVLLM_FORMAL_TASK_CORPUS_V2");
    const packaged = formalCorpus.parse(
      JSON.parse(readFileSync(resolve("evaluation/final/primary-corpus.json"), "utf8")),
    );
    expect(packaged).toEqual(generatedFormalCorpus);
    expect(packaged.cases[0]?.case_id).toBe("formal-001");
    expect(packaged.cases.at(-1)?.case_id).toBe("formal-096");

    const sourceEuCases = generatedFormalCorpus.cases.filter(
      (item) => item.stratum === "eu-date-jurisdiction",
    );
    const finalEuCases = packaged.cases.filter((item) => item.stratum === "eu-date-jurisdiction");
    expect(finalEuCases).toHaveLength(8);
    expect(finalEuCases.map((item) => item.regulatory_basis)).toEqual(
      sourceEuCases.map((item) => item.regulatory_basis),
    );
    expect(
      finalEuCases.every(
        (item) =>
          item.regulatory_basis?.fixture_id === "eu-regulation-2023-1542-battery-passport" &&
          item.regulatory_basis.clause_id === "eu-2023-1542-art-77-1" &&
          item.regulatory_basis.clause_reference.length > 0 &&
          item.regulatory_basis.normalized_requirement.length > 0,
      ),
    ).toBe(true);
  });
});
