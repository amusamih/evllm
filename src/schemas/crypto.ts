import { z } from "zod";

import {
  base64Url,
  base64Url32,
  digest,
  mediaType,
  positiveSafeInteger,
  semver,
  urn,
} from "./common.js";
import {
  accessClass,
  bundleTypes,
  type BundleType,
  domainKindByBundleType,
} from "./protected-bundle.js";

export const protectedPackage = z
  .object({
    schema: z.literal("EVLLM_PROTECTED_PACKAGE_V1"),
    content_media_type: mediaType,
    content_bytes: base64Url,
    content_commitment_salt: base64Url32,
    domain_payload_bytes: base64Url,
    domain_payload_commitment_salt: base64Url32,
  })
  .strict();

const protectedContentAadBase = {
  schema: z.literal("EVLLM_PROTECTED_CONTENT_AAD_V1"),
  bundle_id: urn("bundle"),
  bundle_version: positiveSafeInteger,
  domain_resource_version: positiveSafeInteger,
  domain_payload_commitment: digest,
  custody_controller_org_id: urn("org"),
  primary_repository_id: urn("repository"),
  content_schema_id: urn("schema"),
  content_schema_version: semver,
  access_class: accessClass,
  initial_criticality_class: z.enum(["decision-critical", "supplementary"]),
  criticality_profile_id: urn("profile"),
  criticality_profile_version: positiveSafeInteger,
};

function protectedContentAadVariant<T extends BundleType>(bundleType: T) {
  return z
    .object({
      ...protectedContentAadBase,
      bundle_type: z.literal(bundleType),
      domain_resource_id: urn(domainKindByBundleType[bundleType]),
    })
    .strict();
}

export const protectedContentAad = z.discriminatedUnion("bundle_type", [
  protectedContentAadVariant("evidence"),
  protectedContentAadVariant("verification"),
  protectedContentAadVariant("assessment"),
  protectedContentAadVariant("assistant-support"),
  protectedContentAadVariant("listing"),
  protectedContentAadVariant("agreement"),
  protectedContentAadVariant("dispute"),
  protectedContentAadVariant("logistics"),
  protectedContentAadVariant("audit"),
  protectedContentAadVariant("authoritative-source"),
]);

export const contentJwe = z
  .object({
    protected: base64Url,
    aad: base64Url,
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: base64Url,
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

export const recipientKid = z
  .string()
  .regex(/^urn:ietf:params:oauth:jwk-thumbprint:sha-256:[A-Za-z0-9_-]{43}$/);

const dekWrapContextBase = z
  .object({
    schema: z.literal("EVLLM_DEK_WRAP_CONTEXT_V1"),
    envelope_id: urn("envelope"),
    bundle_id: urn("bundle"),
    bundle_version: positiveSafeInteger,
    bundle_type: z.enum(bundleTypes),
    domain_resource_id: z.string(),
    domain_resource_version: positiveSafeInteger,
    domain_payload_commitment: digest,
    content_commitment: digest,
    content_envelope_digest: digest,
    recipient_org_id: urn("org"),
    recipient_kid: recipientKid,
    purpose: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
  })
  .strict();

export const dekWrapContext = z
  .union([
    dekWrapContextBase.extend({
      authorization_id: urn("authorization"),
      scope: z.literal("protected-bundle:key-administration"),
      purpose: z.literal("controller-custody"),
    }),
    dekWrapContextBase
      .extend({
        authorization_id: urn("grant"),
        scope: z.literal("protected-bundle:decrypt"),
      })
      .refine(({ purpose }) => purpose !== "controller-custody", {
        message: "An ordinary recipient grant cannot use the controller-custody purpose",
        path: ["purpose"],
      }),
  ])
  .superRefine(({ bundle_type: bundleType, domain_resource_id: resourceId }, context) => {
    if (!urn(domainKindByBundleType[bundleType]).safeParse(resourceId).success) {
      context.addIssue({
        code: "custom",
        message: "domain_resource_id does not match bundle_type",
        path: ["domain_resource_id"],
      });
    }
  });

export const recipientJwe = z
  .object({
    protected: base64Url,
    aad: base64Url,
    encrypted_key: base64Url,
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ciphertext: base64Url,
    tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  })
  .strict();

export { bundleTypes };
