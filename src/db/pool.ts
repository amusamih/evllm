import { Pool, type PoolConfig } from "pg";

import type { AppConfig } from "../config/index.js";

export function createDatabasePool(config: AppConfig): Pool {
  const poolConfig: PoolConfig = {
    ...config.database,
    application_name: "evllm-api",
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    max: 10,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  };
  return new Pool(poolConfig);
}

export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}
