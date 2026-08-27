import { z } from "zod";

import {
  canonicalAddress,
  canonicalDecimal,
  digest,
  positiveSafeInteger,
  semver,
  urn,
} from "./common.js";
import { bundleTypes, replicaPolicy } from "./protected-bundle.js";

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const shortText = z.string().min(1).max(256);
const text = z.string().min(1).max(16_384);
const statusTime = {
  effective_at: timestamp,
  recorded_at: timestamp,
};
const scope = z
  .object({ resource_id: z.string().min(1), resource_version: positiveSafeInteger.optional() })
  .strict();

export const unitDefinition = z
  .object({
    schema: z.literal("EVLLM_UNIT_DEFINITION_V1"),
    unit_id: urn("unit"),
    unit_version: positiveSafeInteger,
    symbol: shortText,
    dimension_vector: z.record(z.string().regex(/^[A-Z][A-Za-z0-9_-]*$/), z.number().int()),
    decimal_scale: canonicalDecimal,
    decimal_offset: canonicalDecimal.optional(),
    source: shortText,
    external_mapping: shortText.optional(),
    status: z.enum(["pending", "active", "retired"]),
    ...statusTime,
  })
  .strict();

export const organization = z
  .object({
    schema: z.literal("EVLLM_ORGANIZATION_V1"),
    organization_id: urn("org"),
    organization_version: positiveSafeInteger,
    name: shortText,
    status: z.enum(["pending", "active", "suspended", "revoked"]),
    admitted_role_ids: z.array(urn("role")).max(128),
    administrator_actor_ids: z.array(urn("actor")).max(128),
    repository_ids: z.array(urn("repository")).max(128),
    legal_identity_limitation: text,
    ...statusTime,
  })
  .strict();

export const actorCredential = z
  .object({
    schema: z.literal("EVLLM_ACTOR_CREDENTIAL_V1"),
    credential_id: urn("credential"),
    credential_version: z.literal(1),
    actor_id: urn("actor"),
    organization_id: urn("org"),
    wallet_address: canonicalAddress,
    status: z.enum(["pending", "active", "retired", "revoked", "compromised"]),
    predecessor_credential_id: urn("credential").optional(),
    successor_credential_id: urn("credential").optional(),
    role_ids: z.array(urn("role")).max(128),
    ...statusTime,
    revocation_reason: shortText.optional(),
  })
  .strict();

const rsaPublicJwk = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().min(1),
    n: z.string().regex(/^[A-Za-z0-9_-]{512}$/),
    e: z.literal("AQAB"),
    alg: z.literal("RSA-OAEP-256"),
    use: z.literal("enc"),
    key_ops: z.tuple([z.literal("wrapKey")]),
  })
  .strict();

export const organizationEncryptionKey = z
  .object({
    schema: z.literal("EVLLM_ORGANIZATION_ENCRYPTION_KEY_V1"),
    organization_id: urn("org"),
    key_id: urn("key"),
    key_version: positiveSafeInteger,
    thumbprint_uri: z
      .string()
      .regex(/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/),
    public_jwk: rsaPublicJwk,
    status: z.enum(["pending", "active", "retired", "revoked", "lost", "compromised"]),
    key_authority_actor_id: urn("actor"),
    predecessor_key_id: urn("key").optional(),
    successor_key_id: urn("key").optional(),
    ...statusTime,
    status_reason: shortText.optional(),
  })
  .strict();

export const capabilityGrant = z
  .object({
    schema: z.literal("EVLLM_CAPABILITY_GRANT_V1"),
    grant_id: urn("grant"),
    grant_version: positiveSafeInteger,
    actor_id: urn("actor"),
    organization_id: urn("org"),
    role_id: urn("role"),
    capability_id: urn("capability"),
    resource_scope: z.array(scope).min(1).max(256),
    claim_method_scope: z.array(shortText).max(256),
    effective_at: timestamp,
    expires_at: timestamp,
    grantor_actor_id: urn("actor"),
    status: z.enum(["prepared", "active", "revoked"]),
    reason: shortText,
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
  })
  .strict();

export const roleCapabilityDefinition = z
  .object({
    schema: z.literal("EVLLM_ROLE_CAPABILITY_DEFINITION_V1"),
    definition_id: urn("policy"),
    definition_version: positiveSafeInteger,
    role_id: urn("role"),
    role_code: z.string().regex(/^[a-z][a-z0-9.-]*$/),
    capability_id: urn("capability"),
    capability_code: z.string().regex(/^[a-z][a-z0-9.-]*$/),
    permitted_bundle_types: z.array(z.enum(bundleTypes)).max(bundleTypes.length),
    permitted_actions: z.array(shortText).min(1).max(256),
    required_scope: z.array(shortText).max(256),
    policy_version: positiveSafeInteger,
    status: z.enum(["pending", "active", "retired"]),
    ...statusTime,
  })
  .strict();

const dispatch = z
  .object({
    discriminator: shortText,
    capability_id: urn("capability"),
    relationship_predicate: shortText,
  })
  .strict();

export const authorBindingProfileV1 = z
  .object({
    schema: z.literal("EVLLM_AUTHOR_BINDING_PROFILE_V1"),
    profile_id: urn("profile"),
    profile_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    payload_schema_id: urn("schema"),
    payload_schema_version: semver,
    resource_id_pointer: z.string().startsWith("/"),
    resource_version_pointer: z.string().startsWith("/"),
    author_field_pointers: z.array(z.string().startsWith("/")).min(1).max(16),
    allowed_role_ids: z.array(urn("role")).min(1).max(32),
    allowed_capability_ids: z.array(urn("capability")).min(1).max(32),
    dispatch: z.array(dispatch).min(1).max(32),
    relationship_context_fields: z.array(shortText).max(64),
    separation_of_duty: z.enum(["none", "different-actor", "different-organization"]),
    revalidate_at: z.tuple([z.literal("prepare"), z.literal("domain-activation")]),
    status: z.enum(["pending", "active", "retired"]),
  })
  .strict();

export const authorBindingDecision = z
  .object({
    schema: z.literal("EVLLM_AUTHOR_BINDING_DECISION_V1"),
    decision_id: urn("decision"),
    decision_version: positiveSafeInteger,
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    domain_resource_id: z.string().startsWith("urn:evllm:"),
    domain_resource_version: positiveSafeInteger,
    domain_payload_commitment: digest,
    preparation_request_fingerprint: digest,
    author_binding_profile_id: urn("profile"),
    author_binding_profile_version: positiveSafeInteger,
    intended_author_actor_id: urn("actor"),
    intended_author_organization_id: urn("org"),
    intended_author_credential_id: urn("credential"),
    intended_author_address: canonicalAddress,
    selected_role_id: urn("role"),
    selected_capability_id: urn("capability"),
    discriminator: shortText,
    relationship_operands: z.record(z.string(), z.string()),
    relationship_source: scope,
    equality_result: z.literal("allow"),
    relationship_result: z.literal("allow"),
    evaluated_at: timestamp,
    decision_digest: digest,
  })
  .strict();

export const purposeDefinition = z
  .object({
    schema: z.literal("EVLLM_PURPOSE_DEFINITION_V1"),
    purpose_id: urn("policy"),
    purpose_version: positiveSafeInteger,
    code: z.string().regex(/^[a-z][a-z0-9.-]*$/),
    description: text,
    status: z.enum(["pending", "active", "retired"]),
    ...statusTime,
  })
  .strict();

export const accessPolicy = z
  .object({
    schema: z.literal("EVLLM_ACCESS_POLICY_V1"),
    policy_id: urn("policy"),
    policy_version: positiveSafeInteger,
    purpose_id: urn("policy"),
    bundle_types: z.array(z.enum(bundleTypes)).min(1).max(bundleTypes.length),
    access_class: z.literal("restricted"),
    domain_scope: z.array(scope).max(256),
    permitted_role_ids: z.array(urn("role")).max(128),
    permitted_organization_ids: z.array(urn("org")).max(128),
    permitted_operations: z.array(shortText).min(1).max(64),
    minimization_rule: text,
    retention_profile_id: urn("profile"),
    retention_profile_version: positiveSafeInteger,
    controller_organization_id: urn("org"),
    delegation_allowed: z.boolean(),
    fail_closed: z.literal(true),
    status: z.enum(["pending", "active", "retired"]),
  })
  .strict();

export const replicaPolicyProfile = replicaPolicy.extend({
  canonical_digest: digest,
  status: z.enum(["pending", "active", "retired"]),
  effective_at: timestamp,
});

export const repositoryRegistration = z
  .object({
    schema: z.literal("EVLLM_REPOSITORY_REGISTRATION_V1"),
    repository_id: urn("repository"),
    repository_version: positiveSafeInteger,
    custody_controller_organization_id: urn("org"),
    infrastructure_operator_organization_id: urn("org"),
    protocol_version: semver,
    adapter_version: semver,
    endpoint_alias: shortText,
    supported_operations: z.array(shortText).min(1).max(64),
    conformance_result: z.enum(["pass", "fail"]),
    status: z.enum(["pending", "active", "unavailable", "retired"]),
    approved_replica_scopes: z.array(scope).max(128),
  })
  .strict();

export const custodyRelationship = z
  .object({
    schema: z.literal("EVLLM_CUSTODY_RELATIONSHIP_V1"),
    relationship_id: urn("policy"),
    relationship_version: positiveSafeInteger,
    bundle_controller_organization_id: urn("org"),
    domain_controller_organization_id: urn("org"),
    primary_repository_id: urn("repository"),
    primary_operator_organization_id: urn("org"),
    replica_controller_organization_id: urn("org"),
    replica_operator_organization_id: urn("org"),
    permitted_bundle_types: z.array(z.enum(bundleTypes)).min(1),
    resource_scope: z.array(scope).max(256),
    effective_at: timestamp,
    status: z.enum(["pending", "active", "retired"]),
  })
  .strict();

export const batterySubject = z
  .object({
    schema: z.literal("EVLLM_BATTERY_SUBJECT_V1"),
    battery_id: urn("battery"),
    battery_version: positiveSafeInteger,
    granularity: z.enum(["pack", "module", "cell"]),
    registration_issuer_organization_id: urn("org"),
    subject_schema_id: urn("schema"),
    subject_schema_version: semver,
    status: z.enum(["pending", "active", "locked", "retired"]),
    parent_battery_id: urn("battery").optional(),
    parent_relation_version: positiveSafeInteger.optional(),
  })
  .strict();

export const identifierBinding = z
  .object({
    schema: z.literal("EVLLM_IDENTIFIER_BINDING_V1"),
    binding_id: urn("link"),
    binding_version: positiveSafeInteger,
    battery_id: urn("battery"),
    external_identifier: shortText,
    identifier_scheme: shortText,
    issuer_organization_id: urn("org"),
    source_evidence_id: urn("evidence"),
    source_evidence_version: positiveSafeInteger,
    uncertainty: z.enum(["none", "estimated", "conflicting"]),
    effective_at: timestamp,
    status: z.enum(["active", "superseded", "withdrawn"]),
  })
  .strict();

export const ownershipTransition = z
  .object({
    schema: z.literal("EVLLM_OWNERSHIP_TRANSITION_V1"),
    transition_id: urn("transition"),
    transition_version: positiveSafeInteger,
    battery_id: urn("battery"),
    previous_organization_id: urn("org").optional(),
    new_organization_id: urn("org"),
    reason: shortText,
    agreement_id: urn("agreement").optional(),
    registration_id: urn("ownership").optional(),
    event_time: timestamp,
    chain_id: positiveSafeInteger,
    transaction_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    log_index: z.number().int().nonnegative(),
  })
  .strict();

export const initialOwnershipBinding = z
  .object({
    schema: z.literal("EVLLM_INITIAL_OWNERSHIP_BINDING_V1"),
    ownership_proposal_id: urn("ownership"),
    ownership_proposal_version: z.literal(1),
    battery_id: urn("battery"),
    registrar_actor_id: urn("actor"),
    nominated_organization_id: urn("org"),
    supporting_evidence_id: urn("evidence"),
    supporting_evidence_version: positiveSafeInteger,
    supporting_commitment: digest,
    registrar_confirmation_id: urn("transition"),
    owner_confirmation_id: urn("transition").optional(),
    terminal_transition_id: urn("transition").optional(),
    nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
    expires_at: timestamp,
    state: z.enum(["proposed", "accepted", "rejected", "expired"]),
    reason: shortText.optional(),
    chain_id: positiveSafeInteger,
    transaction_hash: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

export const identityPolicySchemas = {
  unitDefinition,
  organization,
  actorCredential,
  organizationEncryptionKey,
  capabilityGrant,
  roleCapabilityDefinition,
  authorBindingProfileV1,
  authorBindingDecision,
  purposeDefinition,
  accessPolicy,
  replicaPolicyProfile,
  repositoryRegistration,
  custodyRelationship,
  batterySubject,
  identifierBinding,
  ownershipTransition,
  initialOwnershipBinding,
};
