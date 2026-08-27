import type { Pool, PoolClient } from "pg";

import { keyOperationAuthorization } from "../schemas/index.js";

export type KeyOperationAuthorizationRecord = ReturnType<typeof keyOperationAuthorization.parse>;

export interface KeyOperationAuthorizationRepository {
  consume(record: KeyOperationAuthorizationRecord, nonceScope: string): Promise<void>;
  find(
    authorizationId: string,
    authorizationVersion: number,
  ): Promise<KeyOperationAuthorizationRecord | undefined>;
}

export class KeyOperationAuthorizationRepositoryError extends Error {
  public constructor(
    public readonly code: "replay" | "unavailable",
    options?: ErrorOptions,
  ) {
    super("Key-operation authorization persistence failed", options);
    this.name = "KeyOperationAuthorizationRepositoryError";
  }
}

/** Explicit process-local adapter for tests; production services should use PostgreSQL. */
export class InMemoryKeyOperationAuthorizationState {
  public readonly authorizations = new Map<string, KeyOperationAuthorizationRecord>();
  public readonly nonceScopes = new Set<string>();
}

export class InMemoryKeyOperationAuthorizationRepository implements KeyOperationAuthorizationRepository {
  public constructor(private readonly state = new InMemoryKeyOperationAuthorizationState()) {}

  public consume(record: KeyOperationAuthorizationRecord, nonceScope: string): Promise<void> {
    const key = authorizationKey(record.authorization_id, record.authorization_version);
    if (this.state.authorizations.has(key) || this.state.nonceScopes.has(nonceScope)) {
      throw new KeyOperationAuthorizationRepositoryError("replay");
    }
    this.state.authorizations.set(key, structuredClone(record));
    this.state.nonceScopes.add(nonceScope);
    return Promise.resolve();
  }

  public find(
    authorizationId: string,
    authorizationVersion: number,
  ): Promise<KeyOperationAuthorizationRecord | undefined> {
    const record = this.state.authorizations.get(
      authorizationKey(authorizationId, authorizationVersion),
    );
    return Promise.resolve(record === undefined ? undefined : structuredClone(record));
  }
}

export class PostgresKeyOperationAuthorizationRepository implements KeyOperationAuthorizationRepository {
  public constructor(private readonly pool: Pool) {}

  public async consume(record: KeyOperationAuthorizationRecord, nonceScope: string): Promise<void> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw new KeyOperationAuthorizationRepositoryError("unavailable", { cause: error });
    }
    try {
      await client.query("BEGIN");
      await lockNonceScope(client, nonceScope);
      const existing = await client.query(
        `SELECT 1
           FROM repository_private.key_operation_capabilities
          WHERE (record_id = $1 AND record_version = $2)
             OR metadata->>'nonce_scope' = $3
          LIMIT 1`,
        [record.authorization_id, record.authorization_version, nonceScope],
      );
      if ((existing.rowCount ?? 0) > 0) {
        throw new KeyOperationAuthorizationRepositoryError("replay");
      }
      await client.query(
        `INSERT INTO repository_private.key_operation_capabilities
          (record_id, record_version, bundle_id, bundle_version, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          record.authorization_id,
          record.authorization_version,
          record.bundle_id,
          record.bundle_version,
          record.state,
          JSON.stringify({ authorization: record, nonce_scope: nonceScope }),
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof KeyOperationAuthorizationRepositoryError) throw error;
      if (isUniqueViolation(error)) {
        throw new KeyOperationAuthorizationRepositoryError("replay", { cause: error });
      }
      throw new KeyOperationAuthorizationRepositoryError("unavailable", { cause: error });
    } finally {
      client.release();
    }
  }

  public async find(
    authorizationId: string,
    authorizationVersion: number,
  ): Promise<KeyOperationAuthorizationRecord | undefined> {
    try {
      const result = await this.pool.query<{ authorization: unknown }>(
        `SELECT metadata->'authorization' AS authorization
           FROM repository_private.key_operation_capabilities
          WHERE record_id = $1 AND record_version = $2`,
        [authorizationId, authorizationVersion],
      );
      const authorization = result.rows[0]?.authorization;
      return authorization === undefined
        ? undefined
        : keyOperationAuthorization.parse(authorization);
    } catch (error) {
      if (error instanceof KeyOperationAuthorizationRepositoryError) throw error;
      throw new KeyOperationAuthorizationRepositoryError("unavailable", { cause: error });
    }
  }
}

function authorizationKey(authorizationId: string, authorizationVersion: number): string {
  return `${authorizationId}:${authorizationVersion}`;
}

async function lockNonceScope(client: PoolClient, nonceScope: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [nonceScope]);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
