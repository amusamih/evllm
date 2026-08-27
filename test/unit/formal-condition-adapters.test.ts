import { describe, expect, it } from "vitest";

import { generatedFormalCorpus } from "../../scripts/generate-evaluation-corpus.js";
import {
  releaseAssistantCandidateWithRecordedDecision,
  ScriptedAssistantModel,
  type AssistantCandidate,
  type ModelInput,
} from "../../src/assistant/index.js";
import {
  createFormalModelConditionAdapters,
  MODEL_CONDITION_IDS,
  type ModelConditionId,
} from "../../src/evaluation/conditions.js";
import {
  expectedReleasedReasonCodesForFormalCase,
  scoreFormalObservation,
  type FormalCase,
} from "../../src/evaluation/formal.js";

const corpus = generatedFormalCorpus;
const context = (
  reply: (input: ModelInput) => AssistantCandidate,
  accessRequest: FormalCase["access_request"] = {
    organization_id: urn("org", 1),
    purpose_id: urn("policy", 1),
  },
) => ({
  model: new ScriptedAssistantModel(reply, "matched-scripted-model"),
  purposeId: accessRequest.purpose_id,
  asOf: 200,
  session: {
    sessionId: urn("session", 1),
    actorId: urn("actor", 1),
    organizationId: accessRequest.organization_id,
    credentialId: urn("credential", 1),
    address: "0x1111111111111111111111111111111111111111",
    issuedAt: 100,
    expiresAt: 300,
  },
});

describe("formal model-condition adapters", () => {
  it("rejects answer-shaped model output without structured cited claims", async () => {
    const malformed = {
      outcome: "answer",
      summary: "A prose-only answer with an inline citation.",
      evidence_reason_codes: [],
      claims: [],
      warnings: [],
      missing_requirements: [],
    };
    await expect(
      new ScriptedAssistantModel(() => malformed as unknown as AssistantCandidate).generate(
        {} as ModelInput,
      ),
    ).rejects.toThrow();
  });

  it("retains closed machine-readable evidence reason codes", async () => {
    const missing = find("formal-002");
    const execution = await createFormalModelConditionAdapters()
      .get("governed-evllm")
      ?.execute(
        missing,
        context(() => answer(find("formal-001"))),
      );
    expect(execution?.result.candidate.evidence_reason_codes).toEqual(["missing-evidence"]);
  });

  it("implements exactly the eight frozen model-bearing configurations", () => {
    const adapters = createFormalModelConditionAdapters();
    expect([...adapters.keys()]).toEqual(MODEL_CONDITION_IDS);
    expect(adapters.size).toBe(8);
  });

  it("changes one prescribed control in each governed ablation", () => {
    const adapters = createFormalModelConditionAdapters();
    const governed = adapters.get("governed-evllm")?.controls;
    expect(governed).toBeDefined();
    if (governed === undefined) return;
    const mapping: Readonly<
      Record<
        Exclude<ModelConditionId, "ungrounded-model" | "ordinary-rag" | "governed-evllm">,
        keyof typeof governed
      >
    > = {
      "ablation-access-enforcement": "access_enforcement",
      "ablation-source-status-integrity": "provenance_enforcement",
      "ablation-conflict-precondition": "conflict_precondition",
      "ablation-deterministic-rules": "deterministic_rules",
      "ablation-output-validation": "output_validation",
    };
    for (const [id, disabled] of Object.entries(mapping)) {
      const profile = adapters.get(id as ModelConditionId)?.controls;
      expect(profile).toBeDefined();
      if (profile === undefined) continue;
      const changed = Object.keys(governed).filter(
        (key) => profile[key as keyof typeof profile] !== governed[key as keyof typeof governed],
      );
      expect(changed, id).toEqual([disabled]);
      expect(profile[disabled]).toBe(false);
    }
  });

  it("removes support only for the ungrounded condition and disables source-status and integrity checks for its ablation", async () => {
    const item = find("formal-001");
    const seen = new Map<string, ModelInput>();
    const adapters = createFormalModelConditionAdapters();
    for (const id of [
      "ungrounded-model",
      "ordinary-rag",
      "ablation-source-status-integrity",
    ] as const) {
      await adapters.get(id)?.execute(
        item,
        context((input) => {
          seen.set(id, input);
          return answer(item);
        }),
      );
    }
    expect(seen.get("ungrounded-model")?.supports).toHaveLength(0);
    expect(seen.get("ordinary-rag")?.supports).toHaveLength(1);
    expect(seen.get("ablation-source-status-integrity")?.supports[0]).toMatchObject({
      status: "active",
      chain_reference: null,
      commitment: "metadata-withheld",
    });
  });

  it("isolates access, conflict, rule and validation controls", async () => {
    const adapters = createFormalModelConditionAdapters();
    const modelAnswer = (item: FormalCase) => context(() => answer(item));

    const denied = find("formal-006");
    const governedDenied = await adapters
      .get("governed-evllm")
      ?.execute(denied, modelAnswer(denied));
    expect(governedDenied?.model_invoked).toBe(false);
    expect(governedDenied?.validation_codes).toEqual(["access-denied"]);
    if (governedDenied !== undefined) {
      expect(
        scoreFormalObservation(denied, {
          outcome: governedDenied.result.candidate.outcome,
          decision_code: governedDenied.result.candidate.decision_code,
          presented_support_ids: governedDenied.presented_support_ids,
          validation_codes: governedDenied.validation_codes,
          claims: governedDenied.result.candidate.claims,
          summary: governedDenied.result.candidate.summary,
          warnings: governedDenied.result.candidate.warnings,
          missing_requirements: governedDenied.result.candidate.missing_requirements,
          evidence_reason_codes: governedDenied.result.candidate.evidence_reason_codes,
          model_invoked: governedDenied.model_invoked,
        }).task_success,
      ).toBe(1);
    }
    expect(
      (await adapters.get("ablation-access-enforcement")?.execute(denied, modelAnswer(denied)))
        ?.model_invoked,
    ).toBe(true);

    const conflict = find("formal-004");
    const governedConflict = await adapters
      .get("governed-evllm")
      ?.execute(conflict, modelAnswer(conflict));
    expect(governedConflict?.model_invoked).toBe(false);
    expect(governedConflict?.result.candidate.evidence_reason_codes).toEqual(
      expectedReleasedReasonCodesForFormalCase(conflict),
    );
    if (governedConflict !== undefined) {
      expect(
        scoreFormalObservation(conflict, {
          outcome: governedConflict.result.candidate.outcome,
          decision_code: governedConflict.result.candidate.decision_code,
          presented_support_ids: governedConflict.presented_support_ids,
          validation_codes: governedConflict.validation_codes,
          claims: governedConflict.result.candidate.claims,
          summary: governedConflict.result.candidate.summary,
          warnings: governedConflict.result.candidate.warnings,
          missing_requirements: governedConflict.result.candidate.missing_requirements,
          evidence_reason_codes: governedConflict.result.candidate.evidence_reason_codes,
          model_invoked: governedConflict.model_invoked,
        }).task_success,
      ).toBe(1);
    }
    expect(
      (
        await adapters
          .get("ablation-conflict-precondition")
          ?.execute(conflict, modelAnswer(conflict))
      )?.model_invoked,
    ).toBe(true);

    const external = find("formal-087");
    const governedExternal = await adapters
      .get("governed-evllm")
      ?.execute(external, modelAnswer(external));
    expect(governedExternal?.model_invoked).toBe(false);
    expect(governedExternal?.result.candidate).toMatchObject({
      outcome: "requires_external_decision",
      claims: [
        {
          text: external.supports[0]?.content,
          citation_ids: [external.supports[0]?.support_id],
        },
      ],
    });
    if (governedExternal !== undefined) {
      expect(
        scoreFormalObservation(external, {
          outcome: governedExternal.result.candidate.outcome,
          decision_code: governedExternal.result.candidate.decision_code,
          presented_support_ids: governedExternal.presented_support_ids,
          validation_codes: governedExternal.validation_codes,
          claims: governedExternal.result.candidate.claims,
          evidence_reason_codes: governedExternal.result.candidate.evidence_reason_codes,
        }).task_success,
      ).toBe(1);
    }
    expect(
      (await adapters.get("ablation-deterministic-rules")?.execute(external, modelAnswer(external)))
        ?.model_invoked,
    ).toBe(true);

    const invalid = context(() => ({
      outcome: "answer",
      decision_code: null,
      summary: "unsupported",
      evidence_reason_codes: [],
      claims: [{ claim_id: "claim-1", text: "unsupported", citation_ids: ["invalid-support"] }],
      warnings: [],
      missing_requirements: [],
    }));
    const nominal = find("formal-001");
    expect(
      (await adapters.get("governed-evllm")?.execute(nominal, invalid))?.result.candidate.outcome,
    ).toBe("abstain");
    expect(
      (await adapters.get("ablation-output-validation")?.execute(nominal, invalid))?.result
        .candidate.outcome,
    ).toBe("answer");

    const unsupportedWithValidCitation = context(() => ({
      outcome: "answer",
      decision_code: null,
      summary: "unsupported",
      evidence_reason_codes: [],
      claims: [
        {
          claim_id: "claim-1",
          text: "The battery includes an imaginary twenty-year warranty and free replacement.",
          citation_ids: [nominal.supports[0]!.support_id],
        },
      ],
      warnings: [],
      missing_requirements: [],
    }));
    const governedUnsupported = await adapters
      .get("governed-evllm")
      ?.execute(nominal, unsupportedWithValidCitation);
    const unvalidatedUnsupported = await adapters
      .get("ablation-output-validation")
      ?.execute(nominal, unsupportedWithValidCitation);
    expect(governedUnsupported?.validation_codes).toContain("unsupported-claim");
    expect(governedUnsupported?.result.candidate.outcome).toBe("abstain");
    expect(unvalidatedUnsupported?.result.candidate.outcome).toBe("answer");
  });

  it("uses the shared production release path while preserving the raw model candidate", async () => {
    const item = find("formal-015");
    const decision = item.supports.find(
      ({ recorded_decision }) => recorded_decision !== undefined,
    )?.recorded_decision;
    expect(decision).toBeDefined();
    if (decision === undefined) return;
    let presented: Parameters<typeof releaseAssistantCandidateWithRecordedDecision>[1] = [];
    const raw: AssistantCandidate = {
      outcome: decision.outcome,
      decision_code: decision.code,
      summary: "The cited records provide the diagnostic and transport facts.",
      evidence_reason_codes: [...decision.reason_codes],
      claims: item.supports
        .filter(({ recorded_decision }) => recorded_decision === undefined)
        .map((support, index) => ({
          claim_id: `claim-${String(index + 1)}`,
          text: support.content,
          citation_ids: [support.support_id],
        })),
      warnings: [],
      missing_requirements: [],
    };
    const execution = await createFormalModelConditionAdapters()
      .get("governed-evllm")!
      .execute(
        item,
        context((input) => {
          presented = input.supports;
          return raw;
        }),
      );
    const direct = releaseAssistantCandidateWithRecordedDecision(raw, presented, item.prompt, {
      screenExplanation: true,
    });
    expect(execution.result.candidate).toEqual(direct.candidate);
    expect(execution.validation_candidate).toEqual(direct.validation_candidate);
    expect(execution.validation_codes).toEqual(direct.validation_codes);
    expect(execution.model_invocation?.candidate).toEqual(raw);
    expect(raw.summary).toBe("The cited records provide the diagnostic and transport facts.");
  });

  it("binds a structurally valid unsupported model code at release while retaining the raw deviation", async () => {
    const item = find("formal-015");
    const decision = item.supports.find(
      ({ recorded_decision }) => recorded_decision !== undefined,
    )?.recorded_decision;
    expect(decision).toBeDefined();
    if (decision === undefined) return;
    const raw: AssistantCandidate = {
      outcome: "answer",
      decision_code: "battery-passport-requirement",
      summary: "The cited records provide the diagnostic and transport facts.",
      evidence_reason_codes: [],
      claims: item.supports
        .filter(({ recorded_decision }) => recorded_decision === undefined)
        .map((support, index) => ({
          claim_id: `claim-${String(index + 1)}`,
          text: support.content,
          citation_ids: [support.support_id],
        })),
      warnings: [],
      missing_requirements: [],
    };
    const transportContext = () => ({
      ...context(() => raw),
      model: {
        generate: () =>
          Promise.resolve({
            candidate: raw,
            model: "structural-transport-test-model",
            provider: "test-transport",
            responseId: "response-unsupported-code",
            inputTokens: 10,
            outputTokens: 5,
          }),
      },
    });
    const adapters = createFormalModelConditionAdapters();
    const governed = await adapters.get("governed-evllm")!.execute(item, transportContext());
    const withoutValidation = await adapters
      .get("ablation-output-validation")!
      .execute(item, transportContext());

    for (const execution of [governed, withoutValidation]) {
      expect(execution.model_invocation?.candidate).toEqual(raw);
      expect(execution.result.candidate).toMatchObject({
        outcome: decision.outcome,
        decision_code: decision.code,
      });
      expect(execution.validation_codes).toEqual([]);
    }
    expect(raw.decision_code).toBe("battery-passport-requirement");

    const rawScore = scoreFormalObservation(item, {
      outcome: raw.outcome,
      decision_code: raw.decision_code,
      presented_support_ids: governed.presented_support_ids,
      validation_codes: [],
      claims: raw.claims,
      summary: raw.summary,
      warnings: raw.warnings,
      missing_requirements: raw.missing_requirements,
      evidence_reason_codes: raw.evidence_reason_codes,
      model_invoked: true,
    });
    const releasedScore = scoreFormalObservation(item, {
      outcome: governed.result.candidate.outcome,
      decision_code: governed.result.candidate.decision_code,
      presented_support_ids: governed.presented_support_ids,
      validation_codes: governed.validation_codes,
      claims: governed.result.candidate.claims,
      summary: governed.result.candidate.summary,
      warnings: governed.result.candidate.warnings,
      missing_requirements: governed.result.candidate.missing_requirements,
      evidence_reason_codes: governed.result.candidate.evidence_reason_codes,
      model_invoked: true,
    });
    expect(rawScore.decision_correct).toBe(0);
    expect(releasedScore.decision_correct).toBe(1);
  });

  it("removes only the deterministic result record in the no-rules ablation", async () => {
    const item = find("formal-015");
    const decisionSupport = item.supports.find(
      ({ recorded_decision }) => recorded_decision !== undefined,
    );
    expect(decisionSupport).toBeDefined();
    if (decisionSupport === undefined) return;
    const seen = new Map<string, ModelInput>();
    const adapters = createFormalModelConditionAdapters();
    const reply = (id: string) =>
      context((input) => {
        seen.set(id, input);
        return {
          outcome: "answer",
          decision_code: null,
          summary: input.supports[0]?.content ?? "No permitted record is available.",
          evidence_reason_codes: [],
          claims: input.supports.map((support, index) => ({
            claim_id: `claim-${String(index + 1)}`,
            text: support.content,
            citation_ids: [support.support_id],
          })),
          warnings: [],
          missing_requirements: [],
        };
      });
    const noRules = await adapters
      .get("ablation-deterministic-rules")!
      .execute(item, reply("ablation-deterministic-rules"));
    await adapters.get("ordinary-rag")!.execute(item, reply("ordinary-rag"));

    const noRuleSupports = seen.get("ablation-deterministic-rules")?.supports ?? [];
    expect(noRuleSupports.map(({ support_id }) => support_id)).not.toContain(
      decisionSupport.support_id,
    );
    expect(noRuleSupports.some(({ recorded_decision }) => recorded_decision !== undefined)).toBe(
      false,
    );
    expect(JSON.stringify(noRuleSupports)).not.toContain(decisionSupport.recorded_decision?.code);
    expect(noRuleSupports).toHaveLength(item.supports.length - 1);

    const ragSupports = seen.get("ordinary-rag")?.supports ?? [];
    expect(ragSupports.map(({ support_id }) => support_id)).toContain(decisionSupport.support_id);
    expect(ragSupports.some(({ recorded_decision }) => recorded_decision !== undefined)).toBe(
      false,
    );

    const score = scoreFormalObservation(item, {
      configuration_id: "ablation-deterministic-rules",
      outcome: noRules.result.candidate.outcome,
      decision_code: noRules.result.candidate.decision_code,
      presented_support_ids: noRules.presented_support_ids,
      validation_codes: noRules.validation_codes,
      claims: noRules.result.candidate.claims,
      summary: noRules.result.candidate.summary,
      warnings: noRules.result.candidate.warnings,
      missing_requirements: noRules.result.candidate.missing_requirements,
      evidence_reason_codes: noRules.result.candidate.evidence_reason_codes,
      model_invoked: noRules.model_invoked,
    });
    expect(score.required_record_coverage).toBe(1);
    expect(score.decision_correct).toBe(0);
    expect(score.task_success).toBe(0);
  });

  it("derives injection and external-decision behavior from operational input, not oracle labels", async () => {
    const adapter = createFormalModelConditionAdapters().get("governed-evllm")!;
    const injection = find("formal-008");
    const relabeledInjection: FormalCase = {
      ...injection,
      stratum: "benign-sentinel",
      variant: "nominal-sentinel",
      expected_outcome: "answer",
      expected_validation_code: null,
      expected_support_ids: ["oracle-support-sentinel"],
    };
    const injectedExecution = await adapter.execute(
      relabeledInjection,
      context(() => answer(find("formal-001"))),
    );
    expect(injectedExecution).toMatchObject({
      model_invoked: false,
      validation_codes: ["prompt-injection"],
      result: { candidate: { outcome: "abstain" } },
    });

    const nominal = find("formal-001");
    const falselyLabeled: FormalCase = { ...nominal, variant: "adversarial" };
    expect(
      (
        await adapter.execute(
          falselyLabeled,
          context(() => answer(nominal)),
        )
      ).model_invoked,
    ).toBe(true);

    const denied = find("formal-006");
    const relabeledDenied: FormalCase = {
      ...denied,
      stratum: "benign-sentinel",
      variant: "nominal-sentinel",
      expected_outcome: "answer",
      expected_validation_code: null,
    };
    expect(
      await adapter.execute(
        relabeledDenied,
        context(() => answer(denied)),
      ),
    ).toMatchObject({
      model_invoked: false,
      validation_codes: ["access-denied"],
    });
    const operationallyGranted: FormalCase = {
      ...relabeledDenied,
      access_grants: [relabeledDenied.access_request],
    };
    expect(
      (
        await adapter.execute(
          operationallyGranted,
          context(() => answer(operationallyGranted)),
        )
      ).model_invoked,
    ).toBe(true);

    const external = find("formal-087");
    const relabeledExternal: FormalCase = {
      ...external,
      case_id: "formal-999",
      stratum: "benign-sentinel",
      variant: "nominal-sentinel",
      expected_outcome: "answer",
      expected_validation_code: null,
      expected_support_ids: [],
    };
    expect(
      await adapter.execute(
        relabeledExternal,
        context(() => answer(external)),
      ),
    ).toMatchObject({
      model_invoked: false,
      validation_codes: ["external-decision-boundary"],
      result: { candidate: { outcome: "requires_external_decision" } },
    });
  });

  it("never places oracle annotations in model input", async () => {
    const sentinel = "oracle-answer-sentinel";
    const item: FormalCase = {
      ...find("formal-001"),
      stratum: `${sentinel}-stratum`,
      variant: `${sentinel}-variant`,
      expected_validation_code: `${sentinel}-code`,
      expected_support_ids: [`${sentinel}-support`],
    };
    let serializedInput = "";
    await createFormalModelConditionAdapters()
      .get("ordinary-rag")!
      .execute(
        item,
        context((input) => {
          serializedInput = JSON.stringify(input);
          return answer(item);
        }),
      );
    expect(serializedInput).not.toContain(sentinel);
  });

  it("maps every frozen precondition code to the code emitted from operational inputs", async () => {
    const adapter = createFormalModelConditionAdapters().get("governed-evllm")!;
    for (const item of corpus.cases.filter(
      (candidate) => candidate.expected_validation_code !== null,
    )) {
      const result = await adapter.execute(
        item,
        context(() => answer(item), item.access_request),
      );
      expect(result.model_invoked, item.case_id).toBe(false);
      expect(result.validation_codes, item.case_id).toContain(item.expected_validation_code);
    }
  });
});

function find(caseId: string): FormalCase {
  const item = corpus.cases.find(({ case_id }) => case_id === caseId);
  if (item === undefined) throw new Error(`Missing fixture ${caseId}`);
  return item;
}

function answer(item: FormalCase): AssistantCandidate {
  const support = item.supports[0];
  return {
    outcome: "answer",
    decision_code: null,
    summary: "supported",
    evidence_reason_codes: [],
    claims:
      support === undefined
        ? []
        : [{ claim_id: "claim-1", text: support.content, citation_ids: [support.support_id] }],
    warnings: [],
    missing_requirements: [],
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
