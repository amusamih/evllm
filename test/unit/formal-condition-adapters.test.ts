import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
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
  formalCorpus,
  scoreFormalObservation,
  type FormalCase,
} from "../../src/evaluation/formal.js";

const corpus = formalCorpus.parse(
  JSON.parse(readFileSync(resolve("evaluation/formal/task-corpus-v1.json"), "utf8")),
);
const context = (reply: (input: ModelInput) => AssistantCandidate) => ({
  model: new ScriptedAssistantModel(reply, "matched-scripted-model"),
  purposeId: urn("policy", 1),
  asOf: 200,
  session: {
    sessionId: urn("session", 1),
    actorId: urn("actor", 1),
    organizationId: urn("org", 1),
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
      "ablation-provenance-metadata": "provenance_enforcement",
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

  it("removes support only for the ungrounded condition and strips metadata for its ablation", async () => {
    const item = find("formal-001");
    const seen = new Map<string, ModelInput>();
    const adapters = createFormalModelConditionAdapters();
    for (const id of [
      "ungrounded-model",
      "ordinary-rag",
      "ablation-provenance-metadata",
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
    expect(seen.get("ablation-provenance-metadata")?.supports[0]).toMatchObject({
      status: "active",
      chain_reference: null,
      commitment: "metadata-withheld",
    });
  });

  it("isolates access, conflict, rule and validation controls", async () => {
    const adapters = createFormalModelConditionAdapters();
    const modelAnswer = (item: FormalCase) => context(() => answer(item));

    const denied = find("formal-006");
    expect(
      (await adapters.get("governed-evllm")?.execute(denied, modelAnswer(denied)))?.model_invoked,
    ).toBe(false);
    expect(
      (await adapters.get("ablation-access-enforcement")?.execute(denied, modelAnswer(denied)))
        ?.model_invoked,
    ).toBe(true);

    const conflict = find("formal-004");
    expect(
      (await adapters.get("governed-evllm")?.execute(conflict, modelAnswer(conflict)))
        ?.model_invoked,
    ).toBe(false);
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
          validation_codes: governedExternal.validation_codes,
          claims: governedExternal.result.candidate.claims,
        }).task_success,
      ).toBe(1);
    }
    expect(
      (await adapters.get("ablation-deterministic-rules")?.execute(external, modelAnswer(external)))
        ?.model_invoked,
    ).toBe(true);

    const invalid = context(() => ({
      outcome: "answer",
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
