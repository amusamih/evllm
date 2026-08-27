import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { eip712Profiles } from "../../src/schemas/index.js";

describe("generated EIP-712 profile artifact", () => {
  it("matches the runtime profile source exactly", async () => {
    const artifact = JSON.parse(
      await readFile(resolve("contracts/generated/eip712/profiles.json"), "utf8"),
    ) as unknown;
    expect(artifact).toEqual({
      schema: "EVLLM_EIP712_PROFILES_V1",
      profiles: eip712Profiles,
    });
  });
});
