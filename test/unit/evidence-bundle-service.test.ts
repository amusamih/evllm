import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";

import {
  EvidenceBundleService,
  InMemoryKeyOperationAuthorizationRepository,
  InMemoryKeyOperationAuthorizationState,
  type KeyOperationAuthorizationClaims,
  type KeyOperationAuthorizationRepository,
  type KeyOperationAuthorizationTarget,
  type KeyMaterialAcknowledgementTarget,
  type ServicePrincipal,
} from "../../src/evidence/index.js";
import {
  createRsaKeyPossessionProof,
  rsaPublicKeySpkiSha256,
} from "../../src/protected-bundles/crypto/index.js";
import { eip712Profiles } from "../../src/schemas/index.js";
import { MemoryObjectStoreBackend } from "../../src/protected-bundles/storage/index.js";

const ids = {
  actorAuthor: urn("actor", 1),
  actorController: urn("actor", 2),
  actorKeyAuthorizer: urn("actor", 18),
  actorRecipient: urn("actor", 19),
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
  keyAuthorizerCredential: urn("credential", 24),
  keyAuthorizerOrg: urn("org", 25),
  policy: urn("policy", 26),
  profile: urn("profile", 13),
  repository: urn("repository", 14),
  replicaOrg: urn("org", 15),
  replicaRepository: urn("repository", 16),
  recipientCredential: urn("credential", 27),
  purpose: urn("policy", 28),
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
    const recipientOrganizationId = urn("org", 23);
    const recipientIdentityWallet = Wallet.createRandom();
    const recipientRequester = {
      actorId: ids.actorRecipient,
      credentialId: ids.recipientCredential,
      organizationId: recipientOrganizationId,
    };
    fixture.registerKeyMaterialSigner(recipientRequester, recipientIdentityWallet);
    fixture.service.keyLifecycle().addKey({
      id: recipientKeyId,
      organizationId: recipientOrganizationId,
      state: "active",
    });
    const grantTarget = {
      bundleId: prepared.bundleId,
      currentTime: 100,
      effectiveAt: 100,
      expiresAt: 200,
      grantId,
      operation: "create-grant-envelope" as const,
      purpose: "evidence-review",
      recipientEnvelopeId,
      recipientKeyId,
      recipientKid: kid("recipient"),
      recipientOrganizationId,
      recipientPublicKeySpkiSha256: rsaPublicKeySpkiSha256(recipient.publicKey),
    };
    const grantAuthorization = await signedKeyOperationAuthorization(
      fixture,
      grantTarget,
      100,
      101,
    );
    const keyMaterialAcknowledgement = await signedKeyMaterialAcknowledgement(
      fixture,
      grantTarget,
      recipientRequester,
      recipientIdentityWallet,
      recipient.privateKey,
      100,
      101,
    );
    await fixture.service.grantRecipient({
      ...grantTarget,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      keyMaterialAcknowledgement,
      keyOperationAuthorization: grantAuthorization,
      recipientPublicKey: recipient.publicKey,
    });

    const retrievalTarget = {
      bundleId: prepared.bundleId,
      currentTime: 101,
      grantId,
      operation: "decrypt-with-grant" as const,
      recipientEnvelopeId,
    };
    const primaryAuthorization = await signedKeyOperationAuthorization(
      fixture,
      retrievalTarget,
      101,
      102,
      { claims: keyOperationClaims(102, recipientRequester) },
    );
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalTarget,
        keyOperationAuthorization: primaryAuthorization,
        recipientPrivateKey: recipient.privateKey,
      }),
    ).resolves.toMatchObject({ content: fixture.content, source: "primary" });
    await expect(
      fixture.service.consumedKeyOperationAuthorization(
        primaryAuthorization.claims.authorizationId,
      ),
    ).resolves.toMatchObject({
      issuer_service_credential_id: ids.keyAuthorizerCredential,
      operation: "decrypt-with-grant",
      state: "consumed",
    });

    await fixture.primary.delete(prepared.finalObjectId);
    const replicaAuthorization = await signedKeyOperationAuthorization(
      fixture,
      retrievalTarget,
      101,
      103,
      { claims: keyOperationClaims(103, recipientRequester) },
    );
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalTarget,
        keyOperationAuthorization: replicaAuthorization,
        recipientPrivateKey: recipient.privateKey,
      }),
    ).resolves.toMatchObject({ content: fixture.content, source: "replica" });

    fixture.service.keyLifecycle().revokeGrant(grantId);
    const revokedAuthorization = await signedKeyOperationAuthorization(
      fixture,
      retrievalTarget,
      101,
      104,
      { claims: keyOperationClaims(104, recipientRequester) },
    );
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalTarget,
        keyOperationAuthorization: revokedAuthorization,
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
    const keyOperationAuthorization = await signedKeyOperationAuthorization(
      fixture,
      {
        bundleId: prepared.bundleId,
        finalization: proofs.finalization,
        operation: "verify-and-finalize-staging",
      },
      500,
      500,
    );
    await fixture.service.finalize({
      ...proofs,
      bundleId: prepared.bundleId,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      keyOperationAuthorization,
      now: 500,
    });
    await expect(
      fixture.service.finalize({
        ...proofs,
        bundleId: prepared.bundleId,
        controllerPrivateKey: fixture.controllerRsa.privateKey,
        keyOperationAuthorization,
        now: 500,
      }),
    ).rejects.toMatchObject({ code: "invalid-state" });
  }, 30_000);

  it("does not consume finalization proofs when later key authorization is invalid", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    const proofs = await signedProofs(fixture, prepared.bundleId, 800);
    const authorization = await signedKeyOperationAuthorization(
      fixture,
      {
        bundleId: prepared.bundleId,
        finalization: proofs.finalization,
        operation: "verify-and-finalize-staging",
      },
      800,
      800,
    );
    const invalidAuthorization = {
      ...authorization,
      proof: {
        ...authorization.proof,
        message: {
          ...authorization.proof.message,
          operation: `0x${"f".repeat(64)}`,
        },
      },
    };
    const input = {
      ...proofs,
      bundleId: prepared.bundleId,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      now: 800,
    };

    await expect(
      fixture.service.finalize({
        ...input,
        keyOperationAuthorization: invalidAuthorization,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });
    await expect(
      fixture.service.finalize({
        ...input,
        keyOperationAuthorization: authorization,
      }),
    ).resolves.toMatchObject({ primary: { status: "created" } });
  }, 30_000);

  it("requires an exact, unexpired, one-use key-operation authorization", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    await finalize(fixture, prepared.bundleId, 900);
    const recipient = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const recipientKeyId = urn("key", 50);
    const grantId = urn("grant", 51);
    const recipientEnvelopeId = urn("envelope", 52);
    const recipientOrganizationId = urn("org", 53);
    const recipientIdentityWallet = Wallet.createRandom();
    const recipientRequester = {
      actorId: ids.actorRecipient,
      credentialId: ids.recipientCredential,
      organizationId: recipientOrganizationId,
    };
    fixture.registerKeyMaterialSigner(recipientRequester, recipientIdentityWallet);
    fixture.service.keyLifecycle().addKey({
      id: recipientKeyId,
      organizationId: recipientOrganizationId,
      state: "active",
    });
    const grantTarget = {
      bundleId: prepared.bundleId,
      currentTime: 901,
      effectiveAt: 901,
      expiresAt: 1_100,
      grantId,
      operation: "create-grant-envelope" as const,
      purpose: "evidence-review",
      recipientEnvelopeId,
      recipientKeyId,
      recipientKid: kid("authorization-test-recipient"),
      recipientOrganizationId,
      recipientPublicKeySpkiSha256: rsaPublicKeySpkiSha256(recipient.publicKey),
    };
    const keyMaterialAcknowledgement = await signedKeyMaterialAcknowledgement(
      fixture,
      grantTarget,
      recipientRequester,
      recipientIdentityWallet,
      recipient.privateKey,
      901,
      910,
    );
    await fixture.service.grantRecipient({
      ...grantTarget,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      keyMaterialAcknowledgement,
      keyOperationAuthorization: await signedKeyOperationAuthorization(
        fixture,
        grantTarget,
        901,
        910,
      ),
      recipientPublicKey: recipient.publicKey,
    });

    const requester = recipientRequester;
    const retrievalTarget = {
      bundleId: prepared.bundleId,
      currentTime: 902,
      grantId,
      operation: "decrypt-with-grant" as const,
      recipientEnvelopeId,
    };
    const retrievalInput = {
      ...retrievalTarget,
      recipientPrivateKey: recipient.privateKey,
    };
    await expect(
      fixture.service.retrieveWithGrant(
        retrievalInput as unknown as Parameters<typeof fixture.service.retrieveWithGrant>[0],
      ),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    const valid = await signedKeyOperationAuthorization(fixture, retrievalTarget, 902, 911, {
      claims: keyOperationClaims(911, requester),
    });
    const altered = {
      ...valid,
      proof: {
        ...valid.proof,
        message: {
          ...valid.proof.message,
          operation: `0x${"f".repeat(64)}`,
        },
      },
    };
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalInput,
        keyOperationAuthorization: altered,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalInput,
        keyOperationAuthorization: valid,
      }),
    ).resolves.toMatchObject({ content: fixture.content });

    const wrongSigner = await signedKeyOperationAuthorization(fixture, retrievalTarget, 902, 912, {
      claims: keyOperationClaims(912, requester),
      signer: fixture.controllerWallet,
    });
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalInput,
        keyOperationAuthorization: wrongSigner,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });
    const correctlySigned = await signedKeyOperationAuthorization(
      fixture,
      retrievalTarget,
      902,
      912,
      { claims: keyOperationClaims(912, requester) },
    );
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalInput,
        keyOperationAuthorization: correctlySigned,
      }),
    ).resolves.toMatchObject({ content: fixture.content });

    const expiredTarget = { ...retrievalTarget, currentTime: 950 };
    const expired = await signedKeyOperationAuthorization(fixture, expiredTarget, 950, 913, {
      claims: keyOperationClaims(913, requester),
      expiresAt: 950,
      issuedAt: 949,
    });
    await expect(
      fixture.service.retrieveWithGrant({
        ...expiredTarget,
        keyOperationAuthorization: expired,
        recipientPrivateKey: recipient.privateKey,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalInput,
        keyOperationAuthorization: correctlySigned,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });
    const fresh = await signedKeyOperationAuthorization(fixture, retrievalTarget, 902, 914, {
      claims: keyOperationClaims(914, requester),
    });
    await expect(
      fixture.service.retrieveWithGrant({
        ...retrievalInput,
        keyOperationAuthorization: fresh,
      }),
    ).resolves.toMatchObject({ content: fixture.content });
  }, 30_000);

  it("binds recipient key material and requires identity acknowledgement plus possession proof", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    await finalize(fixture, prepared.bundleId, 1_500);
    const recipient = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const substituted = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const recipientIdentityWallet = Wallet.createRandom();
    const untrustedIdentityWallet = Wallet.createRandom();
    const recipientOrganizationId = urn("org", 63);
    const recipientSigner = {
      actorId: ids.actorRecipient,
      credentialId: ids.recipientCredential,
      organizationId: recipientOrganizationId,
    };
    fixture.registerKeyMaterialSigner(recipientSigner, recipientIdentityWallet);
    const recipientKeyId = urn("key", 60);
    fixture.service.keyLifecycle().addKey({
      id: recipientKeyId,
      organizationId: recipientOrganizationId,
      state: "active",
    });
    const grantTarget = {
      bundleId: prepared.bundleId,
      currentTime: 1_501,
      effectiveAt: 1_501,
      expiresAt: 1_700,
      grantId: urn("grant", 61),
      operation: "create-grant-envelope" as const,
      purpose: "evidence-review",
      recipientEnvelopeId: urn("envelope", 62),
      recipientKeyId,
      recipientKid: kid("bound-recipient"),
      recipientOrganizationId,
      recipientPublicKeySpkiSha256: rsaPublicKeySpkiSha256(recipient.publicKey),
    };
    const keyOperationAuthorization = await signedKeyOperationAuthorization(
      fixture,
      grantTarget,
      1_501,
      1_501,
    );
    const acknowledgement = await signedKeyMaterialAcknowledgement(
      fixture,
      grantTarget,
      recipientSigner,
      recipientIdentityWallet,
      recipient.privateKey,
      1_501,
      1_501,
    );
    const grantInput = {
      ...grantTarget,
      controllerPrivateKey: fixture.controllerRsa.privateKey,
      keyOperationAuthorization,
      recipientPublicKey: recipient.publicKey,
    };

    await expect(
      fixture.service.grantRecipient(
        grantInput as unknown as Parameters<typeof fixture.service.grantRecipient>[0],
      ),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    const wrongIdentity = await signedKeyMaterialAcknowledgement(
      fixture,
      grantTarget,
      recipientSigner,
      untrustedIdentityWallet,
      recipient.privateKey,
      1_501,
      1_501,
    );
    await expect(
      fixture.service.grantRecipient({
        ...grantInput,
        keyMaterialAcknowledgement: wrongIdentity,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    const wrongPossession = await signedKeyMaterialAcknowledgement(
      fixture,
      grantTarget,
      recipientSigner,
      recipientIdentityWallet,
      substituted.privateKey,
      1_501,
      1_501,
    );
    await expect(
      fixture.service.grantRecipient({
        ...grantInput,
        keyMaterialAcknowledgement: wrongPossession,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    await expect(
      fixture.service.grantRecipient({
        ...grantInput,
        keyMaterialAcknowledgement: acknowledgement,
        recipientPublicKey: substituted.publicKey,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    const invalidAuthorization = {
      ...keyOperationAuthorization,
      proof: {
        ...keyOperationAuthorization.proof,
        message: {
          ...keyOperationAuthorization.proof.message,
          operation: `0x${"f".repeat(64)}`,
        },
      },
    };
    await expect(
      fixture.service.grantRecipient({
        ...grantInput,
        keyMaterialAcknowledgement: acknowledgement,
        keyOperationAuthorization: invalidAuthorization,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });

    await expect(
      fixture.service.grantRecipient({
        ...grantInput,
        keyMaterialAcknowledgement: acknowledgement,
      }),
    ).resolves.toBeUndefined();
  }, 30_000);

  it("persistently consumes authorization before a controller-key unwrap attempt", async () => {
    const fixture = serviceFixture("decision-critical");
    const prepared = await fixture.service.prepare(fixture.prepareInput);
    await finalize(fixture, prepared.bundleId, 1_800);
    const recipient = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const wrongController = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    const recipientOrganizationId = urn("org", 73);
    const recipientSigner = {
      actorId: ids.actorRecipient,
      credentialId: ids.recipientCredential,
      organizationId: recipientOrganizationId,
    };
    const identityWallet = Wallet.createRandom();
    fixture.registerKeyMaterialSigner(recipientSigner, identityWallet);
    const recipientKeyId = urn("key", 70);
    fixture.service.keyLifecycle().addKey({
      id: recipientKeyId,
      organizationId: recipientOrganizationId,
      state: "active",
    });
    const target = {
      bundleId: prepared.bundleId,
      currentTime: 1_801,
      effectiveAt: 1_801,
      expiresAt: 2_000,
      grantId: urn("grant", 71),
      operation: "create-grant-envelope" as const,
      purpose: "evidence-review",
      recipientEnvelopeId: urn("envelope", 72),
      recipientKeyId,
      recipientKid: kid("consume-before-unwrap"),
      recipientOrganizationId,
      recipientPublicKeySpkiSha256: rsaPublicKeySpkiSha256(recipient.publicKey),
    };
    const authorization = await signedKeyOperationAuthorization(fixture, target, 1_801, 1_801);
    const acknowledgement = await signedKeyMaterialAcknowledgement(
      fixture,
      target,
      recipientSigner,
      identityWallet,
      recipient.privateKey,
      1_801,
      1_801,
    );

    await expect(
      fixture.service.grantRecipient({
        ...target,
        controllerPrivateKey: wrongController.privateKey,
        keyMaterialAcknowledgement: acknowledgement,
        keyOperationAuthorization: authorization,
        recipientPublicKey: recipient.publicKey,
      }),
    ).rejects.toThrow();
    await expect(
      fixture.service.consumedKeyOperationAuthorization(authorization.claims.authorizationId),
    ).resolves.toMatchObject({ operation: "create-grant-envelope", state: "consumed" });
  }, 30_000);

  it("retains nonce consumption across repository re-instantiation and concurrent services", async () => {
    const state = new InMemoryKeyOperationAuthorizationState();
    const keyAuthorizerWallet = Wallet.createRandom();
    const first = serviceFixture("decision-critical", {
      keyAuthorizerWallet,
      keyOperationAuthorizationRepository: new InMemoryKeyOperationAuthorizationRepository(state),
    });
    const second = serviceFixture("decision-critical", {
      keyAuthorizerWallet,
      keyOperationAuthorizationRepository: new InMemoryKeyOperationAuthorizationRepository(state),
    });
    const firstPrepared = await first.service.prepare(first.prepareInput);
    const secondPrepared = await second.service.prepare(second.prepareInput);
    const firstProofs = await signedProofs(first, firstPrepared.bundleId, 1_200);
    const secondProofs = await signedProofs(second, secondPrepared.bundleId, 1_200);
    const sharedNonce = nonce(9_999);
    const firstAuthorization = await signedKeyOperationAuthorization(
      first,
      {
        bundleId: firstPrepared.bundleId,
        finalization: firstProofs.finalization,
        operation: "verify-and-finalize-staging",
      },
      1_200,
      1_201,
      { nonce: sharedNonce },
    );
    const secondAuthorization = await signedKeyOperationAuthorization(
      second,
      {
        bundleId: secondPrepared.bundleId,
        finalization: secondProofs.finalization,
        operation: "verify-and-finalize-staging",
      },
      1_200,
      1_202,
      { nonce: sharedNonce },
    );

    const outcomes = await Promise.allSettled([
      first.service.finalize({
        ...firstProofs,
        bundleId: firstPrepared.bundleId,
        controllerPrivateKey: first.controllerRsa.privateKey,
        keyOperationAuthorization: firstAuthorization,
        now: 1_200,
      }),
      second.service.finalize({
        ...secondProofs,
        bundleId: secondPrepared.bundleId,
        controllerPrivateKey: second.controllerRsa.privateKey,
        keyOperationAuthorization: secondAuthorization,
        now: 1_200,
      }),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === "rejected");
    expect(rejection?.status).toBe("rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toMatchObject({ code: "invalid-proof" });
    }

    const winner = outcomes[0]?.status === "fulfilled" ? firstAuthorization : secondAuthorization;
    const restartedRepository = new InMemoryKeyOperationAuthorizationRepository(state);
    await expect(
      restartedRepository.find(winner.claims.authorizationId, winner.claims.authorizationVersion),
    ).resolves.toMatchObject({ state: "consumed" });
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
    const rotationTarget = {
      bundleId: prepared.bundleId,
      currentTime: 701,
      operation: "rotate-controller-envelope" as const,
      predecessorAuthorizationId: ids.controllerAuthorization,
      successorAuthorizationId: urn("authorization", 41),
      successorEnvelopeId: urn("envelope", 42),
      successorKeyId,
      successorKid: kid("successor"),
      successorPublicKeySpkiSha256: rsaPublicKeySpkiSha256(successor.publicKey),
    };
    const keyOperationAuthorization = await signedKeyOperationAuthorization(
      fixture,
      rotationTarget,
      701,
      701,
    );
    const controllerPrincipal = {
      actorId: ids.actorController,
      credentialId: ids.controllerCredential,
      organizationId: ids.controllerOrg,
    };
    const keyMaterialAcknowledgement = await signedKeyMaterialAcknowledgement(
      fixture,
      rotationTarget,
      controllerPrincipal,
      fixture.controllerWallet,
      successor.privateKey,
      701,
      701,
    );
    const substitutedSuccessor = generateKeyPairSync("rsa", {
      modulusLength: 3072,
      publicExponent: 0x10001,
    });
    await expect(
      fixture.service.rotateControllerEnvelope({
        ...rotationTarget,
        keyMaterialAcknowledgement,
        keyOperationAuthorization,
        predecessorPrivateKey: fixture.controllerRsa.privateKey,
        successorPublicKey: substitutedSuccessor.publicKey,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });
    const invalidAuthorization = {
      ...keyOperationAuthorization,
      proof: {
        ...keyOperationAuthorization.proof,
        message: {
          ...keyOperationAuthorization.proof.message,
          operation: `0x${"f".repeat(64)}`,
        },
      },
    };
    await expect(
      fixture.service.rotateControllerEnvelope({
        ...rotationTarget,
        keyMaterialAcknowledgement,
        keyOperationAuthorization: invalidAuthorization,
        predecessorPrivateKey: fixture.controllerRsa.privateKey,
        successorPublicKey: successor.publicKey,
      }),
    ).rejects.toMatchObject({ code: "invalid-proof" });
    await fixture.service.rotateControllerEnvelope({
      ...rotationTarget,
      keyMaterialAcknowledgement,
      keyOperationAuthorization,
      predecessorPrivateKey: fixture.controllerRsa.privateKey,
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

function serviceFixture(
  initialCriticality: "decision-critical" | "supplementary",
  options: {
    readonly keyAuthorizerWallet?: ReturnType<typeof Wallet.createRandom>;
    readonly keyOperationAuthorizationRepository?: KeyOperationAuthorizationRepository;
  } = {},
) {
  const backend = new MemoryObjectStoreBackend();
  const primary = backend.forOrganization(ids.controllerOrg, { maxObjectBytes: 1_000_000 });
  const replica = backend.forOrganization(ids.replicaOrg, { maxObjectBytes: 1_000_000 });
  const authorWallet = Wallet.createRandom();
  const controllerWallet = Wallet.createRandom();
  const keyAuthorizerWallet = options.keyAuthorizerWallet ?? Wallet.createRandom();
  const keyOperationAuthorizationRepository =
    options.keyOperationAuthorizationRepository ??
    new InMemoryKeyOperationAuthorizationRepository();
  const controllerRsa = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  const keyMaterialSignerAddresses = new Map<string, string>();
  const controllerPrincipal = {
    actorId: ids.actorController,
    credentialId: ids.controllerCredential,
    organizationId: ids.controllerOrg,
  };
  keyMaterialSignerAddresses.set(
    principalKey(controllerPrincipal),
    controllerWallet.address.toLowerCase(),
  );
  const service = new EvidenceBundleService({
    chainId: 31_337,
    controllerRepositoryId: ids.repository,
    credentialAt: () => ({ active: true, validFrom: 0 }),
    keyOperationAuthorizer: {
      actorId: ids.actorKeyAuthorizer,
      address: keyAuthorizerWallet.address.toLowerCase(),
      credentialId: ids.keyAuthorizerCredential,
      organizationId: ids.keyAuthorizerOrg,
    },
    keyOperationAuthorizationRepository,
    keyMaterialAcknowledgementCredentialAt: (signer) => {
      const address = keyMaterialSignerAddresses.get(principalKey(signer));
      return {
        active: address !== undefined,
        address: address ?? "0x0000000000000000000000000000000000000000",
        validFrom: 0,
      };
    },
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
    keyAuthorizerWallet,
    keyOperationAuthorizationRepository,
    registerKeyMaterialSigner: (
      signer: ServicePrincipal,
      wallet: ReturnType<typeof Wallet.createRandom>,
    ) => {
      keyMaterialSignerAddresses.set(principalKey(signer), wallet.address.toLowerCase());
    },
    prepareInput,
    primary,
    replica,
    service,
  };
}

async function finalize(fixture: ReturnType<typeof serviceFixture>, bundleId: string, now: number) {
  const proofs = await signedProofs(fixture, bundleId, now);
  const keyOperationAuthorization = await signedKeyOperationAuthorization(
    fixture,
    {
      bundleId,
      finalization: proofs.finalization,
      operation: "verify-and-finalize-staging",
    },
    now,
    now,
  );
  return fixture.service.finalize({
    ...proofs,
    bundleId,
    controllerPrivateKey: fixture.controllerRsa.privateKey,
    keyOperationAuthorization,
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

async function signedKeyOperationAuthorization(
  fixture: ReturnType<typeof serviceFixture>,
  target: KeyOperationAuthorizationTarget,
  now: number,
  serial: number,
  options: {
    readonly claims?: KeyOperationAuthorizationClaims;
    readonly expiresAt?: number;
    readonly issuedAt?: number;
    readonly nonce?: string;
    readonly signer?: ReturnType<typeof Wallet.createRandom>;
  } = {},
) {
  const claims = options.claims ?? keyOperationClaims(serial);
  const message = fixture.service.keyOperationAuthorizationMessage(target, claims, {
    expiresAt: options.expiresAt ?? now + 60,
    idempotencyKeyHash: `0x${createHash("sha256").update(`key-operation:${serial}`).digest("hex")}`,
    issuedAt: options.issuedAt ?? now - 1,
    nonce: options.nonce ?? nonce(1_000 + serial),
  });
  const signature = await (options.signer ?? fixture.keyAuthorizerWallet).signTypedData(
    {
      chainId: 31_337,
      name: eip712Profiles.KeyOperationAuthorization.domainName,
      verifyingContract: "0x1111111111111111111111111111111111111111",
      version: "1",
    },
    {
      KeyOperationAuthorization: eip712Profiles.KeyOperationAuthorization.fields.map((field) => ({
        ...field,
      })),
    },
    message,
  );
  return { claims, proof: { message, signature } };
}

async function signedKeyMaterialAcknowledgement(
  fixture: ReturnType<typeof serviceFixture>,
  target: KeyMaterialAcknowledgementTarget,
  signer: ServicePrincipal,
  identityWallet: ReturnType<typeof Wallet.createRandom>,
  encryptionPrivateKey: KeyObject,
  now: number,
  serial: number,
) {
  const acknowledgementId = urn("assertion", 2_000 + serial);
  const acknowledgementVersion = 1;
  const message = fixture.service.keyMaterialAcknowledgementMessage(target, signer, {
    acknowledgementId,
    acknowledgementVersion,
    expiresAt: now + 60,
    issuedAt: now - 1,
    nonce: nonce(2_000 + serial),
  });
  const signature = await identityWallet.signTypedData(
    {
      chainId: 31_337,
      name: eip712Profiles.KeyMaterialAcknowledgement.domainName,
      verifyingContract: "0x1111111111111111111111111111111111111111",
      version: "1",
    },
    {
      KeyMaterialAcknowledgement: eip712Profiles.KeyMaterialAcknowledgement.fields.map((field) => ({
        ...field,
      })),
    },
    message,
  );
  const proof = { message, signature };
  return {
    acknowledgementId,
    acknowledgementVersion,
    keyPossessionProof: createRsaKeyPossessionProof(encryptionPrivateKey, proof),
    proof,
    signer,
  };
}

function keyOperationClaims(
  serial: number,
  requester = {
    actorId: ids.actorController,
    credentialId: ids.controllerCredential,
    organizationId: ids.controllerOrg,
  },
): KeyOperationAuthorizationClaims {
  return {
    authorizationId: urn("authorization", 1_000 + serial),
    authorizationVersion: 1,
    policyId: ids.policy,
    policyVersion: 1,
    purposeId: ids.purpose,
    requester,
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

function principalKey(principal: ServicePrincipal): string {
  return `${principal.actorId}|${principal.organizationId}|${principal.credentialId}`;
}
