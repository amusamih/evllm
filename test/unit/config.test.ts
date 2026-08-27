import { describe, expect, it } from "vitest";

import { parseConfig } from "../../src/config/index.js";

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    APP_ENV: "test",
    EVLLM_DB_HOST: "127.0.0.1",
    EVLLM_DB_NAME: "evllm_test",
    EVLLM_DB_PASSWORD: "test-database-password",
    EVLLM_DB_PORT: "5433",
    EVLLM_DB_USER: "evllm_test",
    EVLLM_HTTP_HOST: "127.0.0.1",
    PORT: "3100",
  };
}

describe("parseConfig", () => {
  it("parses and freezes a valid environment", () => {
    const config = parseConfig(validEnvironment());

    expect(config.appEnvironment).toBe("test");
    expect(config.database.port).toBe(5433);
    expect(config.httpHost).toBe("127.0.0.1");
    expect(config.projectRoot.length).toBeGreaterThan(0);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it("rejects placeholder secrets", () => {
    const environment = validEnvironment();
    environment.EVLLM_DB_PASSWORD = "replace_with_local_database_password";

    expect(() => parseConfig(environment)).toThrow();
  });

  it("rejects an invalid server port", () => {
    const environment = validEnvironment();
    environment.PORT = "70000";

    expect(() => parseConfig(environment)).toThrow();
  });

  it("normalizes a configured controlled wallet address and rejects invalid values", () => {
    const environment = validEnvironment();
    environment.EVLLM_CONTROLLED_WALLET_ADDRESS = `0x${"a".repeat(40)}`;
    expect(parseConfig(environment).controlledWalletAddress).toBe(`0x${"a".repeat(40)}`);

    environment.EVLLM_CONTROLLED_WALLET_ADDRESS = "not-an-address";
    expect(() => parseConfig(environment)).toThrow();
  });

  it("defaults to loopback and rejects malformed bind addresses", () => {
    const environment = validEnvironment();
    delete environment.EVLLM_HTTP_HOST;
    expect(parseConfig(environment).httpHost).toBe("127.0.0.1");

    environment.EVLLM_HTTP_HOST = "0.0.0.999";
    expect(() => parseConfig(environment)).toThrow();
  });
});
