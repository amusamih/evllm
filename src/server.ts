import path from "node:path";

import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { checkDatabase, createDatabasePool } from "./db/pool.js";
import { createResearchRuntime } from "./interface/runtime.js";
import { createStructuredLogger } from "./observability/index.js";

const config = loadConfig();
const logger = createStructuredLogger();
if (config.controlledWalletAddress === undefined) {
  throw new Error(
    "EVLLM_CONTROLLED_WALLET_ADDRESS is required to bind the controlled interface credential",
  );
}
const databasePool = createDatabasePool(config);
databasePool.on("error", (error) => {
  logger.log("error", "database.pool_idle_error", { error, service: "postgres" });
});
const researchRuntime = createResearchRuntime({
  controlledWalletAddress: config.controlledWalletAddress,
  corpusPath: path.join(config.projectRoot, "evaluation", "final", "synthesis-corpus.json"),
  ...(config.openai.apiKey === undefined ? {} : { apiKey: config.openai.apiKey }),
  modelName: config.openai.model,
});
const app = createApp({
  appEnvironment: config.appEnvironment,
  logger,
  assistant: {
    sessions: researchRuntime.sessions,
    service: researchRuntime.assistant,
    audit: researchRuntime.audit,
  },
  interface: { service: researchRuntime.interfaceService },
  readinessChecks: [
    {
      name: "postgres",
      probe: async () => checkDatabase(databasePool),
    },
  ],
});

const server = app.listen(config.port, config.httpHost, () => {
  logger.log("info", "server.started", { host: config.httpHost, port: config.port });
});
server.on("error", (error) => {
  logger.log("error", "server.http_error", { error, service: "http" });
  process.exitCode = 1;
});

function shutdown(signal: NodeJS.Signals): void {
  logger.log("info", "server.shutdown_requested", { signal });
  server.closeIdleConnections();
  server.close((serverError) => {
    void databasePool.end().then(
      () => {
        if (serverError) {
          logger.log("error", "server.shutdown_failed", { error: serverError, service: "http" });
          process.exitCode = 1;
        }
      },
      (databaseError: unknown) => {
        logger.log("error", "server.shutdown_failed", {
          error: databaseError,
          service: "database",
        });
        process.exitCode = 1;
      },
    );
  });
}

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
