import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertDecodedConfigurationCall,
  assertExactDeploymentProfile,
  expectedConfigurationCalls,
  sha256,
  verifyReviewedArtifactBinding,
  verifyReviewedRuntimeBytecode,
  type PublicSepoliaDeployment,
  type ReviewedSolidityArtifact,
  type SolidityArtifactManifestContract,
  type SolidityBuildInfoOutput,
  type SolidityArtifactManifest,
} from "../../scripts/lib/sepolia-deployment-verification.js";

describe("Sepolia deployment verification profile", () => {
  it("accepts the complete reviewed deployment and configuration manifest", async () => {
    const fixture = await deploymentFixture();
    expect(() =>
      assertExactDeploymentProfile(fixture.deployment, fixture.manifestBytes, fixture.manifest),
    ).not.toThrow();
  });

  it("rejects missing, extra, reordered, or differently bound entries", async () => {
    const fixture = await deploymentFixture();

    const missingAddress = structuredClone(fixture.deployment);
    delete missingAddress.addresses.AuditAnchor;
    expect(() =>
      assertExactDeploymentProfile(missingAddress, fixture.manifestBytes, fixture.manifest),
    ).toThrow(/deployed addresses/u);

    const extraDeployment = structuredClone(fixture.deployment);
    const firstDeployment = extraDeployment.deploymentTransactions[0];
    if (firstDeployment === undefined) throw new Error("Deployment fixture is empty");
    extraDeployment.deploymentTransactions.push({ ...firstDeployment, contract: "Unexpected" });
    expect(() =>
      assertExactDeploymentProfile(extraDeployment, fixture.manifestBytes, fixture.manifest),
    ).toThrow(/deployment transactions/u);

    const reorderedConfiguration = structuredClone(fixture.deployment);
    const firstConfiguration = reorderedConfiguration.configurationTransactions[0];
    const secondConfiguration = reorderedConfiguration.configurationTransactions[1];
    if (firstConfiguration === undefined || secondConfiguration === undefined) {
      throw new Error("Configuration fixture is incomplete");
    }
    reorderedConfiguration.configurationTransactions[0] = secondConfiguration;
    reorderedConfiguration.configurationTransactions[1] = firstConfiguration;
    expect(() =>
      assertExactDeploymentProfile(reorderedConfiguration, fixture.manifestBytes, fixture.manifest),
    ).toThrow(/configuration transactions/u);

    const wrongManifest = structuredClone(fixture.deployment);
    wrongManifest.artifactManifestSha256 = `0x${"00".repeat(32)}`;
    expect(() =>
      assertExactDeploymentProfile(wrongManifest, fixture.manifestBytes, fixture.manifest),
    ).toThrow(/artifact manifest digest mismatch/u);
  });

  it("checks the complete decoded argument list of every expected configuration call", async () => {
    const { deployment, manifest, manifestBytes } = await deploymentFixture();
    assertExactDeploymentProfile(deployment, manifestBytes, manifest);
    const calls = expectedConfigurationCalls(deployment.addresses);
    for (const call of calls) {
      expect(() =>
        assertDecodedConfigurationCall(call, call.function, [...call.arguments]),
      ).not.toThrow();
    }

    const marketplaceAuthorization = calls.find(
      ({ function: functionName }) => functionName === "setMarketplace",
    );
    if (marketplaceAuthorization === undefined)
      throw new Error("Expected Marketplace call is absent");
    expect(() =>
      assertDecodedConfigurationCall(marketplaceAuthorization, "setMarketplace", [
        marketplaceAuthorization.arguments[0],
        false,
      ]),
    ).toThrow(/argument 2 mismatch/u);
  });

  it("matches reviewed runtime code while accounting only for declared immutable slots", async () => {
    const { artifact, binding } = await reviewedDeploymentArtifact();

    expect(() =>
      verifyReviewedRuntimeBytecode(
        "DeploymentRegistry",
        artifact.deployedBytecode,
        artifact,
        binding,
      ),
    ).not.toThrow();

    const immutableChanged = replaceByte(artifact.deployedBytecode, 356, 0x7f);
    expect(() =>
      verifyReviewedRuntimeBytecode("DeploymentRegistry", immutableChanged, artifact, binding),
    ).not.toThrow();

    const executableCodeChanged = replaceByte(artifact.deployedBytecode, 0, 0x7f);
    expect(() =>
      verifyReviewedRuntimeBytecode("DeploymentRegistry", executableCodeChanged, artifact, binding),
    ).toThrow(/does not match the reviewed artifact/u);
  });

  it("rejects altered creation bytecode before deployment-data comparison", async () => {
    const { artifact, buildInfoOutput, buildInfoOutputBytes, manifestContract } =
      await reviewedDeploymentArtifact();
    const alteredArtifact = structuredClone(artifact);
    alteredArtifact.bytecode = replaceByte(alteredArtifact.bytecode, 0, 0x7f);

    expect(() =>
      verifyReviewedArtifactBinding(
        "DeploymentRegistry",
        alteredArtifact,
        manifestContract,
        buildInfoOutputBytes,
        buildInfoOutput,
      ),
    ).toThrow(/creation-bytecode digest mismatch/u);
  });

  it("rejects widened immutable ranges in a locally altered artifact", async () => {
    const { artifact, buildInfoOutput, buildInfoOutputBytes, manifestContract } =
      await reviewedDeploymentArtifact();
    const alteredArtifact = structuredClone(artifact);
    alteredArtifact.immutableReferences["forged-range"] = [{ start: 0, length: 32 }];

    expect(() =>
      verifyReviewedArtifactBinding(
        "DeploymentRegistry",
        alteredArtifact,
        manifestContract,
        buildInfoOutputBytes,
        buildInfoOutput,
      ),
    ).toThrow(/immutable-reference metadata mismatch/u);
  });
});

async function reviewedDeploymentArtifact(): Promise<{
  artifact: ReviewedSolidityArtifact;
  binding: ReturnType<typeof verifyReviewedArtifactBinding>;
  buildInfoOutput: SolidityBuildInfoOutput;
  buildInfoOutputBytes: Buffer;
  manifestContract: SolidityArtifactManifestContract;
}> {
  const artifact = JSON.parse(
    await readFile(
      resolve("artifacts/contracts/DeploymentRegistry.sol/DeploymentRegistry.json"),
      "utf8",
    ),
  ) as ReviewedSolidityArtifact;
  const manifest = JSON.parse(
    await readFile(resolve("contracts/generated/solidity/manifest.json"), "utf8"),
  ) as SolidityArtifactManifest;
  const manifestContract = manifest.contracts.find(
    ({ contractName }) => contractName === "DeploymentRegistry",
  );
  if (manifestContract === undefined) {
    throw new Error("DeploymentRegistry manifest entry is absent");
  }
  const buildInfoOutputBytes = await readFile(
    resolve(`artifacts/build-info/${manifestContract.buildInfoId}.output.json`),
  );
  const buildInfoOutput = JSON.parse(
    buildInfoOutputBytes.toString("utf8"),
  ) as SolidityBuildInfoOutput;
  const binding = verifyReviewedArtifactBinding(
    "DeploymentRegistry",
    artifact,
    manifestContract,
    buildInfoOutputBytes,
    buildInfoOutput,
  );
  return { artifact, binding, buildInfoOutput, buildInfoOutputBytes, manifestContract };
}

async function deploymentFixture(): Promise<{
  deployment: PublicSepoliaDeployment;
  manifestBytes: Buffer;
  manifest: SolidityArtifactManifest;
}> {
  const manifestBytes = await readFile(resolve("contracts/generated/solidity/manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as SolidityArtifactManifest;
  const deployment = JSON.parse(
    await readFile(resolve("contracts/generated/solidity/sepolia-deployment.json"), "utf8"),
  ) as PublicSepoliaDeployment;
  expect(deployment.artifactManifestSha256).toBe(sha256(manifestBytes));
  return { deployment, manifestBytes, manifest };
}

function replaceByte(bytecode: string, index: number, value: number): string {
  const bytes = Buffer.from(bytecode.replace(/^0x/u, ""), "hex");
  if (index >= bytes.length) throw new Error("Test mutation is outside bytecode");
  bytes[index] = value;
  return `0x${bytes.toString("hex")}`;
}
