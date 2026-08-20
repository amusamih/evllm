import path from "node:path";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import { ScriptedAssistantModel } from "../../src/assistant/index.js";
import { createResearchRuntime } from "../../src/interface/runtime.js";

describe("research web interface", () => {
  const modelReply = vi.fn(({ supports }: Parameters<ScriptedAssistantModel["generate"]>[0]) => {
    const outcomeCode = supports
      .map(({ content }) =>
        content.match(
          /(?:recorded deterministic outcome code|exact decision code) is '([a-z0-9-]+)'/iu,
        ),
      )
      .find((match) => match?.[1] !== undefined)?.[1];
    return {
      outcome: "answer" as const,
      summary:
        outcomeCode === undefined
          ? "The permitted records support the recorded deterministic outcome."
          : `The permitted records support the recorded deterministic outcome ${outcomeCode}.`,
      evidence_reason_codes: [],
      claims: supports.map((support, index) => ({
        claim_id: `claim-${String(index + 1)}`,
        text: /\bC\s*=\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*100\b/u.test(support.content)
          ? `The C value is the circularity component. ${support.content}`
          : support.content,
        citation_ids: [support.support_id],
      })),
      warnings: [],
      missing_requirements: [],
    };
  });
  const runtime = createResearchRuntime({
    corpusPath: path.resolve("evaluation/final/synthesis-corpus.json"),
    modelName: "scripted-interface-test-model",
    modelProvider: new ScriptedAssistantModel(modelReply, "scripted-interface-test-model"),
    now: () => 1_776_033_600,
  });
  const app = createApp({
    appEnvironment: "test",
    rateLimit: false,
    assistant: { sessions: runtime.sessions, service: runtime.assistant, audit: runtime.audit },
    interface: { service: runtime.interfaceService },
  });

  it("serves the accessible interface and its separate assets", async () => {
    const page = await request(app).get("/").expect("content-type", /html/u).expect(200);
    expect(page.text).toContain("Second-Life Battery Decision Support");
    expect(page.text).toContain("Decision support");
    expect(page.text).toContain("Route assessment");
    expect(page.text).toContain("Workflow state");
    expect(page.text).toContain("Executed controlled cases");
    expect(page.text).toContain("Source-linked conversational response");
    expect(page.text).not.toContain("Controlled local scenario");
    expect(page.text).toContain('href="#workspace"');
    await request(app).get("/interface.css").expect("content-type", /css/u).expect(200);
    await request(app)
      .get("/interface.js")
      .expect("content-type", /javascript/u)
      .expect(200)
      .expect(/capture-mode/u);
  });

  it("executes supported, missing and conflicting cases through the governed assistant", async () => {
    const supported = await assistant("supported");
    expect(supported).toMatchObject({
      source: "retained-controlled-case",
      caseId: "synthesis-final-001",
      response: {
        outcome: "answer",
        evidence_state: "active",
        validation: { status: "passed" },
      },
    });
    expect(supported.response.claims).toHaveLength(4);
    expect(supported.response.citations).toHaveLength(4);
    expect(JSON.stringify(supported.response.claims)).toContain("Battery ID 101");
    expect(JSON.stringify(supported.response.claims)).not.toContain("FINAL-101");

    const callsAfterSupported = modelReply.mock.calls.length;
    const missing = await assistant("missing");
    expect(missing.response).toMatchObject({
      outcome: "abstain",
      evidence_state: "defective",
      validation: { status: "rejected", codes: ["missing-support"] },
    });
    expect(modelReply).toHaveBeenCalledTimes(callsAfterSupported);

    const conflicting = await assistant("conflicting");
    expect(conflicting.response).toMatchObject({
      outcome: "requires_external_decision",
      evidence_state: "defective",
      validation: { status: "rejected", codes: ["conflicting-support"] },
    });
    expect(modelReply).toHaveBeenCalledTimes(callsAfterSupported);
  });

  it("explains the deterministic route record but does not generate an authority decision", async () => {
    const route = await ask(
      "Which second life route is supported for Battery ID 121, and why? Please explain the six assessment components separately.",
    );
    expect(route).toMatchObject({
      caseId: "synthesis-final-021",
      response: { outcome: "answer", model: { model: "scripted-interface-test-model" } },
    });
    expect(route.response.citations).toHaveLength(5);
    expect(route.response.summary).toContain("continued-compatible-ev-use-preferred");

    const workflow = await ask(
      "Explain why the recorded marketplace workflow action is permitted for Battery ID 116.",
    );
    expect(workflow).toMatchObject({
      caseId: "synthesis-final-016",
      response: { outcome: "answer", model: { model: "scripted-interface-test-model" } },
    });
    expect(workflow.response.citations).toHaveLength(4);
    expect(workflow.response.summary).toContain("lifecycle-action-permitted");

    const callsAfterRoute = modelReply.mock.calls.length;
    const authority = await ask(
      "Based on its recorded inspection, can you legally certify this battery and approve it for sale?",
    );
    expect(authority.response).toMatchObject({
      outcome: "requires_external_decision",
      validation: { status: "rejected", codes: ["external-decision-boundary"] },
      model: { model: "deterministic-precondition-engine-v1" },
    });
    expect(modelReply).toHaveBeenCalledTimes(callsAfterRoute);
  });

  it("calculates all six route components and preserves safe non-answer outcomes", async () => {
    const nominal = await assessment("nominal");
    expect(nominal.result).toMatchObject({
      decisionState: "answer",
      preferredRoute: "continued-compatible-ev-use",
    });
    expect(nominal.result.routes).toHaveLength(3);
    expect(nominal.result.routes[0]).toMatchObject({
      G: "PASS",
      C: { value: "100" },
      A: { coverage: "1" },
      U: { rankStable: true },
    });
    expect(nominal.result.routes[0]).toHaveProperty("I");
    expect(nominal.result.routes[0]).toHaveProperty("E");
    expect(nominal.result).not.toHaveProperty("overallScore");

    expect((await assessment("missing")).result.decisionState).toBe("abstain");
    expect((await assessment("conflicting")).result.decisionState).toBe(
      "requires_external_decision",
    );
  });

  it("exposes only a controlled read-only workflow projection", async () => {
    const response = await request(app)
      .get("/api/v1/interface/status")
      .expect("cache-control", "no-store")
      .expect(200);
    expect(statusEnvelope.parse(response.body as unknown).result).toMatchObject({
      source: "controlled-local-scenario",
      battery: { id: "Battery ID 001" },
      protectedRecord: { state: "Confirmed" },
      marketplace: { state: "Awaiting buyer confirmation" },
    });
    await request(app)
      .post("/api/v1/interface/assistant")
      .send({ scenario: "invented" })
      .expect(400);
    await request(app).get("/api/v1/interface/assessment/invented").expect(400);
  });

  async function assistant(scenario: string) {
    const question =
      scenario === "supported"
        ? "Is Battery ID 101 ready to be listed for resale? Please cite the records used."
        : scenario === "missing"
          ? "Can Battery ID 106 be listed for resale? What information is still needed?"
          : "Can Battery ID 111 be listed when two current inspections disagree?";
    return ask(question);
  }

  async function ask(question: string) {
    const response = await request(app)
      .post("/api/v1/interface/assistant")
      .send({ question })
      .expect("cache-control", "no-store")
      .expect(200);
    return assistantEnvelope.parse(response.body as unknown).result;
  }

  async function assessment(scenario: string) {
    const response = await request(app)
      .get(`/api/v1/interface/assessment/${scenario}`)
      .expect("cache-control", "no-store")
      .expect(200);
    return assessmentEnvelope.parse(response.body as unknown).result;
  }
});

const assistantEnvelope = z.object({
  result: z.object({
    source: z.literal("retained-controlled-case"),
    caseId: z.string().nullable(),
    response: z.object({
      outcome: z.enum(["answer", "abstain", "requires_external_decision"]),
      summary: z.string(),
      evidence_state: z.enum(["active", "defective", "not-evaluated"]),
      validation: z.object({ status: z.enum(["passed", "rejected"]), codes: z.array(z.string()) }),
      claims: z.array(z.unknown()),
      citations: z.array(z.unknown()),
      model: z.object({
        provider: z.string(),
        model: z.string(),
        response_id: z.string().nullable(),
      }),
    }),
  }),
});

const assessmentEnvelope = z.object({
  result: z.object({
    result: z
      .object({
        decisionState: z.enum(["answer", "abstain", "requires_external_decision"]),
        preferredRoute: z.string().optional(),
        routes: z.array(
          z
            .object({
              G: z.enum(["PASS", "FAIL", "UNKNOWN"]),
              C: z.object({ value: z.string().optional() }).passthrough(),
              I: z.array(z.unknown()),
              E: z.unknown(),
              A: z.object({ coverage: z.string() }).passthrough(),
              U: z.object({ rankStable: z.boolean() }).passthrough(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  }),
});

const statusEnvelope = z.object({
  result: z.object({
    source: z.literal("controlled-local-scenario"),
    battery: z.object({ id: z.string() }).passthrough(),
    protectedRecord: z.object({ state: z.string() }).passthrough(),
    marketplace: z.object({ state: z.string() }).passthrough(),
  }),
});
