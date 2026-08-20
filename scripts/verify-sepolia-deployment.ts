import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import type { Contract } from "ethers";

const { ethers, networkName } = await network.create();
if (networkName !== "sepolia") throw new Error("Verification is restricted to Sepolia");

const provider = ethers.provider;
const chain = await provider.getNetwork();
if (chain.chainId !== 11_155_111n) throw new Error("Unexpected chain ID");

const addresses = JSON.parse(
  await readFile(
    resolve("ignition/deployments/production-sepolia/deployed_addresses.json"),
    "utf8",
  ),
) as Record<string, string>;
const publicDeployment = JSON.parse(
  await readFile(resolve("contracts/generated/solidity/sepolia-deployment.json"), "utf8"),
) as {
  activations: Array<{
    module: string;
    blockNumber: number;
    transactionHash: string;
  }>;
};
const address = (name: string): string => {
  const value = addresses[`ProductionDeployment#${name}`];
  if (value === undefined) throw new Error(`Missing deployed address for ${name}`);
  return ethers.getAddress(value);
};

const names = [
  "AuthorityProfileRegistry",
  "ProtectedBundleRegistry",
  "BatteryOwnershipRegistry",
  "DeploymentRegistry",
  "EvidenceRegistry",
  "Marketplace",
  "AuditAnchor",
] as const;
for (const name of names) {
  if ((await provider.getCode(address(name))) === "0x") throw new Error(`${name} has no code`);
}

const governance = ethers.getAddress((await ethers.getSigners())[1]!.address);
const authority = await ethers.getContractAt(
  "AuthorityProfileRegistry",
  address("AuthorityProfileRegistry"),
);
const protectedBundles = await ethers.getContractAt(
  "ProtectedBundleRegistry",
  address("ProtectedBundleRegistry"),
);
const batteries = await ethers.getContractAt(
  "BatteryOwnershipRegistry",
  address("BatteryOwnershipRegistry"),
);
const deployment = await ethers.getContractAt("DeploymentRegistry", address("DeploymentRegistry"));
const evidence = await ethers.getContractAt("EvidenceRegistry", address("EvidenceRegistry"));
const marketplace = await ethers.getContractAt("Marketplace", address("Marketplace"));
const audit = await ethers.getContractAt("AuditAnchor", address("AuditAnchor"));
const read = async <T>(contract: Contract, method: string, ...args: unknown[]): Promise<T> =>
  (await contract.getFunction(method).staticCall(...args)) as T;

const moduleTypes = ["evidence", "marketplace", "audit"] as const;
const expectedModules = {
  evidence: address("EvidenceRegistry"),
  marketplace: address("Marketplace"),
  audit: address("AuditAnchor"),
};
const activeModules: Record<string, string> = {};
for (const moduleType of moduleTypes) {
  const active = ethers.getAddress(
    await read<string>(deployment, "activeModules", ethers.encodeBytes32String(moduleType)),
  );
  if (active !== expectedModules[moduleType]) throw new Error(`${moduleType} module is not active`);
  activeModules[moduleType] = active;
}

const equal = (actual: string, expected: string, label: string): void => {
  if (ethers.getAddress(actual) !== ethers.getAddress(expected))
    throw new Error(`${label} mismatch`);
};
equal(await read(authority, "owner"), governance, "AuthorityProfileRegistry owner");
equal(await read(batteries, "owner"), governance, "BatteryOwnershipRegistry owner");
equal(await read(deployment, "owner"), governance, "DeploymentRegistry owner");
equal(
  await read(deployment, "authorityProfileRegistry"),
  address("AuthorityProfileRegistry"),
  "authority boundary",
);
equal(
  await read(deployment, "protectedBundleRegistry"),
  address("ProtectedBundleRegistry"),
  "bundle boundary",
);
equal(
  await read(deployment, "batteryOwnershipRegistry"),
  address("BatteryOwnershipRegistry"),
  "battery boundary",
);
equal(
  await read(evidence, "authorityProfileRegistry"),
  address("AuthorityProfileRegistry"),
  "evidence authority",
);
equal(
  await read(evidence, "protectedBundleRegistry"),
  address("ProtectedBundleRegistry"),
  "evidence bundle",
);
equal(
  await read(marketplace, "authorityProfileRegistry"),
  address("AuthorityProfileRegistry"),
  "market authority",
);
equal(
  await read(marketplace, "protectedBundleRegistry"),
  address("ProtectedBundleRegistry"),
  "market bundle",
);
equal(
  await read(marketplace, "batteryOwnershipRegistry"),
  address("BatteryOwnershipRegistry"),
  "market battery",
);
equal(
  await read(marketplace, "deploymentRegistry"),
  address("DeploymentRegistry"),
  "market deployment",
);
equal(
  await read(audit, "authorityProfileRegistry"),
  address("AuthorityProfileRegistry"),
  "audit authority",
);
if (!(await read<boolean>(protectedBundles, "bootstrapClosed")))
  throw new Error("Protected bundle bootstrap remains open");
if (!(await read<boolean>(batteries, "marketplaces", address("Marketplace"))))
  throw new Error("Marketplace is not authorized");
if ((await read<bigint>(deployment, "reviewDelay")) !== 60n)
  throw new Error("Unexpected Sepolia review delay");

const activationEvent = deployment.interface.getEvent("ModuleActivated");
if (activationEvent === null) throw new Error("ModuleActivated event is missing from the ABI");
const activations = [];
for (const expected of publicDeployment.activations) {
  const receipt = await provider.getTransactionReceipt(expected.transactionHash);
  if (receipt === null || receipt.status !== 1)
    throw new Error(`Missing successful ${expected.module} activation receipt`);
  if (receipt.blockNumber !== expected.blockNumber)
    throw new Error(`${expected.module} activation block mismatch`);
  const matchingLog = receipt.logs.find(
    (entry) =>
      ethers.getAddress(entry.address) === address("DeploymentRegistry") &&
      entry.topics[0] === activationEvent.topicHash,
  );
  if (matchingLog === undefined)
    throw new Error(`Missing ${expected.module} ModuleActivated event`);
  activations.push({
    module: expected.module,
    block_number: receipt.blockNumber,
    transaction_hash: receipt.hash,
  });
}
if (activations.length !== 3) throw new Error("Unexpected module activation count");

const latestBlock = await provider.getBlockNumber();

const manifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
const record = {
  schema: "EVLLM_SEPOLIA_DEPLOYMENT_VERIFICATION_V1",
  verified_at: new Date().toISOString(),
  chain_id: chain.chainId.toString(),
  latest_block: latestBlock,
  governance,
  artifact_manifest_sha256: `0x${createHash("sha256").update(manifestBytes).digest("hex")}`,
  compiler: "solc-0.8.36",
  review_delay_seconds: 60,
  addresses: Object.fromEntries(names.map((name) => [name, address(name)])),
  active_modules: activeModules,
  protected_bundle_bootstrap_closed: true,
  marketplace_authorized_for_battery_locking: true,
  activation_events: activations,
  explorer: "https://sepolia.etherscan.io",
};

await mkdir(resolve("evaluation/final/assurance/deployment"), { recursive: true });
await writeFile(
  resolve("evaluation/final/assurance/deployment/sepolia-verification.json"),
  `${JSON.stringify(record, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
