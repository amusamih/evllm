import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(".");
const finalDirectory = resolve("evaluation/final");
const primary = json("evaluation/final/results/primary/analysis.json") as PrimaryAnalysis;
const primaryRun = json(
  "evaluation/final/results/primary/run-summary.json",
) as EvaluationRunSummary;
const synthesis = json("evaluation/final/results/synthesis/analysis.json") as SynthesisAnalysis;
const sustainability = json(
  "evaluation/final/sustainability-validation.json",
) as SustainabilityValidation;
const coverage = json("evaluation/final/assurance/contracts/coverage.json") as Coverage;
const security = json("evaluation/final/assurance/contracts/security.json") as Security;
const deployment = json("contracts/generated/solidity/sepolia-deployment.json") as Deployment;
const gas = json("evaluation/final/assurance/contracts/gas-stats.json") as GasStats;
const slitherReview = json(
  "evaluation/final/assurance/contracts/slither-review.json",
) as SlitherReview;
const resources = json(
  "evaluation/final/results/technical/resource-characterization.json",
) as ResourceCharacterization;
const publicWorkflow = json(
  "evaluation/final/assurance/deployment/sepolia-full-workflow.json",
) as PublicWorkflow;
const networkCosts = json(
  "evaluation/final/assurance/deployment/cross-network-cost-snapshot.json",
) as NetworkCostSnapshot;

const inputTokens = primaryRun.input_tokens + synthesis.integrity.input_tokens;
const outputTokens = primaryRun.output_tokens + synthesis.integrity.output_tokens;
const inputUsdPerMillion = 0.15;
const outputUsdPerMillion = 0.6;
const estimatedApiCostUsd =
  (inputTokens / 1_000_000) * inputUsdPerMillion + (outputTokens / 1_000_000) * outputUsdPerMillion;
if (Object.values(sustainability.assertions).some((passed) => !passed))
  throw new Error("Final evidence cannot include a failed sustainability assertion");

await mkdir(finalDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(finalDirectory, "BLOCKCHAIN_RESULTS.md"), blockchainMarkdown()),
  writeFile(resolve(finalDirectory, "RESOURCE_RESULTS.md"), resourceMarkdown()),
]);

const evidenceFiles = [
  "evaluation/final/FINAL_RESULTS.md",
  "evaluation/final/SUSTAINABILITY_RESULTS.md",
  "evaluation/final/sustainability-validation.json",
  "evaluation/final/primary-corpus.json",
  "evaluation/final/primary-freeze.json",
  "evaluation/final/synthesis-corpus.json",
  "evaluation/final/synthesis-freeze.json",
  "evaluation/final/results/primary/observations.jsonl",
  "evaluation/final/results/primary/analysis.json",
  "evaluation/final/results/primary/run-summary.json",
  "evaluation/final/results/primary/evaluation-config-manifest.json",
  "evaluation/final/results/primary/condition-summary.csv",
  "evaluation/final/results/primary/contrasts.csv",
  "evaluation/final/results/primary/failure-taxonomy.csv",
  "evaluation/final/results/primary/stratum-summary.csv",
  "evaluation/final/results/primary/summary.md",
  "evaluation/final/results/primary/task-success.svg",
  "evaluation/final/results/synthesis/observations.jsonl",
  "evaluation/final/results/synthesis/analysis.json",
  "evaluation/final/results/synthesis/run-summary.json",
  "evaluation/final/results/synthesis/evaluation-config-manifest.json",
  "evaluation/final/results/synthesis/condition-summary.csv",
  "evaluation/final/results/synthesis/paired-contrasts.csv",
  "evaluation/final/results/synthesis/stratum-summary.csv",
  "evaluation/final/results/synthesis/summary.md",
  "evaluation/final/results/synthesis/interaction-burden.svg",
  "evaluation/final/results/technical/resource-characterization.json",
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
  schema: "EVLLM_FINAL_EVIDENCE_MANIFEST_V1",
  generated_at: new Date().toISOString(),
  primary_source_commit: primary.integrity.source_commit,
  synthesis_source_commit: synthesis.integrity.source_commit,
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

The estimate applies the documented GPT-4o mini rates of US$${inputUsdPerMillion.toFixed(2)} per million input tokens and US$${outputUsdPerMillion.toFixed(2)} per million output tokens ([OpenAI, accessed 13 August 2026](https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/)). It excludes taxes, account credits and calls outside the reported evaluation, so it is not an invoice total.

## Observed model-call latency

| Evaluation | Median | 95th percentile |
|---|---:|---:|
| Complementary synthesis | ${(synthesis.integrity.latency_ms.p50 / 1_000).toFixed(2)} s | ${(synthesis.integrity.latency_ms.p95 / 1_000).toFixed(2)} s |

Median and 95th-percentile values for each primary condition are available in \`results/primary/condition-summary.csv\`. These times cover the model call and response parsing; they do not include service startup, blockchain confirmation or indexing.

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

interface PrimaryAnalysis {
  integrity: {
    source_commit: string;
    observations_sha256: string;
  };
}
interface EvaluationRunSummary {
  input_tokens: number;
  output_tokens: number;
}
interface SynthesisAnalysis {
  integrity: {
    source_commit: string;
    observations_sha256: string;
    input_tokens: number;
    output_tokens: number;
    latency_ms: { p50: number; p95: number };
  };
}
interface SustainabilityValidation {
  assertions: Record<string, boolean>;
}
interface PublicWorkflow {
  transactions: Array<{ block_number: number }>;
  measurements: {
    confirmed_transaction_count: number;
    total_gas_used: string;
    total_calldata_bytes: number;
    total_transaction_fees_eth: string;
    confirmation_latency_ms: { median: number; p95: number };
  };
}
interface NetworkCostSnapshot {
  created_at: string;
  eth_usd_spot: number;
  eth_usd_source: string;
  fee_parameter_sources: Record<
    "ethereum" | "optimism" | "arbitrum" | "base",
    { rpc_host: string; method: string }
  >;
  networks: Array<{
    network: string;
    estimate_type: string;
    total_fee_eth: string;
    total_fee_usd: number | null;
  }>;
}
interface Coverage {
  totalLinePercent: number;
  files: Array<{ file: string; found: number; hit: number; linePercent: number }>;
}
interface Security {
  totalFuzzCases: number;
  totalInvariantRuns: number;
  results: unknown[];
}
interface Deployment {
  chainId: string;
  compiler: string;
  evmVersion: string;
  optimizerRuns: number;
  reviewDelaySeconds: number;
  deploymentBlockRange: { first: number; last: number };
  addresses: Record<string, string>;
}
interface GasStats {
  contracts: Record<
    string,
    {
      sourceName: string;
      contractName: string;
      deployment: { median: number; runtimeSize: number };
    }
  >;
}
interface SlitherReview {
  accepted_findings: unknown[];
}
interface ResourceCharacterization {
  environment: {
    node: string;
    platform: string;
    release: string;
    logical_cpu_count: number;
    cpu_model: string;
  };
  deterministic_assessment: {
    first_call_ms: number;
    warm_runs: number;
    warm_p50_ms: number;
    warm_p95_ms: number;
  };
  artifact_storage: {
    files: Array<{ path: string; bytes: number }>;
    total_bytes: number;
  };
}
