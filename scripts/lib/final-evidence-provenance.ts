import { createHash } from "node:crypto";

import { formatEther } from "ethers";
import { z } from "zod";

import {
  expectedContractNames,
  sha256,
  type DeploymentAddresses,
  type PublicSepoliaDeployment,
  type RuntimeBytecodeVerification,
  type SolidityArtifactManifest,
} from "./sepolia-deployment-verification.js";
import {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_WORKFLOW_ID,
  sepoliaWorkflowRoles,
} from "./sepolia-workflow-config.js";
import {
  RETAINED_SEPOLIA_WORKFLOW_SOURCE_REVISION,
  sepoliaWorkflowRecipe,
} from "./sepolia-workflow-recipe.js";
import { sustainabilityValidationEvidence } from "./sustainability-evidence.js";

const address = z.string().regex(/^0x[0-9a-f]{40}$/iu);
const transactionHash = z.string().regex(/^0x[0-9a-f]{64}$/iu);
const sha256Digest = z.string().regex(/^0x[0-9a-f]{64}$/iu);
const bytecode = z.string().regex(/^0x(?:[0-9a-f]{2})+$/iu);
const plainSha256Digest = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceCommit = z.string().regex(/^[0-9a-f]{40}$/u);
const unsignedInteger = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const safeCount = z.number().int().nonnegative().safe();
const positiveSafeCount = z.number().int().positive().safe();
const nonnegativeFinite = z.number().finite().nonnegative();
const positiveFinite = z.number().finite().positive();
const isoDateTime = z.string().datetime({ offset: true });

const deploymentTransaction = z
  .object({
    contract: z.string().min(1),
    blockNumber: positiveSafeCount,
    transactionHash,
    gasUsed: unsignedInteger,
  })
  .strict();

const configurationTransaction = z
  .object({
    contract: z.string().min(1),
    function: z.string().min(1),
    blockNumber: positiveSafeCount,
    transactionHash,
    gasUsed: unsignedInteger,
    transactionFeeWei: unsignedInteger,
  })
  .strict();

const activation = z
  .object({
    module: z.enum(["evidence", "marketplace", "audit"]),
    blockNumber: positiveSafeCount,
    transactionHash,
  })
  .strict();

export const publicSepoliaDeploymentSchema = z
  .object({
    schema: z.literal("EVLLM_PUBLIC_SEPOLIA_DEPLOYMENT_V1"),
    chainId: z.literal("11155111"),
    network: z.literal("sepolia"),
    deployer: address,
    governance: address,
    artifactManifestSha256: sha256Digest,
    compiler: z.string().min(1),
    evmVersion: z.string().min(1),
    optimizerRuns: positiveSafeCount,
    reviewDelaySeconds: positiveSafeCount,
    deploymentBlockRange: z.object({ first: positiveSafeCount, last: positiveSafeCount }).strict(),
    addresses: contractMap(address),
    deploymentTransactions: z.array(deploymentTransaction).length(expectedContractNames.length),
    configurationTransactions: z.array(configurationTransaction).length(8),
    activations: z.array(activation).length(3),
    sourceVerification: z
      .object({
        etherscan: z.literal("verified"),
        blockscout: z.literal("verified"),
        sourcify: z.literal("verified"),
      })
      .strict(),
  })
  .strict();

const manifestContract = z
  .object({
    contractName: z.string().min(1),
    sourceName: z.string().min(1),
    abi: z.string().min(1),
    creationBytecodeSha256: sha256Digest,
    deployedBytecodeSha256: sha256Digest,
    buildInfoId: z.string().min(1),
    buildInfoInputSha256: sha256Digest,
    buildInfoOutputSha256: sha256Digest,
    stableSharedBoundary: z.boolean(),
    proxy: z.boolean(),
  })
  .strict();

export const solidityArtifactManifestSchema = z
  .object({
    schema: z.literal("EVLLM_SOLIDITY_ARTIFACT_MANIFEST_V1"),
    compiler: z.string().min(1),
    compilerLongVersion: z.string().min(1),
    compilerType: z.string().min(1),
    preferWasm: z.boolean(),
    evmVersion: z.string().min(1),
    viaIR: z.boolean(),
    optimizer: z.object({ enabled: z.boolean(), runs: positiveSafeCount }).strict(),
    toolchain: z
      .object({
        hardhat: z.string().min(1),
        hardhatEthers: z.string().min(1),
        hardhatIgnition: z.string().min(1),
        hardhatIgnitionEthers: z.string().min(1),
        hardhatVerify: z.string().min(1),
        ethers: z.string().min(1),
        openZeppelin: z.string().min(1),
        forgeStdCommit: sourceCommit,
        slitherImage: z.string().min(1),
      })
      .strict(),
    networks: z
      .object({
        local: z.object({ chainId: z.literal(31_337), initialDate: isoDateTime }).strict(),
        sepolia: z.object({ chainId: z.literal(11_155_111) }).strict(),
      })
      .strict(),
    deploymentOrder: z.array(z.string().min(1)).length(expectedContractNames.length),
    constructorBindings: contractMap(z.array(z.string().min(1))),
    contracts: z.array(manifestContract).length(expectedContractNames.length),
  })
  .strict();

const verifiedDeploymentTransaction = z
  .object({
    contract: z.string().min(1),
    block_number: positiveSafeCount,
    transaction_hash: transactionHash,
    gas_used: unsignedInteger,
  })
  .strict();

const verifiedConfigurationTransaction = z
  .object({
    contract: z.string().min(1),
    function: z.string().min(1),
    block_number: positiveSafeCount,
    transaction_hash: transactionHash,
    gas_used: unsignedInteger,
    transaction_fee_wei: unsignedInteger,
  })
  .strict();

const runtimeBytecode = z
  .object({
    onchain_bytecode: bytecode,
    onchain_sha256: sha256Digest,
    reviewed_sha256: sha256Digest,
    normalized_sha256: sha256Digest,
    size_bytes: positiveSafeCount,
  })
  .strict();

export const sepoliaDeploymentVerificationSchema = z
  .object({
    schema: z.literal("EVLLM_SEPOLIA_DEPLOYMENT_VERIFICATION_V2"),
    verified_at: isoDateTime,
    chain_id: z.literal("11155111"),
    latest_block: positiveSafeCount,
    governance: address,
    artifact_manifest_sha256: sha256Digest,
    compiler: z.string().min(1),
    review_delay_seconds: positiveSafeCount,
    addresses: contractMap(address),
    runtime_bytecode: contractMap(runtimeBytecode),
    deployment_transactions: z
      .array(verifiedDeploymentTransaction)
      .length(expectedContractNames.length),
    configuration_transactions: z.array(verifiedConfigurationTransaction).length(8),
    deployment_gas_used: unsignedInteger,
    configuration_gas_used: unsignedInteger,
    commissioning_gas_used: unsignedInteger,
    configuration_transaction_fees_wei: unsignedInteger,
    active_modules: z.object({ evidence: address, marketplace: address, audit: address }).strict(),
    protected_bundle_bootstrap_closed: z.literal(true),
    marketplace_authorized_for_battery_locking: z.literal(true),
    activation_events: z
      .array(
        z
          .object({
            module: z.enum(["evidence", "marketplace", "audit"]),
            block_number: positiveSafeCount,
            transaction_hash: transactionHash,
          })
          .strict(),
      )
      .length(3),
    explorer: z.string().url(),
  })
  .strict();

const workflowRole = z.enum(
  sepoliaWorkflowRoles.map(({ role }) => role) as [
    (typeof sepoliaWorkflowRoles)[number]["role"],
    ...(typeof sepoliaWorkflowRoles)[number]["role"][],
  ],
);
const contractName = z.enum(expectedContractNames);

const workflowTransaction = z
  .object({
    sequence: positiveSafeCount,
    step: z.string().min(1),
    contract: contractName,
    function: z.string().min(1),
    signer_role: workflowRole,
    signer_address: address,
    transaction_hash: transactionHash,
    submitted_at: isoDateTime,
    calldata_bytes: positiveSafeCount,
    value_wei: unsignedInteger,
    block_number: positiveSafeCount,
    confirmed_at: isoDateTime,
    confirmation_latency_ms: nonnegativeFinite,
    gas_used: unsignedInteger,
    effective_gas_price_wei: unsignedInteger,
    transaction_fee_wei: unsignedInteger,
    events: z.array(z.string().min(1)),
    status: z.literal("confirmed"),
  })
  .strict();

const aggregateMeasurement = z
  .object({
    transaction_count: safeCount,
    gas_used: unsignedInteger,
    transaction_fees_wei: unsignedInteger,
  })
  .strict();

const roleAddressObject = Object.fromEntries(
  sepoliaWorkflowRoles.map(({ role }) => [role, address]),
) as Record<(typeof sepoliaWorkflowRoles)[number]["role"], typeof address>;

const balanceObject = Object.fromEntries(
  sepoliaWorkflowRoles.map(({ role }) => [role, unsignedInteger]),
) as Record<(typeof sepoliaWorkflowRoles)[number]["role"], typeof unsignedInteger>;

export const publicWorkflowSchema = z
  .object({
    schema: z.literal("EVLLM_SEPOLIA_FULL_WORKFLOW_V1"),
    created_at: isoDateTime,
    workflow_id: z.literal(SEPOLIA_WORKFLOW_ID),
    network: z.literal("sepolia"),
    chain_id: z.literal(SEPOLIA_CHAIN_ID.toString()),
    source_revision: sourceCommit,
    working_tree_status_sha256: plainSha256Digest,
    role_addresses: z.object(roleAddressObject).strict(),
    contract_addresses: contractMap(address),
    case: z
      .object({
        purchase_amount_wei: unsignedInteger,
        battery_id: transactionHash,
        claim_id: transactionHash,
        listing_id: transactionHash,
        offer_id: transactionHash,
        agreement_id: transactionHash,
        audit_batch_id: transactionHash,
      })
      .strict(),
    transactions: z.array(workflowTransaction).length(57),
    measurements: z
      .object({
        confirmed_transaction_count: z.literal(57),
        total_gas_used: unsignedInteger,
        total_transaction_fees_wei: unsignedInteger,
        total_transaction_fees_eth: z.string().regex(/^(?:0|[1-9][0-9]*)\.[0-9]{1,18}$/u),
        total_calldata_bytes: positiveSafeCount,
        confirmation_latency_ms: z
          .object({
            median: nonnegativeFinite,
            p95: nonnegativeFinite,
            minimum: nonnegativeFinite,
            maximum: nonnegativeFinite,
          })
          .strict(),
        by_contract: z.partialRecord(contractName, aggregateMeasurement),
        by_role: z.partialRecord(workflowRole, aggregateMeasurement),
        role_balances_before_wei: z.object(balanceObject).strict(),
        role_balances_after_wei: z.object(balanceObject).strict(),
        marketplace_balance_before_wei: unsignedInteger,
        marketplace_balance_after_wei: unsignedInteger,
      })
      .strict(),
    final_state: z
      .object({
        agreement_settled: z.literal(true),
        listing_closed_settled: z.literal(true),
        offer_accepted: z.literal(true),
        buyer_is_recorded_owner: z.literal(true),
        battery_lock_released: z.literal(true),
        evidence_active: z.literal(true),
        independent_assertion_active: z.literal(true),
        seller_credit_withdrawn: z.literal(true),
        audit_batch_anchored: z.literal(true),
        listing_origin_bound: z.literal(true),
        agreement_origin_bound: z.literal(true),
        agreement_state: z.literal(9),
        listing_state: z.literal(5),
        offer_state: z.literal(2),
        recorded_owner_organization_id: transactionHash,
        marketplace_lock: address,
        seller_credit_wei: z.literal("0"),
      })
      .strict(),
  })
  .strict();

const networkBase = {
  network: z.string().min(1),
  chain_id: positiveSafeCount,
  estimate_type: z.enum(["observed", "snapshot estimate"]),
  method: z.string().min(1),
  total_fee_wei: unsignedInteger,
  total_fee_eth: z.string().min(1),
  total_fee_usd: nonnegativeFinite.nullable(),
} as const;

const observedNetwork = z.object(networkBase).strict();
const executionNetwork = z
  .object({
    ...networkBase,
    gas_price_wei: unsignedInteger,
    serialized_transaction_bytes: positiveSafeCount,
    execution_fee_wei: unsignedInteger,
    l1_data_fee_wei: unsignedInteger,
    operator_fee_wei: unsignedInteger,
    block_number: positiveSafeCount,
    block_timestamp: isoDateTime,
  })
  .strict();
const arbitrumNetwork = z
  .object({
    ...networkBase,
    gas_price_wei: unsignedInteger,
    calldata_bytes: positiveSafeCount,
    execution_fee_wei: unsignedInteger,
    l1_data_fee_wei: unsignedInteger,
    operator_fee_wei: unsignedInteger,
    per_l2_transaction_wei: unsignedInteger,
    per_l1_calldata_byte_wei: unsignedInteger,
    block_number: positiveSafeCount,
    block_timestamp: isoDateTime,
  })
  .strict();

export const networkCostSnapshotSchema = z
  .object({
    schema: z.literal("EVLLM_CROSS_NETWORK_COST_SNAPSHOT_V2"),
    created_at: isoDateTime,
    generation_source_commit: sourceCommit,
    evaluation_set_id: z.string().min(1),
    source_workflow: z.literal("evaluation/final/assurance/deployment/sepolia-full-workflow.json"),
    source_workflow_sha256: sha256Digest,
    artifact_manifest_sha256: sha256Digest,
    workflow_source_revision: sourceCommit,
    verified_receipt_count: z.literal(57),
    measured_transaction_count: z.literal(57),
    measured_gas_used: unsignedInteger,
    measured_calldata_bytes: positiveSafeCount,
    eth_usd_spot: positiveFinite,
    eth_usd_source: z.string().url(),
    fee_parameter_sources: z
      .object({
        ethereum: rpcSourceSchema(),
        optimism: rpcSourceSchema(),
        arbitrum: rpcSourceSchema(),
        base: rpcSourceSchema(),
      })
      .strict(),
    interpretation: z.string().min(1),
    networks: z.tuple([
      observedNetwork,
      executionNetwork,
      executionNetwork,
      arbitrumNetwork,
      executionNetwork,
    ]),
    source_documentation: z
      .object({
        optimism: z.string().url(),
        arbitrum: z.string().url(),
        base: z.string().url(),
      })
      .strict(),
  })
  .strict();

const measuredResourceFile = z
  .object({ path: z.string().min(1), bytes: safeCount, sha256: sha256Digest })
  .strict();

export const resourceCharacterizationSchema = z
  .object({
    schema: z.literal("EVLLM_RESOURCE_CHARACTERIZATION_V2"),
    measured_at: isoDateTime,
    source_commit: sourceCommit,
    evaluation_set_id: z.string().min(1),
    source_scope: z.string().min(1),
    environment: z
      .object({
        node: z.string().min(1),
        platform: z.string().min(1),
        release: z.string().min(1),
        logical_cpu_count: positiveSafeCount,
        cpu_model: z.string().min(1),
      })
      .strict(),
    deterministic_assessment: z
      .object({
        first_call_ms: nonnegativeFinite,
        warm_runs: z.literal(1_000),
        warm_p50_ms: nonnegativeFinite,
        warm_p95_ms: nonnegativeFinite,
        warm_min_ms: nonnegativeFinite,
        warm_max_ms: nonnegativeFinite,
        first_reproduction_hash: z
          .object({
            alg: z.literal("SHA-256"),
            value: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
          })
          .strict(),
      })
      .strict(),
    artifact_storage: z
      .object({
        files: z.array(measuredResourceFile).length(5),
        total_bytes: safeCount,
      })
      .strict(),
    interpretation_boundary: z.string().min(1),
  })
  .strict();

const coverageFile = z
  .object({
    file: z.string().min(1),
    found: positiveSafeCount,
    hit: safeCount,
    linePercent: z.number().finite().min(0).max(100),
  })
  .strict();

export const contractCoverageSchema = z
  .object({
    schema: z.literal("EVLLM_CONTRACT_COVERAGE_V1"),
    thresholdPercent: z.literal(80),
    totalLinePercent: z.number().finite().min(0).max(100),
    files: z.array(coverageFile).length(expectedContractNames.length),
  })
  .strict();

export const contractSecuritySchema = z
  .object({
    schema: z.literal("EVLLM_CONTRACT_SECURITY_FREEZE_V1"),
    hardhat: z.string().min(1),
    compiler: z.string().min(1),
    fuzzRunsPerSeed: positiveSafeCount,
    invariantRunsPerSeed: positiveSafeCount,
    invariantDepth: positiveSafeCount,
    fuzzFunctions: positiveSafeCount,
    invariantFunctions: positiveSafeCount,
    totalFuzzCases: positiveSafeCount,
    totalInvariantRuns: positiveSafeCount,
    results: z
      .array(
        z
          .object({
            seed: transactionHash,
            durationMs: positiveSafeCount,
            status: z.literal("passed"),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const gasStatistic = z
  .object({
    min: nonnegativeFinite,
    max: nonnegativeFinite,
    avg: nonnegativeFinite,
    median: nonnegativeFinite,
    count: positiveSafeCount,
  })
  .strict();

export const gasStatsSchema = z
  .object({
    contracts: z.record(
      z.string().min(1),
      z
        .object({
          sourceName: z.string().min(1),
          contractName: z.string().min(1),
          proxyChain: z.array(z.string()),
          deployment: gasStatistic.extend({ runtimeSize: positiveSafeCount }).strict(),
          functions: z.record(z.string().min(1), gasStatistic),
        })
        .strict(),
    ),
  })
  .strict();

const slitherDetector = z
  .object({
    elements: z.array(z.unknown()),
    description: z.string().min(1),
    markdown: z.string().min(1),
    first_markdown_element: z.string().min(1),
    id: plainSha256Digest,
    check: z.string().min(1),
    impact: z.string().min(1),
    confidence: z.string().min(1),
    reference: z.string().url(),
  })
  .strict();

export const slitherResultsSchema = z
  .object({
    success: z.literal(true),
    error: z.null(),
    results: z.object({ detectors: z.array(slitherDetector) }).strict(),
  })
  .strict();

export const slitherReviewSchema = z
  .object({
    schema: z.literal("EVLLM_SLITHER_REVIEW_V1"),
    image: z.string().min(1),
    accepted_findings: z.array(
      z
        .object({
          check: z.string().min(1),
          impact: z.string().min(1),
          confidence: z.string().min(1),
          scope: z.string().min(1),
          rationale: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

const sustainabilityScenarioNames = [
  "nominal",
  "safetyFailure",
  "missingEvidence",
  "conflictingEvidence",
  "contextSensitivity",
  "unstableRanking",
  "deterministicReplay",
] as const;
const sustainabilityAssertionNames = [
  "nominalAnswers",
  "failedGateCannotBePreferred",
  "missingCriticalEvidenceAbstains",
  "conflictRequiresExternalDecision",
  "contextChangesEnvironmentalIndicator",
  "contextPreservesCircularity",
  "contextPreservesEconomics",
  "unstableRankingAbstains",
  "deterministicReplay",
] as const;

export const strictSustainabilityEvidenceSchema = z
  .object({
    schema: z.literal("EVLLM_SUSTAINABILITY_VALIDATION_V1"),
    method: z.string().min(1),
    routes: z.array(z.string().min(1)).length(3),
    componentOrder: z.tuple([
      z.literal("G"),
      z.literal("C"),
      z.literal("I"),
      z.literal("E"),
      z.literal("A"),
      z.literal("U"),
    ]),
    overallScorePresent: z.literal(false),
    scenarios: z.record(z.enum(sustainabilityScenarioNames), z.unknown()),
    assertions: z.record(z.enum(sustainabilityAssertionNames), z.literal(true)),
  })
  .strict();

export type ParsedPublicDeployment = z.infer<typeof publicSepoliaDeploymentSchema>;
export type ParsedSolidityManifest = z.infer<typeof solidityArtifactManifestSchema>;
export type SepoliaDeploymentVerification = z.infer<typeof sepoliaDeploymentVerificationSchema>;
export type PublicWorkflow = z.infer<typeof publicWorkflowSchema>;
export type NetworkCostSnapshot = z.infer<typeof networkCostSnapshotSchema>;
export type ResourceCharacterization = z.infer<typeof resourceCharacterizationSchema>;
export type ContractCoverage = z.infer<typeof contractCoverageSchema>;
export type ContractSecurity = z.infer<typeof contractSecuritySchema>;
export type GasStats = z.infer<typeof gasStatsSchema>;
export type SlitherResults = z.infer<typeof slitherResultsSchema>;
export type SlitherReview = z.infer<typeof slitherReviewSchema>;
export type SustainabilityEvidence = z.infer<typeof strictSustainabilityEvidenceSchema>;

export function assertDeploymentVerificationBindings(
  deployment: ParsedPublicDeployment,
  manifest: ParsedSolidityManifest,
  verification: SepoliaDeploymentVerification,
  expectedRuntime: Readonly<Record<string, RuntimeBytecodeVerification>>,
): void {
  equalHex(
    verification.artifact_manifest_sha256,
    deployment.artifactManifestSha256,
    "verification manifest digest",
  );
  equalHex(verification.governance, deployment.governance, "verification governance");
  if (
    verification.compiler !== deployment.compiler ||
    verification.review_delay_seconds !== deployment.reviewDelaySeconds
  ) {
    throw new Error("Sepolia verification compiler profile differs from the deployment");
  }
  assertAddressMapsEqual(verification.addresses, deployment.addresses, "verification addresses");
  assertDeploymentTransactionsEqual(verification, deployment);
  const latestRecordedBlock = Math.max(
    ...verification.deployment_transactions.map(({ block_number }) => block_number),
    ...verification.configuration_transactions.map(({ block_number }) => block_number),
    ...verification.activation_events.map(({ block_number }) => block_number),
  );
  if (verification.latest_block < latestRecordedBlock) {
    throw new Error("Sepolia verification latest block predates a verified transaction");
  }
  if (verification.explorer !== "https://sepolia.etherscan.io") {
    throw new Error("Sepolia verification explorer is not the declared network explorer");
  }
  const deploymentGas = sumBigInts(deployment.deploymentTransactions.map(({ gasUsed }) => gasUsed));
  const configurationGas = sumBigInts(
    deployment.configurationTransactions.map(({ gasUsed }) => gasUsed),
  );
  const configurationFees = sumBigInts(
    deployment.configurationTransactions.map(({ transactionFeeWei }) => transactionFeeWei),
  );
  equalExact(verification.deployment_gas_used, deploymentGas.toString(), "deployment gas total");
  equalExact(
    verification.configuration_gas_used,
    configurationGas.toString(),
    "configuration gas total",
  );
  equalExact(
    verification.commissioning_gas_used,
    (deploymentGas + configurationGas).toString(),
    "commissioning gas total",
  );
  equalExact(
    verification.configuration_transaction_fees_wei,
    configurationFees.toString(),
    "configuration fee total",
  );
  const modules = {
    evidence: deployment.addresses.EvidenceRegistry,
    marketplace: deployment.addresses.Marketplace,
    audit: deployment.addresses.AuditAnchor,
  };
  assertAddressMapsEqual(verification.active_modules, modules, "active modules");
  for (const [index, activationRecord] of deployment.activations.entries()) {
    const verified = verification.activation_events[index];
    if (
      verified === undefined ||
      activationRecord.module !== verified.module ||
      activationRecord.blockNumber !== verified.block_number ||
      !sameHex(activationRecord.transactionHash, verified.transaction_hash)
    ) {
      throw new Error("Sepolia activation verification differs from the deployment");
    }
  }
  for (const contract of manifest.contracts) {
    const runtime =
      verification.runtime_bytecode[
        contract.contractName as keyof typeof verification.runtime_bytecode
      ];
    const expected = expectedRuntime[contract.contractName];
    if (runtime === undefined || expected === undefined) {
      throw new Error(`${contract.contractName} runtime verification input is missing`);
    }
    if (
      runtime.onchain_bytecode !== expected.onchainBytecode ||
      !sameHex(runtime.onchain_sha256, expected.onchainSha256) ||
      !sameHex(runtime.reviewed_sha256, expected.reviewedSha256) ||
      !sameHex(runtime.normalized_sha256, expected.normalizedSha256) ||
      runtime.size_bytes !== expected.sizeBytes ||
      !sameHex(runtime.reviewed_sha256, contract.deployedBytecodeSha256)
    ) {
      throw new Error(
        `${contract.contractName} runtime verification differs from the reviewed manifest`,
      );
    }
  }
}

export function assertPublicWorkflowBindings(
  workflow: PublicWorkflow,
  deployment: ParsedPublicDeployment,
  manifestBytes: Uint8Array,
): void {
  equalHex(deployment.artifactManifestSha256, sha256(manifestBytes), "workflow manifest binding");
  equalExact(
    workflow.source_revision,
    RETAINED_SEPOLIA_WORKFLOW_SOURCE_REVISION,
    "retained workflow source revision",
  );
  assertAddressMapsEqual(workflow.contract_addresses, deployment.addresses, "workflow contracts");
  const hashes = new Set<string>();
  let priorBlock = 0;
  for (const [index, transaction] of workflow.transactions.entries()) {
    const recipe = sepoliaWorkflowRecipe[index];
    if (recipe === undefined || transaction.sequence !== recipe.sequence) {
      throw new Error("Workflow transaction sequence differs from the frozen recipe");
    }
    if (
      transaction.step !== recipe.step ||
      transaction.contract !== recipe.contract ||
      transaction.function !== recipe.function ||
      transaction.signer_role !== recipe.signerRole
    ) {
      throw new Error(
        `Workflow call differs from the frozen recipe at sequence ${String(index + 1)}`,
      );
    }
    if (canonical(transaction.events) !== canonical(recipe.expectedEvents)) {
      throw new Error(
        `Workflow events differ from the frozen recipe at sequence ${transaction.sequence}`,
      );
    }
    const expectedValue =
      recipe.valueRule === "purchase-amount" ? workflow.case.purchase_amount_wei : "0";
    if (transaction.value_wei !== expectedValue) {
      throw new Error(
        `Workflow value differs from the frozen recipe at sequence ${transaction.sequence}`,
      );
    }
    const normalizedHash = transaction.transaction_hash.toLowerCase();
    if (hashes.has(normalizedHash)) throw new Error("Workflow transaction hashes are not unique");
    hashes.add(normalizedHash);
    if (transaction.block_number < priorBlock)
      throw new Error("Workflow receipt blocks are not sequential");
    priorBlock = transaction.block_number;
    if (!sameHex(transaction.signer_address, workflow.role_addresses[transaction.signer_role])) {
      throw new Error(`Workflow signer does not match role at sequence ${transaction.sequence}`);
    }
    if (Date.parse(transaction.confirmed_at) < Date.parse(transaction.submitted_at)) {
      throw new Error(
        `Workflow confirmation predates submission at sequence ${transaction.sequence}`,
      );
    }
    const expectedFee = BigInt(transaction.gas_used) * BigInt(transaction.effective_gas_price_wei);
    if (expectedFee !== BigInt(transaction.transaction_fee_wei)) {
      throw new Error(`Workflow transaction fee mismatch at sequence ${transaction.sequence}`);
    }
  }
  const totalGas = sumBigInts(workflow.transactions.map(({ gas_used }) => gas_used));
  const totalFees = sumBigInts(
    workflow.transactions.map(({ transaction_fee_wei }) => transaction_fee_wei),
  );
  const totalCalldata = workflow.transactions.reduce((sum, item) => sum + item.calldata_bytes, 0);
  equalExact(workflow.measurements.total_gas_used, totalGas.toString(), "workflow gas total");
  equalExact(
    workflow.measurements.total_transaction_fees_wei,
    totalFees.toString(),
    "workflow fee total",
  );
  equalExact(
    workflow.measurements.total_transaction_fees_eth,
    formatEther(totalFees),
    "workflow ETH fee display",
  );
  if (workflow.measurements.total_calldata_bytes !== totalCalldata) {
    throw new Error("Workflow calldata total mismatch");
  }
  const latencies = workflow.transactions.map(
    ({ confirmation_latency_ms }) => confirmation_latency_ms,
  );
  const expectedLatency = {
    median: nearestRank(latencies, 0.5),
    p95: nearestRank(latencies, 0.95),
    minimum: Math.min(...latencies),
    maximum: Math.max(...latencies),
  };
  if (canonical(workflow.measurements.confirmation_latency_ms) !== canonical(expectedLatency)) {
    throw new Error("Workflow latency summary mismatch");
  }
  assertAggregates(
    workflow.transactions,
    workflow.measurements.by_contract,
    ({ contract }) => contract,
    "contract",
  );
  assertAggregates(
    workflow.transactions,
    workflow.measurements.by_role,
    ({ signer_role }) => signer_role,
    "role",
  );
}

export function assertNetworkCostBindings(
  snapshot: NetworkCostSnapshot,
  workflow: PublicWorkflow,
  workflowBytes: Uint8Array,
  manifestBytes: Uint8Array,
  expected: { sourceCommit: string; evaluationSetId: string },
): void {
  equalExact(snapshot.generation_source_commit, expected.sourceCommit, "cost source commit");
  equalExact(snapshot.evaluation_set_id, expected.evaluationSetId, "cost evaluation set");
  equalHex(snapshot.source_workflow_sha256, sha256(workflowBytes), "cost workflow digest");
  equalHex(snapshot.artifact_manifest_sha256, sha256(manifestBytes), "cost manifest digest");
  equalExact(
    snapshot.workflow_source_revision,
    RETAINED_SEPOLIA_WORKFLOW_SOURCE_REVISION,
    "cost retained workflow revision",
  );
  equalExact(snapshot.workflow_source_revision, workflow.source_revision, "cost workflow revision");
  if (
    snapshot.measured_transaction_count !== workflow.measurements.confirmed_transaction_count ||
    snapshot.verified_receipt_count !== workflow.measurements.confirmed_transaction_count ||
    snapshot.measured_calldata_bytes !== workflow.measurements.total_calldata_bytes
  ) {
    throw new Error("Cost snapshot workflow counts differ from the verified trace");
  }
  equalExact(snapshot.measured_gas_used, workflow.measurements.total_gas_used, "cost gas total");
  const expectedProfiles = [
    ["Sepolia", 11_155_111, "observed"],
    ["Ethereum Mainnet", 1, "snapshot estimate"],
    ["Optimism", 10, "snapshot estimate"],
    ["Arbitrum One", 42_161, "snapshot estimate"],
    ["Base", 8_453, "snapshot estimate"],
  ] as const;
  for (const [index, [networkName, chainId, estimateType]] of expectedProfiles.entries()) {
    const network = snapshot.networks[index];
    if (
      network === undefined ||
      network.network !== networkName ||
      network.chain_id !== chainId ||
      network.estimate_type !== estimateType
    ) {
      throw new Error("Cost snapshot network order or profile is invalid");
    }
    if (network.total_fee_eth !== formatEther(BigInt(network.total_fee_wei))) {
      throw new Error(`${networkName} ETH fee display differs from integer fee`);
    }
    const expectedUsd = index === 0 ? null : Number(network.total_fee_eth) * snapshot.eth_usd_spot;
    if (
      expectedUsd === null
        ? network.total_fee_usd !== null
        : network.total_fee_usd === null || !approximately(network.total_fee_usd, expectedUsd)
    ) {
      throw new Error(`${networkName} USD fee display is inconsistent`);
    }
  }
  const [sepolia, ethereum, optimism, arbitrum, base] = snapshot.networks;
  if (sepolia.total_fee_wei !== workflow.measurements.total_transaction_fees_wei) {
    throw new Error("Observed Sepolia fee differs from the workflow receipts");
  }
  for (const network of [ethereum, optimism, base]) {
    const expectedExecutionFee = BigInt(snapshot.measured_gas_used) * BigInt(network.gas_price_wei);
    const componentTotal =
      BigInt(network.execution_fee_wei) +
      BigInt(network.l1_data_fee_wei) +
      BigInt(network.operator_fee_wei);
    if (
      expectedExecutionFee !== BigInt(network.execution_fee_wei) ||
      componentTotal !== BigInt(network.total_fee_wei)
    ) {
      throw new Error(`${network.network} fee components do not sum to the total`);
    }
  }
  const expectedArbitrumExecutionFee =
    BigInt(snapshot.measured_gas_used) * BigInt(arbitrum.gas_price_wei);
  const arbitrumDataFee =
    BigInt(snapshot.measured_transaction_count) * BigInt(arbitrum.per_l2_transaction_wei) +
    BigInt(snapshot.measured_calldata_bytes) * BigInt(arbitrum.per_l1_calldata_byte_wei);
  if (
    expectedArbitrumExecutionFee !== BigInt(arbitrum.execution_fee_wei) ||
    arbitrumDataFee !== BigInt(arbitrum.l1_data_fee_wei) ||
    arbitrum.operator_fee_wei !== "0" ||
    BigInt(arbitrum.execution_fee_wei) + arbitrumDataFee !== BigInt(arbitrum.total_fee_wei)
  ) {
    throw new Error("Arbitrum fee components are inconsistent");
  }
}

export function assertResourceCharacterizationBindings(
  resources: ResourceCharacterization,
  expected: { sourceCommit: string; evaluationSetId: string },
  measuredInputs: ReadonlyMap<string, Uint8Array>,
  expectedReproductionHash: string,
): void {
  equalExact(resources.source_commit, expected.sourceCommit, "resource source commit");
  equalExact(resources.evaluation_set_id, expected.evaluationSetId, "resource evaluation set");
  const expectedPaths = [...measuredInputs.keys()].sort();
  const actualPaths = resources.artifact_storage.files.map(({ path }) => path).sort();
  if (canonical(actualPaths) !== canonical(expectedPaths)) {
    throw new Error("Resource characterization measured-file set differs from the final inputs");
  }
  let totalBytes = 0;
  for (const file of resources.artifact_storage.files) {
    const current = measuredInputs.get(file.path);
    if (current === undefined) throw new Error(`Resource input is unavailable: ${file.path}`);
    if (file.bytes !== current.byteLength || !sameHex(file.sha256, sha256(current))) {
      throw new Error(`Resource input size or digest mismatch: ${file.path}`);
    }
    totalBytes += file.bytes;
  }
  if (resources.artifact_storage.total_bytes !== totalBytes) {
    throw new Error("Resource artifact byte total mismatch");
  }
  const timing = resources.deterministic_assessment;
  if (
    timing.warm_min_ms > timing.warm_p50_ms ||
    timing.warm_p50_ms > timing.warm_p95_ms ||
    timing.warm_p95_ms > timing.warm_max_ms
  ) {
    throw new Error("Resource timing percentiles are out of order");
  }
  equalExact(
    timing.first_reproduction_hash.value,
    expectedReproductionHash,
    "resource reproduction hash",
  );
}

export function assertSustainabilityEvidenceBindings(sustainability: SustainabilityEvidence): void {
  const expected = sustainabilityValidationEvidence();
  if (canonical(sustainability) !== canonical(expected)) {
    throw new Error("Sustainability validation differs from the production route-assessment logic");
  }
}

export function assertContractAssuranceEvidence(input: {
  coverage: ContractCoverage;
  security: ContractSecurity;
  gas: GasStats;
  slither: SlitherResults;
  slitherReview: SlitherReview;
  manifest: ParsedSolidityManifest;
}): void {
  const expectedFiles = expectedContractNames.map((name) => `${name}.sol`).sort();
  const actualFiles = input.coverage.files.map(({ file }) => file).sort();
  if (canonical(actualFiles) !== canonical(expectedFiles)) {
    throw new Error("Contract coverage does not contain the exact seven production contracts");
  }
  let totalFound = 0;
  let totalHit = 0;
  for (const file of input.coverage.files) {
    if (file.hit > file.found)
      throw new Error(`${file.file} coverage hit count exceeds lines found`);
    const linePercent = (file.hit / file.found) * 100;
    if (!approximately(file.linePercent, linePercent) || file.linePercent < 80) {
      throw new Error(`${file.file} line coverage is inconsistent or below the declared threshold`);
    }
    totalFound += file.found;
    totalHit += file.hit;
  }
  if (!approximately(input.coverage.totalLinePercent, (totalHit / totalFound) * 100)) {
    throw new Error("Overall contract line coverage is inconsistent");
  }
  if (input.security.hardhat !== input.manifest.toolchain.hardhat) {
    throw new Error("Contract security artifact uses a different Hardhat version");
  }
  const expectedCompiler = `${input.manifest.compiler.replace(/^solc-/u, "")}-wasm`;
  if (input.security.compiler !== expectedCompiler) {
    throw new Error("Contract security artifact uses a different Solidity compiler");
  }
  const seeds = new Set(input.security.results.map(({ seed }) => seed.toLowerCase()));
  if (seeds.size !== input.security.results.length)
    throw new Error("Contract security seeds repeat");
  if (
    input.security.totalFuzzCases !==
      input.security.results.length *
        input.security.fuzzRunsPerSeed *
        input.security.fuzzFunctions ||
    input.security.totalInvariantRuns !==
      input.security.results.length *
        input.security.invariantRunsPerSeed *
        input.security.invariantFunctions
  ) {
    throw new Error("Contract security randomized-run totals are inconsistent");
  }
  for (const contract of input.manifest.contracts) {
    const key = `${contract.sourceName}:${contract.contractName}`;
    const statistics = input.gas.contracts[key];
    if (statistics === undefined || statistics.contractName !== contract.contractName) {
      throw new Error(`${contract.contractName} gas characterization is missing`);
    }
  }
  const detected = input.slither.results.detectors.map(slitherDetectorIdentity);
  const detectorIds = new Set(detected.map(({ id }) => id));
  const detectorScopes = new Map(detected.map((finding) => [finding.scope, finding]));
  if (detectorIds.size !== detected.length || detectorScopes.size !== detected.length) {
    throw new Error("Slither report contains a duplicate detector identity or scope");
  }
  const reviewed = input.slitherReview.accepted_findings.map((review) => {
    const finding = detectorScopes.get(review.scope);
    if (
      finding === undefined ||
      review.check !== finding.check ||
      review.impact !== finding.impact ||
      review.confidence !== finding.confidence
    ) {
      throw new Error(`Slither review does not match the detector at ${review.scope}`);
    }
    return slitherIdentityKey(finding);
  });
  if (canonical(detected.map(slitherIdentityKey).sort()) !== canonical(reviewed.sort())) {
    throw new Error("Slither review does not account for every detected finding exactly once");
  }
  if (input.slitherReview.image !== input.manifest.toolchain.slitherImage) {
    throw new Error("Slither review image differs from the reviewed toolchain manifest");
  }
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function contractMap<T extends z.ZodType>(schema: T) {
  return z
    .object(
      Object.fromEntries(expectedContractNames.map((name) => [name, schema])) as Record<
        (typeof expectedContractNames)[number],
        T
      >,
    )
    .strict();
}

function rpcSourceSchema() {
  return z
    .object({ rpc_host: z.string().min(1), method: z.string().min(1), chain_id: positiveSafeCount })
    .strict();
}

function assertDeploymentTransactionsEqual(
  verification: SepoliaDeploymentVerification,
  deployment: ParsedPublicDeployment,
): void {
  for (const [index, expected] of deployment.deploymentTransactions.entries()) {
    const actual = verification.deployment_transactions[index];
    if (
      actual === undefined ||
      expected.contract !== actual.contract ||
      expected.blockNumber !== actual.block_number ||
      expected.gasUsed !== actual.gas_used ||
      !sameHex(expected.transactionHash, actual.transaction_hash)
    ) {
      throw new Error("Verified deployment transactions differ from the deployment record");
    }
  }
  for (const [index, expected] of deployment.configurationTransactions.entries()) {
    const actual = verification.configuration_transactions[index];
    if (
      actual === undefined ||
      expected.contract !== actual.contract ||
      expected.function !== actual.function ||
      expected.blockNumber !== actual.block_number ||
      expected.gasUsed !== actual.gas_used ||
      expected.transactionFeeWei !== actual.transaction_fee_wei ||
      !sameHex(expected.transactionHash, actual.transaction_hash)
    ) {
      throw new Error("Verified configuration transactions differ from the deployment record");
    }
  }
}

function assertAggregates<T extends { gas_used: string; transaction_fee_wei: string }>(
  transactions: readonly T[],
  recorded: Record<string, z.infer<typeof aggregateMeasurement>>,
  key: (transaction: T) => string,
  label: string,
): void {
  const expected: Record<string, z.infer<typeof aggregateMeasurement>> = {};
  for (const transaction of transactions) {
    const name = key(transaction);
    const current = expected[name] ?? {
      transaction_count: 0,
      gas_used: "0",
      transaction_fees_wei: "0",
    };
    expected[name] = {
      transaction_count: current.transaction_count + 1,
      gas_used: (BigInt(current.gas_used) + BigInt(transaction.gas_used)).toString(),
      transaction_fees_wei: (
        BigInt(current.transaction_fees_wei) + BigInt(transaction.transaction_fee_wei)
      ).toString(),
    };
  }
  if (canonical(recorded) !== canonical(expected)) {
    throw new Error(`Workflow ${label} aggregates are inconsistent`);
  }
}

function nearestRank(values: readonly number[], probability: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1);
  const result = sorted[index];
  if (result === undefined) throw new Error("Cannot calculate a percentile from no observations");
  return result;
}

interface SlitherDetectorIdentity {
  readonly id: string;
  readonly location: string;
  readonly scope: string;
  readonly check: string;
  readonly impact: string;
  readonly confidence: string;
}

function slitherDetectorIdentity(
  detector: z.infer<typeof slitherDetector>,
): SlitherDetectorIdentity {
  const element = detector.elements[0];
  if (element === null || typeof element !== "object") {
    throw new Error(`Slither detector ${detector.id} has no primary element`);
  }
  const fields = unknownProperty(element, "type_specific_fields");
  const mapping = unknownProperty(element, "source_mapping");
  if (
    fields === null ||
    typeof fields !== "object" ||
    mapping === null ||
    typeof mapping !== "object"
  ) {
    throw new Error(`Slither detector ${detector.id} has incomplete element metadata`);
  }
  const parent = unknownProperty(fields, "parent");
  const signature = unknownProperty(fields, "signature");
  const filename = unknownProperty(mapping, "filename_relative");
  const lines = unknownProperty(mapping, "lines");
  const parentName =
    parent !== null && typeof parent === "object" ? unknownProperty(parent, "name") : undefined;
  if (
    parent === null ||
    typeof parent !== "object" ||
    typeof parentName !== "string" ||
    typeof signature !== "string" ||
    typeof filename !== "string" ||
    !Array.isArray(lines) ||
    lines.length === 0 ||
    !lines.every(
      (line: unknown) => typeof line === "number" && line > 0 && Number.isSafeInteger(line),
    )
  ) {
    throw new Error(`Slither detector ${detector.id} has invalid location or scope metadata`);
  }
  const firstLine = lines[0] as number;
  const lastLine = lines.at(-1) as number;
  const location = `${filename}#L${String(firstLine)}-L${String(lastLine)}`;
  const scope = `${parentName}.${signature}`;
  if (detector.first_markdown_element !== location || !detector.description.includes(scope)) {
    throw new Error(`Slither detector ${detector.id} has inconsistent location or scope`);
  }
  return {
    id: detector.id,
    location,
    scope,
    check: detector.check,
    impact: detector.impact,
    confidence: detector.confidence,
  };
}

function slitherIdentityKey(value: SlitherDetectorIdentity): string {
  return [value.id, value.location, value.scope, value.check, value.impact, value.confidence].join(
    "\u0000",
  );
}

function unknownProperty(target: object, key: string): unknown {
  return Reflect.get(target, key) as unknown;
}

function assertAddressMapsEqual(
  actual: Record<string, string>,
  expected: Record<string, string>,
  label: string,
): void {
  const normalize = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, value.toLowerCase()]),
    );
  if (canonical(normalize(actual)) !== canonical(normalize(expected))) {
    throw new Error(`${label} differ from the reviewed deployment`);
  }
}

function sumBigInts(values: readonly string[]): bigint {
  return values.reduce((sum, value) => sum + BigInt(value), 0n);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function equalHex(left: string, right: string, label: string): void {
  if (!sameHex(left, right)) throw new Error(`${label} mismatch`);
}

function equalExact(left: string, right: string, label: string): void {
  if (left !== right) throw new Error(`${label} mismatch`);
}

function approximately(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-12);
}

export function asDeploymentProfile(
  deployment: ParsedPublicDeployment,
): PublicSepoliaDeployment & { addresses: DeploymentAddresses } {
  return deployment;
}

export function asSolidityManifest(manifest: ParsedSolidityManifest): SolidityArtifactManifest {
  return manifest;
}
