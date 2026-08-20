export type ByteSource = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

export interface ObjectHead {
  readonly length: number;
}

export interface PutIfAbsentResult {
  readonly length: number;
  readonly status: "created" | "exists";
}

export interface OpaqueObjectStore {
  readonly namespace: string;
  delete(objectId: string): Promise<boolean>;
  get(objectId: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  head(objectId: string): Promise<ObjectHead | null>;
  health(): Promise<"ready" | "unavailable">;
  putIfAbsent(
    objectId: string,
    source: ByteSource,
    signal?: AbortSignal,
  ): Promise<PutIfAbsentResult>;
}

export type ObjectStoreErrorCode =
  "aborted" | "invalid-object-id" | "object-too-large" | "unavailable";

export class ObjectStoreError extends Error {
  public constructor(
    public readonly code: ObjectStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ObjectStoreError("aborted", "Storage operation was cancelled");
  }
}
