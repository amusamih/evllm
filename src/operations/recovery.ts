import { createHash } from "node:crypto";

import type { OpaqueObjectStore } from "../protected-bundles/storage/index.js";

export interface BackupEntry {
  readonly object_id: string;
  readonly length: number;
  readonly sha256: string;
  readonly stored_envelope_base64: string;
}

export interface RepositoryBackup {
  readonly schema: "EVLLM_REPOSITORY_BACKUP_V1";
  readonly repository_namespace: string;
  readonly created_at: string;
  readonly entries: readonly BackupEntry[];
}

export class RecoveryError extends Error {
  public constructor(public readonly code: "conflict" | "integrity" | "namespace") {
    super("Repository recovery failed");
    this.name = "RecoveryError";
  }
}

export async function backupRepository(
  store: OpaqueObjectStore,
  inventory: readonly string[],
  now: () => Date = () => new Date(),
): Promise<RepositoryBackup> {
  const entries: BackupEntry[] = [];
  for (const objectId of [...new Set(inventory)].sort()) {
    const bytes = await collect(store.get(objectId));
    const head = await store.head(objectId);
    if (head === null || head.length !== bytes.byteLength) throw new RecoveryError("integrity");
    entries.push({
      object_id: objectId,
      length: bytes.byteLength,
      sha256: digest(bytes),
      stored_envelope_base64: Buffer.from(bytes).toString("base64"),
    });
  }
  return {
    schema: "EVLLM_REPOSITORY_BACKUP_V1",
    repository_namespace: store.namespace,
    created_at: now().toISOString(),
    entries,
  };
}

export async function restoreRepository(
  store: OpaqueObjectStore,
  backup: RepositoryBackup,
): Promise<{ readonly restored: number; readonly reused: number }> {
  if (backup.repository_namespace !== store.namespace) throw new RecoveryError("namespace");
  let restored = 0;
  let reused = 0;
  for (const entry of backup.entries) {
    const bytes = Uint8Array.from(Buffer.from(entry.stored_envelope_base64, "base64"));
    if (bytes.byteLength !== entry.length || digest(bytes) !== entry.sha256) {
      throw new RecoveryError("integrity");
    }
    const result = await store.putIfAbsent(entry.object_id, [bytes]);
    const verified = await collect(store.get(entry.object_id));
    if (verified.byteLength !== entry.length || digest(verified) !== entry.sha256) {
      throw new RecoveryError("conflict");
    }
    if (result.status === "created") restored += 1;
    else reused += 1;
  }
  return { restored, reused };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const value = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return value;
}

function digest(value: Uint8Array): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}
