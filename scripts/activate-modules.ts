import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { network } from "hardhat";
import type { ContractTransactionResponse } from "ethers";

const { ethers, networkName } = await network.create();
if (networkName !== "sepolia") throw new Error("Module activation is restricted to Sepolia");
const signers = await ethers.getSigners();
const governance = signers[1];
if (governance === undefined) throw new Error("The distinct Sepolia governance signer is required");
const addresses = JSON.parse(
  await readFile(
    resolve("ignition/deployments/production-sepolia/deployed_addresses.json"),
    "utf8",
  ),
) as Record<string, string>;
const deploymentAddress = addresses["ProductionDeployment#DeploymentRegistry"];
if (deploymentAddress === undefined) throw new Error("DeploymentRegistry address is missing");
const deployment = await ethers.getContractAt("DeploymentRegistry", deploymentAddress, governance);
const proposals = deployment.getFunction("proposals") as unknown as (
  moduleType: string,
) => Promise<{ module: string; activateAfter: bigint }>;
const activeModules = deployment.getFunction("activeModules") as unknown as (
  moduleType: string,
) => Promise<string>;
const activateModule = deployment.getFunction("activateModule") as unknown as (
  moduleType: string,
) => Promise<ContractTransactionResponse>;
for (const moduleType of ["evidence", "marketplace", "audit"] as const) {
  const encoded = ethers.encodeBytes32String(moduleType);
  const proposal = await proposals(encoded);
  if (proposal.module === ethers.ZeroAddress) {
    if ((await activeModules(encoded)) === ethers.ZeroAddress) {
      throw new Error(`${moduleType} has neither a proposal nor an active module`);
    }
    continue;
  }
  if (BigInt(Math.floor(Date.now() / 1000)) < proposal.activateAfter) {
    throw new Error(`${moduleType} review delay has not elapsed`);
  }
  await (await activateModule(encoded)).wait();
}
process.stdout.write("Sepolia module activation completed.\n");
