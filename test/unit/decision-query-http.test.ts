import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import {
  AssessmentLedger,
  DecisionQueryService,
  DatedRuleRegistry,
  type AssessmentResult,
} from "../../src/decision/index.js";
import { EvidenceLedger } from "../../src/evidence/index.js";

describe("exact decision queries", () => {
  it("keeps immutable assessment history and exposes only authorized typed queries", async () => {
    const assessments = new AssessmentLedger();
    assessments.issue(result(1, "a"), 100);
    assessments.issue(result(2, "b"), 101);
    const queries = new DecisionQueryService(
      new EvidenceLedger(),
      assessments,
      new DatedRuleRegistry(),
    );
    expect(queries.assessmentHistory(inputId).map(({ status }) => status)).toEqual([
      "superseded",
      "active",
    ]);
    expect(queries.assessmentCurrent(inputId).result.assessmentInputVersion).toBe(2);

    const app = createApp({
      appEnvironment: "test",
      decision: {
        authorize: (incoming) => incoming.header("authorization") === "Bearer assessor",
        queries,
        rules: new DatedRuleRegistry(),
      },
    });
    await request(app)
      .get("/api/v1/query/assessments")
      .query({ assessment_input_id: inputId })
      .expect(403);
    const response = await request(app)
      .get("/api/v1/query/assessments")
      .set("authorization", "Bearer assessor")
      .query({ assessment_input_id: inputId })
      .expect(200);
    const body = z
      .object({
        current: z.object({ result: z.object({ assessmentInputVersion: z.number() }) }),
        history: z.array(z.unknown()),
      })
      .parse(response.body);
    expect(body.current.result.assessmentInputVersion).toBe(2);
    expect(body.history).toHaveLength(2);
    await request(app)
      .get("/api/v1/query/rules")
      .set("authorization", "Bearer assessor")
      .query({ rule_id: urn("rule", 9), jurisdiction: "EU", subject_scope: "pack", as_of: 100 })
      .expect(404);
  });

  it("rejects duplicate immutable result digests", () => {
    const ledger = new AssessmentLedger();
    ledger.issue(result(1, "same"), 100);
    expect(() => ledger.issue(result(2, "same"), 101)).toThrow();
  });
});

const inputId = urn("assessment", 1);

function result(version: number, digestValue: string): AssessmentResult {
  return {
    schema: "EVLLM_DETERMINISTIC_ROUTE_ASSESSMENT_V1",
    assessmentInputId: inputId,
    assessmentInputVersion: version,
    decisionState: "abstain",
    reproductionHash: { alg: "SHA-256", value: digestValue.padEnd(43, "x") },
    dominance: [],
    routes: [],
    warnings: ["CONTROLLED_TEST_FIXTURE"],
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
