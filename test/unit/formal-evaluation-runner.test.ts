import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFormalPlan,
  formalCorpus,
  scoreFormalObservation,
} from "../../src/evaluation/formal.js";

const corpus = formalCorpus.parse(
  JSON.parse(readFileSync(resolve("evaluation/formal/task-corpus-v1.json"), "utf8")),
);

describe("formal evaluation runner", () => {
  it("expands the frozen paired design exactly", () => {
    const plan = buildFormalPlan(corpus);
    expect(plan).toHaveLength(4_128);
    expect(plan.filter((item) => item.model_bearing)).toHaveLength(3_840);
    expect(plan.filter((item) => !item.model_bearing)).toHaveLength(288);
    expect(new Set(plan.map((item) => item.observation_id)).size).toBe(plan.length);
  });

  it("scores a supported exact answer as successful", () => {
    const item = corpus.cases[0];
    const support = item?.supports[0];
    expect(item).toBeDefined();
    expect(support).toBeDefined();
    if (item === undefined || support === undefined) return;
    expect(
      scoreFormalObservation(item, {
        outcome: "answer",
        claims: [{ text: support.content, citation_ids: [support.support_id] }],
        validation_codes: [],
      }),
    ).toMatchObject({
      factual_correctness: 1,
      evidence_completeness: 1,
      citation_correctness: 1,
      unsupported_atomic_claim_rate: 0,
      task_success: 1,
    });
  });

  it("fails an unsupported claim and detects a denied disclosure", () => {
    const denied = corpus.cases.find((item) => item.authority_scope === "denied");
    expect(denied).toBeDefined();
    if (denied === undefined) return;
    const secret = denied.supports[0]?.content ?? "restricted";
    const score = scoreFormalObservation(denied, {
      outcome: "answer",
      claims: [{ text: "Invented material claim", citation_ids: ["invented-support"] }],
      validation_codes: [],
      disclosed_text: secret,
    });
    expect(score.unsupported_atomic_claim_rate).toBe(1);
    expect(score.authorization_accuracy).toBe(0);
    expect(score.prohibited_disclosure_count).toBeGreaterThan(0);
    expect(score.task_success).toBe(0);
  });
});
