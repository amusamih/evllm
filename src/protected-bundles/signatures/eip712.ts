import { createHash } from "node:crypto";

import {
  TypedDataEncoder,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";

import {
  canonicalAddress,
  domainManifestAttestation,
  eip712Profiles,
  finalizeProtectedBundle,
  keyMaterialAcknowledgementMessage,
  keyOperationAuthorizationMessage,
  positiveSafeInteger,
  replicateProtectedBundle,
} from "../../schemas/index.js";

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type ProtectedSignatureType = keyof typeof eip712Profiles;

export interface ProofDomain {
  readonly chainId: number;
  readonly name: string;
  readonly verifyingContract: string;
  readonly version: "1";
}

export interface CredentialAcceptance {
  readonly active: boolean;
  readonly validFrom: number;
  readonly validUntil?: number;
}

export interface VerifyProofInput {
  readonly credentialAt: (credentialId: string, time: number) => CredentialAcceptance;
  readonly domain: ProofDomain;
  readonly expectedSignerAddress: string;
  readonly maxLifetimeSeconds: number;
  readonly message: unknown;
  readonly mode:
    | { readonly kind: "execution"; readonly currentTime: number; readonly nonceStore: NonceStore }
    | { readonly kind: "external-execution"; readonly currentTime: number }
    | { readonly kind: "validation"; readonly currentTime: number }
    | { readonly acceptanceTime: number; readonly kind: "historical" };
  readonly signature: string;
  readonly type: ProtectedSignatureType;
}

export interface VerifiedProof {
  readonly recoveredAddress: string;
  readonly signatureDigest: string;
  readonly typedDataDigest: string;
}

export class SignatureVerificationError extends Error {
  public constructor(
    public readonly code: "authority" | "domain" | "expiry" | "replay" | "signature",
  ) {
    super("Signed proof is invalid");
    this.name = "SignatureVerificationError";
  }
}

export class NonceStore {
  readonly #consumed = new Set<string>();

  public consume(scope: string): void {
    if (this.#consumed.has(scope)) throw new SignatureVerificationError("replay");
    this.#consumed.add(scope);
  }

  public rollback(scope: string): void {
    this.#consumed.delete(scope);
  }

  public has(scope: string): boolean {
    return this.#consumed.has(scope);
  }
}

export function verifyProtectedProof(input: VerifyProofInput): VerifiedProof {
  const profile = eip712Profiles[input.type];
  if (input.domain.name !== profile.domainName || input.domain.version !== profile.domainVersion) {
    throw new SignatureVerificationError("domain");
  }
  const verifyingContract = canonicalAddress.parse(input.domain.verifyingContract);
  positiveSafeInteger.parse(input.domain.chainId);
  const expectedAddress = canonicalAddress.parse(input.expectedSignerAddress);
  const message = parseMessage(input.type, input.message);
  const issuedAt = readSafeInteger(message, "issuedAt");
  const expiresAt = readSafeInteger(message, "expiresAt");
  if (
    issuedAt >= expiresAt ||
    expiresAt - issuedAt > input.maxLifetimeSeconds ||
    input.maxLifetimeSeconds <= 0
  ) {
    throw new SignatureVerificationError("expiry");
  }
  const evaluationTime =
    input.mode.kind === "historical" ? input.mode.acceptanceTime : input.mode.currentTime;
  const expired =
    input.type === "KeyOperationAuthorization" || input.type === "KeyMaterialAcknowledgement"
      ? evaluationTime >= expiresAt
      : evaluationTime > expiresAt;
  if (evaluationTime < issuedAt || expired) {
    throw new SignatureVerificationError("expiry");
  }
  const credentialId = readString(message, credentialField(input.type));
  const credential = input.credentialAt(credentialId, evaluationTime);
  if (
    !credential.active ||
    evaluationTime < credential.validFrom ||
    (credential.validUntil !== undefined && evaluationTime > credential.validUntil)
  ) {
    throw new SignatureVerificationError("authority");
  }
  const signature = validateCanonicalSignature(input.signature);
  const domain: TypedDataDomain = {
    chainId: input.domain.chainId,
    name: input.domain.name,
    verifyingContract,
    version: input.domain.version,
  };
  const types: Record<string, TypedDataField[]> = {
    [profile.primaryType]: profile.fields.map((field) => ({ ...field })),
  };
  let recoveredAddress: string;
  try {
    recoveredAddress = verifyTypedData(domain, types, message, signature).toLowerCase();
  } catch {
    throw new SignatureVerificationError("signature");
  }
  if (recoveredAddress !== expectedAddress) throw new SignatureVerificationError("signature");
  if (input.mode.kind === "execution") {
    if (input.mode.currentTime < issuedAt) throw new SignatureVerificationError("expiry");
    input.mode.nonceStore.consume(
      nonceScope(input.type, credentialId, readString(message, "nonce")),
    );
  }
  return {
    recoveredAddress,
    signatureDigest: `0x${createHash("sha256")
      .update(Buffer.from(signature.slice(2), "hex"))
      .digest("hex")}`,
    typedDataDigest: TypedDataEncoder.hash(domain, types, message),
  };
}

export function nonceScope(
  type: ProtectedSignatureType,
  credentialId: string,
  nonce: string,
): string {
  return `${type}:${credentialId}:${nonce}`;
}

function parseMessage(type: ProtectedSignatureType, value: unknown): Record<string, unknown> {
  switch (type) {
    case "DomainManifestAttestation":
      return domainManifestAttestation.parse(value);
    case "FinalizeProtectedBundle":
      return finalizeProtectedBundle.parse(value);
    case "ReplicateProtectedBundle":
      return replicateProtectedBundle.parse(value);
    case "KeyOperationAuthorization":
      return keyOperationAuthorizationMessage.parse(value);
    case "KeyMaterialAcknowledgement":
      return keyMaterialAcknowledgementMessage.parse(value);
  }
}

function credentialField(type: ProtectedSignatureType): string {
  switch (type) {
    case "DomainManifestAttestation":
      return "signerCredentialId";
    case "FinalizeProtectedBundle":
    case "ReplicateProtectedBundle":
      return "controllerCredentialId";
    case "KeyOperationAuthorization":
      return "issuerServiceCredentialId";
    case "KeyMaterialAcknowledgement":
      return "signerCredentialId";
  }
}

function validateCanonicalSignature(value: string): string {
  if (!/^0x[0-9a-f]{130}$/.test(value)) throw new SignatureVerificationError("signature");
  const r = BigInt(`0x${value.slice(2, 66)}`);
  const s = BigInt(`0x${value.slice(66, 130)}`);
  const v = Number.parseInt(value.slice(130, 132), 16);
  if (r === 0n || s === 0n || s > SECP256K1_HALF_N || (v !== 27 && v !== 28)) {
    throw new SignatureVerificationError("signature");
  }
  return value;
}

function readSafeInteger(message: Record<string, unknown>, field: string): number {
  return positiveSafeInteger.parse(message[field]);
}

function readString(message: Record<string, unknown>, field: string): string {
  const value = message[field];
  if (typeof value !== "string") throw new SignatureVerificationError("signature");
  return value;
}
