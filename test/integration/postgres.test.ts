import path from "node:path";

import { runner } from "node-pg-migrate";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { checkDatabase, createDatabasePool } from "../../src/db/pool.js";

describe("PostgreSQL foundation", () => {
  let config: AppConfig;
  let pool: ReturnType<typeof createDatabasePool>;

  beforeAll(async () => {
    config = loadConfig();
    if (config.appEnvironment !== "test" || !config.database.database.endsWith("_test")) {
      throw new Error(
        "Integration tests require APP_ENV=test and a database name ending in _test.",
      );
    }
    await runner({
      checkOrder: true,
      databaseUrl: config.database,
      dir: path.join(config.projectRoot, "db", "migrations"),
      direction: "up",
      migrationsTable: "evllm_migrations",
      singleTransaction: true,
    });
    pool = createDatabasePool(config);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("reports the API as ready when PostgreSQL responds", async () => {
    const app = createApp({
      readinessChecks: [{ name: "postgres", probe: async () => checkDatabase(pool) }],
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      checks: [{ name: "postgres", status: "ready" }],
      status: "ready",
    });
  });

  it("has the required database extensions after migration", async () => {
    const result = await pool.query<{ extname: string }>(
      "SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'vector') ORDER BY extname",
    );

    expect(result.rows.map((row) => row.extname)).toEqual(["pgcrypto", "vector"]);
  });
});
