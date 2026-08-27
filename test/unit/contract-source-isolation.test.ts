import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("contract source isolation", () => {
  it("contains only the production contract boundary", async () => {
    const contractDirectory = resolve("contracts");
    const entries = await readdir(contractDirectory, { recursive: true, withFileTypes: true });
    const sources = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sol"))
      .map((entry) => resolve(entry.parentPath, entry.name));
    const joined = (await Promise.all(sources.map((source) => readFile(source, "utf8")))).join(
      "\n",
    );

    expect(sources.length).toBeGreaterThanOrEqual(7);
    expect(joined).not.toMatch(/delegatecall|upgradeTo|ERC1967|TransparentUpgradeableProxy/iu);
  });
});
