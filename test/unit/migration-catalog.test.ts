import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const central = require("../../db/migrations/000002_central_groups.cjs") as {
  groups: Record<string, string[]>;
};
const repository = require("../../db/repository-migrations/000001_repository_private.cjs") as {
  tables: string[];
};

describe("migration catalog", () => {
  it("contains every frozen central migration group", () => {
    expect(Object.keys(central.groups)).toEqual([
      "governance_identity",
      "protected_bundles",
      "battery_evidence",
      "chain_projection",
      "sources_rules_assessment",
      "marketplace",
      "retrieval_audit",
      "evaluation",
    ]);
    expect(Object.values(central.groups).flat()).toHaveLength(75);
  });

  it("contains the independent repository-private lineage", () => {
    expect(repository.tables).toHaveLength(15);
    expect(repository.tables).toContain("protected_bundle_manifests");
    expect(repository.tables).toContain("challenge_delivery_records");
    expect(repository.tables).toContain("cleanup_recovery_records");
  });
});
