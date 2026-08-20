import { createHash, type KeyObject, randomBytes, randomUUID } from "node:crypto";

import { keccak256, toUtf8Bytes } from "ethers";

import {
  type dekWrapContext,
  evidenceClaimPayload,
  evidenceManifest,
  type digest,
  type protectedContentAad,
} from "../schemas/index.js";
import {
  canonicalJsonBytes,
  openProtectedContent,
  protectContent,
  unwrapDek,
  wrapDek,
} from "../protected-bundles/crypto/index.js";
import { KeyLifecycleRegistry } from "../protected-bundles/keys/index.js";
import {
  ProtectedObjectCoordinator,
  type PromotionResult,
} from "../protected-bundles/repository/index.js";
import {
  NonceStore,
  verifyProtectedProof,
  type CredentialAcceptance,
  type ProofDomain,
} from "../protected-bundles/signatures/index.js";
import type { OpaqueObjectStore } from "../protected-bundles/storage/index.js";

type Digest = ReturnType<typeof digest.parse>;
type ContentAad = ReturnType<typeof protectedContentAad.parse>;
type DekWrapContext = ReturnType<typeof dekWrapContext.parse>;

export interface EvidenceBundleServiceConfig {
  readonly chainId: number;
  readonly controllerRepositoryId: string;
  readonly credentialAt: (credentialId: string, time: number) => CredentialAcceptance;
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
  readonly context: DekWrapContext;
  readonly grantId: string;
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
    const wrapped = await wrapDek({
      context: wrapContext,
      dek: protectedResult.dek,
      publicKey: input.controllerPublicKey,
    });
    protectedResult.dek.fill(0);
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
        mode: { kind: "execution", currentTime: input.now, nonceStore: this.#domainNonceStore },
        signature: input.attestation.signature,
        type: "DomainManifestAttestation",
      });
      verifyProtectedProof({
        credentialAt: this.config.credentialAt,
        domain: this.domain("EVLLM Protected Bundle Command"),
        expectedSignerAddress: input.controllerAddress,
        maxLifetimeSeconds: this.config.maxProofLifetimeSeconds,
        message: input.finalization.message,
        mode: {
          kind: "execution",
          currentTime: input.now,
          nonceStore: this.#controllerNonceStore,
        },
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
    const dek = await unwrapDek(
      record.controllerEnvelope,
      input.controllerPrivateKey,
      record.wrapContext,
    );
    const stagedBytes = await collect(this.config.primaryStore.get(record.stagingObjectId));
    await openProtectedContent(stagedBytes, dek, record.aad);
    dek.fill(0);
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
    readonly predecessorAuthorizationId: string;
    readonly predecessorPrivateKey: KeyObject;
    readonly successorAuthorizationId: string;
    readonly successorEnvelopeId: string;
    readonly successorKeyId: string;
    readonly successorKid: string;
    readonly successorPrivateKey: KeyObject;
    readonly successorPublicKey: KeyObject;
  }): Promise<void> {
    const record = this.record(input.bundleId);
    if (
      !record.finalized ||
      record.controllerAuthorizationId !== input.predecessorAuthorizationId
    ) {
      throw new EvidenceBundleServiceError("invalid-state");
    }
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
    const successor = await wrapDek({
      context: successorContext,
      dek,
      publicKey: input.successorPublicKey,
    });
    dek.fill(0);
    await this.#keyLifecycle.rotateControllerAuthorization(
      input.predecessorAuthorizationId,
      {
        authorizationId: input.successorAuthorizationId,
        envelopeId: input.successorEnvelopeId,
        keyId: input.successorKeyId,
        state: "staged",
      },
      async () => {
        const verified = await unwrapDek(
          successor.envelopeBytes,
          input.successorPrivateKey,
          successorContext,
        ).catch(() => undefined);
        verified?.fill(0);
        return verified !== undefined;
      },
    );
    record.controllerAuthorizationId = input.successorAuthorizationId;
    record.controllerEnvelope = successor.envelopeBytes;
    record.controllerEnvelopeId = input.successorEnvelopeId;
    record.controllerEncryptionKeyId = input.successorKeyId;
    record.controllerKid = input.successorKid;
    record.wrapContext = successorContext;
  }

  public async grantRecipient(input: {
    readonly bundleId: string;
    readonly controllerPrivateKey: KeyObject;
    readonly effectiveAt: number;
    readonly expiresAt: number;
    readonly grantId: string;
    readonly purpose: string;
    readonly recipientEnvelopeId: string;
    readonly recipientKeyId: string;
    readonly recipientKid: string;
    readonly recipientOrganizationId: string;
    readonly recipientPrivateKey: KeyObject;
    readonly recipientPublicKey: KeyObject;
  }): Promise<void> {
    const record = this.record(input.bundleId);
    if (!record.finalized) throw new EvidenceBundleServiceError("invalid-state");
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
    const wrapped = await wrapDek({ context, dek, publicKey: input.recipientPublicKey });
    dek.fill(0);
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
      context,
      grantId: input.grantId,
    });
    await this.#keyLifecycle.activateGrant(input.grantId, input.effectiveAt, async () => {
      const check = await unwrapDek(
        wrapped.envelopeBytes,
        input.recipientPrivateKey,
        context,
      ).catch(() => undefined);
      check?.fill(0);
      return wrapped.envelopeBytes.byteLength > 0;
    });
  }

  public async retrieveWithGrant(input: {
    readonly bundleId: string;
    readonly currentTime: number;
    readonly grantId: string;
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
    const dek = await unwrapDek(recipient.bytes, input.recipientPrivateKey, recipient.context);
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
    const opened = await openProtectedContent(fetched.bytes, dek, record.aad);
    dek.fill(0);
    return { ...opened, source: fetched.source };
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

function idHash(value: string): string {
  return keccak256(toUtf8Bytes(`EVLLM_ID_V1\0${value}`));
}

function bundleTypeHash(value: string): string {
  return keccak256(toUtf8Bytes(`EVLLM_LITERAL_V1\0bundle-type\0${value}`));
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
