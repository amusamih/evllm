import { describe, expect, it } from "vitest";

import {
  AssessmentError,
  buildAssessmentAuditBundle,
  componentPath,
  FORMAL_ROUTES,
  RouteAssessmentService,
  routeCalculationInputsDigest,
  type RouteAssessmentInput,
} from "../../src/decision/index.js";

describe("contextual battery route assessment", () => {
  it("reproduces circularity endpoints and keeps all six components separate", () => {
    const service = new RouteAssessmentService();
    const routes = routeInputs();
    routes[0] = route("continued-compatible-ev-use", 1);
    routes[1] = route("stationary-storage-repurposing", 5);
    const result = assessRoutes(service, routes);
    expect(result.routes[0]).toMatchObject({
      G: "PASS",
      C: { lower: "0", upper: "0", value: "0" },
    });
    expect(result.routes[1]).toMatchObject({
      G: "PASS",
      C: { lower: "100", upper: "100", value: "100" },
    });
    expect(result.routes[0]?.I).toEqual([
      { category: "gwp", unit: "kg-co2e/service", value: "4" },
      { category: "mineral-depletion", unit: "kg-sb-e/service", value: "1" },
    ]);
    expect(result.routes[0]?.E).toMatchObject({ currency: "EUR", paybackPeriod: 2 });
    expect(result.routes[0]?.A.coverage).toBe("1");
    expect(result).not.toHaveProperty("overallScore");
  });

  it("makes failure dominant and missing/conflicting evidence suppress recommendations", () => {
    const service = new RouteAssessmentService();
    const failed = routeInputs();
    failed[0] = {
      ...failed[0]!,
      ruleEvaluation: { ...failed[0]!.ruleEvaluation, outcome: "FAIL" },
    };
    expect(assessRoutes(service, failed).routes[0]?.G).toBe("FAIL");

    const missing = routeInputs();
    missing[1] = {
      ...missing[1]!,
      evidence: missing[1]!.evidence.map((item, index) =>
        index === 0 ? { ...item, present: false } : item,
      ),
    };
    const missingResult = assessRoutes(service, missing);
    expect(missingResult.routes[1]).toMatchObject({ G: "UNKNOWN", A: { coverage: "0.5" } });
    expect(missingResult.decisionState).toBe("abstain");

    const conflict = routeInputs();
    conflict[2] = {
      ...conflict[2]!,
      evidence: conflict[2]!.evidence.map((item, index) =>
        index === 0 ? { ...item, conflicting: true } : item,
      ),
    };
    expect(assessRoutes(service, conflict).decisionState).toBe("requires_external_decision");
  });

  it("does not renormalize missing circularity ratings and rejects bad dimensions/weights/routes", () => {
    const service = new RouteAssessmentService();
    const missing = routeInputs();
    missing[0] = {
      ...missing[0]!,
      circularity: [
        { id: "known", rating: 5, weight: "0.5" },
        { id: "missing", weight: "0.5" },
      ],
    };
    expect(assessRoutes(service, missing).routes[0]?.C).toEqual({
      lower: "50",
      upper: "100",
    });

    const badWeights = routeInputs();
    badWeights[0] = { ...badWeights[0]!, circularity: [{ id: "only", rating: 5, weight: "0.9" }] };
    expect(() => assessRoutes(service, badWeights)).toThrow();
    expect(() => assessRoutes(service, routeInputs().slice(0, 2))).toThrow();

    const badUnits = routeInputs();
    badUnits[0] = {
      ...badUnits[0]!,
      environmental: [
        ...badUnits[0]!.environmental,
        {
          category: "gwp",
          factor: "1",
          flow: "x",
          recovered: false,
          quantity: "1",
          resultUnit: "kg-x",
        },
      ],
    };
    expect(() => assessRoutes(service, badUnits)).toThrow();
  });

  it("binds every route calculation to the functional unit declared in its protected basis", () => {
    const service = new RouteAssessmentService();
    const routes = routeInputs();
    const matching = assessRoutes(service, routes);
    expect(matching.routes[0]?.I).toEqual([
      { category: "gwp", unit: "kg-co2e/service", value: "4" },
      { category: "mineral-depletion", unit: "kg-sb-e/service", value: "1" },
    ]);

    const mismatchedBasis = structuredClone(basis(routes));
    mismatchedBasis.candidate_routes[1]!.functional_unit.value = "1";
    let failure: unknown;
    try {
      service.assess(mismatchedBasis, routes);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AssessmentError);
    expect(failure).toMatchObject({ code: "functional-unit-mismatch" });
  });

  it("rejects calculation inputs that differ from the protected basis digest", () => {
    const service = new RouteAssessmentService();
    const committed = routeInputs();
    const altered = structuredClone(committed);
    altered[0] = {
      ...altered[0]!,
      economics: {
        ...altered[0]!.economics,
        cashFlows: altered[0]!.economics.cashFlows.map((flow, index) =>
          index === 0 ? { ...flow, amount: "51" } : flow,
        ),
      },
    };

    let failure: unknown;
    try {
      service.assess(basis(committed), altered);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AssessmentError);
    expect(failure).toMatchObject({ code: "calculation-input-mismatch" });
  });

  it("is byte-deterministic, reacts only to changed context, and creates complete audit support", () => {
    const service = new RouteAssessmentService();
    const original = routeInputs();
    const first = assessRoutes(service, original);
    const replay = assessRoutes(service, structuredClone(original));
    expect(replay).toEqual(first);

    const changed = routeInputs();
    changed[0] = {
      ...changed[0]!,
      environmental: changed[0]!.environmental.map((term) =>
        term.category === "gwp" ? { ...term, factor: "3" } : term,
      ),
    };
    const changedResult = assessRoutes(service, changed);
    expect(changedResult.routes[0]?.I).not.toEqual(first.routes[0]?.I);
    expect(changedResult.routes[0]?.C).toEqual(first.routes[0]?.C);
    expect(changedResult.routes[0]?.E).toEqual(first.routes[0]?.E);

    const supports = FORMAL_ROUTES.flatMap((routeId, index) => ({
      asOf: 100,
      commitment: `commitment-${index}`,
      custodianOrganizationId: id("org", 20),
      issuerOrganizationId: id("org", 21),
      resourceId: id("evidence", 30 + index),
      resourceVersion: 1,
      status: "active" as const,
      supports: (["C", "I", "E", "A", "U"] as const).map((component) =>
        componentPath(routeId, component),
      ),
    }));
    const rules = FORMAL_ROUTES.map((routeId) => ({
      asOf: 100,
      jurisdiction: "EU",
      ruleId: id("rule", 40),
      ruleVersion: 1,
      sourceId: id("source", 41),
      sourceVersion: 1,
      supports: [componentPath(routeId, "G")],
    }));
    const audit = buildAssessmentAuditBundle({
      assessment: first,
      auditId: id("audit", 60),
      createdAt: 101,
      evidenceCitations: supports,
      ruleCitations: rules,
    });
    expect(audit.bundleHash).toHaveLength(43);
    expect(
      buildAssessmentAuditBundle({
        assessment: first,
        auditId: id("audit", 60),
        createdAt: 101,
        evidenceCitations: [...supports].reverse(),
        ruleCitations: [...rules].reverse(),
      }),
    ).toEqual(audit);
    expect(() =>
      buildAssessmentAuditBundle({
        assessment: first,
        auditId: id("audit", 61),
        createdAt: 101,
        evidenceCitations: supports.slice(1),
        ruleCitations: rules,
      }),
    ).toThrow();
  });

  it("validates ordered uncertainty percentiles and reports Pareto dominance", () => {
    const service = new RouteAssessmentService();
    const routes = routeInputs();
    routes[0] = {
      ...route("continued-compatible-ev-use", 5),
      uncertaintyPercentiles: [
        { probability: "0.025", value: "8" },
        { probability: "0.5", value: "10" },
        { probability: "0.975", value: "12" },
      ],
    };
    routes[1] = { ...route("stationary-storage-repurposing", 1), uncertaintyPercentiles: [] };
    const result = assessRoutes(service, routes);
    expect(result.routes[0]?.U.percentiles).toHaveLength(3);
    expect(result.dominance).toContainEqual({
      dominant: "continued-compatible-ev-use",
      dominated: "stationary-storage-repurposing",
    });
    const invalid = routeInputs();
    invalid[0] = {
      ...invalid[0]!,
      uncertaintyPercentiles: [
        { probability: "0.5", value: "1" },
        { probability: "0.5", value: "2" },
      ],
    };
    expect(() => assessRoutes(service, invalid)).toThrow();
  });

  it("never recommends a dominated or non-unique route despite a supplied rank of one", () => {
    const service = new RouteAssessmentService();
    const dominatedWinner = routeInputs();
    dominatedWinner[0] = route("continued-compatible-ev-use", 4);
    dominatedWinner[1] = route("stationary-storage-repurposing", 5);
    const dominatedResult = assessRoutes(service, dominatedWinner);
    expect(dominatedResult.dominance).toContainEqual({
      dominant: "stationary-storage-repurposing",
      dominated: "continued-compatible-ev-use",
    });
    expect(dominatedResult.decisionState).toBe("abstain");
    expect(dominatedResult).not.toHaveProperty("preferredRoute");
    expect(dominatedResult.warnings).toContain("ROUTE_NOT_UNIQUELY_PARETO_SUPPORTED");

    const uniqueWinner = routeInputs();
    uniqueWinner[0] = route("continued-compatible-ev-use", 5);
    uniqueWinner[1] = route("stationary-storage-repurposing", 4);
    uniqueWinner[2] = route("recycling", 3);
    const supportedResult = assessRoutes(service, uniqueWinner);
    expect(supportedResult).toMatchObject({
      decisionState: "answer",
      preferredRoute: "continued-compatible-ev-use",
    });
  });

  it("preserves circularity endpoints across deterministic property cases", () => {
    const service = new RouteAssessmentService();
    for (const rating of [1, 2, 3, 4, 5] as const) {
      for (let split = 1; split < 10; split += 1) {
        const routes = routeInputs();
        routes[0] = {
          ...routes[0]!,
          circularity: [
            { id: "left", rating, weight: `0.${split}` },
            { id: "right", rating, weight: `0.${10 - split}` },
          ],
        };
        const score = assessRoutes(service, routes).routes[0]?.C.value;
        expect(score).toBe(String((rating - 1) * 25));
      }
    }
  });
});

function routeInputs(): RouteAssessmentInput[] {
  return FORMAL_ROUTES.map((routeId) => route(routeId, 3));
}

function route(
  routeId: (typeof FORMAL_ROUTES)[number],
  rating: 1 | 2 | 3 | 4 | 5,
): RouteAssessmentInput {
  return {
    routeId,
    ruleEvaluation: {
      outcome: "PASS",
      predicateResults: [{ id: "condition", state: "PASS" }],
      reasonCodes: [],
      rule: { id: id("rule", 40), version: 1 },
      sources: [{ id: id("source", 41), version: 1 }],
    },
    circularity: [
      { id: "reusability", rating, weight: "0.5" },
      { id: "information", rating, weight: "0.5" },
    ],
    functionalUnit: "2",
    environmental: [
      {
        category: "gwp",
        factor: "2",
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
        { amount: "50", period: 1 },
        { amount: "60", period: 2 },
      ],
    },
    evidence: [
      {
        field: "condition",
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
      { id: "low", gate: "PASS", routeRank: routeId === FORMAL_ROUTES[0] ? 1 : 2 },
      { id: "high", gate: "PASS", routeRank: routeId === FORMAL_ROUTES[0] ? 1 : 2 },
    ],
  };
}

function assessRoutes(service: RouteAssessmentService, routes: readonly RouteAssessmentInput[]) {
  return service.assess(basis(routes), routes);
}

function basis(routes: readonly RouteAssessmentInput[] = routeInputs()) {
  const inputId = id("assessment", 1);
  return {
    schema: "EVLLM_ASSESSMENT_INPUT_PAYLOAD_V1",
    assessment_input_id: inputId,
    assessment_input_version: 1,
    battery_id: id("battery", 2),
    jurisdiction: "EU",
    as_of: 100,
    evidence: [{ id: id("evidence", 3), version: 1 }],
    rules: [{ id: id("rule", 40), version: 1 }],
    method: { id: "contextual-route-assessment", version: 1 },
    calculation_inputs_digest: routeCalculationInputsDigest(routes),
    candidate_routes: FORMAL_ROUTES.map((routeId) => ({
      route_id: routeId,
      application: routeId,
      location: "EU",
      functional_unit: { value: "2", unit_id: id("unit", 5), unit_version: 1 },
      duty_context: "controlled fixture",
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
    issued_at: 100,
    protected_bundle_ref: {
      schema: "EVLLM_PROTECTED_BUNDLE_REF_V1",
      bundle_id: id("bundle", 10),
      bundle_version: 1,
      bundle_type: "assessment",
      domain_resource_id: inputId,
      domain_resource_version: 1,
      custody_controller_org_id: id("org", 8),
      content_schema_id: id("schema", 11),
      content_schema_version: "1.0.0",
      initial_criticality_class: "decision-critical",
      criticality_profile_id: id("profile", 12),
      criticality_profile_version: 1,
    },
  };
}

function id(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
