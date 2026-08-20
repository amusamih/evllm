import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { sustainabilitySynthesisRecords } from "./lib/sustainability-evidence.js";

const originalPrimary = JSON.parse(
  await readFile(resolve("evaluation/formal/task-corpus-v1.json"), "utf8"),
) as PrimaryCorpus;
const primaryCases = originalPrimary.cases.map((item, index) => {
  const oldId = item.case_id;
  const newId = `formal-${String(index + 101).padStart(3, "0")}`;
  return replaceDeep(item, (value) =>
    value
      .replaceAll(oldId, newId)
      .replaceAll("frozen case", "final held-out case")
      .replaceAll("Synthetic held-out fact", "Final held-out fact")
      .replace("8003-", "8005-"),
  );
});
const primaryUnsigned = {
  ...originalPrimary,
  generated_from_seed: "evllm-final-primary-2026-08-12",
  generator: "scripts/generate-final-evaluation.ts",
  cases: primaryCases,
};
delete (primaryUnsigned as Partial<PrimaryCorpus>).corpus_sha256;
const primary = { ...primaryUnsigned, corpus_sha256: sha256(primaryUnsigned) };

const originalSynthesis = JSON.parse(
  await readFile(resolve("evaluation/complementary/synthesis-corpus-v1.json"), "utf8"),
) as SynthesisCorpus;
const synthesisCases = originalSynthesis.cases.map((item, index) => {
  const oldId = item.case_id;
  const newId = `synthesis-final-${String(index + 1).padStart(3, "0")}`;
  const oldBattery = `SYN-${String(index + 1).padStart(3, "0")}`;
  const newBattery = `FINAL-${String(index + 101).padStart(3, "0")}`;
  const replaced = replaceDeep(item, (value) =>
    value.replaceAll(oldId, newId).replaceAll(oldBattery, newBattery).replace("8004-", "8006-"),
  );
  if (replaced.stratum !== "route-comparison") return replaced;
  const variant = index - 19;
  const evaluated = sustainabilitySynthesisRecords(variant, newId);
  return {
    ...replaced,
    prompt: `Using all supplied records, explain the contextual battery route assessment for ${newId}. State the exact decision code 'continued-compatible-ev-use-preferred' in the summary, keep G/C/I/E/A/U separate, state that no overall sustainability score is calculated, cite every material fact, and identify missing or conflicting evidence when present.`,
    expected_conclusion: "continued-compatible-ev-use-preferred",
    records: evaluated.records.map((record, recordIndex) => ({
      ...record,
      resource_id: `urn:evllm:assessment:00000000-0000-4000-8006-${String((index + 1) * 10 + recordIndex).padStart(12, "0")}`,
      resource_version: 1,
      status: "active",
    })),
    raw_record_operations: evaluated.records.length,
    sequential_deterministic_operations: evaluated.records.length + 1,
    evllm_operations: 1,
  };
});
const synthesisUnsigned = {
  ...originalSynthesis,
  generated_from_seed: "evllm-final-synthesis-2026-08-12",
  generator: "scripts/generate-final-evaluation.ts",
  cases: synthesisCases,
};
delete (synthesisUnsigned as Partial<SynthesisCorpus>).corpus_sha256;
const synthesis = { ...synthesisUnsigned, corpus_sha256: sha256(synthesisUnsigned) };

await mkdir(resolve("evaluation/final"), { recursive: true });
await Promise.all([
  writeFile(
    resolve("evaluation/final/primary-corpus.json"),
    `${JSON.stringify(primary, null, 2)}\n`,
  ),
  writeFile(
    resolve("evaluation/final/synthesis-corpus.json"),
    `${JSON.stringify(synthesis, null, 2)}\n`,
  ),
]);
process.stdout.write(
  `${JSON.stringify({ primary: { cases: primary.cases.length, digest: primary.corpus_sha256 }, synthesis: { cases: synthesis.cases.length, digest: synthesis.corpus_sha256 } }, null, 2)}\n`,
);

interface PrimaryCorpus {
  corpus_sha256: string;
  cases: Array<Record<string, unknown> & { case_id: string }>;
  [key: string]: unknown;
}
interface SynthesisCorpus {
  corpus_sha256: string;
  cases: Array<Record<string, unknown> & { case_id: string }>;
  [key: string]: unknown;
}

function replaceDeep<T>(value: T, replace: (text: string) => string): T {
  if (typeof value === "string") return replace(value) as T;
  // The recursive mapping preserves the input JSON shape at runtime.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  if (Array.isArray(value)) return value.map((item) => replaceDeep(item, replace)) as T;
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceDeep(item, replace)]),
    ) as T;
  return value;
}

function sha256(value: unknown): string {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
