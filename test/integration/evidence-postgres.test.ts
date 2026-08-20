import { runner, type RunnerOption } from "node-pg-migrate";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfig, type AppConfig } from "../../src/config/index.js";
import { createDatabasePool } from "../../src/db/pool.js";
import { PostgresEvidenceRepository } from "../../src/evidence/index.js";

describe.sequential("PostgreSQL evidence history", () => {
  let config: AppConfig;
  let pool: ReturnType<typeof createDatabasePool>;
  let repository: PostgresEvidenceRepository;

  beforeAll(async () => {
    config = loadConfig();
    if (config.appEnvironment !== "test" || !config.database.database.endsWith("_test")) {
      throw new Error("Evidence integration requires APP_ENV=test and a *_test database.");
    }
    pool = createDatabasePool(config);
    const options: RunnerOption = {
      checkOrder: true,
      databaseUrl: config.database,
      dir: path.join(config.projectRoot, "db", "migrations"),
      direction: "up",
      migrationsTable: "evllm_migrations",
      singleTransaction: true,
    };
    await runner(options);
    await pool.query("TRUNCATE battery_evidence.claims, battery_evidence.evidence_versions");
    repository = new PostgresEvidenceRepository(pool);
  });

  afterAll(async () => pool.end());

  it("serializes expected-prior activation and preserves superseded history", async () => {
    await repository.activate(evidence(1), 0, new Date("2026-08-12T00:00:00Z"));
    await repository.activate(evidence(2), 1, new Date("2026-08-12T00:01:00Z"));
    await expect(repository.activate(evidence(3), 1, new Date())).rejects.toMatchObject({
      code: "invalid-prior",
    });
    expect((await repository.history(claimId)).map(({ status }) => status)).toEqual([
      "superseded",
      "active",
    ]);
    await repository.revoke(claimId, 2);
    expect((await repository.history(claimId)).at(-1)?.status).toBe("revoked");
  });
});

const claimId = urn("claim", 1);

function evidence(version: number) {
  const evidenceId = urn("evidence", 10 + version);
  return {
    schema: "EVLLM_EVIDENCE_CLAIM_PAYLOAD_V1",
    evidence_id: evidenceId,
    evidence_version: version,
    claim_id: claimId,
    claim_version: version,
    claim_type: "capacity",
    subject_id: urn("battery", 2),
    subject_granularity: "pack",
    issuer_organization_id: urn("org", 3),
    issuer_role_id: urn("role", 4),
    observed_at: 10,
    submitted_at: 20,
    capture_method: { id: "test", version: 1 },
    value: { type: "text", value: `version-${version}` },
    uncertainty: { type: "none" },
    source_class: "primary",
    provenance: [],
    protected_bundle_ref: {
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
      bundle_id: urn("bundle", 20 + version),
      bundle_version: 1,
      bundle_type: "evidence",
      domain_resource_id: evidenceId,
      domain_resource_version: version,
      custody_controller_org_id: urn("org", 5),
      content_schema_id: urn("schema", 6),
      content_schema_version: "1.0.0",
      initial_criticality_class: "decision-critical",
      criticality_profile_id: urn("profile", 7),
      criticality_profile_version: 1,
    },
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
