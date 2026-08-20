import { constants } from "node:fs";
import { access, link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  assertNotAborted,
  type ByteSource,
  type ObjectHead,
  type OpaqueObjectStore,
  ObjectStoreError,
  type PutIfAbsentResult,
} from "./types.js";
import { namespaceKey, validateObjectId } from "./validation.js";

export interface FilesystemObjectStoreOptions {
  readonly maxObjectBytes: number;
  readonly rootDirectory: string;
}

export class FilesystemObjectStore implements OpaqueObjectStore {
  public readonly namespace: string;
  readonly #directory: string;

  public constructor(
    organizationId: string,
    private readonly options: FilesystemObjectStoreOptions,
  ) {
    this.namespace = organizationId;
    this.#directory = resolve(options.rootDirectory, namespaceKey(organizationId));
  }

  public async delete(objectId: string): Promise<boolean> {
    await this.initialize();
    try {
      await unlink(this.path(objectId));
      return true;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return false;
      throw error;
    }
  }

  public async *get(objectId: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    assertNotAborted(signal);
    await this.initialize();
    try {
      const value = await readFile(this.path(objectId), { signal });
      yield value;
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      if (hasCode(error, "ABORT_ERR")) {
        throw new ObjectStoreError("aborted", "Storage operation was cancelled");
      }
      throw error;
    }
  }

  public async head(objectId: string): Promise<ObjectHead | null> {
    await this.initialize();
    try {
      const metadata = await stat(this.path(objectId));
      return { length: metadata.size };
    } catch (error) {
      if (hasCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  public async health(): Promise<"ready" | "unavailable"> {
    try {
      await this.initialize();
      await access(this.#directory, constants.R_OK | constants.W_OK);
      return "ready";
    } catch {
      return "unavailable";
    }
  }

  public async putIfAbsent(
    objectId: string,
    source: ByteSource,
    signal?: AbortSignal,
  ): Promise<PutIfAbsentResult> {
    assertNotAborted(signal);
    await this.initialize();
    const destination = this.path(objectId);
    const existing = await this.head(objectId);
    if (existing !== null) return { ...existing, status: "exists" };

    const temporary = resolve(this.#directory, `.pending-${randomBytes(16).toString("hex")}`);
    let length = 0;
    const handle = await open(temporary, "wx", 0o600);
    try {
      for await (const chunk of source) {
        assertNotAborted(signal);
        length += chunk.byteLength;
        if (length > this.options.maxObjectBytes) {
          throw new ObjectStoreError("object-too-large", "Object exceeds configured maximum");
        }
        await handle.writeFile(chunk);
      }
      await handle.sync();
      await handle.close();
      try {
        await link(temporary, destination);
        return { length, status: "created" };
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const winner = await stat(destination);
        return { length: winner.size, status: "exists" };
      }
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async initialize(): Promise<void> {
    await mkdir(this.#directory, { recursive: true });
  }

  private path(objectId: string): string {
    return resolve(this.#directory, validateObjectId(objectId));
  }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
