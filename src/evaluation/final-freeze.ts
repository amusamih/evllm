import { createHash } from "node:crypto";

import { OPENAI_ASSISTANT_CONFIG, OPENAI_ASSISTANT_MODEL } from "../assistant/model.js";
import { MODEL_CONDITION_IDS } from "./conditions.js";
import {
  COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP,
  COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS,
} from "./complementary-metrics.js";
import { FORMAL_EXPECTED_VALIDATION_TO_RELEASED_REASON_CODES } from "./formal.js";

export const FINAL_EVALUATION_MODEL = OPENAI_ASSISTANT_MODEL;
export const FINAL_TRANSPORT_RETRIES = 2;
export const FINAL_PRIMARY_CONDITIONS = [...MODEL_CONDITION_IDS] as const;
export const FINAL_PRIMARY_OUTCOMES = [
  "required_record_coverage",
  "citation_validity",
  "unsupported_claim_rate",
  "unsupported_claim_response_rate",
  "released_response_validation_failure_event",
  "appropriate_abstention_f1",
  "authorization_accuracy",
  "prohibited_disclosure_event",
  "released_typed_decision_fidelity",
  "task_success",
] as const;
export const FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES = [
  "task_success",
  "required_record_coverage",
  "unsupported_claim_response_rate",
  "released_response_validation_failure_event",
  "appropriate_abstention_f1",
  "authorization_accuracy",
  "prohibited_disclosure_event",
  "released_typed_decision_fidelity",
] as const;
export const FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES = [
  "citation_validity",
  "unsupported_claim_rate",
] as const;
export const FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL = {
  expectedValidationCodeToReleasedEvidenceReasonCodes:
    FORMAL_EXPECTED_VALIDATION_TO_RELEASED_REASON_CODES,
  comparison: "exact-set",
  internalValidationCodes: "diagnostic-only",
} as const;
export const FINAL_SYNTHESIS_CONDITIONS = [
  "raw-structured-record-access",
  "sequential-deterministic-query",
  "governed-evllm-synthesis",
] as const;
export const FINAL_SYNTHESIS_PRIMARY_METRICS = [
  "user_visible_operation_count",
  "required_record_coverage",
  "recorded_decision_and_outcome_accuracy",
  "citation_validity",
  "unsupported_claim_rate",
  "missing_information_detection",
  "conflicting_information_detection",
  "single_response_supported_synthesis_success",
] as const;

export interface CorpusBinding {
  readonly path: string;
  readonly caseCount: number;
  readonly strataCount: number;
  readonly casesPerStratum: number;
  readonly logicalCorpusSha256: string;
  readonly corpusFileSha256: string;
}

export interface RegulatorySourceBinding {
  readonly fixtureId: string;
  readonly path: string;
  readonly fixtureFileSha256: string;
  readonly sourceIdentifier: string;
  readonly eliUri: string;
  readonly officialEurLexUri: string;
  readonly jurisdiction: string;
  readonly clauseCount: number;
}

export interface FinalEvaluationFreezes {
  readonly evaluationSetId: string;
  readonly primary: Record<string, unknown>;
  readonly synthesis: Record<string, unknown>;
}

export interface PrimarySampleDesign {
  readonly plannedModelBearingObservations: number;
  readonly plannedModelInvocations: number;
  readonly plannedModelInvocationsByCondition: Readonly<Record<string, number>>;
  readonly plannedTransportAttemptsMinimum: number;
  readonly plannedTransportAttemptsMaximum: number;
  readonly totalObservationsPlanned: number;
}

export function buildFinalEvaluationFreezes(
  primaryCorpus: CorpusBinding,
  synthesisCorpus: CorpusBinding,
  regulatorySources: readonly RegulatorySourceBinding[],
  primarySampleDesign: PrimarySampleDesign,
): FinalEvaluationFreezes {
  const evaluationSetId = finalEvaluationSetId(primaryCorpus, synthesisCorpus, regulatorySources);
  return {
    evaluationSetId,
    primary: {
      schema: "EVLLM_FINAL_PRIMARY_EVALUATION_FREEZE_V2",
      evaluation_set_id: evaluationSetId,
      formalOutputsCollected: false,
      design:
        "Primary reliability and safety evaluation using 96 synthetic cases, eight model conditions, and five repetitions for every case-condition cell.",
      taskCorpus: primaryCorpus,
      regulatorySources,
      model: {
        provider: "openai",
        api: "responses",
        ...OPENAI_ASSISTANT_CONFIG,
        repetitionsPerStochasticCondition: 5,
        maximumTransportRetriesPerInvocation: FINAL_TRANSPORT_RETRIES,
      },
      conditions: [...FINAL_PRIMARY_CONDITIONS],
      sampleDesign: primarySampleDesign,
      primaryOutcomes: [...FINAL_PRIMARY_OUTCOMES],
      taskSuccessReasonSemantics: FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL,
      analysis: {
        confidenceLevel: 0.95,
        resamplingUnit: "case_id",
        pairedContrastOutcomes: [...FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES],
        descriptiveOutcomes: [...FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES],
        binaryIntervals:
          "Case-cluster percentile bootstrap; boundary intervals use Wilson score bounds over eligible cases.",
        pairedIntervals:
          "Paired 10000-resample case-cluster bootstrap confidence intervals retaining all repetitions within each sampled case.",
        pairedPValues:
          "Paired case-cluster randomization p values using within-case sign swaps, with exact enumeration when feasible and deterministic Monte Carlo sampling otherwise.",
        multipleComparisons: "Holm correction within each outcome family",
        zeroFailureRule:
          "Report numerator, denominator, and a 95% upper confidence bound rather than claiming zero risk.",
      },
      designation:
        "Only observations matching this evaluation set, source commit, freeze digest, and both corpus digests belong to the primary evidence set.",
    },
    synthesis: {
      schema: "EVLLM_FINAL_SYNTHESIS_EVALUATION_FREEZE_V2",
      evaluation_set_id: evaluationSetId,
      outputsCollected: false,
      researchQuestion:
        "Can governed conversational synthesis combine several permitted records in one supported response while preserving decision outcomes, traceability, and missing or conflicting information?",
      corpus: synthesisCorpus,
      model: {
        provider: "openai",
        api: "responses",
        ...OPENAI_ASSISTANT_CONFIG,
        repetitionsPerCase: 5,
        plannedMaximumModelResponses: 150,
        transportRetries: FINAL_TRANSPORT_RETRIES,
      },
      conditions: [...FINAL_SYNTHESIS_CONDITIONS],
      primaryMetrics: [...FINAL_SYNTHESIS_PRIMARY_METRICS],
      rawGenerationDiagnostics: [...COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS],
      rawGenerationDiagnosticFieldMap: { ...COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP },
      analysis: {
        confidenceLevel: 0.95,
        resamplingUnit: "case_id",
        binaryIntervals:
          "Case-cluster percentile bootstrap; boundary intervals use Wilson score bounds over eligible cases.",
        analyticReferenceComparison:
          "Prescribed operation counts are reported descriptively; response-quality metrics are not applicable to reference interfaces that generate no response.",
        zeroFailureRule:
          "Report numerator, denominator, and a 95% upper confidence bound rather than claiming zero risk.",
      },
      interpretationBoundary:
        "The evaluation measures machine-observed response behavior and interaction structure rather than subjective usefulness or usability.",
      designation:
        "Only observations matching this evaluation set, source commit, freeze digest, and both corpus digests belong to the synthesis evidence set.",
    },
  };
}

export function finalEvaluationSetId(
  primaryCorpus: CorpusBinding,
  synthesisCorpus: CorpusBinding,
  regulatorySources: readonly RegulatorySourceBinding[],
): string {
  const digest = sha256Json({
    schema: "EVLLM_FINAL_EVALUATION_SET_V2",
    primary: primaryCorpus,
    synthesis: synthesisCorpus,
    regulatorySources,
  });
  return `evllm-final-evaluation-v2-${digest.slice(2, 18)}`;
}

export function jsonFileBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256Bytes(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Json(value: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
