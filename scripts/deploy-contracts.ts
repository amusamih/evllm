import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Wallet, type BaseContract, type Signer } from "ethers";
import { network } from "hardhat";

import { deploymentReceipt } from "../src/schemas/deployment.js";

const { ethers, networkName } = await network.create();
const [localDeployer, localGovernance] = await ethers.getSigners();
let deployer = localDeployer;
let governance = localGovernance;
if (networkName === "sepolia") {
  loadEnvironment({ path: ".env/sepolia-demo.env", quiet: true });
  deployer = new Wallet(requiredKey("SEPOLIA_DEPLOYER_PRIVATE_KEY"), ethers.provider);
  governance = new Wallet(requiredKey("SEPOLIA_GOVERNANCE_PRIVATE_KEY"), ethers.provider);
}
if (!deployer) throw new Error("A deployer signer is required");
if (!governance) throw new Error("A governance signer is required");
if (deployer.address.toLowerCase() === governance.address.toLowerCase()) {
  throw new Error("Deployer and governance must use distinct accounts");
}

const reviewDelaySeconds = networkName === "sepolia" ? 60 : 86_400;
const authority = await ethers.deployContract("AuthorityProfileRegistry", [governance.address]);
await authority.waitForDeployment();
const bundle = await ethers.deployContract("ProtectedBundleRegistry", [
  await authority.getAddress(),
]);
await bundle.waitForDeployment();
const ownership = await ethers.deployContract("BatteryOwnershipRegistry", [governance.address]);
await ownership.waitForDeployment();
const deployment = await ethers.deployContract("DeploymentRegistry", [
  governance.address,
  await authority.getAddress(),
  await bundle.getAddress(),
  await ownership.getAddress(),
  reviewDelaySeconds,
]);
await deployment.waitForDeployment();
const evidence = await ethers.deployContract("EvidenceRegistry", [
  await authority.getAddress(),
  await bundle.getAddress(),
]);
await evidence.waitForDeployment();
const marketplace = await ethers.deployContract("Marketplace", [
  await authority.getAddress(),
  await bundle.getAddress(),
  await ownership.getAddress(),
  await deployment.getAddress(),
  86_400,
]);
await marketplace.waitForDeployment();
const auditAnchor = await ethers.deployContract("AuditAnchor", [await authority.getAddress()]);
await auditAnchor.waitForDeployment();

await transact(governance, ownership, "setMarketplace", [await marketplace.getAddress(), true]);
await transact(deployer, bundle, "closeBootstrap", []);
await transact(governance, deployment, "proposeModule", [
  ethers.encodeBytes32String("evidence"),
  await evidence.getAddress(),
]);
await transact(governance, deployment, "proposeModule", [
  ethers.encodeBytes32String("marketplace"),
  await marketplace.getAddress(),
]);
await transact(governance, deployment, "proposeModule", [
  ethers.encodeBytes32String("audit"),
  await auditAnchor.getAddress(),
]);

const manifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
const chain = await ethers.provider.getNetwork();
const receipt = deploymentReceipt.parse({
  schema: "EVLLM_DEPLOYMENT_RECEIPT_V1",
  network: networkName.toLowerCase().replaceAll(/[^a-z0-9_-]/gu, "-"),
  chain_id: chain.chainId.toString(),
  deployed_at: new Date().toISOString(),
  artifact_manifest_sha256: `0x${createHash("sha256").update(manifestBytes).digest("hex")}`,
  deployer: deployer.address.toLowerCase(),
  governance: governance.address.toLowerCase(),
  review_delay_seconds: reviewDelaySeconds,
  contracts: {
    AuthorityProfileRegistry: (await authority.getAddress()).toLowerCase(),
    ProtectedBundleRegistry: (await bundle.getAddress()).toLowerCase(),
    BatteryOwnershipRegistry: (await ownership.getAddress()).toLowerCase(),
    DeploymentRegistry: (await deployment.getAddress()).toLowerCase(),
    EvidenceRegistry: (await evidence.getAddress()).toLowerCase(),
    Marketplace: (await marketplace.getAddress()).toLowerCase(),
    AuditAnchor: (await auditAnchor.getAddress()).toLowerCase(),
  },
});

process.stdout.write(`${JSON.stringify(receipt)}\n`);

async function transact(
  signer: Signer,
  contract: BaseContract,
  method: string,
  arguments_: readonly unknown[],
): Promise<void> {
  const transaction = await signer.sendTransaction({
    data: contract.interface.encodeFunctionData(method, arguments_),
    to: await contract.getAddress(),
  });
  await transaction.wait();
}

function requiredKey(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.includes("replace_with")) {
    throw new Error(`${name} is required for Sepolia deployment`);
  }
  return value;
}
