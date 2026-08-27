import { Router, type RequestHandler } from "express";

import type { DecisionQueryService } from "./queries.js";
import type { DatedRuleRegistry } from "./rules.js";

export interface DecisionHttpOptions {
  readonly authorize: (request: Parameters<RequestHandler>[0], operation: string) => boolean;
  readonly queries: DecisionQueryService;
  readonly rules: DatedRuleRegistry;
}

export function decisionRouter(options: DecisionHttpOptions): Router {
  const router = Router();
  router.get("/api/v1/query/assessments", (request, response) => {
    if (!options.authorize(request, "assessment.read")) return denied(response);
    const inputId = textQuery(request.query.assessment_input_id);
    if (inputId === undefined) return invalid(response, "assessment_input_id is required.");
    try {
      response.json({
        current: options.queries.assessmentCurrent(inputId),
        history: options.queries.assessmentHistory(inputId),
      });
    } catch {
      response
        .status(404)
        .json({ error: { code: "ASSESSMENT_NOT_FOUND", message: "Assessment not found." } });
    }
  });
  router.get("/api/v1/query/rules", (request, response) => {
    if (!options.authorize(request, "rule.read")) return denied(response);
    const ruleId = textQuery(request.query.rule_id);
    const jurisdiction = textQuery(request.query.jurisdiction);
    const subjectScope = textQuery(request.query.subject_scope);
    const asOfText = textQuery(request.query.as_of);
    const asOf = asOfText === undefined ? Number.NaN : Number(asOfText);
    if (
      ruleId === undefined ||
      jurisdiction === undefined ||
      subjectScope === undefined ||
      !Number.isSafeInteger(asOf)
    ) {
      return invalid(
        response,
        "rule_id, jurisdiction, subject_scope and integer as_of are required.",
      );
    }
    try {
      response.json({
        rule: options.rules.selectRule({ asOf, jurisdiction, ruleId, subjectScope }),
      });
    } catch {
      response
        .status(404)
        .json({ error: { code: "RULE_NOT_APPLICABLE", message: "No applicable rule." } });
    }
  });
  return router;
}

function textQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function denied(response: Parameters<RequestHandler>[1]): void {
  response.status(403).json({ error: { code: "ACCESS_DENIED", message: "Access denied." } });
}

function invalid(response: Parameters<RequestHandler>[1], message: string): void {
  response.status(400).json({ error: { code: "INVALID_REQUEST", message } });
}
