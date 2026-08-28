import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Wallet } from "ethers";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import { assistantSupport, ScriptedAssistantModel } from "../../src/assistant/index.js";
import {
  CONTROLLED_ACTOR_ID,
  CONTROLLED_CREDENTIAL_ID,
  CONTROLLED_ORGANIZATION_ID,
  ControlledCaseCatalog,
} from "../../src/interface/cases.js";
import { createResearchRuntime } from "../../src/interface/runtime.js";
import {
  interfaceClient,
  recordedDecisionCodeMetadata,
  responseSourceMetadata,
} from "../../src/interface/page.js";

describe("research web interface", () => {
  const controlledWallet = Wallet.createRandom();
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
      decision_code: null,
      summary:
        outcomeCode === undefined ? "supported" : `The exact decision code is ${outcomeCode}.`,
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
    controlledWalletAddress: controlledWallet.address,
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

  it("accepts the controlled credential only from its configured wallet", async () => {
    const wrongWallet = Wallet.createRandom();
    const rejectedChallenge = await walletChallenge(wrongWallet.address);
    await request(app)
      .post("/api/v1/auth")
      .send({
        action: "verify",
        challenge_id: rejectedChallenge.challenge_id,
        signature: await wrongWallet.signMessage(rejectedChallenge.message),
      })
      .expect(403);

    const acceptedChallenge = await walletChallenge(controlledWallet.address);
    await request(app)
      .post("/api/v1/auth")
      .send({
        action: "verify",
        challenge_id: acceptedChallenge.challenge_id,
        signature: await controlledWallet.signMessage(acceptedChallenge.message),
      })
      .expect(200);
  });

  it("executes supported, missing and conflicting cases through the governed assistant", async () => {
    const supported = await assistant("supported");
    expect(supported).toMatchObject({
      source: "retained-evaluation-input",
      caseId: "synthesis-101",
      response: {
        outcome: "answer",
        evidence_state: "active",
        validation: { status: "passed" },
      },
    });
    expect(supported.response.claims).toHaveLength(4);
    expect(supported.response.citations).toHaveLength(4);
    expect(JSON.stringify(supported.response.claims)).toContain("Battery ID 101");
    expect(JSON.stringify(supported.response.claims)).not.toContain("SYN-101");

    const missing = await assistant("missing");
    expect(missing.response).toMatchObject({
      outcome: "abstain",
      decision_code: "insufficient-evidence",
      evidence_state: "active",
      validation: { status: "passed", codes: [] },
    });

    const conflicting = await assistant("conflicting");
    expect(conflicting.response).toMatchObject({
      outcome: "requires_external_decision",
      decision_code: "external-decision-required",
      evidence_state: "active",
      validation: { status: "passed", codes: [] },
    });
  });

  it("selects decision mode only for decision questions about a known battery", async () => {
    expect(
      runtime.cases.resolve("Is Battery ID 101 ready to be listed for resale?", 1_776_033_600).query
        .mode,
    ).toBe("explain_recorded_decision");
    expect(
      runtime.cases.resolve("What state of health is recorded for Battery ID 101?", 1_776_033_600)
        .query.mode,
    ).toBe("explain_records");

    const factual = await ask("What state of health is recorded for Battery ID 101?");
    expect(factual.response).toMatchObject({
      outcome: "answer",
      decision_code: null,
      validation: { status: "passed", codes: [] },
    });
    expect(factual.response.claims).toHaveLength(3);
    expect(factual.response.citations).toHaveLength(3);
    const lastInput = modelReply.mock.calls.at(-1)?.[0];
    expect(lastInput?.supports).toHaveLength(3);
    expect(
      lastInput?.supports.some(({ recorded_decision }) => recorded_decision !== undefined),
    ).toBe(false);
  });

  it("never copies evaluation-only expected labels into retrieved support", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "evllm-interface-corpus-"));
    try {
      const source = JSON.parse(
        await readFile(path.resolve("evaluation/final/synthesis-corpus.json"), "utf8"),
      ) as { cases: Array<{ case_id: string; expected_conclusion?: string }> };
      const sentinel = "evaluation-only-label-must-not-enter-support";
      for (const item of source.cases) {
        if (item.case_id === "synthesis-101") item.expected_conclusion = sentinel;
      }
      const corpusPath = path.join(directory, "synthesis-corpus.json");
      await writeFile(corpusPath, JSON.stringify(source), "utf8");

      const catalog = ControlledCaseCatalog.load(corpusPath);
      const retrieved = [
        ...catalog.supports("synthesis-101", "facts"),
        ...catalog.supports("synthesis-101", "rules"),
      ];
      expect(retrieved).not.toHaveLength(0);
      expect(retrieved.map(({ content }) => content).join("\n")).not.toContain(sentinel);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("binds the interface decision metadata to its transformed support", () => {
    const decisionSupport = runtime.cases.supports("synthesis-101", "rules").at(-1)!;
    expect(assistantSupport.safeParse(decisionSupport).success).toBe(true);
    expect(
      assistantSupport.safeParse({
        ...decisionSupport,
        recorded_decision: {
          ...decisionSupport.recorded_decision!,
          code: "altered-after-commitment",
        },
      }).success,
    ).toBe(false);
  });

  it("explains the deterministic route record but does not generate an authority decision", async () => {
    const routeQuestion =
      "Which of the three second life routes is preferred for Battery ID 121, and why? Please cite each available record and clarify whether the system combines the assessment components into one sustainability score or keeps them separate.";
    const resolvedRoute = runtime.cases.resolve(routeQuestion, 1_776_033_600);
    expect(resolvedRoute.query.mode).toBe("explain_recorded_decision");
    expect(resolvedRoute.query.requests).toEqual([
      { tool: "assessment", arguments: { case_id: "synthesis-121" } },
    ]);

    const route = await ask(routeQuestion);
    expect(route).toMatchObject({
      caseId: "synthesis-121",
      response: {
        outcome: "answer",
        decision_code: "continued-compatible-ev-use-preferred",
        model: { model: "scripted-interface-test-model" },
      },
    });
    expect(route.response.citations).toHaveLength(5);
    expect(route.response.summary).toContain("continued-compatible-ev-use-preferred");

    const workflow = await ask(
      "Explain why the recorded marketplace workflow action is permitted for Battery ID 116.",
    );
    expect(workflow).toMatchObject({
      caseId: "synthesis-116",
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
      decision_code: null,
      validation: { status: "rejected", codes: ["external-decision-boundary"] },
      model: { model: "deterministic-precondition-engine-v1" },
    });
    expect(modelReply).toHaveBeenCalledTimes(callsAfterRoute);
  });

  it("renders a typed recorded decision code separately and omits a null code", () => {
    expect(
      recordedDecisionCodeMetadata({
        decision_code: "continued-compatible-ev-use-preferred",
      }),
    ).toEqual([["Recorded decision code", "continued-compatible-ev-use-preferred"]]);
    expect(recordedDecisionCodeMetadata({ decision_code: null })).toEqual([]);
    expect(
      responseSourceMetadata({
        decision_code: "continued-compatible-ev-use-preferred",
        claims: [{}, {}],
        model: { provider: "openai", model: "explanation-model" },
      }),
    ).toEqual([
      ["Decision source", "Checked deterministic record"],
      ["Explanation source", "explanation-model"],
    ]);
    expect(
      responseSourceMetadata({
        decision_code: null,
        claims: [],
        model: { provider: "evllm", model: "deterministic-precondition-engine-v1" },
      }),
    ).toEqual([["Decision source", "Deterministic rules"]]);
    expect(
      responseSourceMetadata({
        decision_code: "eligible-for-resale",
        claims: [{}],
        model: { provider: "openai", model: "explanation-model" },
      }),
    ).toEqual([
      ["Decision source", "Checked deterministic record"],
      ["Explanation source", "No model explanation retained"],
    ]);
    expect(interfaceClient).toContain("recordedDecisionCodeMetadata(response)");
    expect(interfaceClient).toContain("responseSourceMetadata(response)");
    expect(interfaceClient).toContain("Recorded decision code");
    expect(interfaceClient).toContain("Recorded decision with AI explanation");
    expect(interfaceClient).toContain("No model explanation was retained.");
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

  async function walletChallenge(address: string) {
    const response = await request(app)
      .post("/api/v1/auth")
      .send({
        action: "challenge",
        identity: {
          actorId: CONTROLLED_ACTOR_ID,
          organizationId: CONTROLLED_ORGANIZATION_ID,
          credentialId: CONTROLLED_CREDENTIAL_ID,
          address: address.toLowerCase(),
        },
      })
      .expect(200);
    return z
      .object({ result: z.object({ challenge_id: z.string(), message: z.string() }) })
      .parse(response.body as unknown).result;
  }
});

const assistantEnvelope = z.object({
  result: z.object({
    source: z.literal("retained-evaluation-input"),
    caseId: z.string().nullable(),
    response: z.object({
      outcome: z.enum(["answer", "abstain", "requires_external_decision"]),
      decision_code: z.string().nullable(),
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
