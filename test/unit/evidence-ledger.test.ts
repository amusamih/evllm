import { describe, expect, it } from "vitest";

import { EvidenceLedger } from "../../src/evidence/index.js";

const claimId = urn("claim", 1);
const issuerOrg = urn("org", 2);

describe("signed versioned evidence lifecycle projection", () => {
  it("atomically supersedes an expected prior and retains immutable history", () => {
    const ledger = new EvidenceLedger();
    ledger.activate(evidence(1), 0, 100);
    ledger.openDispute({
      claimId,
      claimVersion: 1,
      disputeId: urn("dispute", 20),
      openedByOrganizationId: urn("org", 21),
      reason: "measurement conflict",
    });
    ledger.activate(evidence(2), 1, 200);
    expect(ledger.history(claimId).map(({ status }) => status)).toEqual(["superseded", "active"]);
    expect(ledger.dispute(urn("dispute", 20)).status).toBe("closed-by-supersession");
    expect(() => ledger.activate(evidence(3), 1, 300)).toThrow();
  });

  it("keeps verification separate and denies issuer self-certification", () => {
    const ledger = new EvidenceLedger();
    ledger.activate(evidence(1), 0, 100);
    const verification = verificationPayload(urn("org", 30));
    expect(ledger.addVerification(verification).status).toBe("active");
    expect(ledger.withdrawVerification(verification.verification_id, 1).status).toBe("withdrawn");
    expect(() => ledger.addVerification(verificationPayload(issuerOrg, 31))).toThrow();
  });

  it("revokes the current version and refers its open dispute externally", () => {
    const ledger = new EvidenceLedger();
    ledger.activate(evidence(1), 0, 100);
    ledger.openDispute({
      claimId,
      claimVersion: 1,
      disputeId: urn("dispute", 40),
      openedByOrganizationId: urn("org", 41),
      reason: "issuer withdrew basis",
    });
    expect(ledger.revoke(claimId, 1).status).toBe("revoked");
    expect(ledger.dispute(urn("dispute", 40)).status).toBe("referred-external");
    expect(() => ledger.revoke(claimId, 1)).toThrow();
  });
});

function evidence(version: number) {
  const evidenceId = urn("evidence", 100 + version);
  return {
    schema: "EVLLM_EVIDENCE_CLAIM_PAYLOAD_V1",
    evidence_id: evidenceId,
    evidence_version: version,
    claim_id: claimId,
    claim_version: version,
    claim_type: "remaining-capacity",
    subject_id: urn("battery", 4),
    subject_granularity: "pack",
    issuer_organization_id: issuerOrg,
    issuer_role_id: urn("role", 5),
    observed_at: 50 + version,
    submitted_at: 60 + version,
    capture_method: { id: "capacity-test", version: 1 },
    value: {
      type: "quantity",
      quantity: { value: `${70 + version}`, unit_id: urn("unit", 6), unit_version: 1 },
    },
    uncertainty: { type: "none" },
    source_class: "primary",
    provenance: [],
    protected_bundle_ref: bundleRef("evidence", evidenceId, version, 200 + version),
  };
}

function verificationPayload(verifierOrg: string, offset = 30) {
  const verificationId = urn("verification", offset);
  return {
    schema: "EVLLM_VERIFICATION_PAYLOAD_V1",
    verification_id: verificationId,
    verification_version: 1,
    assertion_type: "certification",
    claim_id: claimId,
    claim_version: 1,
    verifier_organization_id: verifierOrg,
    verifier_role_id: urn("role", offset + 1),
    verifier_credential_id: urn("credential", offset + 2),
    basis_evidence: [{ id: urn("evidence", 101), version: 1 }],
    method: { id: "verification-method", version: 1 },
    reason: "Independent report review",
    verified_at: 80,
    protected_bundle_ref: bundleRef("verification", verificationId, 1, offset + 3),
  };
}

function bundleRef(
  type: "evidence" | "verification",
  resourceId: string,
  version: number,
  offset: number,
) {
  return {
    schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
    bundle_id: urn("bundle", offset),
    bundle_version: 1,
    bundle_type: type,
    domain_resource_id: resourceId,
    domain_resource_version: version,
    custody_controller_org_id: urn("org", offset + 1),
    content_schema_id: urn("schema", offset + 2),
    content_schema_version: "1.0.0",
    initial_criticality_class: "decision-critical",
    criticality_profile_id: urn("profile", offset + 3),
    criticality_profile_version: 1,
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
