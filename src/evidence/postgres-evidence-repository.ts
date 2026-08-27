import type { Pool, PoolClient } from "pg";

import { evidenceClaimPayload } from "../schemas/index.js";
import type { EvidenceLifecycle, EvidenceRecord } from "./evidence-ledger.js";

interface StoredEvidenceRow {
  payload: unknown;
  status: EvidenceLifecycle;
  created_at: Date;
}

export class PostgresEvidenceRepositoryError extends Error {
  public constructor(public readonly code: "conflict" | "invalid-prior" | "not-found") {
    super("Evidence persistence operation failed");
    this.name = "PostgresEvidenceRepositoryError";
  }
}

export class PostgresEvidenceRepository {
  public constructor(private readonly pool: Pool) {}

  public async activate(
    payloadInput: unknown,
    expectedPriorVersion: number,
    activatedAt: Date,
  ): Promise<void> {
    const payload = evidenceClaimPayload.parse(payloadInput);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockClaim(client, payload.claim_id);
      const current = await client.query<{ record_version: string; status: string }>(
        `SELECT record_version, status
           FROM battery_evidence.claims
          WHERE record_id = $1
          ORDER BY record_version DESC
          LIMIT 1
          FOR UPDATE`,
        [payload.claim_id],
      );
      const priorVersion = Number(current.rows[0]?.record_version ?? 0);
      if (priorVersion !== expectedPriorVersion || payload.claim_version !== priorVersion + 1) {
        throw new PostgresEvidenceRepositoryError("invalid-prior");
      }
      if (priorVersion > 0) {
        if (current.rows[0]?.status !== "active") {
          throw new PostgresEvidenceRepositoryError("invalid-prior");
        }
        await client.query(
          `UPDATE battery_evidence.claims
              SET status = 'superseded'
            WHERE record_id = $1 AND record_version = $2 AND status = 'active'`,
          [payload.claim_id, priorVersion],
        );
        await client.query(
          `UPDATE battery_evidence.evidence_versions
              SET status = 'superseded'
            WHERE payload->>'claim_id' = $1 AND payload->>'claim_version' = $2 AND status = 'active'`,
          [payload.claim_id, String(priorVersion)],
        );
      }
      const values = [
        payload.claim_id,
        payload.claim_version,
        "urn:evllm:schema:00000000-0000-4000-8000-000000000001",
        "1.0.0",
        "active",
        payload.issuer_organization_id,
        JSON.stringify(payload),
        activatedAt,
      ];
      await client.query(
        `INSERT INTO battery_evidence.claims
          (record_id, record_version, schema_id, schema_version, status,
           controller_organization_id, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        values,
      );
      await client.query(
        `INSERT INTO battery_evidence.evidence_versions
          (record_id, record_version, schema_id, schema_version, status,
           controller_organization_id, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
        [payload.evidence_id, ...values.slice(1)],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof PostgresEvidenceRepositoryError) throw error;
      if (isUniqueViolation(error)) throw new PostgresEvidenceRepositoryError("conflict");
      throw error;
    } finally {
      client.release();
    }
  }

  public async revoke(claimId: string, version: number): Promise<void> {
    const result = await this.pool.query(
      `UPDATE battery_evidence.claims
          SET status = 'revoked'
        WHERE record_id = $1 AND record_version = $2 AND status = 'active'`,
      [claimId, version],
    );
    if (result.rowCount !== 1) throw new PostgresEvidenceRepositoryError("not-found");
  }

  public async history(claimId: string): Promise<readonly EvidenceRecord[]> {
    const result = await this.pool.query<StoredEvidenceRow>(
      `SELECT payload, status, created_at
         FROM battery_evidence.claims
        WHERE record_id = $1
        ORDER BY record_version`,
      [claimId],
    );
    return result.rows.map((row) => ({
      activatedAt: Math.floor(row.created_at.getTime() / 1000),
      payload: evidenceClaimPayload.parse(row.payload),
      status: row.status,
    }));
  }

  private async lockClaim(client: PoolClient, claimId: string): Promise<void> {
    // Transaction-scoped advisory locking serializes first-version races where no row exists yet.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [claimId]);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
