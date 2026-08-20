import { z } from "zod";

import { bytes32Hex, positiveSafeInteger, uint256Hex } from "./common.js";

const commonBundleFields = {
  bundleId: bytes32Hex,
  bundleVersion: positiveSafeInteger,
  bundleType: bytes32Hex,
  domainResourceId: bytes32Hex,
  domainResourceVersion: positiveSafeInteger,
};

const proofWindowFields = {
  nonce: uint256Hex,
  issuedAt: positiveSafeInteger,
  expiresAt: positiveSafeInteger,
};

export const domainManifestAttestation = z
  .object({
    ...commonBundleFields,
    authorBindingProfileId: bytes32Hex,
    authorBindingProfileVersion: positiveSafeInteger,
    domainPayloadCommitment: bytes32Hex,
    signerActorId: bytes32Hex,
    signerOrgId: bytes32Hex,
    signerCredentialId: bytes32Hex,
    ...proofWindowFields,
  })
  .strict();

export const finalizeProtectedBundle = z
  .object({
    commandId: bytes32Hex,
    stagingDescriptorDigest: bytes32Hex,
    domainManifestEnvelopeDigest: bytes32Hex,
    ...commonBundleFields,
    controllerActorId: bytes32Hex,
    controllerOrgId: bytes32Hex,
    controllerCredentialId: bytes32Hex,
    contentCommitment: bytes32Hex,
    contentEnvelopeDigest: bytes32Hex,
    storedEnvelopeLength: positiveSafeInteger,
    contentSchemaBindingDigest: bytes32Hex,
    encryptionProfileId: bytes32Hex,
    encryptionProfileVersion: positiveSafeInteger,
    criticalityProfileId: bytes32Hex,
    criticalityProfileVersion: positiveSafeInteger,
    initialCriticalityClass: bytes32Hex,
    replicaPolicyDigest: bytes32Hex,
    ...proofWindowFields,
    idempotencyKeyHash: bytes32Hex,
  })
  .strict();

export const replicateProtectedBundle = z
  .object({
    commandId: bytes32Hex,
    ...commonBundleFields,
    controllerActorId: bytes32Hex,
    controllerOrgId: bytes32Hex,
    controllerCredentialId: bytes32Hex,
    contentEnvelopeDigest: bytes32Hex,
    storedEnvelopeLength: positiveSafeInteger,
    criticalityProfileId: bytes32Hex,
    criticalityProfileVersion: positiveSafeInteger,
    replicaPolicyDigest: bytes32Hex,
    replicaRepositoryId: bytes32Hex,
    ...proofWindowFields,
    idempotencyKeyHash: bytes32Hex,
  })
  .strict();

export interface Eip712Field {
  readonly name: string;
  readonly type: string;
}

export interface Eip712Profile {
  readonly domainName: string;
  readonly domainVersion: "1";
  readonly primaryType: string;
  readonly fields: readonly Eip712Field[];
}

const bundleFields = [
  { name: "bundleId", type: "bytes32" },
  { name: "bundleVersion", type: "uint64" },
  { name: "bundleType", type: "bytes32" },
  { name: "domainResourceId", type: "bytes32" },
  { name: "domainResourceVersion", type: "uint64" },
] as const;

const proofWindow = [
  { name: "nonce", type: "uint256" },
  { name: "issuedAt", type: "uint64" },
  { name: "expiresAt", type: "uint64" },
] as const;

export const eip712Profiles = {
  DomainManifestAttestation: {
    domainName: "EVLLM Domain Manifest",
    domainVersion: "1",
    primaryType: "DomainManifestAttestation",
    fields: [
      ...bundleFields,
      { name: "authorBindingProfileId", type: "bytes32" },
      { name: "authorBindingProfileVersion", type: "uint64" },
      { name: "domainPayloadCommitment", type: "bytes32" },
      { name: "signerActorId", type: "bytes32" },
      { name: "signerOrgId", type: "bytes32" },
      { name: "signerCredentialId", type: "bytes32" },
      ...proofWindow,
    ],
  },
  FinalizeProtectedBundle: {
    domainName: "EVLLM Protected Bundle Command",
    domainVersion: "1",
    primaryType: "FinalizeProtectedBundle",
    fields: [
      { name: "commandId", type: "bytes32" },
      { name: "stagingDescriptorDigest", type: "bytes32" },
      { name: "domainManifestEnvelopeDigest", type: "bytes32" },
      ...bundleFields,
      { name: "controllerActorId", type: "bytes32" },
      { name: "controllerOrgId", type: "bytes32" },
      { name: "controllerCredentialId", type: "bytes32" },
      { name: "contentCommitment", type: "bytes32" },
      { name: "contentEnvelopeDigest", type: "bytes32" },
      { name: "storedEnvelopeLength", type: "uint64" },
      { name: "contentSchemaBindingDigest", type: "bytes32" },
      { name: "encryptionProfileId", type: "bytes32" },
      { name: "encryptionProfileVersion", type: "uint64" },
      { name: "criticalityProfileId", type: "bytes32" },
      { name: "criticalityProfileVersion", type: "uint64" },
      { name: "initialCriticalityClass", type: "bytes32" },
      { name: "replicaPolicyDigest", type: "bytes32" },
      ...proofWindow,
      { name: "idempotencyKeyHash", type: "bytes32" },
    ],
  },
  ReplicateProtectedBundle: {
    domainName: "EVLLM Protected Bundle Command",
    domainVersion: "1",
    primaryType: "ReplicateProtectedBundle",
    fields: [
      { name: "commandId", type: "bytes32" },
      ...bundleFields,
      { name: "controllerActorId", type: "bytes32" },
      { name: "controllerOrgId", type: "bytes32" },
      { name: "controllerCredentialId", type: "bytes32" },
      { name: "contentEnvelopeDigest", type: "bytes32" },
      { name: "storedEnvelopeLength", type: "uint64" },
      { name: "criticalityProfileId", type: "bytes32" },
      { name: "criticalityProfileVersion", type: "uint64" },
      { name: "replicaPolicyDigest", type: "bytes32" },
      { name: "replicaRepositoryId", type: "bytes32" },
      ...proofWindow,
      { name: "idempotencyKeyHash", type: "bytes32" },
    ],
  },
} as const satisfies Record<string, Eip712Profile>;
