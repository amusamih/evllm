import { Router, type Response } from "express";
import { z } from "zod";

import { AssistantIdempotencyError } from "../assistant/index.js";
import { interfaceClient, interfacePage, interfaceStyles } from "./page.js";
import { ASSESSMENT_SCENARIOS, type ResearchInterfaceService } from "./service.js";

export interface ResearchInterfaceHttpOptions {
  readonly service?: ResearchInterfaceService;
}

const assistantRequest = z
  .object({
    question: z.string().trim().min(1).max(4_000),
    idempotency_key: z.string().uuid().optional(),
  })
  .strict();
const assessmentScenario = z.enum(ASSESSMENT_SCENARIOS);

export function interfaceRouter(options: ResearchInterfaceHttpOptions = {}): Router {
  const router = Router();
  const service = options.service;

  router.get("/", (_request, response) => {
    response.type("html").send(interfacePage());
  });
  router.get("/interface.css", (_request, response) => {
    response.set("cache-control", "public, max-age=300").type("text/css").send(interfaceStyles);
  });
  router.get("/interface.js", (_request, response) => {
    response
      .set("cache-control", "public, max-age=300")
      .type("application/javascript")
      .send(interfaceClient);
  });
  router.post("/api/v1/interface/assistant", async (request, response) => {
    if (service === undefined) return unavailable(response);
    const parsed = assistantRequest.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_INTERFACE_SCENARIO",
          message: "Select a supported decision-support scenario.",
        },
      });
      return;
    }
    try {
      response.set("cache-control", "no-store").json({
        result: await service.runAssistant(parsed.data.question, parsed.data.idempotency_key),
      });
    } catch (error) {
      if (!(error instanceof AssistantIdempotencyError)) throw error;
      response.status(409).json({
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "This request key was already used for another question.",
        },
      });
    }
  });
  router.get("/api/v1/interface/assessment/:scenario", (request, response) => {
    if (service === undefined) return unavailable(response);
    const parsed = assessmentScenario.safeParse(request.params.scenario);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: "INVALID_INTERFACE_SCENARIO",
          message: "Select a supported route-assessment scenario.",
        },
      });
      return;
    }
    response.set("cache-control", "no-store").json({ result: service.runAssessment(parsed.data) });
  });
  router.get("/api/v1/interface/status", (_request, response) => {
    if (service === undefined) return unavailable(response);
    response.set("cache-control", "no-store").json({ result: service.workflowStatus() });
  });

  return router;
}

function unavailable(response: Response): void {
  response.status(503).json({
    error: {
      code: "INTERFACE_RUNTIME_UNAVAILABLE",
      message: "The governed decision-support runtime is not configured.",
    },
  });
}
