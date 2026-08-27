import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import type { Contract, InterfaceAbi } from "ethers";

import {
  assertDecodedConfigurationCall,
  assertExactDeploymentProfile,
  expectedConfigurationCalls,
  expectedConstructorArguments,
  expectedContractNames,
  expectedModuleTypes,
  sha256,
  verifyReviewedArtifactBinding,
  verifyReviewedRuntimeBytecode,
  type PublicSepoliaDeployment,
  type ReviewedSolidityArtifact,
  type SolidityBuildInfoOutput,
  type SolidityArtifactManifest,
} from "./lib/sepolia-deployment-verification.js";

const { ethers, networkName } = await network.create();
if (networkName !== "sepolia") throw new Error("Verification is restricted to Sepolia");

const provider = ethers.provider;
const chain = await provider.getNetwork();
if (chain.chainId !== 11_155_111n) throw new Error("Unexpected chain ID");

const publicDeployment = JSON.parse(
  await readFile(resolve("contracts/generated/solidity/sepolia-deployment.json"), "utf8"),
) as PublicSepoliaDeployment;
const artifactManifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
const artifactManifest = JSON.parse(
  artifactManifestBytes.toString("utf8"),
) as SolidityArtifactManifest;
assertExactDeploymentProfile(publicDeployment, artifactManifestBytes, artifactManifest);

const address = (name: string): string => {
  const value = publicDeployment.addresses[name];
  if (value === undefined) throw new Error(`Missing deployed address for ${name}`);
  return ethers.getAddress(value);
};

const artifactByContract = new Map<
  (typeof expectedContractNames)[number],
  ReviewedSolidityArtifact & { abi: InterfaceAbi; bytecode: string }
>();
const runtimeBytecode: Record<string, unknown> = {};
for (const name of expectedContractNames) {
  const artifact = JSON.parse(
    await readFile(resolve(`artifacts/contracts/${name}.sol/${name}.json`), "utf8"),
  ) as ReviewedSolidityArtifact & { abi: InterfaceAbi; bytecode: string };
  const manifestContract = artifactManifest.contracts.find(
    ({ contractName }) => contractName === name,
  );
  if (manifestContract === undefined) throw new Error(`${name} is missing from artifact manifest`);
  const buildInfoOutputBytes = await readFile(
    resolve(`artifacts/build-info/${manifestContract.buildInfoId}.output.json`),
  );
  const buildInfoOutput = JSON.parse(
    buildInfoOutputBytes.toString("utf8"),
  ) as SolidityBuildInfoOutput;
  const artifactBinding = verifyReviewedArtifactBinding(
    name,
    artifact,
    manifestContract,
    buildInfoOutputBytes,
    buildInfoOutput,
  );
  const verification = verifyReviewedRuntimeBytecode(
    name,
    await provider.getCode(address(name)),
    artifact,
    artifactBinding,
  );
  runtimeBytecode[name] = {
    onchain_bytecode: verification.onchainBytecode,
    onchain_sha256: verification.onchainSha256,
    reviewed_sha256: verification.reviewedSha256,
    normalized_sha256: verification.normalizedSha256,
    size_bytes: verification.sizeBytes,
  };
  artifactByContract.set(name, artifact);
}

const deployer = ethers.getAddress(publicDeployment.deployer);
const governance = ethers.getAddress(publicDeployment.governance);
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
equal(await read(protectedBundles, "bootstrapGovernance"), deployer, "bootstrap governance");
if (!(await read<boolean>(batteries, "marketplaces", address("Marketplace"))))
  throw new Error("Marketplace is not authorized");
if ((await read<bigint>(deployment, "reviewDelay")) !== 60n)
  throw new Error("Unexpected Sepolia review delay");
if ((await read<bigint>(marketplace, "acceptanceWindow")) !== 86_400n)
  throw new Error("Unexpected Marketplace acceptance window");

const activationEvent = deployment.interface.getEvent("ModuleActivated");
if (activationEvent === null) throw new Error("ModuleActivated event is missing from the ABI");
const deploymentTransactions = [];
for (const expected of publicDeployment.deploymentTransactions) {
  const receipt = await successfulReceipt(expected.transactionHash, expected.blockNumber);
  if (receipt.contractAddress === null || receipt.contractAddress !== address(expected.contract)) {
    throw new Error(`${expected.contract} deployment address mismatch`);
  }
  if (receipt.gasUsed.toString() !== expected.gasUsed)
    throw new Error(`${expected.contract} deployment gas mismatch`);
  const transaction = await provider.getTransaction(expected.transactionHash);
  if (transaction === null) throw new Error(`Missing ${expected.contract} deployment transaction`);
  if (transaction.to !== null || ethers.getAddress(transaction.from) !== deployer) {
    throw new Error(`${expected.contract} deployment origin mismatch`);
  }
  if (transaction.value !== 0n) throw new Error(`${expected.contract} deployment sent value`);
  const name = expected.contract as (typeof expectedContractNames)[number];
  const artifact = artifactByContract.get(name);
  if (artifact === undefined) throw new Error(`${expected.contract} reviewed artifact is missing`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode);
  const reviewedDeployment = await factory.getDeployTransaction(
    ...expectedConstructorArguments(name, publicDeployment.addresses, governance),
  );
  if (
    reviewedDeployment.data === undefined ||
    transaction.data.toLowerCase() !== reviewedDeployment.data.toString().toLowerCase()
  ) {
    throw new Error(`${expected.contract} creation bytecode or constructor arguments mismatch`);
  }
  deploymentTransactions.push({
    contract: expected.contract,
    block_number: receipt.blockNumber,
    transaction_hash: receipt.hash,
    gas_used: receipt.gasUsed.toString(),
  });
}

const configurationTransactions = [];
const expectedConfiguration = expectedConfigurationCalls(publicDeployment.addresses);
for (const [index, expected] of publicDeployment.configurationTransactions.entries()) {
  const expectedCall = expectedConfiguration[index];
  if (expectedCall === undefined) throw new Error("Unexpected configuration transaction");
  const receipt = await successfulReceipt(expected.transactionHash, expected.blockNumber);
  if (receipt.gasUsed.toString() !== expected.gasUsed)
    throw new Error(`${expected.contract}.${expected.function} gas mismatch`);
  if (receipt.fee.toString() !== expected.transactionFeeWei)
    throw new Error(`${expected.contract}.${expected.function} fee mismatch`);
  const transaction = await provider.getTransaction(expected.transactionHash);
  if (transaction === null || transaction.to === null)
    throw new Error(`${expected.contract}.${expected.function} transaction is missing`);
  if (ethers.getAddress(transaction.to) !== address(expected.contract))
    throw new Error(`${expected.contract}.${expected.function} transaction target mismatch`);
  const expectedSigner = expectedCall.signer === "deployer" ? deployer : governance;
  if (ethers.getAddress(transaction.from) !== expectedSigner)
    throw new Error(`${expected.contract}.${expected.function} transaction signer mismatch`);
  if (transaction.value !== 0n)
    throw new Error(`${expected.contract}.${expected.function} transaction sent value`);
  const contract = await ethers.getContractAt(expected.contract, address(expected.contract));
  const decoded = contract.interface.parseTransaction({
    data: transaction.data,
    value: transaction.value,
  });
  if (decoded === null)
    throw new Error(`${expected.contract}.${expected.function} transaction data is undecodable`);
  assertDecodedConfigurationCall(expectedCall, decoded.name, Array.from(decoded.args));
  configurationTransactions.push({
    contract: expected.contract,
    function: expected.function,
    block_number: receipt.blockNumber,
    transaction_hash: receipt.hash,
    gas_used: receipt.gasUsed.toString(),
    transaction_fee_wei: receipt.fee.toString(),
  });
}

const activations = [];
for (const expected of publicDeployment.activations) {
  const receipt = await provider.getTransactionReceipt(expected.transactionHash);
  if (receipt === null || receipt.status !== 1)
    throw new Error(`Missing successful ${expected.module} activation receipt`);
  if (receipt.blockNumber !== expected.blockNumber)
    throw new Error(`${expected.module} activation block mismatch`);
  const matchingLogs = receipt.logs.filter(
    (entry) =>
      ethers.getAddress(entry.address) === address("DeploymentRegistry") &&
      entry.topics[0] === activationEvent.topicHash,
  );
  if (matchingLogs.length !== 1)
    throw new Error(`Expected exactly one ${expected.module} ModuleActivated event`);
  const matchingLog = matchingLogs[0];
  if (matchingLog === undefined) throw new Error(`Missing ${expected.module} activation log`);
  const decodedLog = deployment.interface.parseLog(matchingLog);
  const expectedModuleType =
    expectedModuleTypes[expected.module as keyof typeof expectedModuleTypes];
  const expectedModuleAddress = expectedModules[expected.module as keyof typeof expectedModules];
  const moduleTypeArgument: unknown = decodedLog?.args[0];
  const moduleAddressArgument: unknown = decodedLog?.args[1];
  if (
    decodedLog?.name !== "ModuleActivated" ||
    typeof moduleTypeArgument !== "string" ||
    moduleTypeArgument.toLowerCase() !== expectedModuleType ||
    typeof moduleAddressArgument !== "string" ||
    ethers.getAddress(moduleAddressArgument) !== expectedModuleAddress
  ) {
    throw new Error(`${expected.module} ModuleActivated event arguments mismatch`);
  }
  activations.push({
    module: expected.module,
    block_number: receipt.blockNumber,
    transaction_hash: receipt.hash,
  });
}
if (activations.length !== 3) throw new Error("Unexpected module activation count");

const latestBlock = await provider.getBlockNumber();
const deploymentGas = deploymentTransactions.reduce(
  (total, item) => total + BigInt(item.gas_used),
  0n,
);
const configurationGas = configurationTransactions.reduce(
  (total, item) => total + BigInt(item.gas_used),
  0n,
);
const configurationFees = configurationTransactions.reduce(
  (total, item) => total + BigInt(item.transaction_fee_wei),
  0n,
);

const record = {
  schema: "EVLLM_SEPOLIA_DEPLOYMENT_VERIFICATION_V2",
  verified_at: new Date().toISOString(),
  chain_id: chain.chainId.toString(),
  latest_block: latestBlock,
  governance,
  artifact_manifest_sha256: sha256(artifactManifestBytes),
  compiler: "solc-0.8.36",
  review_delay_seconds: 60,
  addresses: Object.fromEntries(expectedContractNames.map((name) => [name, address(name)])),
  runtime_bytecode: runtimeBytecode,
  deployment_transactions: deploymentTransactions,
  configuration_transactions: configurationTransactions,
  deployment_gas_used: deploymentGas.toString(),
  configuration_gas_used: configurationGas.toString(),
  commissioning_gas_used: (deploymentGas + configurationGas).toString(),
  configuration_transaction_fees_wei: configurationFees.toString(),
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

async function successfulReceipt(transactionHash: string, blockNumber: number) {
  const receipt = await provider.getTransactionReceipt(transactionHash);
  if (receipt === null || receipt.status !== 1)
    throw new Error(`Missing successful receipt ${transactionHash}`);
  if (receipt.blockNumber !== blockNumber)
    throw new Error(`Receipt block mismatch ${transactionHash}`);
  return receipt;
}
