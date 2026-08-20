import { describe, expect, it } from "vitest";

import {
  canonicalDecimal,
  decimalRange,
  domainAttestationChallenge,
  domainManifestAttestation,
  eip712Profiles,
  PrepareContractMismatchError,
  protectedBundleStagingDescriptor,
  protectedBundleRef,
  replicaPolicy,
  validatePrepareProtectedBundleRequest,
  weiAmount,
} from "../../src/schemas/index.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("machine-readable shared contracts", () => {
  it("accepts an exact evidence protected-bundle reference", () => {
    expect(
      protectedBundleRef.parse({
        schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
        bundle_id: `urn:evllm:bundle:${uuid}`,
        bundle_version: 1,
        bundle_type: "evidence",
        domain_resource_id: `urn:evllm:evidence:${uuid}`,
        domain_resource_version: 1,
        custody_controller_org_id: `urn:evllm:org:${uuid}`,
        content_schema_id: `urn:evllm:schema:${uuid}`,
        content_schema_version: "1.0.0",
        initial_criticality_class: "decision-critical",
        criticality_profile_id: `urn:evllm:profile:${uuid}`,
        criticality_profile_version: 1,
      }),
    ).toBeDefined();
  });

  it("rejects a cross-domain URN and extra mutable state", () => {
    const result = protectedBundleRef.safeParse({
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
      bundle_id: `urn:evllm:bundle:${uuid}`,
      bundle_version: 1,
      bundle_type: "evidence",
      domain_resource_id: `urn:evllm:assessment:${uuid}`,
      domain_resource_version: 1,
      custody_controller_org_id: `urn:evllm:org:${uuid}`,
      content_schema_id: `urn:evllm:schema:${uuid}`,
      content_schema_version: "1.0.0",
      initial_criticality_class: "supplementary",
      criticality_profile_id: `urn:evllm:profile:${uuid}`,
      criticality_profile_version: 1,
      current_state: "confirmed",
    });
    expect(result.success).toBe(false);
  });

  it("enforces the fixed v1 replica topology", () => {
    const result = replicaPolicy.safeParse({
      schema: "EVLLM_REPLICA_POLICY_V1",
      replica_policy_id: `urn:evllm:profile:${uuid}`,
      replica_policy_version: 1,
      required_when_decision_critical: true,
      replica_count: 2,
      replica_custodian_org_id: `urn:evllm:org:${uuid}`,
      replica_repository_id: `urn:evllm:repository:${uuid}`,
      retention_profile_id: `urn:evllm:profile:${uuid}`,
      retention_profile_version: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects noncanonical decimals and invalid ranges", () => {
    expect(canonicalDecimal.safeParse("1.0").success).toBe(false);
    expect(decimalRange.safeParse({ lower: "2", upper: "1" }).success).toBe(false);
  });

  it("represents wei without JSON number loss", () => {
    expect(weiAmount.safeParse(`0x${"f".repeat(64)}`).success).toBe(true);
    expect(weiAmount.safeParse("1").success).toBe(false);
  });

  it("accepts the exact domain-attestation challenge shape", () => {
    const digest = { alg: "SHA-256", value: "A".repeat(43) };
    const result = domainAttestationChallenge.safeParse({
      schema: "EVLLM_DOMAIN_ATTESTATION_CHALLENGE_V1",
      challenge_id: `urn:evllm:challenge:${uuid}`,
      staging_id: `urn:evllm:staging:${uuid}`,
      staging_descriptor_digest: digest,
      bundle_id: `urn:evllm:bundle:${uuid}`,
      bundle_version: 1,
      bundle_type: "evidence",
      domain_resource_id: `urn:evllm:evidence:${uuid}`,
      domain_resource_version: 1,
      domain_payload_bytes: "e30",
      domain_payload_salt: "A".repeat(43),
      domain_payload_commitment: digest,
      author_binding_profile_id: `urn:evllm:profile:${uuid}`,
      author_binding_profile_version: 1,
      eip712_profile_id: `urn:evllm:profile:${uuid}`,
      eip712_profile_version: 1,
      eip712_domain: {
        name: "EVLLM Domain Manifest",
        version: "1",
        chain_id: 31337,
        verifying_contract: `0x${"a".repeat(40)}`,
      },
      signer_actor_id: `urn:evllm:actor:${uuid}`,
      signer_org_id: `urn:evllm:org:${uuid}`,
      signer_credential_id: `urn:evllm:credential:${uuid}`,
      signer_address: `0x${"b".repeat(40)}`,
      nonce: `0x${"0".repeat(63)}1`,
      issued_at: 1,
      expires_at: 2,
      prepared_at: 1,
      staging_expires_at: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects noncanonical EIP-712 values and freezes exact field order", () => {
    expect(
      domainManifestAttestation.safeParse({
        bundleId: `0x${"0".repeat(64)}`,
        bundleVersion: 1,
        bundleType: `0x${"0".repeat(64)}`,
        domainResourceId: `0x${"0".repeat(64)}`,
        domainResourceVersion: 1,
        authorBindingProfileId: `0x${"0".repeat(64)}`,
        authorBindingProfileVersion: 1,
        domainPayloadCommitment: `0x${"0".repeat(64)}`,
        signerActorId: `0x${"0".repeat(64)}`,
        signerOrgId: `0x${"0".repeat(64)}`,
        signerCredentialId: `0x${"0".repeat(64)}`,
        nonce: "1",
        issuedAt: 1,
        expiresAt: 2,
      }).success,
    ).toBe(false);
    expect(eip712Profiles.DomainManifestAttestation.fields.map(({ name }) => name)).toEqual([
      "bundleId",
      "bundleVersion",
      "bundleType",
      "domainResourceId",
      "domainResourceVersion",
      "authorBindingProfileId",
      "authorBindingProfileVersion",
      "domainPayloadCommitment",
      "signerActorId",
      "signerOrgId",
      "signerCredentialId",
      "nonce",
      "issuedAt",
      "expiresAt",
    ]);
  });

  it("validates preparation against the embedded protected-bundle reference", () => {
    const reference = evidenceReference();
    const request = prepareRequest(reference);
    expect(validatePrepareProtectedBundleRequest(request).reference).toEqual(reference);

    const swappedReference = { ...reference, criticality_profile_version: 2 };
    const swappedRequest = prepareRequest(swappedReference);
    swappedRequest.criticality_profile_version = 1;
    expect(() => validatePrepareProtectedBundleRequest(swappedRequest)).toThrow(
      PrepareContractMismatchError,
    );
  });

  it("rejects a staging descriptor with an invalid time interval", () => {
    const descriptor = {
      schema: "EVLLM_PROTECTED_BUNDLE_STAGING_V1",
      staging_id: `urn:evllm:staging:${uuid}`,
      repository_receipt_id: `urn:evllm:receipt:${uuid}`,
      bundle_id: `urn:evllm:bundle:${uuid}`,
      bundle_version: 1,
      bundle_type: "evidence",
      domain_resource_id: `urn:evllm:evidence:${uuid}`,
      domain_resource_version: 1,
      domain_payload_commitment: sha256Digest(),
      custody_controller_org_id: `urn:evllm:org:${uuid}`,
      primary_repository_id: `urn:evllm:repository:${uuid}`,
      staging_object_id: "A".repeat(43),
      primary_object_id: "B".repeat(43),
      content_schema_id: `urn:evllm:schema:${uuid}`,
      content_schema_version: "1.0.0",
      author_binding_profile_id: `urn:evllm:profile:${uuid}`,
      author_binding_profile_version: 1,
      author_binding_decision_id: `urn:evllm:decision:${uuid}`,
      author_binding_decision_digest: sha256Digest(),
      access_class: "restricted",
      initial_criticality_class: "decision-critical",
      criticality_profile_id: `urn:evllm:profile:${uuid}`,
      criticality_profile_version: 1,
      content_commitment: sha256Digest(),
      content_envelope_digest: sha256Digest(),
      encryption_profile_id: `urn:evllm:profile:${uuid}`,
      encryption_profile_version: 1,
      controller_key_authorization_id: `urn:evllm:authorization:${uuid}`,
      controller_envelope_id: `urn:evllm:envelope:${uuid}`,
      controller_encryption_key_id: `urn:evllm:key:${uuid}`,
      controller_envelope_profile_id: `urn:evllm:profile:${uuid}`,
      controller_envelope_profile_version: 1,
      controller_envelope_commitment: sha256Digest(),
      stored_envelope_length: 100,
      replica_policy: replicaPolicyFixture(),
      prepared_at: 2,
      expires_at: 1,
      preparation_idempotency_key_hash: `0x${"1".repeat(64)}`,
    };
    expect(protectedBundleStagingDescriptor.safeParse(descriptor).success).toBe(false);
  });
});

function evidenceReference() {
  return {
    schema: "EVLLM_PROTECTED_BUNDLE_REF_V1" as const,
    bundle_id: `urn:evllm:bundle:${uuid}`,
    bundle_version: 1,
    bundle_type: "evidence" as const,
    domain_resource_id: `urn:evllm:evidence:${uuid}`,
    domain_resource_version: 1,
    custody_controller_org_id: `urn:evllm:org:${uuid}`,
    content_schema_id: `urn:evllm:schema:${uuid}`,
    content_schema_version: "1.0.0",
    initial_criticality_class: "decision-critical" as const,
    criticality_profile_id: `urn:evllm:profile:${uuid}`,
    criticality_profile_version: 1,
  };
}

function prepareRequest(reference: ReturnType<typeof evidenceReference>) {
  const payload = Buffer.from(JSON.stringify({ protected_bundle_ref: reference })).toString(
    "base64url",
  );
  return {
    schema: "EVLLM_PREPARE_PROTECTED_BUNDLE_REQUEST_V1" as const,
    bundle_id: reference.bundle_id,
    bundle_version: reference.bundle_version,
    bundle_type: reference.bundle_type,
    domain_resource_id: reference.domain_resource_id,
    domain_resource_version: reference.domain_resource_version,
    content_media_type: "application/pdf",
    content_bytes: "eA",
    domain_payload_bytes: payload,
    custody_controller_actor_id: `urn:evllm:actor:${uuid}`,
    custody_controller_org_id: reference.custody_controller_org_id,
    custody_controller_credential_id: `urn:evllm:credential:${uuid}`,
    custody_controller_address: `0x${"a".repeat(40)}`,
    intended_author_actor_id: `urn:evllm:actor:${uuid}`,
    intended_author_org_id: `urn:evllm:org:${uuid}`,
    intended_author_credential_id: `urn:evllm:credential:${uuid}`,
    intended_author_address: `0x${"b".repeat(40)}`,
    author_binding_profile_id: `urn:evllm:profile:${uuid}`,
    author_binding_profile_version: 1,
    primary_repository_id: `urn:evllm:repository:${uuid}`,
    content_schema_id: reference.content_schema_id,
    content_schema_version: reference.content_schema_version,
    access_class: "restricted" as const,
    initial_criticality_class: reference.initial_criticality_class,
    criticality_profile_id: reference.criticality_profile_id,
    criticality_profile_version: reference.criticality_profile_version,
    encryption_profile_id: `urn:evllm:profile:${uuid}`,
    encryption_profile_version: 1,
    controller_encryption_key_id: `urn:evllm:key:${uuid}`,
    controller_envelope_profile_id: `urn:evllm:profile:${uuid}`,
    controller_envelope_profile_version: 1,
    replica_policy: replicaPolicyFixture(),
  };
}

function replicaPolicyFixture() {
  return {
    schema: "EVLLM_REPLICA_POLICY_V1" as const,
    replica_policy_id: `urn:evllm:profile:${uuid}`,
    replica_policy_version: 1,
    required_when_decision_critical: true as const,
    replica_count: 1 as const,
    replica_custodian_org_id: `urn:evllm:org:${uuid}`,
    replica_repository_id: `urn:evllm:repository:${uuid}`,
    retention_profile_id: `urn:evllm:profile:${uuid}`,
    retention_profile_version: 1,
  };
}

function sha256Digest() {
  return { alg: "SHA-256" as const, value: "A".repeat(43) };
}
