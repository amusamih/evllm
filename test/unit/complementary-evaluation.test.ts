import { describe, expect, it } from "vitest";

import {
  complementaryAnalyticReference,
  expectedSynthesisOutcome,
  scoreComplementaryRawGeneration,
  scoreComplementarySynthesis,
  type ComplementarySynthesisCase,
  type ComplementarySynthesisObservation,
} from "../../src/evaluation/complementary.js";
import { COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP } from "../../src/evaluation/complementary-metrics.js";
import { sustainabilitySynthesisRecords } from "../../scripts/lib/sustainability-evidence.js";

const answerCase: ComplementarySynthesisCase = {
  case_id: "synthesis-test-001",
  stratum: "resale-readiness",
  prompt: "Explain the resale decision and state the exact decision code eligible-for-resale.",
  expected_conclusion: "eligible-for-resale",
  expected_detection: null,
  expected_outcome: "answer",
  records: [
    {
      support_id: "record-1",
      resource_id: "urn:evllm:evidence:00000000-0000-4000-8000-000000000001",
      resource_version: 1,
      status: "active",
      content:
        "Battery B-1 has recorded ownership and is eligible for resale. The exact decision code is 'eligible-for-resale'.",
      recorded_decision: {
        outcome: "answer",
        code: "eligible-for-resale",
        reason_codes: [],
      },
    },
  ],
  evllm_operations: 1,
};

const validObservation: ComplementarySynthesisObservation = {
  outcome: "answer",
  decision_code: "eligible-for-resale",
  summary: "The exact decision code is eligible-for-resale.",
  warnings: [],
  missing_requirements: [],
  evidence_reason_codes: [],
  validation_status: "passed",
  validation_codes: [],
  claims: [
    {
      text: "Battery B-1 has recorded ownership and is eligible for resale. The recorded decision code is eligible-for-resale.",
      citation_ids: ["record-1"],
    },
  ],
};

describe("complementary synthesis scoring", () => {
  it("accepts a pipeline-validated response with the expected outcome and supported claims", () => {
    expect(scoreComplementarySynthesis(validObservation, answerCase)).toMatchObject({
      recorded_decision_preservation: 1,
      structured_outcome_accuracy: 1,
      recorded_decision_and_outcome_accuracy: 1,
      unsupported_claim_count: 0,
      pipeline_validation_accuracy: 1,
      single_response_supported_synthesis_success: 1,
    });
  });

  it("accepts exact generated G/C/I/E/A/U route records without construing C as an overall score", () => {
    for (let variant = 1; variant <= 5; variant += 1) {
      const caseId = `synthesis-route-${String(variant)}`;
      const generated = sustainabilitySynthesisRecords(variant, caseId);
      const records = generated.records.map((record, index) => ({
        ...record,
        resource_id: `urn:evllm:assessment:00000000-0000-4000-8006-${String(index + 1).padStart(12, "0")}`,
        resource_version: 1,
        status: "active" as const,
      }));
      const routeText = records
        .slice(1, 4)
        .map(({ content }) => content)
        .join(" ");
      expect(routeText).toContain("G=PASS (technical and safety gate)");
      expect(routeText).toContain("C=100/100 (circularity)");
      expect(routeText).toContain("(environmental indicators)");
      expect(routeText).toContain("(economics)");
      expect(routeText).toContain("(information adequacy)");
      expect(routeText).toContain("(uncertainty)");
      const item: ComplementarySynthesisCase = {
        case_id: caseId,
        stratum: "route-comparison",
        prompt:
          "Explain the contextual route assessment, keep G/C/I/E/A/U separate, and state whether an overall sustainability score is calculated.",
        expected_conclusion: "continued-compatible-ev-use-preferred",
        expected_detection: null,
        expected_outcome: "answer",
        records,
        evllm_operations: 1,
      };
      const observation: ComplementarySynthesisObservation = {
        outcome: "answer",
        decision_code: "continued-compatible-ev-use-preferred",
        summary: "The exact decision code is continued-compatible-ev-use-preferred.",
        warnings: [],
        missing_requirements: [],
        evidence_reason_codes: [],
        validation_status: "passed",
        validation_codes: [],
        claims: records.map((record) => ({
          text: record.content,
          citation_ids: [record.support_id],
        })),
      };
      expect(scoreComplementarySynthesis(observation, item)).toMatchObject({
        required_record_coverage: 1,
        unsupported_claim_count: 0,
        pipeline_validation_accuracy: 1,
        single_response_supported_synthesis_success: 1,
      });
    }
  });

  it("scores a faithful comma-delimited route explanation as complete synthesis", () => {
    const generated = sustainabilitySynthesisRecords(2, "synthesis-route-paraphrase");
    const records = generated.records.map((record, index) => ({
      ...record,
      resource_id: `urn:evllm:assessment:00000000-0000-4000-8006-${String(index + 1).padStart(12, "0")}`,
      resource_version: 1,
      status: "active" as const,
    }));
    const item: ComplementarySynthesisCase = {
      case_id: "synthesis-route-paraphrase",
      stratum: "route-comparison",
      prompt:
        "Compare the three routes while keeping the six route-assessment components separate.",
      expected_conclusion: "continued-compatible-ev-use-preferred",
      expected_detection: null,
      expected_outcome: "answer",
      records,
      evllm_operations: 1,
    };
    const routeClaims = [
      "For continued compatible EV use, the assessment reports G=PASS, C=100/100, I=[gwp=4.25 kg CO2-eq/service; mineral-depletion=1 kg Sb-eq/service], E=NPV 10 EUR and payback 2, A=usable-field coverage 1, verified fraction 0.5, conflicts 0, U=eligibility-pass frequency 1, rank stable=true.",
      "For stationary storage repurposing, the G component is PASS, C is 75/100, I includes gwp of 4.25 kg CO2-eq/service and mineral-depletion of 1 kg Sb-eq/service, E has NPV of 8 EUR and payback of 2, A shows usable-field coverage of 1 with verified fraction of 0.5 and no conflicts, and U has eligibility-pass frequency of 1 with stable rank.",
      "For recycling, the assessment shows G=PASS, C=50/100, I=[gwp=4.25 kg CO2-eq/service; mineral-depletion=1 kg Sb-eq/service], E=NPV 6 EUR and payback 2, A=usable-field coverage 1, verified fraction 0.5, conflicts 0, U=eligibility-pass frequency 1, rank stable=true.",
    ];
    const observation: ComplementarySynthesisObservation = {
      outcome: "answer",
      decision_code: "continued-compatible-ev-use-preferred",
      summary:
        "The recorded route decision is continued-compatible-ev-use-preferred. The recorded decision code is continued-compatible-ev-use-preferred.",
      warnings: [],
      missing_requirements: [],
      evidence_reason_codes: [],
      validation_status: "passed",
      validation_codes: [],
      claims: [
        { text: records[0]!.content, citation_ids: [records[0]!.support_id] },
        ...routeClaims.map((text, index) => ({
          text,
          citation_ids: [records[index + 1]!.support_id],
        })),
        { text: records[4]!.content, citation_ids: [records[4]!.support_id] },
      ],
    };
    expect(scoreComplementarySynthesis(observation, item)).toMatchObject({
      required_record_coverage: 1,
      unsupported_claim_count: 0,
      pipeline_validation_accuracy: 1,
      single_response_supported_synthesis_success: 1,
    });
  });

  it("rejects the right decision code when the structured outcome is wrong", () => {
    const missingCase: ComplementarySynthesisCase = {
      ...answerCase,
      stratum: "missing-evidence",
      expected_conclusion: "insufficient-evidence",
      expected_detection: "missing",
      expected_outcome: "abstain",
      records: [
        {
          ...answerCase.records[0]!,
          content:
            "A required safety report is missing, so the exact decision code is insufficient-evidence.",
          recorded_decision: {
            outcome: "abstain",
            code: "insufficient-evidence",
            reason_codes: ["missing-evidence"],
          },
        },
      ],
    };
    const score = scoreComplementarySynthesis(
      {
        ...validObservation,
        outcome: "answer",
        decision_code: "insufficient-evidence",
        summary: "The exact decision code is insufficient-evidence.",
        evidence_reason_codes: ["missing-evidence"],
        claims: [
          {
            text: "A required safety report is missing, so the decision is insufficient-evidence.",
            citation_ids: ["record-1"],
          },
        ],
      },
      missingCase,
    );
    expect(expectedSynthesisOutcome(missingCase)).toBe("abstain");
    expect(score.recorded_decision_preservation).toBe(1);
    expect(score.structured_outcome_accuracy).toBe(0);
    expect(score.recorded_decision_and_outcome_accuracy).toBe(0);
    expect(score.missing_information_detection).toBe(1);
    expect(score.conflicting_information_detection).toBeNull();
    expect(score.single_response_supported_synthesis_success).toBe(0);
  });

  it("reports conflicting-information detection separately from missing information", () => {
    const conflictingCase: ComplementarySynthesisCase = {
      ...answerCase,
      stratum: "conflicting-evidence",
      expected_conclusion: "external-decision-required",
      expected_detection: "conflict",
      expected_outcome: "requires_external_decision",
      records: [
        {
          ...answerCase.records[0]!,
          content:
            "Two current measurements conflict, so the exact decision code is external-decision-required.",
          recorded_decision: {
            outcome: "requires_external_decision",
            code: "external-decision-required",
            reason_codes: ["conflicting-evidence", "external-decision-required"],
          },
        },
      ],
    };
    const score = scoreComplementarySynthesis(
      {
        ...validObservation,
        outcome: "requires_external_decision",
        decision_code: "external-decision-required",
        summary: "The exact decision code is external-decision-required.",
        evidence_reason_codes: ["conflicting-evidence", "external-decision-required"],
        claims: [
          {
            text: "Two current measurements conflict, so the decision is external-decision-required.",
            citation_ids: ["record-1"],
          },
        ],
      },
      conflictingCase,
    );
    expect(score.missing_information_detection).toBeNull();
    expect(score.conflicting_information_detection).toBe(1);

    const conflictDetectedWithoutReferralReason = scoreComplementarySynthesis(
      {
        ...validObservation,
        outcome: "requires_external_decision",
        decision_code: "external-decision-required",
        summary: "The records contain conflicting measurements.",
        evidence_reason_codes: ["conflicting-evidence"],
        claims: [
          {
            text: "Two current measurements conflict.",
            citation_ids: ["record-1"],
          },
        ],
      },
      conflictingCase,
    );
    expect(conflictDetectedWithoutReferralReason.conflicting_information_detection).toBe(1);
    expect(conflictDetectedWithoutReferralReason.recorded_decision_and_outcome_accuracy).toBe(1);
    expect(conflictDetectedWithoutReferralReason.pipeline_validation_accuracy).toBe(0);
    expect(conflictDetectedWithoutReferralReason.single_response_supported_synthesis_success).toBe(
      0,
    );
  });

  it.each([
    "The recorded decision code is not eligible-for-resale.",
    "The recorded decision code is not-eligible-for-resale.",
    "The code eligible-for-resale does not apply.",
  ])(
    "rejects a negated or invented summary even when the structured code is correct: %s",
    (summary) => {
      const score = scoreComplementarySynthesis({ ...validObservation, summary }, answerCase);
      expect(score.recorded_decision_preservation).toBe(1);
      expect(score.pipeline_validation_accuracy).toBe(0);
      expect(score.single_response_supported_synthesis_success).toBe(0);
    },
  );

  it.each([
    "The exact decision code is eligible-for-resale.",
    "The recorded decision code: eligible-for-resale.",
    "For Battery B-1, the recorded decision is eligible-for-resale.",
  ])("uses the structured decision code rather than one rigid summary grammar: %s", (summary) => {
    const score = scoreComplementarySynthesis({ ...validObservation, summary }, answerCase);
    expect(score.recorded_decision_preservation).toBe(1);
    expect(score.recorded_decision_and_outcome_accuracy).toBe(1);
  });

  it("reports raw model outcome, reason, code, coverage, and binding separately", () => {
    const validScore = scoreComplementaryRawGeneration(validObservation, answerCase);
    expect(validScore).toMatchObject({
      all_required_records_covered: 1,
      deterministic_record_binding: 1,
      decision_code_accuracy: 1,
      structured_outcome_accuracy: 1,
      required_reason_accuracy: 1,
    });
    for (const artifactField of Object.values(COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP)) {
      expect(validScore).toHaveProperty(artifactField);
    }

    const wrongOutcome = scoreComplementaryRawGeneration(
      { ...validObservation, outcome: "abstain" },
      answerCase,
    );
    expect(wrongOutcome.structured_outcome_accuracy).toBe(0);
    expect(wrongOutcome.deterministic_record_binding).toBe(0);
    expect(wrongOutcome.generation_success).toBe(0);

    const wrongCode = scoreComplementaryRawGeneration(
      { ...validObservation, decision_code: "another-decision" },
      answerCase,
    );
    expect(wrongCode.decision_code_accuracy).toBe(0);
    expect(wrongCode.deterministic_record_binding).toBe(0);
    expect(wrongCode.generation_success).toBe(0);
  });

  it.each([
    "Battery B-1 has recorded ownership but is not eligible for resale.",
    "Battery B-1 has recorded ownership and is eligible for resale, so it is legally certified.",
    "Battery B-1 has recorded ownership and is eligible for resale and legally certified.",
  ])("rejects a contradictory or unsupported synthesized inference: %s", (text) => {
    const score = scoreComplementarySynthesis(
      {
        ...validObservation,
        claims: [{ text, citation_ids: ["record-1"] }],
      },
      answerCase,
    );
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.pipeline_validation_accuracy).toBe(0);
    expect(score.single_response_supported_synthesis_success).toBe(0);
  });

  it("rejects an unsupported inference appended to an otherwise correct summary", () => {
    const score = scoreComplementarySynthesis(
      {
        ...validObservation,
        summary:
          "The exact decision code is eligible-for-resale. The battery is therefore legally certified.",
      },
      answerCase,
    );
    expect(score.recorded_decision_preservation).toBe(1);
    expect(score.pipeline_validation_accuracy).toBe(0);
    expect(score.single_response_supported_synthesis_success).toBe(0);
  });

  it("rejects unsupported factual text outside the claims array", () => {
    for (const patch of [
      { summary: "The battery has a magical twenty-year warranty and free replacement." },
      { warnings: ["The battery has a magical twenty-year warranty and free replacement."] },
      {
        missing_requirements: [
          "The battery has a magical twenty-year warranty and free replacement.",
        ],
      },
    ]) {
      const score = scoreComplementarySynthesis({ ...validObservation, ...patch }, answerCase);
      expect(score.pipeline_validation_accuracy).toBe(0);
      expect(score.single_response_supported_synthesis_success).toBe(0);
    }
  });

  it("uses governed lexical support semantics instead of citation-ID presence alone", () => {
    const score = scoreComplementarySynthesis(
      {
        ...validObservation,
        claims: [
          {
            text: "The battery has an imaginary twenty-year warranty.",
            citation_ids: ["record-1"],
          },
        ],
      },
      answerCase,
    );
    expect(score.citation_validity).toBe(1);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.pipeline_validation_accuracy).toBe(0);
    expect(score.single_response_supported_synthesis_success).toBe(0);
  });

  it("does not treat an inactive record ID as valid support", () => {
    const score = scoreComplementarySynthesis(validObservation, {
      ...answerCase,
      records: [{ ...answerCase.records[0]!, status: "superseded" }],
    });
    expect(score.required_record_coverage).toBe(0);
    expect(score.citation_validity).toBe(0);
    expect(score.unsupported_claim_count).toBe(1);
    expect(score.pipeline_validation_accuracy).toBe(0);
  });

  it("does not count an unvalidated or rejected response as complete synthesis", () => {
    const rejected = scoreComplementarySynthesis(
      {
        ...validObservation,
        validation_status: "rejected",
        validation_codes: ["unsupported-claim"],
      },
      answerCase,
    );
    const legacyWithoutValidation = scoreComplementarySynthesis(
      {
        outcome: validObservation.outcome,
        decision_code: validObservation.decision_code,
        summary: validObservation.summary,
        warnings: validObservation.warnings,
        missing_requirements: validObservation.missing_requirements,
        evidence_reason_codes: validObservation.evidence_reason_codes,
        claims: validObservation.claims,
      },
      answerCase,
    );
    expect(rejected.pipeline_validation_accuracy).toBe(0);
    expect(rejected.single_response_supported_synthesis_success).toBe(0);
    expect(legacyWithoutValidation.pipeline_validation_accuracy).toBe(0);
  });

  it("marks response-quality metrics as not applicable for analytic reference interfaces", () => {
    const fixture = {
      ...answerCase,
      raw_record_operations: 4,
      sequential_deterministic_operations: 5,
    };
    for (const condition of [
      "raw-structured-record-access",
      "sequential-deterministic-query",
    ] as const) {
      const reference = complementaryAnalyticReference(fixture, condition);
      expect(reference.operation_count).toBe(condition.startsWith("raw") ? 4 : 5);
      expect(reference).toMatchObject({
        required_record_coverage: null,
        recorded_decision_preservation: null,
        structured_outcome_accuracy: null,
        citation_validity: null,
        unsupported_claim_rate: null,
        claim_count: null,
        pipeline_validation_accuracy: null,
        single_response_supported_synthesis_success: null,
      });
    }
  });

  it("rejects unknown or incoherent evidence reason codes", () => {
    expect(
      scoreComplementarySynthesis(
        { ...validObservation, evidence_reason_codes: ["conflicting-evidence"] },
        answerCase,
      ).single_response_supported_synthesis_success,
    ).toBe(0);
    expect(
      scoreComplementarySynthesis(
        { ...validObservation, evidence_reason_codes: ["made-up-reason"] },
        answerCase,
      ).single_response_supported_synthesis_success,
    ).toBe(0);
  });
});
