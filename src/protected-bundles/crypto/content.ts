import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import { FlattenedEncrypt, flattenedDecrypt } from "jose";

import { contentJwe, digest, protectedContentAad, protectedPackage } from "../../schemas/index.js";
import { canonicalJsonBytes, parseExactCanonicalJson } from "./canonical.js";

const CONTENT_COMMITMENT_DOMAIN = new TextEncoder().encode("EVLLM_PROTECTED_CONTENT_COMMITMENT_V1");
const DOMAIN_COMMITMENT_DOMAIN = new TextEncoder().encode("EVLLM_DOMAIN_PAYLOAD_COMMITMENT_V1");

export const protectedContentHeader = {
  alg: "dir",
  cty: "application/vnd.evllm.protected-package+json",
  enc: "A256GCM",
  typ: "application/vnd.evllm.protected-content+jwe",
} as const;

export interface ProtectContentInput {
  readonly aad: Omit<ReturnType<typeof protectedContentAad.parse>, "domain_payload_commitment">;
  readonly content: Uint8Array;
  readonly contentMediaType: string;
  readonly domainPayload: Uint8Array;
  readonly randomBytes?: (length: number) => Uint8Array;
}

export interface ProtectedContentResult {
  readonly aad: ReturnType<typeof protectedContentAad.parse>;
  readonly contentCommitment: ReturnType<typeof digest.parse>;
  readonly contentEnvelopeDigest: ReturnType<typeof digest.parse>;
  readonly dek: Uint8Array;
  readonly domainPayloadCommitment: ReturnType<typeof digest.parse>;
  readonly envelopeBytes: Uint8Array;
  readonly packageBytes: Uint8Array;
}

export async function protectContent(input: ProtectContentInput): Promise<ProtectedContentResult> {
  assertCanonicalDomainPayload(input.domainPayload);
  const randomness = input.randomBytes ?? ((length: number) => nodeRandomBytes(length));
  const dek = exactRandom(randomness, 32);
  const iv = exactRandom(randomness, 12);
  const contentSalt = exactRandom(randomness, 32);
  const domainSalt = exactRandom(randomness, 32);
  const contentCommitment = commitment(CONTENT_COMMITMENT_DOMAIN, contentSalt, input.content);
  const domainPayloadCommitment = commitment(
    DOMAIN_COMMITMENT_DOMAIN,
    domainSalt,
    input.domainPayload,
  );
  const aad = protectedContentAad.parse({
    ...input.aad,
    domain_payload_commitment: domainPayloadCommitment,
  });
  const packageObject = protectedPackage.parse({
    schema: "EVLLM_PROTECTED_PACKAGE_V1",
    content_media_type: input.contentMediaType,
    content_bytes: Buffer.from(input.content).toString("base64url"),
    content_commitment_salt: Buffer.from(contentSalt).toString("base64url"),
    domain_payload_bytes: Buffer.from(input.domainPayload).toString("base64url"),
    domain_payload_commitment_salt: Buffer.from(domainSalt).toString("base64url"),
  });
  const packageBytes = canonicalJsonBytes(packageObject);
  const aadBytes = canonicalJsonBytes(aad);
  const encrypted = await new FlattenedEncrypt(packageBytes)
    .setProtectedHeader(protectedContentHeader)
    .setAdditionalAuthenticatedData(aadBytes)
    .setInitializationVector(iv)
    .encrypt(dek);
  const envelope = contentJwe.parse({
    protected: encrypted.protected,
    aad: encrypted.aad,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    tag: encrypted.tag,
  });
  const envelopeBytes = canonicalJsonBytes(envelope);
  return {
    aad,
    contentCommitment,
    contentEnvelopeDigest: sha256(envelopeBytes),
    dek,
    domainPayloadCommitment,
    envelopeBytes,
    packageBytes,
  };
}

export async function openProtectedContent(
  envelopeBytes: Uint8Array,
  dek: Uint8Array,
  expectedAad: ReturnType<typeof protectedContentAad.parse>,
): Promise<{ readonly content: Uint8Array; readonly domainPayload: Uint8Array }> {
  if (dek.byteLength !== 32) throw new TypeError("A256GCM requires a 32-byte DEK");
  const envelope = contentJwe.parse(parseExactCanonicalJson(envelopeBytes));
  const headerBytes = Buffer.from(envelope.protected, "base64url");
  const header = parseExactCanonicalJson(headerBytes);
  if (!equalBytes(canonicalJsonBytes(header), canonicalJsonBytes(protectedContentHeader))) {
    throw new TypeError("Protected content header does not match the fixed profile");
  }
  const aadBytes = Buffer.from(envelope.aad, "base64url");
  const aad = protectedContentAad.parse(parseExactCanonicalJson(aadBytes));
  if (!equalBytes(canonicalJsonBytes(aad), canonicalJsonBytes(expectedAad))) {
    throw new TypeError("Protected content AAD does not match the expected context");
  }
  const { plaintext } = await flattenedDecrypt(envelope, dek);
  const packageObject = protectedPackage.parse(parseExactCanonicalJson(plaintext));
  const content = Uint8Array.from(Buffer.from(packageObject.content_bytes, "base64url"));
  const domainPayload = Uint8Array.from(
    Buffer.from(packageObject.domain_payload_bytes, "base64url"),
  );
  assertCanonicalDomainPayload(domainPayload);
  const contentCommitment = commitment(
    CONTENT_COMMITMENT_DOMAIN,
    Buffer.from(packageObject.content_commitment_salt, "base64url"),
    content,
  );
  const domainCommitment = commitment(
    DOMAIN_COMMITMENT_DOMAIN,
    Buffer.from(packageObject.domain_payload_commitment_salt, "base64url"),
    domainPayload,
  );
  if (
    domainCommitment.value !== aad.domain_payload_commitment.value ||
    contentCommitment.alg !== "SHA-256"
  ) {
    throw new TypeError("Protected package commitment mismatch");
  }
  return { content, domainPayload };
}

function commitment(domain: Uint8Array, salt: Uint8Array, value: Uint8Array) {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return digest.parse({
    alg: "SHA-256",
    value: createHash("sha256")
      .update(domain)
      .update(Uint8Array.of(0))
      .update(salt)
      .update(length)
      .update(value)
      .digest("base64url"),
  });
}

function sha256(value: Uint8Array) {
  return digest.parse({
    alg: "SHA-256",
    value: createHash("sha256").update(value).digest("base64url"),
  });
}

function exactRandom(source: (length: number) => Uint8Array, length: number): Uint8Array {
  const value = source(length);
  if (value.byteLength !== length) throw new TypeError("Random source returned an invalid length");
  return Uint8Array.from(value);
}

function assertCanonicalDomainPayload(value: Uint8Array): void {
  void parseExactCanonicalJson(value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
