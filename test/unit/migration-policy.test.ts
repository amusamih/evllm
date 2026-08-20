import { describe, expect, it } from "vitest";

import { decideMigrationPolicy } from "../../src/db/migration-policy.js";

describe("migration policy", () => {
  it("returns an explicit prohibited-operation result for production rollback", () => {
    expect(decideMigrationPolicy("production", "down")).toEqual({
      allowed: false,
      code: "MIGRATION_ROLLBACK_PROHIBITED",
      direction: "down",
      environment: "production",
      message: "Destructive database rollback is prohibited in production.",
    });
  });

  it.each([
    ["production", "up"],
    ["development", "up"],
    ["development", "down"],
    ["test", "up"],
    ["test", "down"],
  ] as const)("allows %s %s", (environment, direction) => {
    expect(decideMigrationPolicy(environment, direction)).toEqual({ allowed: true, direction });
  });
});
