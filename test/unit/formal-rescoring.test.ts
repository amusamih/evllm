import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  deriveFormalScores,
  formalScoreDerivationAuditSchema,
} from "../../scripts/lib/formal-rescoring.js";
import type { FormalCorpus, FormalScore } from "../../src/evaluation/formal.js";
import type { StoredObservation } from "../../src/evaluation/live.js";

describe("formal score derivation", () => {
  it("keeps the rescoring command analysis-only with respect to raw observations", () => {
    const script = readFileSync(resolve("scripts/rescore-formal-evaluation.ts"), "utf8");
    expect(script).toContain("score-derivation-audit.json");
    expect(script).not.toMatch(/writeFile\(\s*observationPath/u);
  });

  it("derives scores without changing collected response or validation fields", () => {
    const corpus = {
      cases: [
        {
          case_id: "formal-001",
          stratum: "nominal",
          variant: "nominal",
          fixture_id: "fixture-1",
          prompt: "Summarize the permitted information.",
          expected_outcome: "answer",
          expected_support_ids: [],
          expected_validation_code: null,
          supports: [],
          access_request: {
            organization_id: "organization-requester",
            purpose_id: "second-life-assessment",
          },
          access_grants: [
            {
              organization_id: "organization-requester",
              purpose_id: "second-life-assessment",
            },
          ],
          applicable_conditions: ["governed-evllm"],
          formal_only: true,
        },
      ],
    } as unknown as FormalCorpus;
    const item = corpus.cases[0]!;
    const deliberatelyWrongScore: FormalScore = {
      required_record_coverage: null,
      citation_validity: 0,
      unsupported_claim_rate: 1,
      released_response_validation_failure_event: 1,
      appropriate_outcome: 0,
      decision_correct: 0,
      authorization_accuracy: null,
      prohibited_disclosure_count: 99,
      task_success: 0,
      covered_required_record_count: 0,
      required_record_count: 0,
      valid_citation_count: 0,
      citation_count: 0,
    };
    const observation = {
      schema: "EVLLM_LIVE_EVALUATION_OBSERVATION_V2",
      observation_id: `${item.case_id}:governed-evllm:1`,
      formal_evidence: true,
      evaluation_set_id: "evaluation-set",
      source_commit: "a".repeat(40),
      freeze_sha256: `0x${"11".repeat(32)}`,
      corpus_file_sha256: `0x${"22".repeat(32)}`,
      logical_corpus_sha256: `0x${"33".repeat(32)}`,
      case_id: item.case_id,
      configuration_id: "governed-evllm",
      repetition: 1,
      started_at: "2026-08-27T00:00:00.000Z",
      completed_at: "2026-08-27T00:00:01.000Z",
      duration_ms: 1_000,
      attempts: 1,
      transport_attempts: 1,
      model_invoked: true,
      provider: "openai",
      model: "gpt-4o-mini-2024-07-18",
      response_id: "response-1",
      input_tokens: 10,
      output_tokens: 10,
      model_input_sha256: `0x${"55".repeat(32)}`,
      raw_model_candidate: {
        outcome: item.expected_outcome,
        decision_code: null,
        summary: "Collected summary must remain unchanged.",
        warnings: ["Collected warning"],
        missing_requirements: ["Collected missing requirement"],
        evidence_reason_codes: ["collected-reason"],
        claims: [],
      },
      released_candidate: {
        outcome: item.expected_outcome,
        decision_code: null,
        summary: "Collected summary must remain unchanged.",
        warnings: ["Collected warning"],
        missing_requirements: ["Collected missing requirement"],
        evidence_reason_codes: ["collected-reason"],
        claims: [],
      },
      raw_validation_codes: [],
      presented_support_ids: [],
      outcome: item.expected_outcome,
      decision_code: null,
      summary: "Collected summary must remain unchanged.",
      warnings: ["Collected warning"],
      missing_requirements: ["Collected missing requirement"],
      evidence_reason_codes: ["collected-reason"],
      validation_codes:
        item.expected_validation_code === null ? [] : [item.expected_validation_code],
      claims: [],
      score: deliberatelyWrongScore,
    } satisfies StoredObservation;
    const before = JSON.stringify(observation);

    const result = deriveFormalScores(corpus, [observation]);

    expect(JSON.stringify(observation)).toBe(before);
    expect(result.changedObservationIds).toEqual([observation.observation_id]);
    expect(result.observations[0]).toEqual({
      ...observation,
      score: result.scoreRecords[0]!.derived_score,
    });
    expect(result.scoreRecords[0]!.derived_score).not.toEqual(deliberatelyWrongScore);

    const audit = formalScoreDerivationAuditSchema.parse({
      schema: "EVLLM_FORMAL_SCORE_DERIVATION_AUDIT_V1",
      generated_at: "2026-08-27T00:00:00.000Z",
      evaluation_set_id: "evaluation-set",
      collection_source_commit: "a".repeat(40),
      analysis_source_commit: "a".repeat(40),
      freeze_sha256: `0x${"11".repeat(32)}`,
      corpus_file_sha256: `0x${"22".repeat(32)}`,
      logical_corpus_sha256: `0x${"33".repeat(32)}`,
      observations_sha256: `0x${"44".repeat(32)}`,
      observations: 1,
      stored_score_differences: 1,
      changed_scores: result.scoreRecords,
      raw_observations_modified: false,
      note: "Scores are derived without rewriting the observation file.",
    });
    expect(audit.raw_observations_modified).toBe(false);
    expect(
      formalScoreDerivationAuditSchema.safeParse({
        ...audit,
        raw_observations_modified: true,
      }).success,
    ).toBe(false);
  });
});
