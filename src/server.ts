import path from "node:path";

import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { checkDatabase, createDatabasePool } from "./db/pool.js";
import { createResearchRuntime } from "./interface/runtime.js";

const config = loadConfig();
const databasePool = createDatabasePool(config);
const researchRuntime = createResearchRuntime({
  corpusPath: path.join(config.projectRoot, "evaluation", "final", "synthesis-corpus.json"),
  ...(config.openai.apiKey === undefined ? {} : { apiKey: config.openai.apiKey }),
  modelName: config.openai.model,
});
const app = createApp({
  appEnvironment: config.appEnvironment,
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

const server = app.listen(config.port, () => {
  console.log(`EVLLM API listening on http://localhost:${config.port}`);
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down.`);
  server.closeIdleConnections();
  server.close((serverError) => {
    void databasePool.end().then(
      () => {
        if (serverError) {
          console.error("HTTP server shutdown failed.", serverError);
          process.exitCode = 1;
        }
      },
      (databaseError: unknown) => {
        console.error("Database shutdown failed.", databaseError);
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
