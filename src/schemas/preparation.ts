import { prepareProtectedBundleRequest, protectedBundleRef } from "./protected-bundle.js";

export class PrepareContractMismatchError extends Error {
  public constructor(field: string) {
    super(`Prepare request does not match embedded protected_bundle_ref: ${field}`);
    this.name = "PrepareContractMismatchError";
  }
}

export function validatePrepareProtectedBundleRequest(input: unknown) {
  const request = prepareProtectedBundleRequest.parse(input);
  assertCanonicalBase64Url(request.content_bytes, "content_bytes");
  const payloadBytes = decodeCanonicalBase64Url(
    request.domain_payload_bytes,
    "domain_payload_bytes",
  );
  const payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  const payload: unknown = JSON.parse(payloadText);
  if (typeof payload !== "object" || payload === null || !("protected_bundle_ref" in payload)) {
    throw new PrepareContractMismatchError("protected_bundle_ref");
  }
  const reference = protectedBundleRef.parse(payload.protected_bundle_ref);

  const comparisons = {
    bundle_id: request.bundle_id === reference.bundle_id,
    bundle_version: request.bundle_version === reference.bundle_version,
    bundle_type: request.bundle_type === reference.bundle_type,
    domain_resource_id: request.domain_resource_id === reference.domain_resource_id,
    domain_resource_version: request.domain_resource_version === reference.domain_resource_version,
    custody_controller_org_id:
      request.custody_controller_org_id === reference.custody_controller_org_id,
    content_schema_id: request.content_schema_id === reference.content_schema_id,
    content_schema_version: request.content_schema_version === reference.content_schema_version,
    initial_criticality_class:
      request.initial_criticality_class === reference.initial_criticality_class,
    criticality_profile_id: request.criticality_profile_id === reference.criticality_profile_id,
    criticality_profile_version:
      request.criticality_profile_version === reference.criticality_profile_version,
  } as const;

  for (const [field, matches] of Object.entries(comparisons)) {
    if (!matches) {
      throw new PrepareContractMismatchError(field);
    }
  }
  return { payload, reference, request };
}

function assertCanonicalBase64Url(value: string, field: string): void {
  void decodeCanonicalBase64Url(value, field);
}

function decodeCanonicalBase64Url(value: string, field: string): Uint8Array {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new PrepareContractMismatchError(field);
  }
  return decoded;
}
