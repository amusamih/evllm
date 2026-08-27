import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  complementarySynthesisObservationSchema,
  JsonlObservationStore,
  prepareEvaluationRunDirectory,
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
    expect(resumed.get("formal-001:governed-evllm:1")).toMatchObject({
      attempts: 1,
      transport_attempts: 1,
    });
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

  it("rejects retired V1 observations instead of silently resuming them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evllm-eval-v1-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "observations.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ ...record(), schema: "EVLLM_LIVE_EVALUATION_OBSERVATION_V1" })}\n`,
      "utf8",
    );
    await expect(new JsonlObservationStore(path).initialize()).rejects.toThrow(
      "Invalid observation JSONL",
    );
  });

  it("rejects a released candidate that differs from the scored top-level response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evllm-eval-released-"));
    temporaryDirectories.push(directory);
    const store = new JsonlObservationStore(join(directory, "observations.jsonl"));
    await store.initialize();
    await expect(
      store.append({
        ...record(),
        released_candidate: { ...record().released_candidate, summary: "Different response" },
      }),
    ).rejects.toThrow();
  });

  it("persists typed decision codes identically in raw, released and top-level fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evllm-eval-decision-"));
    temporaryDirectories.push(directory);
    const store = new JsonlObservationStore(join(directory, "observations.jsonl"));
    await store.initialize();
    const typed = {
      ...record(),
      decision_code: "eligible-for-resale",
      raw_model_candidate: {
        ...record().raw_model_candidate!,
        decision_code: "eligible-for-resale",
      },
      released_candidate: {
        ...record().released_candidate,
        decision_code: "eligible-for-resale",
      },
    } satisfies StoredObservation;
    await store.append(typed);
    expect(store.get(typed.observation_id)).toMatchObject({
      decision_code: "eligible-for-resale",
      raw_model_candidate: { decision_code: "eligible-for-resale" },
      released_candidate: { decision_code: "eligible-for-resale" },
    });
    await expect(
      store.append({
        ...typed,
        observation_id: "formal-002:governed-evllm:1",
        released_candidate: { ...typed.released_candidate, decision_code: null },
      }),
    ).rejects.toThrow();
  });

  it("strictly parses complementary provenance and reconciles model transport", () => {
    const candidate = { ...record().released_candidate, decision_code: null };
    const base = {
      schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_OBSERVATION_V2",
      observation_id: "synthesis-001:governed-evllm-synthesis:1",
      evaluation_set_id: "evaluation-set",
      source_commit: "a".repeat(40),
      freeze_sha256: `0x${"1".repeat(64)}`,
      corpus_file_sha256: `0x${"2".repeat(64)}`,
      logical_corpus_sha256: `0x${"3".repeat(64)}`,
      case_id: "synthesis-001",
      stratum: "complete",
      repetition: 1,
      started_at: "2026-08-27T00:00:00.000Z",
      completed_at: "2026-08-27T00:00:01.000Z",
      duration_ms: 1_000,
      attempts: 2,
      transport_attempts: 2,
      model_invoked: true,
      provider: "openai",
      model: "gpt-4o-mini-2024-07-18",
      response_id: "resp_test",
      input_tokens: 10,
      output_tokens: 5,
      raw_model_candidate: candidate,
      released_candidate: candidate,
      raw_validation_codes: [],
      presented_support_ids: ["support-1"],
      model_input_sha256: `0x${"4".repeat(64)}`,
      outcome: candidate.outcome,
      decision_code: candidate.decision_code,
      summary: candidate.summary,
      warnings: candidate.warnings,
      missing_requirements: candidate.missing_requirements,
      evidence_reason_codes: candidate.evidence_reason_codes,
      validation_status: "passed",
      validation_codes: [],
      claims: candidate.claims,
    } as const;
    expect(complementarySynthesisObservationSchema.parse(base).model_invoked).toBe(true);
    expect(
      complementarySynthesisObservationSchema.safeParse({ ...base, transport_attempts: 1 }).success,
    ).toBe(false);
    expect(
      complementarySynthesisObservationSchema.safeParse({ ...base, unexpected: true }).success,
    ).toBe(false);
  });

  it("requires an empty final directory or an explicit exact-manifest resume", async () => {
    const directory = await mkdtemp(join(tmpdir(), "evllm-final-run-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "evaluation-config-manifest.json");
    const expectedManifest = {
      source_commit: "a".repeat(40),
      freeze_sha256: `0x${"1".repeat(64)}`,
      plan_sha256: `0x${"2".repeat(64)}`,
    };
    const options = {
      directory,
      manifestPath,
      expectedManifest,
      finalRun: true,
      resume: false,
      allowedResumeEntries: ["evaluation-config-manifest.json", "observations.jsonl"],
    } as const;
    await expect(prepareEvaluationRunDirectory(options)).resolves.toBe("fresh");
    await expect(prepareEvaluationRunDirectory(options)).rejects.toThrow("not empty");
    await expect(prepareEvaluationRunDirectory({ ...options, resume: true })).resolves.toBe(
      "resume",
    );
    await expect(
      prepareEvaluationRunDirectory({
        ...options,
        expectedManifest: { ...expectedManifest, source_commit: "b".repeat(40) },
        resume: true,
      }),
    ).rejects.toThrow("differs");
    await writeFile(join(directory, "unexpected.tmp"), "stale", "utf8");
    await expect(prepareEvaluationRunDirectory({ ...options, resume: true })).rejects.toThrow(
      "unexpected files",
    );
  });
});

function record(): StoredObservation {
  return {
    schema: "EVLLM_LIVE_EVALUATION_OBSERVATION_V2",
    observation_id: "formal-001:governed-evllm:1",
    formal_evidence: false,
    evaluation_set_id: "development-primary-test",
    source_commit: "a".repeat(40),
    freeze_sha256: `0x${"1".repeat(64)}`,
    corpus_file_sha256: `0x${"2".repeat(64)}`,
    logical_corpus_sha256: `0x${"3".repeat(64)}`,
    case_id: "formal-001",
    configuration_id: "governed-evllm",
    repetition: 1,
    started_at: "2026-08-12T00:00:00.000Z",
    completed_at: "2026-08-12T00:00:01.000Z",
    duration_ms: 1_000,
    attempts: 1,
    transport_attempts: 1,
    model_invoked: true,
    provider: "openai",
    model: "gpt-4o-mini-2024-07-18",
    response_id: "resp_test",
    input_tokens: 10,
    output_tokens: 5,
    model_input_sha256: `0x${"4".repeat(64)}`,
    raw_model_candidate: {
      outcome: "answer",
      decision_code: null,
      summary: "Supported answer",
      warnings: [],
      missing_requirements: [],
      evidence_reason_codes: [],
      claims: [{ claim_id: "claim-1", text: "Supported fact", citation_ids: ["support-1"] }],
    },
    released_candidate: {
      outcome: "answer",
      decision_code: null,
      summary: "Supported answer",
      warnings: [],
      missing_requirements: [],
      evidence_reason_codes: [],
      claims: [{ claim_id: "claim-1", text: "Supported fact", citation_ids: ["support-1"] }],
    },
    raw_validation_codes: [],
    presented_support_ids: ["support-1"],
    outcome: "answer",
    decision_code: null,
    summary: "Supported answer",
    warnings: [],
    missing_requirements: [],
    evidence_reason_codes: [],
    validation_codes: [],
    claims: [{ claim_id: "claim-1", text: "Supported fact", citation_ids: ["support-1"] }],
    score: {
      required_record_coverage: 1,
      citation_validity: 1,
      unsupported_claim_rate: 0,
      released_response_validation_failure_event: 0,
      appropriate_outcome: 1,
      decision_correct: 1,
      authorization_accuracy: null,
      prohibited_disclosure_count: 0,
      task_success: 1,
      covered_required_record_count: 1,
      required_record_count: 1,
      valid_citation_count: 1,
      citation_count: 1,
    },
  };
}
