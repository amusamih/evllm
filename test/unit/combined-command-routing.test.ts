import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { EvidenceLedger } from "../../src/evidence/index.js";
import { MarketplaceCommandGateway } from "../../src/marketplace/index.js";

describe("combined command routing", () => {
  it("dispatches evidence and marketplace commands to their own authorization boundary", async () => {
    const ledger = new EvidenceLedger();
    const execute = vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}`));
    const app = createApp({
      appEnvironment: "test",
      evidence: {
        authorize: (incoming) => incoming.header("authorization") === "Bearer evidence-admin",
        ledger,
        now: () => 100,
      },
      marketplace: {
        authorize: (incoming) => incoming.header("authorization") === "Bearer marketplace-actor",
        gateway: new MarketplaceCommandGateway(
          () => true,
          execute,
          () => 150,
        ),
        query: () => Promise.resolve({}),
      },
    });

    await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer marketplace-actor")
      .send(marketplaceCommand())
      .expect(202);
    expect(execute).toHaveBeenCalledTimes(1);

    await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer evidence-admin")
      .send({ kind: "activate-evidence", expected_prior_version: 0, payload: evidencePayload() })
      .expect(202);
    expect(ledger.current(claimId).status).toBe("active");
  });
});

const claimId = urn("claim", 1);

function marketplaceCommand() {
  return {
    schema: "EVLLM_MARKETPLACE_COMMAND_V1",
    command_id: urn("command", 1),
    kind: "create-listing",
    signer_actor_id: urn("actor", 2),
    signer_organization_id: urn("org", 3),
    signer_credential_id: urn("credential", 4),
    signer_address: "0x1111111111111111111111111111111111111111",
    issued_at: 100,
    expires_at: 200,
    nonce: `0x${"00".repeat(31)}01`,
    idempotency_key_hash: `0x${"44".repeat(32)}`,
    payload: { listing_id: urn("listing", 1) },
    signature: `0x${"22".repeat(65)}`,
  };
}

function evidencePayload() {
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
