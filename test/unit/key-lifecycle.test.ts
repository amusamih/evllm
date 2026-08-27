import { describe, expect, it } from "vitest";

import { KeyLifecycleRegistry } from "../../src/protected-bundles/keys/index.js";

describe("protected-bundle key and grant lifecycle", () => {
  it("activates a grant only after its envelope verifies", async () => {
    const registry = initializedRegistry();
    registry.addKey({ id: "recipient-1", organizationId: "recipient", state: "active" });
    registry.prepareGrant({
      effectiveAt: 10,
      envelopeId: "envelope-1",
      expiresAt: 100,
      grantId: "grant-1",
      recipientKeyId: "recipient-1",
      state: "prepared",
    });
    await expect(
      registry.activateGrant("grant-1", 20, () => Promise.resolve(false)),
    ).rejects.toThrow();
    expect(registry.effectiveGrantState("grant-1", 20)).toBe("prepared");
    await registry.activateGrant("grant-1", 20, () => Promise.resolve(true));
    expect(() => registry.authorizeRetrieval("grant-1", 20)).not.toThrow();
  });

  it("derives expiry and makes revocation irreversible", async () => {
    const registry = await activeGrantRegistry();
    expect(registry.effectiveGrantState("grant-1", 101)).toBe("expired");
    expect(() => registry.authorizeRetrieval("grant-1", 101)).toThrow();
    registry.revokeGrant("grant-1");
    expect(registry.effectiveGrantState("grant-1", 20)).toBe("revoked");
    expect(() => registry.revokeGrant("grant-1")).toThrow();
  });

  it("denies lost and compromised recipient keys without rewriting the grant", async () => {
    for (const state of ["lost", "compromised"] as const) {
      const registry = await activeGrantRegistry();
      registry.recordKeyFailure("recipient-1", state);
      expect(() => registry.authorizeRetrieval("grant-1", 20)).toThrow();
      expect(registry.snapshot().grants[0]?.state).toBe("active");
    }
  });

  it("rotates a recipient envelope atomically and retains predecessor on failure", async () => {
    const registry = await activeGrantRegistry();
    registry.addKey({ id: "recipient-2", organizationId: "recipient", state: "active" });
    await expect(
      registry.rotateRecipientEnvelope("grant-1", "recipient-2", "envelope-2", () =>
        Promise.resolve(false),
      ),
    ).rejects.toThrow();
    expect(registry.snapshot().grants[0]?.recipientKeyId).toBe("recipient-1");
    await registry.rotateRecipientEnvelope("grant-1", "recipient-2", "envelope-2", () =>
      Promise.resolve(true),
    );
    expect(registry.snapshot().grants[0]).toMatchObject({
      envelopeId: "envelope-2",
      recipientKeyId: "recipient-2",
      state: "active",
    });
  });

  it("activates a successor controller before retiring its predecessor", async () => {
    const registry = initializedRegistry();
    registry.addKey({ id: "controller-2", organizationId: "controller", state: "active" });
    await registry.rotateControllerAuthorization(
      "authorization-1",
      {
        authorizationId: "authorization-2",
        envelopeId: "controller-envelope-2",
        keyId: "controller-2",
        state: "staged",
      },
      () => Promise.resolve(true),
    );
    expect(registry.snapshot().authorizations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ authorizationId: "authorization-1", state: "retired" }),
        expect.objectContaining({ authorizationId: "authorization-2", state: "active" }),
      ]),
    );
  });

  it("forbids retirement of the last usable controller path", () => {
    const registry = initializedRegistry();
    expect(() => registry.retireKey("controller-1")).toThrow();
    registry.recordKeyFailure("controller-1", "lost");
    expect(() =>
      registry.prepareGrant({
        effectiveAt: 1,
        envelopeId: "new-envelope",
        expiresAt: 2,
        grantId: "new-grant",
        recipientKeyId: "controller-1",
        state: "prepared",
      }),
    ).toThrow();
  });

  it("hydrates a canonical snapshot without weakening restart enforcement", async () => {
    const before = await activeGrantRegistry();
    before.recordKeyFailure("recipient-1", "compromised");
    const persisted = JSON.parse(JSON.stringify(before.snapshot())) as unknown;
    const after = KeyLifecycleRegistry.fromSnapshot(persisted);

    expect(after.snapshot()).toEqual(before.snapshot());
    expect(() => after.authorizeRetrieval("grant-1", 20)).toThrow();
    expect(() => after.retireKey("controller-1")).toThrow();
    expect(() =>
      KeyLifecycleRegistry.fromSnapshot({
        keys: [],
        grants: [],
        authorizations: [{ keyId: "missing" }],
      }),
    ).toThrow();
  });
});

function initializedRegistry(): KeyLifecycleRegistry {
  const registry = new KeyLifecycleRegistry();
  registry.addKey({ id: "controller-1", organizationId: "controller", state: "pending" });
  registry.activateKey("controller-1");
  registry.stageControllerAuthorization({
    authorizationId: "authorization-1",
    envelopeId: "controller-envelope-1",
    keyId: "controller-1",
    state: "staged",
  });
  registry.activateControllerAuthorization("authorization-1");
  return registry;
}

async function activeGrantRegistry(): Promise<KeyLifecycleRegistry> {
  const registry = initializedRegistry();
  registry.addKey({ id: "recipient-1", organizationId: "recipient", state: "active" });
  registry.prepareGrant({
    effectiveAt: 10,
    envelopeId: "envelope-1",
    expiresAt: 100,
    grantId: "grant-1",
    recipientKeyId: "recipient-1",
    state: "prepared",
  });
  await registry.activateGrant("grant-1", 20, () => Promise.resolve(true));
  return registry;
}
