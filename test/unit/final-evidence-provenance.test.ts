import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { formatEther } from "ethers";
import { describe, expect, it } from "vitest";

import {
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
  sha256Bytes,
  slitherResultsSchema,
  slitherReviewSchema,
  solidityArtifactManifestSchema,
  strictSustainabilityEvidenceSchema,
  type PublicWorkflow,
} from "../../scripts/lib/final-evidence-provenance.js";
import {
  expectedContractNames,
  verifyReviewedArtifactBinding,
  verifyReviewedRuntimeBytecode,
  type ReviewedSolidityArtifact,
  type RuntimeBytecodeVerification,
  type SolidityBuildInfoOutput,
} from "../../scripts/lib/sepolia-deployment-verification.js";
import { sepoliaWorkflowRoles } from "../../scripts/lib/sepolia-workflow-config.js";
import {
  RETAINED_SEPOLIA_WORKFLOW_SOURCE_REVISION,
  sepoliaWorkflowRecipe,
} from "../../scripts/lib/sepolia-workflow-recipe.js";

describe("final evidence provenance", () => {
  it("strictly parses the retained deterministic and contract assurance artifacts", async () => {
    const manifest = solidityArtifactManifestSchema.parse(
      await json("contracts/generated/solidity/manifest.json"),
    );
    const coverage = contractCoverageSchema.parse(
      await json("evaluation/final/assurance/contracts/coverage.json"),
    );
    const security = contractSecuritySchema.parse(
      await json("evaluation/final/assurance/contracts/security.json"),
    );
    const gas = gasStatsSchema.parse(
      await json("evaluation/final/assurance/contracts/gas-stats.json"),
    );
    const slither = slitherResultsSchema.parse(
      await json("evaluation/final/assurance/contracts/slither.json"),
    );
    const slitherReview = slitherReviewSchema.parse(
      await json("evaluation/final/assurance/contracts/slither-review.json"),
    );
    expect(() =>
      assertContractAssuranceEvidence({
        coverage,
        security,
        gas,
        slither,
        slitherReview,
        manifest,
      }),
    ).not.toThrow();
    const sustainability = strictSustainabilityEvidenceSchema.parse(
      await json("evaluation/final/sustainability-validation.json"),
    );
    expect(() => assertSustainabilityEvidenceBindings(sustainability)).not.toThrow();
    expect(() =>
      strictSustainabilityEvidenceSchema.parse({
        ...sustainability,
        unexpected: true,
      }),
    ).toThrow();
    const alteredSustainability = structuredClone(sustainability);
    alteredSustainability.scenarios.nominal = { fabricated: true };
    expect(() => assertSustainabilityEvidenceBindings(alteredSustainability)).toThrow(
      /production route-assessment logic/u,
    );

    const duplicateReview = structuredClone(slitherReview);
    duplicateReview.accepted_findings[1] = structuredClone(duplicateReview.accepted_findings[0]!);
    expect(() =>
      assertContractAssuranceEvidence({
        coverage,
        security,
        gas,
        slither,
        slitherReview: duplicateReview,
        manifest,
      }),
    ).toThrow(/every detected finding exactly once/u);

    const alteredLocation = structuredClone(slither);
    alteredLocation.results.detectors[0]!.first_markdown_element =
      "contracts/AuditAnchor.sol#L1-L1";
    expect(() =>
      assertContractAssuranceEvidence({
        coverage,
        security,
        gas,
        slither: alteredLocation,
        slitherReview,
        manifest,
      }),
    ).toThrow(/inconsistent location or scope/u);
  });

  it("binds every deployment runtime field to reviewed local bytecode", async () => {
    const fixture = await deploymentVerificationFixture();
    const bind = (verification = fixture.verification) =>
      assertDeploymentVerificationBindings(
        fixture.deployment,
        fixture.manifest,
        verification,
        fixture.expectedRuntime,
      );
    expect(() => bind()).not.toThrow();

    for (const field of ["onchain_sha256", "reviewed_sha256", "normalized_sha256"] as const) {
      const altered = structuredClone(fixture.verification);
      altered.runtime_bytecode.AuthorityProfileRegistry[field] = `0x${"00".repeat(32)}`;
      expect(() => bind(altered)).toThrow(/runtime verification differs/u);
    }

    const alteredBytecode = structuredClone(fixture.verification);
    alteredBytecode.runtime_bytecode.AuthorityProfileRegistry.onchain_bytecode = "0x00";
    expect(() => bind(alteredBytecode)).toThrow(/runtime verification differs/u);

    const alteredSize = structuredClone(fixture.verification);
    alteredSize.runtime_bytecode.AuthorityProfileRegistry.size_bytes += 1;
    expect(() => bind(alteredSize)).toThrow(/runtime verification differs/u);
  });

  it("rejects duplicate receipts and altered workflow aggregates", async () => {
    const deployment = publicSepoliaDeploymentSchema.parse(
      await json("contracts/generated/solidity/sepolia-deployment.json"),
    );
    const manifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
    const workflow = workflowFixture(deployment.addresses, deployment.governance);
    expect(() => assertPublicWorkflowBindings(workflow, deployment, manifestBytes)).not.toThrow();

    const duplicate = structuredClone(workflow);
    duplicate.transactions[1]!.transaction_hash = duplicate.transactions[0]!.transaction_hash;
    expect(() => assertPublicWorkflowBindings(duplicate, deployment, manifestBytes)).toThrow(
      /not unique/u,
    );

    const alteredTotal = structuredClone(workflow);
    alteredTotal.measurements.total_gas_used = "1";
    expect(() => assertPublicWorkflowBindings(alteredTotal, deployment, manifestBytes)).toThrow(
      /gas total/u,
    );

    for (const mutate of [
      (candidate: PublicWorkflow) => {
        candidate.transactions[0]!.step = "Fabricated step";
      },
      (candidate: PublicWorkflow) => {
        candidate.transactions[0]!.function = "setCredential";
      },
      (candidate: PublicWorkflow) => {
        candidate.transactions[0]!.signer_role = "seller";
        candidate.transactions[0]!.signer_address = candidate.role_addresses.seller;
      },
      (candidate: PublicWorkflow) => {
        candidate.transactions[0]!.events = ["AuthorityProfileRegistry.CredentialSet"];
      },
      (candidate: PublicWorkflow) => {
        candidate.transactions[44]!.value_wei = "0";
      },
      (candidate: PublicWorkflow) => {
        candidate.source_revision = "a".repeat(40);
      },
    ]) {
      const altered = structuredClone(workflow);
      mutate(altered);
      expect(() => assertPublicWorkflowBindings(altered, deployment, manifestBytes)).toThrow();
    }

    expect(() =>
      publicWorkflowSchema.parse({
        ...workflow,
        final_state: { ...workflow.final_state, evidence_active: false },
      }),
    ).toThrow();
  });

  it("binds every characterized resource to its source, size, and digest", () => {
    const inputs = new Map(
      ["a", "b", "c", "d", "e"].map((path) => [path, Buffer.from(`content-${path}`)] as const),
    );
    const resource = resourceCharacterizationSchema.parse({
      schema: "EVLLM_RESOURCE_CHARACTERIZATION_V2",
      measured_at: "2026-08-28T00:00:00.000Z",
      source_commit: "a".repeat(40),
      evaluation_set_id: "evaluation-set",
      source_scope: "test",
      environment: {
        node: "v24.0.0",
        platform: "win32",
        release: "test",
        logical_cpu_count: 1,
        cpu_model: "test",
      },
      deterministic_assessment: {
        first_call_ms: 1,
        warm_runs: 1_000,
        warm_p50_ms: 2,
        warm_p95_ms: 3,
        warm_min_ms: 1,
        warm_max_ms: 4,
        first_reproduction_hash: { alg: "SHA-256", value: "A".repeat(43) },
      },
      artifact_storage: {
        files: [...inputs].map(([path, content]) => ({
          path,
          bytes: content.byteLength,
          sha256: sha256Bytes(content),
        })),
        total_bytes: [...inputs.values()].reduce((total, content) => total + content.byteLength, 0),
      },
      interpretation_boundary: "test",
    });
    expect(() =>
      assertResourceCharacterizationBindings(
        resource,
        { sourceCommit: "a".repeat(40), evaluationSetId: "evaluation-set" },
        inputs,
        "A".repeat(43),
      ),
    ).not.toThrow();

    const changed = new Map(inputs);
    changed.set("c", Buffer.from("altered"));
    expect(() =>
      assertResourceCharacterizationBindings(
        resource,
        { sourceCommit: "a".repeat(40), evaluationSetId: "evaluation-set" },
        changed,
        "A".repeat(43),
      ),
    ).toThrow(/size or digest/u);

    expect(() =>
      assertResourceCharacterizationBindings(
        resource,
        { sourceCommit: "a".repeat(40), evaluationSetId: "evaluation-set" },
        inputs,
        "a".repeat(43),
      ),
    ).toThrow(/reproduction hash/u);
  });

  it("cross-binds cost arithmetic to the exact workflow bytes", async () => {
    const deployment = publicSepoliaDeploymentSchema.parse(
      await json("contracts/generated/solidity/sepolia-deployment.json"),
    );
    const manifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
    const workflow = workflowFixture(deployment.addresses, deployment.governance);
    const workflowBytes = Buffer.from(JSON.stringify(workflow));
    const snapshot = networkCostSnapshotSchema.parse(
      costFixture(workflow, workflowBytes, manifestBytes),
    );
    expect(() =>
      assertNetworkCostBindings(snapshot, workflow, workflowBytes, manifestBytes, {
        sourceCommit: "a".repeat(40),
        evaluationSetId: "evaluation-set",
      }),
    ).not.toThrow();

    const detached = structuredClone(snapshot);
    detached.source_workflow_sha256 = `0x${"00".repeat(32)}`;
    expect(() =>
      assertNetworkCostBindings(detached, workflow, workflowBytes, manifestBytes, {
        sourceCommit: "a".repeat(40),
        evaluationSetId: "evaluation-set",
      }),
    ).toThrow(/workflow digest/u);

    const alteredExecution = structuredClone(snapshot);
    const ethereum = alteredExecution.networks[1];
    ethereum.execution_fee_wei = (BigInt(ethereum.execution_fee_wei) + 1n).toString();
    ethereum.total_fee_wei = (BigInt(ethereum.total_fee_wei) + 1n).toString();
    ethereum.total_fee_eth = formatEther(BigInt(ethereum.total_fee_wei));
    ethereum.total_fee_usd = Number(ethereum.total_fee_eth) * alteredExecution.eth_usd_spot;
    expect(() =>
      assertNetworkCostBindings(alteredExecution, workflow, workflowBytes, manifestBytes, {
        sourceCommit: "a".repeat(40),
        evaluationSetId: "evaluation-set",
      }),
    ).toThrow(/fee components/u);
  });
});

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

function workflowFixture(
  addresses: Record<(typeof expectedContractNames)[number], string>,
  governance: string,
): PublicWorkflow {
  const roleAddresses = Object.fromEntries(
    sepoliaWorkflowRoles.map(({ role }, index) => [
      role,
      index === 1 ? governance : `0x${String(index + 1).padStart(40, "0")}`,
    ]),
  ) as Record<(typeof sepoliaWorkflowRoles)[number]["role"], string>;
  const purchaseAmount = "1000";
  const transactions = sepoliaWorkflowRecipe.map((recipe, index) => ({
    sequence: recipe.sequence,
    step: recipe.step,
    contract: recipe.contract,
    function: recipe.function,
    signer_role: recipe.signerRole,
    signer_address: roleAddresses[recipe.signerRole],
    transaction_hash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    submitted_at: "2026-08-18T00:00:00.000Z",
    calldata_bytes: 4,
    value_wei: recipe.valueRule === "purchase-amount" ? purchaseAmount : "0",
    block_number: 1_000 + index,
    confirmed_at: "2026-08-18T00:00:01.000Z",
    confirmation_latency_ms: index + 1,
    gas_used: "100",
    effective_gas_price_wei: "2",
    transaction_fee_wei: "200",
    events: [...recipe.expectedEvents],
    status: "confirmed" as const,
  }));
  const byContract = workflowAggregates(transactions, ({ contract }) => contract);
  const byRole = workflowAggregates(transactions, ({ signer_role }) => signer_role);
  const roleBalances = Object.fromEntries(sepoliaWorkflowRoles.map(({ role }) => [role, "1"]));
  return publicWorkflowSchema.parse({
    schema: "EVLLM_SEPOLIA_FULL_WORKFLOW_V1",
    created_at: "2026-08-18T00:01:00.000Z",
    workflow_id: "paper-public-workflow-v1",
    network: "sepolia",
    chain_id: "11155111",
    source_revision: RETAINED_SEPOLIA_WORKFLOW_SOURCE_REVISION,
    working_tree_status_sha256: "c".repeat(64),
    role_addresses: roleAddresses,
    contract_addresses: addresses,
    case: {
      purchase_amount_wei: purchaseAmount,
      battery_id: hash(101),
      claim_id: hash(102),
      listing_id: hash(103),
      offer_id: hash(104),
      agreement_id: hash(105),
      audit_batch_id: hash(106),
    },
    transactions,
    measurements: {
      confirmed_transaction_count: 57,
      total_gas_used: "5700",
      total_transaction_fees_wei: "11400",
      total_transaction_fees_eth: formatEther(11_400n),
      total_calldata_bytes: 228,
      confirmation_latency_ms: { median: 29, p95: 55, minimum: 1, maximum: 57 },
      by_contract: byContract,
      by_role: byRole,
      role_balances_before_wei: roleBalances,
      role_balances_after_wei: roleBalances,
      marketplace_balance_before_wei: "0",
      marketplace_balance_after_wei: "0",
    },
    final_state: {
      agreement_settled: true,
      listing_closed_settled: true,
      offer_accepted: true,
      buyer_is_recorded_owner: true,
      battery_lock_released: true,
      evidence_active: true,
      independent_assertion_active: true,
      seller_credit_withdrawn: true,
      audit_batch_anchored: true,
      listing_origin_bound: true,
      agreement_origin_bound: true,
      agreement_state: 9,
      listing_state: 5,
      offer_state: 2,
      recorded_owner_organization_id: hash(107),
      marketplace_lock: "0x0000000000000000000000000000000000000000",
      seller_credit_wei: "0",
    },
  });
}

async function deploymentVerificationFixture() {
  const deployment = publicSepoliaDeploymentSchema.parse(
    await json("contracts/generated/solidity/sepolia-deployment.json"),
  );
  const manifest = solidityArtifactManifestSchema.parse(
    await json("contracts/generated/solidity/manifest.json"),
  );
  const expectedRuntime: Record<string, RuntimeBytecodeVerification> = {};
  const runtimeBytecode: Record<string, unknown> = {};
  for (const name of expectedContractNames) {
    const artifact = (await json(
      `artifacts/contracts/${name}.sol/${name}.json`,
    )) as ReviewedSolidityArtifact;
    const manifestContract = manifest.contracts.find(({ contractName }) => contractName === name);
    if (manifestContract === undefined) throw new Error(`${name} is absent from the test manifest`);
    const buildInfoOutputBytes = await readFile(
      resolve(`artifacts/build-info/${manifestContract.buildInfoId}.output.json`),
    );
    const binding = verifyReviewedArtifactBinding(
      name,
      artifact,
      manifestContract,
      buildInfoOutputBytes,
      JSON.parse(buildInfoOutputBytes.toString("utf8")) as SolidityBuildInfoOutput,
    );
    const verified = verifyReviewedRuntimeBytecode(
      name,
      artifact.deployedBytecode,
      artifact,
      binding,
    );
    expectedRuntime[name] = verified;
    runtimeBytecode[name] = {
      onchain_bytecode: verified.onchainBytecode,
      onchain_sha256: verified.onchainSha256,
      reviewed_sha256: verified.reviewedSha256,
      normalized_sha256: verified.normalizedSha256,
      size_bytes: verified.sizeBytes,
    };
  }
  const deploymentGas = sumStrings(deployment.deploymentTransactions.map(({ gasUsed }) => gasUsed));
  const configurationGas = sumStrings(
    deployment.configurationTransactions.map(({ gasUsed }) => gasUsed),
  );
  const configurationFees = sumStrings(
    deployment.configurationTransactions.map(({ transactionFeeWei }) => transactionFeeWei),
  );
  const latestBlock = Math.max(
    ...deployment.deploymentTransactions.map(({ blockNumber }) => blockNumber),
    ...deployment.configurationTransactions.map(({ blockNumber }) => blockNumber),
    ...deployment.activations.map(({ blockNumber }) => blockNumber),
  );
  const verification = sepoliaDeploymentVerificationSchema.parse({
    schema: "EVLLM_SEPOLIA_DEPLOYMENT_VERIFICATION_V2",
    verified_at: "2026-08-28T00:00:00.000Z",
    chain_id: deployment.chainId,
    latest_block: latestBlock,
    governance: deployment.governance,
    artifact_manifest_sha256: deployment.artifactManifestSha256,
    compiler: deployment.compiler,
    review_delay_seconds: deployment.reviewDelaySeconds,
    addresses: deployment.addresses,
    runtime_bytecode: runtimeBytecode,
    deployment_transactions: deployment.deploymentTransactions.map((transaction) => ({
      contract: transaction.contract,
      block_number: transaction.blockNumber,
      transaction_hash: transaction.transactionHash,
      gas_used: transaction.gasUsed,
    })),
    configuration_transactions: deployment.configurationTransactions.map((transaction) => ({
      contract: transaction.contract,
      function: transaction.function,
      block_number: transaction.blockNumber,
      transaction_hash: transaction.transactionHash,
      gas_used: transaction.gasUsed,
      transaction_fee_wei: transaction.transactionFeeWei,
    })),
    deployment_gas_used: deploymentGas.toString(),
    configuration_gas_used: configurationGas.toString(),
    commissioning_gas_used: (deploymentGas + configurationGas).toString(),
    configuration_transaction_fees_wei: configurationFees.toString(),
    active_modules: {
      evidence: deployment.addresses.EvidenceRegistry,
      marketplace: deployment.addresses.Marketplace,
      audit: deployment.addresses.AuditAnchor,
    },
    protected_bundle_bootstrap_closed: true,
    marketplace_authorized_for_battery_locking: true,
    activation_events: deployment.activations.map((activationRecord) => ({
      module: activationRecord.module,
      block_number: activationRecord.blockNumber,
      transaction_hash: activationRecord.transactionHash,
    })),
    explorer: "https://sepolia.etherscan.io",
  });
  return { deployment, manifest, verification, expectedRuntime };
}

function workflowAggregates<T extends { gas_used: string; transaction_fee_wei: string }>(
  transactions: readonly T[],
  key: (transaction: T) => string,
) {
  const result: Record<
    string,
    { transaction_count: number; gas_used: string; transaction_fees_wei: string }
  > = {};
  for (const transaction of transactions) {
    const name = key(transaction);
    const current = result[name] ?? {
      transaction_count: 0,
      gas_used: "0",
      transaction_fees_wei: "0",
    };
    result[name] = {
      transaction_count: current.transaction_count + 1,
      gas_used: (BigInt(current.gas_used) + BigInt(transaction.gas_used)).toString(),
      transaction_fees_wei: (
        BigInt(current.transaction_fees_wei) + BigInt(transaction.transaction_fee_wei)
      ).toString(),
    };
  }
  return result;
}

function sumStrings(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + BigInt(value), 0n);
}

function costFixture(workflow: PublicWorkflow, workflowBytes: Buffer, manifestBytes: Buffer) {
  const gas = BigInt(workflow.measurements.total_gas_used);
  const calldata = BigInt(workflow.measurements.total_calldata_bytes);
  const transactionCount = BigInt(workflow.measurements.confirmed_transaction_count);
  const gasPrice = 2n;
  const execution = gas * gasPrice;
  const arbitrumData = transactionCount + calldata;
  const snapshotNetwork = (network: string, chainId: number, total: bigint, l1Data = 0n) => ({
    network,
    chain_id: chainId,
    estimate_type: "snapshot estimate",
    method: "test",
    gas_price_wei: gasPrice.toString(),
    serialized_transaction_bytes: 100,
    execution_fee_wei: execution.toString(),
    l1_data_fee_wei: l1Data.toString(),
    operator_fee_wei: "0",
    total_fee_wei: total.toString(),
    total_fee_eth: formatEther(total),
    block_number: 1,
    block_timestamp: "2026-08-28T00:00:00.000Z",
    total_fee_usd: Number(formatEther(total)) * 1_000,
  });
  return {
    schema: "EVLLM_CROSS_NETWORK_COST_SNAPSHOT_V2",
    created_at: "2026-08-28T00:00:00.000Z",
    generation_source_commit: "a".repeat(40),
    evaluation_set_id: "evaluation-set",
    source_workflow: "evaluation/final/assurance/deployment/sepolia-full-workflow.json",
    source_workflow_sha256: sha256Bytes(workflowBytes),
    artifact_manifest_sha256: sha256Bytes(manifestBytes),
    workflow_source_revision: workflow.source_revision,
    verified_receipt_count: 57,
    measured_transaction_count: 57,
    measured_gas_used: workflow.measurements.total_gas_used,
    measured_calldata_bytes: workflow.measurements.total_calldata_bytes,
    eth_usd_spot: 1_000,
    eth_usd_source: "https://example.com/spot",
    fee_parameter_sources: {
      ethereum: { rpc_host: "example.com", method: "test", chain_id: 1 },
      optimism: { rpc_host: "example.com", method: "test", chain_id: 10 },
      arbitrum: { rpc_host: "example.com", method: "test", chain_id: 42_161 },
      base: { rpc_host: "example.com", method: "test", chain_id: 8_453 },
    },
    interpretation: "test",
    networks: [
      {
        network: "Sepolia",
        chain_id: 11_155_111,
        estimate_type: "observed",
        method: "test",
        total_fee_wei: workflow.measurements.total_transaction_fees_wei,
        total_fee_eth: workflow.measurements.total_transaction_fees_eth,
        total_fee_usd: null,
      },
      snapshotNetwork("Ethereum Mainnet", 1, execution),
      snapshotNetwork("Optimism", 10, execution),
      {
        network: "Arbitrum One",
        chain_id: 42_161,
        estimate_type: "snapshot estimate",
        method: "test",
        gas_price_wei: gasPrice.toString(),
        calldata_bytes: Number(calldata),
        execution_fee_wei: execution.toString(),
        l1_data_fee_wei: arbitrumData.toString(),
        operator_fee_wei: "0",
        total_fee_wei: (execution + arbitrumData).toString(),
        total_fee_eth: formatEther(execution + arbitrumData),
        per_l2_transaction_wei: "1",
        per_l1_calldata_byte_wei: "1",
        block_number: 1,
        block_timestamp: "2026-08-28T00:00:00.000Z",
        total_fee_usd: Number(formatEther(execution + arbitrumData)) * 1_000,
      },
      snapshotNetwork("Base", 8_453, execution),
    ],
    source_documentation: {
      optimism: "https://example.com/optimism",
      arbitrum: "https://example.com/arbitrum",
      base: "https://example.com/base",
    },
  };
}

function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
