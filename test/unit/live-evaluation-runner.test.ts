import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonlObservationStore,
  withBoundedTransportRetries,
  type StoredObservation,
} from "../../src/evaluation/live.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("live evaluation persistence", () => {
  it("durably resumes a unique completed observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evllm-eval-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "observations.jsonl");
    const store = new JsonlObservationStore(path);
    await store.initialize();
    await store.append(record());
    await expect(store.append(record())).rejects.toThrow("already stored");

    const resumed = new JsonlObservationStore(path);
    await resumed.initialize();
    expect(resumed.get("formal-001:governed-evllm:1")).toMatchObject({ attempts: 1 });
    expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  it("retries only bounded transient failures", async () => {
    let attempts = 0;
    const result = await withBoundedTransportRetries(
      () => {
        attempts += 1;
        if (attempts < 3) {
          const error = new Error("rate limited") as Error & { status: number };
          error.status = 429;
          return Promise.reject(error);
        }
        return Promise.resolve("ok");
      },
      () => Promise.resolve(),
    );
    expect(result).toEqual({ value: "ok", attempts: 3 });
    await expect(
      withBoundedTransportRetries(() => Promise.reject(new Error("valid response failure"))),
    ).rejects.toThrow("valid response failure");
  });
});

function record(): StoredObservation {
  return {
    schema: "EVLLM_LIVE_EVALUATION_OBSERVATION_V1",
    observation_id: "formal-001:governed-evllm:1",
    formal_evidence: false,
    source_commit: "a".repeat(40),
    case_id: "formal-001",
    configuration_id: "governed-evllm",
    repetition: 1,
    started_at: "2026-08-12T00:00:00.000Z",
    completed_at: "2026-08-12T00:00:01.000Z",
    duration_ms: 1_000,
    attempts: 1,
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
    response_id: "resp_test",
    input_tokens: 10,
    output_tokens: 5,
    outcome: "answer",
    summary: "Supported answer",
    warnings: [],
    missing_requirements: [],
    evidence_reason_codes: [],
    validation_codes: [],
    claims: [{ text: "Supported fact", citation_ids: ["support-1"] }],
    score: {
      factual_correctness: 1,
      evidence_completeness: 1,
      citation_correctness: 1,
      unsupported_atomic_claim_rate: 0,
      appropriate_outcome: 1,
      authorization_accuracy: null,
      prohibited_disclosure_count: 0,
      task_success: 1,
      supported_fact_count: 1,
      required_fact_count: 1,
      correct_citation_count: 1,
      citation_count: 1,
    },
  };
}
