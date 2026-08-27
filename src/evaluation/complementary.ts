import { z } from "zod";

import {
  validateAssistantCandidate,
  validateAssistantClaim,
  validateAssistantExplanationCandidate,
} from "../assistant/service.js";
import {
  assistantSupport,
  assistantOutcome,
  recordedDecision,
  supportState,
  type AssistantCandidate,
  type AssistantSupport,
  type RecordedDecision,
  type SupportState,
} from "../assistant/types.js";
import { recordedDecisionSupportCommitment } from "../assistant/support-commitment.js";
import { sha256Json } from "./final-freeze.js";

const complementarySynthesisRecordSchema = z
  .object({
    support_id: z.string().min(1),
    resource_id: z.string().min(1),
    resource_version: z.number().int().positive(),
    status: supportState,
    content: z.string().min(1),
    recorded_decision: recordedDecision.optional(),
  })
  .strict();

export const complementaryEvaluationCaseSchema = z
  .object({
    case_id: z.string().min(1),
    stratum: z.string().min(1),
    variant: z.number().int().positive(),
    prompt: z.string().min(1),
    expected_conclusion: z.string().min(1),
    expected_detection: z.enum(["missing", "conflict"]).nullable(),
    expected_outcome: assistantOutcome,
    records: z.array(complementarySynthesisRecordSchema).min(1),
    raw_record_operations: z.number().int().positive(),
    sequential_deterministic_operations: z.number().int().positive(),
    evllm_operations: z.number().int().positive(),
  })
  .strict();
export type ComplementaryEvaluationCase = z.infer<typeof complementaryEvaluationCaseSchema>;

const complementaryEvaluationCorpusSchema = z
  .object({
    schema: z.literal("EVLLM_COMPLEMENTARY_SYNTHESIS_CORPUS_V2"),
    version: z.literal(2),
    generated_from_seed: z.string().min(1),
    source_class: z.literal("synthetic-generator"),
    generator: z.string().min(1),
    case_count: z.number().int().positive(),
    strata: z.array(z.string().min(1)).min(1),
    cases: z.array(complementaryEvaluationCaseSchema).min(1),
    corpus_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
  })
  .strict();
export type ComplementaryEvaluationCorpus = z.infer<typeof complementaryEvaluationCorpusSchema>;

/** Parses and audits a synthesis corpus before any model client or worker is constructed. */
export function parseAndValidateComplementaryCorpus(input: unknown): ComplementaryEvaluationCorpus {
  const corpus = complementaryEvaluationCorpusSchema.parse(input);
  if (corpus.case_count !== corpus.cases.length) {
    throw new Error("Complementary corpus case_count does not match its cases");
  }
  const declaredStrata = new Set(corpus.strata);
  if (declaredStrata.size !== corpus.strata.length) {
    throw new Error("Complementary corpus strata must be unique");
  }
  const caseIds = new Set<string>();
  for (const item of corpus.cases) {
    if (caseIds.has(item.case_id)) throw new Error(`Duplicate complementary case ${item.case_id}`);
    caseIds.add(item.case_id);
    if (!declaredStrata.has(item.stratum)) {
      throw new Error(`Complementary case ${item.case_id} has an undeclared stratum`);
    }
    validateComplementaryCasePreflight(item);
  }
  return corpus;
}

/**
 * Validates a stored corpus and reproduces the digest over the exact stored
 * document. Schema parsing may normalize object-key order, so integrity must be
 * checked against the validated input rather than the parser's reconstructed
 * return value.
 */
export function parseAndVerifyComplementaryCorpus(input: unknown): {
  readonly corpus: ComplementaryEvaluationCorpus;
  readonly logicalCorpusSha256: string;
} {
  const corpus = parseAndValidateComplementaryCorpus(input);
  const unsignedCorpus = { ...(input as Record<string, unknown>) };
  delete unsignedCorpus.corpus_sha256;
  const logicalCorpusSha256 = sha256Json(unsignedCorpus);
  if (corpus.corpus_sha256 !== logicalCorpusSha256) {
    throw new Error("Complementary corpus logical digest is not reproducible");
  }
  return { corpus, logicalCorpusSha256 };
}

/** Audits one parsed case without accessing a model, network, filesystem, or mutable state. */
export function validateComplementaryCasePreflight(item: ComplementaryEvaluationCase): void {
  const recorded = recordedDecisionForCase(item);
  const finalRecord = item.records.at(-1);
  if (finalRecord?.status !== "active") {
    throw new Error(`Complementary case ${item.case_id} lacks a final active recorded decision`);
  }
  if (recorded.decision.outcome !== expectedSynthesisOutcome(item)) {
    throw new Error(`Complementary case ${item.case_id} has inconsistent expected outcome fields`);
  }
  const expectedDetectionReason = detectionReasonCode(item.expected_detection);
  const detectionReasons = recorded.decision.reason_codes.filter((code) =>
    ["missing-evidence", "conflicting-evidence"].includes(code),
  );
  if (
    expectedDetectionReason === null
      ? detectionReasons.length !== 0
      : !detectionReasons.includes(expectedDetectionReason) || detectionReasons.length !== 1
  ) {
    throw new Error(
      `Complementary case ${item.case_id} expected detection does not match its typed decision reasons`,
    );
  }
  const escapedCode = recorded.decision.code.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    finalRecord === undefined ||
    !new RegExp(
      `\\b(?:exact\\s+|recorded\\s+)?decision\\s+code\\s+is\\s+['"]?${escapedCode}(?:['"]|\\b)`,
      "iu",
    ).test(finalRecord.content)
  ) {
    throw new Error(
      `Complementary case ${item.case_id} final record does not affirm its typed decision code`,
    );
  }
  const escapedOutcome = recorded.decision.outcome.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (
    !new RegExp(
      `\\b(?:structured\\s+outcome|assessment\\s+state)\\s+(?:is\\s+)?${escapedOutcome}\\b`,
      "iu",
    ).test(finalRecord.content)
  ) {
    throw new Error(
      `Complementary case ${item.case_id} final record does not state its typed outcome`,
    );
  }
  if (
    recorded.decision.reason_codes.includes("missing-evidence") &&
    !/\b(?:missing|absent|unavailable|not\s+available|no\s+current)\b/iu.test(finalRecord.content)
  ) {
    throw new Error(
      `Complementary case ${item.case_id} final record does not state its missing evidence`,
    );
  }
  if (
    recorded.decision.reason_codes.includes("conflicting-evidence") &&
    !/\b(?:conflict|conflicting|disagree|disagreement|inconsistent)\b/iu.test(finalRecord.content)
  ) {
    throw new Error(
      `Complementary case ${item.case_id} final record does not state its conflicting evidence`,
    );
  }
  if (!recordAffirmsDecisionMeaning(finalRecord.content, recorded.decision.code)) {
    throw new Error(
      `Complementary case ${item.case_id} final record conflicts with the meaning of its typed decision`,
    );
  }
  const supportIds = new Set(item.records.map(({ support_id: supportId }) => supportId));
  if (supportIds.size !== item.records.length) {
    throw new Error(`Complementary case ${item.case_id} repeats a support identifier`);
  }
  for (const support of supportsForSynthesisCase(item)) assistantSupport.parse(support);
  if (
    item.raw_record_operations !== item.records.length ||
    item.sequential_deterministic_operations !== item.records.length + 1 ||
    item.evllm_operations !== 1
  ) {
    throw new Error(`Complementary case ${item.case_id} has inconsistent operation counts`);
  }
  const batteryIds = new Set(
    item.records.flatMap(({ content }) =>
      [...content.matchAll(/\bBattery\s+(SYN-[0-9]{3})\b/giu)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1].toUpperCase()],
      ),
    ),
  );
  if (batteryIds.size !== 1) {
    throw new Error(`Complementary case ${item.case_id} does not identify one supported battery`);
  }
  const [batteryId] = batteryIds;
  if (batteryId === undefined || !item.prompt.includes(`Battery ${batteryId}`)) {
    throw new Error(
      `Complementary case ${item.case_id} prompt does not name its supported battery`,
    );
  }
  if (item.prompt.toLowerCase().includes(item.case_id.toLowerCase())) {
    throw new Error(`Complementary case ${item.case_id} prompt exposes its evaluation case ID`);
  }
  if (item.stratum === "route-comparison") {
    if (!/\bthree(?:\s+recorded)?\s+routes\b/iu.test(item.prompt)) {
      throw new Error(`Complementary route case ${item.case_id} does not state three routes`);
    }
    if (!/\bsix\s+components\s+separately\b/iu.test(item.prompt)) {
      throw new Error(`Complementary route case ${item.case_id} does not state six components`);
    }
    const componentDefinitions = [
      /\bG\s+is\s+the\s+technical\s+and\s+safety\s+gate\b/iu,
      /\bC\s+is\s+circularity\b/iu,
      /\bI\s+contains\s+the\s+environmental\s+indicators\b/iu,
      /\bE\s+is\s+economics\b/iu,
      /\bA\s+is\s+information\s+adequacy\b/iu,
      /\bU\s+is\s+uncertainty\b/iu,
    ];
    if (componentDefinitions.some((definition) => !definition.test(item.prompt))) {
      throw new Error(
        `Complementary route case ${item.case_id} does not define all six components`,
      );
    }
  }
}

function recordAffirmsDecisionMeaning(content: string, code: string): boolean {
  const checks: Readonly<Record<string, RegExp>> = {
    "eligible-for-resale": /\b(?:eligible|eligibility)\b.{0,80}\b(?:resale|resell)\b/iu,
    "insufficient-evidence":
      /(?:\b(?:missing|absent|unavailable|no\s+current)\b.{0,80}\b(?:evidence|inspection|record)\b|\b(?:evidence|inspection|record)\b.{0,80}\b(?:is\s+)?(?:missing|absent|unavailable)\b)/iu,
    "external-decision-required":
      /\b(?:external|accountable|responsible)\b.{0,80}\b(?:decision|review|verifier|referral)\b/iu,
    "lifecycle-action-permitted": /\blifecycle\b.{0,80}\b(?:permitted|permits|allowed)\b/iu,
    "continued-compatible-ev-use-preferred":
      /\bcontinued\s+compatible\s+EV\s+use\b.{0,80}\bprefer(?:red|ence)?\b/iu,
    "replica-recovery-permitted":
      /\b(?:replica|recovery)\b.{0,80}\b(?:is\s+)?(?:permitted|allowed|authorized)\b/iu,
  };
  return checks[code]?.test(content) ?? false;
}

export interface ComplementarySynthesisRecord {
  readonly support_id: string;
  readonly resource_id: string;
  readonly resource_version: number;
  readonly status: SupportState;
  readonly content: string;
  readonly recorded_decision?: ComplementaryRecordedDecision | undefined;
}

export type ComplementaryRecordedDecision = RecordedDecision;

export interface ComplementarySynthesisCase {
  readonly case_id: string;
  readonly stratum: string;
  readonly prompt: string;
  readonly expected_conclusion: string;
  readonly expected_detection: "missing" | "conflict" | null;
  readonly expected_outcome?: AssistantCandidate["outcome"];
  readonly records: readonly ComplementarySynthesisRecord[];
  readonly evllm_operations: number;
}

export interface ComplementarySynthesisObservation {
  readonly outcome: AssistantCandidate["outcome"];
  readonly decision_code: string | null;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly missing_requirements: readonly string[];
  readonly evidence_reason_codes: readonly string[];
  readonly validation_status?: "passed" | "rejected";
  readonly validation_codes?: readonly string[];
  readonly claims: ReadonlyArray<{
    readonly text: string;
    readonly citation_ids: readonly string[];
  }>;
}

export interface ComplementarySynthesisScore {
  readonly operation_count: number;
  readonly required_record_coverage: number;
  readonly deterministic_record_binding: number;
  readonly recorded_decision_preservation: number;
  readonly structured_outcome_accuracy: number;
  readonly recorded_decision_and_outcome_accuracy: number;
  readonly citation_validity: number;
  readonly unsupported_claim_rate: number;
  readonly unsupported_claim_count: number;
  readonly claim_count: number;
  readonly missing_information_detection: number | null;
  readonly conflicting_information_detection: number | null;
  readonly pipeline_validation_accuracy: number;
  readonly single_response_supported_synthesis_success: number;
}

export interface ComplementaryRawGenerationScore {
  readonly required_record_coverage: number;
  readonly all_required_records_covered: number;
  readonly deterministic_record_binding: number;
  readonly decision_code_accuracy: number;
  readonly structured_outcome_accuracy: number;
  readonly required_reason_accuracy: number;
  readonly raw_candidate_validation_accuracy: number;
  readonly generation_success: number;
  readonly claim_count: number;
}

export type ComplementaryAnalyticReferenceCondition =
  "raw-structured-record-access" | "sequential-deterministic-query";

/**
 * Describes only the prescribed interaction count for a non-response interface.
 * Response, claim, citation, and decision metrics are deliberately not applicable.
 */
export function complementaryAnalyticReference(
  item: Pick<ComplementarySynthesisCase, "case_id" | "stratum"> & {
    readonly raw_record_operations: number;
    readonly sequential_deterministic_operations: number;
  },
  condition: ComplementaryAnalyticReferenceCondition,
): {
  readonly condition: ComplementaryAnalyticReferenceCondition;
  readonly case_id: string;
  readonly stratum: string;
  readonly operation_count: number;
  readonly required_record_coverage: null;
  readonly deterministic_record_binding: null;
  readonly recorded_decision_preservation: null;
  readonly structured_outcome_accuracy: null;
  readonly recorded_decision_and_outcome_accuracy: null;
  readonly citation_validity: null;
  readonly unsupported_claim_rate: null;
  readonly unsupported_claim_count: null;
  readonly claim_count: null;
  readonly missing_information_detection: null;
  readonly conflicting_information_detection: null;
  readonly pipeline_validation_accuracy: null;
  readonly single_response_supported_synthesis_success: null;
} {
  return {
    condition,
    case_id: item.case_id,
    stratum: item.stratum,
    operation_count:
      condition === "sequential-deterministic-query"
        ? item.sequential_deterministic_operations
        : item.raw_record_operations,
    required_record_coverage: null,
    deterministic_record_binding: null,
    recorded_decision_preservation: null,
    structured_outcome_accuracy: null,
    recorded_decision_and_outcome_accuracy: null,
    citation_validity: null,
    unsupported_claim_rate: null,
    unsupported_claim_count: null,
    claim_count: null,
    missing_information_detection: null,
    conflicting_information_detection: null,
    pipeline_validation_accuracy: null,
    single_response_supported_synthesis_success: null,
  };
}

export function expectedSynthesisOutcome(
  item: Pick<ComplementarySynthesisCase, "expected_detection" | "expected_outcome">,
): AssistantCandidate["outcome"] {
  if (item.expected_outcome !== undefined) return item.expected_outcome;
  if (item.expected_detection === "missing") return "abstain";
  if (item.expected_detection === "conflict") return "requires_external_decision";
  return "answer";
}

export function supportsForSynthesisCase(
  item: Pick<ComplementarySynthesisCase, "records">,
  asOf = 200,
): readonly AssistantSupport[] {
  return item.records.map((record) => {
    const support = {
      ...record,
      issuer_organization_id: urn("org", 2),
      custodian_organization_id: urn("org", 2),
      as_of: asOf,
      chain_reference: `complementary:${record.support_id}`,
    };
    return {
      ...support,
      commitment:
        support.recorded_decision === undefined
          ? `sha256:${"c".repeat(48)}`
          : recordedDecisionSupportCommitment({
              ...support,
              recorded_decision: support.recorded_decision,
            }),
    };
  });
}

export function recordedDecisionForCase(
  item: Pick<ComplementarySynthesisCase, "records"> &
    Partial<
      Pick<
        ComplementarySynthesisCase,
        "expected_conclusion" | "expected_detection" | "expected_outcome"
      >
    >,
): { readonly support_id: string; readonly decision: ComplementaryRecordedDecision } {
  const bound = item.records.flatMap((record) =>
    record.recorded_decision === undefined
      ? []
      : [{ support_id: record.support_id, decision: record.recorded_decision }],
  );
  if (bound.length !== 1) {
    throw new Error("A complementary synthesis case must contain one recorded decision");
  }
  const finalRecord = item.records.at(-1);
  if (finalRecord?.support_id !== bound[0]!.support_id) {
    throw new Error("The recorded decision must be attached to the final deterministic record");
  }
  const { decision } = bound[0]!;
  if (
    item.expected_conclusion !== undefined &&
    decision.code !== item.expected_conclusion.toLowerCase()
  ) {
    throw new Error("The typed decision code conflicts with the declared expected conclusion");
  }
  if (item.expected_outcome !== undefined && decision.outcome !== item.expected_outcome) {
    throw new Error("The typed decision outcome conflicts with the declared expected outcome");
  }
  if (
    item.expected_detection === "missing" &&
    !decision.reason_codes.includes("missing-evidence")
  ) {
    throw new Error("The typed decision lacks the expected missing-evidence reason");
  }
  if (
    item.expected_detection === "conflict" &&
    !decision.reason_codes.includes("conflicting-evidence")
  ) {
    throw new Error("The typed decision lacks the expected conflicting-evidence reason");
  }
  if (item.expected_detection === null && decision.reason_codes.length > 0) {
    throw new Error("The typed answer decision unexpectedly contains evidence reason codes");
  }
  return bound[0]!;
}

export function scoreComplementaryRawGeneration(
  candidate: ComplementarySynthesisObservation,
  item: ComplementarySynthesisCase,
): ComplementaryRawGenerationScore {
  const recorded = recordedDecisionForCase(item);
  const supports = supportsForSynthesisCase(item);
  const claims = candidateClaims(candidate);
  const coverage = supportedRecordCoverage(claims, supports);
  const decisionCodeCorrect = candidate.decision_code === recorded.decision.code;
  const outcomeCorrect = candidate.outcome === recorded.decision.outcome;
  const reasonCorrect = sameCodes(candidate.evidence_reason_codes, recorded.decision.reason_codes);
  const decisionBinding = decisionCodeCorrect && outcomeCorrect && reasonCorrect;
  const validationPassed = validateComplementaryRawGeneration(candidate, item).length === 0;
  const success = coverage === 1 && decisionBinding && validationPassed ? 1 : 0;
  return {
    required_record_coverage: coverage,
    all_required_records_covered: coverage === 1 ? 1 : 0,
    deterministic_record_binding: decisionBinding ? 1 : 0,
    decision_code_accuracy: decisionCodeCorrect ? 1 : 0,
    structured_outcome_accuracy: outcomeCorrect ? 1 : 0,
    required_reason_accuracy: reasonCorrect ? 1 : 0,
    raw_candidate_validation_accuracy: validationPassed ? 1 : 0,
    generation_success: success,
    claim_count: candidate.claims.length,
  };
}

export function validateComplementaryRawGeneration(
  candidate: ComplementarySynthesisObservation,
  item: ComplementarySynthesisCase,
): string[] {
  const invalidReasonCode = candidate.evidence_reason_codes.some(
    (code) => !isEvidenceReasonCode(code),
  );
  const codes = validateAssistantExplanationCandidate(
    {
      outcome: candidate.outcome,
      decision_code: candidate.decision_code,
      summary: candidate.summary,
      warnings: [...candidate.warnings],
      missing_requirements: [...candidate.missing_requirements],
      evidence_reason_codes: candidate.evidence_reason_codes.filter(isEvidenceReasonCode),
      claims: candidateClaims(candidate),
    },
    supportsForSynthesisCase(item),
  );
  if (invalidReasonCode) codes.push("unknown-evidence-reason-code");
  return [...new Set(codes)].sort();
}

export function scoreComplementarySynthesis(
  observation: ComplementarySynthesisObservation,
  item: ComplementarySynthesisCase,
): ComplementarySynthesisScore {
  const recorded = recordedDecisionForCase(item);
  const supports = supportsForSynthesisCase(item);
  const supportById = new Map(supports.map((support) => [support.support_id, support]));
  const required = new Set(supports.map((support) => support.support_id));
  const claims: AssistantCandidate["claims"] = observation.claims.map((claim, index) => ({
    claim_id: `claim-${String(index + 1)}`,
    text: claim.text,
    citation_ids: [...claim.citation_ids],
  }));
  const candidate: AssistantCandidate = {
    outcome: observation.outcome,
    decision_code: observation.decision_code,
    summary: observation.summary,
    warnings: [...observation.warnings],
    missing_requirements: [...observation.missing_requirements],
    evidence_reason_codes: observation.evidence_reason_codes.filter(isEvidenceReasonCode),
    claims,
  };
  const invalidReasonCode = observation.evidence_reason_codes.some(
    (code) => !isEvidenceReasonCode(code),
  );
  const coveredRequiredRecords = new Set<string>();
  const citationCount = claims.reduce(
    (total, claim) => total + new Set(claim.citation_ids).size,
    0,
  );
  const validCitationCount = claims.reduce(
    (total, claim) =>
      total +
      [...new Set(claim.citation_ids)].filter((citationId) => {
        const support = supportById.get(citationId);
        return support !== undefined && support.status === "active";
      }).length,
    0,
  );
  const unsupportedClaims = claims.filter((claim) => {
    const unsupported = validateAssistantClaim(claim, supports).length > 0;
    if (!unsupported) {
      for (const citationId of claim.citation_ids) {
        if (required.has(citationId)) coveredRequiredRecords.add(citationId);
      }
    }
    return unsupported;
  }).length;
  const coverage = required.size === 0 ? 1 : coveredRequiredRecords.size / required.size;
  const citationValidity = citationCount === 0 ? 0 : validCitationCount / citationCount;
  const unsupported = claims.length === 0 ? 0 : unsupportedClaims / claims.length;
  const conclusion = observation.decision_code === recorded.decision.code;
  const outcomeCorrect = observation.outcome === recorded.decision.outcome;
  const reasonCorrect = sameCodes(
    observation.evidence_reason_codes,
    recorded.decision.reason_codes,
  );
  const deterministicBinding = conclusion && outcomeCorrect && reasonCorrect;
  const expectedDetectionReason = detectionReasonCode(item.expected_detection);
  const detection =
    expectedDetectionReason === null
      ? null
      : observation.evidence_reason_codes.includes(expectedDetectionReason)
        ? 1
        : 0;
  const recordedValidationPassed =
    observation.validation_status === "passed" &&
    (observation.validation_codes?.length ?? Number.POSITIVE_INFINITY) === 0;
  const rescoredValidationPassed =
    !invalidReasonCode && validateAssistantCandidate(candidate, supports, item.prompt).length === 0;
  const pipelineValidationPassed = recordedValidationPassed && rescoredValidationPassed;
  const decisionCorrect = conclusion && outcomeCorrect;
  const success =
    item.evllm_operations === 1 &&
    coverage === 1 &&
    citationValidity === 1 &&
    unsupported === 0 &&
    decisionCorrect &&
    (detection === null || detection === 1) &&
    pipelineValidationPassed
      ? 1
      : 0;
  return {
    operation_count: item.evllm_operations,
    required_record_coverage: coverage,
    deterministic_record_binding: deterministicBinding ? 1 : 0,
    recorded_decision_preservation: conclusion ? 1 : 0,
    structured_outcome_accuracy: outcomeCorrect ? 1 : 0,
    recorded_decision_and_outcome_accuracy: decisionCorrect ? 1 : 0,
    citation_validity: citationValidity,
    unsupported_claim_rate: unsupported,
    unsupported_claim_count: unsupportedClaims,
    claim_count: claims.length,
    missing_information_detection: item.expected_detection === "missing" ? detection : null,
    conflicting_information_detection: item.expected_detection === "conflict" ? detection : null,
    pipeline_validation_accuracy: pipelineValidationPassed ? 1 : 0,
    single_response_supported_synthesis_success: success,
  };
}

function detectionReasonCode(
  expected: ComplementaryEvaluationCase["expected_detection"],
): "missing-evidence" | "conflicting-evidence" | null {
  if (expected === "missing") return "missing-evidence";
  if (expected === "conflict") return "conflicting-evidence";
  return null;
}

function candidateClaims(
  candidate: ComplementarySynthesisObservation,
): AssistantCandidate["claims"] {
  return candidate.claims.map((claim, index) => ({
    claim_id: `claim-${String(index + 1)}`,
    text: claim.text,
    citation_ids: [...claim.citation_ids],
  }));
}

function supportedRecordCoverage(
  claims: AssistantCandidate["claims"],
  supports: readonly AssistantSupport[],
): number {
  const required = new Set(supports.map(({ support_id: supportId }) => supportId));
  const covered = new Set<string>();
  for (const claim of claims) {
    if (validateAssistantClaim(claim, supports).length > 0) continue;
    for (const citationId of claim.citation_ids) {
      if (required.has(citationId)) covered.add(citationId);
    }
  }
  return required.size === 0 ? 1 : covered.size / required.size;
}

function sameCodes(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((code, index) => code === [...right].sort()[index])
  );
}

function isEvidenceReasonCode(
  value: string,
): value is AssistantCandidate["evidence_reason_codes"][number] {
  return [
    "missing-evidence",
    "conflicting-evidence",
    "inactive-evidence",
    "access-denied",
    "prompt-injection",
    "external-decision-required",
  ].includes(value);
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
