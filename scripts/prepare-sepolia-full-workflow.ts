import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { config as loadEnvironment } from "dotenv";
import { Contract, JsonRpcProvider, Wallet, formatEther } from "ethers";

import {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_WORKFLOW_ID,
  sepoliaContractNames,
  sepoliaWorkflowRoles,
} from "./lib/sepolia-workflow-config.js";

loadEnvironment({ path: ".env/local.env", quiet: true });
loadEnvironment({ path: ".env/sepolia-demo.env", quiet: true });

const rpcUrl = process.env.SEPOLIA_RPC_URL;
if (rpcUrl === undefined || rpcUrl.includes("replace_with")) {
  throw new Error("SEPOLIA_RPC_URL is required for the read-only workflow preflight");
}

const provider = new JsonRpcProvider(rpcUrl, SEPOLIA_CHAIN_ID, { staticNetwork: true });
const network = await provider.getNetwork();
if (network.chainId !== SEPOLIA_CHAIN_ID) throw new Error("The RPC endpoint is not Sepolia");

const deployment = JSON.parse(
  await readFile(resolve("contracts/generated/solidity/sepolia-deployment.json"), "utf8"),
) as {
  deployer: string;
  governance: string;
  addresses: Record<string, string>;
};

const missingEnvironment: string[] = [];
const invalidEnvironment: string[] = [];
const wallets = new Map<string, Wallet>();
for (const specification of sepoliaWorkflowRoles) {
  const privateKey = process.env[specification.environment];
  if (privateKey === undefined || privateKey.trim() === "" || privateKey.includes("replace_with")) {
    missingEnvironment.push(specification.environment);
    continue;
  }
  try {
    wallets.set(specification.role, new Wallet(privateKey.trim(), provider));
  } catch {
    invalidEnvironment.push(specification.environment);
  }
}

const duplicateAddresses = [...wallets.entries()]
  .map(([role, wallet]) => ({ role, address: wallet.address.toLowerCase() }))
  .reduce<Map<string, string[]>>((groups, entry) => {
    const roles = groups.get(entry.address) ?? [];
    roles.push(entry.role);
    groups.set(entry.address, roles);
    return groups;
  }, new Map());
const repeatedRoles = [...duplicateAddresses.entries()]
  .filter(([, roles]) => roles.length > 1)
  .map(([address, roles]) => ({ address, roles }));

const deploymentChecks: Array<{ check: string; passed: boolean; observed: string }> = [];
for (const name of sepoliaContractNames) {
  const address = deployment.addresses[name];
  const hasCode = address !== undefined && (await provider.getCode(address)) !== "0x";
  deploymentChecks.push({
    check: `${name} bytecode`,
    passed: hasCode,
    observed: address ?? "missing",
  });
}

const authorityAddress = requiredAddress(deployment.addresses, "AuthorityProfileRegistry");
const bundleAddress = requiredAddress(deployment.addresses, "ProtectedBundleRegistry");
const ownershipAddress = requiredAddress(deployment.addresses, "BatteryOwnershipRegistry");
const deploymentAddress = requiredAddress(deployment.addresses, "DeploymentRegistry");
const evidenceAddress = requiredAddress(deployment.addresses, "EvidenceRegistry");
const marketplaceAddress = requiredAddress(deployment.addresses, "Marketplace");
const auditAddress = requiredAddress(deployment.addresses, "AuditAnchor");

const authority = new Contract(
  authorityAddress,
  ["function owner() view returns (address)"],
  provider,
);
const bundles = new Contract(
  bundleAddress,
  ["function bootstrapClosed() view returns (bool)"],
  provider,
);
const ownership = new Contract(
  ownershipAddress,
  ["function owner() view returns (address)", "function marketplaces(address) view returns (bool)"],
  provider,
);
const deploymentRegistry = new Contract(
  deploymentAddress,
  [
    "function owner() view returns (address)",
    "function activeModules(bytes32) view returns (address)",
    "function authorityProfileRegistry() view returns (address)",
    "function protectedBundleRegistry() view returns (address)",
    "function batteryOwnershipRegistry() view returns (address)",
  ],
  provider,
);

const governance = deployment.governance.toLowerCase();
const authorityOwner = String(await contractRead(authority, "owner"));
const ownershipOwner = String(await contractRead(ownership, "owner"));
const deploymentOwner = String(await contractRead(deploymentRegistry, "owner"));
const bootstrapClosed = Boolean(await contractRead(bundles, "bootstrapClosed"));
const marketplaceAuthorized = Boolean(
  await contractRead(ownership, "marketplaces", marketplaceAddress),
);
const authorityLink = String(await contractRead(deploymentRegistry, "authorityProfileRegistry"));
const bundleLink = String(await contractRead(deploymentRegistry, "protectedBundleRegistry"));
const ownershipLink = String(await contractRead(deploymentRegistry, "batteryOwnershipRegistry"));
deploymentChecks.push(
  {
    check: "Authority registry owner",
    passed: authorityOwner.toLowerCase() === governance,
    observed: authorityOwner,
  },
  {
    check: "Ownership registry owner",
    passed: ownershipOwner.toLowerCase() === governance,
    observed: ownershipOwner,
  },
  {
    check: "Deployment registry owner",
    passed: deploymentOwner.toLowerCase() === governance,
    observed: deploymentOwner,
  },
  {
    check: "Protected-record bootstrap closed",
    passed: bootstrapClosed,
    observed: String(bootstrapClosed),
  },
  {
    check: "Marketplace authorized for battery locking",
    passed: marketplaceAuthorized,
    observed: String(marketplaceAuthorized),
  },
  {
    check: "Deployment registry authority link",
    passed: authorityLink.toLowerCase() === authorityAddress.toLowerCase(),
    observed: authorityLink,
  },
  {
    check: "Deployment registry bundle link",
    passed: bundleLink.toLowerCase() === bundleAddress.toLowerCase(),
    observed: bundleLink,
  },
  {
    check: "Deployment registry ownership link",
    passed: ownershipLink.toLowerCase() === ownershipAddress.toLowerCase(),
    observed: ownershipLink,
  },
);

for (const [module, expected] of [
  ["evidence", evidenceAddress],
  ["marketplace", marketplaceAddress],
  ["audit", auditAddress],
] as const) {
  const active = String(
    await contractRead(deploymentRegistry, "activeModules", encodeModule(module)),
  );
  deploymentChecks.push({
    check: `${module} module active`,
    passed: active.toLowerCase() === expected.toLowerCase(),
    observed: active,
  });
}

const feeData = await provider.getFeeData();
const observedMaxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 5_000_000_000n;
const bufferedGasPrice = (observedMaxFeePerGas * 3n + 1n) / 2n;
const balances = [];
for (const specification of sepoliaWorkflowRoles) {
  const wallet = wallets.get(specification.role);
  if (wallet === undefined) {
    balances.push({
      role: specification.role,
      environment: specification.environment,
      address: null,
      balance_wei: null,
      balance_eth: null,
      recommended_minimum_wei: null,
      recommended_minimum_eth: null,
      sufficient: false,
    });
    continue;
  }
  const balance = await provider.getBalance(wallet.address);
  const recommended = specification.gasBudget * bufferedGasPrice + specification.transferredValue;
  balances.push({
    role: specification.role,
    environment: specification.environment,
    address: wallet.address,
    balance_wei: balance.toString(),
    balance_eth: formatEther(balance),
    recommended_minimum_wei: recommended.toString(),
    recommended_minimum_eth: formatEther(recommended),
    sufficient: balance >= recommended,
  });
}

const expectedDeployer = wallets.get("deployer")?.address.toLowerCase();
const expectedGovernance = wallets.get("governance")?.address.toLowerCase();
const identityChecks = [
  {
    check: "deployer matches deployment record",
    passed:
      expectedDeployer !== undefined && expectedDeployer === deployment.deployer.toLowerCase(),
  },
  {
    check: "governance matches deployment record",
    passed: expectedGovernance !== undefined && expectedGovernance === governance,
  },
];

const ready =
  missingEnvironment.length === 0 &&
  invalidEnvironment.length === 0 &&
  repeatedRoles.length === 0 &&
  deploymentChecks.every((entry) => entry.passed) &&
  identityChecks.every((entry) => entry.passed) &&
  balances.every((entry) => entry.sufficient);

const report = {
  schema: "EVLLM_SEPOLIA_FULL_WORKFLOW_PREFLIGHT_V1",
  checked_at: new Date().toISOString(),
  workflow_id: SEPOLIA_WORKFLOW_ID,
  chain_id: network.chainId.toString(),
  latest_block: await provider.getBlockNumber(),
  observed_max_fee_per_gas_wei: observedMaxFeePerGas.toString(),
  buffered_gas_price_wei: bufferedGasPrice.toString(),
  missing_environment: missingEnvironment,
  invalid_environment: invalidEnvironment,
  duplicate_role_addresses: repeatedRoles,
  identity_checks: identityChecks,
  deployment_checks: deploymentChecks,
  balances,
  ready,
};

const outputDirectory = resolve(".local-results", "sepolia-full-workflow");
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, "preflight.json"), `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`Sepolia full-workflow preflight ${ready ? "READY" : "NOT READY"}\n`);
for (const entry of balances) {
  process.stdout.write(
    `${entry.role.padEnd(20)} ${entry.address ?? "missing key"} balance=${entry.balance_eth ?? "-"} ETH required=${entry.recommended_minimum_eth ?? "-"} ETH ${entry.sufficient ? "OK" : "NEEDS ACTION"}\n`,
  );
}
if (missingEnvironment.length > 0) {
  process.stdout.write(`Missing environment entries: ${missingEnvironment.join(", ")}\n`);
}
if (invalidEnvironment.length > 0) {
  process.stdout.write(`Invalid private-key entries: ${invalidEnvironment.join(", ")}\n`);
}
if (repeatedRoles.length > 0) {
  process.stdout.write(
    `Role separation failure: ${repeatedRoles.map((entry) => entry.roles.join("/")).join(", ")}\n`,
  );
}
for (const check of [...identityChecks, ...deploymentChecks]) {
  if (!check.passed) process.stdout.write(`Failed check: ${check.check}\n`);
}

if (!ready) process.exitCode = 1;

function requiredAddress(addresses: Record<string, string>, name: string): string {
  const address = addresses[name];
  if (address === undefined) throw new Error(`Missing ${name} address in the deployment record`);
  return address;
}

function encodeModule(name: string): string {
  const bytes = Buffer.alloc(32);
  bytes.write(name, "utf8");
  return `0x${bytes.toString("hex")}`;
}

async function contractRead(
  contract: Contract,
  method: string,
  ...arguments_: unknown[]
): Promise<unknown> {
  return contract.getFunction(method).staticCall(...arguments_);
}
