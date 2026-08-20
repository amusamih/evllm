import { Readable } from "node:stream";

import {
  assertNotAborted,
  type ByteSource,
  type ObjectHead,
  type OpaqueObjectStore,
  ObjectStoreError,
  type PutIfAbsentResult,
} from "./types.js";
import { namespaceKey, validateObjectId } from "./validation.js";

export interface MemoryObjectStoreOptions {
  readonly maxObjectBytes: number;
}

export class MemoryObjectStoreBackend {
  readonly #objects = new Map<string, Uint8Array>();

  public forOrganization(
    organizationId: string,
    options: MemoryObjectStoreOptions,
  ): OpaqueObjectStore {
    return new MemoryObjectStore(this.#objects, organizationId, options);
  }
}

class MemoryObjectStore implements OpaqueObjectStore {
  public readonly namespace: string;
  readonly #prefix: string;

  public constructor(
    private readonly objects: Map<string, Uint8Array>,
    organizationId: string,
    private readonly options: MemoryObjectStoreOptions,
  ) {
    this.namespace = organizationId;
    this.#prefix = `${namespaceKey(organizationId)}:`;
  }

  public delete(objectId: string): Promise<boolean> {
    return Promise.resolve(this.objects.delete(this.key(objectId)));
  }

  public get(objectId: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    assertNotAborted(signal);
    const value = this.objects.get(this.key(objectId));
    return Readable.from(value === undefined ? [] : [value.slice()]);
  }

  public head(objectId: string): Promise<ObjectHead | null> {
    const value = this.objects.get(this.key(objectId));
    return Promise.resolve(value === undefined ? null : { length: value.byteLength });
  }

  public health(): Promise<"ready"> {
    return Promise.resolve("ready");
  }

  public async putIfAbsent(
    objectId: string,
    source: ByteSource,
    signal?: AbortSignal,
  ): Promise<PutIfAbsentResult> {
    const key = this.key(objectId);
    const existing = this.objects.get(key);
    if (existing !== undefined) {
      return { length: existing.byteLength, status: "exists" };
    }
    const value = await collect(source, this.options.maxObjectBytes, signal);
    if (this.objects.has(key)) {
      const winner = this.objects.get(key);
      if (winner === undefined) {
        throw new ObjectStoreError("unavailable", "Concurrent object creation failed");
      }
      return { length: winner.byteLength, status: "exists" };
    }
    this.objects.set(key, value);
    return { length: value.byteLength, status: "created" };
  }

  private key(objectId: string): string {
    return `${this.#prefix}${validateObjectId(objectId)}`;
  }
}

async function collect(
  source: ByteSource,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    assertNotAborted(signal);
    length += chunk.byteLength;
    if (length > maximum) {
      throw new ObjectStoreError("object-too-large", "Object exceeds configured maximum");
    }
    chunks.push(chunk.slice());
  }
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}
