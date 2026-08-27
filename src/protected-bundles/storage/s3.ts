import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";

import {
  assertNotAborted,
  type ByteSource,
  type ObjectHead,
  type OpaqueObjectStore,
  ObjectStoreError,
  type PutIfAbsentResult,
} from "./types.js";
import { namespaceKey, validateObjectId } from "./validation.js";

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  readonly client: S3Client;
  readonly maxObjectBytes: number;
  readonly organizationId: string;
}

export class S3ObjectStore implements OpaqueObjectStore {
  public readonly namespace: string;
  readonly #prefix: string;

  public constructor(private readonly options: S3ObjectStoreOptions) {
    this.namespace = options.organizationId;
    this.#prefix = `${namespaceKey(options.organizationId)}/`;
  }

  public async delete(objectId: string): Promise<boolean> {
    if ((await this.head(objectId)) === null) return false;
    await this.options.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.key(objectId) }),
    );
    return true;
  }

  public async *get(objectId: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
    assertNotAborted(signal);
    try {
      const command = new GetObjectCommand({
        Bucket: this.options.bucket,
        Key: this.key(objectId),
      });
      const response =
        signal === undefined
          ? await this.options.client.send(command)
          : await this.options.client.send(command, { abortSignal: signal });
      const body = response.Body;
      if (body === undefined || !(Symbol.asyncIterator in body)) return;
      for await (const chunk of body as AsyncIterable<Uint8Array>) {
        assertNotAborted(signal);
        yield Uint8Array.from(chunk);
      }
    } catch (error) {
      if (isStatus(error, 404)) return;
      throw mapS3Error(error);
    }
  }

  public async head(objectId: string): Promise<ObjectHead | null> {
    try {
      const response = await this.options.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: this.key(objectId) }),
      );
      return { length: response.ContentLength ?? 0 };
    } catch (error) {
      if (isStatus(error, 404)) return null;
      throw mapS3Error(error);
    }
  }

  public async health(): Promise<"ready" | "unavailable"> {
    try {
      await this.options.client.send(new HeadBucketCommand({ Bucket: this.options.bucket }));
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
    const body = await collect(source, this.options.maxObjectBytes, signal);
    try {
      const command = new PutObjectCommand({
        Body: body,
        Bucket: this.options.bucket,
        ContentLength: body.byteLength,
        IfNoneMatch: "*",
        Key: this.key(objectId),
      });
      if (signal === undefined) await this.options.client.send(command);
      else await this.options.client.send(command, { abortSignal: signal });
      return { length: body.byteLength, status: "created" };
    } catch (error) {
      if (isStatus(error, 409) || isStatus(error, 412)) {
        const existing = await this.head(objectId);
        if (existing === null) throw mapS3Error(error);
        return { ...existing, status: "exists" };
      }
      throw mapS3Error(error);
    }
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
    chunks.push(chunk);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isStatus(error: unknown, status: number): boolean {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return false;
  const metadata = error.$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === status
  );
}

function mapS3Error(error: unknown): ObjectStoreError {
  if (error instanceof ObjectStoreError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  ) {
    return new ObjectStoreError("aborted", "Storage operation was cancelled");
  }
  return new ObjectStoreError("unavailable", "Object storage operation failed");
}
