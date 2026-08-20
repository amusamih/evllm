import { describe, expect, it } from "vitest";

import {
  evaluationConfigManifest,
  evaluationRunManifest,
  fixtureManifest,
} from "../../src/schemas/evaluation.js";

const digest = `0x${"ab".repeat(32)}`;
const fixtureId = "urn:evllm:source:123e4567-e89b-42d3-a456-426614174000";
const evaluationId = "urn:evllm:case:123e4567-e89b-42d3-a456-426614174001";

describe("research artifact manifests", () => {
  it("requires provenance labels and source/licence or generator metadata", () => {
    expect(
      fixtureManifest.parse({
        schema: "EVLLM_FIXTURE_MANIFEST_V1",
        fixture_id: fixtureId,
        fixture_version: 1,
        source_class: "public-data-replay",
        source_uri: "https://example.invalid/data.csv",
        licence_id: "CC-BY-4.0",
        content_sha256: digest,
        derived_from: [],
      }),
    ).toBeDefined();
    expect(() =>
      fixtureManifest.parse({
        schema: "EVLLM_FIXTURE_MANIFEST_V1",
        fixture_id: fixtureId,
        fixture_version: 1,
        source_class: "scripted-report",
        content_sha256: digest,
        derived_from: [],
      }),
    ).toThrow();
  });

  it("rejects a dirty or unfrozen formal configuration", () => {
    const base = {
      schema: "EVLLM_EVALUATION_CONFIG_V1",
      evaluation_id: evaluationId,
      evaluation_version: 1,
      mode: "formal",
      source_commit: "a".repeat(40),
      generated_contracts_sha256: digest,
      fixtures: [fixtureId],
    } as const;
    expect(() =>
      evaluationConfigManifest.parse({ ...base, frozen: false, dirty_generated_artifacts: false }),
    ).toThrow();
    expect(() =>
      evaluationConfigManifest.parse({ ...base, frozen: true, dirty_generated_artifacts: true }),
    ).toThrow();
    expect(
      evaluationConfigManifest.parse({
        ...base,
        frozen: true,
        dirty_generated_artifacts: false,
      }),
    ).toBeDefined();
  });

  it("separates development/formal result paths and prohibits secret-bearing runs", () => {
    expect(
      evaluationRunManifest.parse({
        schema: "EVLLM_EVALUATION_RUN_V1",
        run_id: "urn:evllm:event:123e4567-e89b-42d3-a456-426614174002",
        config_id: evaluationId,
        config_version: 1,
        config_sha256: digest,
        started_at: "2026-08-11T00:00:00.000Z",
        completed_at: "2026-08-11T00:01:00.000Z",
        result_directory: "evaluation/formal/source-smoke",
        secrets_included: false,
        metrics: [{ metric_id: "schema.pass_rate", value: "1.0" }],
      }),
    ).toBeDefined();
    expect(() =>
      evaluationRunManifest.parse({
        schema: "EVLLM_EVALUATION_RUN_V1",
        run_id: "urn:evllm:event:123e4567-e89b-42d3-a456-426614174002",
        config_id: evaluationId,
        config_version: 1,
        config_sha256: digest,
        started_at: "2026-08-11T00:00:00.000Z",
        completed_at: "2026-08-11T00:01:00.000Z",
        result_directory: "../escaped",
        secrets_included: true,
        metrics: [],
      }),
    ).toThrow();
  });
});
