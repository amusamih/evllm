import path from "node:path";

import { runner, type RunnerOption } from "node-pg-migrate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { createDatabasePool } from "../../src/db/pool.js";

describe.sequential("database migrations", () => {
  let config: AppConfig;
  let pool: ReturnType<typeof createDatabasePool>;

  function options(scope: "central" | "repository", direction: "up" | "down"): RunnerOption {
    return {
      checkOrder: true,
      databaseUrl: config.database,
      dir: path.join(
        config.projectRoot,
        "db",
        scope === "central" ? "migrations" : "repository-migrations",
      ),
      direction,
      migrationsTable: scope === "central" ? "evllm_migrations" : "evllm_repository_migrations",
      singleTransaction: true,
      ...(direction === "down" ? { count: scope === "repository" ? 2 : 1 } : {}),
    };
  }

  async function schemaExists(schema: string): Promise<boolean> {
    const result = await pool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
      [schema],
    );
    return result.rows[0]?.exists ?? false;
  }

  beforeAll(async () => {
    config = loadConfig();
    if (config.appEnvironment !== "test" || !config.database.database.endsWith("_test")) {
      throw new Error("Migration integration requires APP_ENV=test and a *_test database.");
    }
    pool = createDatabasePool(config);
    await runner(options("central", "up"));
    await runner(options("repository", "up"));
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates every central group and the repository-private lineage", async () => {
    for (const schema of [
      "governance_identity",
      "protected_bundles",
      "battery_evidence",
      "chain_projection",
      "sources_rules_assessment",
      "marketplace",
      "retrieval_audit",
      "evaluation",
      "repository_private",
    ]) {
      expect(await schemaExists(schema), schema).toBe(true);
    }
    const nonceIndex = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_indexes
          WHERE schemaname = 'repository_private'
            AND indexname = 'key_operation_capabilities_nonce_scope_idx'
       ) AS exists`,
    );
    expect(nonceIndex.rows[0]?.exists).toBe(true);
  });

  it("rolls back and reapplies both non-production lineages", async () => {
    await runner(options("repository", "down"));
    await runner(options("central", "down"));

    expect(await schemaExists("repository_private")).toBe(false);
    expect(await schemaExists("governance_identity")).toBe(false);

    await runner(options("central", "up"));
    await runner(options("repository", "up"));

    expect(await schemaExists("governance_identity")).toBe(true);
    expect(await schemaExists("repository_private")).toBe(true);
  });
});
