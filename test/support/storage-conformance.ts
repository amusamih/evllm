import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ProtectedObjectCoordinator,
  RepositoryStorageError,
} from "../../src/protected-bundles/repository/index.js";
import {
  type ByteSource,
  type OpaqueObjectStore,
  ObjectStoreError,
} from "../../src/protected-bundles/storage/index.js";

export interface StorageConformanceOptions {
  readonly create: (organizationId: string) => OpaqueObjectStore;
  readonly maxObjectBytes: number;
  readonly organizations: readonly [string, string];
}

export function runOpaqueObjectStoreConformance(options: StorageConformanceOptions): void {
  describe("shared opaque-byte conformance", () => {
    const firstId = Buffer.alloc(32, 1).toString("base64url");
    const emptyId = Buffer.alloc(32, 2).toString("base64url");
    const boundaryId = Buffer.alloc(32, 3).toString("base64url");

    it("round trips empty, small, and maximum-size objects exactly", async () => {
      const startedAt = performance.now();
      const initialHeap = process.memoryUsage().heapUsed;
      const store = options.create(options.organizations[0]);
      for (const [objectId, bytes] of [
        [emptyId, new Uint8Array()],
        [firstId, Uint8Array.from([0, 1, 2, 255])],
        [boundaryId, new Uint8Array(options.maxObjectBytes).fill(7)],
      ] as const) {
        await store.delete(objectId);
        expect(await store.putIfAbsent(objectId, chunks(bytes))).toEqual({
          length: bytes.byteLength,
          status: "created",
        });
        expect(await store.head(objectId)).toEqual({ length: bytes.byteLength });
        expect(await collect(store.get(objectId))).toEqual(bytes);
      }
      expect(await store.health()).toBe("ready");
      expect(performance.now() - startedAt).toBeLessThan(30_000);
      expect(process.memoryUsage().heapUsed - initialHeap).toBeLessThan(
        options.maxObjectBytes * 32 + 128 * 1024 * 1024,
      );
    });

    it("never overwrites an existing object", async () => {
      const store = options.create(options.organizations[0]);
      const original = Uint8Array.from([1, 2, 3]);
      await store.delete(firstId);
      await store.putIfAbsent(firstId, chunks(original));
      expect(await store.putIfAbsent(firstId, chunks(Uint8Array.from([9])))).toEqual({
        length: original.byteLength,
        status: "exists",
      });
      expect(await collect(store.get(firstId))).toEqual(original);
    });

    it("isolates organization namespaces", async () => {
      const first = options.create(options.organizations[0]);
      const second = options.create(options.organizations[1]);
      await first.delete(firstId);
      await second.delete(firstId);
      await first.putIfAbsent(firstId, chunks(Uint8Array.from([4])));
      expect(await second.head(firstId)).toBeNull();
      expect(await collect(second.get(firstId))).toEqual(new Uint8Array());
    });

    it("rejects traversal-shaped identifiers before backend access", async () => {
      const store = options.create(options.organizations[0]);
      await expect(
        store.putIfAbsent("../secret", chunks(Uint8Array.from([1]))),
      ).rejects.toMatchObject({
        code: "invalid-object-id",
      });
    });

    it("rejects oversized and cancelled writes without publishing them", async () => {
      const store = options.create(options.organizations[0]);
      await store.delete(boundaryId);
      await expect(
        store.putIfAbsent(boundaryId, chunks(new Uint8Array(options.maxObjectBytes + 1))),
      ).rejects.toBeInstanceOf(ObjectStoreError);
      expect(await store.head(boundaryId)).toBeNull();

      const controller = new AbortController();
      controller.abort();
      await expect(
        store.putIfAbsent(boundaryId, chunks(Uint8Array.from([1])), controller.signal),
      ).rejects.toMatchObject({ code: "aborted" });
      expect(await store.head(boundaryId)).toBeNull();
    });

    it("deletes idempotently", async () => {
      const store = options.create(options.organizations[0]);
      await store.putIfAbsent(firstId, chunks(Uint8Array.from([1])));
      expect(await store.delete(firstId)).toBe(true);
      expect(await store.delete(firstId)).toBe(false);
    });

    it("resets its known inventory without exposing a list operation", async () => {
      const store = options.create(options.organizations[0]);
      const inventory = [firstId, emptyId, boundaryId];
      for (const objectId of inventory) {
        await store.delete(objectId);
        await store.putIfAbsent(objectId, chunks(Uint8Array.from([1])));
      }
      for (const objectId of inventory) expect(await store.delete(objectId)).toBe(true);
      for (const objectId of inventory) expect(await store.head(objectId)).toBeNull();
      expect("list" in store).toBe(false);
    });

    it("fails deterministically on backend outage and timeout", async () => {
      const base = options.create(options.organizations[0]);
      const input = {
        destinationObjectId: Buffer.alloc(32, 26).toString("base64url"),
        digest: digest(Uint8Array.from([1])),
        length: 1,
        sourceObjectId: Buffer.alloc(32, 27).toString("base64url"),
      };
      const unavailable = delegate(base, {
        head: () => Promise.reject(new ObjectStoreError("unavailable", "backend unavailable")),
      });
      await expect(
        new ProtectedObjectCoordinator(100).promoteStagedObject(unavailable, input),
      ).rejects.toMatchObject({ code: "unavailable" });

      const hanging = delegate(base, { head: () => new Promise(() => undefined) });
      await expect(
        new ProtectedObjectCoordinator(25).promoteStagedObject(hanging, input),
      ).rejects.toMatchObject({ code: "timeout" });
    });

    it("promotes conditionally, recovers identical bytes, and rejects conflicts", async () => {
      const store = options.create(options.organizations[0]);
      const coordinator = new ProtectedObjectCoordinator();
      const sourceId = Buffer.alloc(32, 20).toString("base64url");
      const destinationId = Buffer.alloc(32, 21).toString("base64url");
      const value = Uint8Array.from([10, 20, 30]);
      const expected = { digest: digest(value), length: value.byteLength };
      await store.delete(sourceId);
      await store.delete(destinationId);
      await store.putIfAbsent(sourceId, chunks(value));
      await expect(
        coordinator.promoteStagedObject(store, {
          ...expected,
          destinationObjectId: destinationId,
          sourceObjectId: sourceId,
        }),
      ).resolves.toMatchObject({ status: "created" });
      await expect(
        coordinator.promoteStagedObject(store, {
          ...expected,
          destinationObjectId: destinationId,
          sourceObjectId: sourceId,
        }),
      ).resolves.toMatchObject({ status: "recovered" });

      await store.delete(destinationId);
      await store.putIfAbsent(destinationId, chunks(Uint8Array.from([30, 20, 10])));
      await expect(
        coordinator.promoteStagedObject(store, {
          ...expected,
          destinationObjectId: destinationId,
          sourceObjectId: sourceId,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    });

    it("serializes finalization against expiry cleanup", async () => {
      const base = options.create(options.organizations[0]);
      const coordinator = new ProtectedObjectCoordinator(5_000);
      const sourceObjectId = Buffer.alloc(32, 28).toString("base64url");
      const destinationObjectId = Buffer.alloc(32, 29).toString("base64url");
      const value = Uint8Array.from([7, 8, 9]);
      const input = {
        destinationObjectId,
        sourceObjectId,
        digest: digest(value),
        length: value.byteLength,
      };
      await base.delete(sourceObjectId);
      await base.delete(destinationObjectId);
      await base.putIfAbsent(sourceObjectId, [value]);

      let releaseCopy = (): void => undefined;
      let signalCopy = (): void => undefined;
      const copyStarted = new Promise<void>((resolve) => (signalCopy = resolve));
      const copyGate = new Promise<void>((resolve) => (releaseCopy = resolve));
      const gated = delegate(base, {
        async putIfAbsent(objectId, source, signal) {
          if (objectId === destinationObjectId) {
            signalCopy();
            await copyGate;
          }
          return base.putIfAbsent(objectId, source, signal);
        },
      });
      const promotion = coordinator.promoteStagedObject(gated, input);
      await copyStarted;
      let cleanupChecked = false;
      const cleanup = coordinator.cleanStaging(gated, input, () => {
        cleanupChecked = true;
        return Promise.resolve(true);
      });
      await Promise.resolve();
      expect(cleanupChecked).toBe(false);
      releaseCopy();
      await promotion;
      await cleanup;
      expect(cleanupChecked).toBe(true);
      expect(await base.head(sourceObjectId)).toBeNull();
      expect(await base.head(destinationObjectId)).toEqual({ length: value.byteLength });
    });

    it("replicates byte-identically and fails over only when critical", async () => {
      const primary = options.create(options.organizations[0]);
      const replica = options.create(options.organizations[1]);
      const coordinator = new ProtectedObjectCoordinator();
      const primaryId = Buffer.alloc(32, 22).toString("base64url");
      const replicaId = Buffer.alloc(32, 23).toString("base64url");
      const value = Uint8Array.from([4, 5, 6, 7]);
      const expected = { digest: digest(value), length: value.byteLength };
      await primary.delete(primaryId);
      await replica.delete(replicaId);
      await primary.putIfAbsent(primaryId, chunks(value));
      await coordinator.replicateExact(primary, primaryId, replica, replicaId, expected);
      await primary.delete(primaryId);

      await expect(
        coordinator.fetchWithFailover({
          ...expected,
          critical: true,
          primary: { objectId: primaryId, store: primary },
          replica: { objectId: replicaId, store: replica },
        }),
      ).resolves.toEqual({ bytes: value, source: "replica" });
      await expect(
        coordinator.fetchWithFailover({
          ...expected,
          critical: false,
          primary: { objectId: primaryId, store: primary },
          replica: { objectId: replicaId, store: replica },
        }),
      ).rejects.toBeInstanceOf(RepositoryStorageError);
    });

    it("publishes no list operation or confidential error detail", async () => {
      const store = options.create(options.organizations[0]);
      expect("list" in store).toBe(false);
      const missingId = Buffer.alloc(32, 24).toString("base64url");
      const coordinator = new ProtectedObjectCoordinator();
      const error = await coordinator
        .promoteStagedObject(store, {
          destinationObjectId: Buffer.alloc(32, 25).toString("base64url"),
          digest: digest(Uint8Array.from([99])),
          length: 1,
          sourceObjectId: missingId,
        })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(RepositoryStorageError);
      expect(String(error)).not.toContain(missingId);
      expect(String(error)).not.toContain("99");
    });
  });
}

function delegate(
  base: OpaqueObjectStore,
  overrides: Partial<OpaqueObjectStore>,
): OpaqueObjectStore {
  return {
    namespace: base.namespace,
    delete: overrides.delete?.bind(overrides) ?? base.delete.bind(base),
    get: overrides.get?.bind(overrides) ?? base.get.bind(base),
    head: overrides.head?.bind(overrides) ?? base.head.bind(base),
    health: overrides.health?.bind(overrides) ?? base.health.bind(base),
    putIfAbsent: overrides.putIfAbsent?.bind(overrides) ?? base.putIfAbsent.bind(base),
  };
}

function* chunks(bytes: Uint8Array): ByteSource {
  const split = Math.floor(bytes.byteLength / 2);
  yield bytes.slice(0, split);
  yield bytes.slice(split);
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}
