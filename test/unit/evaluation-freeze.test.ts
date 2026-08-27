import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OPENAI_ASSISTANT_CONFIG } from "../../src/assistant/model.js";
import { looksLikeEmbeddedInstruction } from "../../src/assistant/semantic-support.js";
import {
  generatedFormalCorpus,
  generatedFormalFreeze,
} from "../../scripts/generate-evaluation-corpus.js";
import { formalCorpus } from "../../src/evaluation/formal.js";
import {
  FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES,
  FINAL_PRIMARY_OUTCOMES,
  FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES,
  jsonFileBytes,
  sha256Bytes,
  sha256Json,
} from "../../src/evaluation/final-freeze.js";
import {
  EU_BATTERIES_REGULATION_CELEX,
  EU_BATTERIES_REGULATION_ELI,
  EU_BATTERIES_REGULATION_EUR_LEX,
} from "../../src/evaluation/regulatory.js";

describe("formal evaluation freeze", () => {
  it("freezes the version-2 model, sample design, outcomes, and case-cluster analysis", () => {
    expect(generatedFormalFreeze).toMatchObject({
      schema: "EVLLM_FORMAL_EVALUATION_FREEZE_V2",
      formalOutputsCollected: false,
      model: {
        ...OPENAI_ASSISTANT_CONFIG,
        repetitionsPerStochasticCondition: 5,
      },
      sampleDesign: {
        plannedModelBearingObservations: 3_840,
        plannedModelInvocations: 1_990,
        plannedModelInvocationsByCondition: {
          "ungrounded-model": 480,
          "ordinary-rag": 480,
          "governed-evllm": 110,
          "ablation-access-enforcement": 175,
          "ablation-source-status-integrity": 350,
          "ablation-conflict-precondition": 170,
          "ablation-deterministic-rules": 115,
          "ablation-output-validation": 110,
        },
        plannedTransportAttemptsMinimum: 1_990,
        plannedTransportAttemptsMaximum: 5_970,
        totalObservationsPlanned: 3_840,
      },
      analysis: {
        resamplingUnit: "case_id",
        pairedContrastOutcomes: [...FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES],
        descriptiveOutcomes: [...FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES],
      },
    });
    expect(generatedFormalFreeze.primaryOutcomes).toHaveLength(10);
    expect(generatedFormalFreeze.primaryOutcomes).toContain("released_typed_decision_fidelity");
    expect(generatedFormalFreeze.primaryOutcomes).toContain("unsupported_claim_response_rate");
    expect(generatedFormalFreeze.primaryOutcomes).toContain(
      "released_response_validation_failure_event",
    );
    expect(generatedFormalFreeze.primaryOutcomes).toContain("prohibited_disclosure_event");
    expect(generatedFormalFreeze.primaryOutcomes).not.toContain("decision_correct");
    expect(
      new Set([...FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES, ...FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES]),
    ).toEqual(new Set(FINAL_PRIMARY_OUTCOMES));
    expect(
      FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES.filter((outcome) =>
        FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES.includes(
          outcome as (typeof FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES)[number],
        ),
      ),
    ).toEqual([]);
  });

  it("contains a balanced 96-case predefined synthetic corpus with executable ground truth", () => {
    expect(generatedFormalCorpus.schema).toBe("EVLLM_FORMAL_TASK_CORPUS_V2");
    expect(generatedFormalCorpus.case_count).toBe(96);
    expect(generatedFormalCorpus.cases).toHaveLength(96);
    expect(new Set(generatedFormalCorpus.cases.map((item) => item.case_id)).size).toBe(96);
    for (const stratum of generatedFormalCorpus.strata) {
      expect(generatedFormalCorpus.cases.filter((item) => item.stratum === stratum)).toHaveLength(
        8,
      );
    }
    for (const item of generatedFormalCorpus.cases) {
      expect(item.formal_only).toBe(true);
      expect(item.prompt.length).toBeGreaterThan(20);
      expect(item.applicable_conditions).toEqual(generatedFormalFreeze.conditions);
      expect(Array.isArray(item.supports)).toBe(true);
    }
  });

  it("uses diverse domain scenarios without exposing oracle annotations in prompts", () => {
    const promptSubjects = new Set(
      generatedFormalCorpus.cases
        .filter(({ variant }) => variant === "nominal")
        .map(({ prompt }) => prompt.replace(/FORMAL-[0-9]{3}/gu, "FORMAL-ID")),
    );
    expect(promptSubjects.size).toBe(12);

    for (const item of generatedFormalCorpus.cases) {
      const prompt = item.prompt.toLowerCase();
      expect(prompt).not.toContain(item.variant.toLowerCase());
      expect(prompt).not.toContain(item.expected_outcome.toLowerCase());
      if (item.expected_validation_code !== null) {
        expect(prompt).not.toContain(item.expected_validation_code.toLowerCase());
      }
      for (const supportId of item.expected_support_ids) {
        expect(prompt).not.toContain(supportId.toLowerCase());
      }
    }

    const multiRecord = generatedFormalCorpus.cases.filter(
      ({ stratum, variant }) =>
        stratum === "multi-record-attribution" && !["missing", "conflicting"].includes(variant),
    );
    expect(multiRecord.every(({ supports }) => supports.length >= 2)).toBe(true);
    const adversarial = generatedFormalCorpus.cases.filter(
      ({ variant }) => variant === "adversarial",
    );
    expect(adversarial).toHaveLength(12);
    expect(
      adversarial.every(
        ({ supports }) =>
          supports.length >= 2 &&
          supports.some(({ content }) => !looksLikeEmbeddedInstruction(content)),
      ),
    ).toBe(true);
    const injectedRecords = adversarial.map(
      ({ supports }) =>
        supports.find(({ content }) => looksLikeEmbeddedInstruction(content))?.content,
    );
    expect(injectedRecords.every((content) => content !== undefined)).toBe(true);
    expect(new Set(injectedRecords).size).toBe(12);
  });

  it("keeps deterministic result records out of factual and no-rules evidence", () => {
    const resultMarker =
      /\b(?:exact decision code|structured outcome|records? .{0,40} as (?:preferred|permitted|eligible|applicable)|therefore enters)\b/iu;
    for (const item of generatedFormalCorpus.cases) {
      const batteryId = item.prompt.match(/\bSYN-[0-9]+\b/u)?.[0];
      for (const support of item.supports) {
        expect(support.support_id).toMatch(/^support-[0-9a-f]{24}$/u);
        expect(support.support_id).not.toContain(item.case_id);
        if (batteryId !== undefined) expect(support.support_id).not.toContain(batteryId);
      }
      if (item.query_mode === "explain_records") {
        expect(
          item.supports.every(({ recorded_decision }) => recorded_decision === undefined),
        ).toBe(true);
        expect(item.supports.some(({ content }) => resultMarker.test(content))).toBe(false);
        continue;
      }
      const decisionRecords = item.supports.filter(
        ({ recorded_decision }) => recorded_decision !== undefined,
      );
      expect(decisionRecords).toHaveLength(1);
      const noRulesSupports = item.supports.filter(
        ({ recorded_decision }) => recorded_decision === undefined,
      );
      expect(noRulesSupports.some(({ content }) => resultMarker.test(content))).toBe(false);
    }
  });

  it("implements a distinct setting-specific edge case in every stratum", () => {
    const edgeCases = generatedFormalCorpus.cases.filter(({ variant }) => variant === "edge");
    expect(edgeCases).toHaveLength(12);
    for (const edgeCase of edgeCases) {
      const nominal = generatedFormalCorpus.cases.find(
        ({ stratum, variant }) => stratum === edgeCase.stratum && variant === "nominal",
      );
      expect(nominal).toBeDefined();
      expect(edgeCase.prompt).not.toBe(nominal?.prompt);
      expect(edgeCase.supports.map(({ content }) => content)).not.toEqual(
        nominal?.supports.map(({ content }) => content),
      );
    }

    const benignInstruction = edgeCases.find(({ stratum }) => stratum === "adversarial-injection");
    expect(benignInstruction).toMatchObject({
      expected_outcome: "answer",
      expected_validation_code: null,
    });
    expect(
      benignInstruction?.supports.every(({ content }) => !looksLikeEmbeddedInstruction(content)),
    ).toBe(true);

    const accessPurpose = edgeCases.find(({ stratum }) => stratum === "actor-purpose-access");
    expect(accessPurpose).toMatchObject({
      expected_outcome: "abstain",
      expected_validation_code: "access-denied",
    });
    expect(accessPurpose?.access_request.organization_id).toBe(
      accessPurpose?.access_grants[0]?.organization_id,
    );
    expect(accessPurpose?.access_request.purpose_id).not.toBe(
      accessPurpose?.access_grants[0]?.purpose_id,
    );
  });

  it("distinguishes the external-authority edge through the user request", () => {
    const nominal = generatedFormalCorpus.cases.find(
      ({ stratum, variant }) =>
        stratum === "insufficient-external-decision" && variant === "nominal",
    );
    const edge = generatedFormalCorpus.cases.find(
      ({ stratum, variant }) => stratum === "insufficient-external-decision" && variant === "edge",
    );
    expect(nominal).toMatchObject({
      expected_outcome: "answer",
      expected_validation_code: null,
    });
    expect(edge).toMatchObject({
      expected_outcome: "requires_external_decision",
      expected_validation_code: "external-decision-boundary",
    });
    expect(nominal?.prompt).not.toMatch(/formally certify/iu);
    expect(edge?.prompt).toMatch(/formally certify/iu);
  });

  it("rejects retired V1 formal-corpus envelopes", () => {
    expect(
      formalCorpus.safeParse({
        ...generatedFormalCorpus,
        schema: "EVLLM_FORMAL_TASK_CORPUS_V1",
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("binds the exact version-2 corpus bytes and logical content", () => {
    const { corpus_sha256: recorded, ...unsigned } = generatedFormalCorpus;
    expect(recorded).toBe(sha256Json(unsigned));
    expect(generatedFormalFreeze.taskCorpus).toMatchObject({
      path: "evaluation/formal/task-corpus-v2.json",
      caseCount: 96,
      strataCount: 12,
      casesPerStratum: 8,
      logicalCorpusSha256: recorded,
      corpusFileSha256: sha256Bytes(jsonFileBytes(generatedFormalCorpus)),
    });
  });

  it("binds the official EU regulatory fixture and its source identifiers", () => {
    expect(generatedFormalFreeze.regulatorySources).toHaveLength(1);
    const source = generatedFormalFreeze.regulatorySources[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    expect(source).toMatchObject({
      fixtureId: "eu-regulation-2023-1542-battery-passport",
      path: "evaluation/fixtures/eu-regulation-2023-1542-articles-77-78.json",
      sourceIdentifier: `CELEX:${EU_BATTERIES_REGULATION_CELEX}`,
      eliUri: EU_BATTERIES_REGULATION_ELI,
      officialEurLexUri: EU_BATTERIES_REGULATION_EUR_LEX,
      jurisdiction: "EU",
      clauseCount: 8,
    });
    expect(source.fixtureFileSha256).toBe(sha256Bytes(readFileSync(resolve(source.path))));
  });
});
