import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  assertStagingLifecycleProfile,
  ProtectedObjectCoordinator,
  RepositoryStorageError,
} from "../../src/protected-bundles/repository/index.js";
import { MemoryObjectStoreBackend } from "../../src/protected-bundles/storage/index.js";

const orgA = "urn:evllm:org:123e4567-e89b-42d3-a456-426614174000";
const orgB = "urn:evllm:org:223e4567-e89b-42d3-a456-426614174000";
const sourceId = Buffer.alloc(32, 10).toString("base64url");
const destinationId = Buffer.alloc(32, 11).toString("base64url");
const replicaId = Buffer.alloc(32, 12).toString("base64url");
const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
const expected = { digest: digest(bytes), length: bytes.byteLength };

describe("protected object repository operations", () => {
  const backend = new MemoryObjectStoreBackend();
  const primary = backend.forOrganization(orgA, { maxObjectBytes: 1024 });
  const replica = backend.forOrganization(orgB, { maxObjectBytes: 1024 });
  const coordinator = new ProtectedObjectCoordinator();

  beforeEach(async () => {
    for (const store of [primary, replica]) {
      await store.delete(sourceId);
      await store.delete(destinationId);
      await store.delete(replicaId);
    }
  });

  it("promotes exact bytes and recovers an identical unpublished destination", async () => {
    await primary.putIfAbsent(sourceId, [bytes]);
    await expect(
      coordinator.promoteStagedObject(primary, {
        ...expected,
        destinationObjectId: destinationId,
        sourceObjectId: sourceId,
      }),
    ).resolves.toMatchObject({ status: "created" });
    await expect(
      coordinator.promoteStagedObject(primary, {
        ...expected,
        destinationObjectId: destinationId,
        sourceObjectId: sourceId,
      }),
    ).resolves.toMatchObject({ status: "recovered" });
  });

  it("recovers an exact final object after the staging source was lost post-copy", async () => {
    await primary.putIfAbsent(destinationId, [bytes]);
    await expect(
      coordinator.promoteStagedObject(primary, {
        ...expected,
        destinationObjectId: destinationId,
        sourceObjectId: sourceId,
      }),
    ).resolves.toMatchObject({ status: "recovered" });
  });

  it("rejects altered sources and conflicting destinations without revealing identifiers", async () => {
    await primary.putIfAbsent(sourceId, [Uint8Array.from([9, 9, 9, 9, 9])]);
    const altered = await coordinator
      .promoteStagedObject(primary, {
        ...expected,
        destinationObjectId: destinationId,
        sourceObjectId: sourceId,
      })
      .catch((error: unknown) => error);
    expect(altered).toBeInstanceOf(RepositoryStorageError);
    expect(String(altered)).not.toContain(sourceId);

    await primary.delete(sourceId);
    await primary.putIfAbsent(sourceId, [bytes]);
    await primary.putIfAbsent(destinationId, [Uint8Array.from([8, 8, 8, 8, 8])]);
    await expect(
      coordinator.promoteStagedObject(primary, {
        ...expected,
        destinationObjectId: destinationId,
        sourceObjectId: sourceId,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("serializes concurrent promotion and returns one creation plus one recovery", async () => {
    await primary.putIfAbsent(sourceId, [bytes]);
    const input = { ...expected, destinationObjectId: destinationId, sourceObjectId: sourceId };
    const results = await Promise.all([
      coordinator.promoteStagedObject(primary, input),
      coordinator.promoteStagedObject(primary, input),
    ]);
    expect(results.map(({ status }) => status).sort()).toEqual(["created", "recovered"]);
  });

  it("cleans unpublished destinations but preserves a finalized destination", async () => {
    const input = { ...expected, destinationObjectId: destinationId, sourceObjectId: sourceId };
    await primary.putIfAbsent(sourceId, [bytes]);
    await coordinator.promoteStagedObject(primary, input);
    await coordinator.cleanStaging(primary, input, () => Promise.resolve(false));
    expect(await primary.head(sourceId)).toBeNull();
    expect(await primary.head(destinationId)).toBeNull();

    await primary.putIfAbsent(sourceId, [bytes]);
    await coordinator.promoteStagedObject(primary, input);
    await coordinator.cleanStaging(primary, input, () => Promise.resolve(true));
    expect(await primary.head(sourceId)).toBeNull();
    expect(await primary.head(destinationId)).toEqual({ length: bytes.byteLength });
  });

  it("replicates exact bytes and uses the replica only for critical failover", async () => {
    await primary.putIfAbsent(destinationId, [bytes]);
    await coordinator.replicateExact(primary, destinationId, replica, replicaId, expected);
    await primary.delete(destinationId);

    await expect(
      coordinator.fetchWithFailover({
        ...expected,
        critical: true,
        primary: { objectId: destinationId, store: primary },
        replica: { objectId: replicaId, store: replica },
      }),
    ).resolves.toEqual({ bytes, source: "replica" });

    await expect(
      coordinator.fetchWithFailover({
        ...expected,
        critical: false,
        primary: { objectId: destinationId, store: primary },
        replica: { objectId: replicaId, store: replica },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("fails closed when a replica is substituted or corrupt", async () => {
    await replica.putIfAbsent(replicaId, [Uint8Array.from([5, 4, 3, 2, 1])]);
    await expect(
      coordinator.fetchWithFailover({
        ...expected,
        critical: true,
        primary: { objectId: destinationId, store: primary },
        replica: { objectId: replicaId, store: replica },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("requires native staging expiry to exceed every active and recovery interval", () => {
    const profile = {
      maxPreparationMaterializationSeconds: 30,
      maxDescriptorLifetimeSeconds: 60,
      maxFinalizationSeconds: 15,
      maxCleanupRecoverySeconds: 30,
      maxClockSkewSeconds: 5,
      nativeStagingTtlSeconds: 141,
    };
    expect(() => assertStagingLifecycleProfile(profile)).not.toThrow();
    expect(() =>
      assertStagingLifecycleProfile({ ...profile, nativeStagingTtlSeconds: 140 }),
    ).toThrow("must exceed");
    expect(() => assertStagingLifecycleProfile({ ...profile, maxFinalizationSeconds: -1 })).toThrow(
      "nonnegative",
    );
  });
});

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}
