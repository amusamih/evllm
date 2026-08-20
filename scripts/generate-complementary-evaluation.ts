import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  "route-comparison": "route-reuse-preferred",
  "custody-replica": "replica-recovery-permitted",
};
const cases = strata.flatMap((stratum, stratumIndex) =>
  Array.from({ length: 5 }, (_, variantIndex) => {
    const ordinal = stratumIndex * 5 + variantIndex + 1;
    const id = `synthesis-${ordinal.toString().padStart(3, "0")}`;
    const records = recordContents(stratum, ordinal).map((content, index) => ({
      support_id: `${id}-record-${String(index + 1)}`,
      resource_id: `urn:evllm:evidence:00000000-0000-4000-8004-${String(ordinal * 10 + index).padStart(12, "0")}`,
      resource_version: 1,
      status: "active" as const,
      content,
    }));
    const conclusion = conclusions[stratum];
    return {
      case_id: id,
      stratum,
      variant: variantIndex + 1,
      prompt: `Using all supplied records, explain the decision for ${id}. State the exact decision code '${conclusion}' in the summary, cite every material fact, and identify missing or conflicting evidence when present.`,
      expected_conclusion: conclusion,
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
  schema: "EVLLM_COMPLEMENTARY_SYNTHESIS_CORPUS_V1",
  version: 1,
  generated_from_seed: "evllm-complementary-synthesis-v1-2026-08-12",
  source_class: "fresh-synthetic-generator",
  generator: "scripts/generate-complementary-evaluation.ts",
  case_count: cases.length,
  strata: [...strata],
  cases,
};
const corpus = { ...unsigned, corpus_sha256: sha256(unsigned) };
await mkdir(resolve("evaluation/complementary"), { recursive: true });
await writeFile(
  resolve("evaluation/complementary/synthesis-corpus-v1.json"),
  `${JSON.stringify(corpus, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify({ cases: cases.length, digest: corpus.corpus_sha256 })}\n`);

function recordContents(stratum: (typeof strata)[number], ordinal: number): string[] {
  const battery = `Battery SYN-${String(ordinal).padStart(3, "0")}`;
  if (stratum === "resale-readiness")
    return [
      `${battery} has recorded owner Organization Seller-${ordinal}.`,
      `${battery} has active verifier status and state of health ${80 + (ordinal % 5)} percent.`,
      `${battery} has a current transport inspection with no blocking defect.`,
      `The active resale rule permits listing when ownership, verification, state of health, and transport inspection are current.`,
    ];
  if (stratum === "missing-evidence")
    return [
      `${battery} has recorded owner Organization Seller-${ordinal}.`,
      `${battery} has active verifier status and state of health ${76 + (ordinal % 5)} percent.`,
      `${battery} has no current transport inspection record.`,
      `The active resale rule requires a current transport inspection, so absence is blocking evidence.`,
    ];
  if (stratum === "conflicting-evidence")
    return [
      `${battery} inspection record A reports state of health ${81 + (ordinal % 3)} percent.`,
      `${battery} inspection record B reports state of health ${62 + (ordinal % 3)} percent for the same effective time.`,
      `The active conflict rule prohibits automated eligibility when equally current measurements materially disagree.`,
      `The conflict must be referred to an accountable verifier before a marketplace decision.`,
    ];
  if (stratum === "lifecycle-eligibility")
    return [
      `${battery} is active and is not locked by an agreement or dispute.`,
      `${battery} is controlled by the recorded owner Organization Seller-${ordinal}.`,
      `The requested lifecycle action is supported by an active decision-critical evidence version.`,
      `The lifecycle rule permits the action when ownership, unlocked state, and evidence support all hold.`,
    ];
  if (stratum === "route-comparison")
    return [
      `${battery} reuse route score is ${82 + (ordinal % 4)} points under the frozen assessment profile.`,
      `${battery} recycling route score is ${64 + (ordinal % 4)} points under the same profile.`,
      `${battery} remanufacturing route score is ${73 + (ordinal % 4)} points under the same profile.`,
      `The deterministic comparison rule selects the highest admissible score when uncertainty does not reverse ranking.`,
      `The uncertainty analysis for ${battery} does not reverse the route ranking.`,
    ];
  return [
    `${battery} primary repository is temporarily unavailable.`,
    `${battery} has a canonically confirmed decision-critical bundle commitment.`,
    `${battery} neutral replica envelope digest and stored length match the confirmed commitment.`,
    `The requesting organization has an active scoped grant and recipient envelope.`,
    `The recovery rule permits byte-identical replica retrieval only when commitment, grant, and envelope checks all pass.`,
  ];
}

function sha256(value: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
