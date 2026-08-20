import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";

import { calculateJwkThumbprintUri, exportJWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  unwrapDek,
  wrapDek,
} from "../../src/protected-bundles/crypto/index.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const digest = { alg: "SHA-256" as const, value: "A".repeat(43) };
const dek = new Uint8Array(32).fill(7);

describe("recipient DEK envelope profile", () => {
  const recipient = generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });
  const wrongRecipient = generateKeyPairSync("rsa", {
    modulusLength: 3072,
    publicExponent: 0x10001,
  });
  let kid = "";

  beforeAll(async () => {
    kid = await calculateJwkThumbprintUri(await exportJWK(recipient.publicKey), "sha256");
  });

  it("wraps and unwraps a controller-custody DEK with six exact members", async () => {
    const context = controllerContext(kid);
    const wrapped = await wrapDek({ context, dek, publicKey: recipient.publicKey });
    const stored: unknown = JSON.parse(new TextDecoder().decode(wrapped.envelopeBytes));
    expect(Object.keys(stored as Record<string, unknown>)).toEqual([
      "aad",
      "ciphertext",
      "encrypted_key",
      "iv",
      "protected",
      "tag",
    ]);
    await expect(unwrapDek(wrapped.envelopeBytes, recipient.privateKey, context)).resolves.toEqual(
      dek,
    );
    expect(wrapped.commitment.value).toHaveLength(43);
  });

  it("supports an ordinary grant while rejecting controller-purpose confusion", async () => {
    const context = {
      ...controllerContext(kid),
      authorization_id: `urn:evllm:grant:${uuid}`,
      purpose: "assessment-review",
      scope: "protected-bundle:decrypt",
    } as const;
    const wrapped = await wrapDek({ context, dek, publicKey: recipient.publicKey });
    await expect(unwrapDek(wrapped.envelopeBytes, recipient.privateKey, context)).resolves.toEqual(
      dek,
    );
    await expect(
      wrapDek({
        context: { ...context, purpose: "controller-custody" },
        dek,
        publicKey: recipient.publicKey,
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong keys and context transplants", async () => {
    const context = controllerContext(kid);
    const wrapped = await wrapDek({ context, dek, publicKey: recipient.publicKey });
    await expect(
      unwrapDek(wrapped.envelopeBytes, wrongRecipient.privateKey, context),
    ).rejects.toThrow();
    await expect(
      unwrapDek(wrapped.envelopeBytes, recipient.privateKey, { ...context, bundle_version: 2 }),
    ).rejects.toThrow("context mismatch");
  });

  it.each(["protected", "aad", "encrypted_key", "iv", "ciphertext", "tag"] as const)(
    "rejects tampering with %s",
    async (member) => {
      const context = controllerContext(kid);
      const wrapped = await wrapDek({ context, dek, publicKey: recipient.publicKey });
      const envelope = JSON.parse(new TextDecoder().decode(wrapped.envelopeBytes)) as Record<
        string,
        string
      >;
      const original = envelope[member];
      if (original === undefined) throw new Error("Missing envelope member");
      envelope[member] = `${original[0] === "A" ? "B" : "A"}${original.slice(1)}`;
      await expect(
        unwrapDek(canonicalJsonBytes(envelope), recipient.privateKey, context),
      ).rejects.toThrow();
    },
  );

  it("rejects RSA keys below the fixed modulus size", async () => {
    const weak = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
    await expect(
      wrapDek({ context: controllerContext(kid), dek, publicKey: weak.publicKey }),
    ).rejects.toThrow("RSA-3072");
  });

  it("unwraps with independent Node RSA-OAEP and AES-GCM primitives", async () => {
    const context = controllerContext(kid);
    const wrapped = await wrapDek({ context, dek, publicKey: recipient.publicKey });
    const envelope = JSON.parse(new TextDecoder().decode(wrapped.envelopeBytes)) as Record<
      "aad" | "ciphertext" | "encrypted_key" | "iv" | "protected" | "tag",
      string
    >;
    const contentEncryptionKey = privateDecrypt(
      {
        key: recipient.privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(envelope.encrypted_key, "base64url"),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      contentEncryptionKey,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${envelope.protected}.${envelope.aad}`, "ascii"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);

    expect(plaintext).toEqual(Buffer.from(dek));
  });
});

function controllerContext(kid: string) {
  return {
    schema: "EVLLM_DEK_WRAP_CONTEXT_V1" as const,
    envelope_id: `urn:evllm:envelope:${uuid}`,
    bundle_id: `urn:evllm:bundle:${uuid}`,
    bundle_version: 1,
    bundle_type: "evidence" as const,
    domain_resource_id: `urn:evllm:evidence:${uuid}`,
    domain_resource_version: 1,
    domain_payload_commitment: digest,
    content_commitment: digest,
    content_envelope_digest: digest,
    recipient_org_id: `urn:evllm:org:${uuid}`,
    recipient_kid: kid,
    authorization_id: `urn:evllm:authorization:${uuid}`,
    scope: "protected-bundle:key-administration" as const,
    purpose: "controller-custody" as const,
  };
}
