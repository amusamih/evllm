import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { format } from "prettier";

const checkOnly = process.argv.includes("--check");
const outputDirectory = resolve("contracts/generated/solidity");
const contracts = [
  "AuthorityProfileRegistry",
  "ProtectedBundleRegistry",
  "BatteryOwnershipRegistry",
  "DeploymentRegistry",
  "EvidenceRegistry",
  "Marketplace",
  "AuditAnchor",
] as const;

type Artifact = {
  abi: unknown[];
  buildInfoId: string;
  bytecode: string;
  deployedBytecode: string;
  inputSourceName: string;
  sourceName: string;
};

type BuildInfo = {
  compilerType: string;
  input: { settings: { evmVersion?: string; optimizer?: unknown; viaIR?: boolean } };
  solcLongVersion: string;
  solcVersion: string;
  toolVersions: Record<string, string>;
};

function bytecodeDigest(bytecode: string): string {
  const bytes = Buffer.from(bytecode.replace(/^0x/u, ""), "hex");
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

const documents: Record<string, unknown> = {};
const manifestContracts = [];
const buildInfoCache = new Map<
  string,
  { document: BuildInfo; inputSha256: string; outputSha256: string }
>();
for (const contractName of contracts) {
  const artifactPath = resolve(
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`,
  );
  const artifact = JSON.parse(await readFile(artifactPath, "utf8")) as Artifact;
  let buildInfo = buildInfoCache.get(artifact.buildInfoId);
  if (buildInfo === undefined) {
    const inputBytes = await readFile(
      resolve("artifacts", "build-info", `${artifact.buildInfoId}.json`),
    );
    const outputBytes = await readFile(
      resolve("artifacts", "build-info", `${artifact.buildInfoId}.output.json`),
    );
    buildInfo = {
      document: JSON.parse(inputBytes.toString("utf8")) as BuildInfo,
      inputSha256: `0x${createHash("sha256").update(inputBytes).digest("hex")}`,
      outputSha256: `0x${createHash("sha256").update(outputBytes).digest("hex")}`,
    };
    buildInfoCache.set(artifact.buildInfoId, buildInfo);
  }
  documents[`abi/${contractName}.json`] = artifact.abi;
  manifestContracts.push({
    contractName,
    sourceName: artifact.sourceName,
    abi: `abi/${contractName}.json`,
    creationBytecodeSha256: bytecodeDigest(artifact.bytecode),
    deployedBytecodeSha256: bytecodeDigest(artifact.deployedBytecode),
    buildInfoId: artifact.buildInfoId,
    buildInfoInputSha256: buildInfo.inputSha256,
    buildInfoOutputSha256: buildInfo.outputSha256,
    stableSharedBoundary: !["EvidenceRegistry", "Marketplace", "AuditAnchor"].includes(
      contractName,
    ),
    proxy: false,
  });
}

documents["manifest.json"] = {
  schema: "EVLLM_SOLIDITY_ARTIFACT_MANIFEST_V1",
  compiler: "solc-0.8.36",
  compilerLongVersion: [...buildInfoCache.values()][0]?.document.solcLongVersion,
  compilerType: [...buildInfoCache.values()][0]?.document.compilerType,
  preferWasm: true,
  evmVersion: "cancun",
  viaIR: false,
  optimizer: { enabled: true, runs: 200 },
  toolchain: {
    hardhat: "3.12.0",
    hardhatEthers: "4.0.15",
    hardhatIgnition: "3.1.8",
    hardhatIgnitionEthers: "3.1.6",
    hardhatVerify: "3.0.22",
    ethers: "6.17.0",
    openZeppelin: "5.6.1",
    forgeStdCommit: "bf647bd6046f2f7da30d0c2bf435e5c76a780c1b",
    slitherImage:
      "ghcr.io/crytic/slither:0.11.6@sha256:89d4127ec3bfeba9725a863c58dd96b01781ff73737871dd3b07606ebc4cf16b",
  },
  networks: {
    local: { chainId: 31337, initialDate: "2026-08-11T00:00:00.000Z" },
    sepolia: { chainId: 11155111 },
  },
  deploymentOrder: contracts,
  constructorBindings: {
    AuthorityProfileRegistry: ["governance"],
    ProtectedBundleRegistry: ["AuthorityProfileRegistry"],
    BatteryOwnershipRegistry: ["governance"],
    DeploymentRegistry: [
      "governance",
      "AuthorityProfileRegistry",
      "ProtectedBundleRegistry",
      "BatteryOwnershipRegistry",
      "reviewDelaySeconds",
    ],
    EvidenceRegistry: ["AuthorityProfileRegistry", "ProtectedBundleRegistry"],
    Marketplace: [
      "AuthorityProfileRegistry",
      "ProtectedBundleRegistry",
      "BatteryOwnershipRegistry",
      "DeploymentRegistry",
      "acceptanceWindowSeconds",
    ],
    AuditAnchor: ["AuthorityProfileRegistry"],
  },
  contracts: manifestContracts,
};

await mkdir(resolve(outputDirectory, "abi"), { recursive: true });
let drift = false;
for (const [relativePath, document] of Object.entries(documents)) {
  const path = resolve(outputDirectory, relativePath);
  const expected = await format(JSON.stringify(document), {
    endOfLine: "lf",
    parser: "json",
    printWidth: 100,
  });
  if (checkOnly) {
    const actual = await readFile(path, "utf8").catch(() => "");
    if (actual !== expected) {
      drift = true;
      process.stderr.write(`Generated Solidity artifact drift: ${relativePath}\n`);
    }
  } else {
    await writeFile(path, expected, "utf8");
  }
}

if (drift) process.exitCode = 1;
