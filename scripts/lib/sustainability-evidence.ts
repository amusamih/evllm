import {
  RouteAssessmentService,
  routeCalculationInputsDigest,
  type RouteAssessmentInput,
} from "../../src/decision/index.js";

export const EVALUATED_ROUTES = [
  "continued-compatible-ev-use",
  "stationary-storage-repurposing",
  "recycling",
] as const;

type EvaluatedRoute = (typeof EVALUATED_ROUTES)[number];

export interface SustainabilityFixture {
  readonly basis: ReturnType<typeof assessmentBasis>;
  readonly routes: RouteAssessmentInput[];
}

export function nominalSustainabilityFixture(variant = 1): SustainabilityFixture {
  const routes = [
    route("continued-compatible-ev-use", 5, 1, variant),
    route("stationary-storage-repurposing", 4, 2, variant),
    route("recycling", 3, 3, variant),
  ];
  return {
    basis: assessmentBasis(variant, routes),
    routes,
  };
}

export function evaluateNominalSustainability(variant = 1) {
  const fixture = nominalSustainabilityFixture(variant);
  return new RouteAssessmentService().assess(fixture.basis, fixture.routes);
}

export function sustainabilitySynthesisRecords(variant: number, idPrefix: string) {
  const result = evaluateNominalSustainability(variant);
  if (result.decisionState !== "answer" || result.preferredRoute === undefined)
    throw new Error("Nominal sustainability fixture must have a stable preferred route");
  const records = [
    {
      support_id: `${idPrefix}-record-1`,
      content: `The contextual assessment for battery FINAL-${String(120 + variant)} compares exactly continued compatible EV use, stationary-storage repurposing, and recycling in the EU context; it reports six separate components and no overall sustainability score.`,
    },
    ...result.routes.map((routeResult, index) => ({
      support_id: `${idPrefix}-record-${String(index + 2)}`,
      content: routeSummary(routeResult),
    })),
    {
      support_id: `${idPrefix}-record-5`,
      content: `The deterministic assessment state is answer; uncertainty ranks ${result.preferredRoute} first in every declared scenario, so the exact decision code is '${result.preferredRoute}-preferred'. The SHA-256 reproduction hash is ${result.reproductionHash.value}.`,
    },
  ];
  return { records, result };
}

export function sustainabilityValidationEvidence() {
  const service = new RouteAssessmentService();
  const nominalFixture = nominalSustainabilityFixture(1);
  const nominal = assessFixture(service, nominalFixture);
  const replay = assessFixture(service, nominalFixture);

  const safetyFixture = nominalSustainabilityFixture(2);
  safetyFixture.routes[0] = {
    ...safetyFixture.routes[0]!,
    ruleEvaluation: {
      ...safetyFixture.routes[0]!.ruleEvaluation,
      outcome: "FAIL",
      reasonCodes: ["TECHNICAL_RULE_FAILED"],
    },
  };
  const safetyFailure = assessFixture(service, safetyFixture);

  const missingFixture = nominalSustainabilityFixture(3);
  missingFixture.routes[1] = {
    ...missingFixture.routes[1]!,
    evidence: missingFixture.routes[1]!.evidence.map((item, index) =>
      index === 0 ? { ...item, present: false } : item,
    ),
  };
  const missingEvidence = assessFixture(service, missingFixture);

  const conflictFixture = nominalSustainabilityFixture(4);
  conflictFixture.routes[2] = {
    ...conflictFixture.routes[2]!,
    evidence: conflictFixture.routes[2]!.evidence.map((item, index) =>
      index === 0 ? { ...item, conflicting: true } : item,
    ),
  };
  const conflictingEvidence = assessFixture(service, conflictFixture);

  const contextFixture = nominalSustainabilityFixture(5);
  const changedContextFixture = structuredClone(contextFixture);
  changedContextFixture.routes[0] = {
    ...changedContextFixture.routes[0]!,
    environmental: changedContextFixture.routes[0]!.environmental.map((term) =>
      term.category === "gwp" ? { ...term, factor: "3" } : term,
    ),
  };
  const contextBaseline = assessFixture(service, contextFixture);
  const changedContext = assessFixture(service, changedContextFixture);

  return {
    schema: "EVLLM_SUSTAINABILITY_VALIDATION_V1" as const,
    method: "Contextual Battery Route Sustainability Assessment",
    routes: EVALUATED_ROUTES,
    componentOrder: ["G", "C", "I", "E", "A", "U"] as const,
    overallScorePresent: false,
    scenarios: {
      nominal,
      safetyFailure,
      missingEvidence,
      conflictingEvidence,
      contextSensitivity: {
        baseline: contextBaseline,
        changed: changedContext,
        changedComponent: "I",
        unchangedComponents: ["C", "E"],
      },
      deterministicReplay: {
        byteIdentical: JSON.stringify(nominal) === JSON.stringify(replay),
        firstHash: nominal.reproductionHash,
        replayHash: replay.reproductionHash,
      },
    },
    assertions: {
      nominalAnswers: nominal.decisionState === "answer",
      failedGateCannotBePreferred: safetyFailure.preferredRoute !== EVALUATED_ROUTES[0],
      missingCriticalEvidenceAbstains: missingEvidence.decisionState === "abstain",
      conflictRequiresExternalDecision:
        conflictingEvidence.decisionState === "requires_external_decision",
      contextChangesEnvironmentalIndicator:
        JSON.stringify(contextBaseline.routes[0]!.I) !==
        JSON.stringify(changedContext.routes[0]!.I),
      contextPreservesCircularity:
        JSON.stringify(contextBaseline.routes[0]!.C) ===
        JSON.stringify(changedContext.routes[0]!.C),
      contextPreservesEconomics:
        JSON.stringify(contextBaseline.routes[0]!.E) ===
        JSON.stringify(changedContext.routes[0]!.E),
      deterministicReplay: JSON.stringify(nominal) === JSON.stringify(replay),
    },
  };
}

function assessFixture(service: RouteAssessmentService, fixture: SustainabilityFixture) {
  return service.assess(
    {
      ...fixture.basis,
      calculation_inputs_digest: routeCalculationInputsDigest(fixture.routes),
    },
    fixture.routes,
  );
}

function routeSummary(result: ReturnType<typeof evaluateNominalSustainability>["routes"][number]) {
  const indicators = result.I.map(
    ({ category, unit, value }) => `${category}=${value} ${unit}`,
  ).join("; ");
  const circularity = result.C.value ?? `${result.C.lower}-${result.C.upper}`;
  return `${routeLabel(result.routeId)}: G=${result.G}; C=${circularity}/100; I=[${indicators}]; E=NPV ${result.E.netPresentValue} ${result.E.currency} and payback ${String(result.E.paybackPeriod ?? "not reached")}; A=coverage ${result.A.coverage}, verified fraction ${result.A.verifiedFraction}, conflicts ${String(result.A.conflictCount)}; U=gate-pass frequency ${result.U.gatePassFrequency}, rank stable=${String(result.U.rankStable)}.`;
}

function routeLabel(routeId: EvaluatedRoute): string {
  return routeId.replaceAll("-", " ");
}

function route(
  routeId: EvaluatedRoute,
  rating: 1 | 2 | 3 | 4 | 5,
  rank: number,
  variant: number,
): RouteAssessmentInput {
  const environmentalFactor = String(2 + (variant - 1) / 10);
  return {
    routeId,
    ruleEvaluation: {
      outcome: "PASS",
      predicateResults: [{ id: "condition-and-safety", state: "PASS" }],
      reasonCodes: [],
      rule: { id: id("rule", 40), version: 1 },
      sources: [{ id: id("source", 41), version: 1 }],
    },
    circularity: [
      { id: "reusability", rating, weight: "0.5" },
      { id: "information-availability", rating, weight: "0.5" },
    ],
    functionalUnit: "2",
    environmental: [
      {
        category: "gwp",
        factor: environmentalFactor,
        flow: "processing",
        recovered: false,
        quantity: "5",
        resultUnit: "kg-co2e/service",
      },
      {
        category: "gwp",
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
        { amount: String(45 + rating), period: 1 },
        { amount: String(55 + rating), period: 2 },
      ],
    },
    evidence: [
      {
        field: "condition-and-safety",
        present: true,
        authorized: true,
        current: true,
        revoked: false,
        conflicting: false,
        verified: true,
        critical: true,
      },
      {
        field: "history",
        present: true,
        authorized: true,
        current: true,
        revoked: false,
        conflicting: false,
        verified: false,
        critical: false,
      },
    ],
    uncertaintyScenarios: [
      { id: "lower", gate: "PASS", routeRank: rank },
      { id: "central", gate: "PASS", routeRank: rank },
      { id: "upper", gate: "PASS", routeRank: rank },
    ],
    uncertaintyPercentiles: [
      { probability: "0.025", value: String(8 + variant) },
      { probability: "0.5", value: String(10 + variant) },
      { probability: "0.975", value: String(12 + variant) },
    ],
  };
}

function assessmentBasis(variant: number, routes: readonly RouteAssessmentInput[]) {
  const inputId = id("assessment", 100 + variant);
  return {
    schema: "EVLLM_ASSESSMENT_INPUT_PAYLOAD_V1" as const,
    assessment_input_id: inputId,
    assessment_input_version: 1,
    battery_id: id("battery", 120 + variant),
    jurisdiction: "EU",
    as_of: 200 + variant,
    evidence: [{ id: id("evidence", 300 + variant), version: 1 }],
    rules: [{ id: id("rule", 40), version: 1 }],
    method: { id: "contextual-battery-route-sustainability-assessment", version: 1 },
    calculation_inputs_digest: routeCalculationInputsDigest(routes),
    candidate_routes: EVALUATED_ROUTES.map((routeId) => ({
      route_id: routeId,
      application: routeId,
      location: "EU",
      functional_unit: { value: "2", unit_id: id("unit", 5), unit_version: 1 },
      duty_context: "controlled final evaluation fixture",
      service_life: { lower: "1", upper: "2" },
      transport_burden: { value: "1", unit_id: id("unit", 6), unit_version: 1 },
      testing_burden: { value: "1", unit_id: id("unit", 7), unit_version: 1 },
      energy_context: "EU grid fixture",
      displaced_alternative: "declared alternative",
      recovery_process: "declared process",
      inventories: [],
      factors: [],
      economic_assumptions: [],
      uncertainty: [],
    })),
    issuer_organization_id: id("org", 8),
    issuer_role_id: id("role", 9),
    issued_at: 200 + variant,
    protected_bundle_ref: {
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1" as const,
      bundle_id: id("bundle", 100 + variant),
      bundle_version: 1,
      bundle_type: "assessment" as const,
      domain_resource_id: inputId,
      domain_resource_version: 1,
      custody_controller_org_id: id("org", 8),
      content_schema_id: id("schema", 11),
      content_schema_version: "1.0.0",
      initial_criticality_class: "decision-critical" as const,
      criticality_profile_id: id("profile", 12),
      criticality_profile_version: 1,
    },
  };
}

function id(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}
