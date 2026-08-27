import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import {
  assertOpenAIAssistantConfig,
  createOpenAIAssistantClient,
  OPENAI_ASSISTANT_CONFIG,
  OPENAI_ASSISTANT_MAX_OUTPUT_TOKENS,
  OPENAI_ASSISTANT_MODEL,
  OPENAI_ASSISTANT_PROVIDER_MAX_RETRIES,
  OPENAI_ASSISTANT_STORE,
  OPENAI_ASSISTANT_TEMPERATURE,
  OpenAIAssistantModel,
} from "../../src/assistant/model.js";
import { recordedDecisionSupportCommitment } from "../../src/assistant/support-commitment.js";
import { assistantCandidate, assistantModelOutputCandidate } from "../../src/assistant/types.js";

describe("OpenAI assistant runtime configuration", () => {
  it("disables provider SDK retries so evaluation retry attempts remain externally journaled", () => {
    const client = createOpenAIAssistantClient("unused-test-key");

    expect(OPENAI_ASSISTANT_PROVIDER_MAX_RETRIES).toBe(0);
    expect(OPENAI_ASSISTANT_CONFIG.providerMaxRetries).toBe(0);
    expect(client.maxRetries).toBe(0);
  });

  it("passes the exported effective configuration to the production Responses call", async () => {
    let request: unknown;
    const client = {
      responses: {
        parse: vi.fn((value: unknown) => {
          request = value;
          return Promise.resolve({
            id: "response-test",
            output_parsed: {
              outcome: "abstain",
              decision_code: null,
              summary: "No support was supplied.",
              evidence_reason_codes: ["missing-evidence"],
              warnings: [],
              missing_requirements: ["support"],
              claims: [],
            },
            usage: { input_tokens: 10, output_tokens: 5 },
          });
        }),
      },
    } as unknown as OpenAI;
    const model = new OpenAIAssistantModel("unused-test-key", OPENAI_ASSISTANT_MODEL, client);

    const result = await model.generate({
      question: "What evidence is available?",
      purposeId: "urn:evllm:policy:00000000-0000-4000-8000-000000000001",
      asOf: 100,
      session: {
        sessionId: "urn:evllm:session:00000000-0000-4000-8000-000000000001",
        actorId: "urn:evllm:actor:00000000-0000-4000-8000-000000000001",
        organizationId: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
        credentialId: "urn:evllm:credential:00000000-0000-4000-8000-000000000001",
        address: "0x1111111111111111111111111111111111111111",
        issuedAt: 1,
        expiresAt: 200,
      },
      supports: [],
    });

    expect(model.effectiveConfig).toEqual(OPENAI_ASSISTANT_CONFIG);
    expect(request).toMatchObject({
      model: OPENAI_ASSISTANT_MODEL,
      temperature: OPENAI_ASSISTANT_TEMPERATURE,
      max_output_tokens: OPENAI_ASSISTANT_MAX_OUTPUT_TOKENS,
      store: OPENAI_ASSISTANT_STORE,
    });
    expect(result.model).toBe(OPENAI_ASSISTANT_MODEL);
  });

  it("rejects a freeze that differs from the effective runtime configuration", () => {
    expect(() =>
      assertOpenAIAssistantConfig(
        { ...OPENAI_ASSISTANT_CONFIG, maxOutputTokens: 1_201 },
        OPENAI_ASSISTANT_CONFIG,
        "Test freeze",
      ),
    ).toThrow("Test freeze maxOutputTokens differs from the effective runtime configuration");
  });

  it("accepts structurally valid model output for later semantic governance checks", async () => {
    const rawCandidate = {
      outcome: "answer" as const,
      decision_code: "battery-passport-requirement",
      summary: "The cited record describes the applicable regulatory clause.",
      evidence_reason_codes: [],
      warnings: [],
      missing_requirements: [],
      claims: [
        {
          claim_id: "claim-1",
          text: "The cited record describes the applicable regulatory clause.",
          citation_ids: ["support-1"],
        },
      ],
    };
    let request: unknown;
    const client = {
      responses: {
        parse: vi.fn((value: unknown) => {
          request = value;
          const format = (
            value as {
              text: { format: { $parseRaw(content: string): unknown } };
            }
          ).text.format;
          return Promise.resolve({
            id: "response-structural-candidate",
            output_parsed: format.$parseRaw(JSON.stringify(rawCandidate)),
            usage: { input_tokens: 12, output_tokens: 7 },
          });
        }),
      },
    } as unknown as OpenAI;
    const model = new OpenAIAssistantModel("unused-test-key", OPENAI_ASSISTANT_MODEL, client);

    const result = await model.generate({
      question: "Does the cited clause apply?",
      purposeId: "urn:evllm:policy:00000000-0000-4000-8000-000000000001",
      asOf: 100,
      session: {
        sessionId: "urn:evllm:session:00000000-0000-4000-8000-000000000001",
        actorId: "urn:evllm:actor:00000000-0000-4000-8000-000000000001",
        organizationId: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
        credentialId: "urn:evllm:credential:00000000-0000-4000-8000-000000000001",
        address: "0x1111111111111111111111111111111111111111",
        issuedAt: 1,
        expiresAt: 200,
      },
      supports: [],
    });

    expect(request).toBeDefined();
    expect(assistantModelOutputCandidate.safeParse(rawCandidate).success).toBe(true);
    expect(assistantCandidate.safeParse(rawCandidate).success).toBe(false);
    expect(result.candidate).toEqual(rawCandidate);
  });

  it("includes typed recorded decisions in the model support payload", async () => {
    let request: unknown;
    const client = {
      responses: {
        parse: vi.fn((value: unknown) => {
          request = value;
          return Promise.resolve({
            id: "response-decision-test",
            output_parsed: {
              outcome: "answer",
              decision_code: "eligible-for-resale",
              summary: "Battery B-101 is eligible for resale.",
              evidence_reason_codes: [],
              warnings: [],
              missing_requirements: [],
              claims: [
                {
                  claim_id: "claim-1",
                  text: "Battery B-101 has active status.",
                  citation_ids: ["support-1"],
                },
              ],
            },
            usage: { input_tokens: 20, output_tokens: 8 },
          });
        }),
      },
    } as unknown as OpenAI;
    const model = new OpenAIAssistantModel("unused-test-key", OPENAI_ASSISTANT_MODEL, client);

    const typedSupport = {
      support_id: "support-1",
      resource_id: "urn:evllm:evidence:00000000-0000-4000-8000-000000000001",
      resource_version: 1,
      issuer_organization_id: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
      custodian_organization_id: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
      as_of: 100,
      status: "active" as const,
      chain_reference: null,
      content: "Battery B-101 has active status.",
      recorded_decision: {
        outcome: "answer" as const,
        code: "eligible-for-resale",
        reason_codes: [],
      },
    };

    await model.generate({
      question: "What is the recorded decision?",
      purposeId: "urn:evllm:policy:00000000-0000-4000-8000-000000000001",
      asOf: 100,
      session: {
        sessionId: "urn:evllm:session:00000000-0000-4000-8000-000000000001",
        actorId: "urn:evllm:actor:00000000-0000-4000-8000-000000000001",
        organizationId: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
        credentialId: "urn:evllm:credential:00000000-0000-4000-8000-000000000001",
        address: "0x1111111111111111111111111111111111111111",
        issuedAt: 1,
        expiresAt: 200,
      },
      supports: [{ ...typedSupport, commitment: recordedDecisionSupportCommitment(typedSupport) }],
    });

    const payload = JSON.parse((request as { input: string }).input) as unknown;
    expect(payload).toMatchObject({
      support: [
        {
          support_id: "support-1",
          recorded_decision: {
            outcome: "answer",
            code: "eligible-for-resale",
            reason_codes: [],
          },
        },
      ],
    });
    const instructions = (request as { instructions: string }).instructions;
    expect(instructions).toContain(
      "copy its outcome, decision_code, and evidence_reason_codes only into the corresponding structured fields for diagnostic comparison",
    );
    expect(instructions).toContain(
      "Do not restate its decision or code in summary, claims, warnings, or missing_requirements",
    );
    expect(instructions).toContain("provide only source-linked explanatory facts");
    expect(instructions).toContain("must cite the record for every subject being compared");
  });
});
