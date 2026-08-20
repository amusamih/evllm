import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import {
  AssistantAuditLedger,
  AssistantRequestStore,
  AssistantToolRegistry,
  GovernedAssistantService,
  ScriptedAssistantModel,
  WalletSessionManager,
  encodeAssistantQuery,
  type AssistantTool,
} from "../../src/assistant/index.js";

describe("assistant HTTP boundary", () => {
  it("authenticates a wallet-bound session and returns a no-store structured answer", async () => {
    const fixture = createFixture();
    const token = await authenticate(fixture.app, 1);
    const result = await request(fixture.app)
      .get("/api/v1/query/assistant")
      .set("authorization", `Bearer ${token}`)
      .query({ request: encodeAssistantQuery(query()) })
      .expect("cache-control", "no-store")
      .expect(200);
    const answer = answerEnvelope.parse(result.body as unknown).result;
    expect(answer).toMatchObject({
      schema: "EVLLM_ASSISTANT_RESPONSE_V1",
      outcome: "answer",
      validation: { status: "passed" },
    });
    const audit = await request(fixture.app)
      .get("/api/v1/query/audit")
      .set("authorization", `Bearer ${token}`)
      .query({ request_id: answer.request_id })
      .expect(200);
    expect(auditEnvelope.parse(audit.body as unknown).result).toHaveLength(1);
    expect(JSON.stringify(audit.body as unknown)).not.toContain(query().question);
  });

  it("rejects unauthenticated queries, challenge replay, and logged-out sessions", async () => {
    const fixture = createFixture();
    await request(fixture.app)
      .get("/api/v1/query/assistant")
      .query({ request: encodeAssistantQuery(query()) })
      .expect(403);
    const challenge = await challengeFor(fixture.app, 1);
    const verified = await request(fixture.app)
      .post("/api/v1/auth")
      .send({ action: "verify", challenge_id: challenge.challenge_id, signature: "valid" })
      .expect(200);
    await request(fixture.app)
      .post("/api/v1/auth")
      .send({ action: "verify", challenge_id: challenge.challenge_id, signature: "valid" })
      .expect(403);
    const token = tokenEnvelope.parse(verified.body as unknown).result.token;
    await request(fixture.app)
      .post("/api/v1/auth")
      .set("authorization", `Bearer ${token}`)
      .send({ action: "logout" })
      .expect(200);
    await request(fixture.app)
      .get("/api/v1/query/assistant")
      .set("authorization", `Bearer ${token}`)
      .query({ request: encodeAssistantQuery(query()) })
      .expect(403);
  });

  it("does not expose one actor's audit record to a concurrent different actor", async () => {
    const fixture = createFixture();
    const [first, second] = await Promise.all([
      authenticate(fixture.app, 1),
      authenticate(fixture.app, 2),
    ]);
    const answered = await request(fixture.app)
      .get("/api/v1/query/assistant")
      .set("authorization", `Bearer ${first}`)
      .query({ request: encodeAssistantQuery(query()) })
      .expect(200);
    const answer = answerEnvelope.parse(answered.body as unknown).result;
    const hidden = await request(fixture.app)
      .get("/api/v1/query/audit")
      .set("authorization", `Bearer ${second}`)
      .query({ request_id: answer.request_id })
      .expect(200);
    expect(auditEnvelope.parse(hidden.body as unknown).result).toEqual([]);
  });

  it("returns the retained response after response loss and rejects conflicting key reuse", async () => {
    const fixture = createFixture();
    const token = await authenticate(fixture.app, 1);
    const idempotent = {
      ...query(),
      idempotency_key: "00000000-0000-4000-8000-000000000778",
    };
    const first = await request(fixture.app)
      .get("/api/v1/query/assistant")
      .set("authorization", `Bearer ${token}`)
      .query({ request: encodeAssistantQuery(idempotent) })
      .expect(200);
    const replay = await request(fixture.app)
      .get("/api/v1/query/assistant")
      .set("authorization", `Bearer ${token}`)
      .query({ request: encodeAssistantQuery(idempotent) })
      .expect(200);
    const firstAnswer = answerEnvelope.parse(first.body as unknown).result;
    expect(answerEnvelope.parse(replay.body as unknown).result).toEqual(firstAnswer);

    const audit = await request(fixture.app)
      .get("/api/v1/query/audit")
      .set("authorization", `Bearer ${token}`)
      .query({ request_id: firstAnswer.request_id })
      .expect(200);
    expect(auditEnvelope.parse(audit.body as unknown).result).toHaveLength(1);

    await request(fixture.app)
      .get("/api/v1/query/assistant")
      .set("authorization", `Bearer ${token}`)
      .query({
        request: encodeAssistantQuery({
          ...idempotent,
          question: "A different question with the same key.",
        }),
      })
      .expect(409);
  });
});

function createFixture() {
  const audit = new AssistantAuditLedger();
  const tool: AssistantTool = {
    name: "facts",
    execute: (context) =>
      Promise.resolve([
        {
          support_id: "support-http-1",
          resource_id: urn("evidence", 1),
          resource_version: 1,
          issuer_organization_id: urn("org", 3),
          custodian_organization_id: urn("org", 3),
          as_of: context.asOf,
          status: "active",
          commitment: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          chain_reference: "0xabc:1",
          content: "The recorded battery state is active.",
        },
      ]),
  };
  const sessions = new WalletSessionManager(
    (_challenge, signature) => Promise.resolve(signature === "valid"),
    () => Promise.resolve(true),
    () => 100,
  );
  const service = new GovernedAssistantService(
    new AssistantToolRegistry([tool], () => Promise.resolve(true)),
    new ScriptedAssistantModel(() => ({
      outcome: "answer",
      summary: "The battery state is active.",
      evidence_reason_codes: [],
      claims: [
        {
          claim_id: "claim-1",
          text: "The battery state is active.",
          citation_ids: ["support-http-1"],
        },
      ],
      warnings: [],
      missing_requirements: [],
    })),
    audit,
    new AssistantRequestStore(),
    () => 100,
  );
  return { app: createApp({ appEnvironment: "test", assistant: { sessions, service, audit } }) };
}

async function authenticate(app: ReturnType<typeof createApp>, value: number): Promise<string> {
  const challenge = await challengeFor(app, value);
  const response = await request(app)
    .post("/api/v1/auth")
    .send({ action: "verify", challenge_id: challenge.challenge_id, signature: "valid" })
    .expect(200);
  return tokenEnvelope.parse(response.body as unknown).result.token;
}

async function challengeFor(app: ReturnType<typeof createApp>, value: number) {
  const response = await request(app)
    .post("/api/v1/auth")
    .send({
      action: "challenge",
      identity: {
        actorId: urn("actor", value),
        organizationId: urn("org", value),
        credentialId: urn("credential", value),
        address: `0x${value.toString().repeat(40)}`,
      },
    })
    .expect(200);
  return challengeEnvelope.parse(response.body as unknown).result;
}

function query() {
  return {
    question: "What is the battery state?",
    purpose_id: urn("policy", 5),
    as_of: 100,
    requests: [{ tool: "facts" as const, arguments: { battery_id: urn("battery", 6) } }],
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

const answerEnvelope = z.object({
  result: z.object({
    schema: z.literal("EVLLM_ASSISTANT_RESPONSE_V1"),
    request_id: z.string(),
    outcome: z.string(),
    validation: z.object({ status: z.string() }),
  }),
});
const auditEnvelope = z.object({ result: z.array(z.unknown()) });
const tokenEnvelope = z.object({ result: z.object({ token: z.string() }) });
const challengeEnvelope = z.object({
  result: z.object({
    challenge_id: z.string(),
    message: z.string(),
    expires_at: z.number(),
  }),
});
