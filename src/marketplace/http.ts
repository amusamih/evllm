import { Router, type RequestHandler } from "express";

import { MarketplaceGatewayError } from "./gateway.js";
import type { MarketplaceCommandGateway } from "./gateway.js";

export interface MarketplaceHttpOptions {
  readonly authorize: (request: Parameters<RequestHandler>[0], operation: string) => boolean;
  readonly gateway: MarketplaceCommandGateway;
  readonly query: (input: {
    readonly agreementId?: string;
    readonly listingId?: string;
    readonly offerId?: string;
  }) => Promise<unknown>;
}

export function marketplaceRouter(options: MarketplaceHttpOptions): Router {
  const router = Router();
  router.get("/api/v1/query/marketplace", async (request, response) => {
    if (!options.authorize(request, "marketplace.read")) return denied(response);
    const agreementId = text(request.query.agreement_id);
    const listingId = text(request.query.listing_id);
    const offerId = text(request.query.offer_id);
    const input = {
      ...(agreementId === undefined ? {} : { agreementId }),
      ...(listingId === undefined ? {} : { listingId }),
      ...(offerId === undefined ? {} : { offerId }),
    };
    if (Object.keys(input).length !== 1) {
      response.status(400).json({
        error: { code: "INVALID_REQUEST", message: "Supply exactly one marketplace record ID." },
      });
      return;
    }
    response.json({ result: await options.query(input) });
  });
  router.post("/api/v1/commands", async (request, response) => {
    if (!options.authorize(request, "marketplace.command")) return denied(response);
    try {
      response.status(202).json({ result: await options.gateway.submit(request.body) });
    } catch (error) {
      if (error instanceof MarketplaceGatewayError) {
        response
          .status(error.code === "invalid" ? 400 : error.code === "signature" ? 403 : 409)
          .json({
            error: {
              code: `MARKETPLACE_${error.code.toUpperCase()}`,
              message: "Marketplace command rejected.",
            },
          });
        return;
      }
      throw error;
    }
  });
  router.get("/api/v1/query/commands/:id", (request, response) => {
    if (!options.authorize(request, "marketplace.command.read")) return denied(response);
    try {
      response.json({ result: options.gateway.result(request.params.id) });
    } catch {
      response.status(404).json({ error: { code: "COMMAND_NOT_FOUND", message: "Not found." } });
    }
  });
  return router;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function denied(response: Parameters<RequestHandler>[1]): void {
  response.status(403).json({ error: { code: "ACCESS_DENIED", message: "Access denied." } });
}
