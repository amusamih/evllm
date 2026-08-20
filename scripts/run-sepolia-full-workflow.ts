import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { config as loadEnvironment } from "dotenv";
import type { BaseContract, Signer, TransactionReceipt } from "ethers";
import { Wallet, ZeroAddress, concat, formatEther, getAddress, keccak256 } from "ethers";
import { network } from "hardhat";

import {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_WORKFLOW_CONFIRMATION,
  SEPOLIA_WORKFLOW_ID,
  SEPOLIA_WORKFLOW_PURCHASE_WEI,
  type SepoliaContractName,
  type SepoliaWorkflowRole,
  sepoliaContractNames,
  sepoliaWorkflowRoles,
} from "./lib/sepolia-workflow-config.js";

interface RecordedTransaction {
  readonly sequence: number;
  readonly step: string;
  readonly contract: string;
  readonly function: string;
  readonly signer_role: SepoliaWorkflowRole;
  readonly signer_address: string;
  readonly transaction_hash: string;
  readonly submitted_at: string;
  readonly calldata_bytes: number;
  readonly value_wei: string;
  block_number: number | null;
  confirmed_at: string | null;
  confirmation_latency_ms: number | null;
  gas_used: string | null;
  effective_gas_price_wei: string | null;
  transaction_fee_wei: string | null;
  events: string[];
  status: "pending" | "confirmed" | "failed";
}

interface BundleSpecification {
  readonly label: string;
  readonly domainKey: string;
  readonly bundleType: string;
  readonly payloadCommitment: string;
  readonly authorRole: SepoliaWorkflowRole;
  readonly controllerRole: SepoliaWorkflowRole;
  readonly decisionCritical: boolean;
}

loadEnvironment({ path: ".env/local.env", quiet: true });
loadEnvironment({ path: ".env/sepolia-demo.env", quiet: true });

const { ethers, networkName } = await network.create();
const isSepolia = networkName === "sepolia";
const isRehearsal = networkName === "hardhatMainnet";
if (!isSepolia && !isRehearsal) {
  throw new Error("The full workflow is restricted to Sepolia or the controlled local rehearsal");
}
if (isSepolia && process.env.SEPOLIA_WORKFLOW_CONFIRM !== SEPOLIA_WORKFLOW_CONFIRMATION) {
  throw new Error(
    `Set SEPOLIA_WORKFLOW_CONFIRM=${SEPOLIA_WORKFLOW_CONFIRMATION} only after the preflight is ready`,
  );
}

const provider = ethers.provider;
const chain = await provider.getNetwork();
if (isSepolia && chain.chainId !== SEPOLIA_CHAIN_ID) throw new Error("Unexpected Sepolia chain ID");

const signers = new Map<SepoliaWorkflowRole, Signer>();
if (isSepolia) {
  for (const specification of sepoliaWorkflowRoles) {
    const privateKey = requiredEnvironment(specification.environment);
    signers.set(specification.role, new Wallet(privateKey, provider));
  }
} else {
  const localSigners = await ethers.getSigners();
  if (localSigners.length < sepoliaWorkflowRoles.length) {
    throw new Error("The local rehearsal requires eleven distinct signers");
  }
  sepoliaWorkflowRoles.forEach((specification, index) => {
    const signer = localSigners[index];
    if (signer === undefined) throw new Error(`Missing local signer for ${specification.role}`);
    signers.set(specification.role, signer);
  });
}

const roleAddresses = new Map<SepoliaWorkflowRole, string>();
for (const specification of sepoliaWorkflowRoles) {
  roleAddresses.set(specification.role, getAddress(await signer(specification.role).getAddress()));
}
const addressGroups = new Map<string, SepoliaWorkflowRole[]>();
for (const [role, address] of roleAddresses) {
  const roles = addressGroups.get(address.toLowerCase()) ?? [];
  roles.push(role);
  addressGroups.set(address.toLowerCase(), roles);
}
for (const roles of addressGroups.values()) {
  if (roles.length > 1) throw new Error(`Workflow roles share one account: ${roles.join(", ")}`);
}

const contracts = isSepolia ? await connectExistingDeployment() : await deployLocalRehearsal();
await verifyDeploymentConfiguration(contracts);

const checkpointDirectory = resolve(".local-results", "sepolia-full-workflow");
const checkpointPath = resolve(
  checkpointDirectory,
  `${isSepolia ? "sepolia" : "rehearsal"}-checkpoint.json`,
);
await mkdir(checkpointDirectory, { recursive: true });
const transactions = isSepolia ? await loadCheckpoint(checkpointPath) : [];
await finalizePendingTransactions();

const ids = createWorkflowIds();
if (isSepolia && transactions.length === 0) {
  const existingIssuerStatus = Number(
    await read<bigint>(
      contracts.AuthorityProfileRegistry,
      "organizationStatus",
      ids.issuer.organizationId,
    ),
  );
  if (existingIssuerStatus !== 0) {
    throw new Error(
      "The workflow has existing on-chain state but no local checkpoint. Stop before spending more ETH and recover the prior trace.",
    );
  }
}

const startingBalances = await readRoleBalances();
const marketplaceStartingBalance = await provider.getBalance(
  await contracts.Marketplace.getAddress(),
);
const sellerStartingCredit = await read<bigint>(
  contracts.Marketplace,
  "withdrawableCredits",
  addressOf("seller"),
);
if (sellerStartingCredit !== 0n) {
  throw new Error(
    "The seller account has an existing marketplace credit; use a clean role account",
  );
}

for (const identity of Object.values(ids.identities)) {
  await ensureOrganization(identity.organizationId, identity.label);
  await ensureCredential(identity);
}
await ensureRegistrar();
await ensureReplicaRepository();

const issueCapability = await read<string>(contracts.EvidenceRegistry, "ISSUE_CAPABILITY");
const certifyCapability = await read<string>(contracts.EvidenceRegistry, "CERTIFY_CAPABILITY");
const listingCapability = await read<string>(contracts.Marketplace, "LISTING_CAPABILITY");
const offerCapability = await read<string>(contracts.Marketplace, "OFFER_CAPABILITY");
const logisticsCapability = await read<string>(contracts.Marketplace, "LOGISTICS_CAPABILITY");
const anchorCapability = await read<string>(contracts.AuditAnchor, "ANCHOR_CAPABILITY");

await ensureCapability(ids.issuer, issueCapability, ids.claimId, "Allow evidence issuance");
await ensureCapability(
  ids.verifier,
  certifyCapability,
  ids.claimId,
  "Allow certification assertion",
);
await ensureCapability(ids.seller, listingCapability, ids.batteryId, "Allow listing creation");
await ensureCapability(ids.buyer, offerCapability, ids.listingId, "Allow offer submission");
await ensureCapability(
  ids.logistics_provider,
  logisticsCapability,
  ids.agreementId,
  "Allow logistics records",
);
await ensureCapability(
  ids.audit_anchor,
  anchorCapability,
  ids.auditBatchId,
  "Allow audit anchoring",
);

await ensureInitialOwnership();

const evidenceBundle = await ensureBundle({
  label: "diagnostic-evidence",
  domainKey: ids.claimId,
  bundleType: await read<string>(contracts.EvidenceRegistry, "EVIDENCE_BUNDLE_TYPE"),
  payloadCommitment: ids.evidencePayloadCommitment,
  authorRole: "issuer",
  controllerRole: "controller",
  decisionCritical: true,
});
await ensureEvidenceActivation(evidenceBundle);

const verificationBundle = await ensureBundle({
  label: "verification-assertion",
  domainKey: ids.assertionId,
  bundleType: await read<string>(contracts.EvidenceRegistry, "VERIFICATION_BUNDLE_TYPE"),
  payloadCommitment: ids.verificationPayloadCommitment,
  authorRole: "verifier",
  controllerRole: "controller",
  decisionCritical: true,
});
await ensureVerificationAssertion(verificationBundle);

const listingBundle = await ensureBundle({
  label: "listing",
  domainKey: ids.listingId,
  bundleType: await read<string>(contracts.Marketplace, "LISTING_BUNDLE_TYPE"),
  payloadCommitment: ids.listingPayloadCommitment,
  authorRole: "seller",
  controllerRole: "seller",
  decisionCritical: true,
});
await ensureListing(listingBundle);
await ensureOffer();

const agreementBundle = await ensureBundle({
  label: "agreement",
  domainKey: ids.agreementId,
  bundleType: await read<string>(contracts.Marketplace, "AGREEMENT_BUNDLE_TYPE"),
  payloadCommitment: ids.agreementPayloadCommitment,
  authorRole: "seller",
  controllerRole: "seller",
  decisionCritical: true,
});
await ensureAgreement(agreementBundle);
await ensureAgreementFunding();

const dispatchBundle = await ensureBundle({
  label: "dispatch",
  domainKey: ids.dispatchId,
  bundleType: await read<string>(contracts.Marketplace, "LOGISTICS_BUNDLE_TYPE"),
  payloadCommitment: ids.dispatchPayloadCommitment,
  authorRole: "logistics_provider",
  controllerRole: "logistics_provider",
  decisionCritical: true,
});
const deliveryBundle = await ensureBundle({
  label: "delivery",
  domainKey: ids.deliveryId,
  bundleType: await read<string>(contracts.Marketplace, "LOGISTICS_BUNDLE_TYPE"),
  payloadCommitment: ids.deliveryPayloadCommitment,
  authorRole: "logistics_provider",
  controllerRole: "logistics_provider",
  decisionCritical: true,
});
await ensureLogisticsAndSettlement(dispatchBundle, deliveryBundle);
await ensureAuditAnchor();

const finalState = await verifyFinalState();
const endingBalances = await readRoleBalances();
const marketplaceEndingBalance = await provider.getBalance(
  await contracts.Marketplace.getAddress(),
);
const confirmedTransactions = transactions.filter((entry) => entry.status === "confirmed");
const totalGas = sum(confirmedTransactions.map((entry) => BigInt(entry.gas_used ?? "0")));
const totalFees = sum(
  confirmedTransactions.map((entry) => BigInt(entry.transaction_fee_wei ?? "0")),
);
const totalCalldata = confirmedTransactions.reduce(
  (total, entry) => total + entry.calldata_bytes,
  0,
);
const latencies = confirmedTransactions
  .map((entry) => entry.confirmation_latency_ms)
  .filter((value): value is number => value !== null);

const result = {
  schema: "EVLLM_SEPOLIA_FULL_WORKFLOW_V1",
  created_at: new Date().toISOString(),
  workflow_id: SEPOLIA_WORKFLOW_ID,
  network: isSepolia ? "sepolia" : "controlled-local-rehearsal",
  chain_id: chain.chainId.toString(),
  source_revision: sourceRevision(),
  working_tree_status_sha256: workingTreeStatusHash(),
  role_addresses: Object.fromEntries(roleAddresses),
  contract_addresses: await contractAddresses(),
  case: {
    purchase_amount_wei: SEPOLIA_WORKFLOW_PURCHASE_WEI.toString(),
    battery_id: ids.batteryId,
    claim_id: ids.claimId,
    listing_id: ids.listingId,
    offer_id: ids.offerId,
    agreement_id: ids.agreementId,
    audit_batch_id: ids.auditBatchId,
  },
  transactions,
  measurements: {
    confirmed_transaction_count: confirmedTransactions.length,
    total_gas_used: totalGas.toString(),
    total_transaction_fees_wei: totalFees.toString(),
    total_transaction_fees_eth: formatEther(totalFees),
    total_calldata_bytes: totalCalldata,
    confirmation_latency_ms: {
      median: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      minimum: latencies.length === 0 ? null : Math.min(...latencies),
      maximum: latencies.length === 0 ? null : Math.max(...latencies),
    },
    by_contract: summarizeBy(confirmedTransactions, (entry) => entry.contract),
    by_role: summarizeBy(confirmedTransactions, (entry) => entry.signer_role),
    role_balances_before_wei: startingBalances,
    role_balances_after_wei: endingBalances,
    marketplace_balance_before_wei: marketplaceStartingBalance.toString(),
    marketplace_balance_after_wei: marketplaceEndingBalance.toString(),
  },
  final_state: finalState,
};

const serialized = `${JSON.stringify(result, null, 2)}\n`;
if (/(?:PRIVATE KEY|OPENAI_API_KEY|\bsk-[a-z0-9_-]{16,})/iu.test(serialized)) {
  throw new Error("The workflow artifact contains secret-like material");
}
const finalDirectory = isSepolia
  ? resolve("evaluation", "final", "assurance", "deployment")
  : checkpointDirectory;
await mkdir(finalDirectory, { recursive: true });
await writeFile(
  resolve(finalDirectory, isSepolia ? "sepolia-full-workflow.json" : "rehearsal-result.json"),
  serialized,
);
process.stdout.write(
  `${isSepolia ? "Sepolia" : "Local rehearsal"} workflow completed with ${confirmedTransactions.length} confirmed transactions and ${totalGas.toString()} gas units.\n`,
);

async function connectExistingDeployment(): Promise<Record<SepoliaContractName, BaseContract>> {
  const deployment = JSON.parse(
    await readFile(resolve("contracts/generated/solidity/sepolia-deployment.json"), "utf8"),
  ) as { deployer: string; governance: string; addresses: Record<string, string> };
  if (addressOf("deployer").toLowerCase() !== deployment.deployer.toLowerCase()) {
    throw new Error("The deployer key does not match the public deployment");
  }
  if (addressOf("governance").toLowerCase() !== deployment.governance.toLowerCase()) {
    throw new Error("The governance key does not match the public deployment");
  }
  const entries = await Promise.all(
    sepoliaContractNames.map(async (name) => {
      const address = deployment.addresses[name];
      if (address === undefined || (await provider.getCode(address)) === "0x") {
        throw new Error(`Missing deployed ${name}`);
      }
      return [name, await ethers.getContractAt(name, address)] as const;
    }),
  );
  return Object.fromEntries(entries) as unknown as Record<SepoliaContractName, BaseContract>;
}

async function deployLocalRehearsal(): Promise<Record<SepoliaContractName, BaseContract>> {
  const governanceAddress = addressOf("governance");
  const deployer = signer("deployer");
  const governance = signer("governance");
  const authority = await deploy("AuthorityProfileRegistry", deployer, [governanceAddress]);
  const bundles = await deploy("ProtectedBundleRegistry", deployer, [await authority.getAddress()]);
  const ownership = await deploy("BatteryOwnershipRegistry", deployer, [governanceAddress]);
  const deployment = await deploy("DeploymentRegistry", deployer, [
    governanceAddress,
    await authority.getAddress(),
    await bundles.getAddress(),
    await ownership.getAddress(),
    0,
  ]);
  const evidence = await deploy("EvidenceRegistry", deployer, [
    await authority.getAddress(),
    await bundles.getAddress(),
  ]);
  const marketplace = await deploy("Marketplace", deployer, [
    await authority.getAddress(),
    await bundles.getAddress(),
    await ownership.getAddress(),
    await deployment.getAddress(),
    300,
  ]);
  const audit = await deploy("AuditAnchor", deployer, [await authority.getAddress()]);

  await sendSetup(governance, ownership, "setMarketplace", [await marketplace.getAddress(), true]);
  await sendSetup(deployer, bundles, "closeBootstrap", []);
  for (const [module, contract] of [
    ["evidence", evidence],
    ["marketplace", marketplace],
    ["audit", audit],
  ] as const) {
    await sendSetup(governance, deployment, "proposeModule", [
      ethers.encodeBytes32String(module),
      await contract.getAddress(),
    ]);
    await sendSetup(governance, deployment, "activateModule", [ethers.encodeBytes32String(module)]);
  }
  return {
    AuthorityProfileRegistry: authority,
    ProtectedBundleRegistry: bundles,
    BatteryOwnershipRegistry: ownership,
    DeploymentRegistry: deployment,
    EvidenceRegistry: evidence,
    Marketplace: marketplace,
    AuditAnchor: audit,
  };
}

async function verifyDeploymentConfiguration(
  deployed: Record<SepoliaContractName, BaseContract>,
): Promise<void> {
  if (!(await read<boolean>(deployed.ProtectedBundleRegistry, "bootstrapClosed"))) {
    throw new Error("Protected-record bootstrap must be closed");
  }
  if (
    !(await read<boolean>(
      deployed.BatteryOwnershipRegistry,
      "marketplaces",
      await deployed.Marketplace.getAddress(),
    ))
  ) {
    throw new Error("Marketplace is not authorized for battery locking");
  }
  for (const [module, name] of [
    ["evidence", "EvidenceRegistry"],
    ["marketplace", "Marketplace"],
    ["audit", "AuditAnchor"],
  ] as const) {
    const active = await read<string>(
      deployed.DeploymentRegistry,
      "activeModules",
      ethers.encodeBytes32String(module),
    );
    if (getAddress(active) !== getAddress(await deployed[name].getAddress())) {
      throw new Error(`${module} module is not active`);
    }
  }
}

async function ensureOrganization(organizationId: string, label: string): Promise<void> {
  const current = Number(
    await read<bigint>(contracts.AuthorityProfileRegistry, "organizationStatus", organizationId),
  );
  if (current === 1) return;
  if (current !== 0) throw new Error(`${label} organization has an unexpected existing status`);
  await recordTransaction(
    `Activate ${label} organization`,
    "AuthorityProfileRegistry",
    "setOrganizationStatus",
    "governance",
    [organizationId, 1],
    "OrganizationStatusChanged",
  );
}

async function ensureCredential(identity: Identity): Promise<void> {
  const current = await read<readonly unknown[]>(
    contracts.AuthorityProfileRegistry,
    "credentials",
    identity.credentialId,
  );
  const account = String(current[1]);
  if (account !== ZeroAddress) {
    if (
      String(current[0]) !== identity.organizationId ||
      getAddress(account) !== addressOf(identity.role) ||
      Boolean(current[2]) !== true ||
      Boolean(current[3]) !== identity.replicaAttestation
    ) {
      throw new Error(`${identity.label} credential conflicts with existing state`);
    }
    return;
  }
  await recordTransaction(
    `Register ${identity.label} credential`,
    "AuthorityProfileRegistry",
    "setCredential",
    "governance",
    [
      identity.credentialId,
      identity.organizationId,
      addressOf(identity.role),
      true,
      identity.replicaAttestation,
    ],
    "CredentialSet",
  );
}

async function ensureRegistrar(): Promise<void> {
  if (
    await read<boolean>(contracts.BatteryOwnershipRegistry, "registrars", addressOf("registrar"))
  ) {
    return;
  }
  await recordTransaction(
    "Authorize the battery registrar",
    "BatteryOwnershipRegistry",
    "setRegistrar",
    "governance",
    [addressOf("registrar"), true],
    null,
  );
}

async function ensureReplicaRepository(): Promise<void> {
  if (
    await read<boolean>(
      contracts.AuthorityProfileRegistry,
      "approvedRepositories",
      ids.replicaRepositoryId,
    )
  ) {
    return;
  }
  await recordTransaction(
    "Approve the neutral replica repository",
    "AuthorityProfileRegistry",
    "setRepositoryApproval",
    "governance",
    [ids.replicaRepositoryId, true],
    "RepositoryApprovalChanged",
  );
}

async function ensureCapability(
  identity: Identity,
  capabilityId: string,
  resourceScope: string,
  step: string,
): Promise<void> {
  const current = await read<readonly unknown[]>(
    contracts.AuthorityProfileRegistry,
    "capabilityGrants",
    identity.credentialId,
    capabilityId,
  );
  if (String(current[0]) === resourceScope && Boolean(current[3])) return;
  await recordTransaction(
    step,
    "AuthorityProfileRegistry",
    "setCapabilityGrant",
    "governance",
    [identity.credentialId, capabilityId, resourceScope, 0, 0, true],
    "CapabilityGrantSet",
  );
}

async function ensureInitialOwnership(): Promise<void> {
  const battery = await read<readonly unknown[]>(
    contracts.BatteryOwnershipRegistry,
    "batteries",
    ids.batteryId,
  );
  if (battery[2]) {
    if (String(battery[0]) !== ids.seller.organizationId) {
      throw new Error("The demonstration battery has an unexpected recorded owner");
    }
    return;
  }
  const proposal = await read<readonly unknown[]>(
    contracts.BatteryOwnershipRegistry,
    "initialOwnershipProposals",
    ids.ownershipProposalId,
  );
  const proposalState = Number(proposal[4]);
  if (proposalState === 0) {
    await recordTransaction(
      "Propose initial recorded ownership",
      "BatteryOwnershipRegistry",
      "proposeInitialOwnership",
      "registrar",
      [
        ids.ownershipProposalId,
        ids.batteryId,
        ids.seller.organizationId,
        addressOf("seller"),
        (await latestTimestamp()) + 7_200,
      ],
      "InitialOwnershipProposed",
    );
  } else if (proposalState !== 1) {
    throw new Error("The initial ownership proposal is already terminal");
  }
  await recordTransaction(
    "Accept initial recorded ownership",
    "BatteryOwnershipRegistry",
    "acceptInitialOwnership",
    "seller",
    [ids.ownershipProposalId],
    "InitialOwnershipProposalClosed",
  );
}

async function ensureBundle(specification: BundleSpecification): Promise<string> {
  const bundleKey = id(`bundle:${specification.label}`);
  const contentEnvelopeDigest = id(`stored-envelope:${specification.label}`);
  const replicaPolicyDigest = id("replica-policy:v1");
  const author = identityFor(specification.authorRole);
  const controller = identityFor(specification.controllerRole);
  const current = await read<readonly unknown[]>(
    contracts.ProtectedBundleRegistry,
    "commitments",
    bundleKey,
  );
  if (!current[9]) {
    const issuedAt = Math.max(1, (await latestTimestamp()) - 5);
    const attestation = {
      bundleId: bundleKey,
      bundleVersion: 1,
      bundleType: specification.bundleType,
      domainResourceId: specification.domainKey,
      domainResourceVersion: 1,
      authorBindingProfileId: id("author-binding-profile:v1"),
      authorBindingProfileVersion: 1,
      domainPayloadCommitment: specification.payloadCommitment,
      signerActorId: author.actorId,
      signerOrgId: author.organizationId,
      signerCredentialId: author.credentialId,
      nonce: BigInt(id(`attestation-nonce:${specification.label}`)),
      issuedAt,
      expiresAt: issuedAt + 7_200,
    };
    const signature = await signer(specification.authorRole).signTypedData(
      {
        name: "EVLLM Domain Manifest",
        version: "1",
        chainId: chain.chainId,
        verifyingContract: await contracts.ProtectedBundleRegistry.getAddress(),
      },
      {
        DomainManifestAttestation: [
          { name: "bundleId", type: "bytes32" },
          { name: "bundleVersion", type: "uint64" },
          { name: "bundleType", type: "bytes32" },
          { name: "domainResourceId", type: "bytes32" },
          { name: "domainResourceVersion", type: "uint64" },
          { name: "authorBindingProfileId", type: "bytes32" },
          { name: "authorBindingProfileVersion", type: "uint64" },
          { name: "domainPayloadCommitment", type: "bytes32" },
          { name: "signerActorId", type: "bytes32" },
          { name: "signerOrgId", type: "bytes32" },
          { name: "signerCredentialId", type: "bytes32" },
          { name: "nonce", type: "uint256" },
          { name: "issuedAt", type: "uint64" },
          { name: "expiresAt", type: "uint64" },
        ],
      },
      attestation,
    );
    await recordTransaction(
      `Commit attested ${specification.label} bundle`,
      "ProtectedBundleRegistry",
      "commitAttestedProtectedBundle",
      specification.controllerRole,
      [
        attestation,
        signature,
        controller.organizationId,
        controller.credentialId,
        contentEnvelopeDigest,
        512,
        replicaPolicyDigest,
      ],
      "ProtectedBundleCommitted",
    );
  } else {
    if (
      String(current[0]) !== specification.domainKey ||
      String(current[1]) !== controller.organizationId ||
      getAddress(String(current[2])) !== addressOf(specification.controllerRole) ||
      String(current[3]) !== specification.bundleType ||
      String(current[4]) !== specification.payloadCommitment ||
      String(current[5]) !== contentEnvelopeDigest
    ) {
      throw new Error(`${specification.label} bundle conflicts with existing state`);
    }
  }

  if (specification.decisionCritical) {
    if (
      !(await read<boolean>(contracts.ProtectedBundleRegistry, "verifiedReplicaReceipt", bundleKey))
    ) {
      await recordTransaction(
        `Verify replica receipt for ${specification.label}`,
        "ProtectedBundleRegistry",
        "submitReplicaReceipt",
        "replica_attester",
        [
          bundleKey,
          ids.replicaRepositoryId,
          ids.replica_attester.organizationId,
          ids.replica_attester.credentialId,
          contentEnvelopeDigest,
          512,
          id(`replica-receipt-nonce:${specification.label}`),
        ],
        "ReplicaReceiptVerified",
      );
    }
    const refreshed = await read<readonly unknown[]>(
      contracts.ProtectedBundleRegistry,
      "commitments",
      bundleKey,
    );
    if (Number(refreshed[8]) !== 1) {
      await recordTransaction(
        `Promote ${specification.label} bundle to decision critical`,
        "ProtectedBundleRegistry",
        "promoteToDecisionCritical",
        specification.controllerRole,
        [bundleKey],
        "ProtectedBundlePromoted",
      );
    }
  }
  return bundleKey;
}

async function ensureEvidenceActivation(bundleKey: string): Promise<void> {
  const version = Number(
    await read<bigint>(contracts.EvidenceRegistry, "currentVersion", ids.claimId),
  );
  if (version === 1) return;
  if (version !== 0) throw new Error("The evidence claim has an unexpected version");
  await recordTransaction(
    "Activate the diagnostic evidence claim",
    "EvidenceRegistry",
    "activateEvidence",
    "issuer",
    [
      ids.claimId,
      1,
      0,
      bundleKey,
      ids.claimId,
      ids.evidencePayloadCommitment,
      ids.issuer.organizationId,
      ids.issuer.credentialId,
    ],
    "EvidenceActivated",
  );
}

async function ensureVerificationAssertion(bundleKey: string): Promise<void> {
  const current = await read<readonly unknown[]>(
    contracts.EvidenceRegistry,
    "assertions",
    ids.assertionId,
  );
  if (Number(current[7]) === 1) return;
  if (Number(current[7]) !== 0) throw new Error("The verification assertion is already terminal");
  await recordTransaction(
    "Create the independent certification assertion",
    "EvidenceRegistry",
    "createVerificationAssertion",
    "verifier",
    [
      ids.assertionId,
      ids.claimId,
      1,
      bundleKey,
      ids.assertionId,
      ids.verificationPayloadCommitment,
      ids.verifier.organizationId,
      ids.verifier.credentialId,
      1,
    ],
    "VerificationAssertionCreated",
  );
}

async function ensureListing(bundleKey: string): Promise<void> {
  const state = Number(await read<bigint>(contracts.Marketplace, "listingState", ids.listingId));
  if (state !== 0) return;
  await recordTransaction(
    "Create the protected marketplace listing",
    "Marketplace",
    "createListing",
    "seller",
    [
      {
        listingId: ids.listingId,
        batteryId: ids.batteryId,
        sellerOrganizationId: ids.seller.organizationId,
        sellerCredentialId: ids.seller.credentialId,
        bundleKey,
        payloadCommitment: ids.listingPayloadCommitment,
        testPrice: SEPOLIA_WORKFLOW_PURCHASE_WEI,
        sellerPayoutAddress: addressOf("seller"),
        expiresAt: (await latestTimestamp()) + 14_400,
      },
    ],
    "ListingCreated",
  );
}

async function ensureOffer(): Promise<void> {
  const state = Number(await read<bigint>(contracts.Marketplace, "offerState", ids.offerId));
  if (state !== 0) return;
  const listingExpiry = Number(
    await read<bigint>(contracts.Marketplace, "listingExpiry", ids.listingId),
  );
  await recordTransaction(
    "Submit the buyer offer",
    "Marketplace",
    "submitOffer",
    "buyer",
    [
      {
        offerId: ids.offerId,
        listingId: ids.listingId,
        buyerOrganizationId: ids.buyer.organizationId,
        buyerCredentialId: ids.buyer.credentialId,
        amount: SEPOLIA_WORKFLOW_PURCHASE_WEI,
        buyerRefundAddress: addressOf("buyer"),
        termsCommitment: ids.offerTermsCommitment,
        expiresAt: Math.min(listingExpiry - 60, (await latestTimestamp()) + 10_800),
      },
    ],
    "OfferSubmitted",
  );
}

async function ensureAgreement(bundleKey: string): Promise<void> {
  const state = Number(
    await read<bigint>(contracts.Marketplace, "agreementState", ids.agreementId),
  );
  if (state !== 0) return;
  const now = await latestTimestamp();
  await recordTransaction(
    "Select the offer and create the protected agreement",
    "Marketplace",
    "selectOfferAndCreateAgreement",
    "seller",
    [
      {
        agreementId: ids.agreementId,
        listingId: ids.listingId,
        offerId: ids.offerId,
        bundleKey,
        payloadCommitment: ids.agreementPayloadCommitment,
        buyerAccessAuthorizationDigest: ids.buyerAccessAuthorizationDigest,
        confirmationDeadline: now + 7_200,
        deliveryDeadline: now + 10_800,
      },
    ],
    "AgreementCreated",
  );
}

async function ensureAgreementFunding(): Promise<void> {
  let state = Number(await read<bigint>(contracts.Marketplace, "agreementState", ids.agreementId));
  if (state === 1) {
    await recordTransaction(
      "Confirm buyer access to the agreement",
      "Marketplace",
      "confirmAgreement",
      "buyer",
      [ids.agreementId, ids.buyerAccessAuthorizationDigest],
      "AgreementStateChanged",
    );
    state = 2;
  }
  if (state === 2) {
    await recordTransaction(
      "Fund the agreement",
      "Marketplace",
      "fundAgreement",
      "buyer",
      [ids.agreementId],
      "AgreementStateChanged",
      SEPOLIA_WORKFLOW_PURCHASE_WEI,
    );
    state = 3;
  }
  if (state < 3 || state > 9) throw new Error("Agreement did not reach the funded state");
}

async function ensureLogisticsAndSettlement(
  dispatchBundle: string,
  deliveryBundle: string,
): Promise<void> {
  let state = Number(await read<bigint>(contracts.Marketplace, "agreementState", ids.agreementId));
  if (state === 3) {
    await recordTransaction(
      "Record dispatch",
      "Marketplace",
      "recordDispatch",
      "logistics_provider",
      [
        ids.agreementId,
        {
          actionId: ids.dispatchId,
          bundleKey: dispatchBundle,
          payloadCommitment: ids.dispatchPayloadCommitment,
          organizationId: ids.logistics_provider.organizationId,
          credentialId: ids.logistics_provider.credentialId,
        },
      ],
      "LogisticsRecorded",
    );
    state = 4;
  }
  if (state === 4) {
    await recordTransaction(
      "Record delivery",
      "Marketplace",
      "recordDelivery",
      "logistics_provider",
      [
        ids.agreementId,
        {
          actionId: ids.deliveryId,
          bundleKey: deliveryBundle,
          payloadCommitment: ids.deliveryPayloadCommitment,
          organizationId: ids.logistics_provider.organizationId,
          credentialId: ids.logistics_provider.credentialId,
        },
      ],
      "LogisticsRecorded",
    );
    state = 5;
  }
  if (state === 5) {
    await recordTransaction(
      "Accept delivery",
      "Marketplace",
      "acceptDelivery",
      "buyer",
      [ids.agreementId],
      "AgreementStateChanged",
    );
    state = 6;
  }
  if (state === 6) {
    await recordTransaction(
      "Settle the accepted agreement",
      "Marketplace",
      "settleAccepted",
      "governance",
      [ids.agreementId],
      "CreditCreated",
    );
    state = 9;
  }
  if (state !== 9) throw new Error("The marketplace agreement did not settle");
  const sellerCredit = await read<bigint>(
    contracts.Marketplace,
    "withdrawableCredits",
    addressOf("seller"),
  );
  if (sellerCredit > 0n) {
    if (sellerCredit !== SEPOLIA_WORKFLOW_PURCHASE_WEI) {
      throw new Error("The seller credit does not equal the funded amount");
    }
    await recordTransaction(
      "Withdraw the seller credit",
      "Marketplace",
      "withdrawCredits",
      "seller",
      [],
      "CreditWithdrawn",
    );
  }
}

async function ensureAuditAnchor(): Promise<void> {
  const current = await read<readonly unknown[]>(
    contracts.AuditAnchor,
    "anchors",
    ids.auditBatchId,
  );
  if (Number(current[0]) !== 0) return;
  const hashes = transactions
    .filter((entry) => entry.status === "confirmed")
    .map((entry) => entry.transaction_hash);
  if (hashes.length === 0)
    throw new Error("No confirmed workflow transactions are available to anchor");
  const finalEventHash = keccak256(concat(hashes));
  const previousCommitment = await read<string>(contracts.AuditAnchor, "lastCommitment");
  const commitment = ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32", "bytes32"],
    [ids.auditBatchId, finalEventHash, previousCommitment],
  );
  const eventCount = hashes.length;
  await recordTransaction(
    "Anchor the workflow audit batch",
    "AuditAnchor",
    "anchorBatch",
    "audit_anchor",
    [
      ids.auditBatchId,
      1,
      1,
      eventCount,
      eventCount,
      finalEventHash,
      commitment,
      previousCommitment,
      ids.audit_anchor.organizationId,
      ids.audit_anchor.credentialId,
    ],
    "AuditBatchAnchored",
  );
}

async function verifyFinalState(): Promise<Record<string, unknown>> {
  const battery = await read<readonly unknown[]>(
    contracts.BatteryOwnershipRegistry,
    "batteries",
    ids.batteryId,
  );
  const agreementState = Number(
    await read<bigint>(contracts.Marketplace, "agreementState", ids.agreementId),
  );
  const listingState = Number(
    await read<bigint>(contracts.Marketplace, "listingState", ids.listingId),
  );
  const offerState = Number(await read<bigint>(contracts.Marketplace, "offerState", ids.offerId));
  const evidence = await read<readonly unknown[]>(
    contracts.EvidenceRegistry,
    "evidenceVersions",
    ids.claimId,
    1,
  );
  const assertion = await read<readonly unknown[]>(
    contracts.EvidenceRegistry,
    "assertions",
    ids.assertionId,
  );
  const anchor = await read<readonly unknown[]>(contracts.AuditAnchor, "anchors", ids.auditBatchId);
  const sellerCredit = await read<bigint>(
    contracts.Marketplace,
    "withdrawableCredits",
    addressOf("seller"),
  );
  const originListing = await read<string>(
    contracts.DeploymentRegistry,
    "originModule",
    ids.listingId,
  );
  const originAgreement = await read<string>(
    contracts.DeploymentRegistry,
    "originModule",
    ids.agreementId,
  );
  const expectedMarketplace = getAddress(await contracts.Marketplace.getAddress());
  const checks = {
    agreement_settled: agreementState === 9,
    listing_closed_settled: listingState === 5,
    offer_accepted: offerState === 2,
    buyer_is_recorded_owner: String(battery[0]) === ids.buyer.organizationId,
    battery_lock_released: getAddress(String(battery[1])) === ZeroAddress,
    evidence_active: Number(evidence[6]) === 1,
    independent_assertion_active: Number(assertion[7]) === 1,
    seller_credit_withdrawn: sellerCredit === 0n,
    audit_batch_anchored: Number(anchor[0]) === 1,
    listing_origin_bound: getAddress(originListing) === expectedMarketplace,
    agreement_origin_bound: getAddress(originAgreement) === expectedMarketplace,
  };
  if (!Object.values(checks).every(Boolean)) {
    throw new Error(`Final workflow checks failed: ${JSON.stringify(checks)}`);
  }
  return {
    ...checks,
    agreement_state: agreementState,
    listing_state: listingState,
    offer_state: offerState,
    recorded_owner_organization_id: String(battery[0]),
    marketplace_lock: String(battery[1]),
    seller_credit_wei: sellerCredit.toString(),
  };
}

async function recordTransaction(
  step: string,
  contractName: SepoliaContractName,
  method: string,
  role: SepoliaWorkflowRole,
  arguments_: readonly unknown[],
  expectedEvent: string | null,
  value = 0n,
): Promise<void> {
  const contract = contracts[contractName];
  const data = contract.interface.encodeFunctionData(method, arguments_);
  const started = performance.now();
  const submittedAt = new Date().toISOString();
  const response = await signer(role).sendTransaction({
    to: await contract.getAddress(),
    data,
    value,
  });
  const record: RecordedTransaction = {
    sequence: transactions.length + 1,
    step,
    contract: contractName,
    function: method,
    signer_role: role,
    signer_address: addressOf(role),
    transaction_hash: response.hash,
    submitted_at: submittedAt,
    calldata_bytes: (data.length - 2) / 2,
    value_wei: value.toString(),
    block_number: null,
    confirmed_at: null,
    confirmation_latency_ms: null,
    gas_used: null,
    effective_gas_price_wei: null,
    transaction_fee_wei: null,
    events: [],
    status: "pending",
  };
  transactions.push(record);
  await writeCheckpoint();
  const receipt = await response.wait();
  if (receipt === null) throw new Error(`${step} returned no receipt`);
  completeRecord(record, receipt, Math.round(performance.now() - started));
  if (expectedEvent !== null && !record.events.includes(`${contractName}.${expectedEvent}`)) {
    record.status = "failed";
    await writeCheckpoint();
    throw new Error(`${step} did not emit ${expectedEvent}`);
  }
  await writeCheckpoint();
  process.stdout.write(
    `${record.sequence.toString().padStart(2, "0")} ${step} gas=${record.gas_used} tx=${record.transaction_hash}\n`,
  );
}

function completeRecord(
  record: RecordedTransaction,
  receipt: TransactionReceipt,
  latencyMs: number,
): void {
  record.block_number = receipt.blockNumber;
  record.confirmed_at = new Date().toISOString();
  record.confirmation_latency_ms = latencyMs;
  record.gas_used = receipt.gasUsed.toString();
  record.effective_gas_price_wei = receipt.gasPrice.toString();
  record.transaction_fee_wei = receipt.fee.toString();
  record.events = parseEvents(receipt);
  record.status = receipt.status === 1 ? "confirmed" : "failed";
  if (receipt.status !== 1) throw new Error(`${record.step} reverted on chain`);
}

function parseEvents(receipt: TransactionReceipt): string[] {
  const names: string[] = [];
  for (const log of receipt.logs) {
    for (const name of sepoliaContractNames) {
      const contract = contracts[name];
      if (log.address.toLowerCase() !== (contract.target as string).toLowerCase()) continue;
      try {
        const parsed = contract.interface.parseLog(log);
        if (parsed !== null) names.push(`${name}.${parsed.name}`);
      } catch {
        // A log from the correct address but outside this ABI is ignored.
      }
    }
  }
  return names;
}

async function finalizePendingTransactions(): Promise<void> {
  for (const record of transactions.filter((entry) => entry.status === "pending")) {
    const started = performance.now();
    const receipt =
      (await provider.getTransactionReceipt(record.transaction_hash)) ??
      (await provider.waitForTransaction(record.transaction_hash));
    if (receipt === null)
      throw new Error(`Pending transaction ${record.transaction_hash} was not found`);
    completeRecord(record, receipt, Math.round(performance.now() - started));
  }
  await writeCheckpoint();
}

async function loadCheckpoint(path: string): Promise<RecordedTransaction[]> {
  try {
    const content = JSON.parse(await readFile(path, "utf8")) as {
      workflow_id: string;
      chain_id: string;
      transactions: RecordedTransaction[];
    };
    if (
      content.workflow_id !== SEPOLIA_WORKFLOW_ID ||
      content.chain_id !== chain.chainId.toString()
    ) {
      throw new Error("The workflow checkpoint belongs to a different workflow or chain");
    }
    return content.transactions;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeCheckpoint(): Promise<void> {
  await writeFile(
    checkpointPath,
    `${JSON.stringify(
      {
        schema: "EVLLM_SEPOLIA_FULL_WORKFLOW_CHECKPOINT_V1",
        updated_at: new Date().toISOString(),
        workflow_id: SEPOLIA_WORKFLOW_ID,
        chain_id: chain.chainId.toString(),
        transactions,
      },
      null,
      2,
    )}\n`,
  );
}

async function readRoleBalances(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    sepoliaWorkflowRoles.map(
      async ({ role }) => [role, (await provider.getBalance(addressOf(role))).toString()] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function contractAddresses(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    sepoliaContractNames.map(async (name) => [name, await contracts[name].getAddress()] as const),
  );
  return Object.fromEntries(entries);
}

async function deploy(name: string, deployer: Signer, arguments_: readonly unknown[]) {
  const factory = await ethers.getContractFactory(name, deployer);
  const contract = await factory.deploy(...arguments_);
  await contract.waitForDeployment();
  return contract;
}

async function sendSetup(
  sender: Signer,
  contract: BaseContract,
  method: string,
  arguments_: readonly unknown[],
): Promise<void> {
  const response = await sender.sendTransaction({
    to: await contract.getAddress(),
    data: contract.interface.encodeFunctionData(method, arguments_),
  });
  const receipt = await response.wait();
  if (receipt === null || receipt.status !== 1) throw new Error(`Local setup ${method} failed`);
}

async function read<T>(
  contract: BaseContract,
  method: string,
  ...arguments_: unknown[]
): Promise<T> {
  return (await contract.getFunction(method).staticCall(...arguments_)) as T;
}

async function latestTimestamp(): Promise<number> {
  const block = await provider.getBlock("latest");
  if (block === null) throw new Error("Latest block is unavailable");
  return block.timestamp;
}

function signer(role: SepoliaWorkflowRole): Signer {
  const result = signers.get(role);
  if (result === undefined) throw new Error(`Missing ${role} signer`);
  return result;
}

function addressOf(role: SepoliaWorkflowRole): string {
  const result = roleAddresses.get(role);
  if (result === undefined) throw new Error(`Missing ${role} address`);
  return result;
}

function identityFor(role: SepoliaWorkflowRole): Identity {
  const result = ids.identities[role as keyof typeof ids.identities];
  if (result === undefined) throw new Error(`${role} has no workflow credential`);
  return result;
}

function createWorkflowIds() {
  const identity = (
    role: Exclude<SepoliaWorkflowRole, "deployer" | "governance" | "registrar">,
    label: string,
    replicaAttestation = false,
  ): Identity => ({
    role,
    label,
    organizationId: id(`organization:${role}`),
    credentialId: id(`credential:${role}`),
    actorId: id(`actor:${role}`),
    replicaAttestation,
  });
  const identities = {
    issuer: identity("issuer", "evidence issuer"),
    controller: identity("controller", "protected-record controller"),
    verifier: identity("verifier", "independent verifier"),
    seller: identity("seller", "seller"),
    buyer: identity("buyer", "buyer"),
    replica_attester: identity("replica_attester", "replica attester", true),
    logistics_provider: identity("logistics_provider", "logistics provider"),
    audit_anchor: identity("audit_anchor", "audit-anchor service"),
  };
  return {
    identities,
    ...identities,
    batteryId: id("battery"),
    ownershipProposalId: id("initial-ownership-proposal"),
    claimId: id("evidence-claim"),
    assertionId: id("verification-assertion"),
    listingId: id("listing"),
    offerId: id("offer"),
    agreementId: id("agreement"),
    dispatchId: id("dispatch"),
    deliveryId: id("delivery"),
    auditBatchId: id("audit-batch"),
    replicaRepositoryId: id("replica-repository"),
    evidencePayloadCommitment: id("payload:evidence"),
    verificationPayloadCommitment: id("payload:verification"),
    listingPayloadCommitment: id("payload:listing"),
    offerTermsCommitment: id("payload:offer-terms"),
    agreementPayloadCommitment: id("payload:agreement"),
    dispatchPayloadCommitment: id("payload:dispatch"),
    deliveryPayloadCommitment: id("payload:delivery"),
    buyerAccessAuthorizationDigest: id("buyer-access-authorization"),
  };
}

interface Identity {
  readonly role: Exclude<SepoliaWorkflowRole, "deployer" | "governance" | "registrar">;
  readonly label: string;
  readonly organizationId: string;
  readonly credentialId: string;
  readonly actorId: string;
  readonly replicaAttestation: boolean;
}

function id(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${SEPOLIA_WORKFLOW_ID}:${label}`));
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function percentile(values: number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1);
  return sorted[index] ?? null;
}

function summarizeBy(
  entries: RecordedTransaction[],
  key: (entry: RecordedTransaction) => string,
): Record<string, { transaction_count: number; gas_used: string; transaction_fees_wei: string }> {
  const groups = new Map<string, RecordedTransaction[]>();
  for (const entry of entries) {
    const name = key(entry);
    groups.set(name, [...(groups.get(name) ?? []), entry]);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([name, group]) => [
      name,
      {
        transaction_count: group.length,
        gas_used: sum(group.map((entry) => BigInt(entry.gas_used ?? "0"))).toString(),
        transaction_fees_wei: sum(
          group.map((entry) => BigInt(entry.transaction_fee_wei ?? "0")),
        ).toString(),
      },
    ]),
  );
}

function sourceRevision(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function workingTreeStatusHash(): string {
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  });
  return createHash("sha256").update(status).digest("hex");
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "" || value.includes("replace_with")) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}
