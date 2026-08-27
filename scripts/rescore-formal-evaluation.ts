import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formalCorpus } from "../src/evaluation/formal.js";
import type { EvaluationBinding } from "../src/evaluation/final-integrity.js";
import { storedObservationSchema } from "../src/evaluation/live.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";
import { deriveFormalScores, formalScoreDerivationAuditSchema } from "./lib/formal-rescoring.js";

const finalRun = process.argv.includes("--final");
const resultRelativeDirectory = finalRun
  ? "evaluation/final/results/primary"
  : "evaluation/formal/results/run-v2";
const allowedResultDirectories = finalRun
  ? ["evaluation/final/results/primary", "evaluation/final/results/synthesis"]
  : [resultRelativeDirectory];
const resultDirectory = resolve(resultRelativeDirectory);
const corpusPath = resolve(
  finalRun ? "evaluation/final/primary-corpus.json" : "evaluation/formal/task-corpus-v2.json",
);
const observationPath = resolve(resultDirectory, "observations.jsonl");
const configManifest = JSON.parse(
  await readFile(resolve(resultDirectory, "evaluation-config-manifest.json"), "utf8"),
) as EvaluationBinding;
const currentSource = assertCommittedEvaluationSource(allowedResultDirectories, {
  expectedSourceCommit: configManifest.source_commit,
  operation: "Primary score derivation",
});

const corpus = formalCorpus.parse(JSON.parse(await readFile(corpusPath, "utf8")));
const observationBytes = await readFile(observationPath);
const observationsSha256 = sha256(observationBytes);
const collectedObservations = observationBytes
  .toString("utf8")
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0)
  .map((line, index) => {
    try {
      return storedObservationSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`Invalid primary observation JSONL at line ${String(index + 1)}`, {
        cause: error,
      });
    }
  });
const derived = deriveFormalScores(corpus, collectedObservations);

const audit = formalScoreDerivationAuditSchema.parse({
  schema: "EVLLM_FORMAL_SCORE_DERIVATION_AUDIT_V1",
  generated_at: new Date().toISOString(),
  evaluation_set_id: configManifest.evaluation_set_id,
  collection_source_commit: configManifest.source_commit,
  analysis_source_commit: currentSource.sourceCommit,
  freeze_sha256: configManifest.freeze_sha256,
  corpus_file_sha256: configManifest.corpus_file_sha256,
  logical_corpus_sha256: configManifest.logical_corpus_sha256,
  observations_sha256: observationsSha256,
  observations: collectedObservations.length,
  stored_score_differences: derived.changedObservationIds.length,
  changed_scores: derived.scoreRecords.filter((record) => record.differs_from_stored_score),
  raw_observations_modified: false,
  note: "Scores are derived from the checksum-bound collected response and validation fields. This artifact does not replace or rewrite observations.jsonl.",
});
await writeFile(
  resolve(resultDirectory, "score-derivation-audit.json"),
  `${JSON.stringify(audit, null, 2)}\n`,
);

const observationBytesAfter = await readFile(observationPath);
if (sha256(observationBytesAfter) !== observationsSha256) {
  throw new Error("Primary score derivation changed the raw observation file");
}
process.stdout.write(
  `${JSON.stringify(
    {
      output: `${resultRelativeDirectory}/score-derivation-audit.json`,
      observations: collectedObservations.length,
      stored_score_differences: derived.changedObservationIds.length,
      observations_sha256: observationsSha256,
      collection_source_commit: configManifest.source_commit,
      analysis_source_commit: currentSource.sourceCommit,
      raw_observations_modified: false,
      model_calls: 0,
    },
    null,
    2,
  )}\n`,
);

function sha256(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
