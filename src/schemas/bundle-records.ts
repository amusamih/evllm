import { z } from "zod";

import {
  base64Url,
  bytes32Hex,
  canonicalAddress,
  digest,
  opaqueObjectId,
  positiveSafeInteger,
  semver,
  uint256Hex,
  urn,
} from "./common.js";
import { recipientJwe } from "./crypto.js";
import { bundleTypes, protectedBundleRef, replicaPolicy } from "./protected-bundle.js";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().min(1).max(256);
const text = z.string().min(1).max(16_384);
const signature = base64Url.refine((value) => Buffer.from(value, "base64url").length === 65);
const ref = z.object({ id: z.string().min(1), version: positiveSafeInteger }).strict();
const chainLocator = z
  .object({
    chain_id: positiveSafeInteger,
    transaction_hash: bytes32Hex,
    block_number: z.number().int().nonnegative(),
    log_index: z.number().int().nonnegative(),
  })
  .strict();

export const claimVersion = z
  .object({
    schema: z.literal("EVLLM_CLAIM_VERSION_V1"),
    claim_version_id: urn("evidence"),
    claim_id: urn("claim"),
    sequence: positiveSafeInteger,
    prior_version_id: urn("evidence").optional(),
    correction_reason: text.optional(),
    evidence_payload_commitment: digest,
    status: z.enum(["active", "superseded", "revoked"]),
    issuer_signature_id: urn("assertion"),
    recorded_at: timestamp,
  })
  .strict();

export const verificationAssertion = z
  .object({
    schema: z.literal("EVLLM_VERIFICATION_ASSERTION_V1"),
    verification_id: urn("verification"),
    verification_version: positiveSafeInteger,
    verification_payload_ref: ref,
    domain_signature_record_id: urn("assertion"),
    assertion_type: z.enum(["corroboration", "certification"]),
    assertion_commitment: digest,
    status: z.enum(["active", "withdrawn", "superseded"]),
    status_reason: shortText.optional(),
    status_time: timestamp,
    support_links: z.array(ref).max(256),
  })
  .strict();

export const protectedBundleStagingState = z
  .object({
    schema: z.literal("EVLLM_PROTECTED_BUNDLE_STAGING_STATE_V1"),
    staging_id: urn("staging"),
    state: z.enum(["preparing", "prepared", "finalized", "expired", "rejected"]),
    state_revision: positiveSafeInteger,
    materialization_revision: positiveSafeInteger,
    preparation_idempotency_key_hash: bytes32Hex,
    preparation_request_fingerprint: digest,
    reserved_ids: z.array(z.string().startsWith("urn:evllm:")).min(1).max(32),
    staging_descriptor_digest: digest.optional(),
    preparation_command_id: urn("command"),
    finalization_command_id: urn("command").optional(),
    retained_result_ref: ref.optional(),
    preparing_at: timestamp,
    materialization_expires_at: timestamp,
    prepared_at: timestamp.optional(),
    expires_at: timestamp,
    finalized_at: timestamp.optional(),
    closed_at: timestamp.optional(),
    reason: shortText.optional(),
    correlation_id: z.uuid(),
    audit_event_id: urn("event"),
  })
  .strict();

export const domainAttestationChallengeDeliveryRecord = z
  .object({
    schema: z.literal("EVLLM_DOMAIN_ATTESTATION_CHALLENGE_DELIVERY_RECORD_V1"),
    challenge_id: urn("challenge"),
    staging_id: urn("staging"),
    staging_descriptor_digest: digest,
    challenge_digest: digest,
    intended_author_actor_id: urn("actor"),
    intended_author_organization_id: urn("org"),
    intended_author_credential_id: urn("credential"),
    intended_author_address: canonicalAddress,
    author_binding_profile_id: urn("profile"),
    author_binding_profile_version: positiveSafeInteger,
    eip712_profile_id: urn("profile"),
    eip712_profile_version: positiveSafeInteger,
    domain_name: shortText,
    domain_version: shortText,
    chain_id: positiveSafeInteger,
    protected_bundle_registry_address: canonicalAddress,
    attribution_nonce: uint256Hex,
    issued_at: timestamp,
    expires_at: timestamp,
    state: z.enum(["prepared", "delivered", "expired"]),
    prepared_at: timestamp,
    delivered_at: timestamp.optional(),
    correlation_id: z.uuid(),
    audit_event_id: urn("event"),
  })
  .strict();

export const domainSignatureRecord = z
  .object({
    schema: z.literal("EVLLM_DOMAIN_SIGNATURE_RECORD_V1"),
    signature_record_id: urn("assertion"),
    signature_record_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    payload_type: shortText,
    eip712_profile_id: urn("profile"),
    eip712_profile_version: positiveSafeInteger,
    author_binding_profile_id: urn("profile"),
    author_binding_profile_version: positiveSafeInteger,
    author_binding_decision_id: urn("decision"),
    signer_actor_id: urn("actor"),
    signer_organization_id: urn("org"),
    signer_credential_id: urn("credential"),
    signer_address: canonicalAddress,
    chain_id: positiveSafeInteger,
    verifying_contract: canonicalAddress,
    nonce: uint256Hex,
    issued_at: timestamp,
    expires_at: timestamp,
    domain_payload_commitment: digest,
    signature,
    typed_data_digest: bytes32Hex,
    signature_digest: digest,
    signed_domain_envelope_digest: digest,
    state: z.enum(["accepted", "reorganized", "rejected"]),
    accepted_at: timestamp,
    chain_locator: chainLocator.optional(),
    audit_event_id: urn("event"),
  })
  .strict();

export const protectedBundleManifest = z
  .object({
    schema: z.literal("EVLLM_PROTECTED_BUNDLE_MANIFEST_V1"),
    protected_bundle_ref: protectedBundleRef,
    domain_payload_commitment: digest,
    domain_signature_record_id: urn("assertion"),
    domain_typed_data_digest: bytes32Hex,
    domain_signature_digest: digest,
    signed_domain_envelope_digest: digest,
    author_binding_decision_id: urn("decision"),
    author_binding_decision_digest: digest,
    staging_descriptor_digest: digest,
    finalization_command_id: urn("command"),
    finalization_typed_data_digest: bytes32Hex,
    finalization_signature_digest: digest,
    custody_controller_organization_id: urn("org"),
    primary_repository_id: urn("repository"),
    access_class: z.literal("restricted"),
    content_schema_id: urn("schema"),
    content_schema_uri: z.url(),
    content_schema_version: semver,
    schema_binding_digest: digest,
    author_binding_profile_id: urn("profile"),
    author_binding_profile_version: positiveSafeInteger,
    encryption_profile_id: urn("profile"),
    encryption_profile_version: positiveSafeInteger,
    controller_key_authorization_id: urn("authorization"),
    controller_envelope_id: urn("envelope"),
    controller_encryption_key_id: urn("key"),
    controller_envelope_profile_id: urn("profile"),
    controller_envelope_profile_version: positiveSafeInteger,
    recipient_envelope_commitment: digest,
    content_commitment: digest,
    content_envelope_digest: digest,
    primary_object_id: opaqueObjectId,
    stored_envelope_length: positiveSafeInteger,
    object_state: z.literal("finalized"),
    replica_policy: replicaPolicy,
    provenance_links: z.array(ref).max(256),
    finalized_at: timestamp,
  })
  .strict();

export const resolvedProtectedBundleView = z
  .object({
    schema: z.literal("EVLLM_RESOLVED_PROTECTED_BUNDLE_VIEW_V1"),
    protected_bundle_ref: protectedBundleRef,
    domain_payload_commitment: digest,
    content_commitment: digest,
    content_envelope_digest: digest,
    stored_envelope_length: positiveSafeInteger,
    schema_binding_digest: digest,
    author_binding_profile_id: urn("profile"),
    author_binding_profile_version: positiveSafeInteger,
    encryption_profile_id: urn("profile"),
    encryption_profile_version: positiveSafeInteger,
    replica_policy: replicaPolicy,
    replica_policy_digest: digest,
    primary_repository_id: urn("repository"),
    access_class: z.literal("restricted"),
    access_result: z.enum(["allow", "deny"]),
    current_criticality: z.enum(["supplementary", "decision-critical"]),
    replica_state: z.enum(["not-required", "pending", "verified", "unavailable"]),
    availability_state: z.enum(["available", "unavailable", "unknown"]),
    registry_status: z.enum(["confirmed", "reorganized"]),
    chain_locator: chainLocator,
    as_of_block: z.number().int().nonnegative(),
    as_of_time: timestamp,
  })
  .strict();

export const evidenceManifest = z
  .object({
    schema: z.literal("EVLLM_EVIDENCE_MANIFEST_V1"),
    evidence_id: urn("evidence"),
    evidence_version: positiveSafeInteger,
    evidence_claim_payload_ref: ref,
    protected_bundle_ref: protectedBundleRef,
    claim_id: urn("claim"),
    subject_id: z.string().startsWith("urn:evllm:"),
    issuer_organization_id: urn("org"),
    content_schema_id: urn("schema"),
    content_schema_version: semver,
    method: ref,
    source_class: shortText,
    provenance: z.array(ref).max(256),
    domain_signature_record_id: urn("assertion"),
    signed_domain_envelope_digest: digest,
    signature_digest: digest,
    lifecycle: z.enum(["active", "superseded", "revoked"]),
    support_links: z.array(ref).max(256),
  })
  .strict();

export const protectedDomainActivationAttempt = z
  .object({
    schema: z.literal("EVLLM_PROTECTED_DOMAIN_ACTIVATION_ATTEMPT_V1"),
    attempt_id: urn("attempt"),
    attempt_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    staging_id: urn("staging"),
    finalization_command_id: urn("command"),
    proof_expires_at: timestamp,
    state: z.enum([
      "prepared",
      "finalized-awaiting-bundle",
      "bundle-confirmed-awaiting-domain",
      "active",
      "expired-before-finalization",
      "rejected-before-finalization",
      "abandoned-before-registry-commit",
      "stranded-by-authority-revocation",
      "domain-rejected-after-bundle-confirmation",
    ]),
    command_ids: z.array(urn("command")).max(16),
    transaction_hashes: z.array(bytes32Hex).max(16),
    reason: shortText.optional(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .strict();

export const protectedBundleCriticalityTransition = z
  .object({
    schema: z.literal("EVLLM_PROTECTED_BUNDLE_CRITICALITY_TRANSITION_V1"),
    transition_id: urn("transition"),
    transition_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    prior_class: z.literal("supplementary"),
    new_class: z.literal("decision-critical"),
    reason: text,
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    controller_command_id: urn("command"),
    replica_receipt_id: urn("receipt"),
    status: z.enum(["pending-replica", "confirmed", "reorganized"]),
    chain_locator: chainLocator.optional(),
    recorded_at: timestamp,
  })
  .strict();

export const recipientKeyEnvelope = z
  .object({
    schema: z.literal("EVLLM_RECIPIENT_KEY_ENVELOPE_V1"),
    envelope_id: urn("envelope"),
    envelope_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    recipient_organization_id: urn("org"),
    recipient_key_id: urn("key"),
    recipient_key_thumbprint_uri: shortText,
    grant_id: urn("grant").optional(),
    controller_authorization_id: urn("authorization").optional(),
    purpose_id: urn("policy"),
    scope: z.array(shortText).min(1).max(64),
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    jwe: recipientJwe,
    envelope_commitment: digest,
    status: z.enum(["staged", "active", "retired", "revoked", "unavailable"]),
    created_at: timestamp,
    activated_at: timestamp.optional(),
    retired_at: timestamp.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.grant_id === undefined) === (value.controller_authorization_id === undefined)) {
      context.addIssue({ code: "custom", message: "Exactly one authority reference is required" });
    }
  });

export const controllerKeyAuthorization = z
  .object({
    schema: z.literal("EVLLM_CONTROLLER_KEY_AUTHORIZATION_V1"),
    authorization_id: urn("authorization"),
    authorization_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    controller_organization_id: urn("org"),
    controller_key_id: urn("key"),
    envelope_id: urn("envelope"),
    status: z.enum(["staged", "active", "retired", "revoked", "unavailable"]),
    predecessor_authorization_id: urn("authorization").optional(),
    successor_authorization_id: urn("authorization").optional(),
    created_at: timestamp,
    activated_at: timestamp.optional(),
    retired_at: timestamp.optional(),
  })
  .strict();

export const accessGrant = z
  .object({
    schema: z.literal("EVLLM_ACCESS_GRANT_V1"),
    grant_id: urn("grant"),
    grant_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    recipient_actor_id: urn("actor"),
    recipient_organization_id: urn("org"),
    purpose_id: urn("policy"),
    operations: z.array(shortText).min(1).max(32),
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    effective_at: timestamp,
    expires_at: timestamp,
    envelope_id: urn("envelope").optional(),
    status: z.enum(["prepared", "active", "revoked"]),
    revocation_reason: shortText.optional(),
  })
  .strict();

export const authorizationDecision = z
  .object({
    schema: z.literal("EVLLM_AUTHORIZATION_DECISION_V1"),
    decision_id: urn("decision"),
    decision_version: positiveSafeInteger,
    actor_id: urn("actor"),
    organization_id: urn("org"),
    credential_id: urn("credential"),
    session_id: urn("session"),
    repository_id: urn("repository"),
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    operation: shortText,
    purpose_id: urn("policy"),
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    result: z.enum(["allow", "deny"]),
    reason: shortText,
    issued_at: timestamp,
    expires_at: timestamp,
    correlation_id: z.uuid(),
    decision_digest: digest,
    grant_id: urn("grant").optional(),
    envelope_id: urn("envelope").optional(),
    release_mode: z.enum(["full", "excerpt", "ciphertext"]).optional(),
    preparation_request_fingerprint: digest.optional(),
  })
  .strict();

export const keyOperationAuthorization = z
  .object({
    schema: z.literal("EVLLM_KEY_OPERATION_AUTHORIZATION_V1"),
    authorization_id: urn("authorization"),
    authorization_version: positiveSafeInteger,
    issuer_service_actor_id: urn("actor"),
    issuer_service_organization_id: urn("org"),
    issuer_service_credential_id: urn("credential"),
    issuer_service_address: canonicalAddress,
    repository_id: urn("repository"),
    operation: shortText,
    requesting_actor_id: urn("actor"),
    requesting_organization_id: urn("org"),
    requesting_credential_id: urn("credential"),
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    purpose_id: urn("policy"),
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    source_authority_ids: z.array(z.string().startsWith("urn:evllm:")).min(1).max(16),
    source_authority_digest: digest,
    operation_context_digest: digest,
    nonce: uint256Hex,
    issued_at: timestamp,
    expires_at: timestamp,
    idempotency_key_hash: bytes32Hex,
    signature,
    typed_data_digest: bytes32Hex,
    signature_digest: digest,
    state: z.enum(["issued", "consumed", "expired", "rejected"]),
    result_ref: ref.optional(),
  })
  .strict();

const rotationItem = z
  .object({
    grant_id: urn("grant"),
    envelope_id: urn("envelope"),
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    outcome: z.enum(["pending", "complete", "unavailable", "failed"]),
  })
  .strict();

export const recipientKeyRotationCampaign = z
  .object({
    schema: z.literal("EVLLM_RECIPIENT_KEY_ROTATION_CAMPAIGN_V1"),
    campaign_id: urn("campaign"),
    campaign_version: positiveSafeInteger,
    recipient_organization_id: urn("org"),
    administrator_actor_id: urn("actor"),
    administrator_credential_id: urn("credential"),
    predecessor_key_id: urn("key"),
    successor_key_id: urn("key"),
    required_items: z.array(rotationItem).min(1).max(4096),
    required_set_digest: digest,
    required_count: positiveSafeInteger,
    nonce: uint256Hex,
    issued_at: timestamp,
    expires_at: timestamp,
    idempotency_key_hash: bytes32Hex,
    signature,
    state: z.enum(["prepared", "in-progress", "complete", "expired", "failed"]),
  })
  .strict();

export const replicaRecord = z
  .object({
    schema: z.literal("EVLLM_REPLICA_RECORD_V1"),
    replica_id: urn("replica"),
    replica_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    primary_repository_id: urn("repository"),
    replica_repository_id: urn("repository"),
    primary_object_id: opaqueObjectId,
    replica_object_id: opaqueObjectId,
    content_envelope_digest: digest,
    stored_envelope_length: positiveSafeInteger,
    state: z.enum(["pending", "stored", "verified", "failed", "reorganized"]),
    attempt: positiveSafeInteger,
    attempted_at: timestamp,
    verification_result: z.enum(["pass", "fail"]),
    receipt_nonce: uint256Hex,
    observed_at: timestamp,
    expires_at: timestamp,
    custodian_organization_id: urn("org"),
    signer_credential_id: urn("credential"),
    receipt_signature: signature,
    receipt_digest: digest,
    failure_reason: shortText.optional(),
  })
  .strict();

export const replicaReceipt = z
  .object({
    schema: z.literal("EVLLM_REPLICA_RECEIPT_V1"),
    receipt_id: urn("receipt"),
    receipt_version: positiveSafeInteger,
    eip712_profile_id: urn("profile"),
    eip712_profile_version: positiveSafeInteger,
    chain_id: positiveSafeInteger,
    verifying_contract: canonicalAddress,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    content_envelope_digest: digest,
    stored_envelope_length: positiveSafeInteger,
    replica_repository_id: urn("repository"),
    replica_custodian_organization_id: urn("org"),
    criticality_profile_id: urn("profile"),
    criticality_profile_version: positiveSafeInteger,
    signer_credential_id: urn("credential"),
    signer_address: canonicalAddress,
    nonce: uint256Hex,
    observed_at: timestamp,
    expires_at: timestamp,
    signature,
    receipt_digest: digest,
  })
  .strict();

export const derivedArtifactDescriptor = z
  .object({
    schema: z.literal("EVLLM_DERIVED_ARTIFACT_DESCRIPTOR_V1"),
    artifact_id: urn("link"),
    artifact_version: positiveSafeInteger,
    source_bundle_id: urn("bundle"),
    source_bundle_version: positiveSafeInteger,
    source_bundle_type: z.enum(bundleTypes),
    source_domain_resource_id: z.string().startsWith("urn:evllm:"),
    source_domain_resource_version: positiveSafeInteger,
    artifact_type: shortText,
    custodian_organization_id: urn("org"),
    purpose_id: urn("policy"),
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    method_profile_id: urn("profile"),
    method_profile_version: positiveSafeInteger,
    model_profile_id: urn("profile").optional(),
    model_profile_version: positiveSafeInteger.optional(),
    status: z.enum(["active", "invalidated"]),
    retention_profile_id: urn("profile"),
    retention_profile_version: positiveSafeInteger,
    artifact_digest: digest,
    index_namespace: shortText,
    invalidation_reason: shortText.optional(),
    invalidated_at: timestamp.optional(),
  })
  .strict();

export const bundleRecordSchemas = {
  claimVersion,
  verificationAssertion,
  protectedBundleStagingState,
  domainAttestationChallengeDeliveryRecord,
  protectedBundleManifest,
  resolvedProtectedBundleView,
  domainSignatureRecord,
  evidenceManifest,
  protectedDomainActivationAttempt,
  protectedBundleCriticalityTransition,
  recipientKeyEnvelope,
  controllerKeyAuthorization,
  accessGrant,
  authorizationDecision,
  keyOperationAuthorization,
  recipientKeyRotationCampaign,
  replicaRecord,
  replicaReceipt,
  derivedArtifactDescriptor,
};
