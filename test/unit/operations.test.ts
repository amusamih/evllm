import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import { MemoryObjectStoreBackend } from "../../src/protected-bundles/storage/index.js";
import {
  backupRepository,
  OperationalMetrics,
  RecoveryError,
  restoreRepository,
  retryTransient,
} from "../../src/operations/index.js";

const firstOrg = "urn:evllm:org:00000000-0000-4000-8000-000000000001";
const secondOrg = "urn:evllm:org:00000000-0000-4000-8000-000000000002";
const objectId = Buffer.alloc(32, 7).toString("base64url");

describe("operational controls", () => {
  it("serves the accessible read-only research interface", async () => {
    const response = await request(createApp({ rateLimit: false }))
      .get("/")
      .expect(200);
    expect(response.text).toContain('lang="en"');
    for (const view of ["Decision support", "Route assessment", "Workflow state"]) {
      expect(response.text).toContain(view);
    }
    expect(response.text).toContain('href="#workspace"');
    expect(response.text).toContain("cannot sign transactions");
    expect(response.text).toContain('aria-live="polite"');
  });

  it("rate limits safely and publishes non-secret metrics", async () => {
    const metrics = new OperationalMetrics();
    const app = createApp({ metrics, rateLimit: { limit: 2, windowMs: 60_000 } });
    await request(app).get("/health/live").expect(200);
    await request(app).get("/health/live").expect(200);
    const denied = await request(app).get("/health/live").expect(429);
    const error = z
      .object({ error: z.object({ code: z.string() }).passthrough() })
      .parse(denied.body);
    expect(error.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(error.error).not.toHaveProperty("stack");
    expect(metrics.render()).toContain("evllm_http_requests_total");
  });

  it("retries bounded transient work and stops at the configured attempt", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const result = retryTransient(
      () => {
        calls += 1;
        return calls === 3 ? Promise.resolve("ok") : Promise.reject(new Error("temporary"));
      },
      { attempts: 3, baseDelayMs: 10 },
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe("ok");
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("backs up and restores one repository without crossing namespaces", async () => {
    const backend = new MemoryObjectStoreBackend();
    const primary = backend.forOrganization(firstOrg, { maxObjectBytes: 1024 });
    const restored = new MemoryObjectStoreBackend().forOrganization(firstOrg, {
      maxObjectBytes: 1024,
    });
    const other = new MemoryObjectStoreBackend().forOrganization(secondOrg, {
      maxObjectBytes: 1024,
    });
    const bytes = Uint8Array.from([1, 4, 9, 16]);
    await primary.putIfAbsent(objectId, [bytes]);
    const backup = await backupRepository(primary, [objectId]);
    await expect(restoreRepository(restored, backup)).resolves.toEqual({ restored: 1, reused: 0 });
    await expect(restoreRepository(restored, backup)).resolves.toEqual({ restored: 0, reused: 1 });
    await expect(restoreRepository(other, backup)).rejects.toBeInstanceOf(RecoveryError);
  });

  it("rejects a tampered backup and a conflicting destination", async () => {
    const sourceBackend = new MemoryObjectStoreBackend();
    const source = sourceBackend.forOrganization(firstOrg, { maxObjectBytes: 1024 });
    await source.putIfAbsent(objectId, [Uint8Array.from([1, 2, 3])]);
    const backup = await backupRepository(source, [objectId]);
    const target = new MemoryObjectStoreBackend().forOrganization(firstOrg, {
      maxObjectBytes: 1024,
    });
    const tampered = {
      ...backup,
      entries: [{ ...backup.entries[0]!, stored_envelope_base64: "AA==" }],
    };
    await expect(restoreRepository(target, tampered)).rejects.toMatchObject({ code: "integrity" });
    await target.putIfAbsent(objectId, [Uint8Array.from([9, 9, 9])]);
    await expect(restoreRepository(target, backup)).rejects.toMatchObject({ code: "conflict" });
  });
});
