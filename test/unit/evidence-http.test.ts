import request from "supertest";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import { EvidenceLedger } from "../../src/evidence/index.js";

describe("evidence HTTP boundary", () => {
  it("denies unscoped callers and supports authorized activate/query/revoke", async () => {
    const ledger = new EvidenceLedger();
    const app = createApp({
      appEnvironment: "test",
      evidence: {
        authorize: (incoming) => incoming.header("authorization") === "Bearer evidence-admin",
        ledger,
        now: () => 100,
      },
    });
    await request(app).get("/api/v1/query/evidence").query({ claim_id: claimId }).expect(403);
    await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer evidence-admin")
      .send({ kind: "activate-evidence", expected_prior_version: 0, payload: evidence() })
      .expect(202);
    const queried = await request(app)
      .get("/api/v1/query/evidence")
      .set("authorization", "Bearer evidence-admin")
      .query({ claim_id: claimId })
      .expect(200);
    const queriedBody = z
      .object({ current: z.object({ status: z.string() }) })
      .passthrough()
      .parse(queried.body);
    expect(queriedBody.current.status).toBe("active");
    await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer evidence-admin")
      .send({ kind: "revoke-evidence", claim_id: claimId, claim_version: 1 })
      .expect(202);
    await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer evidence-admin")
      .send({ kind: "revoke-evidence", claim_id: claimId, claim_version: 1 })
      .expect(409);
  });
});

const claimId = urn("claim", 1);

function evidence() {
  const evidenceId = urn("evidence", 2);
  return {
    schema: "EVLLM_EVIDENCE_CLAIM_PAYLOAD_V1",
    evidence_id: evidenceId,
    evidence_version: 1,
    claim_id: claimId,
    claim_version: 1,
    claim_type: "remaining-capacity",
    subject_id: urn("battery", 3),
    subject_granularity: "pack",
    issuer_organization_id: urn("org", 4),
    issuer_role_id: urn("role", 5),
    observed_at: 50,
    submitted_at: 60,
    capture_method: { id: "capacity-test", version: 1 },
    value: { type: "text", value: "verified capacity report" },
    uncertainty: { type: "none" },
    source_class: "primary",
    provenance: [],
    protected_bundle_ref: {
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
      bundle_id: urn("bundle", 6),
      bundle_version: 1,
      bundle_type: "evidence",
      domain_resource_id: evidenceId,
      domain_resource_version: 1,
      custody_controller_org_id: urn("org", 7),
      content_schema_id: urn("schema", 8),
      content_schema_version: "1.0.0",
      initial_criticality_class: "decision-critical",
      criticality_profile_id: urn("profile", 9),
      criticality_profile_version: 1,
    },
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
