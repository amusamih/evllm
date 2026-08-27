import path from "node:path";

import { runner, type RunnerOption } from "node-pg-migrate";

import { loadConfig } from "../src/config/index.js";
import { decideMigrationPolicy, type MigrationDirection } from "../src/db/migration-policy.js";

const requestedDirection = process.argv[2] as MigrationDirection | undefined;
if (requestedDirection !== "up" && requestedDirection !== "down") {
  throw new Error("Migration direction must be either 'up' or 'down'.");
}

const config = loadConfig();
const repositoryScope = process.argv.includes("--repository");
const policy = decideMigrationPolicy(config.appEnvironment, requestedDirection);
if (!policy.allowed) {
  process.stderr.write(`${JSON.stringify(policy)}\n`);
  process.exitCode = 2;
} else {
  const options: RunnerOption = {
    checkOrder: true,
    databaseUrl: config.database,
    dir: path.join(
      config.projectRoot,
      "db",
      repositoryScope ? "repository-migrations" : "migrations",
    ),
    direction: requestedDirection,
    migrationsTable: repositoryScope ? "evllm_repository_migrations" : "evllm_migrations",
    singleTransaction: true,
    ...(requestedDirection === "down" ? { count: 1 } : {}),
  };

  await runner(options);
}
