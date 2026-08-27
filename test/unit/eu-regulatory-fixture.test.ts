import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { generatedFormalCorpus } from "../../scripts/generate-evaluation-corpus.js";
import {
  EU_BATTERIES_REGULATION_CELEX,
  EU_BATTERIES_REGULATION_ELI,
  EU_BATTERIES_REGULATION_EUR_LEX,
  EU_BATTERY_PASSPORT_CLAUSE_IDS,
  euRegulatorySourceFixture,
} from "../../src/evaluation/regulatory.js";

const fixture = euRegulatorySourceFixture.parse(
  JSON.parse(
    readFileSync(
      resolve("evaluation/fixtures/eu-regulation-2023-1542-articles-77-78.json"),
      "utf8",
    ),
  ),
);

describe("EU regulatory evaluation fixture", () => {
  it("pins the official Regulation (EU) 2023/1542 identifiers and eight selected clauses", () => {
    expect(fixture.source).toMatchObject({
      jurisdiction: "EU",
      celex_identifier: EU_BATTERIES_REGULATION_CELEX,
      eli_uri: EU_BATTERIES_REGULATION_ELI,
      official_eur_lex_uri: EU_BATTERIES_REGULATION_EUR_LEX,
    });
    expect(fixture.clauses.map((item) => item.clause_id)).toEqual([
      ...EU_BATTERY_PASSPORT_CLAUSE_IDS,
    ]);
    expect(fixture.clauses.some((item) => item.reference === "Article 77(1)")).toBe(true);
    expect(fixture.clauses.some((item) => item.reference === "Article 78(h)")).toBe(true);
  });

  it("keeps the grounded source separate from synthetic evaluation claims", () => {
    expect(fixture.scope_boundary).toMatchObject({
      legal_compliance_validation: false,
      legal_advice: false,
      synthetic_elements: [
        "actor identities",
        "battery facts",
        "route parameters",
        "expected outcomes",
      ],
    });
  });

  it("uses one representative provision across controlled EU variants", () => {
    expect(generatedFormalCorpus).toMatchObject({
      schema: "EVLLM_FORMAL_TASK_CORPUS_V2",
      version: 2,
      case_count: 96,
      scope_boundary: { legal_compliance_validation: false },
    });
    const cases = generatedFormalCorpus.cases.filter(
      (item) => item.stratum === "eu-date-jurisdiction",
    );
    expect(cases).toHaveLength(8);
    expect(new Set(cases.map((item) => item.regulatory_basis?.clause_id))).toEqual(
      new Set(["eu-2023-1542-art-77-1"]),
    );
    for (const item of cases) {
      expect(item.regulatory_basis).toBeDefined();
      if (item.regulatory_basis === undefined) continue;
      expect(item.regulatory_basis.jurisdiction).toBe("EU");
      expect(item.prompt).toContain(item.regulatory_basis.clause_reference);
      const clause = fixture.clauses.find(
        (candidate) => candidate.clause_id === item.regulatory_basis?.clause_id,
      );
      expect(item.regulatory_basis.normalized_requirement).toBe(clause?.normalized_requirement);
      for (const support of item.supports) {
        expect(support.content).not.toContain("active for eu-date-jurisdiction");
        expect(support.content).not.toContain("conflicting value for eu-date-jurisdiction");
      }
    }
    const effectiveDateEdge = cases.find(({ variant }) => variant === "edge");
    expect(effectiveDateEdge?.prompt).toContain("exactly on 18 February 2027");
    expect(
      effectiveDateEdge?.supports.filter((support) => support.recorded_decision === undefined),
    ).toHaveLength(2);
    expect(
      effectiveDateEdge?.supports.filter((support) => support.recorded_decision !== undefined),
    ).toHaveLength(1);
  });
});
