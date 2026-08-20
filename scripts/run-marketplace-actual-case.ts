import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { BaseContract, Signer, TransactionResponse } from "ethers";
import { network } from "hardhat";

interface RecordedTransaction {
  readonly step: string;
  readonly contract: string;
  readonly event: string;
  readonly transaction_hash: string;
  readonly block_number: number;
}

const { ethers, networkName } = await network.create();
if (networkName !== "hardhatMainnet") {
  throw new Error("The retained marketplace demonstration must run on the controlled local chain");
}
const localSigners = await ethers.getSigners();
const governance = requiredSigner(localSigners[0], "governance");
const seller = requiredSigner(localSigners[1], "seller");
const buyer = requiredSigner(localSigners[2], "buyer");
const replica = requiredSigner(localSigners[3], "replica");
const governanceAddress = await governance.getAddress();
const sellerAddress = await seller.getAddress();
const buyerAddress = await buyer.getAddress();
const replicaAddress = await replica.getAddress();

const transactions: RecordedTransaction[] = [];
const sellerOrganizationId = id("organization:seller");
const buyerOrganizationId = id("organization:buyer");
const replicaOrganizationId = id("organization:replica");
const sellerCredentialId = id("credential:seller");
const buyerCredentialId = id("credential:buyer");
const replicaCredentialId = id("credential:replica");
const batteryId = id("battery:final-demonstration");
const listingId = id("listing:final-demonstration");
const offerId = id("offer:final-demonstration");
const agreementId = id("agreement:final-demonstration");
const accessAuthorizationDigest = id("buyer-access:final-demonstration");
const testAmountWei = 1_000_000_000_000_000n;

const authority = await deploy("AuthorityProfileRegistry", governance, [governanceAddress]);
const bundles = await deploy("ProtectedBundleRegistry", seller, [await authority.getAddress()]);
const ownership = await deploy("BatteryOwnershipRegistry", governance, [governanceAddress]);
const deployments = await deploy("DeploymentRegistry", governance, [
  governanceAddress,
  await authority.getAddress(),
  await bundles.getAddress(),
  await ownership.getAddress(),
  0,
]);
const marketplace = await deploy("Marketplace", governance, [
  await authority.getAddress(),
  await bundles.getAddress(),
  await ownership.getAddress(),
  await deployments.getAddress(),
  300,
]);

for (const organizationId of [sellerOrganizationId, buyerOrganizationId, replicaOrganizationId]) {
  await transact(governance, authority, "setOrganizationStatus", [organizationId, 1]);
}
await transact(governance, authority, "setCredential", [
  sellerCredentialId,
  sellerOrganizationId,
  sellerAddress,
  true,
  false,
]);
await transact(governance, authority, "setCredential", [
  buyerCredentialId,
  buyerOrganizationId,
  buyerAddress,
  true,
  false,
]);
await transact(governance, authority, "setCredential", [
  replicaCredentialId,
  replicaOrganizationId,
  replicaAddress,
  true,
  true,
]);
await transact(governance, ownership, "setRegistrar", [governanceAddress, true]);
await transact(governance, ownership, "setMarketplace", [await marketplace.getAddress(), true]);
await transact(governance, deployments, "proposeModule", [
  ethers.encodeBytes32String("marketplace"),
  await marketplace.getAddress(),
]);
await transact(governance, deployments, "activateModule", [
  ethers.encodeBytes32String("marketplace"),
]);

const initialTimestamp = await latestTimestamp();
const proposalId = id("initial-owner-proposal:final-demonstration");
await record(
  "Initial recorded ownership proposed",
  "BatteryOwnershipRegistry",
  "InitialOwnershipProposed",
  governance,
  ownership,
  "proposeInitialOwnership",
  [proposalId, batteryId, sellerOrganizationId, sellerAddress, initialTimestamp + 3_600],
);
await record(
  "Recorded owner accepted",
  "BatteryOwnershipRegistry",
  "InitialOwnershipProposalClosed",
  seller,
  ownership,
  "acceptInitialOwnership",
  [proposalId],
);

const listingCapability = await readBytes32(marketplace, "LISTING_CAPABILITY");
const offerCapability = await readBytes32(marketplace, "OFFER_CAPABILITY");
const logisticsCapability = await readBytes32(marketplace, "LOGISTICS_CAPABILITY");
await grant(sellerCredentialId, listingCapability, batteryId);

const listingPayload = id("listing-payload:final-demonstration");
const listingBundle = await criticalBundle(
  listingId,
  await readBytes32(marketplace, "LISTING_BUNDLE_TYPE"),
  listingPayload,
  "listing",
);
const listingExpiry = (await latestTimestamp()) + 3_600;
await record(
  "Protected listing created and battery locked",
  "Marketplace",
  "ListingCreated",
  seller,
  marketplace,
  "createListing",
  [
    {
      listingId,
      batteryId,
      sellerOrganizationId,
      sellerCredentialId,
      bundleKey: listingBundle,
      payloadCommitment: listingPayload,
      testPrice: testAmountWei,
      sellerPayoutAddress: sellerAddress,
      expiresAt: listingExpiry,
    },
  ],
);

await grant(buyerCredentialId, offerCapability, listingId);
await record(
  "Buyer offer submitted",
  "Marketplace",
  "OfferSubmitted",
  buyer,
  marketplace,
  "submitOffer",
  [
    {
      offerId,
      listingId,
      buyerOrganizationId,
      buyerCredentialId,
      amount: testAmountWei,
      buyerRefundAddress: buyerAddress,
      termsCommitment: id("offer-terms:final-demonstration"),
      expiresAt: (await latestTimestamp()) + 1_800,
    },
  ],
);

const agreementPayload = id("agreement-payload:final-demonstration");
const agreementBundle = await criticalBundle(
  agreementId,
  await readBytes32(marketplace, "AGREEMENT_BUNDLE_TYPE"),
  agreementPayload,
  "agreement",
);
const agreementTimestamp = await latestTimestamp();
await record(
  "Seller selected the offer and created the protected agreement",
  "Marketplace",
  "AgreementCreated",
  seller,
  marketplace,
  "selectOfferAndCreateAgreement",
  [
    {
      agreementId,
      listingId,
      offerId,
      bundleKey: agreementBundle,
      payloadCommitment: agreementPayload,
      buyerAccessAuthorizationDigest: accessAuthorizationDigest,
      confirmationDeadline: agreementTimestamp + 1_200,
      deliveryDeadline: agreementTimestamp + 2_400,
    },
  ],
);
await record(
  "Buyer confirmed the protected agreement",
  "Marketplace",
  "AgreementStateChanged",
  buyer,
  marketplace,
  "confirmAgreement",
  [agreementId, accessAuthorizationDigest],
);
await record(
  "Exact test funds deposited",
  "Marketplace",
  "AgreementStateChanged",
  buyer,
  marketplace,
  "fundAgreement",
  [agreementId],
  testAmountWei,
);

await grant(sellerCredentialId, logisticsCapability, agreementId);
for (const [action, delivered] of [
  ["dispatch", false],
  ["delivery", true],
] as const) {
  const actionId = id(`${action}:final-demonstration`);
  const payload = id(`${action}-payload:final-demonstration`);
  const bundle = await criticalBundle(
    actionId,
    await readBytes32(marketplace, "LOGISTICS_BUNDLE_TYPE"),
    payload,
    action,
  );
  await record(
    delivered ? "Delivery record accepted" : "Dispatch record accepted",
    "Marketplace",
    "LogisticsRecorded",
    seller,
    marketplace,
    delivered ? "recordDelivery" : "recordDispatch",
    [
      agreementId,
      {
        actionId,
        bundleKey: bundle,
        payloadCommitment: payload,
        organizationId: sellerOrganizationId,
        credentialId: sellerCredentialId,
      },
    ],
  );
}
await record(
  "Buyer accepted delivery",
  "Marketplace",
  "AgreementStateChanged",
  buyer,
  marketplace,
  "acceptDelivery",
  [agreementId],
);
await record(
  "Settlement transferred recorded ownership and created seller credit",
  "Marketplace",
  "CreditCreated",
  governance,
  marketplace,
  "settleAccepted",
  [agreementId],
);
await record(
  "Seller withdrew the credited test funds",
  "Marketplace",
  "CreditWithdrawn",
  seller,
  marketplace,
  "withdrawCredits",
  [],
);

const agreementState = Number(await readValue(marketplace, "agreementState", [agreementId]));
const listingState = Number(await readValue(marketplace, "listingState", [listingId]));
const battery = (await readValue(ownership, "batteries", [batteryId])) as readonly unknown[];
const withdrawableCredit = BigInt(
  String(await readValue(marketplace, "withdrawableCredits", [sellerAddress])),
);
if (
  agreementState !== 9 ||
  listingState !== 5 ||
  battery[0] !== buyerOrganizationId ||
  battery[1] !== ethers.ZeroAddress ||
  withdrawableCredit !== 0n
) {
  throw new Error("The controlled marketplace lifecycle did not reach the expected final state");
}

const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const workingTreeStatus = execFileSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=all"],
  { encoding: "utf8" },
);
const chain = await ethers.provider.getNetwork();
const artifact = {
  schema: "EVLLM_MARKETPLACE_ACTUAL_CASE_V1",
  created_at: new Date().toISOString(),
  run_id: `marketplace-local-${transactions.at(-1)?.transaction_hash.slice(2, 14) ?? "unknown"}`,
  source_revision: sourceRevision,
  working_tree_status_sha256: sha256(workingTreeStatus),
  network: "controlled-local-chain",
  chain_id: chain.chainId.toString(),
  contracts: {
    AuthorityProfileRegistry: await authority.getAddress(),
    ProtectedBundleRegistry: await bundles.getAddress(),
    BatteryOwnershipRegistry: await ownership.getAddress(),
    DeploymentRegistry: await deployments.getAddress(),
    Marketplace: await marketplace.getAddress(),
  },
  case: {
    battery_id: "Battery ID 201",
    listing_id: "Listing 201",
    offer_id: "Offer 201-A",
    agreement_id: "Agreement 201-A",
    test_amount_wei: testAmountWei.toString(),
  },
  transactions,
  final_state: {
    agreement: "Settled",
    listing: "Closed settled",
    recorded_owner: "Buyer organization",
    marketplace_lock: "Released",
    seller_credit_after_withdrawal_wei: withdrawableCredit.toString(),
  },
};
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
if (/(?:PRIVATE KEY|OPENAI_API_KEY|\bsk-[a-z0-9_-]{16,})/iu.test(serialized)) {
  throw new Error("Marketplace evidence contains a secret-like value");
}
const outputDirectory = resolve("evaluation", "final", "demonstrations");
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "marketplace-workflow.json"), serialized, "utf8");
process.stdout.write(
  `Marketplace actual case passed: ${String(transactions.length)} retained transactions, final agreement state Settled.\n`,
);

async function deploy(name: string, signer: Signer, arguments_: readonly unknown[]) {
  const factory = await ethers.getContractFactory(name, signer);
  const contract = await factory.deploy(...arguments_);
  await contract.waitForDeployment();
  return contract;
}

async function transact(
  signer: Signer,
  contract: BaseContract,
  method: string,
  arguments_: readonly unknown[],
  value?: bigint,
): Promise<TransactionResponse> {
  return signer.sendTransaction({
    data: contract.interface.encodeFunctionData(method, arguments_),
    to: await contract.getAddress(),
    ...(value === undefined ? {} : { value }),
  });
}

async function record(
  step: string,
  contractName: string,
  event: string,
  signer: Signer,
  contract: BaseContract,
  method: string,
  arguments_: readonly unknown[],
  value?: bigint,
): Promise<void> {
  const transaction = await transact(signer, contract, method, arguments_, value);
  const receipt = await transaction.wait();
  if (receipt === null || receipt.status !== 1) throw new Error(`${step} was not confirmed`);
  transactions.push({
    step,
    contract: contractName,
    event,
    transaction_hash: transaction.hash,
    block_number: receipt.blockNumber,
  });
}

async function grant(credentialId: string, capabilityId: string, resourceScope: string) {
  await transact(governance, authority, "setCapabilityGrant", [
    credentialId,
    capabilityId,
    resourceScope,
    0,
    0,
    true,
  ]).then((transaction) => transaction.wait());
}

async function criticalBundle(
  domainId: string,
  bundleType: string,
  payloadCommitment: string,
  label: string,
): Promise<string> {
  const bundleKey = id(`bundle:${label}:final-demonstration`);
  const envelopeDigest = id(`envelope:${label}:final-demonstration`);
  await transact(seller, bundles, "commitProtectedBundle", [
    bundleKey,
    domainId,
    sellerOrganizationId,
    bundleType,
    payloadCommitment,
    envelopeDigest,
    512,
    id("replica-policy:final-demonstration"),
    0,
  ]).then((transaction) => transaction.wait());
  await transact(replica, bundles, "submitReplicaReceipt", [
    bundleKey,
    id("repository:replica:final-demonstration"),
    replicaOrganizationId,
    replicaCredentialId,
    envelopeDigest,
    512,
    id(`receipt:${label}:final-demonstration`),
  ]).then((transaction) => transaction.wait());
  await transact(seller, bundles, "promoteToDecisionCritical", [bundleKey]).then((transaction) =>
    transaction.wait(),
  );
  return bundleKey;
}

async function readBytes32(contract: BaseContract, method: string): Promise<string> {
  return String(await readValue(contract, method, []));
}

async function readValue(
  contract: BaseContract,
  method: string,
  arguments_: readonly unknown[],
): Promise<unknown> {
  return contract.getFunction(method).staticCall(...arguments_);
}

async function latestTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock("latest");
  if (block === null) throw new Error("The local chain did not return its latest block");
  return block.timestamp;
}

function id(value: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredSigner(candidate: Signer | undefined, label: string): Signer {
  if (candidate === undefined) throw new Error(`A distinct ${label} signer is required`);
  return candidate;
}
