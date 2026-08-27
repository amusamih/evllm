import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import OpenAI from "openai";
import { afterEach, describe, expect, it } from "vitest";

import { ScriptedAssistantModel, type ModelInput } from "../../src/assistant/model.js";
import { withBoundedTransportRetries } from "../../src/evaluation/live.js";
import {
  isTransientTransportError,
  JournaledAssistantModel,
  TransportAttemptJournal,
} from "../../src/evaluation/transport-attempt-journal.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("transport-attempt journal", () => {
  it("recognizes SDK connection failures and nested network causes as retryable", () => {
    const reset = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
    const connection = new OpenAI.APIConnectionError({ cause: reset });
    const timeout = new OpenAI.APIConnectionTimeoutError();

    expect(isTransientTransportError(connection)).toBe(true);
    expect(isTransientTransportError(timeout)).toBe(true);
    expect(
      isTransientTransportError({
        name: "APIConnectionError",
        cause: { cause: { code: "EAI_AGAIN" } },
      }),
    ).toBe(true);
    expect(isTransientTransportError({ name: "APIConnectionTimeoutError" })).toBe(true);
    expect(isTransientTransportError(Object.assign(new Error("invalid"), { status: 400 }))).toBe(
      false,
    );
  });

  it("journals an SDK connection failure before the explicit outer retry succeeds", async () => {
    const { journal } = await newJournal();
    let calls = 0;
    const provider = {
      generate: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(
            new OpenAI.APIConnectionError({
              cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
            }),
          );
        }
        return Promise.resolve({
          candidate: {
            outcome: "answer" as const,
            decision_code: null,
            summary: "Supported",
            warnings: [],
            missing_requirements: [],
            evidence_reason_codes: [],
            claims: [],
          },
          model: "test-model",
          provider: "openai",
          responseId: "response-1",
          inputTokens: 1,
          outputTokens: 1,
        });
      },
    };
    const model = new JournaledAssistantModel(provider, journal, identity());

    const result = await withBoundedTransportRetries(
      () => model.generate(modelInput()),
      () => Promise.resolve(),
    );

    expect(result.attempts).toBe(2);
    expect(journal.summary()).toMatchObject({
      transport_attempts: 2,
      retry_attempts: 1,
      failed_attempts: 1,
      successful_invocations: 1,
    });
    expect(journal.events().find((event) => event.event_type === "failed")).toMatchObject({
      transient: true,
      error_category: "connection-reset",
    });
  });

  it("retains exhausted failed attempts across resume without prompt content", async () => {
    const { journal, path } = await newJournal();
    let calls = 0;
    const provider = {
      generate: () => {
        calls += 1;
        const error = new Error(`secret provider message ${String(calls)}`) as Error & {
          status: number;
        };
        error.status = 429;
        return Promise.reject(error);
      },
    };
    const model = new JournaledAssistantModel(provider, journal, identity());
    await expect(
      withBoundedTransportRetries(
        () => model.generate(modelInput()),
        () => Promise.resolve(),
      ),
    ).rejects.toThrow("secret provider message");

    const resumed = new TransportAttemptJournal(path, binding());
    await resumed.initialize();
    expect(resumed.summary()).toMatchObject({
      transport_attempts: 3,
      retry_attempts: 2,
      successful_invocations: 0,
      failed_attempts: 3,
      open_attempts: 0,
    });
    expect(() => resumed.assertCanResumeObservation(identity().observation_id)).toThrow(
      "budget is exhausted",
    );
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("secret provider message");
    expect(text).not.toContain("secret question");
    expect(text.trim().split("\n")).toHaveLength(6);
  });

  it("turns an open attempt into a durable interruption and refuses final-safe resume", async () => {
    const { journal, path } = await newJournal();
    await journal.beginAttempt(identity(), modelInput(), crypto.randomUUID(), 1);

    const resumed = new TransportAttemptJournal(path, binding());
    await resumed.initialize();
    expect(await resumed.markOpenAttemptsInterrupted()).toBe(1);
    expect(resumed.summary()).toMatchObject({
      transport_attempts: 1,
      interrupted_attempts: 1,
      open_attempts: 0,
    });
    expect(() => resumed.assertCanResumeObservation(identity().observation_id)).toThrow(
      "unknown outcome",
    );
  });

  it("reconciles successful response, token, input-digest, and support provenance", async () => {
    const { journal } = await newJournal();
    const provider = new ScriptedAssistantModel(() => ({
      outcome: "answer",
      decision_code: null,
      summary: "Supported",
      warnings: [],
      missing_requirements: [],
      evidence_reason_codes: [],
      claims: [{ claim_id: "claim-1", text: "Supported", citation_ids: ["support-1"] }],
    }));
    const model = new JournaledAssistantModel(provider, journal, identity());
    const result = await model.generate(modelInput());
    const start = journal.events().find((event) => event.event_type === "started")!;
    if (start.event_type !== "started") throw new Error("Missing start");
    journal.assertReconciled([
      {
        observation_id: identity().observation_id,
        model_invoked: true,
        transport_attempts: 1,
        response_id: result.responseId,
        provider: result.provider,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        model_input_sha256: start.model_input_sha256,
        presented_support_ids: ["support-1"],
      },
    ]);
    expect(journal.summary()).toMatchObject({
      successful_invocations: 1,
      transport_attempts: 1,
      retry_attempts: 0,
    });
  });

  it("strictly rejects tampering with a persisted event", async () => {
    const { journal, path } = await newJournal();
    await journal.beginAttempt(identity(), modelInput(), crypto.randomUUID(), 1);
    const [line] = (await readFile(path, "utf8")).trim().split("\n");
    const event = JSON.parse(line!) as Record<string, unknown>;
    event.model = "tampered-model";
    await writeFile(path, `${JSON.stringify(event)}\n`, "utf8");
    await expect(new TransportAttemptJournal(path, binding()).initialize()).rejects.toThrow(
      "Invalid transport-attempt event digest",
    );
  });
});

async function newJournal(): Promise<{ journal: TransportAttemptJournal; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "evllm-attempt-journal-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "transport-attempts.jsonl");
  const journal = new TransportAttemptJournal(path, binding());
  await journal.initialize();
  return { journal, path };
}

function binding() {
  return {
    evaluation_set_id: "evaluation-set",
    source_commit: "a".repeat(40),
    freeze_sha256: `0x${"1".repeat(64)}`,
    corpus_file_sha256: `0x${"2".repeat(64)}`,
    logical_corpus_sha256: `0x${"3".repeat(64)}`,
  };
}

function identity() {
  return {
    observation_id: "case-1:governed-evllm:1",
    case_id: "case-1",
    configuration_id: "governed-evllm",
    repetition: 1,
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
  };
}

function modelInput(): ModelInput {
  return {
    question: "secret question",
    purposeId: "urn:evllm:policy:00000000-0000-4000-8000-000000000001",
    asOf: 200,
    session: {
      sessionId: "urn:evllm:session:00000000-0000-4000-8000-000000000001",
      actorId: "urn:evllm:actor:00000000-0000-4000-8000-000000000001",
      organizationId: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
      credentialId: "urn:evllm:credential:00000000-0000-4000-8000-000000000001",
      address: "0x1111111111111111111111111111111111111111",
      issuedAt: 100,
      expiresAt: 300,
    },
    supports: [
      {
        support_id: "support-1",
        resource_id: "urn:evllm:resource:00000000-0000-4000-8000-000000000001",
        resource_version: 1,
        issuer_organization_id: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
        custodian_organization_id: "urn:evllm:org:00000000-0000-4000-8000-000000000001",
        as_of: 200,
        status: "active",
        commitment: `0x${"4".repeat(64)}`,
        chain_reference: null,
        content: "secret support content",
      },
    ],
  };
}
