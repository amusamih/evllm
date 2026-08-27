import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { assertOpenAIAssistantConfig, OPENAI_ASSISTANT_CONFIG } from "../src/assistant/model.js";
import {
  COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP,
  COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS,
} from "../src/evaluation/complementary-metrics.js";
import {
  FINAL_SYNTHESIS_CONDITIONS,
  FINAL_SYNTHESIS_PRIMARY_METRICS,
  FINAL_TRANSPORT_RETRIES,
  jsonFileBytes,
  sha256Bytes,
  sha256Json,
} from "../src/evaluation/final-freeze.js";

const strata = [
  "resale-readiness",
  "missing-evidence",
  "conflicting-evidence",
  "lifecycle-eligibility",
  "route-comparison",
  "custody-replica",
] as const;
const conclusions: Record<(typeof strata)[number], string> = {
  "resale-readiness": "eligible-for-resale",
  "missing-evidence": "insufficient-evidence",
  "conflicting-evidence": "external-decision-required",
  "lifecycle-eligibility": "lifecycle-action-permitted",
  "route-comparison": "continued-compatible-ev-use-preferred",
  "custody-replica": "replica-recovery-permitted",
};
const cases = strata.flatMap((stratum, stratumIndex) =>
  Array.from({ length: 5 }, (_, variantIndex) => {
    const ordinal = stratumIndex * 5 + variantIndex + 1;
    const syntheticBatteryNumber = ordinal + 100;
    const id = `synthesis-${syntheticBatteryNumber.toString().padStart(3, "0")}`;
    const conclusion = conclusions[stratum];
    const expectedOutcome =
      stratum === "missing-evidence"
        ? "abstain"
        : stratum === "conflicting-evidence"
          ? "requires_external_decision"
          : "answer";
    const recordedDecision = {
      outcome: expectedOutcome,
      code: conclusion,
      reason_codes:
        stratum === "missing-evidence"
          ? (["missing-evidence"] as const)
          : stratum === "conflicting-evidence"
            ? (["conflicting-evidence", "external-decision-required"] as const)
            : ([] as const),
    } as const;
    const recordText = recordContents(stratum, syntheticBatteryNumber);
    const records = recordText.map((content, index) => ({
      support_id: `${id}-record-${String(index + 1)}`,
      resource_id: `urn:evllm:evidence:00000000-0000-4000-8004-${String(syntheticBatteryNumber * 10 + index).padStart(12, "0")}`,
      resource_version: 1,
      status: "active" as const,
      content,
      ...(index === recordText.length - 1 ? { recorded_decision: recordedDecision } : {}),
    }));
    const battery = `Battery SYN-${String(syntheticBatteryNumber).padStart(3, "0")}`;
    return {
      case_id: id,
      stratum,
      variant: variantIndex + 1,
      prompt: synthesisPrompt(stratum, battery),
      expected_conclusion: conclusion,
      expected_outcome: expectedOutcome,
      expected_detection:
        stratum === "missing-evidence"
          ? "missing"
          : stratum === "conflicting-evidence"
            ? "conflict"
            : null,
      records,
      raw_record_operations: records.length,
      sequential_deterministic_operations: records.length + 1,
      evllm_operations: 1,
    };
  }),
);

const unsigned = {
  schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_CORPUS_V2",
  version: 2,
  generated_from_seed: "evllm-complementary-synthesis-v2-2026-08-27",
  source_class: "synthetic-generator",
  generator: "scripts/generate-complementary-evaluation.ts",
  case_count: cases.length,
  strata: [...strata],
  cases,
};
export const generatedSynthesisCorpus = { ...unsigned, corpus_sha256: sha256Json(unsigned) };
const corpusBytes = jsonFileBytes(generatedSynthesisCorpus);
export const generatedSynthesisFreeze = {
  schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_FREEZE_V2",
  outputsCollected: false,
  corpus: {
    path: "evaluation/complementary/synthesis-corpus-v2.json",
    caseCount: generatedSynthesisCorpus.case_count,
    strataCount: generatedSynthesisCorpus.strata.length,
    casesPerStratum: generatedSynthesisCorpus.case_count / generatedSynthesisCorpus.strata.length,
    logicalCorpusSha256: generatedSynthesisCorpus.corpus_sha256,
    corpusFileSha256: sha256Bytes(corpusBytes),
  },
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
  },
};
assertOpenAIAssistantConfig(
  generatedSynthesisFreeze.model,
  OPENAI_ASSISTANT_CONFIG,
  "Generated complementary freeze",
);

if (isDirectExecution()) {
  const checkOnly = process.argv.includes("--check");
  if (checkOnly) {
    const storedFreeze = JSON.parse(
      await readFile(resolve("evaluation/complementary/synthesis-freeze-v2.json"), "utf8"),
    ) as { model?: unknown };
    assertOpenAIAssistantConfig(
      storedFreeze.model,
      OPENAI_ASSISTANT_CONFIG,
      "Stored complementary freeze",
    );
  } else {
    await mkdir(resolve("evaluation/complementary"), { recursive: true });
    await Promise.all([
      writeFile(resolve("evaluation/complementary/synthesis-corpus-v2.json"), corpusBytes),
      writeFile(
        resolve("evaluation/complementary/synthesis-freeze-v2.json"),
        jsonFileBytes(generatedSynthesisFreeze),
      ),
    ]);
  }
  process.stdout.write(
    `${JSON.stringify({ checked: checkOnly, cases: cases.length, digest: generatedSynthesisCorpus.corpus_sha256 })}\n`,
  );
}

function recordContents(stratum: (typeof strata)[number], batteryNumber: number): string[] {
  const battery = `Battery SYN-${String(batteryNumber).padStart(3, "0")}`;
  if (stratum === "resale-readiness")
    return [
      `${battery} has recorded owner Organization Seller-${batteryNumber}.`,
      `${battery} has active verifier status and state of health ${80 + (batteryNumber % 5)} percent.`,
      `${battery} has a current transport inspection with no blocking defect.`,
      `For ${battery}, after applying the active resale rule to ownership, verification, state of health, and transport inspection, the deterministic service records structured outcome answer and exact decision code is 'eligible-for-resale'.`,
    ];
  if (stratum === "missing-evidence")
    return [
      `${battery} has recorded owner Organization Seller-${batteryNumber}.`,
      `${battery} has active verifier status and state of health ${76 + (batteryNumber % 5)} percent.`,
      `${battery} has no current transport inspection record.`,
      `For ${battery}, because the current transport inspection is missing and the active resale rule requires it, the deterministic service records structured outcome abstain and exact decision code is 'insufficient-evidence'.`,
    ];
  if (stratum === "conflicting-evidence")
    return [
      `${battery} inspection record A reports state of health ${81 + (batteryNumber % 3)} percent.`,
      `${battery} inspection record B reports state of health ${62 + (batteryNumber % 3)} percent for the same effective time.`,
      `The active conflict rule prohibits automated eligibility when equally current measurements materially disagree.`,
      `For ${battery}, because the equally current measurements materially disagree, the deterministic conflict check records structured outcome requires_external_decision and exact decision code is 'external-decision-required' for referral to an accountable verifier.`,
    ];
  if (stratum === "lifecycle-eligibility")
    return [
      `${battery} is active and is not locked by an agreement or dispute.`,
      `${battery} is controlled by the recorded owner Organization Seller-${batteryNumber}.`,
      `The requested lifecycle action is supported by an active decision-critical evidence version.`,
      `For ${battery}, after applying the lifecycle rule to ownership, unlocked state, and evidence support, the deterministic service records structured outcome answer and exact decision code is 'lifecycle-action-permitted'.`,
    ];
  if (stratum === "route-comparison")
    return [
      `${battery} continued compatible EV use has technical gate pass, circularity 100, climate-change indicator 4 kg CO2-eq/service, mineral-depletion indicator 1 kg Sb-eq/service, net present value EUR 10, information adequacy 100 percent, and a stable uncertainty result.`,
      `${battery} stationary-storage repurposing has technical gate pass, circularity 75, climate-change indicator 4 kg CO2-eq/service, mineral-depletion indicator 1 kg Sb-eq/service, net present value EUR 8, information adequacy 100 percent, and a stable uncertainty result.`,
      `${battery} recycling has technical gate pass, circularity 50, climate-change indicator 4 kg CO2-eq/service, mineral-depletion indicator 1 kg Sb-eq/service, net present value EUR 6, information adequacy 100 percent, and a stable uncertainty result.`,
      `For ${battery}, the deterministic comparison retains the six components separately and records continued compatible EV use as the stable preferred route with structured outcome answer and exact decision code is 'continued-compatible-ev-use-preferred'.`,
    ];
  return [
    `${battery} primary repository is temporarily unavailable.`,
    `${battery} has a canonically confirmed decision-critical bundle commitment.`,
    `${battery} neutral replica envelope digest and stored length match the confirmed commitment.`,
    `The requesting organization has an active scoped grant and recipient envelope.`,
    `For ${battery}, after the commitment, grant, and envelope checks pass, the deterministic service records replica recovery as permitted, with structured outcome answer and exact decision code is 'replica-recovery-permitted'.`,
  ];
}

function synthesisPrompt(stratum: (typeof strata)[number], battery: string): string {
  const responseInstructions =
    "Use the structured outcome, decision code, and reason fields for the recorded tuple, and keep the prose to source-linked factual explanation. Place source IDs in the structured claim citations, cite every material fact, and identify missing or conflicting information when present.";
  if (stratum === "route-comparison") {
    return `Using all permitted records, compare the three recorded routes for ${battery} and explain the source facts underlying the separately displayed recorded decision. Retain the six components separately: G is the technical and safety gate, C is circularity, I contains the environmental indicators, E is economics, A is information adequacy, and U is uncertainty. State whether an overall sustainability score is calculated. ${responseInstructions}`;
  }
  return `Using all permitted records, explain the source facts underlying the separately displayed recorded decision for ${battery}. ${responseInstructions}`;
}

function isDirectExecution(): boolean {
  const entryPoint = process.argv[1];
  return entryPoint !== undefined && import.meta.url === pathToFileURL(resolve(entryPoint)).href;
}
