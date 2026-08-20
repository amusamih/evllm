import { randomUUID } from "node:crypto";

import type {
  ActorSession,
  AssistantResponse,
  GovernedAssistantService,
} from "../assistant/index.js";
import {
  FORMAL_ROUTES,
  RouteAssessmentService,
  routeCalculationInputsDigest,
  type AssessmentResult,
  type FormalRoute,
  type RouteAssessmentInput,
} from "../decision/index.js";
import type { ControlledCaseCatalog, ControlledCaseId } from "./cases.js";

export const ASSESSMENT_SCENARIOS = ["nominal", "missing", "conflicting"] as const;
export type AssessmentScenario = (typeof ASSESSMENT_SCENARIOS)[number];

export interface AssistantPresentation {
  readonly caseId: ControlledCaseId | null;
  readonly caseLabel: string;
  readonly question: string;
  readonly source: "retained-controlled-case";
  readonly response: AssistantResponse;
}

export interface AssessmentPresentation {
  readonly scenario: AssessmentScenario;
  readonly scenarioLabel: string;
  readonly source: "controlled-local-scenario";
  readonly result: AssessmentResult;
}

export interface WorkflowStatusPresentation {
  readonly source: "controlled-local-scenario";
  readonly battery: Readonly<{
    id: string;
    recordedOwner: string;
    ownershipState: string;
  }>;
  readonly protectedRecord: Readonly<{
    id: string;
    version: number;
    state: string;
    criticality: string;
    replicaState: string;
  }>;
  readonly marketplace: Readonly<{
    listing: string;
    agreement: string;
    state: string;
    nextAuthorizedAction: string;
  }>;
  readonly audit: Readonly<{
    lastEvent: string;
    chainState: string;
  }>;
  readonly execution?: Readonly<{
    runId: string;
    chain: string;
    transactions: readonly Readonly<{
      step: string;
      transactionHash: string;
      blockNumber: number;
    }>[];
  }>;
}

export interface ResearchInterfaceService {
  runAssistant(question: string, idempotencyKey?: string): Promise<AssistantPresentation>;
  runAssessment(scenario: AssessmentScenario): AssessmentPresentation;
  workflowStatus(): WorkflowStatusPresentation;
}

const NOW = 1_776_033_600;

export interface ResearchInterfaceServiceOptions {
  readonly assistant: GovernedAssistantService;
  readonly cases: ControlledCaseCatalog;
  readonly session: ActorSession;
  readonly now?: () => number;
}

export function createResearchInterfaceService(
  options: ResearchInterfaceServiceOptions,
): ResearchInterfaceService {
  return {
    runAssistant: (question, idempotencyKey) => runAssistant(question, idempotencyKey, options),
    runAssessment,
    workflowStatus,
  };
}

async function runAssistant(
  submittedQuestion: string,
  idempotencyKey: string | undefined,
  options: ResearchInterfaceServiceOptions,
): Promise<AssistantPresentation> {
  const question = submittedQuestion.trim();
  const resolved = options.cases.resolve(question, (options.now ?? (() => NOW))());
  const response = await options.assistant.answer(
    idempotencyKey === undefined
      ? resolved.query
      : { ...resolved.query, idempotency_key: idempotencyKey },
    options.session,
    randomUUID(),
  );
  return {
    caseId: resolved.caseId,
    caseLabel: resolved.caseLabel,
    question,
    source: "retained-controlled-case",
    response,
  };
}

function runAssessment(scenario: AssessmentScenario): AssessmentPresentation {
  const routes = FORMAL_ROUTES.map((routeId, index) => route(routeId, 5 - index));
  if (scenario === "missing") {
    const first = routes[0]!;
    routes[0] = {
      ...first,
      evidence: first.evidence.map((item, index) =>
        index === 0 ? { ...item, present: false } : item,
      ),
    };
  }
  if (scenario === "conflicting") {
    const first = routes[0]!;
    routes[0] = {
      ...first,
      evidence: first.evidence.map((item, index) =>
        index === 0 ? { ...item, conflicting: true } : item,
      ),
    };
  }
  const result = new RouteAssessmentService().assess(assessmentBasis(routes), routes);
  return {
    scenario,
    scenarioLabel:
      scenario === "nominal"
        ? "Complete compatible records"
        : scenario === "missing"
          ? "Missing critical record"
          : "Conflicting critical records",
    source: "controlled-local-scenario",
    result,
  };
}

function route(routeId: FormalRoute, rating: number): RouteAssessmentInput {
  const routeIndex = FORMAL_ROUTES.indexOf(routeId);
  const cashFlow = 60 - routeIndex * 2;
  return {
    routeId,
    ruleEvaluation: {
      outcome: "PASS",
      predicateResults: [{ id: "technical-condition", state: "PASS" }],
      reasonCodes: [],
      rule: { id: urn("rule", 40), version: 1 },
      sources: [{ id: urn("source", 41), version: 1 }],
    },
    circularity: [
      { id: "resource-retention", rating: rating as 1 | 2 | 3 | 4 | 5, weight: "0.5" },
      { id: "information-availability", rating: rating as 1 | 2 | 3 | 4 | 5, weight: "0.5" },
    ],
    functionalUnit: "2",
    environmental: [
      {
        category: "climate-change",
        factor: "2",
        flow: "processing",
        recovered: false,
        quantity: "5",
        resultUnit: "kg-co2e/service",
      },
      {
        category: "climate-change",
        factor: "1",
        flow: "recovery-credit",
        recovered: true,
        quantity: "2",
        resultUnit: "kg-co2e/service",
      },
      {
        category: "mineral-depletion",
        factor: "1",
        flow: "materials",
        recovered: false,
        quantity: "2",
        resultUnit: "kg-sb-e/service",
      },
    ],
    economics: {
      currency: "EUR",
      discountRate: "0",
      initialInvestment: "-100",
      cashFlows: [
        { amount: "50", period: 1 },
        { amount: String(cashFlow), period: 2 },
      ],
    },
    evidence: [
      {
        field: "diagnostic-condition",
        present: true,
        authorized: true,
        current: true,
        revoked: false,
        conflicting: false,
        verified: true,
        critical: true,
      },
      {
        field: "service-history",
        present: true,
        authorized: true,
        current: true,
        revoked: false,
        conflicting: false,
        verified: false,
        critical: false,
      },
    ],
    uncertaintyScenarios: ["low", "central", "high"].map((id) => ({
      id,
      gate: "PASS" as const,
      routeRank: routeIndex + 1,
    })),
    uncertaintyPercentiles: [
      { probability: "0.025", value: String(9 - routeIndex) },
      { probability: "0.5", value: String(11 - routeIndex) },
      { probability: "0.975", value: String(13 - routeIndex) },
    ],
  };
}

function assessmentBasis(routes: readonly RouteAssessmentInput[]) {
  const inputId = urn("assessment", 1);
  return {
    schema: "EVLLM_ASSESSMENT_INPUT_PAYLOAD_V1",
    assessment_input_id: inputId,
    assessment_input_version: 1,
    battery_id: urn("battery", 14),
    jurisdiction: "EU",
    as_of: NOW,
    evidence: [{ id: urn("evidence", 14), version: 1 }],
    rules: [{ id: urn("rule", 40), version: 1 }],
    method: { id: "contextual-route-assessment", version: 1 },
    calculation_inputs_digest: routeCalculationInputsDigest(routes),
    candidate_routes: FORMAL_ROUTES.map((routeId) => ({
      route_id: routeId,
      application: routeName(routeId),
      location: "EU controlled scenario",
      functional_unit: { value: "2", unit_id: urn("unit", 5), unit_version: 1 },
      duty_context: "Controlled second-life duty context",
      service_life: { lower: "1", upper: "2" },
      transport_burden: { value: "1", unit_id: urn("unit", 6), unit_version: 1 },
      testing_burden: { value: "1", unit_id: urn("unit", 7), unit_version: 1 },
      energy_context: "EU grid scenario",
      displaced_alternative: "Declared alternative",
      recovery_process: "Declared recovery process",
      inventories: [],
      factors: [],
      economic_assumptions: [],
      uncertainty: [],
    })),
    issuer_organization_id: urn("org", 8),
    issuer_role_id: urn("role", 9),
    issued_at: NOW,
    protected_bundle_ref: {
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
      bundle_id: urn("bundle", 10),
      bundle_version: 1,
      bundle_type: "assessment",
      domain_resource_id: inputId,
      domain_resource_version: 1,
      custody_controller_org_id: urn("org", 8),
      content_schema_id: urn("schema", 11),
      content_schema_version: "1.0.0",
      initial_criticality_class: "decision-critical",
      criticality_profile_id: urn("profile", 12),
      criticality_profile_version: 1,
    },
  };
}

function workflowStatus(): WorkflowStatusPresentation {
  return {
    source: "controlled-local-scenario",
    battery: {
      id: "Battery ID 001",
      recordedOwner: "Fleet operator 03",
      ownershipState: "Accepted recorded owner",
    },
    protectedRecord: {
      id: "Diagnostic record 014",
      version: 1,
      state: "Confirmed",
      criticality: "Decision-critical",
      replicaState: "Verified encrypted copy recorded",
    },
    marketplace: {
      listing: "Listing 014",
      agreement: "Agreement 014-A",
      state: "Awaiting buyer confirmation",
      nextAuthorizedAction: "Buyer reviews the protected agreement and confirms or declines",
    },
    audit: {
      lastEvent: "Agreement access authorization recorded",
      chainState: "Confirmed in the controlled workflow projection",
    },
  };
}

function routeName(routeId: FormalRoute): string {
  switch (routeId) {
    case "continued-compatible-ev-use":
      return "Continued compatible EV use";
    case "stationary-storage-repurposing":
      return "Stationary storage repurposing";
    case "recycling":
      return "Recycling";
  }
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
