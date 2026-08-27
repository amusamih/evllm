import { createDecipheriv } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  openProtectedContent,
  protectContent,
} from "../../src/protected-bundles/crypto/index.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";
const content = new TextEncoder().encode("private battery report");
const domainPayload = canonicalJsonBytes({
  evidence_id: `urn:evllm:evidence:${uuid}`,
  evidence_version: 1,
});

describe("protected content crypto profile", () => {
  it("round trips exact content and canonical domain payload", async () => {
    const protectedContent = await protectContent({
      aad: aadFixture(),
      content,
      contentMediaType: "application/pdf",
      domainPayload,
      randomBytes: deterministicRandom(),
    });
    const storedEnvelope: unknown = JSON.parse(
      new TextDecoder().decode(protectedContent.envelopeBytes),
    );
    expect(Object.keys(storedEnvelope as Record<string, unknown>)).toEqual([
      "aad",
      "ciphertext",
      "iv",
      "protected",
      "tag",
    ]);
    await expect(
      openProtectedContent(
        protectedContent.envelopeBytes,
        protectedContent.dek,
        protectedContent.aad,
        protectedContent.contentCommitment,
      ),
    ).resolves.toEqual({ content, domainPayload });
    await expect(
      openProtectedContent(
        protectedContent.envelopeBytes,
        protectedContent.dek,
        protectedContent.aad,
        { ...protectedContent.contentCommitment, value: "A".repeat(43) },
      ),
    ).rejects.toThrow("Protected package commitment mismatch");
    expect(protectedContent.contentCommitment).not.toEqual(
      protectedContent.domainPayloadCommitment,
    );
  });

  it("uses fresh random material for repeat encryption", async () => {
    const first = await protectContent({
      aad: aadFixture(),
      content,
      contentMediaType: "application/pdf",
      domainPayload,
    });
    const second = await protectContent({
      aad: aadFixture(),
      content,
      contentMediaType: "application/pdf",
      domainPayload,
    });
    expect(first.envelopeBytes).not.toEqual(second.envelopeBytes);
    expect(first.dek).not.toEqual(second.dek);
    expect(first.contentCommitment).not.toEqual(second.contentCommitment);
  });

  it.each(["protected", "aad", "iv", "ciphertext", "tag"] as const)(
    "rejects a tampered %s member",
    async (member) => {
      const result = await protectContent({
        aad: aadFixture(),
        content,
        contentMediaType: "application/pdf",
        domainPayload,
        randomBytes: deterministicRandom(),
      });
      const envelope = JSON.parse(new TextDecoder().decode(result.envelopeBytes)) as Record<
        string,
        string
      >;
      const original = envelope[member];
      if (original === undefined) throw new Error("Missing fixture member");
      envelope[member] = `${original[0] === "A" ? "B" : "A"}${original.slice(1)}`;
      await expect(
        openProtectedContent(
          canonicalJsonBytes(envelope),
          result.dek,
          result.aad,
          result.contentCommitment,
        ),
      ).rejects.toThrow();
    },
  );

  it("rejects wrong keys, context transplants, and noncanonical stored JSON", async () => {
    const result = await protectContent({
      aad: aadFixture(),
      content,
      contentMediaType: "application/pdf",
      domainPayload,
      randomBytes: deterministicRandom(),
    });
    await expect(
      openProtectedContent(
        result.envelopeBytes,
        new Uint8Array(32).fill(9),
        result.aad,
        result.contentCommitment,
      ),
    ).rejects.toThrow();
    await expect(
      openProtectedContent(
        result.envelopeBytes,
        result.dek,
        {
          ...result.aad,
          bundle_version: 2,
        },
        result.contentCommitment,
      ),
    ).rejects.toThrow();

    const parsed: unknown = JSON.parse(new TextDecoder().decode(result.envelopeBytes));
    const prettyBytes = new TextEncoder().encode(JSON.stringify(parsed, null, 2));
    await expect(
      openProtectedContent(prettyBytes, result.dek, result.aad, result.contentCommitment),
    ).rejects.toThrow("exact RFC 8785");
  });

  it("rejects a noncanonical unsigned domain payload before encryption", async () => {
    await expect(
      protectContent({
        aad: aadFixture(),
        content,
        contentMediaType: "application/pdf",
        domainPayload: new TextEncoder().encode('{ "evidence_version": 1 }'),
      }),
    ).rejects.toThrow("exact RFC 8785");
  });

  it("decrypts with independent Node AES-GCM primitives", async () => {
    const result = await protectContent({
      aad: aadFixture(),
      content,
      contentMediaType: "application/pdf",
      domainPayload,
      randomBytes: deterministicRandom(),
    });
    const envelope = JSON.parse(new TextDecoder().decode(result.envelopeBytes)) as Record<
      "aad" | "ciphertext" | "iv" | "protected" | "tag",
      string
    >;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      result.dek,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${envelope.protected}.${envelope.aad}`, "ascii"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);

    expect(plaintext).toEqual(Buffer.from(result.packageBytes));
  });
});

function aadFixture() {
  return {
    schema: "EVLLM_PROTECTED_CONTENT_AAD_V1" as const,
    bundle_id: `urn:evllm:bundle:${uuid}`,
    bundle_version: 1,
    bundle_type: "evidence" as const,
    domain_resource_id: `urn:evllm:evidence:${uuid}`,
    domain_resource_version: 1,
    custody_controller_org_id: `urn:evllm:org:${uuid}`,
    primary_repository_id: `urn:evllm:repository:${uuid}`,
    content_schema_id: `urn:evllm:schema:${uuid}`,
    content_schema_version: "1.0.0",
    access_class: "restricted" as const,
    initial_criticality_class: "decision-critical" as const,
    criticality_profile_id: `urn:evllm:profile:${uuid}`,
    criticality_profile_version: 1,
  };
}

function deterministicRandom() {
  let counter = 1;
  return (length: number) => new Uint8Array(length).fill(counter++);
}
