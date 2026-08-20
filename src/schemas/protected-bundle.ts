import { z } from "zod";

import {
  base64Url,
  base64Url32,
  canonicalAddress,
  digest,
  mediaType,
  opaqueObjectId,
  positiveSafeInteger,
  semver,
  uint256Hex,
  urn,
} from "./common.js";

export const bundleTypes = [
  "evidence",
  "verification",
  "assessment",
  "assistant-support",
  "listing",
  "agreement",
  "dispute",
  "logistics",
  "audit",
  "authoritative-source",
] as const;

export type BundleType = (typeof bundleTypes)[number];

export const domainKindByBundleType = {
  evidence: "evidence",
  verification: "verification",
  assessment: "assessment",
  "assistant-support": "assistant",
  listing: "listing",
  agreement: "agreement",
  dispute: "dispute",
  logistics: "delivery",
  audit: "audit",
  "authoritative-source": "source",
} as const;

const protectedBundleRefBase = {
  schema: z.literal("EVLLM_PROTECTED_BUNDLE_REF_V1"),
  bundle_id: urn("bundle"),
  bundle_version: positiveSafeInteger,
  domain_resource_version: positiveSafeInteger,
  custody_controller_org_id: urn("org"),
  content_schema_id: urn("schema"),
  content_schema_version: semver,
  initial_criticality_class: z.enum(["decision-critical", "supplementary"]),
  criticality_profile_id: urn("profile"),
  criticality_profile_version: positiveSafeInteger,
};

function protectedBundleRefVariant<T extends BundleType>(bundleType: T) {
  return z
    .object({
      ...protectedBundleRefBase,
      bundle_type: z.literal(bundleType),
      domain_resource_id: urn(domainKindByBundleType[bundleType]),
    })
    .strict();
}

export const protectedBundleRef = z.discriminatedUnion("bundle_type", [
  protectedBundleRefVariant("evidence"),
  protectedBundleRefVariant("verification"),
  protectedBundleRefVariant("assessment"),
  protectedBundleRefVariant("assistant-support"),
  protectedBundleRefVariant("listing"),
  protectedBundleRefVariant("agreement"),
  protectedBundleRefVariant("dispute"),
  protectedBundleRefVariant("logistics"),
  protectedBundleRefVariant("audit"),
  protectedBundleRefVariant("authoritative-source"),
]);

export const replicaPolicy = z
  .object({
    schema: z.literal("EVLLM_REPLICA_POLICY_V1"),
    replica_policy_id: urn("profile"),
    replica_policy_version: positiveSafeInteger,
    required_when_decision_critical: z.literal(true),
    replica_count: z.literal(1),
    replica_custodian_org_id: urn("org"),
    replica_repository_id: urn("repository"),
    retention_profile_id: urn("profile"),
    retention_profile_version: positiveSafeInteger,
  })
  .strict();

export const accessClass = z.literal("restricted");

const prepareProtectedBundleRequestBase = {
  schema: z.literal("EVLLM_PREPARE_PROTECTED_BUNDLE_REQUEST_V1"),
  bundle_id: urn("bundle"),
  bundle_version: positiveSafeInteger,
  domain_resource_version: positiveSafeInteger,
  content_media_type: mediaType,
  content_bytes: base64Url,
  domain_payload_bytes: base64Url,
  custody_controller_actor_id: urn("actor"),
  custody_controller_org_id: urn("org"),
  custody_controller_credential_id: urn("credential"),
  custody_controller_address: canonicalAddress,
  intended_author_actor_id: urn("actor"),
  intended_author_org_id: urn("org"),
  intended_author_credential_id: urn("credential"),
  intended_author_address: canonicalAddress,
  author_binding_profile_id: urn("profile"),
  author_binding_profile_version: positiveSafeInteger,
  primary_repository_id: urn("repository"),
  content_schema_id: urn("schema"),
  content_schema_version: semver,
  access_class: accessClass,
  initial_criticality_class: z.enum(["decision-critical", "supplementary"]),
  criticality_profile_id: urn("profile"),
  criticality_profile_version: positiveSafeInteger,
  encryption_profile_id: urn("profile"),
  encryption_profile_version: positiveSafeInteger,
  controller_encryption_key_id: urn("key"),
  controller_envelope_profile_id: urn("profile"),
  controller_envelope_profile_version: positiveSafeInteger,
  replica_policy: replicaPolicy,
};

function prepareProtectedBundleRequestVariant<T extends BundleType>(bundleType: T) {
  return z
    .object({
      ...prepareProtectedBundleRequestBase,
      bundle_type: z.literal(bundleType),
      domain_resource_id: urn(domainKindByBundleType[bundleType]),
    })
    .strict();
}

export const prepareProtectedBundleRequest = z.discriminatedUnion("bundle_type", [
  prepareProtectedBundleRequestVariant("evidence"),
  prepareProtectedBundleRequestVariant("verification"),
  prepareProtectedBundleRequestVariant("assessment"),
  prepareProtectedBundleRequestVariant("assistant-support"),
  prepareProtectedBundleRequestVariant("listing"),
  prepareProtectedBundleRequestVariant("agreement"),
  prepareProtectedBundleRequestVariant("dispute"),
  prepareProtectedBundleRequestVariant("logistics"),
  prepareProtectedBundleRequestVariant("audit"),
  prepareProtectedBundleRequestVariant("authoritative-source"),
]);

const protectedBundleStagingDescriptorBase = {
  schema: z.literal("EVLLM_PROTECTED_BUNDLE_STAGING_V1"),
  staging_id: urn("staging"),
  repository_receipt_id: urn("receipt"),
  bundle_id: urn("bundle"),
  bundle_version: positiveSafeInteger,
  domain_resource_version: positiveSafeInteger,
  domain_payload_commitment: digest,
  custody_controller_org_id: urn("org"),
  primary_repository_id: urn("repository"),
  staging_object_id: opaqueObjectId,
  primary_object_id: opaqueObjectId,
  content_schema_id: urn("schema"),
  content_schema_version: semver,
  author_binding_profile_id: urn("profile"),
  author_binding_profile_version: positiveSafeInteger,
  author_binding_decision_id: urn("decision"),
  author_binding_decision_digest: digest,
  access_class: accessClass,
  initial_criticality_class: z.enum(["decision-critical", "supplementary"]),
  criticality_profile_id: urn("profile"),
  criticality_profile_version: positiveSafeInteger,
  content_commitment: digest,
  content_envelope_digest: digest,
  encryption_profile_id: urn("profile"),
  encryption_profile_version: positiveSafeInteger,
  controller_key_authorization_id: urn("authorization"),
  controller_envelope_id: urn("envelope"),
  controller_encryption_key_id: urn("key"),
  controller_envelope_profile_id: urn("profile"),
  controller_envelope_profile_version: positiveSafeInteger,
  controller_envelope_commitment: digest,
  stored_envelope_length: positiveSafeInteger,
  replica_policy: replicaPolicy,
  prepared_at: positiveSafeInteger,
  expires_at: positiveSafeInteger,
  preparation_idempotency_key_hash: uint256Hex,
};

function protectedBundleStagingDescriptorVariant<T extends BundleType>(bundleType: T) {
  return z
    .object({
      ...protectedBundleStagingDescriptorBase,
      bundle_type: z.literal(bundleType),
      domain_resource_id: urn(domainKindByBundleType[bundleType]),
    })
    .strict()
    .superRefine(({ expires_at, prepared_at }, context) => {
      if (prepared_at >= expires_at) {
        context.addIssue({ code: "custom", message: "prepared_at must be before expires_at" });
      }
    });
}

export const protectedBundleStagingDescriptor = z.discriminatedUnion("bundle_type", [
  protectedBundleStagingDescriptorVariant("evidence"),
  protectedBundleStagingDescriptorVariant("verification"),
  protectedBundleStagingDescriptorVariant("assessment"),
  protectedBundleStagingDescriptorVariant("assistant-support"),
  protectedBundleStagingDescriptorVariant("listing"),
  protectedBundleStagingDescriptorVariant("agreement"),
  protectedBundleStagingDescriptorVariant("dispute"),
  protectedBundleStagingDescriptorVariant("logistics"),
  protectedBundleStagingDescriptorVariant("audit"),
  protectedBundleStagingDescriptorVariant("authoritative-source"),
]);

const eip712Domain = z
  .object({
    name: z.literal("EVLLM Domain Manifest"),
    version: z.literal("1"),
    chain_id: positiveSafeInteger,
    verifying_contract: canonicalAddress,
  })
  .strict();

const domainAttestationChallengeBase = {
  schema: z.literal("EVLLM_DOMAIN_ATTESTATION_CHALLENGE_V1"),
  challenge_id: urn("challenge"),
  staging_id: urn("staging"),
  staging_descriptor_digest: digest,
  bundle_id: urn("bundle"),
  bundle_version: positiveSafeInteger,
  domain_resource_version: positiveSafeInteger,
  domain_payload_bytes: base64Url,
  domain_payload_salt: base64Url32,
  domain_payload_commitment: digest,
  author_binding_profile_id: urn("profile"),
  author_binding_profile_version: positiveSafeInteger,
  eip712_profile_id: urn("profile"),
  eip712_profile_version: positiveSafeInteger,
  eip712_domain: eip712Domain,
  signer_actor_id: urn("actor"),
  signer_org_id: urn("org"),
  signer_credential_id: urn("credential"),
  signer_address: canonicalAddress,
  nonce: uint256Hex,
  issued_at: positiveSafeInteger,
  expires_at: positiveSafeInteger,
  prepared_at: positiveSafeInteger,
  staging_expires_at: positiveSafeInteger,
};

function domainAttestationChallengeVariant<T extends BundleType>(bundleType: T) {
  return z
    .object({
      ...domainAttestationChallengeBase,
      bundle_type: z.literal(bundleType),
      domain_resource_id: urn(domainKindByBundleType[bundleType]),
    })
    .strict();
}

export const domainAttestationChallenge = z.discriminatedUnion("bundle_type", [
  domainAttestationChallengeVariant("evidence"),
  domainAttestationChallengeVariant("verification"),
  domainAttestationChallengeVariant("assessment"),
  domainAttestationChallengeVariant("assistant-support"),
  domainAttestationChallengeVariant("listing"),
  domainAttestationChallengeVariant("agreement"),
  domainAttestationChallengeVariant("dispute"),
  domainAttestationChallengeVariant("logistics"),
  domainAttestationChallengeVariant("audit"),
  domainAttestationChallengeVariant("authoritative-source"),
]);
