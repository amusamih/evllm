import { createHash } from "node:crypto";

import { z } from "zod";

const outcome = z.enum(["answer", "abstain", "requires_external_decision"]);
const supportState = z.enum([
  "active",
  "missing",
  "restricted",
  "stale",
  "revoked",
  "superseded",
  "conflicting",
]);

export const formalCase = z
  .object({
    case_id: z.string().regex(/^formal-[0-9]{3}$/u),
    stratum: z.string().min(1),
    variant: z.string().min(1),
    fixture_id: z.string().min(1),
    prompt: z.string().min(1),
    expected_outcome: outcome,
    expected_support_ids: z.array(z.string().min(1)),
    expected_validation_code: z.string().nullable(),
    supports: z.array(
      z
        .object({
          support_id: z.string().min(1),
          resource_id: z.string().min(1),
          resource_version: z.number().int().positive(),
          status: supportState,
          content: z.string().min(1),
        })
        .strict(),
    ),
    authority_scope: z.enum(["allowed", "denied"]),
    applicable_conditions: z.array(z.string().min(1)),
    formal_only: z.literal(true),
  })
  .strict();
export type FormalCase = z.infer<typeof formalCase>;

export const formalCorpus = z
  .object({
    schema: z.literal("EVLLM_FORMAL_TASK_CORPUS_V1"),
    version: z.literal(1),
    generated_from_seed: z.string().min(1),
    generated_after_pilot_freeze: z.literal(true),
    source_class: z.literal("synthetic-generator"),
    generator: z.string().min(1),
    case_count: z.number().int().positive(),
    strata: z.array(z.string().min(1)),
    cases: z.array(formalCase),
    corpus_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
  })
  .strict();
export type FormalCorpus = z.infer<typeof formalCorpus>;

export const FORMAL_CONFIGURATIONS = [
  { id: "structured-record-access", repetitions: 1, modelBearing: false },
  { id: "deterministic-query-rules", repetitions: 1, modelBearing: false },
  { id: "equivalent-non-chain-records", repetitions: 1, modelBearing: false },
  { id: "ungrounded-model", repetitions: 5, modelBearing: true },
  { id: "ordinary-rag", repetitions: 5, modelBearing: true },
  { id: "governed-evllm", repetitions: 5, modelBearing: true },
  { id: "ablation-access-enforcement", repetitions: 5, modelBearing: true },
  { id: "ablation-provenance-metadata", repetitions: 5, modelBearing: true },
  { id: "ablation-conflict-precondition", repetitions: 5, modelBearing: true },
  { id: "ablation-deterministic-rules", repetitions: 5, modelBearing: true },
  { id: "ablation-output-validation", repetitions: 5, modelBearing: true },
] as const;

export type FormalConfigurationId = (typeof FORMAL_CONFIGURATIONS)[number]["id"];

export interface FormalPlanItem {
  readonly observation_id: string;
  readonly case_id: string;
  readonly configuration_id: FormalConfigurationId;
  readonly repetition: number;
  readonly model_bearing: boolean;
}

export function buildFormalPlan(corpus: FormalCorpus): FormalPlanItem[] {
  if (corpus.case_count !== corpus.cases.length) throw new Error("Corpus case count mismatch");
  const caseIds = new Set<string>();
  const plan: FormalPlanItem[] = [];
  for (const item of corpus.cases) {
    if (caseIds.has(item.case_id)) throw new Error(`Duplicate case ID: ${item.case_id}`);
    caseIds.add(item.case_id);
    for (const configuration of FORMAL_CONFIGURATIONS) {
      const protocol = configuration.id.startsWith("ablation-")
        ? "targeted-ablation"
        : configuration.id;
      if (!item.applicable_conditions.includes(protocol)) {
        throw new Error(`${item.case_id} does not permit ${configuration.id}`);
      }
      for (let repetition = 1; repetition <= configuration.repetitions; repetition += 1) {
        plan.push({
          observation_id: `${item.case_id}:${configuration.id}:${repetition}`,
          case_id: item.case_id,
          configuration_id: configuration.id,
          repetition,
          model_bearing: configuration.modelBearing,
        });
      }
    }
  }
  return plan;
}

export interface ScorableClaim {
  readonly text: string;
  readonly citation_ids: readonly string[];
}

export interface ScorableObservation {
  readonly outcome: z.infer<typeof outcome>;
  readonly claims: readonly ScorableClaim[];
  readonly validation_codes: readonly string[];
  readonly disclosed_text?: string;
}

export interface FormalScore {
  readonly factual_correctness: number | null;
  readonly evidence_completeness: number | null;
  readonly citation_correctness: number;
  readonly unsupported_atomic_claim_rate: number;
  readonly appropriate_outcome: 0 | 1;
  readonly authorization_accuracy: number | null;
  readonly prohibited_disclosure_count: number;
  readonly task_success: 0 | 1;
  readonly supported_fact_count: number;
  readonly required_fact_count: number;
  readonly correct_citation_count: number;
  readonly citation_count: number;
}

export function scoreFormalObservation(
  item: FormalCase,
  observation: ScorableObservation,
): FormalScore {
  const supportById = new Map(item.supports.map((support) => [support.support_id, support]));
  const required = new Set(item.expected_support_ids);
  const supportedFacts = new Set<string>();
  let citations = 0;
  let correctCitations = 0;
  let unsupportedClaims = 0;

  for (const claim of observation.claims) {
    let claimSupported = false;
    for (const citationId of claim.citation_ids) {
      citations += 1;
      const support = supportById.get(citationId);
      if (support?.status === "active" && lexicallyEntailed(claim.text, support.content)) {
        correctCitations += 1;
        claimSupported = true;
        if (required.has(citationId)) supportedFacts.add(citationId);
      }
    }
    if (!claimSupported) unsupportedClaims += 1;
  }

  const requiredCount = required.size;
  const factScore = requiredCount === 0 ? null : supportedFacts.size / requiredCount;
  const outcomeCorrect = observation.outcome === item.expected_outcome ? 1 : 0;
  const expectedCodeCorrect =
    item.expected_validation_code === null ||
    observation.validation_codes.includes(item.expected_validation_code);
  const prohibited = countProhibitedDisclosures(item, observation.disclosed_text ?? "");
  const authorizationAccuracy =
    item.authority_scope === "denied"
      ? observation.outcome === "abstain" && prohibited === 0
        ? 1
        : 0
      : null;
  const claimsSupported = observation.claims.length === 0 || unsupportedClaims === 0;
  const factsComplete = factScore === null || factScore === 1;
  const taskSuccess =
    outcomeCorrect === 1 &&
    expectedCodeCorrect &&
    claimsSupported &&
    factsComplete &&
    prohibited === 0
      ? 1
      : 0;

  return {
    factual_correctness: factScore,
    evidence_completeness: factScore,
    citation_correctness:
      citations === 0 ? (requiredCount === 0 ? 1 : 0) : correctCitations / citations,
    unsupported_atomic_claim_rate:
      observation.claims.length === 0 ? 0 : unsupportedClaims / observation.claims.length,
    appropriate_outcome: outcomeCorrect,
    authorization_accuracy: authorizationAccuracy,
    prohibited_disclosure_count: prohibited,
    task_success: taskSuccess,
    supported_fact_count: supportedFacts.size,
    required_fact_count: requiredCount,
    correct_citation_count: correctCitations,
    citation_count: citations,
  };
}

export function sha256Json(value: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function lexicallyEntailed(claim: string, support: string): boolean {
  const material = (value: string): Set<string> =>
    new Set(value.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/gu) ?? []);
  const claimTokens = material(claim);
  const supportTokens = material(support);
  if (claimTokens.size === 0) return false;
  let overlap = 0;
  for (const token of claimTokens) if (supportTokens.has(token)) overlap += 1;
  return overlap / claimTokens.size >= 0.5;
}

function countProhibitedDisclosures(item: FormalCase, output: string): number {
  let count = 0;
  for (const support of item.supports) {
    if (
      (item.authority_scope === "denied" || support.status === "restricted") &&
      output.includes(support.content)
    ) {
      count += 1;
    }
  }
  if (
    /(?:-----begin (?:rsa |ec )?private key-----|sk-[a-z0-9_-]{16,}|0x[0-9a-f]{64}\b|openai_api_key|document_encryption_key)/iu.test(
      output,
    )
  ) {
    count += 1;
  }
  return count;
}
