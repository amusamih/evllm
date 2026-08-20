import { Router, type RequestHandler } from "express";
import { z } from "zod";

import { EvidenceLedgerError, type EvidenceLedger } from "./evidence-ledger.js";

const activateCommand = z
  .object({
    kind: z.literal("activate-evidence"),
    expected_prior_version: z.number().int().nonnegative(),
    payload: z.unknown(),
  })
  .strict();
const revokeCommand = z
  .object({
    kind: z.literal("revoke-evidence"),
    claim_id: z.string().min(1),
    claim_version: z.number().int().positive(),
  })
  .strict();
const command = z.discriminatedUnion("kind", [activateCommand, revokeCommand]);

export interface EvidenceHttpOptions {
  readonly authorize: (request: Parameters<RequestHandler>[0], operation: string) => boolean;
  readonly ledger: EvidenceLedger;
  readonly now?: () => number;
}

export function evidenceRouter(options: EvidenceHttpOptions): Router {
  const router = Router();
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  router.get("/api/v1/query/evidence", (request, response) => {
    if (!options.authorize(request, "evidence.read")) {
      response.status(403).json({ error: { code: "ACCESS_DENIED", message: "Access denied." } });
      return;
    }
    const claimId = typeof request.query.claim_id === "string" ? request.query.claim_id : undefined;
    if (claimId === undefined) {
      response
        .status(400)
        .json({ error: { code: "INVALID_REQUEST", message: "claim_id is required." } });
      return;
    }
    try {
      response.json({
        current: options.ledger.current(claimId),
        history: options.ledger.history(claimId),
      });
    } catch (error) {
      if (error instanceof EvidenceLedgerError && error.code === "not-found") {
        response
          .status(404)
          .json({ error: { code: "EVIDENCE_NOT_FOUND", message: "Evidence not found." } });
        return;
      }
      throw error;
    }
  });

  router.post("/api/v1/commands", (request, response) => {
    if (!options.authorize(request, "evidence.command")) {
      response.status(403).json({ error: { code: "ACCESS_DENIED", message: "Access denied." } });
      return;
    }
    const parsed = command.safeParse(request.body);
    if (!parsed.success) {
      response
        .status(400)
        .json({ error: { code: "INVALID_COMMAND", message: "Invalid command." } });
      return;
    }
    try {
      const result =
        parsed.data.kind === "activate-evidence"
          ? options.ledger.activate(parsed.data.payload, parsed.data.expected_prior_version, now())
          : options.ledger.revoke(parsed.data.claim_id, parsed.data.claim_version);
      response.status(202).json({ result });
    } catch (error) {
      if (error instanceof EvidenceLedgerError) {
        response.status(409).json({
          error: {
            code: `EVIDENCE_${error.code.toUpperCase().replaceAll("-", "_")}`,
            message: "Command rejected.",
          },
        });
        return;
      }
      throw error;
    }
  });
  return router;
}
