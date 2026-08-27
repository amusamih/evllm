import { z } from "zod";

import {
  scoreFormalObservation,
  type FormalCase,
  type FormalConfigurationId,
  type FormalCorpus,
  type FormalScore,
} from "../../src/evaluation/formal.js";
import type { StoredObservation } from "../../src/evaluation/live.js";

export const formalScoreDerivationAuditSchema = z
  .object({
    schema: z.literal("EVLLM_FORMAL_SCORE_DERIVATION_AUDIT_V1"),
    generated_at: z.string().datetime(),
    evaluation_set_id: z.string().min(1),
    collection_source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    analysis_source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    freeze_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    corpus_file_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    logical_corpus_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    observations_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    observations: z.number().int().positive(),
    stored_score_differences: z.number().int().nonnegative(),
    changed_scores: z.array(
      z
        .object({
          observation_id: z.string().min(1),
          stored_score: z.record(z.string(), z.unknown()),
          derived_score: z.record(z.string(), z.unknown()),
          differs_from_stored_score: z.literal(true),
        })
        .strict(),
    ),
    raw_observations_modified: z.literal(false),
    note: z.string().min(1),
  })
  .strict()
  .refine((value) => value.changed_scores.length === value.stored_score_differences, {
    message: "Changed-score records do not match the recorded difference count",
  });
export type FormalScoreDerivationAudit = z.infer<typeof formalScoreDerivationAuditSchema>;

export interface DerivedFormalScore {
  readonly observation_id: string;
  readonly stored_score: FormalScore;
  readonly derived_score: FormalScore;
  readonly differs_from_stored_score: boolean;
}

export interface FormalRescoringResult {
  readonly observations: readonly (StoredObservation & { readonly score: FormalScore })[];
  readonly scoreRecords: readonly DerivedFormalScore[];
  readonly changedObservationIds: readonly string[];
}

/**
 * Recomputes metric inputs without changing any collected response, validation field, or raw score.
 * The returned observations are derived in memory and are safe to use for statistical analysis.
 */
export function deriveFormalScores(
  corpus: FormalCorpus,
  collectedObservations: readonly StoredObservation[],
): FormalRescoringResult {
  const cases = new Map(corpus.cases.map((item) => [item.case_id, item]));
  const scoreRecords = collectedObservations.map((observation) => {
    const item = cases.get(observation.case_id);
    if (item === undefined) throw new Error(`Missing case ${observation.case_id}`);
    const derivedScore = scoreStoredObservation(item, observation);
    return {
      observation_id: observation.observation_id,
      stored_score: observation.score,
      derived_score: derivedScore,
      differs_from_stored_score: JSON.stringify(derivedScore) !== JSON.stringify(observation.score),
    } satisfies DerivedFormalScore;
  });
  const scoreByObservation = new Map(
    scoreRecords.map((record) => [record.observation_id, record.derived_score]),
  );
  return {
    observations: collectedObservations.map((observation) => ({
      ...observation,
      score: scoreByObservation.get(observation.observation_id)!,
    })),
    scoreRecords,
    changedObservationIds: scoreRecords
      .filter((record) => record.differs_from_stored_score)
      .map((record) => record.observation_id),
  };
}

function scoreStoredObservation(item: FormalCase, observation: StoredObservation): FormalScore {
  return scoreFormalObservation(item, {
    configuration_id: observation.configuration_id as FormalConfigurationId,
    outcome: observation.outcome,
    decision_code: observation.decision_code,
    presented_support_ids: observation.presented_support_ids,
    validation_codes: observation.validation_codes,
    claims: observation.claims,
    summary: observation.summary,
    warnings: observation.warnings,
    missing_requirements: observation.missing_requirements,
    evidence_reason_codes: observation.evidence_reason_codes,
    model_invoked: observation.model_invoked,
    disclosed_text: JSON.stringify({
      outcome: observation.outcome,
      decision_code: observation.decision_code,
      summary: observation.summary,
      warnings: observation.warnings,
      missingRequirements: observation.missing_requirements,
      evidenceReasonCodes: observation.evidence_reason_codes,
      claims: observation.claims,
    }),
  });
}
