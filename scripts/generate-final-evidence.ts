import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertFinalEvaluationIntegrity,
  type EvaluationBinding,
} from "../src/evaluation/final-integrity.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";
import {
  asDeploymentProfile,
  asSolidityManifest,
  assertContractAssuranceEvidence,
  assertDeploymentVerificationBindings,
  assertNetworkCostBindings,
  assertPublicWorkflowBindings,
  assertResourceCharacterizationBindings,
  assertSustainabilityEvidenceBindings,
  contractCoverageSchema,
  contractSecuritySchema,
  gasStatsSchema,
  networkCostSnapshotSchema,
  publicSepoliaDeploymentSchema,
  publicWorkflowSchema,
  resourceCharacterizationSchema,
  sepoliaDeploymentVerificationSchema,
  slitherResultsSchema,
  slitherReviewSchema,
  solidityArtifactManifestSchema,
  strictSustainabilityEvidenceSchema,
} from "./lib/final-evidence-provenance.js";
import { applicationAssuranceSchema } from "./lib/final-results.js";
import { formalScoreDerivationAuditSchema } from "./lib/formal-rescoring.js";
import { modelPricingSnapshot } from "./lib/model-pricing.js";
import { assertManifestBoundGeneratedMarkdown } from "./lib/public-evidence.js";
import {
  assertExactDeploymentProfile,
  expectedContractNames,
  verifyReviewedArtifactBinding,
  verifyReviewedRuntimeBytecode,
  type ReviewedSolidityArtifact,
  type SolidityBuildInfoOutput,
} from "./lib/sepolia-deployment-verification.js";
import { evaluateNominalSustainability } from "./lib/sustainability-evidence.js";

const root = resolve(".");
const finalDirectory = resolve("evaluation/final");
const primary = json("evaluation/final/results/primary/analysis.json") as PrimaryAnalysis;
const primaryRun = json(
  "evaluation/final/results/primary/run-summary.json",
) as EvaluationRunSummary;
const primaryConfig = json(
  "evaluation/final/results/primary/evaluation-config-manifest.json",
) as EvaluationBinding;
const synthesis = json("evaluation/final/results/synthesis/analysis.json") as SynthesisAnalysis;
const synthesisRun = json(
  "evaluation/final/results/synthesis/run-summary.json",
) as EvaluationRunSummary;
const synthesisConfig = json(
  "evaluation/final/results/synthesis/evaluation-config-manifest.json",
) as EvaluationBinding;
const primaryScoreAudit = formalScoreDerivationAuditSchema.parse(
  json("evaluation/final/results/primary/score-derivation-audit.json"),
);
const currentSource = assertCommittedEvaluationSource(
  [
    "evaluation/final/results",
    "evaluation/final/assurance",
    "evaluation/final/demonstrations",
    "evaluation/final/sustainability-validation.json",
    "evaluation/final/SUSTAINABILITY_RESULTS.md",
    "evaluation/final/FINAL_RESULTS.md",
    "evaluation/final/RESOURCE_RESULTS.md",
    "evaluation/final/BLOCKCHAIN_RESULTS.md",
    "evaluation/final/evidence-manifest.json",
  ],
  {
    expectedSourceCommit: primaryConfig.source_commit,
    operation: "Final evidence generation",
  },
);
const sustainability = strictSustainabilityEvidenceSchema.parse(
  json("evaluation/final/sustainability-validation.json"),
);
assertSustainabilityEvidenceBindings(sustainability);
const coverage = contractCoverageSchema.parse(
  json("evaluation/final/assurance/contracts/coverage.json"),
);
const security = contractSecuritySchema.parse(
  json("evaluation/final/assurance/contracts/security.json"),
);
const deployment = publicSepoliaDeploymentSchema.parse(
  json("contracts/generated/solidity/sepolia-deployment.json"),
);
const artifactManifestBytes = bytes("contracts/generated/solidity/manifest.json");
const artifactManifest = solidityArtifactManifestSchema.parse(
  JSON.parse(artifactManifestBytes.toString("utf8")),
);
assertExactDeploymentProfile(
  asDeploymentProfile(deployment),
  artifactManifestBytes,
  asSolidityManifest(artifactManifest),
);
const deploymentVerification = sepoliaDeploymentVerificationSchema.parse(
  json("evaluation/final/assurance/deployment/sepolia-verification.json"),
);
const gas = gasStatsSchema.parse(json("evaluation/final/assurance/contracts/gas-stats.json"));
const expectedRuntime = Object.fromEntries(
  expectedContractNames.map((name) => {
    const artifact = json(
      `artifacts/contracts/${name}.sol/${name}.json`,
    ) as ReviewedSolidityArtifact;
    const manifestContract = artifactManifest.contracts.find(
      ({ contractName }) => contractName === name,
    );
    if (manifestContract === undefined) throw new Error(`${name} is absent from the manifest`);
    const buildInfoOutputBytes = bytes(
      `artifacts/build-info/${manifestContract.buildInfoId}.output.json`,
    );
    const buildInfoOutput = JSON.parse(
      buildInfoOutputBytes.toString("utf8"),
    ) as SolidityBuildInfoOutput;
    const binding = verifyReviewedArtifactBinding(
      name,
      artifact,
      manifestContract,
      buildInfoOutputBytes,
      buildInfoOutput,
    );
    return [
      name,
      verifyReviewedRuntimeBytecode(
        name,
        deploymentVerification.runtime_bytecode[name].onchain_bytecode,
        artifact,
        binding,
      ),
    ] as const;
  }),
);
assertDeploymentVerificationBindings(
  deployment,
  artifactManifest,
  deploymentVerification,
  expectedRuntime,
);
const slither = slitherResultsSchema.parse(
  json("evaluation/final/assurance/contracts/slither.json"),
);
const slitherReview = slitherReviewSchema.parse(
  json("evaluation/final/assurance/contracts/slither-review.json"),
);
assertContractAssuranceEvidence({
  coverage,
  security,
  gas,
  slither,
  slitherReview,
  manifest: artifactManifest,
});
const applicationAssurance = applicationAssuranceSchema.parse(
  json("evaluation/final/assurance/application-tests.json"),
);
const resources = resourceCharacterizationSchema.parse(
  json("evaluation/final/results/technical/resource-characterization.json"),
);
const measuredResourceInputs = new Map(
  [
    "evaluation/final/results/primary/observations.jsonl",
    "evaluation/final/results/synthesis/observations.jsonl",
    "evaluation/final/primary-corpus.json",
    "evaluation/final/synthesis-corpus.json",
    "evaluation/final/sustainability-validation.json",
  ].map((path) => [path, bytes(path)] as const),
);
const publicWorkflowBytes = bytes(
  "evaluation/final/assurance/deployment/sepolia-full-workflow.json",
);
const publicWorkflow = publicWorkflowSchema.parse(JSON.parse(publicWorkflowBytes.toString("utf8")));
assertPublicWorkflowBindings(publicWorkflow, deployment, artifactManifestBytes);
const networkCosts = networkCostSnapshotSchema.parse(
  json("evaluation/final/assurance/deployment/cross-network-cost-snapshot.json"),
);
const pricing = modelPricingSnapshot.parse(
  json("evaluation/fixtures/openai-gpt-4o-mini-pricing-2026-08-27.json"),
);

const finalEvaluationIntegrity = assertFinalEvaluationIntegrity(
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
if (currentSource.sourceCommit !== finalEvaluationIntegrity.source_commit) {
  throw new Error("The evidence generator source commit differs from the evaluation evidence");
}
assertResourceCharacterizationBindings(
  resources,
  {
    sourceCommit: finalEvaluationIntegrity.source_commit,
    evaluationSetId: finalEvaluationIntegrity.evaluation_set_id,
  },
  measuredResourceInputs,
  evaluateNominalSustainability(1).reproductionHash.value,
);
assertNetworkCostBindings(
  networkCosts,
  publicWorkflow,
  publicWorkflowBytes,
  artifactManifestBytes,
  {
    sourceCommit: finalEvaluationIntegrity.source_commit,
    evaluationSetId: finalEvaluationIntegrity.evaluation_set_id,
  },
);
if (applicationAssurance.source_commit !== currentSource.sourceCommit) {
  throw new Error("Application assurance source commit differs from the final evaluation");
}
for (const [label, actual, expected] of [
  [
    "evaluation set",
    primaryScoreAudit.evaluation_set_id,
    finalEvaluationIntegrity.evaluation_set_id,
  ],
  [
    "collection source commit",
    primaryScoreAudit.collection_source_commit,
    primaryConfig.source_commit,
  ],
  ["analysis source commit", primaryScoreAudit.analysis_source_commit, currentSource.sourceCommit],
  ["freeze digest", primaryScoreAudit.freeze_sha256, primaryConfig.freeze_sha256],
  ["corpus file digest", primaryScoreAudit.corpus_file_sha256, primaryConfig.corpus_file_sha256],
  [
    "logical corpus digest",
    primaryScoreAudit.logical_corpus_sha256,
    primaryConfig.logical_corpus_sha256,
  ],
  [
    "observation digest",
    primaryScoreAudit.observations_sha256,
    primary.integrity.observations_sha256,
  ],
] as const) {
  if (actual !== expected) {
    throw new Error(`Primary score-derivation audit has a mismatched ${label}`);
  }
}
if (primaryScoreAudit.observations !== primary.integrity.observations) {
  throw new Error("Primary score-derivation audit has a mismatched observation count");
}
if (!primaryRun.complete || !synthesisRun.complete)
  throw new Error("Final evidence cannot include an incomplete evaluation run");

const inputTokens = primaryRun.input_tokens + synthesis.integrity.input_tokens;
const outputTokens = primaryRun.output_tokens + synthesis.integrity.output_tokens;
const inputUsdPerMillion = pricing.rates.input_usd_per_million_tokens;
const outputUsdPerMillion = pricing.rates.output_usd_per_million_tokens;
const estimatedApiCostUsd =
  (inputTokens / 1_000_000) * inputUsdPerMillion + (outputTokens / 1_000_000) * outputUsdPerMillion;
if (Object.values(sustainability.assertions).some((passed) => !passed))
  throw new Error("Final evidence cannot include a failed sustainability assertion");

await mkdir(finalDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(finalDirectory, "BLOCKCHAIN_RESULTS.md"), blockchainMarkdown()),
  writeFile(resolve(finalDirectory, "RESOURCE_RESULTS.md"), resourceMarkdown()),
]);
await assertManifestBoundGeneratedMarkdown(root);

const evidenceFiles = [
  "evaluation/final/FINAL_RESULTS.md",
  "evaluation/final/SUSTAINABILITY_RESULTS.md",
  "evaluation/final/sustainability-validation.json",
  "evaluation/final/primary-corpus.json",
  "evaluation/final/primary-freeze.json",
  "evaluation/final/synthesis-corpus.json",
  "evaluation/final/synthesis-freeze.json",
  "evaluation/fixtures/eu-regulation-2023-1542-articles-77-78.json",
  "evaluation/final/results/primary/observations.jsonl",
  "evaluation/final/results/primary/transport-attempts.jsonl",
  "evaluation/final/results/primary/analysis.json",
  "evaluation/final/results/primary/run-summary.json",
  "evaluation/final/results/primary/evaluation-config-manifest.json",
  "evaluation/final/results/primary/score-derivation-audit.json",
  "evaluation/final/results/primary/condition-summary.csv",
  "evaluation/final/results/primary/contrasts.csv",
  "evaluation/final/results/primary/failure-taxonomy.csv",
  "evaluation/final/results/primary/stratum-summary.csv",
  "evaluation/final/results/primary/summary.md",
  "evaluation/final/results/primary/task-success.svg",
  "evaluation/final/results/synthesis/observations.jsonl",
  "evaluation/final/results/synthesis/transport-attempts.jsonl",
  "evaluation/final/results/synthesis/analysis.json",
  "evaluation/final/results/synthesis/run-summary.json",
  "evaluation/final/results/synthesis/evaluation-config-manifest.json",
  "evaluation/final/results/synthesis/condition-summary.csv",
  "evaluation/final/results/synthesis/raw-generation-summary.csv",
  "evaluation/final/results/synthesis/raw-generation-stratum-summary.csv",
  "evaluation/final/results/synthesis/stratum-summary.csv",
  "evaluation/final/results/synthesis/summary.md",
  "evaluation/final/results/synthesis/interaction-burden.svg",
  "evaluation/final/results/technical/resource-characterization.json",
  "evaluation/fixtures/openai-gpt-4o-mini-pricing-2026-08-27.json",
  "evaluation/final/BLOCKCHAIN_RESULTS.md",
  "evaluation/final/RESOURCE_RESULTS.md",
  "contracts/generated/solidity/sepolia-deployment.json",
  "contracts/generated/solidity/manifest.json",
  "evaluation/final/assurance/contracts/coverage.json",
  "evaluation/final/assurance/contracts/security.json",
  "evaluation/final/assurance/contracts/gas-stats.json",
  "evaluation/final/assurance/contracts/slither.json",
  "evaluation/final/assurance/contracts/slither-review.json",
  "evaluation/final/assurance/application-tests.json",
  "evaluation/final/assurance/deployment/sepolia-verification.json",
  "evaluation/final/assurance/deployment/sepolia-full-workflow.json",
  "evaluation/final/assurance/deployment/cross-network-cost-snapshot.json",
  "evaluation/final/demonstrations/assistant-case-runs.json",
  "evaluation/final/demonstrations/marketplace-workflow.json",
  "evaluation/final/demonstrations/screenshots/decision-support/QA_MultiRecordBatterySummary.png",
  "evaluation/final/demonstrations/screenshots/system-capabilities/RouteAssessment_ActualNominalCase.png",
  "evaluation/final/demonstrations/screenshots/system-capabilities/RouteAssessment_ActualConflictCase.png",
];
const entries = await Promise.all(
  evidenceFiles.map(async (path) => {
    const bytes = await readFile(resolve(root, path));
    return {
      path,
      bytes: (await stat(resolve(root, path))).size,
      sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }),
);
const manifest = {
  schema: "EVLLM_FINAL_EVIDENCE_MANIFEST_V3",
  generated_at: new Date().toISOString(),
  evaluation_set_id: finalEvaluationIntegrity.evaluation_set_id,
  source_commit: finalEvaluationIntegrity.source_commit,
  generation_source_commit: currentSource.sourceCommit,
  primary_source_commit: finalEvaluationIntegrity.primary.source_commit,
  synthesis_source_commit: finalEvaluationIntegrity.synthesis.source_commit,
  primary_analysis_source_commit: primary.integrity.analysis_source_commit,
  synthesis_analysis_source_commit: synthesis.integrity.analysis_source_commit,
  retained_workflow_source_revision: publicWorkflow.source_revision,
  primary_freeze_sha256: finalEvaluationIntegrity.primary.freeze_sha256,
  synthesis_freeze_sha256: finalEvaluationIntegrity.synthesis.freeze_sha256,
  primary_corpus_file_sha256: finalEvaluationIntegrity.primary.corpus_file_sha256,
  synthesis_corpus_file_sha256: finalEvaluationIntegrity.synthesis.corpus_file_sha256,
  primary_observations_sha256: primary.integrity.observations_sha256,
  synthesis_observations_sha256: synthesis.integrity.observations_sha256,
  entries,
};
await writeFile(
  resolve(finalDirectory, "evidence-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(
  `${JSON.stringify({ files: entries.length, inputTokens, outputTokens, estimatedApiCostUsd }, null, 2)}\n`,
);

function blockchainMarkdown(): string {
  const deploymentRows = Object.entries(deployment.addresses)
    .map(([name, address]) => `| ${name} | \`${address}\` |`)
    .join("\n");
  const coverageRows = coverage.files
    .map(
      ({ file, found, hit, linePercent }) =>
        `| ${file} | ${hit}/${found} | ${linePercent.toFixed(1)}% |`,
    )
    .join("\n");
  const gasRows = Object.values(gas.contracts)
    .filter(
      ({ sourceName }) => sourceName.startsWith("contracts/") && !sourceName.includes("/test/"),
    )
    .map(
      ({ contractName, deployment: gasDeployment }) =>
        `| ${contractName} | ${gasDeployment.median.toLocaleString("en-US")} | ${gasDeployment.runtimeSize.toLocaleString("en-US")} |`,
    )
    .join("\n");
  return `# Blockchain implementation and assurance results

## Public Sepolia deployment

- Chain ID: ${deployment.chainId}
- Compiler: ${deployment.compiler}; EVM ${deployment.evmVersion}; optimizer runs ${deployment.optimizerRuns}
- Deployment blocks: ${deployment.deploymentBlockRange.first}-${deployment.deploymentBlockRange.last}
- Source verification: Etherscan, Blockscout, and Sourcify all recorded as verified
- Evaluation review delay: ${deployment.reviewDelaySeconds} seconds; the production configuration uses 86,400 seconds

| Contract | Sepolia address |
|---|---|
${deploymentRows}

## Complete public workflow

| Measure | Observed value |
|---|---:|
| Confirmed transactions | ${publicWorkflow.measurements.confirmed_transaction_count.toLocaleString("en-US")} |
| Block range | ${publicWorkflow.transactions[0]?.block_number.toLocaleString("en-US")}-${publicWorkflow.transactions.at(-1)?.block_number.toLocaleString("en-US")} |
| Gas used | ${Number(publicWorkflow.measurements.total_gas_used).toLocaleString("en-US")} |
| Function-call data | ${publicWorkflow.measurements.total_calldata_bytes.toLocaleString("en-US")} bytes |
| Observed Sepolia fee | ${publicWorkflow.measurements.total_transaction_fees_eth} Sepolia ETH |
| Confirmation latency p50 | ${(publicWorkflow.measurements.confirmation_latency_ms.median / 1_000).toFixed(2)} s |
| Confirmation latency p95 | ${(publicWorkflow.measurements.confirmation_latency_ms.p95 / 1_000).toFixed(2)} s |

The Sepolia workflow registers the role accounts, records initial ownership, commits and replicates protected diagnostic and verification records, creates and funds a marketplace agreement, records dispatch and delivery, settles the transaction, transfers recorded ownership, withdraws the seller credit, and anchors an audit batch. All receipts are confirmed and every expected final-state check passes. Sepolia ETH is test-network currency and is not assigned a fiat value.

## Contract testing and analysis

- Complete seven-contract executable-line coverage: **${coverage.totalLinePercent.toFixed(1)}%**.
- High-volume randomized assurance: **${security.totalFuzzCases.toLocaleString("en-US")} fuzz cases** and **${security.totalInvariantRuns.toLocaleString("en-US")} invariant runs** across ${security.results.length} fixed seeds; all passed.
- Slither: no unresolved high- or medium-impact finding; ${slitherReview.accepted_findings.length} low or informational findings were reviewed and documented with rationale.
- Reentrancy, authorization, replay, deadline, cutover, escrow, recovery, and negative state-transition cases are included in the contract and integration suites.

| Contract | Executable lines hit | Coverage |
|---|---:|---:|
${coverageRows}

## Deployment gas characterization

| Contract | Median deployment gas | Runtime bytecode bytes |
|---|---:|---:|
${gasRows}

Gas units are reproducible implementation measurements; fiat or ETH cost varies with network fee conditions and is not treated as a stable system property.

## Scope of the blockchain results

The contracts enforce attributable authority, immutable commitments, lifecycle transitions, ownership, escrow, module routing, and audit anchoring. Blockchain consensus does not establish the physical truth of submitted evidence, lawful processing, competence, confidentiality of plaintext, industry adoption, or realized sustainability outcomes. Confidential content and encryption keys remain off chain.
`;
}

function resourceMarkdown(): string {
  const storageRows = resources.artifact_storage.files
    .map(({ path, bytes }) => `| ${path} | ${bytes.toLocaleString("en-US")} |`)
    .join("\n");
  return `# Resource characterization

## OpenAI evaluation use

| Item | Value |
|---|---:|
| Primary input tokens | ${primaryRun.input_tokens.toLocaleString("en-US")} |
| Primary output tokens | ${primaryRun.output_tokens.toLocaleString("en-US")} |
| Complementary synthesis input tokens | ${synthesis.integrity.input_tokens.toLocaleString("en-US")} |
| Complementary synthesis output tokens | ${synthesis.integrity.output_tokens.toLocaleString("en-US")} |
| Total input tokens | ${inputTokens.toLocaleString("en-US")} |
| Total output tokens | ${outputTokens.toLocaleString("en-US")} |
| Estimated token charge | US$${estimatedApiCostUsd.toFixed(3)} |

The estimate applies the pinned ${pricing.display_name} public list-price snapshot of US$${inputUsdPerMillion.toFixed(2)} per million input tokens and US$${outputUsdPerMillion.toFixed(2)} per million output tokens ([OpenAI, accessed ${pricing.source.accessed_on}](${pricing.source.url})). ${pricing.scope_boundary} The estimate is not an invoice total.

## Governed synthesis request duration

| Evaluation | Median | 95th percentile |
|---|---:|---:|
| Complementary synthesis | ${(synthesis.integrity.latency_ms.p50 / 1_000).toFixed(2)} s | ${(synthesis.integrity.latency_ms.p95 / 1_000).toFixed(2)} s |

Each complementary value measures one complete governed synthesis request in the evaluation harness. It includes session preparation, permitted-record tool setup and access checks, service orchestration, model generation and response parsing, and post-generation validation. It excludes process startup, blockchain confirmation and indexing. Median and 95th-percentile values for each primary condition are reported separately in \`results/primary/condition-summary.csv\`.

## Public-workflow confirmation and fee snapshot

| Measure | Value |
|---|---:|
| Confirmed Sepolia transactions | ${publicWorkflow.measurements.confirmed_transaction_count.toLocaleString("en-US")} |
| Median confirmation time | ${(publicWorkflow.measurements.confirmation_latency_ms.median / 1_000).toFixed(2)} s |
| 95th-percentile confirmation time | ${(publicWorkflow.measurements.confirmation_latency_ms.p95 / 1_000).toFixed(2)} s |
| Measured gas | ${Number(publicWorkflow.measurements.total_gas_used).toLocaleString("en-US")} |
| Observed fee | ${publicWorkflow.measurements.total_transaction_fees_eth} Sepolia ETH |

| Network | Basis | Total ETH | USD at snapshot |
|---|---|---:|---:|
${networkCosts.networks
  .map(
    ({ network, estimate_type, total_fee_eth, total_fee_usd }) =>
      `| ${network} | ${estimate_type} | ${total_fee_eth} | ${total_fee_usd === null ? "not applicable" : `US$${total_fee_usd.toFixed(4)}`} |`,
  )
  .join("\n")}

The Sepolia value comes from confirmed transaction receipts. The other rows are dated estimates that apply each network's fee parameters, including Layer 2 data charges, to the measured workflow trace. The parameters and ETH spot price were collected on ${networkCosts.created_at.slice(0, 10)}; their exact sources and query methods are recorded in the accompanying cost snapshot. These values vary with network fees and exchange rates and are not receipts from deployments on those networks.

## Deterministic assessment timing

| Measure | Value |
|---|---:|
| First in-process assessment call | ${resources.deterministic_assessment.first_call_ms.toFixed(3)} ms |
| Warm calls | ${resources.deterministic_assessment.warm_runs.toLocaleString("en-US")} |
| Warm-call median | ${resources.deterministic_assessment.warm_p50_ms.toFixed(3)} ms |
| Warm-call 95th percentile | ${resources.deterministic_assessment.warm_p95_ms.toFixed(3)} ms |

Environment: Node ${resources.environment.node}, ${resources.environment.platform} ${resources.environment.release}, ${resources.environment.logical_cpu_count} logical CPUs (${resources.environment.cpu_model}). These measurements characterize local execution and do not estimate production throughput.

## Evaluation artifact sizes

| Artifact | Bytes |
|---|---:|
${storageRows}
| **Total** | **${resources.artifact_storage.total_bytes.toLocaleString("en-US")}** |
`;
}

function json(path: string): unknown {
  // Explicit paths keep the checksum manifest reproducible.
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function bytes(path: string): Buffer {
  return readFileSync(resolve(root, path));
}

interface PrimaryAnalysis {
  integrity: EvaluationBinding & {
    analysis_source_commit: string;
    observations_sha256: string;
    observations: number;
    transport_attempt_journal_sha256: string;
  };
}
interface EvaluationRunSummary extends EvaluationBinding {
  input_tokens: number;
  output_tokens: number;
  complete: boolean;
  transport_attempt_journal_sha256: string;
}
interface SynthesisAnalysis {
  integrity: EvaluationBinding & {
    analysis_source_commit: string;
    observations_sha256: string;
    transport_attempt_journal_sha256: string;
    input_tokens: number;
    output_tokens: number;
    latency_ms: { p50: number; p95: number };
  };
}
