import {
  constants,
  createHash,
  randomBytes,
  sign as signBytes,
  type KeyObject,
  verify as verifyBytes,
} from "node:crypto";

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

export interface RsaKeyPossessionProof {
  readonly algorithm: "PS256";
  readonly signature: string;
}

export function rsaPublicKeySpkiSha256(publicKey: KeyObject) {
  assertRsa3072PublicKey(publicKey);
  const spki = publicKey.export({ format: "der", type: "spki" });
  return sha256(Uint8Array.from(spki));
}

export function createRsaKeyPossessionProof(
  privateKey: KeyObject,
  acknowledgement: { readonly message: Record<string, unknown>; readonly signature: string },
): RsaKeyPossessionProof {
  assertRsa3072PrivateKey(privateKey);
  const signature = signBytes("sha256", keyPossessionPayload(acknowledgement), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32,
  });
  return { algorithm: "PS256", signature: signature.toString("base64url") };
}

export function verifyRsaKeyPossessionProof(
  publicKey: KeyObject,
  acknowledgement: { readonly message: Record<string, unknown>; readonly signature: string },
  proof: RsaKeyPossessionProof,
): boolean {
  try {
    assertRsa3072PublicKey(publicKey);
    if (proof.algorithm !== "PS256" || !/^[A-Za-z0-9_-]{512}$/u.test(proof.signature)) {
      return false;
    }
    return verifyBytes(
      "sha256",
      keyPossessionPayload(acknowledgement),
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    return false;
  }
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
  try {
    if (result.plaintext.byteLength !== 32) throw new TypeError("Unwrapped DEK has invalid length");
    return Uint8Array.from(result.plaintext);
  } finally {
    result.plaintext.fill(0);
  }
}

export function verifyWrappedDekEnvelope(input: {
  readonly commitment: ReturnType<typeof digest.parse>;
  readonly context: ReturnType<typeof dekWrapContext.parse>;
  readonly envelopeBytes: Uint8Array;
}): boolean {
  try {
    const envelope = recipientJwe.parse(parseExactCanonicalJson(input.envelopeBytes));
    const context = dekWrapContext.parse(
      parseExactCanonicalJson(Buffer.from(envelope.aad, "base64url")),
    );
    if (!equal(canonicalJsonBytes(context), canonicalJsonBytes(input.context))) return false;
    const expectedHeader = {
      alg: "RSA-OAEP-256",
      cty: "application/octet-stream",
      enc: "A256GCM",
      kid: context.recipient_kid,
      typ: "application/vnd.evllm.dek-envelope+jwe",
    } as const;
    const header = parseExactCanonicalJson(Buffer.from(envelope.protected, "base64url"));
    if (!equal(canonicalJsonBytes(header), canonicalJsonBytes(expectedHeader))) return false;
    if (
      Buffer.from(envelope.encrypted_key, "base64url").byteLength !== 384 ||
      Buffer.from(envelope.iv, "base64url").byteLength !== 12 ||
      Buffer.from(envelope.ciphertext, "base64url").byteLength !== 32 ||
      Buffer.from(envelope.tag, "base64url").byteLength !== 16
    ) {
      return false;
    }
    return sha256(input.envelopeBytes).value === input.commitment.value;
  } catch {
    return false;
  }
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

function assertRsa3072PrivateKey(key: KeyObject): void {
  const details = key.asymmetricKeyDetails;
  if (
    key.type !== "private" ||
    key.asymmetricKeyType !== "rsa" ||
    details?.modulusLength !== 3072 ||
    details.publicExponent !== 65_537n
  ) {
    throw new TypeError("Recipient possession proof requires an RSA-3072 private key");
  }
}

function keyPossessionPayload(acknowledgement: {
  readonly message: Record<string, unknown>;
  readonly signature: string;
}): Uint8Array {
  return canonicalJsonBytes({
    schema: "EVLLM_RSA_KEY_POSSESSION_PROOF_V1",
    acknowledgement_message: acknowledgement.message,
    identity_signature_sha256: createHash("sha256")
      .update(Buffer.from(acknowledgement.signature.slice(2), "hex"))
      .digest("base64url"),
  });
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
