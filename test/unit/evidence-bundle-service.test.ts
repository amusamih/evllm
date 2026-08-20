import { createHash, generateKeyPairSync } from "node:crypto";

import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import { EvidenceBundleService } from "../../src/evidence/index.js";
import { eip712Profiles } from "../../src/schemas/index.js";
import { MemoryObjectStoreBackend } from "../../src/protected-bundles/storage/index.js";

const ids = {
  actorAuthor: urn("actor", 1),
  actorController: urn("actor", 2),
  authorBindingProfile: urn("profile", 3),
  bundle: urn("bundle", 4),
  claim: urn("claim", 5),
  controllerAuthorization: urn("authorization", 6),
  controllerCredential: urn("credential", 7),
  controllerKey: urn("key", 8),
  controllerOrg: urn("org", 9),
  evidence: urn("evidence", 10),
  issuerCredential: urn("credential", 11),
  issuerOrg: urn("org", 12),
  profile: urn("profile", 13),
  repository: urn("repository", 14),
  replicaOrg: urn("org", 15),
  replicaRepository: urn("repository", 16),
  schema: urn("schema", 17),
};

describe("evidence protected-bundle workflow", () => {
  it("prepares idempotently, verifies two signatures, replicates, grants and fails over", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    const retried = await fixture.service.prepare(fixture.prepareInput);
    expect(retried).toEqual(prepared);

    await finalize(fixture, prepared.bundleId, 100);
    expect(fixture.service.finalizedRecord(prepared.bundleId)).toMatchObject({
      bundleId: prepared.bundleId,
      storedEnvelopeLength: prepared.storedEnvelopeLength,
    });
    expect(fixture.service.evidenceManifest(prepared.bundleId, "active")).toMatchObject({
      schema: "EVLLM_EVIDENCE_MANIFEST_V1",
      evidence_id: ids.evidence,
      evidence_version: 1,
      claim_id: ids.claim,
      lifecycle: "active",
      protected_bundle_ref: { bundle_id: prepared.bundleId },
    });
    const recipient = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const recipientKeyId = urn("key", 20);
    const grantId = urn("grant", 21);
    const recipientEnvelopeId = urn("envelope", 22);
    fixture.service.keyLifecycle().addKey({
      id: recipientKeyId,
      organizationId: urn("org", 23),
      state: "active",
    });
    await fixture.service.grantRecipient({
      bundleId: prepared.bundleId,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      effectiveAt: 100,
      expiresAt: 200,
      grantId,
      purpose: "evidence-review",
      recipientEnvelopeId,
      recipientKeyId,
      recipientKid: kid("recipient"),
      recipientOrganizationId: urn("org", 23),
      recipientPrivateKey: recipient.privateKey,
      recipientPublicKey: recipient.publicKey,
    });

    await expect(
      fixture.service.retrieveWithGrant({
        bundleId: prepared.bundleId,
        currentTime: 101,
        grantId,
        recipientEnvelopeId,
        recipientPrivateKey: recipient.privateKey,
      }),
    ).resolves.toMatchObject({ content: fixture.content, source: "primary" });

    await fixture.primary.delete(prepared.finalObjectId);
    await expect(
      fixture.service.retrieveWithGrant({
        bundleId: prepared.bundleId,
        currentTime: 101,
        grantId,
        recipientEnvelopeId,
        recipientPrivateKey: recipient.privateKey,
      }),
    ).resolves.toMatchObject({ content: fixture.content, source: "replica" });

    fixture.service.keyLifecycle().revokeGrant(grantId);
    await expect(
      fixture.service.retrieveWithGrant({
        bundleId: prepared.bundleId,
        currentTime: 101,
        grantId,
        recipientEnvelopeId,
        recipientPrivateKey: recipient.privateKey,
      }),
    ).rejects.toMatchObject({ code: "policy-denied" });
  }, 30_000);

  it("keeps supplementary content primary-only until irreversible promotion", async () => {
    const fixture = serviceFixture("supplementary");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    await finalize(fixture, prepared.bundleId, 300);
    expect(await fixture.replica.health()).toBe("ready");
    await expect(
      fixture.service.promoteToDecisionCritical(prepared.bundleId),
    ).resolves.toMatchObject({
      status: "created",
    });
    await expect(
      fixture.service.promoteToDecisionCritical(prepared.bundleId),
    ).rejects.toMatchObject({
      code: "invalid-state",
    });
  }, 30_000);

  it("rejects changed idempotent input and cross-signature replay", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    await expect(
      fixture.service.prepare({
        ...fixture.prepareInput,
        content: new TextEncoder().encode("substituted report"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const proofs = await signedProofs(fixture, prepared.bundleId, 500);
    await fixture.service.finalize({
      ...proofs,
      bundleId: prepared.bundleId,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      now: 500,
    });
    await expect(
      fixture.service.finalize({
        ...proofs,
        bundleId: prepared.bundleId,
        controllerPrivateKey: fixture.controllerRsa.privateKey,
        now: 500,
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });
  }, 30_000);

  it("rotates controller recovery without changing protected content bytes", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    await finalize(fixture, prepared.bundleId, 700);
    const before = fixture.service.finalizedRecord(prepared.bundleId);
    const successor = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const successorKeyId = urn("key", 40);
    fixture.service.keyLifecycle().addKey({
      id: successorKeyId,
      organizationId: ids.controllerOrg,
      state: "active",
    });
    await fixture.service.rotateControllerEnvelope({
      bundleId: prepared.bundleId,
      predecessorAuthorizationId: ids.controllerAuthorization,
      predecessorPrivateKey: fixture.controllerRsa.privateKey,
      successorAuthorizationId: urn("authorization", 41),
      successorEnvelopeId: urn("envelope", 42),
      successorKeyId,
      successorKid: kid("successor"),
      successorPrivateKey: successor.privateKey,
      successorPublicKey: successor.publicKey,
    });
    const after = fixture.service.finalizedRecord(prepared.bundleId);
    expect(after.contentEnvelopeDigest).toEqual(before.contentEnvelopeDigest);
    expect(after.primaryObjectId).toBe(before.primaryObjectId);
    expect(fixture.service.keyLifecycle().snapshot().authorizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorizationId: ids.controllerAuthorization,
          state: "retired",
        }),
        expect.objectContaining({ authorizationId: urn("authorization", 41), state: "active" }),
      ]),
    );
  }, 30_000);
});

function serviceFixture(initialCriticality: "decision-critical" | "supplementary") {
  const backend = new MemoryObjectStoreBackend();
  const primary = backend.forOrganization(ids.controllerOrg, { maxObjectBytes: 1_000_000 });
  const replica = backend.forOrganization(ids.replicaOrg, { maxObjectBytes: 1_000_000 });
  const authorWallet = Wallet.createRandom();
  const controllerWallet = Wallet.createRandom();
  const controllerRsa = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  const service = new EvidenceBundleService({
    chainId: 31_337,
    controllerRepositoryId: ids.repository,
    credentialAt: () => ({ active: true, validFrom: 0 }),
    maxProofLifetimeSeconds: 600,
    primaryStore: primary,
    protectedBundleRegistryAddress: "0x1111111111111111111111111111111111111111",
    replicaRepositoryId: ids.replicaRepository,
    replicaStore: replica,
  });
  service.keyLifecycle().addKey({
    id: ids.controllerKey,
    organizationId: ids.controllerOrg,
    state: "active",
  });
  const content = new TextEncoder().encode("private battery capacity report");
  const payload = evidencePayload(initialCriticality);
  const prepareInput = {
    authorBindingProfileId: ids.authorBindingProfile,
    authorBindingProfileVersion: 1,
    content,
    contentMediaType: "application/pdf",
    controllerActorId: ids.actorController,
    controllerAuthorizationId: ids.controllerAuthorization,
    controllerCredentialId: ids.controllerCredential,
    controllerEncryptionKeyId: ids.controllerKey,
    controllerKid: kid("controller"),
    controllerOrganizationId: ids.controllerOrg,
    controllerPublicKey: controllerRsa.publicKey,
    evidencePayload: payload,
    idempotencyKey: new Uint8Array(32).fill(7),
    initialCriticality,
    intendedAuthorActorId: ids.actorAuthor,
    intendedAuthorCredentialId: ids.issuerCredential,
    intendedAuthorOrganizationId: ids.issuerOrg,
  } as const;
  return {
    authorWallet,
    content,
    controllerRsa,
    controllerWallet,
    prepareInput,
    primary,
    replica,
    service,
  };
}

async function finalize(fixture: ReturnType<typeof serviceFixture>, bundleId: string, now: number) {
  const proofs = await signedProofs(fixture, bundleId, now);
  return fixture.service.finalize({
    ...proofs,
    bundleId,
    controllerPrivateKey: fixture.controllerRsa.privateKey,
    now,
  });
}

async function signedProofs(
  fixture: ReturnType<typeof serviceFixture>,
  bundleId: string,
  now: number,
) {
  const attestationMessage = fixture.service.domainAttestationMessage(
    bundleId,
    {
      actorId: ids.actorAuthor,
      credentialId: ids.issuerCredential,
      organizationId: ids.issuerOrg,
    },
    { expiresAt: now + 60, issuedAt: now - 1, nonce: nonce(1) },
  );
  const attestationDomain = {
    chainId: 31_337,
    name: eip712Profiles.DomainManifestAttestation.domainName,
    verifyingContract: "0x1111111111111111111111111111111111111111",
    version: "1",
  } as const;
  const attestationSignature = await fixture.authorWallet.signTypedData(
    attestationDomain,
    {
      DomainManifestAttestation: eip712Profiles.DomainManifestAttestation.fields.map((field) => ({
        ...field,
      })),
    },
    attestationMessage,
  );
  const attestation = { message: attestationMessage, signature: attestationSignature };
  const finalizationMessage = fixture.service.finalizationMessage(
    bundleId,
    attestation,
    {
      actorId: ids.actorController,
      credentialId: ids.controllerCredential,
      organizationId: ids.controllerOrg,
    },
    {
      commandId: urn("command", now),
      expiresAt: now + 60,
      idempotencyKeyHash: `0x${createHash("sha256").update("finalize").digest("hex")}`,
      issuedAt: now - 1,
      nonce: nonce(2),
    },
  );
  const finalizationDomain = {
    ...attestationDomain,
    name: eip712Profiles.FinalizeProtectedBundle.domainName,
  };
  const finalizationSignature = await fixture.controllerWallet.signTypedData(
    finalizationDomain,
    {
      FinalizeProtectedBundle: eip712Profiles.FinalizeProtectedBundle.fields.map((field) => ({
        ...field,
      })),
    },
    finalizationMessage,
  );
  return {
    attestation,
    authorAddress: fixture.authorWallet.address.toLowerCase(),
    controllerAddress: fixture.controllerWallet.address.toLowerCase(),
    finalization: { message: finalizationMessage, signature: finalizationSignature },
  };
}

function evidencePayload(initialCriticality: "decision-critical" | "supplementary") {
  return {
    schema: "EVLLM_EVIDENCE_CLAIM_PAYLOAD_V1",
    evidence_id: ids.evidence,
    evidence_version: 1,
    claim_id: ids.claim,
    claim_version: 1,
    claim_type: "remaining-capacity",
    subject_id: urn("battery", 30),
    subject_granularity: "pack",
    issuer_organization_id: ids.issuerOrg,
    issuer_role_id: urn("role", 31),
    observed_at: 50,
    submitted_at: 60,
    capture_method: { id: "capacity-test", version: 1 },
    value: {
      type: "quantity",
      quantity: { value: "72.5", unit_id: urn("unit", 32), unit_version: 1 },
    },
    uncertainty: { type: "range", range: { lower: "72", upper: "73" } },
    source_class: "primary",
    provenance: [],
    protected_bundle_ref: {
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
      bundle_id: ids.bundle,
      bundle_version: 1,
      bundle_type: "evidence",
      domain_resource_id: ids.evidence,
      domain_resource_version: 1,
      custody_controller_org_id: ids.controllerOrg,
      content_schema_id: ids.schema,
      content_schema_version: "1.0.0",
      initial_criticality_class: initialCriticality,
      criticality_profile_id: ids.profile,
      criticality_profile_version: 1,
    },
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}

function nonce(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function kid(label: string): string {
  return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${createHash("sha256")
    .update(label)
    .digest("base64url")}`;
}
