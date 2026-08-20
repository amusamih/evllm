import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { currentCorrelationId } from "../observability/index.js";
import type { AssistantAuditLedger } from "./audit.js";
import { AssistantIdempotencyError, type GovernedAssistantService } from "./service.js";
import { SessionError, type WalletSessionManager } from "./session.js";
import { assistantQuery } from "./types.js";

const authRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("challenge"), identity: z.unknown() }).strict(),
  z
    .object({
      action: z.literal("verify"),
      challenge_id: z.string().uuid(),
      signature: z.string().min(1).max(512),
    })
    .strict(),
  z.object({ action: z.literal("current") }).strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);

export interface AssistantHttpOptions {
  readonly sessions: WalletSessionManager;
  readonly service: GovernedAssistantService;
  readonly audit: AssistantAuditLedger;
}

export function assistantRouter(options: AssistantHttpOptions): Router {
  const router = Router();
  router.post("/api/v1/auth", async (request, response) => {
    try {
      const input = authRequest.parse(request.body);
      if (input.action === "challenge") {
        response.setHeader("cache-control", "no-store");
        response.json({ result: options.sessions.challenge(input.identity) });
        return;
      }
      const token = bearer(request);
      if (input.action === "verify") {
        const result = await options.sessions.verify(input.challenge_id, input.signature);
        response.setHeader("cache-control", "no-store");
        response.json({ result });
        return;
      }
      if (token === undefined) return denied(response);
      if (input.action === "logout") {
        options.sessions.logout(token);
        response.json({ result: { status: "logged-out" } });
        return;
      }
      response.json({ result: options.sessions.require(token) });
    } catch (error) {
      if (error instanceof SessionError) return denied(response);
      invalid(response);
    }
  });
  router.get("/api/v1/query/assistant", async (request, response) => {
    try {
      const session = requireSession(options.sessions, request);
      const raw = decodeQuery(request.query.request);
      const query = assistantQuery.parse(raw);
      response.setHeader("cache-control", "no-store");
      response.json({
        result: await options.service.answer(query, session, currentCorrelationId() ?? ""),
      });
    } catch (error) {
      if (error instanceof SessionError) return denied(response);
      if (error instanceof AssistantIdempotencyError) return conflict(response);
      invalid(response);
    }
  });
  router.get("/api/v1/query/audit", (request, response) => {
    try {
      const session = requireSession(options.sessions, request);
      const requestId =
        typeof request.query.request_id === "string" ? request.query.request_id : "";
      if (!requestId.startsWith("urn:evllm:assistant:")) return invalid(response);
      response.json({ result: options.audit.forRequest(requestId, session) });
    } catch (error) {
      if (error instanceof SessionError) return denied(response);
      invalid(response);
    }
  });
  return router;
}

export function encodeAssistantQuery(value: unknown): string {
  return Buffer.from(JSON.stringify(assistantQuery.parse(value)), "utf8").toString("base64url");
}

function decodeQuery(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 16_000) throw new Error("Invalid query");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function requireSession(sessions: WalletSessionManager, request: Request) {
  const token = bearer(request);
  if (token === undefined) throw new SessionError("invalid");
  return sessions.require(token);
}

function bearer(request: Request): string | undefined {
  const authorization = request.header("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function denied(response: Response): void {
  response.status(403).json({ error: { code: "ACCESS_DENIED", message: "Access denied." } });
}

function invalid(response: Response): void {
  response.status(400).json({ error: { code: "INVALID_REQUEST", message: "Request rejected." } });
}

function conflict(response: Response): void {
  response.status(409).json({
    error: {
      code: "IDEMPOTENCY_CONFLICT",
      message: "This request key was already used for another query.",
    },
  });
}
