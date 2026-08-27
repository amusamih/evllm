import path from "node:path";

import { runner, type RunnerOption } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { createDatabasePool } from "../../src/db/pool.js";
import {
  PostgresKeyOperationAuthorizationRepository,
  type KeyOperationAuthorizationRecord,
} from "../../src/evidence/index.js";

describe.sequential("PostgreSQL key-operation authorization persistence", () => {
  let config: AppConfig;
  let pool: ReturnType<typeof createDatabasePool>;

  beforeAll(async () => {
    config = loadConfig();
    if (config.appEnvironment !== "test" || !config.database.database.endsWith("_test")) {
      throw new Error("Key-operation integration requires APP_ENV=test and a *_test database.");
    }
    pool = createDatabasePool(config);
    const options: RunnerOption = {
      checkOrder: true,
      databaseUrl: config.database,
      dir: path.join(config.projectRoot, "db", "repository-migrations"),
      direction: "up",
      migrationsTable: "evllm_repository_migrations",
      singleTransaction: true,
    };
    await runner(options);
    await pool.query("TRUNCATE repository_private.key_operation_capabilities");
  });

  afterAll(async () => pool.end());

  it("atomically retains one winner for a concurrent nonce and survives re-instantiation", async () => {
    const first = authorization(1);
    const second = authorization(2);
    const nonceScope = `KeyOperationAuthorization:${credentialId}:${first.nonce}`;
    const repository = new PostgresKeyOperationAuthorizationRepository(pool);
    const outcomes = await Promise.allSettled([
      repository.consume(first, nonceScope),
      repository.consume(second, nonceScope),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find(({ status }) => status === "rejected");
    if (rejection?.status === "rejected") {
      expect(rejection.reason).toMatchObject({ code: "replay" });
    }

    const winner = outcomes[0]?.status === "fulfilled" ? first : second;
    const restarted = new PostgresKeyOperationAuthorizationRepository(pool);
    await expect(
      restarted.find(winner.authorization_id, winner.authorization_version),
    ).resolves.toEqual(winner);
  });
});

const credentialId = urn("credential", 1);

function authorization(value: number): KeyOperationAuthorizationRecord {
  const digest = { alg: "SHA-256" as const, value: Buffer.alloc(32, value).toString("base64url") };
  return {
    schema: "EVLLM_KEY_OPERATION_AUTHORIZATION_V1",
    authorization_id: urn("authorization", value),
    authorization_version: 1,
    issuer_service_actor_id: urn("actor", 2),
    issuer_service_organization_id: urn("org", 3),
    issuer_service_credential_id: credentialId,
    issuer_service_address: `0x${"1".repeat(40)}`,
    repository_id: urn("repository", 4),
    operation: "decrypt-with-grant",
    requesting_actor_id: urn("actor", 5),
    requesting_organization_id: urn("org", 6),
    requesting_credential_id: urn("credential", 7),
    bundle_id: urn("bundle", 8),
    bundle_version: 1,
    bundle_type: "evidence",
    domain_resource_id: urn("evidence", 9),
    domain_resource_version: 1,
    purpose_id: urn("policy", 10),
    policy_id: urn("policy", 11),
    policy_version: 1,
    source_authority_ids: [urn("grant", 12)],
    source_authority_digest: digest,
    operation_context_digest: digest,
    nonce: `0x${"a".repeat(64)}`,
    issued_at: 100,
    expires_at: 200,
    idempotency_key_hash: `0x${value.toString(16).padStart(64, "0")}`,
    signature: Buffer.alloc(65, value).toString("base64url"),
    typed_data_digest: `0x${value.toString(16).padStart(64, "0")}`,
    signature_digest: digest,
    state: "consumed",
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
