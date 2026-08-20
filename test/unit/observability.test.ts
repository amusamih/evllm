import { describe, expect, it } from "vitest";

import {
  canonicalCorrelationId,
  createStructuredLogger,
  redactForLog,
  runWithCorrelation,
} from "../../src/observability/index.js";

describe("structured observability", () => {
  it("propagates a canonical correlation ID into structured JSON", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger((line) => lines.push(line));
    const correlationId = "123e4567-e89b-42d3-a456-426614174000";

    runWithCorrelation(correlationId, () =>
      logger.log("info", "repository.read", { result: "ok" }),
    );

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      level: "info",
      event: "repository.read",
      correlation_id: correlationId,
      fields: { result: "ok" },
    });
    expect(canonicalCorrelationId(correlationId)).toBe(correlationId);
    expect(canonicalCorrelationId("INVALID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });

  it("redacts every frozen sensitive class before serialization", () => {
    const protectedValues = {
      password: "VALUE_DATABASE_PASSWORD",
      session_token: "VALUE_SESSION_TOKEN",
      private_key: "VALUE_PRIVATE_KEY",
      dek: "VALUE_PLAINTEXT_DEK",
      commitment_salt: "VALUE_COMMITMENT_SALT",
      domain_payload_bytes: "VALUE_UNSIGNED_DOMAIN_PAYLOAD",
      protected_content: "VALUE_PROTECTED_PLAINTEXT",
      recipient_envelope: "VALUE_RECIPIENT_ENVELOPE",
      controller_envelope: "VALUE_CONTROLLER_ENVELOPE",
      primary_object_id: "VALUE_PRIVATE_LOCATOR",
      prompt: "VALUE_PRIVATE_QUESTION",
      nested: { repository_credential: "VALUE_CREDENTIAL", safe_digest: "0x1234" },
      error: new Error("s3://private-bucket/private-object"),
    };
    const serialized = JSON.stringify(redactForLog(protectedValues));

    for (const forbidden of Object.values(protectedValues).filter(
      (value) => typeof value === "string",
    )) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("private-object");
    expect(serialized).toContain("safe_digest");
    expect(serialized).toContain("[REDACTED]");
  });
});
