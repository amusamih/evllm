import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes, protectContent } from "../../src/protected-bundles/crypto/index.js";
import { FilesystemObjectStore } from "../../src/protected-bundles/storage/index.js";

const roots: string[] = [];
const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("persistent crypto leakage", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
  });

  it("persists only the encrypted envelope, never plaintext, payload, salts, or DEK", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "evllm-crypto-leakage-"));
    roots.push(root);
    const content = Buffer.from("UNIQUE_PRIVATE_CONTENT_SENTINEL_7f39", "utf8");
    const domainPayload = canonicalJsonBytes({
      evidence_id: `urn:evllm:evidence:${uuid}`,
      marker: "UNIQUE_DOMAIN_PAYLOAD_SENTINEL_8a41",
      version: 1,
    });
    let counter = 1;
    const result = await protectContent({
      aad: {
        schema: "EVLLM_PROTECTED_CONTENT_AAD_V1",
        bundle_id: `urn:evllm:bundle:${uuid}`,
        bundle_version: 1,
        bundle_type: "evidence",
        domain_resource_id: `urn:evllm:evidence:${uuid}`,
        domain_resource_version: 1,
        custody_controller_org_id: `urn:evllm:org:${uuid}`,
        primary_repository_id: `urn:evllm:repository:${uuid}`,
        content_schema_id: `urn:evllm:schema:${uuid}`,
        content_schema_version: "1.0.0",
        access_class: "restricted",
        initial_criticality_class: "decision-critical",
        criticality_profile_id: `urn:evllm:profile:${uuid}`,
        criticality_profile_version: 1,
      },
      content,
      contentMediaType: "application/octet-stream",
      domainPayload,
      randomBytes: (length) => new Uint8Array(length).fill(counter++),
    });
    const store = new FilesystemObjectStore(`urn:evllm:org:${uuid}`, {
      maxObjectBytes: 1024 * 1024,
      rootDirectory: root,
    });
    await store.putIfAbsent(Buffer.alloc(32, 9).toString("base64url"), [result.envelopeBytes]);

    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    const persisted = Buffer.concat(
      await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map((entry) => readFile(resolve(entry.parentPath, entry.name))),
      ),
    );
    for (const forbidden of [
      content,
      domainPayload,
      Buffer.from(result.dek),
      Buffer.alloc(32, 3),
      Buffer.alloc(32, 4),
    ]) {
      const forbiddenBytes = Buffer.from(forbidden);
      expect(persisted.includes(forbiddenBytes)).toBe(false);
      expect(persisted.toString("utf8")).not.toContain(forbiddenBytes.toString("base64url"));
      expect(persisted.toString("utf8")).not.toContain(forbiddenBytes.toString("hex"));
    }
    expect(persisted).toEqual(Buffer.from(result.envelopeBytes));
    expect(JSON.parse(persisted.toString("utf8"))).toMatchObject({
      iv: Buffer.alloc(12, 2).toString("base64url"),
    });
  });
});
