import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

import { config as loadEnvironment } from "dotenv";
import { formatEther, JsonRpcProvider, Wallet } from "ethers";

loadEnvironment({ path: ".env/local.env", quiet: true });
loadEnvironment({ path: ".env/sepolia-demo.env", quiet: true });

const rpc = required("SEPOLIA_RPC_URL");
const provider = new JsonRpcProvider(rpc);
const network = await provider.getNetwork();
if (network.chainId !== 11_155_111n)
  throw new Error("Refusing to plan against a non-Sepolia chain");
const deployer = new Wallet(required("SEPOLIA_DEPLOYER_PRIVATE_KEY"));
const governance = new Wallet(required("SEPOLIA_GOVERNANCE_PRIVATE_KEY"));
if (deployer.address === governance.address) throw new Error("Deployer and governance must differ");

const gas = JSON.parse(
  await readFile(resolve("evaluation/final/assurance/contracts/gas-stats.json"), "utf8"),
) as { contracts: Record<string, { contractName: string; deployment?: { max: number } }> };
const manifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
const contracts = [
  "AuthorityProfileRegistry",
  "ProtectedBundleRegistry",
  "BatteryOwnershipRegistry",
  "DeploymentRegistry",
  "EvidenceRegistry",
  "Marketplace",
  "AuditAnchor",
] as const;
const reviewDelaySeconds = 60;
const deploymentGas = contracts.map((contract) => {
  const record = Object.values(gas.contracts).find(
    (candidate) => candidate.contractName === contract,
  );
  if (record?.deployment === undefined) throw new Error(`Missing gas evidence for ${contract}`);
  return { contract, measuredGas: record.deployment.max };
});
const deployerConfigurationGas = 46_457;
const governanceConfigurationGas = 49_099 + 78_811 * 3;
const deploymentGasTotal = deploymentGas.reduce((sum, item) => sum + item.measuredGas, 0);
const measuredGas = deploymentGasTotal + deployerConfigurationGas + governanceConfigurationGas;
const bufferedGas = Math.ceil(measuredGas * 1.25);
const fee = await provider.getFeeData();
const planningGasPrice = fee.maxFeePerGas ?? fee.gasPrice;
if (planningGasPrice === null) throw new Error("Sepolia fee data is unavailable");
const maximumEstimatedWei = BigInt(bufferedGas) * planningGasPrice;
const deployerBufferedGas = Math.ceil((deploymentGasTotal + deployerConfigurationGas) * 1.25);
const governanceBufferedGas = Math.ceil(governanceConfigurationGas * 1.25);
const document = {
  schema: "EVLLM_SEPOLIA_DEPLOYMENT_PLAN_V1",
  generated_at: new Date().toISOString(),
  chain_id: network.chainId.toString(),
  deployer: deployer.address,
  governance: governance.address,
  balances: {
    deployer_eth: formatEther(await provider.getBalance(deployer.address)),
    governance_eth: formatEther(await provider.getBalance(governance.address)),
  },
  artifact_manifest_sha256: `0x${createHash("sha256").update(manifestBytes).digest("hex")}`,
  review_delay_seconds: reviewDelaySeconds,
  transactions: [
    ...deploymentGas.map((item, index) => ({
      order: index + 1,
      signer: "deployer",
      action: `deploy ${item.contract}`,
      measured_local_gas: item.measuredGas,
    })),
    { order: 8, signer: "governance", action: "authorize Marketplace in BatteryOwnershipRegistry" },
    {
      order: 9,
      signer: "deployer",
      action: "irreversibly close ProtectedBundleRegistry bootstrap",
    },
    { order: 10, signer: "governance", action: "propose EvidenceRegistry module" },
    { order: 11, signer: "governance", action: "propose Marketplace module" },
    { order: 12, signer: "governance", action: "propose AuditAnchor module" },
  ],
  measured_local_gas_total: measuredGas,
  buffered_gas_total: bufferedGas,
  signer_gas: {
    deployer: {
      buffered_gas: deployerBufferedGas,
      buffered_maximum_estimated_eth: formatEther(BigInt(deployerBufferedGas) * planningGasPrice),
    },
    governance: {
      buffered_gas: governanceBufferedGas,
      buffered_maximum_estimated_eth: formatEther(BigInt(governanceBufferedGas) * planningGasPrice),
    },
  },
  planning_max_fee_per_gas_wei: planningGasPrice.toString(),
  buffered_maximum_estimated_eth: formatEther(maximumEstimatedWei),
  activation_transactions: [
    { order: 13, signer: "governance", action: "activate EvidenceRegistry module" },
    { order: 14, signer: "governance", action: "activate Marketplace module" },
    { order: 15, signer: "governance", action: "activate AuditAnchor module" },
  ],
  activation_buffered_maximum_estimated_eth: formatEther(
    BigInt(Math.ceil(52_330 * 3 * 1.25)) * planningGasPrice,
  ),
  approval_required: true,
  activation_note:
    "The Sepolia research profile uses a 60-second review delay. Production retains the 86400-second default.",
};
await mkdir(resolve(".local-results/deployment"), { recursive: true });
await writeFile(
  resolve(".local-results/deployment/sepolia-deployment-plan.json"),
  `${JSON.stringify(document, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.includes("replace_with")) throw new Error(`${name} is missing`);
  return value;
}
