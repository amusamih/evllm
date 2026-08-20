import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/index.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "test",
    DOCUMENT_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DOCUMENT_STORE_PATH: "data/test-evidence",
    EVLLM_DB_HOST: "127.0.0.1",
    EVLLM_DB_NAME: "evllm_test",
    EVLLM_DB_PASSWORD: "test-database-password",
    EVLLM_DB_PORT: "5433",
    EVLLM_DB_USER: "evllm_test",
    PORT: "3100",
    SESSION_SECRET: "test-session-secret-that-is-at-least-32-characters",
  };
}

describe("parseConfig", () => {
  it("parses and freezes a valid environment", () => {
    const config = parseConfig(validEnvironment());

    expect(config.appEnvironment).toBe("test");
    expect(config.database.port).toBe(5433);
    expect(config.documentEncryptionKey).toHaveLength(32);
    expect(path.isAbsolute(config.documentStorePath)).toBe(true);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it("rejects placeholder secrets", () => {
    const environment = validEnvironment();
    environment.EVLLM_DB_PASSWORD = "replace_with_local_database_password";

    expect(() => parseConfig(environment)).toThrow();
  });

  it("rejects an encryption key that is not exactly 32 bytes", () => {
    const environment = validEnvironment();
    environment.DOCUMENT_ENCRYPTION_KEY = Buffer.alloc(31).toString("base64");

    expect(() => parseConfig(environment)).toThrow();
  });

  it("rejects noncanonical Base64 that decodes to 32 bytes", () => {
    const environment = validEnvironment();
    environment.DOCUMENT_ENCRYPTION_KEY = `${environment.DOCUMENT_ENCRYPTION_KEY}!!!!`;

    expect(() => parseConfig(environment)).toThrow();
  });
});
