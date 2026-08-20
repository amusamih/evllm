import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { evaluateReadiness } from "../../src/health/readiness.js";

describe("health endpoints", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports liveness without consulting dependencies", async () => {
    const app = createApp({
      readinessChecks: [
        {
          name: "unused",
          probe: async () => Promise.reject(new Error("must not run")),
        },
      ],
    });

    const response = await request(app).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ service: "evllm-api", status: "live" });
  });

  it("preserves a valid correlation ID and replaces an invalid one", async () => {
    const app = createApp();
    const supplied = "123e4567-e89b-42d3-a456-426614174000";

    const preserved = await request(app).get("/health/live").set("x-correlation-id", supplied);
    const replaced = await request(app).get("/health/live").set("x-correlation-id", "NOT-A-UUID");

    expect(preserved.headers["x-correlation-id"]).toBe(supplied);
    expect(replaced.headers["x-correlation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("returns a generic JSON error for malformed request bodies", async () => {
    const app = createApp({ appEnvironment: "production" });

    const response = await request(app)
      .post("/health/live")
      .set("content-type", "application/json")
      .send('{"broken"');

    expect(response.status).toBe(400);
    expect(response.type).toBe("application/json");
    expect(response.body).toEqual({
      error: {
        code: "INVALID_JSON",
        correlation_id: response.headers["x-correlation-id"],
        message: "Request body must contain valid JSON.",
      },
    });
    expect(response.text).not.toContain("SyntaxError");
    expect(response.text).not.toContain("node_modules");
  });

  it("returns JSON for unknown routes", async () => {
    const app = createApp();

    const response = await request(app).get("/not-a-route");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "ROUTE_NOT_FOUND",
        correlation_id: response.headers["x-correlation-id"],
        message: "Not found.",
      },
    });
  });

  it("reports readiness when all dependencies respond", async () => {
    const app = createApp({
      readinessChecks: [{ name: "postgres", probe: () => Promise.resolve() }],
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      checks: [{ name: "postgres", status: "ready" }],
      status: "ready",
    });
  });

  it("reports an unavailable dependency without exposing its error", async () => {
    const app = createApp({
      readinessChecks: [
        {
          name: "postgres",
          probe: async () => Promise.reject(new Error("secret connection detail")),
        },
      ],
    });

    const response = await request(app).get("/health/ready");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      checks: [{ name: "postgres", status: "unavailable" }],
      status: "unavailable",
    });
    expect(JSON.stringify(response.body)).not.toContain("secret connection detail");
  });

  it("bounds a readiness probe that never settles", async () => {
    vi.useFakeTimers();
    const resultPromise = evaluateReadiness(
      [
        {
          name: "stalled",
          probe: async () => new Promise<void>(() => undefined),
        },
      ],
      100,
    );

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result).toEqual({
      checks: [{ name: "stalled", status: "unavailable" }],
      status: "unavailable",
    });
  });
});
