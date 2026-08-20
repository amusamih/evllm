import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const contractNames = [
  "AuthorityProfileRegistry",
  "ProtectedBundleRegistry",
  "BatteryOwnershipRegistry",
  "DeploymentRegistry",
  "EvidenceRegistry",
  "Marketplace",
  "AuditAnchor",
] as const;

describe("frozen Hardhat assurance and deployment profile", () => {
  it("pins every selected plugin and the exact forge-std commit", async () => {
    const packageDocument = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    expect(packageDocument.devDependencies).toMatchObject({
      "@nomicfoundation/hardhat-ethers": "4.0.15",
      "@nomicfoundation/hardhat-ignition": "3.1.8",
      "@nomicfoundation/hardhat-ignition-ethers": "3.1.6",
      "@nomicfoundation/hardhat-verify": "3.0.22",
      "@openzeppelin/contracts": "5.6.1",
      "forge-std":
        "https://github.com/foundry-rs/forge-std/archive/bf647bd6046f2f7da30d0c2bf435e5c76a780c1b.tar.gz",
      hardhat: "3.12.0",
    });
  });

  it("retains production compiler, network, deployment, and verification config", async () => {
    const config = await readFile(resolve("hardhat.config.ts"), "utf8");
    for (const required of [
      "preferWasm: true",
      "viaIR: false",
      'evmVersion: "cancun"',
      "runs: 200",
      "chainId: 31337",
      "chainId: 11155111",
      'configVariable("SEPOLIA_RPC_URL")',
      'configVariable("SEPOLIA_DEPLOYER_PRIVATE_KEY")',
      'configVariable("SEPOLIA_GOVERNANCE_PRIVATE_KEY")',
      'configVariable("ETHERSCAN_API_KEY")',
    ]) {
      expect(config).toContain(required);
    }
    const module = await readFile(resolve("ignition/modules/ProductionDeployment.ts"), "utf8");
    for (const contractName of contractNames) expect(module).toContain(contractName);
    const parameters = JSON.parse(
      await readFile(resolve("ignition/parameters/production-sepolia.json"), "utf8"),
    ) as { ProductionDeployment: { reviewDelaySeconds: number } };
    expect(parameters.ProductionDeployment.reviewDelaySeconds).toBe(60);
  });

  it("matches every generated manifest digest to the current compiler artifact", async () => {
    const manifest = JSON.parse(
      await readFile(resolve("contracts/generated/solidity/manifest.json"), "utf8"),
    ) as {
      contracts: Array<{
        contractName: string;
        creationBytecodeSha256: string;
        deployedBytecodeSha256: string;
      }>;
    };
    expect(manifest.contracts.map(({ contractName }) => contractName)).toEqual(contractNames);
    for (const contract of manifest.contracts) {
      const artifact = JSON.parse(
        await readFile(
          resolve(`artifacts/contracts/${contract.contractName}.sol/${contract.contractName}.json`),
          "utf8",
        ),
      ) as { bytecode: string; deployedBytecode: string };
      expect(digest(artifact.bytecode)).toBe(contract.creationBytecodeSha256);
      expect(digest(artifact.deployedBytecode)).toBe(contract.deployedBytecodeSha256);
      if (contract.contractName === "Marketplace") {
        expect((artifact.deployedBytecode.length - 2) / 2).toBeLessThanOrEqual(24_576);
      }
    }
  });
});

function digest(bytecode: string): string {
  return `0x${createHash("sha256")
    .update(Buffer.from(bytecode.replace(/^0x/u, ""), "hex"))
    .digest("hex")}`;
}
