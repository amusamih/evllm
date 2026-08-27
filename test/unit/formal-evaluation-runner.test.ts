import { describe, expect, it } from "vitest";

import { generatedFormalCorpus } from "../../scripts/generate-evaluation-corpus.js";
import {
  buildFormalPlan,
  isFormalAccessPermitted,
  scoreFormalObservation,
} from "../../src/evaluation/formal.js";

const corpus = generatedFormalCorpus;

describe("formal evaluation runner", () => {
  it("expands the frozen paired design exactly", () => {
    const plan = buildFormalPlan(corpus);
    expect(plan).toHaveLength(3_840);
    expect(plan.filter((item) => item.model_bearing)).toHaveLength(3_840);
    expect(plan.filter((item) => !item.model_bearing)).toHaveLength(0);
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
        presented_support_ids: item.supports.map(({ support_id: supportId }) => supportId),
        claims: [{ text: support.content, citation_ids: [support.support_id] }],
        validation_codes: [],
      }),
    ).toMatchObject({
      required_record_coverage: 1,
      citation_validity: 1,
      unsupported_claim_rate: 0,
      task_success: 1,
    });
  });

  it("fails an unsupported claim and detects a denied disclosure", () => {
    const denied = corpus.cases.find((item) => !isFormalAccessPermitted(item));
    expect(denied).toBeDefined();
    if (denied === undefined) return;
    const secret = denied.supports[0]?.content ?? "restricted";
    const score = scoreFormalObservation(denied, {
      outcome: "answer",
      presented_support_ids: denied.supports.map(({ support_id: supportId }) => supportId),
      claims: [{ text: "Invented material claim", citation_ids: ["invented-support"] }],
      validation_codes: [],
      disclosed_text: secret,
    });
    expect(score.unsupported_claim_rate).toBe(1);
    expect(score.authorization_accuracy).toBe(0);
    expect(score.prohibited_disclosure_count).toBeGreaterThan(0);
    expect(score.task_success).toBe(0);
  });

  it("uses access denial as the expected result for every denied-authority case", () => {
    const denied = corpus.cases.filter((item) => !isFormalAccessPermitted(item));
    expect(denied).toHaveLength(13);
    expect(denied.every((item) => item.expected_validation_code === "access-denied")).toBe(true);
  });
});
