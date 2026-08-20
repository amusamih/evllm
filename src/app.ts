import express, { type ErrorRequestHandler, type Express, type Response } from "express";

import { evaluateReadiness, type ReadinessCheck } from "./health/readiness.js";
import {
  canonicalCorrelationId,
  createStructuredLogger,
  runWithCorrelation,
  type StructuredLogger,
} from "./observability/index.js";
import { evidenceRouter, type EvidenceHttpOptions } from "./evidence/http.js";
import { decisionRouter, type DecisionHttpOptions } from "./decision/http.js";
import { marketplaceRouter, type MarketplaceHttpOptions } from "./marketplace/http.js";
import { assistantRouter, type AssistantHttpOptions } from "./assistant/http.js";
import { interfaceRouter, type ResearchInterfaceHttpOptions } from "./interface/http.js";
import { OperationalMetrics, rateLimit, requestMetrics } from "./operations/index.js";

export interface CreateAppOptions {
  readonly appEnvironment?: "development" | "production" | "test";
  readonly readinessChecks?: readonly ReadinessCheck[];
  readonly logger?: StructuredLogger;
  readonly evidence?: EvidenceHttpOptions;
  readonly decision?: DecisionHttpOptions;
  readonly marketplace?: MarketplaceHttpOptions;
  readonly assistant?: AssistantHttpOptions;
  readonly interface?: ResearchInterfaceHttpOptions;
  readonly rateLimit?: Readonly<{ limit: number; windowMs: number }> | false;
  readonly metrics?: OperationalMetrics;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  const readinessChecks = options.readinessChecks ?? [];
  const logger = options.logger ?? createStructuredLogger();
  const metrics = options.metrics ?? new OperationalMetrics();

  app.disable("x-powered-by");
  app.set("env", options.appEnvironment ?? "development");
  app.use((request, response, next) => {
    const correlationId = canonicalCorrelationId(request.header("x-correlation-id"));
    response.setHeader("x-correlation-id", correlationId);
    runWithCorrelation(correlationId, next);
  });
  app.use(express.json({ limit: "16kb" }));
  app.use(requestMetrics(metrics));
  if (options.rateLimit !== false) {
    app.use(rateLimit(options.rateLimit ?? { limit: 120, windowMs: 60_000 }));
  }
  app.use(interfaceRouter(options.interface));
  if (options.evidence !== undefined) app.use(evidenceRouter(options.evidence));
  if (options.decision !== undefined) app.use(decisionRouter(options.decision));
  if (options.marketplace !== undefined) app.use(marketplaceRouter(options.marketplace));
  if (options.assistant !== undefined) app.use(assistantRouter(options.assistant));

  app.get("/health/live", (_request, response) => {
    response.json({ service: "evllm-api", status: "live" });
  });

  app.get("/health/ready", async (_request, response) => {
    const result = await evaluateReadiness(readinessChecks);
    response.status(result.status === "ready" ? 200 : 503).json(result);
  });
  app.get("/metrics", (_request, response) => {
    response.type("text/plain").send(`${metrics.render()}\n`);
  });

  app.use((_request, response) => {
    response.status(404).json({
      error: {
        code: "ROUTE_NOT_FOUND",
        correlation_id: responseCorrelationId(response),
        message: "Not found.",
      },
    });
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    void next;

    if (isMalformedJsonError(error)) {
      response.status(400).json({
        error: {
          code: "INVALID_JSON",
          correlation_id: responseCorrelationId(response),
          message: "Request body must contain valid JSON.",
        },
      });
      return;
    }

    logger.log("error", "http.unhandled_error", { error });
    response.status(500).json({
      error: {
        code: "INTERNAL_ERROR",
        correlation_id: responseCorrelationId(response),
        message: "Internal server error.",
      },
    });
  };
  app.use(handleError);

  return app;
}

function responseCorrelationId(response: Response): string {
  const value = response.getHeader("x-correlation-id");
  return typeof value === "string" ? value : "";
}

function isMalformedJsonError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}
