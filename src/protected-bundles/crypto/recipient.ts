import { createHash, randomBytes, type KeyObject } from "node:crypto";

import { FlattenedEncrypt, flattenedDecrypt } from "jose";

import { dekWrapContext, digest, recipientJwe } from "../../schemas/index.js";
import { canonicalJsonBytes, parseExactCanonicalJson } from "./canonical.js";

export interface WrapDekInput {
  readonly context: ReturnType<typeof dekWrapContext.parse>;
  readonly dek: Uint8Array;
  readonly publicKey: KeyObject;
}

export interface WrappedDekResult {
  readonly commitment: ReturnType<typeof digest.parse>;
  readonly envelopeBytes: Uint8Array;
}

export async function wrapDek(input: WrapDekInput): Promise<WrappedDekResult> {
  if (input.dek.byteLength !== 32) throw new TypeError("A bundle DEK must be exactly 32 bytes");
  assertRsa3072PublicKey(input.publicKey);
  const context = dekWrapContext.parse(input.context);
  const header = {
    alg: "RSA-OAEP-256",
    cty: "application/octet-stream",
    enc: "A256GCM",
    kid: context.recipient_kid,
    typ: "application/vnd.evllm.dek-envelope+jwe",
  } as const;
  const encrypted = await new FlattenedEncrypt(input.dek)
    .setProtectedHeader(header)
    .setAdditionalAuthenticatedData(canonicalJsonBytes(context))
    .setInitializationVector(randomBytes(12))
    .encrypt(input.publicKey);
  const envelope = recipientJwe.parse({
    protected: encrypted.protected,
    aad: encrypted.aad,
    encrypted_key: encrypted.encrypted_key,
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    tag: encrypted.tag,
  });
  const envelopeBytes = canonicalJsonBytes(envelope);
  return { commitment: sha256(envelopeBytes), envelopeBytes };
}

export async function unwrapDek(
  envelopeBytes: Uint8Array,
  privateKey: KeyObject,
  expectedContext: ReturnType<typeof dekWrapContext.parse>,
): Promise<Uint8Array> {
  const envelope = recipientJwe.parse(parseExactCanonicalJson(envelopeBytes));
  const context = dekWrapContext.parse(
    parseExactCanonicalJson(Buffer.from(envelope.aad, "base64url")),
  );
  if (!equal(canonicalJsonBytes(context), canonicalJsonBytes(expectedContext))) {
    throw new TypeError("DEK envelope context mismatch");
  }
  const expectedHeader = {
    alg: "RSA-OAEP-256",
    cty: "application/octet-stream",
    enc: "A256GCM",
    kid: context.recipient_kid,
    typ: "application/vnd.evllm.dek-envelope+jwe",
  } as const;
  const header = parseExactCanonicalJson(Buffer.from(envelope.protected, "base64url"));
  if (!equal(canonicalJsonBytes(header), canonicalJsonBytes(expectedHeader))) {
    throw new TypeError("DEK envelope header mismatch");
  }
  const result = await flattenedDecrypt(envelope, privateKey);
  if (result.plaintext.byteLength !== 32) throw new TypeError("Unwrapped DEK has invalid length");
  return Uint8Array.from(result.plaintext);
}

function assertRsa3072PublicKey(key: KeyObject): void {
  const details = key.asymmetricKeyDetails;
  if (
    key.asymmetricKeyType !== "rsa" ||
    details?.modulusLength !== 3072 ||
    details.publicExponent !== 65_537n
  ) {
    throw new TypeError("Recipient encryption key must be RSA-3072 with exponent 65537");
  }
}

function sha256(value: Uint8Array) {
  return digest.parse({
    alg: "SHA-256",
    value: createHash("sha256").update(value).digest("base64url"),
  });
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}
