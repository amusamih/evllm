import { createHash } from "node:crypto";

export const expectedContractNames = [
  "AuthorityProfileRegistry",
  "ProtectedBundleRegistry",
  "BatteryOwnershipRegistry",
  "DeploymentRegistry",
  "EvidenceRegistry",
  "Marketplace",
  "AuditAnchor",
] as const;

export type ExpectedContractName = (typeof expectedContractNames)[number];

export const expectedModuleTypes = {
  audit: "0x6175646974000000000000000000000000000000000000000000000000000000",
  evidence: "0x65766964656e6365000000000000000000000000000000000000000000000000",
  marketplace: "0x6d61726b6574706c616365000000000000000000000000000000000000000000",
} as const;

export type DeploymentAddresses = Record<ExpectedContractName, string>;

export interface PublicSepoliaDeployment {
  schema: string;
  chainId: string;
  network: string;
  deployer: string;
  governance: string;
  artifactManifestSha256: string;
  compiler: string;
  evmVersion: string;
  optimizerRuns: number;
  reviewDelaySeconds: number;
  addresses: Record<string, string>;
  deploymentTransactions: Array<{
    contract: string;
    blockNumber: number;
    transactionHash: string;
    gasUsed: string;
  }>;
  configurationTransactions: Array<{
    contract: string;
    function: string;
    blockNumber: number;
    transactionHash: string;
    gasUsed: string;
    transactionFeeWei: string;
  }>;
  activations: Array<{
    module: string;
    blockNumber: number;
    transactionHash: string;
  }>;
}

export interface SolidityArtifactManifest {
  schema: string;
  compiler: string;
  evmVersion: string;
  optimizer: { enabled: boolean; runs: number };
  networks: { sepolia: { chainId: number } };
  deploymentOrder: string[];
  contracts: SolidityArtifactManifestContract[];
}

export interface SolidityArtifactManifestContract {
  contractName: string;
  sourceName: string;
  creationBytecodeSha256: string;
  deployedBytecodeSha256: string;
  buildInfoId: string;
  buildInfoOutputSha256: string;
}

export type ImmutableReferences = Record<string, Array<{ start: number; length: number }>>;

export interface ReviewedSolidityArtifact {
  bytecode: string;
  deployedBytecode: string;
  immutableReferences: ImmutableReferences;
  buildInfoId: string;
  inputSourceName: string;
  sourceName: string;
}

export interface SolidityBuildInfoOutput {
  id: string;
  output: {
    contracts: Record<
      string,
      Record<
        string,
        {
          evm: {
            bytecode: { object: string };
            deployedBytecode: {
              immutableReferences: ImmutableReferences;
              object: string;
            };
          };
        }
      >
    >;
  };
}

export interface ReviewedArtifactBinding {
  creationBytecodeSha256: string;
  deployedBytecodeSha256: string;
  immutableReferences: ImmutableReferences;
}

export interface ExpectedConfigurationCall {
  contract: ExpectedContractName;
  function: "activateModule" | "closeBootstrap" | "proposeModule" | "setMarketplace";
  signer: "deployer" | "governance";
  arguments: readonly (boolean | string)[];
  activationModule?: keyof typeof expectedModuleTypes;
}

export interface RuntimeBytecodeVerification {
  onchainBytecode: string;
  onchainSha256: string;
  reviewedSha256: string;
  normalizedSha256: string;
  sizeBytes: number;
}

export function verifyReviewedArtifactBinding(
  contractName: string,
  artifact: ReviewedSolidityArtifact,
  manifestContract: SolidityArtifactManifestContract,
  buildInfoOutputBytes: Uint8Array,
  buildInfoOutput: SolidityBuildInfoOutput,
): ReviewedArtifactBinding {
  if (manifestContract.contractName !== contractName) {
    throw new Error(`${contractName} artifact-manifest contract mismatch`);
  }
  if (
    artifact.sourceName !== manifestContract.sourceName ||
    artifact.inputSourceName !== `project/${manifestContract.sourceName}`
  ) {
    throw new Error(`${contractName} reviewed source binding mismatch`);
  }
  if (
    artifact.buildInfoId !== manifestContract.buildInfoId ||
    buildInfoOutput.id !== manifestContract.buildInfoId
  ) {
    throw new Error(`${contractName} reviewed build-info binding mismatch`);
  }
  if (sha256(buildInfoOutputBytes) !== manifestContract.buildInfoOutputSha256.toLowerCase()) {
    throw new Error(`${contractName} reviewed build-info output digest mismatch`);
  }

  const compiledContract =
    buildInfoOutput.output.contracts[artifact.inputSourceName]?.[contractName];
  if (compiledContract === undefined) {
    throw new Error(`${contractName} is absent from the bound compiler output`);
  }

  const creationDigest = bytecodeSha256(artifact.bytecode);
  if (creationDigest !== manifestContract.creationBytecodeSha256.toLowerCase()) {
    throw new Error(`${contractName} reviewed creation-bytecode digest mismatch`);
  }
  const deployedDigest = bytecodeSha256(artifact.deployedBytecode);
  if (deployedDigest !== manifestContract.deployedBytecodeSha256.toLowerCase()) {
    throw new Error(`${contractName} reviewed runtime-bytecode digest mismatch`);
  }
  if (
    bytecodeSha256(compiledContract.evm.bytecode.object) !== creationDigest ||
    bytecodeSha256(compiledContract.evm.deployedBytecode.object) !== deployedDigest
  ) {
    throw new Error(`${contractName} local artifact does not match the bound compiler output`);
  }

  const compiledImmutableReferences = compiledContract.evm.deployedBytecode.immutableReferences;
  if (
    canonicalImmutableReferences(artifact.immutableReferences) !==
    canonicalImmutableReferences(compiledImmutableReferences)
  ) {
    throw new Error(`${contractName} immutable-reference metadata mismatch`);
  }

  const runtimeLength = bytecodeBytes(
    artifact.deployedBytecode,
    `${contractName} reviewed runtime bytecode`,
  ).length;
  validateImmutableReferences(compiledImmutableReferences, runtimeLength);

  return {
    creationBytecodeSha256: creationDigest,
    deployedBytecodeSha256: deployedDigest,
    immutableReferences: cloneImmutableReferences(compiledImmutableReferences),
  };
}

export function assertExactDeploymentProfile(
  deployment: PublicSepoliaDeployment,
  artifactManifestBytes: Uint8Array,
  artifactManifest: SolidityArtifactManifest,
): asserts deployment is PublicSepoliaDeployment & { addresses: DeploymentAddresses } {
  if (deployment.schema !== "EVLLM_PUBLIC_SEPOLIA_DEPLOYMENT_V1") {
    throw new Error("Unexpected public Sepolia deployment schema");
  }
  if (deployment.chainId !== "11155111" || deployment.network !== "sepolia") {
    throw new Error("Public deployment is not the reviewed Sepolia profile");
  }
  if (artifactManifest.schema !== "EVLLM_SOLIDITY_ARTIFACT_MANIFEST_V1") {
    throw new Error("Unexpected Solidity artifact manifest schema");
  }
  if (artifactManifest.networks.sepolia.chainId !== 11_155_111) {
    throw new Error("Artifact manifest does not bind the Sepolia chain ID");
  }

  const manifestDigest = sha256(artifactManifestBytes);
  if (deployment.artifactManifestSha256.toLowerCase() !== manifestDigest) {
    throw new Error("Public deployment artifact manifest digest mismatch");
  }
  if (
    deployment.compiler !== artifactManifest.compiler ||
    deployment.evmVersion !== artifactManifest.evmVersion ||
    deployment.optimizerRuns !== artifactManifest.optimizer.runs ||
    !artifactManifest.optimizer.enabled
  ) {
    throw new Error("Public deployment compiler profile does not match the reviewed artifacts");
  }
  if (deployment.reviewDelaySeconds !== 60) {
    throw new Error("Unexpected Sepolia review delay in public deployment manifest");
  }

  assertExactSet(Object.keys(deployment.addresses), expectedContractNames, "deployed addresses");
  assertExactSequence(
    artifactManifest.deploymentOrder,
    expectedContractNames,
    "artifact deployment order",
  );
  assertExactSequence(
    artifactManifest.contracts.map(({ contractName }) => contractName),
    expectedContractNames,
    "artifact contracts",
  );
  assertExactSequence(
    deployment.deploymentTransactions.map(({ contract }) => contract),
    expectedContractNames,
    "deployment transactions",
  );

  const expectedCalls = expectedConfigurationCalls(deployment.addresses as DeploymentAddresses);
  assertExactSequence(
    deployment.configurationTransactions.map(
      ({ contract, function: functionName }) => `${contract}.${functionName}`,
    ),
    expectedCalls.map(({ contract, function: functionName }) => `${contract}.${functionName}`),
    "configuration transactions",
  );
  assertExactSequence(
    deployment.activations.map(({ module }) => module),
    ["evidence", "marketplace", "audit"],
    "module activations",
  );

  assertUnique(
    deployment.deploymentTransactions.map(({ transactionHash }) => transactionHash.toLowerCase()),
    "deployment transaction hashes",
  );
  assertUnique(
    deployment.configurationTransactions.map(({ transactionHash }) =>
      transactionHash.toLowerCase(),
    ),
    "configuration transaction hashes",
  );

  for (const activation of deployment.activations) {
    const call = expectedCalls.find(
      ({ activationModule }) => activationModule === activation.module,
    );
    if (call === undefined) throw new Error(`Unexpected activation ${activation.module}`);
    const callIndex = expectedCalls.indexOf(call);
    const transaction = deployment.configurationTransactions[callIndex];
    if (
      transaction === undefined ||
      transaction.transactionHash.toLowerCase() !== activation.transactionHash.toLowerCase() ||
      transaction.blockNumber !== activation.blockNumber
    ) {
      throw new Error(`${activation.module} activation does not match its configuration call`);
    }
  }
}

export function expectedConfigurationCalls(
  addresses: DeploymentAddresses,
): readonly ExpectedConfigurationCall[] {
  return [
    {
      contract: "ProtectedBundleRegistry",
      function: "closeBootstrap",
      signer: "deployer",
      arguments: [],
    },
    {
      contract: "DeploymentRegistry",
      function: "proposeModule",
      signer: "governance",
      arguments: [expectedModuleTypes.audit, addresses.AuditAnchor],
    },
    {
      contract: "DeploymentRegistry",
      function: "proposeModule",
      signer: "governance",
      arguments: [expectedModuleTypes.evidence, addresses.EvidenceRegistry],
    },
    {
      contract: "BatteryOwnershipRegistry",
      function: "setMarketplace",
      signer: "governance",
      arguments: [addresses.Marketplace, true],
    },
    {
      contract: "DeploymentRegistry",
      function: "proposeModule",
      signer: "governance",
      arguments: [expectedModuleTypes.marketplace, addresses.Marketplace],
    },
    {
      contract: "DeploymentRegistry",
      function: "activateModule",
      signer: "governance",
      arguments: [expectedModuleTypes.evidence],
      activationModule: "evidence",
    },
    {
      contract: "DeploymentRegistry",
      function: "activateModule",
      signer: "governance",
      arguments: [expectedModuleTypes.marketplace],
      activationModule: "marketplace",
    },
    {
      contract: "DeploymentRegistry",
      function: "activateModule",
      signer: "governance",
      arguments: [expectedModuleTypes.audit],
      activationModule: "audit",
    },
  ];
}

export function expectedConstructorArguments(
  contractName: ExpectedContractName,
  addresses: DeploymentAddresses,
  governance: string,
): readonly unknown[] {
  switch (contractName) {
    case "AuthorityProfileRegistry":
      return [governance];
    case "ProtectedBundleRegistry":
      return [addresses.AuthorityProfileRegistry];
    case "BatteryOwnershipRegistry":
      return [governance];
    case "DeploymentRegistry":
      return [
        governance,
        addresses.AuthorityProfileRegistry,
        addresses.ProtectedBundleRegistry,
        addresses.BatteryOwnershipRegistry,
        60,
      ];
    case "EvidenceRegistry":
      return [addresses.AuthorityProfileRegistry, addresses.ProtectedBundleRegistry];
    case "Marketplace":
      return [
        addresses.AuthorityProfileRegistry,
        addresses.ProtectedBundleRegistry,
        addresses.BatteryOwnershipRegistry,
        addresses.DeploymentRegistry,
        86_400,
      ];
    case "AuditAnchor":
      return [addresses.AuthorityProfileRegistry];
  }
}

export function assertDecodedConfigurationCall(
  expected: ExpectedConfigurationCall,
  functionName: string,
  decodedArguments: readonly unknown[],
): void {
  if (functionName !== expected.function) {
    throw new Error(`${expected.contract}.${expected.function} transaction data mismatch`);
  }
  if (decodedArguments.length !== expected.arguments.length) {
    throw new Error(`${expected.contract}.${expected.function} argument count mismatch`);
  }
  for (const [index, expectedArgument] of expected.arguments.entries()) {
    const actualArgument = decodedArguments[index];
    if (!sameDecodedValue(actualArgument, expectedArgument)) {
      throw new Error(`${expected.contract}.${expected.function} argument ${index + 1} mismatch`);
    }
  }
}

export function verifyReviewedRuntimeBytecode(
  contractName: string,
  onchainBytecode: string,
  artifact: ReviewedSolidityArtifact,
  binding: ReviewedArtifactBinding,
): RuntimeBytecodeVerification {
  const reviewedDigest = bytecodeSha256(artifact.deployedBytecode);
  if (reviewedDigest !== binding.deployedBytecodeSha256.toLowerCase()) {
    throw new Error(`${contractName} reviewed runtime-bytecode digest mismatch`);
  }

  const actualBytes = bytecodeBytes(onchainBytecode, `${contractName} on-chain runtime bytecode`);
  const reviewedBytes = bytecodeBytes(
    artifact.deployedBytecode,
    `${contractName} reviewed runtime bytecode`,
  );
  if (actualBytes.length === 0) throw new Error(`${contractName} has no deployed runtime bytecode`);
  if (actualBytes.length !== reviewedBytes.length) {
    throw new Error(`${contractName} runtime-bytecode length mismatch`);
  }

  const normalizedActual = normalizeImmutableReferences(actualBytes, binding.immutableReferences);
  const normalizedReviewed = normalizeImmutableReferences(
    reviewedBytes,
    binding.immutableReferences,
  );
  if (!normalizedActual.equals(normalizedReviewed)) {
    throw new Error(
      `${contractName} on-chain runtime bytecode does not match the reviewed artifact`,
    );
  }

  return {
    onchainBytecode: `0x${actualBytes.toString("hex")}`,
    onchainSha256: sha256(actualBytes),
    reviewedSha256: reviewedDigest,
    normalizedSha256: sha256(normalizedActual),
    sizeBytes: actualBytes.length,
  };
}

export function bytecodeSha256(bytecode: string): string {
  return sha256(bytecodeBytes(bytecode, "bytecode"));
}

export function sha256(bytes: Uint8Array): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizeImmutableReferences(
  source: Buffer,
  immutableReferences: ImmutableReferences,
): Buffer {
  validateImmutableReferences(immutableReferences, source.length);
  const normalized = Buffer.from(source);
  for (const references of Object.values(immutableReferences)) {
    for (const { start, length } of references) {
      const end = start + length;
      normalized.fill(0, start, end);
    }
  }
  return normalized;
}

function validateImmutableReferences(
  immutableReferences: ImmutableReferences,
  bytecodeLength: number,
): void {
  const ranges = Object.values(immutableReferences)
    .flat()
    .map(({ start, length }) => ({ start, length, end: start + length }))
    .sort((left, right) => left.start - right.start || left.length - right.length);
  let priorEnd = -1;
  for (const { start, length, end } of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(length) ||
      start < 0 ||
      length < 1 ||
      !Number.isSafeInteger(end)
    ) {
      throw new Error("Invalid immutable-reference range in reviewed artifact");
    }
    if (end > bytecodeLength) {
      throw new Error("Immutable-reference range exceeds reviewed runtime bytecode");
    }
    if (start < priorEnd) {
      throw new Error("Overlapping immutable-reference ranges in reviewed artifact");
    }
    priorEnd = end;
  }
}

function canonicalImmutableReferences(immutableReferences: ImmutableReferences): string {
  return JSON.stringify(
    Object.entries(immutableReferences)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([identifier, ranges]) => [
        identifier,
        [...ranges].sort((left, right) => left.start - right.start || left.length - right.length),
      ]),
  );
}

function cloneImmutableReferences(immutableReferences: ImmutableReferences): ImmutableReferences {
  return Object.fromEntries(
    Object.entries(immutableReferences).map(([identifier, ranges]) => [
      identifier,
      ranges.map(({ start, length }) => ({ start, length })),
    ]),
  );
}

function bytecodeBytes(bytecode: string, label: string): Buffer {
  const hexadecimal = bytecode.replace(/^0x/u, "");
  if (hexadecimal.length % 2 !== 0 || !/^[0-9a-f]*$/iu.test(hexadecimal)) {
    throw new Error(`${label} is not valid hexadecimal bytecode`);
  }
  return Buffer.from(hexadecimal, "hex");
}

function sameDecodedValue(actual: unknown, expected: boolean | string): boolean {
  if (typeof expected === "boolean") return actual === expected;
  return typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
}

function assertExactSequence(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`Unexpected ${label}; expected exactly ${expected.join(", ")}`);
  }
}

function assertExactSet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assertUnique(actual, label);
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assertExactSequence(actualSorted, expectedSorted, label);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`);
}
