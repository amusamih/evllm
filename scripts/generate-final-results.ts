import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertFinalEvaluationIntegrity,
  type EvaluationBinding,
} from "../src/evaluation/final-integrity.js";
import {
  applicationAssuranceSchema,
  assertFinalResultsInputs,
  evaluationRunSummarySchema,
  primaryAnalysisSchema,
  renderFinalResults,
  sustainabilityValidationSchema,
  synthesisAnalysisSchema,
} from "./lib/final-results.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";
import {
  assertSustainabilityEvidenceBindings,
  strictSustainabilityEvidenceSchema,
} from "./lib/final-evidence-provenance.js";

const finalDirectory = resolve("evaluation/final");
const allowedGeneratedResults = [
  "evaluation/final/results",
  "evaluation/final/assurance",
  "evaluation/final/demonstrations",
  "evaluation/final/sustainability-validation.json",
  "evaluation/final/SUSTAINABILITY_RESULTS.md",
  "evaluation/final/FINAL_RESULTS.md",
  "evaluation/final/RESOURCE_RESULTS.md",
  "evaluation/final/BLOCKCHAIN_RESULTS.md",
  "evaluation/final/evidence-manifest.json",
] as const;
const primary = primaryAnalysisSchema.parse(json("evaluation/final/results/primary/analysis.json"));
const primaryRun = evaluationRunSummarySchema.parse(
  json("evaluation/final/results/primary/run-summary.json"),
);
const primaryConfig = json(
  "evaluation/final/results/primary/evaluation-config-manifest.json",
) as EvaluationBinding;
const synthesis = synthesisAnalysisSchema.parse(
  json("evaluation/final/results/synthesis/analysis.json"),
);
const synthesisRun = evaluationRunSummarySchema.parse(
  json("evaluation/final/results/synthesis/run-summary.json"),
);
const synthesisConfig = json(
  "evaluation/final/results/synthesis/evaluation-config-manifest.json",
) as EvaluationBinding;
const currentSource = assertCommittedEvaluationSource(allowedGeneratedResults, {
  expectedSourceCommit: primaryConfig.source_commit,
  operation: "Final result generation",
});
const sustainabilityEvidence = strictSustainabilityEvidenceSchema.parse(
  json("evaluation/final/sustainability-validation.json"),
);
assertSustainabilityEvidenceBindings(sustainabilityEvidence);
const sustainability = sustainabilityValidationSchema.parse(sustainabilityEvidence);
const application = applicationAssuranceSchema.parse(
  json("evaluation/final/assurance/application-tests.json"),
);

const integrity = assertFinalEvaluationIntegrity(
  {
    label: "primary",
    freezeBytes: bytes("evaluation/final/primary-freeze.json"),
    corpusBytes: bytes("evaluation/final/primary-corpus.json"),
    observationBytes: bytes("evaluation/final/results/primary/observations.jsonl"),
    transportJournalBytes: bytes("evaluation/final/results/primary/transport-attempts.jsonl"),
    regulatorySourceFiles: [
      {
        path: "evaluation/fixtures/eu-regulation-2023-1542-articles-77-78.json",
        bytes: bytes("evaluation/fixtures/eu-regulation-2023-1542-articles-77-78.json"),
      },
    ],
    configManifest: primaryConfig,
    runSummary: primaryRun,
    analysis: primary,
  },
  {
    label: "synthesis",
    freezeBytes: bytes("evaluation/final/synthesis-freeze.json"),
    corpusBytes: bytes("evaluation/final/synthesis-corpus.json"),
    observationBytes: bytes("evaluation/final/results/synthesis/observations.jsonl"),
    transportJournalBytes: bytes("evaluation/final/results/synthesis/transport-attempts.jsonl"),
    configManifest: synthesisConfig,
    runSummary: synthesisRun,
    analysis: synthesis,
  },
);
if (currentSource.sourceCommit !== integrity.source_commit) {
  throw new Error("The result generator source commit differs from the evaluation evidence");
}

const input = {
  evaluationSetId: integrity.evaluation_set_id,
  sourceCommit: integrity.source_commit,
  primary,
  primaryRun,
  synthesis,
  synthesisRun,
  sustainability,
  application,
};
assertFinalResultsInputs(input);
await mkdir(finalDirectory, { recursive: true });
await writeFile(resolve(finalDirectory, "FINAL_RESULTS.md"), renderFinalResults(input));
process.stdout.write(
  `${JSON.stringify(
    {
      output: "evaluation/final/FINAL_RESULTS.md",
      evaluation_set_id: integrity.evaluation_set_id,
      source_commit: integrity.source_commit,
    },
    null,
    2,
  )}\n`,
);

function json(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
}

function bytes(path: string): Buffer {
  return readFileSync(resolve(path));
}
