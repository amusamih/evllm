import { createHash, type KeyObject, randomBytes, randomUUID } from "node:crypto";

import { keccak256, toUtf8Bytes } from "ethers";

import {
  type dekWrapContext,
  evidenceClaimPayload,
  evidenceManifest,
  type digest,
  keyOperationAuthorization,
  type protectedContentAad,
} from "../schemas/index.js";
import {
  canonicalJsonBytes,
  openProtectedContent,
  protectContent,
  type RsaKeyPossessionProof,
  rsaPublicKeySpkiSha256,
  unwrapDek,
  verifyWrappedDekEnvelope,
  verifyRsaKeyPossessionProof,
  withZeroizedBytes,
  wrapDek,
} from "../protected-bundles/crypto/index.js";
import { KeyLifecycleRegistry } from "../protected-bundles/keys/index.js";
import {
  ProtectedObjectCoordinator,
  type PromotionResult,
} from "../protected-bundles/repository/index.js";
import {
  NonceStore,
  nonceScope,
  verifyProtectedProof,
  type CredentialAcceptance,
  type ProofDomain,
  type ProtectedSignatureType,
} from "../protected-bundles/signatures/index.js";
import type { OpaqueObjectStore } from "../protected-bundles/storage/index.js";
import type {
  KeyOperationAuthorizationRecord,
  KeyOperationAuthorizationRepository,
} from "./key-operation-authorization-repository.js";

type Digest = ReturnType<typeof digest.parse>;
type ContentAad = ReturnType<typeof protectedContentAad.parse>;
type DekWrapContext = ReturnType<typeof dekWrapContext.parse>;

export interface ServicePrincipal {
  readonly actorId: string;
  readonly credentialId: string;
  readonly organizationId: string;
}

export interface KeyOperationAuthorizationClaims {
  readonly authorizationId: string;
  readonly authorizationVersion: number;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly purposeId: string;
  readonly requester: ServicePrincipal;
}

export interface KeyOperationAuthorizationWindow {
  readonly expiresAt: number;
  readonly idempotencyKeyHash: string;
  readonly issuedAt: number;
  readonly nonce: string;
}

export interface SignedKeyOperationAuthorization {
  readonly claims: KeyOperationAuthorizationClaims;
  readonly proof: SignedProof;
}

export interface KeyMaterialAcknowledgementWindow {
  readonly acknowledgementId: string;
  readonly acknowledgementVersion: number;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly nonce: string;
}

export interface SignedKeyMaterialAcknowledgement {
  readonly acknowledgementId: string;
  readonly acknowledgementVersion: number;
  readonly keyPossessionProof: RsaKeyPossessionProof;
  readonly proof: SignedProof;
  readonly signer: ServicePrincipal;
}

interface GrantEnvelopeTarget {
  readonly bundleId: string;
  readonly currentTime: number;
  readonly effectiveAt: number;
  readonly expiresAt: number;
  readonly grantId: string;
  readonly operation: "create-grant-envelope";
  readonly purpose: string;
  readonly recipientEnvelopeId: string;
  readonly recipientKeyId: string;
  readonly recipientKid: string;
  readonly recipientOrganizationId: string;
  readonly recipientPublicKeySpkiSha256: Digest;
}

interface ControllerEnvelopeRotationTarget {
  readonly bundleId: string;
  readonly currentTime: number;
  readonly operation: "rotate-controller-envelope";
  readonly predecessorAuthorizationId: string;
  readonly successorAuthorizationId: string;
  readonly successorEnvelopeId: string;
  readonly successorKeyId: string;
  readonly successorKid: string;
  readonly successorPublicKeySpkiSha256: Digest;
}

export type KeyMaterialAcknowledgementTarget =
  ControllerEnvelopeRotationTarget | GrantEnvelopeTarget;

export type KeyOperationAuthorizationTarget =
  | {
      readonly bundleId: string;
      readonly finalization: SignedProof;
      readonly operation: "verify-and-finalize-staging";
    }
  | {
      readonly bundleId: string;
      readonly currentTime: number;
      readonly operation: "rotate-controller-envelope";
      readonly predecessorAuthorizationId: string;
      readonly successorAuthorizationId: string;
      readonly successorEnvelopeId: string;
      readonly successorKeyId: string;
      readonly successorKid: string;
      readonly successorPublicKeySpkiSha256: Digest;
    }
  | {
      readonly bundleId: string;
      readonly currentTime: number;
      readonly effectiveAt: number;
      readonly expiresAt: number;
      readonly grantId: string;
      readonly operation: "create-grant-envelope";
      readonly purpose: string;
      readonly recipientEnvelopeId: string;
      readonly recipientKeyId: string;
      readonly recipientKid: string;
      readonly recipientOrganizationId: string;
      readonly recipientPublicKeySpkiSha256: Digest;
    }
  | {
      readonly bundleId: string;
      readonly currentTime: number;
      readonly grantId: string;
      readonly operation: "decrypt-with-grant";
      readonly recipientEnvelopeId: string;
    };

export interface EvidenceBundleServiceConfig {
  readonly chainId: number;
  readonly controllerRepositoryId: string;
  readonly credentialAt: (credentialId: string, time: number) => CredentialAcceptance;
  /** Trusted repository-scoped signer; never inferred from the custody-controller identity. */
  readonly keyOperationAuthorizer: ServicePrincipal & { readonly address: string };
  readonly keyOperationAuthorizationRepository: KeyOperationAuthorizationRepository;
  /** Resolves an acknowledgement credential through the trusted identity registry. */
  readonly keyMaterialAcknowledgementCredentialAt: (
    signer: ServicePrincipal,
    time: number,
  ) => CredentialAcceptance & { readonly address: string };
  readonly maxProofLifetimeSeconds: number;
  readonly primaryStore: OpaqueObjectStore;
  readonly protectedBundleRegistryAddress: string;
  readonly replicaRepositoryId: string;
  readonly replicaStore: OpaqueObjectStore;
}

export interface PrepareEvidenceInput {
  readonly authorBindingProfileId: string;
  readonly authorBindingProfileVersion: number;
  readonly content: Uint8Array;
  readonly contentMediaType: string;
  readonly controllerActorId: string;
  readonly controllerAuthorizationId: string;
  readonly controllerCredentialId: string;
  readonly controllerEncryptionKeyId: string;
  readonly controllerKid: string;
  readonly controllerOrganizationId: string;
  readonly controllerPublicKey: KeyObject;
  readonly evidencePayload: unknown;
  readonly idempotencyKey: Uint8Array;
  readonly initialCriticality: "decision-critical" | "supplementary";
  readonly intendedAuthorActorId: string;
  readonly intendedAuthorCredentialId: string;
  readonly intendedAuthorOrganizationId: string;
}

export interface PreparedEvidence {
  readonly bundleId: string;
  readonly bundleVersion: 1;
  readonly contentCommitment: Digest;
  readonly contentEnvelopeDigest: Digest;
  readonly controllerEnvelope: Uint8Array;
  readonly controllerEnvelopeId: string;
  readonly descriptorDigest: string;
  readonly domainPayload: Uint8Array;
  readonly domainPayloadCommitment: Digest;
  readonly finalObjectId: string;
  readonly stagingId: string;
  readonly stagingObjectId: string;
  readonly storedEnvelopeLength: number;
}

export interface SignedProof {
  readonly message: Record<string, unknown>;
  readonly signature: string;
}

interface PreparedInternal extends PreparedEvidence {
  readonly aad: ContentAad;
  readonly authorBindingProfileId: string;
  readonly authorBindingProfileVersion: number;
  controllerAuthorizationId: string;
  readonly controllerActorId: string;
  readonly controllerCredentialId: string;
  controllerEncryptionKeyId: string;
  controllerKid: string;
  controllerPublicKeySpkiSha256: Digest;
  readonly controllerOrganizationId: string;
  readonly envelopeDigestBase64Url: string;
  readonly idempotencyFingerprint: string;
  readonly initialCriticality: "decision-critical" | "supplementary";
  readonly intendedAuthorActorId: string;
  readonly intendedAuthorCredentialId: string;
  readonly intendedAuthorOrganizationId: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly signatureRecordId: string;
  wrapContext: DekWrapContext;
  controllerEnvelope: Uint8Array;
  controllerEnvelopeId: string;
  finalized: boolean;
  critical: boolean;
  replicaObjectId?: string;
}

interface RecipientEnvelopeRecord {
  readonly bytes: Uint8Array;
  readonly commitment: Digest;
  readonly context: DekWrapContext;
  readonly grantId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly purpose: string;
  readonly purposeId: string;
  readonly recipientKeyId: string;
  readonly recipientKid: string;
  readonly recipientOrganizationId: string;
  readonly recipientPublicKeySpkiSha256: Digest;
}

interface PendingNonceConsumption {
  readonly scope: string;
  readonly store: NonceStore;
}

interface PreparedKeyOperationAuthorization {
  readonly nonceScope: string;
  readonly record: KeyOperationAuthorizationRecord;
}

export interface FinalizedEvidenceBundleRecord {
  readonly attestation: SignedProof;
  readonly bundleId: string;
  readonly contentCommitment: Digest;
  readonly contentEnvelopeDigest: Digest;
  readonly domainPayloadCommitment: Digest;
  readonly finalization: SignedProof;
  readonly finalizedAt: number;
  readonly primaryObjectId: string;
  readonly replicaObjectId?: string;
  readonly storedEnvelopeLength: number;
}

export class EvidenceBundleServiceError extends Error {
  public constructor(
    public readonly code:
      "conflict" | "invalid-proof" | "invalid-state" | "not-found" | "policy-denied",
  ) {
    super("Evidence bundle operation failed");
    this.name = "EvidenceBundleServiceError";
  }
}

export class EvidenceBundleService {
  readonly #byIdempotency = new Map<string, PreparedInternal>();
  readonly #byBundle = new Map<string, PreparedInternal>();
  readonly #controllerNonceStore = new NonceStore();
  readonly #coordinator = new ProtectedObjectCoordinator();
  readonly #domainNonceStore = new NonceStore();
  readonly #finalizedRecords = new Map<string, FinalizedEvidenceBundleRecord>();
  readonly #keyMaterialAcknowledgementNonceStore = new NonceStore();
  readonly #keyLifecycle: KeyLifecycleRegistry;
  readonly #recipientEnvelopes = new Map<string, RecipientEnvelopeRecord>();

  public constructor(
    private readonly config: EvidenceBundleServiceConfig,
    keyLifecycle = new KeyLifecycleRegistry(),
  ) {
    this.#keyLifecycle = keyLifecycle;
  }

  public keyLifecycle(): KeyLifecycleRegistry {
    return this.#keyLifecycle;
  }

  public keyOperationAuthorizationMessage(
    target: KeyOperationAuthorizationTarget,
    claims: KeyOperationAuthorizationClaims,
    window: KeyOperationAuthorizationWindow,
  ): Record<string, unknown> {
    const binding = this.keyOperationBinding(target);
    const sourceAuthorityDigest = digestObject(canonicalJsonBytes(binding.sourceAuthorityIds));
    const operationContextDigest = digestObject(canonicalJsonBytes(binding.operationContext));
    return {
      authorizationId: idHash(claims.authorizationId),
      authorizationVersion: claims.authorizationVersion,
      issuerServiceActorId: idHash(this.config.keyOperationAuthorizer.actorId),
      issuerServiceOrgId: idHash(this.config.keyOperationAuthorizer.organizationId),
      issuerServiceCredentialId: idHash(this.config.keyOperationAuthorizer.credentialId),
      issuerServiceAddress: this.config.keyOperationAuthorizer.address,
      repositoryId: idHash(this.config.controllerRepositoryId),
      operation: keyOperationHash(binding.operation),
      requestingActorId: idHash(claims.requester.actorId),
      requestingOrgId: idHash(claims.requester.organizationId),
      requestingCredentialId: idHash(claims.requester.credentialId),
      bundleId: idHash(binding.record.bundleId),
      bundleVersion: binding.record.bundleVersion,
      bundleType: bundleTypeHash("evidence"),
      domainResourceId: idHash(binding.record.resourceId),
      domainResourceVersion: binding.record.resourceVersion,
      purposeId: idHash(claims.purposeId),
      policyId: idHash(claims.policyId),
      policyVersion: claims.policyVersion,
      sourceAuthorityDigest: digestHex(sourceAuthorityDigest),
      operationContextDigest: digestHex(operationContextDigest),
      nonce: window.nonce,
      issuedAt: window.issuedAt,
      expiresAt: window.expiresAt,
      idempotencyKeyHash: window.idempotencyKeyHash,
    };
  }

  public keyMaterialAcknowledgementMessage(
    target: KeyMaterialAcknowledgementTarget,
    signer: ServicePrincipal,
    window: KeyMaterialAcknowledgementWindow,
  ): Record<string, unknown> {
    const binding = this.keyOperationBinding(target);
    const operationContextDigest = digestObject(canonicalJsonBytes(binding.operationContext));
    const material = keyMaterialTargetFields(target);
    return {
      acknowledgementId: idHash(window.acknowledgementId),
      acknowledgementVersion: window.acknowledgementVersion,
      signerActorId: idHash(signer.actorId),
      signerOrgId: idHash(signer.organizationId),
      signerCredentialId: idHash(signer.credentialId),
      repositoryId: idHash(this.config.controllerRepositoryId),
      operation: keyOperationHash(binding.operation),
      bundleId: idHash(binding.record.bundleId),
      bundleVersion: binding.record.bundleVersion,
      bundleType: bundleTypeHash("evidence"),
      domainResourceId: idHash(binding.record.resourceId),
      domainResourceVersion: binding.record.resourceVersion,
      authorityId: idHash(material.authorityId),
      envelopeId: idHash(material.envelopeId),
      encryptionKeyId: idHash(material.encryptionKeyId),
      recipientKid: idHash(material.recipientKid),
      publicKeySpkiSha256: digestHex(material.publicKeySpkiSha256),
      operationContextDigest: digestHex(operationContextDigest),
      nonce: window.nonce,
      issuedAt: window.issuedAt,
      expiresAt: window.expiresAt,
    };
  }

  public async consumedKeyOperationAuthorization(
    authorizationId: string,
    authorizationVersion = 1,
  ): Promise<KeyOperationAuthorizationRecord> {
    const record = await this.config.keyOperationAuthorizationRepository.find(
      authorizationId,
      authorizationVersion,
    );
    if (record === undefined) throw new EvidenceBundleServiceError("not-found");
    return record;
  }

  public async prepare(input: PrepareEvidenceInput): Promise<PreparedEvidence> {
    if (input.idempotencyKey.byteLength !== 32) {
      throw new EvidenceBundleServiceError("conflict");
    }
    const payload = evidenceClaimPayload.parse(input.evidencePayload);
    const domainPayload = canonicalJsonBytes(payload);
    const fingerprint = sha256Hex(
      canonicalJsonBytes({
        author_binding_profile_id: input.authorBindingProfileId,
        author_binding_profile_version: input.authorBindingProfileVersion,
        content_sha256: sha256Hex(input.content),
        controller_actor_id: input.controllerActorId,
        controller_authorization_id: input.controllerAuthorizationId,
        controller_encryption_key_id: input.controllerEncryptionKeyId,
        controller_organization_id: input.controllerOrganizationId,
        domain_payload_sha256: sha256Hex(domainPayload),
        initial_criticality: input.initialCriticality,
        intended_author_actor_id: input.intendedAuthorActorId,
        intended_author_credential_id: input.intendedAuthorCredentialId,
        intended_author_organization_id: input.intendedAuthorOrganizationId,
      }),
    );
    const idempotencyHash = sha256Hex(input.idempotencyKey);
    const existing = this.#byIdempotency.get(idempotencyHash);
    if (existing !== undefined) {
      if (existing.idempotencyFingerprint !== fingerprint) {
        throw new EvidenceBundleServiceError("conflict");
      }
      return publicPreparation(existing);
    }

    const bundleId = payload.protected_bundle_ref.bundle_id;
    const resourceId = payload.evidence_id;
    const aadInput = {
      schema: "EVLLM_PROTECTED_CONTENT_AAD_V1" as const,
      bundle_id: bundleId,
      bundle_version: 1,
      bundle_type: "evidence" as const,
      domain_resource_id: resourceId,
      domain_resource_version: payload.evidence_version,
      custody_controller_org_id: input.controllerOrganizationId,
      primary_repository_id: this.config.controllerRepositoryId,
      content_schema_id: payload.protected_bundle_ref.content_schema_id,
      content_schema_version: payload.protected_bundle_ref.content_schema_version,
      access_class: "restricted" as const,
      initial_criticality_class: input.initialCriticality,
      criticality_profile_id: payload.protected_bundle_ref.criticality_profile_id,
      criticality_profile_version: payload.protected_bundle_ref.criticality_profile_version,
    };
    const protectedResult = await protectContent({
      aad: aadInput,
      content: input.content,
      contentMediaType: input.contentMediaType,
      domainPayload,
    });
    const stagingObjectId = opaqueId();
    const finalObjectId = opaqueId();
    const stagingId = urn("staging");
    const controllerEnvelopeId = urn("envelope");
    const wrapContext = {
      schema: "EVLLM_DEK_WRAP_CONTEXT_V1" as const,
      envelope_id: controllerEnvelopeId,
      bundle_id: bundleId,
      bundle_version: 1,
      bundle_type: "evidence" as const,
      domain_resource_id: resourceId,
      domain_resource_version: payload.evidence_version,
      domain_payload_commitment: protectedResult.domainPayloadCommitment,
      content_commitment: protectedResult.contentCommitment,
      content_envelope_digest: protectedResult.contentEnvelopeDigest,
      recipient_org_id: input.controllerOrganizationId,
      recipient_kid: input.controllerKid,
      purpose: "controller-custody" as const,
      authorization_id: input.controllerAuthorizationId,
      scope: "protected-bundle:key-administration" as const,
    };
    const wrapped = await withZeroizedBytes(protectedResult.dek, (dek) =>
      wrapDek({
        context: wrapContext,
        dek,
        publicKey: input.controllerPublicKey,
      }),
    );
    await this.config.primaryStore.putIfAbsent(stagingObjectId, [protectedResult.envelopeBytes]);
    this.#keyLifecycle.stageControllerAuthorization({
      authorizationId: input.controllerAuthorizationId,
      envelopeId: controllerEnvelopeId,
      keyId: input.controllerEncryptionKeyId,
      state: "staged",
    });
    const descriptorDigest = sha256Hex(
      canonicalJsonBytes({
        bundle_id: bundleId,
        content_envelope_digest: protectedResult.contentEnvelopeDigest,
        controller_envelope_commitment: wrapped.commitment,
        final_object_id: finalObjectId,
        staging_id: stagingId,
        staging_object_id: stagingObjectId,
        stored_envelope_length: protectedResult.envelopeBytes.byteLength,
      }),
    );
    const record: PreparedInternal = {
      aad: protectedResult.aad,
      authorBindingProfileId: input.authorBindingProfileId,
      authorBindingProfileVersion: input.authorBindingProfileVersion,
      bundleId,
      bundleVersion: 1,
      contentCommitment: protectedResult.contentCommitment,
      contentEnvelopeDigest: protectedResult.contentEnvelopeDigest,
      controllerAuthorizationId: input.controllerAuthorizationId,
      controllerActorId: input.controllerActorId,
      controllerCredentialId: input.controllerCredentialId,
      controllerEncryptionKeyId: input.controllerEncryptionKeyId,
      controllerEnvelope: wrapped.envelopeBytes,
      controllerEnvelopeId,
      controllerKid: input.controllerKid,
      controllerOrganizationId: input.controllerOrganizationId,
      controllerPublicKeySpkiSha256: rsaPublicKeySpkiSha256(input.controllerPublicKey),
      critical: input.initialCriticality === "decision-critical",
      descriptorDigest,
      domainPayload,
      domainPayloadCommitment: protectedResult.domainPayloadCommitment,
      envelopeDigestBase64Url: protectedResult.contentEnvelopeDigest.value,
      finalObjectId,
      finalized: false,
      idempotencyFingerprint: fingerprint,
      initialCriticality: input.initialCriticality,
      intendedAuthorActorId: input.intendedAuthorActorId,
      intendedAuthorCredentialId: input.intendedAuthorCredentialId,
      intendedAuthorOrganizationId: input.intendedAuthorOrganizationId,
      signatureRecordId: urn("assertion"),
      resourceId,
      resourceVersion: payload.evidence_version,
      stagingId,
      stagingObjectId,
      storedEnvelopeLength: protectedResult.envelopeBytes.byteLength,
      wrapContext,
    };
    this.#byIdempotency.set(idempotencyHash, record);
    this.#byBundle.set(bundleId, record);
    return publicPreparation(record);
  }

  public domainAttestationMessage(
    bundleId: string,
    signer: { actorId: string; credentialId: string; organizationId: string },
    window: { expiresAt: number; issuedAt: number; nonce: string },
  ): Record<string, unknown> {
    const record = this.record(bundleId);
    return {
      bundleId: idHash(record.bundleId),
      bundleVersion: 1,
      bundleType: bundleTypeHash("evidence"),
      domainResourceId: idHash(record.resourceId),
      domainResourceVersion: record.resourceVersion,
      authorBindingProfileId: idHash(record.authorBindingProfileId),
      authorBindingProfileVersion: record.authorBindingProfileVersion,
      domainPayloadCommitment: digestHex(record.domainPayloadCommitment),
      signerActorId: idHash(signer.actorId),
      signerOrgId: idHash(signer.organizationId),
      signerCredentialId: idHash(signer.credentialId),
      nonce: window.nonce,
      issuedAt: window.issuedAt,
      expiresAt: window.expiresAt,
    };
  }

  public finalizationMessage(
    bundleId: string,
    attestation: SignedProof,
    controller: { actorId: string; credentialId: string; organizationId: string },
    window: {
      commandId: string;
      expiresAt: number;
      idempotencyKeyHash: string;
      issuedAt: number;
      nonce: string;
    },
  ): Record<string, unknown> {
    const record = this.record(bundleId);
    return {
      commandId: idHash(window.commandId),
      stagingDescriptorDigest: record.descriptorDigest,
      domainManifestEnvelopeDigest: sha256Hex(
        canonicalJsonBytes({ message: attestation.message, signature: attestation.signature }),
      ),
      bundleId: idHash(record.bundleId),
      bundleVersion: 1,
      bundleType: bundleTypeHash("evidence"),
      domainResourceId: idHash(record.resourceId),
      domainResourceVersion: record.resourceVersion,
      controllerActorId: idHash(controller.actorId),
      controllerOrgId: idHash(controller.organizationId),
      controllerCredentialId: idHash(controller.credentialId),
      contentCommitment: digestHex(record.contentCommitment),
      contentEnvelopeDigest: digestHex(record.contentEnvelopeDigest),
      storedEnvelopeLength: record.storedEnvelopeLength,
      contentSchemaBindingDigest: sha256Hex(
        canonicalJsonBytes({
          id: record.aad.content_schema_id,
          version: record.aad.content_schema_version,
        }),
      ),
      encryptionProfileId: idHash("urn:evllm:profile:00000000-0000-4000-8000-000000000001"),
      encryptionProfileVersion: 1,
      criticalityProfileId: idHash(record.aad.criticality_profile_id),
      criticalityProfileVersion: record.aad.criticality_profile_version,
      initialCriticalityClass: keccak256(
        toUtf8Bytes(`criticality-class:${record.initialCriticality}`),
      ),
      replicaPolicyDigest: sha256Hex(
        canonicalJsonBytes({ repository_id: this.config.replicaRepositoryId, required: true }),
      ),
      nonce: window.nonce,
      issuedAt: window.issuedAt,
      expiresAt: window.expiresAt,
      idempotencyKeyHash: window.idempotencyKeyHash,
    };
  }

  public async finalize(input: {
    readonly attestation: SignedProof;
    readonly authorAddress: string;
    readonly bundleId: string;
    readonly controllerAddress: string;
    readonly controllerPrivateKey: KeyObject;
    readonly finalization: SignedProof;
    readonly keyOperationAuthorization: SignedKeyOperationAuthorization;
    readonly now: number;
  }): Promise<{ readonly primary: PromotionResult; readonly replica?: PromotionResult }> {
    const record = this.record(input.bundleId);
    if (record.finalized) throw new EvidenceBundleServiceError("invalid-state");
    try {
      verifyProtectedProof({
        credentialAt: this.config.credentialAt,
        domain: this.domain("EVLLM Domain Manifest"),
        expectedSignerAddress: input.authorAddress,
        maxLifetimeSeconds: this.config.maxProofLifetimeSeconds,
        message: input.attestation.message,
        mode: { kind: "validation", currentTime: input.now },
        signature: input.attestation.signature,
        type: "DomainManifestAttestation",
      });
      verifyProtectedProof({
        credentialAt: this.config.credentialAt,
        domain: this.domain("EVLLM Protected Bundle Command"),
        expectedSignerAddress: input.controllerAddress,
        maxLifetimeSeconds: this.config.maxProofLifetimeSeconds,
        message: input.finalization.message,
        mode: { kind: "validation", currentTime: input.now },
        signature: input.finalization.signature,
        type: "FinalizeProtectedBundle",
      });
    } catch {
      throw new EvidenceBundleServiceError("invalid-proof");
    }
    const expectedAttestation = this.domainAttestationMessage(
      record.bundleId,
      {
        actorId: record.intendedAuthorActorId,
        credentialId: record.intendedAuthorCredentialId,
        organizationId: record.intendedAuthorOrganizationId,
      },
      {
        expiresAt: numberField(input.attestation.message, "expiresAt"),
        issuedAt: numberField(input.attestation.message, "issuedAt"),
        nonce: stringField(input.attestation.message, "nonce"),
      },
    );
    for (const field of Object.keys(expectedAttestation)) {
      if (input.attestation.message[field] !== expectedAttestation[field]) {
        throw new EvidenceBundleServiceError("invalid-proof");
      }
    }
    const expectedFinalization = this.finalizationMessage(
      record.bundleId,
      input.attestation,
      {
        actorId: record.controllerActorId,
        credentialId: record.controllerCredentialId,
        organizationId: record.controllerOrganizationId,
      },
      {
        commandId: "urn:evllm:command:00000000-0000-4000-8000-000000000000",
        expiresAt: numberField(input.finalization.message, "expiresAt"),
        idempotencyKeyHash: stringField(input.finalization.message, "idempotencyKeyHash"),
        issuedAt: numberField(input.finalization.message, "issuedAt"),
        nonce: stringField(input.finalization.message, "nonce"),
      },
    );
    for (const field of Object.keys(expectedFinalization).filter(
      (field) => field !== "commandId",
    )) {
      if (input.finalization.message[field] !== expectedFinalization[field]) {
        throw new EvidenceBundleServiceError("invalid-proof");
      }
    }
    const keyOperationAuthorization = this.prepareKeyOperationAuthorization(
      {
        bundleId: input.bundleId,
        finalization: input.finalization,
        operation: "verify-and-finalize-staging",
      },
      input.keyOperationAuthorization,
      input.now,
    );
    await this.consumeValidatedProofs(
      [
        pendingNonceConsumption(
          this.#domainNonceStore,
          "DomainManifestAttestation",
          "signerCredentialId",
          input.attestation.message,
        ),
        pendingNonceConsumption(
          this.#controllerNonceStore,
          "FinalizeProtectedBundle",
          "controllerCredentialId",
          input.finalization.message,
        ),
      ],
      keyOperationAuthorization,
    );
    const dek = await unwrapDek(
      record.controllerEnvelope,
      input.controllerPrivateKey,
      record.wrapContext,
    );
    await withZeroizedBytes(dek, async (unwrappedDek) => {
      const stagedBytes = await collect(this.config.primaryStore.get(record.stagingObjectId));
      await openProtectedContent(stagedBytes, unwrappedDek, record.aad, record.contentCommitment);
    });
    const expected = {
      digest: record.envelopeDigestBase64Url,
      length: record.storedEnvelopeLength,
    };
    const primary = await this.#coordinator.promoteStagedObject(this.config.primaryStore, {
      ...expected,
      sourceObjectId: record.stagingObjectId,
      destinationObjectId: record.finalObjectId,
    });
    let replica: PromotionResult | undefined;
    if (record.critical) {
      record.replicaObjectId = opaqueId();
      replica = await this.#coordinator.replicateExact(
        this.config.primaryStore,
        record.finalObjectId,
        this.config.replicaStore,
        record.replicaObjectId,
        expected,
      );
    }
    this.#keyLifecycle.activateControllerAuthorization(record.controllerAuthorizationId);
    record.finalized = true;
    this.#finalizedRecords.set(record.bundleId, {
      attestation: structuredClone(input.attestation),
      bundleId: record.bundleId,
      contentCommitment: record.contentCommitment,
      contentEnvelopeDigest: record.contentEnvelopeDigest,
      domainPayloadCommitment: record.domainPayloadCommitment,
      finalization: structuredClone(input.finalization),
      finalizedAt: input.now,
      primaryObjectId: record.finalObjectId,
      ...(record.replicaObjectId === undefined ? {} : { replicaObjectId: record.replicaObjectId }),
      storedEnvelopeLength: record.storedEnvelopeLength,
    });
    return replica === undefined ? { primary } : { primary, replica };
  }

  public finalizedRecord(bundleId: string): FinalizedEvidenceBundleRecord {
    const record = this.#finalizedRecords.get(bundleId);
    if (record === undefined) throw new EvidenceBundleServiceError("not-found");
    return structuredClone(record);
  }

  public evidenceManifest(
    bundleId: string,
    lifecycle: "active" | "revoked" | "superseded",
  ): ReturnType<typeof evidenceManifest.parse> {
    const record = this.record(bundleId);
    const finalized = this.finalizedRecord(bundleId);
    const payload = evidenceClaimPayload.parse(
      JSON.parse(new TextDecoder().decode(record.domainPayload)),
    );
    return evidenceManifest.parse({
      schema: "EVLLM_EVIDENCE_MANIFEST_V1",
      evidence_id: payload.evidence_id,
      evidence_version: payload.evidence_version,
      evidence_claim_payload_ref: { id: payload.evidence_id, version: payload.evidence_version },
      protected_bundle_ref: payload.protected_bundle_ref,
      claim_id: payload.claim_id,
      subject_id: payload.subject_id,
      issuer_organization_id: payload.issuer_organization_id,
      content_schema_id: payload.protected_bundle_ref.content_schema_id,
      content_schema_version: payload.protected_bundle_ref.content_schema_version,
      method: payload.capture_method,
      source_class: payload.source_class,
      provenance: payload.provenance,
      domain_signature_record_id: record.signatureRecordId,
      signed_domain_envelope_digest: digestObject(canonicalJsonBytes(finalized.attestation)),
      signature_digest: digestObject(Buffer.from(finalized.attestation.signature.slice(2), "hex")),
      lifecycle,
      support_links: [],
    });
  }

  public async rotateControllerEnvelope(input: {
    readonly bundleId: string;
    readonly currentTime: number;
    readonly keyMaterialAcknowledgement: SignedKeyMaterialAcknowledgement;
    readonly keyOperationAuthorization: SignedKeyOperationAuthorization;
    readonly predecessorAuthorizationId: string;
    readonly predecessorPrivateKey: KeyObject;
    readonly successorAuthorizationId: string;
    readonly successorEnvelopeId: string;
    readonly successorKeyId: string;
    readonly successorKid: string;
    readonly successorPublicKey: KeyObject;
  }): Promise<void> {
    const record = this.record(input.bundleId);
    if (
      !record.finalized ||
      record.controllerAuthorizationId !== input.predecessorAuthorizationId
    ) {
      throw new EvidenceBundleServiceError("invalid-state");
    }
    const target: ControllerEnvelopeRotationTarget = {
      bundleId: input.bundleId,
      currentTime: input.currentTime,
      operation: "rotate-controller-envelope",
      predecessorAuthorizationId: input.predecessorAuthorizationId,
      successorAuthorizationId: input.successorAuthorizationId,
      successorEnvelopeId: input.successorEnvelopeId,
      successorKeyId: input.successorKeyId,
      successorKid: input.successorKid,
      successorPublicKeySpkiSha256: rsaPublicKeySpkiSha256(input.successorPublicKey),
    };
    const keyMaterialAcknowledgement = this.verifyKeyMaterialAcknowledgement(
      target,
      input.keyMaterialAcknowledgement,
      input.successorPublicKey,
      input.currentTime,
    );
    const keyOperationAuthorization = this.prepareKeyOperationAuthorization(
      target,
      input.keyOperationAuthorization,
      input.currentTime,
    );
    await this.consumeValidatedProofs([keyMaterialAcknowledgement], keyOperationAuthorization);
    const dek = await unwrapDek(
      record.controllerEnvelope,
      input.predecessorPrivateKey,
      record.wrapContext,
    );
    const successorContext = {
      ...record.wrapContext,
      envelope_id: input.successorEnvelopeId,
      recipient_kid: input.successorKid,
      authorization_id: input.successorAuthorizationId,
    };
    const successor = await withZeroizedBytes(dek, (unwrappedDek) =>
      wrapDek({
        context: successorContext,
        dek: unwrappedDek,
        publicKey: input.successorPublicKey,
      }),
    );
    await this.#keyLifecycle.rotateControllerAuthorization(
      input.predecessorAuthorizationId,
      {
        authorizationId: input.successorAuthorizationId,
        envelopeId: input.successorEnvelopeId,
        keyId: input.successorKeyId,
        state: "staged",
      },
      () =>
        Promise.resolve(
          verifyWrappedDekEnvelope({
            commitment: successor.commitment,
            context: successorContext,
            envelopeBytes: successor.envelopeBytes,
          }),
        ),
    );
    record.controllerAuthorizationId = input.successorAuthorizationId;
    record.controllerEnvelope = successor.envelopeBytes;
    record.controllerEnvelopeId = input.successorEnvelopeId;
    record.controllerEncryptionKeyId = input.successorKeyId;
    record.controllerKid = input.successorKid;
    record.controllerPublicKeySpkiSha256 = target.successorPublicKeySpkiSha256;
    record.wrapContext = successorContext;
  }

  public async grantRecipient(input: {
    readonly bundleId: string;
    readonly controllerPrivateKey: KeyObject;
    readonly currentTime: number;
    readonly effectiveAt: number;
    readonly expiresAt: number;
    readonly grantId: string;
    readonly keyMaterialAcknowledgement: SignedKeyMaterialAcknowledgement;
    readonly keyOperationAuthorization: SignedKeyOperationAuthorization;
    readonly purpose: string;
    readonly recipientEnvelopeId: string;
    readonly recipientKeyId: string;
    readonly recipientKid: string;
    readonly recipientOrganizationId: string;
    readonly recipientPublicKey: KeyObject;
  }): Promise<void> {
    const record = this.record(input.bundleId);
    if (!record.finalized) throw new EvidenceBundleServiceError("invalid-state");
    const target: GrantEnvelopeTarget = {
      bundleId: input.bundleId,
      currentTime: input.currentTime,
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt,
      grantId: input.grantId,
      operation: "create-grant-envelope",
      purpose: input.purpose,
      recipientEnvelopeId: input.recipientEnvelopeId,
      recipientKeyId: input.recipientKeyId,
      recipientKid: input.recipientKid,
      recipientOrganizationId: input.recipientOrganizationId,
      recipientPublicKeySpkiSha256: rsaPublicKeySpkiSha256(input.recipientPublicKey),
    };
    const keyMaterialAcknowledgement = this.verifyKeyMaterialAcknowledgement(
      target,
      input.keyMaterialAcknowledgement,
      input.recipientPublicKey,
      input.currentTime,
    );
    const keyOperationAuthorization = this.prepareKeyOperationAuthorization(
      target,
      input.keyOperationAuthorization,
      input.currentTime,
    );
    await this.consumeValidatedProofs([keyMaterialAcknowledgement], keyOperationAuthorization);
    const dek = await unwrapDek(
      record.controllerEnvelope,
      input.controllerPrivateKey,
      record.wrapContext,
    );
    const context = {
      ...record.wrapContext,
      envelope_id: input.recipientEnvelopeId,
      recipient_org_id: input.recipientOrganizationId,
      recipient_kid: input.recipientKid,
      purpose: input.purpose,
      authorization_id: input.grantId,
      scope: "protected-bundle:decrypt" as const,
    };
    const wrapped = await withZeroizedBytes(dek, (unwrappedDek) =>
      wrapDek({ context, dek: unwrappedDek, publicKey: input.recipientPublicKey }),
    );
    this.#keyLifecycle.prepareGrant({
      effectiveAt: input.effectiveAt,
      envelopeId: input.recipientEnvelopeId,
      expiresAt: input.expiresAt,
      grantId: input.grantId,
      recipientKeyId: input.recipientKeyId,
      state: "prepared",
    });
    this.#recipientEnvelopes.set(input.recipientEnvelopeId, {
      bytes: wrapped.envelopeBytes,
      commitment: wrapped.commitment,
      context,
      grantId: input.grantId,
      policyId: input.keyOperationAuthorization.claims.policyId,
      policyVersion: input.keyOperationAuthorization.claims.policyVersion,
      purpose: input.purpose,
      purposeId: input.keyOperationAuthorization.claims.purposeId,
      recipientKeyId: input.recipientKeyId,
      recipientKid: input.recipientKid,
      recipientOrganizationId: input.recipientOrganizationId,
      recipientPublicKeySpkiSha256: target.recipientPublicKeySpkiSha256,
    });
    await this.#keyLifecycle.activateGrant(input.grantId, input.effectiveAt, () =>
      Promise.resolve(
        verifyWrappedDekEnvelope({
          commitment: wrapped.commitment,
          context,
          envelopeBytes: wrapped.envelopeBytes,
        }),
      ),
    );
  }

  public async retrieveWithGrant(input: {
    readonly bundleId: string;
    readonly currentTime: number;
    readonly grantId: string;
    readonly keyOperationAuthorization: SignedKeyOperationAuthorization;
    readonly recipientEnvelopeId: string;
    readonly recipientPrivateKey: KeyObject;
  }): Promise<{
    readonly content: Uint8Array;
    readonly domainPayload: Uint8Array;
    readonly source: "primary" | "replica";
  }> {
    const record = this.record(input.bundleId);
    this.#keyLifecycle.authorizeRetrieval(input.grantId, input.currentTime);
    const recipient = this.#recipientEnvelopes.get(input.recipientEnvelopeId);
    if (recipient === undefined || recipient.grantId !== input.grantId) {
      throw new EvidenceBundleServiceError("policy-denied");
    }
    const keyOperationAuthorization = this.prepareKeyOperationAuthorization(
      {
        bundleId: input.bundleId,
        currentTime: input.currentTime,
        grantId: input.grantId,
        operation: "decrypt-with-grant",
        recipientEnvelopeId: input.recipientEnvelopeId,
      },
      input.keyOperationAuthorization,
      input.currentTime,
    );
    await this.consumeValidatedProofs([], keyOperationAuthorization);
    const dek = await unwrapDek(recipient.bytes, input.recipientPrivateKey, recipient.context);
    return withZeroizedBytes(dek, async (unwrappedDek) => {
      const failover = {
        digest: record.envelopeDigestBase64Url,
        length: record.storedEnvelopeLength,
        critical: record.critical,
        primary: { objectId: record.finalObjectId, store: this.config.primaryStore },
        ...(record.replicaObjectId === undefined
          ? {}
          : { replica: { objectId: record.replicaObjectId, store: this.config.replicaStore } }),
      };
      const fetched = await this.#coordinator.fetchWithFailover(failover);
      const opened = await openProtectedContent(
        fetched.bytes,
        unwrappedDek,
        record.aad,
        record.contentCommitment,
      );
      return { ...opened, source: fetched.source };
    });
  }

  public async promoteToDecisionCritical(bundleId: string): Promise<PromotionResult> {
    const record = this.record(bundleId);
    if (!record.finalized || record.critical) throw new EvidenceBundleServiceError("invalid-state");
    record.replicaObjectId = opaqueId();
    const result = await this.#coordinator.replicateExact(
      this.config.primaryStore,
      record.finalObjectId,
      this.config.replicaStore,
      record.replicaObjectId,
      { digest: record.envelopeDigestBase64Url, length: record.storedEnvelopeLength },
    );
    record.critical = true;
    return result;
  }

  private verifyKeyMaterialAcknowledgement(
    target: KeyMaterialAcknowledgementTarget,
    acknowledgement: SignedKeyMaterialAcknowledgement | undefined,
    publicKey: KeyObject,
    currentTime: number,
  ): PendingNonceConsumption {
    if (acknowledgement === undefined) throw new EvidenceBundleServiceError("invalid-proof");
    try {
      const expectedOrganizationId =
        target.operation === "create-grant-envelope"
          ? target.recipientOrganizationId
          : this.record(target.bundleId).controllerOrganizationId;
      if (acknowledgement.signer.organizationId !== expectedOrganizationId) {
        throw new EvidenceBundleServiceError("invalid-proof");
      }
      const credential = this.config.keyMaterialAcknowledgementCredentialAt(
        acknowledgement.signer,
        currentTime,
      );
      const expected = this.keyMaterialAcknowledgementMessage(target, acknowledgement.signer, {
        acknowledgementId: acknowledgement.acknowledgementId,
        acknowledgementVersion: acknowledgement.acknowledgementVersion,
        expiresAt: numberField(acknowledgement.proof.message, "expiresAt"),
        issuedAt: numberField(acknowledgement.proof.message, "issuedAt"),
        nonce: stringField(acknowledgement.proof.message, "nonce"),
      });
      if (!canonicalBytesEqual(expected, acknowledgement.proof.message)) {
        throw new EvidenceBundleServiceError("invalid-proof");
      }
      if (
        !verifyRsaKeyPossessionProof(
          publicKey,
          acknowledgement.proof,
          acknowledgement.keyPossessionProof,
        )
      ) {
        throw new EvidenceBundleServiceError("invalid-proof");
      }
      verifyProtectedProof({
        credentialAt: () => credential,
        domain: this.domain("EVLLM Key Material Acknowledgement"),
        expectedSignerAddress: credential.address,
        maxLifetimeSeconds: this.config.maxProofLifetimeSeconds,
        message: acknowledgement.proof.message,
        mode: { currentTime, kind: "validation" },
        signature: acknowledgement.proof.signature,
        type: "KeyMaterialAcknowledgement",
      });
      return pendingNonceConsumption(
        this.#keyMaterialAcknowledgementNonceStore,
        "KeyMaterialAcknowledgement",
        "signerCredentialId",
        acknowledgement.proof.message,
      );
    } catch {
      throw new EvidenceBundleServiceError("invalid-proof");
    }
  }

  private prepareKeyOperationAuthorization(
    target: KeyOperationAuthorizationTarget,
    authorization: SignedKeyOperationAuthorization | undefined,
    currentTime: number,
  ): PreparedKeyOperationAuthorization {
    if (authorization === undefined) throw new EvidenceBundleServiceError("invalid-proof");
    let expected: Record<string, unknown>;
    let binding: ReturnType<EvidenceBundleService["keyOperationBinding"]>;
    try {
      const window = {
        expiresAt: numberField(authorization.proof.message, "expiresAt"),
        idempotencyKeyHash: stringField(authorization.proof.message, "idempotencyKeyHash"),
        issuedAt: numberField(authorization.proof.message, "issuedAt"),
        nonce: stringField(authorization.proof.message, "nonce"),
      };
      this.validateKeyOperationClaims(target, authorization.claims);
      binding = this.keyOperationBinding(target);
      expected = this.keyOperationAuthorizationMessage(target, authorization.claims, window);
      if (!canonicalBytesEqual(expected, authorization.proof.message)) {
        throw new EvidenceBundleServiceError("invalid-proof");
      }
    } catch {
      throw new EvidenceBundleServiceError("invalid-proof");
    }

    let verified: ReturnType<typeof verifyProtectedProof>;
    try {
      verified = verifyProtectedProof({
        credentialAt: this.config.credentialAt,
        domain: this.domain("EVLLM Key Operation Authorization"),
        expectedSignerAddress: this.config.keyOperationAuthorizer.address,
        maxLifetimeSeconds: this.config.maxProofLifetimeSeconds,
        message: authorization.proof.message,
        mode: {
          kind: "external-execution",
          currentTime,
        },
        signature: authorization.proof.signature,
        type: "KeyOperationAuthorization",
      });
    } catch {
      throw new EvidenceBundleServiceError("invalid-proof");
    }

    const sourceAuthorityDigest = digestObject(canonicalJsonBytes(binding.sourceAuthorityIds));
    const operationContextDigest = digestObject(canonicalJsonBytes(binding.operationContext));
    let consumed: KeyOperationAuthorizationRecord;
    try {
      consumed = keyOperationAuthorization.parse({
        schema: "EVLLM_KEY_OPERATION_AUTHORIZATION_V1",
        authorization_id: authorization.claims.authorizationId,
        authorization_version: authorization.claims.authorizationVersion,
        issuer_service_actor_id: this.config.keyOperationAuthorizer.actorId,
        issuer_service_organization_id: this.config.keyOperationAuthorizer.organizationId,
        issuer_service_credential_id: this.config.keyOperationAuthorizer.credentialId,
        issuer_service_address: this.config.keyOperationAuthorizer.address,
        repository_id: this.config.controllerRepositoryId,
        operation: binding.operation,
        requesting_actor_id: authorization.claims.requester.actorId,
        requesting_organization_id: authorization.claims.requester.organizationId,
        requesting_credential_id: authorization.claims.requester.credentialId,
        bundle_id: binding.record.bundleId,
        bundle_version: binding.record.bundleVersion,
        bundle_type: "evidence",
        domain_resource_id: binding.record.resourceId,
        domain_resource_version: binding.record.resourceVersion,
        purpose_id: authorization.claims.purposeId,
        policy_id: authorization.claims.policyId,
        policy_version: authorization.claims.policyVersion,
        source_authority_ids: binding.sourceAuthorityIds,
        source_authority_digest: sourceAuthorityDigest,
        operation_context_digest: operationContextDigest,
        nonce: stringField(authorization.proof.message, "nonce"),
        issued_at: numberField(authorization.proof.message, "issuedAt"),
        expires_at: numberField(authorization.proof.message, "expiresAt"),
        idempotency_key_hash: stringField(authorization.proof.message, "idempotencyKeyHash"),
        signature: signatureBase64Url(authorization.proof.signature),
        typed_data_digest: verified.typedDataDigest,
        signature_digest: digestFromHex(verified.signatureDigest),
        state: "consumed",
      });
    } catch {
      throw new EvidenceBundleServiceError("invalid-proof");
    }
    return {
      nonceScope: nonceScope(
        "KeyOperationAuthorization",
        stringField(authorization.proof.message, "issuerServiceCredentialId"),
        consumed.nonce,
      ),
      record: consumed,
    };
  }

  private async consumeValidatedProofs(
    localNonces: readonly PendingNonceConsumption[],
    keyOperationAuthorization: PreparedKeyOperationAuthorization,
  ): Promise<void> {
    const consumedLocalNonces: PendingNonceConsumption[] = [];
    try {
      for (const pending of localNonces) {
        pending.store.consume(pending.scope);
        consumedLocalNonces.push(pending);
      }
      await this.config.keyOperationAuthorizationRepository.consume(
        keyOperationAuthorization.record,
        keyOperationAuthorization.nonceScope,
      );
    } catch {
      for (const pending of consumedLocalNonces) {
        pending.store.rollback(pending.scope);
      }
      throw new EvidenceBundleServiceError("invalid-proof");
    }
  }

  private validateKeyOperationClaims(
    target: KeyOperationAuthorizationTarget,
    claims: KeyOperationAuthorizationClaims,
  ): void {
    if (target.operation !== "decrypt-with-grant") return;
    const recipient = this.#recipientEnvelopes.get(target.recipientEnvelopeId);
    if (
      recipient === undefined ||
      recipient.grantId !== target.grantId ||
      claims.policyId !== recipient.policyId ||
      claims.policyVersion !== recipient.policyVersion ||
      claims.purposeId !== recipient.purposeId ||
      claims.requester.organizationId !== recipient.recipientOrganizationId
    ) {
      throw new EvidenceBundleServiceError("invalid-proof");
    }
  }

  private keyOperationBinding(target: KeyOperationAuthorizationTarget): {
    readonly operation: KeyOperationAuthorizationTarget["operation"];
    readonly operationContext: Readonly<Record<string, unknown>>;
    readonly record: PreparedInternal;
    readonly sourceAuthorityIds: readonly string[];
  } {
    const record = this.record(target.bundleId);
    switch (target.operation) {
      case "verify-and-finalize-staging":
        return {
          operation: target.operation,
          operationContext: {
            staging_id: record.stagingId,
            staging_object_id: record.stagingObjectId,
            staging_descriptor_digest: record.descriptorDigest,
            controller_authorization_id: record.controllerAuthorizationId,
            controller_envelope_id: record.controllerEnvelopeId,
            controller_encryption_key_id: record.controllerEncryptionKeyId,
            content_envelope_digest: record.contentEnvelopeDigest,
            stored_envelope_length: record.storedEnvelopeLength,
            finalization_proof_digest: digestObject(canonicalJsonBytes(target.finalization)),
          },
          record,
          sourceAuthorityIds: [record.controllerAuthorizationId],
        };
      case "rotate-controller-envelope":
        return {
          operation: target.operation,
          operationContext: {
            predecessor_authorization_id: target.predecessorAuthorizationId,
            predecessor_envelope_id: record.controllerEnvelopeId,
            predecessor_key_id: record.controllerEncryptionKeyId,
            predecessor_public_key_spki_sha256: record.controllerPublicKeySpkiSha256,
            successor_authorization_id: target.successorAuthorizationId,
            successor_envelope_id: target.successorEnvelopeId,
            successor_key_id: target.successorKeyId,
            successor_kid: target.successorKid,
            successor_public_key_spki_sha256: target.successorPublicKeySpkiSha256,
          },
          record,
          sourceAuthorityIds: [target.predecessorAuthorizationId],
        };
      case "create-grant-envelope":
        return {
          operation: target.operation,
          operationContext: {
            controller_authorization_id: record.controllerAuthorizationId,
            controller_envelope_id: record.controllerEnvelopeId,
            content_envelope_digest: record.contentEnvelopeDigest,
            effective_at: target.effectiveAt,
            expires_at: target.expiresAt,
            grant_id: target.grantId,
            purpose: target.purpose,
            recipient_envelope_id: target.recipientEnvelopeId,
            recipient_key_id: target.recipientKeyId,
            recipient_kid: target.recipientKid,
            recipient_organization_id: target.recipientOrganizationId,
            recipient_public_key_spki_sha256: target.recipientPublicKeySpkiSha256,
          },
          record,
          sourceAuthorityIds: [record.controllerAuthorizationId, target.grantId].sort(),
        };
      case "decrypt-with-grant": {
        const recipient = this.#recipientEnvelopes.get(target.recipientEnvelopeId);
        if (recipient === undefined || recipient.grantId !== target.grantId) {
          throw new EvidenceBundleServiceError("policy-denied");
        }
        return {
          operation: target.operation,
          operationContext: {
            content_envelope_digest: record.contentEnvelopeDigest,
            grant_id: recipient.grantId,
            policy_id: recipient.policyId,
            policy_version: recipient.policyVersion,
            purpose_id: recipient.purposeId,
            recipient_envelope_commitment: recipient.commitment,
            recipient_envelope_id: target.recipientEnvelopeId,
            recipient_key_id: recipient.recipientKeyId,
            recipient_kid: recipient.recipientKid,
            recipient_organization_id: recipient.recipientOrganizationId,
            recipient_public_key_spki_sha256: recipient.recipientPublicKeySpkiSha256,
            purpose: recipient.purpose,
            release_mode: "full",
          },
          record,
          sourceAuthorityIds: [recipient.grantId],
        };
      }
    }
  }

  private domain(name: ProofDomain["name"]): ProofDomain {
    return {
      chainId: this.config.chainId,
      name,
      verifyingContract: this.config.protectedBundleRegistryAddress,
      version: "1",
    };
  }

  private record(bundleId: string): PreparedInternal {
    const record = this.#byBundle.get(bundleId);
    if (record === undefined) throw new EvidenceBundleServiceError("not-found");
    return record;
  }
}

function keyMaterialTargetFields(target: KeyMaterialAcknowledgementTarget): {
  readonly authorityId: string;
  readonly encryptionKeyId: string;
  readonly envelopeId: string;
  readonly publicKeySpkiSha256: Digest;
  readonly recipientKid: string;
} {
  if (target.operation === "create-grant-envelope") {
    return {
      authorityId: target.grantId,
      encryptionKeyId: target.recipientKeyId,
      envelopeId: target.recipientEnvelopeId,
      publicKeySpkiSha256: target.recipientPublicKeySpkiSha256,
      recipientKid: target.recipientKid,
    };
  }
  return {
    authorityId: target.successorAuthorizationId,
    encryptionKeyId: target.successorKeyId,
    envelopeId: target.successorEnvelopeId,
    publicKeySpkiSha256: target.successorPublicKeySpkiSha256,
    recipientKid: target.successorKid,
  };
}

function pendingNonceConsumption(
  store: NonceStore,
  type: ProtectedSignatureType,
  credentialField: string,
  message: Record<string, unknown>,
): PendingNonceConsumption {
  return {
    scope: nonceScope(type, stringField(message, credentialField), stringField(message, "nonce")),
    store,
  };
}

function publicPreparation(record: PreparedInternal): PreparedEvidence {
  return {
    bundleId: record.bundleId,
    bundleVersion: 1,
    contentCommitment: record.contentCommitment,
    contentEnvelopeDigest: record.contentEnvelopeDigest,
    controllerEnvelope: Uint8Array.from(record.controllerEnvelope),
    controllerEnvelopeId: record.controllerEnvelopeId,
    descriptorDigest: record.descriptorDigest,
    domainPayload: Uint8Array.from(record.domainPayload),
    domainPayloadCommitment: record.domainPayloadCommitment,
    finalObjectId: record.finalObjectId,
    stagingId: record.stagingId,
    stagingObjectId: record.stagingObjectId,
    storedEnvelopeLength: record.storedEnvelopeLength,
  };
}

function digestHex(value: Digest): string {
  return `0x${Buffer.from(value.value, "base64url").toString("hex")}`;
}

function sha256Hex(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

function digestObject(value: Uint8Array): Digest {
  return {
    alg: "SHA-256",
    value: createHash("sha256").update(value).digest("base64url"),
  };
}

function digestFromHex(value: string): Digest {
  if (!/^0x[0-9a-f]{64}$/u.test(value)) throw new EvidenceBundleServiceError("invalid-proof");
  return {
    alg: "SHA-256",
    value: Buffer.from(value.slice(2), "hex").toString("base64url"),
  };
}

function signatureBase64Url(value: string): string {
  if (!/^0x[0-9a-f]{130}$/u.test(value)) {
    throw new EvidenceBundleServiceError("invalid-proof");
  }
  return Buffer.from(value.slice(2), "hex").toString("base64url");
}

function canonicalBytesEqual(left: unknown, right: unknown): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)));
}

function idHash(value: string): string {
  return keccak256(toUtf8Bytes(`EVLLM_ID_V1\0${value}`));
}

function bundleTypeHash(value: string): string {
  return keccak256(toUtf8Bytes(`EVLLM_LITERAL_V1\0bundle-type\0${value}`));
}

function keyOperationHash(value: string): string {
  return keccak256(toUtf8Bytes(`EVLLM_LITERAL_V1\0key-operation\0${value}`));
}

function opaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function urn(kind: string): string {
  return `urn:evllm:${kind}:${randomUUID()}`;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== "string") throw new EvidenceBundleServiceError("invalid-proof");
  return candidate;
}

function numberField(value: Record<string, unknown>, field: string): number {
  const candidate = value[field];
  if (!Number.isSafeInteger(candidate)) throw new EvidenceBundleServiceError("invalid-proof");
  return candidate as number;
}
