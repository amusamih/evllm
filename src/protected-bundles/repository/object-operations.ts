import { createHash } from "node:crypto";

import type { OpaqueObjectStore } from "../storage/index.js";

export interface ExpectedObject {
  readonly digest: string;
  readonly length: number;
}

export interface PromotionInput extends ExpectedObject {
  readonly destinationObjectId: string;
  readonly sourceObjectId: string;
}

export interface PromotionResult extends ExpectedObject {
  readonly status: "created" | "recovered";
}

export interface FailoverInput extends ExpectedObject {
  readonly critical: boolean;
  readonly primary: { readonly objectId: string; readonly store: OpaqueObjectStore };
  readonly replica?: { readonly objectId: string; readonly store: OpaqueObjectStore };
}

export class RepositoryStorageError extends Error {
  public constructor(
    public readonly code: "conflict" | "integrity-mismatch" | "timeout" | "unavailable",
  ) {
    super("Protected object is unavailable");
    this.name = "RepositoryStorageError";
  }
}

export class ProtectedObjectCoordinator {
  readonly #locks = new Map<string, Promise<void>>();

  public constructor(private readonly operationTimeoutMs = 30_000) {
    if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
      throw new RangeError("operationTimeoutMs must be a positive safe integer");
    }
  }

  public async promoteStagedObject(
    store: OpaqueObjectStore,
    input: PromotionInput,
  ): Promise<PromotionResult> {
    return this.withTimeout(
      this.withLock(lockKey(store, input), async () => {
        if (await store.head(input.destinationObjectId)) {
          try {
            await readVerified(store, input.destinationObjectId, input);
            return { digest: input.digest, length: input.length, status: "recovered" };
          } catch {
            throw new RepositoryStorageError("conflict");
          }
        }
        const bytes = await readVerified(store, input.sourceObjectId, input);
        const result = await store.putIfAbsent(input.destinationObjectId, [bytes]);
        try {
          await readVerified(store, input.destinationObjectId, input);
        } catch (error) {
          if (result.status === "exists") throw new RepositoryStorageError("conflict");
          throw error;
        }
        return {
          digest: input.digest,
          length: input.length,
          status: result.status === "created" ? "created" : "recovered",
        };
      }),
    );
  }

  public async cleanStaging(
    store: OpaqueObjectStore,
    input: PromotionInput,
    hasFinalizedManifest: () => Promise<boolean>,
  ): Promise<void> {
    await this.withTimeout(
      this.withLock(lockKey(store, input), async () => {
        const finalized = await hasFinalizedManifest();
        await store.delete(input.sourceObjectId);
        if (!finalized) await store.delete(input.destinationObjectId);
      }),
    );
  }

  public async replicateExact(
    sourceStore: OpaqueObjectStore,
    sourceObjectId: string,
    replicaStore: OpaqueObjectStore,
    replicaObjectId: string,
    expected: ExpectedObject,
  ): Promise<PromotionResult> {
    return this.withTimeout(
      this.replicate(sourceStore, sourceObjectId, replicaStore, replicaObjectId, expected),
    );
  }

  private async replicate(
    sourceStore: OpaqueObjectStore,
    sourceObjectId: string,
    replicaStore: OpaqueObjectStore,
    replicaObjectId: string,
    expected: ExpectedObject,
  ): Promise<PromotionResult> {
    const bytes = await readVerified(sourceStore, sourceObjectId, expected);
    const result = await replicaStore.putIfAbsent(replicaObjectId, [bytes]);
    try {
      await readVerified(replicaStore, replicaObjectId, expected);
    } catch (error) {
      if (result.status === "exists") throw new RepositoryStorageError("conflict");
      throw error;
    }
    return {
      ...expected,
      status: result.status === "created" ? "created" : "recovered",
    };
  }

  public async fetchWithFailover(
    input: FailoverInput,
  ): Promise<{ readonly bytes: Uint8Array; readonly source: "primary" | "replica" }> {
    return this.withTimeout(this.fetch(input));
  }

  private async fetch(
    input: FailoverInput,
  ): Promise<{ readonly bytes: Uint8Array; readonly source: "primary" | "replica" }> {
    try {
      return {
        bytes: await readVerified(input.primary.store, input.primary.objectId, input),
        source: "primary",
      };
    } catch {
      if (!input.critical || input.replica === undefined) {
        throw new RepositoryStorageError("unavailable");
      }
    }
    try {
      return {
        bytes: await readVerified(input.replica.store, input.replica.objectId, input),
        source: "replica",
      };
    } catch {
      throw new RepositoryStorageError("unavailable");
    }
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RepositoryStorageError("timeout")),
        this.operationTimeoutMs,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.#locks.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
    }
  }
}

export interface StagingLifecycleProfile {
  readonly maxPreparationMaterializationSeconds: number;
  readonly maxDescriptorLifetimeSeconds: number;
  readonly maxFinalizationSeconds: number;
  readonly maxCleanupRecoverySeconds: number;
  readonly maxClockSkewSeconds: number;
  readonly nativeStagingTtlSeconds: number;
}

export function assertStagingLifecycleProfile(profile: StagingLifecycleProfile): void {
  const values = Object.values(profile);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError("Staging lifecycle durations must be nonnegative safe integers");
  }
  const requiredMinimum =
    profile.maxPreparationMaterializationSeconds +
    profile.maxDescriptorLifetimeSeconds +
    profile.maxFinalizationSeconds +
    profile.maxCleanupRecoverySeconds +
    profile.maxClockSkewSeconds;
  if (profile.nativeStagingTtlSeconds <= requiredMinimum) {
    throw new RangeError("Native staging TTL must exceed every active/recovery interval plus skew");
  }
}

async function readVerified(
  store: OpaqueObjectStore,
  objectId: string,
  expected: ExpectedObject,
): Promise<Uint8Array> {
  const head = await store.head(objectId);
  if (head === null) throw new RepositoryStorageError("unavailable");
  if (head.length !== expected.length) throw new RepositoryStorageError("integrity-mismatch");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const hash = createHash("sha256");
  for await (const chunk of store.get(objectId)) {
    length += chunk.byteLength;
    if (length > expected.length) throw new RepositoryStorageError("integrity-mismatch");
    hash.update(chunk);
    chunks.push(chunk);
  }
  if (length !== expected.length || hash.digest("base64url") !== expected.digest) {
    throw new RepositoryStorageError("integrity-mismatch");
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function lockKey(store: OpaqueObjectStore, input: PromotionInput): string {
  return `${store.namespace}:${input.sourceObjectId}:${input.destinationObjectId}`;
}
