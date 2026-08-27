import { createHash } from "node:crypto";

import { assessmentInputPayload, type digest } from "../schemas/index.js";
import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import { ExactDecimal } from "./decimal.js";
import type { RuleEvaluation } from "./rules.js";

export type AssessmentDigest = ReturnType<typeof digest.parse>;
export const FORMAL_ROUTES = [
  "continued-compatible-ev-use",
  "stationary-storage-repurposing",
  "recycling",
] as const;
export type FormalRoute = (typeof FORMAL_ROUTES)[number];

export interface CircularityCriterion {
  readonly id: string;
  readonly rating?: 1 | 2 | 3 | 4 | 5;
  readonly weight: string;
}

export interface EnvironmentalTerm {
  readonly category: string;
  readonly factor: string;
  readonly flow: string;
  readonly recovered: boolean;
  readonly quantity: string;
  readonly resultUnit: string;
}

export interface EconomicScenario {
  readonly cashFlows: readonly { readonly amount: string; readonly period: number }[];
  readonly currency: string;
  readonly discountRate: string;
  readonly initialInvestment: string;
}

export interface EvidenceFieldState {
  readonly authorized: boolean;
  readonly conflicting: boolean;
  readonly critical: boolean;
  readonly current: boolean;
  readonly field: string;
  readonly present: boolean;
  readonly revoked: boolean;
  readonly verified: boolean;
}

export interface RouteAssessmentInput {
  readonly circularity: readonly CircularityCriterion[];
  readonly economics: EconomicScenario;
  readonly environmental: readonly EnvironmentalTerm[];
  readonly evidence: readonly EvidenceFieldState[];
  readonly functionalUnit: string;
  readonly routeId: FormalRoute;
  readonly ruleEvaluation: RuleEvaluation;
  readonly uncertaintyScenarios: readonly {
    readonly gate: "FAIL" | "PASS" | "UNKNOWN";
    readonly id: string;
    readonly routeRank?: number;
  }[];
  readonly uncertaintyPercentiles?: readonly {
    readonly probability: string;
    readonly value: string;
  }[];
}

export interface RouteAssessmentResult {
  readonly routeId: FormalRoute;
  readonly G: "FAIL" | "PASS" | "UNKNOWN";
  readonly C: { readonly lower: string; readonly upper: string; readonly value?: string };
  readonly I: readonly {
    readonly category: string;
    readonly unit: string;
    readonly value: string;
  }[];
  readonly E: {
    readonly currency: string;
    readonly netPresentValue: string;
    readonly paybackPeriod?: number;
  };
  readonly A: {
    readonly coverage: string;
    readonly verifiedFraction: string;
    readonly freshnessFraction: string;
    readonly conflictCount: number;
    readonly missingCritical: readonly string[];
    readonly weakestCriticalVerification: "missing" | "unverified" | "verified";
  };
  readonly U: {
    readonly gatePassFrequency: string;
    readonly rankStable: boolean;
    readonly scenarioCount: number;
    readonly percentiles: readonly { readonly probability: string; readonly value: string }[];
  };
  readonly reasonCodes: readonly string[];
}

export interface AssessmentResult {
  readonly schema: "EVLLM_DETERMINISTIC_ROUTE_ASSESSMENT_V1";
  readonly assessmentInputId: string;
  readonly assessmentInputVersion: number;
  readonly decisionState: "answer" | "abstain" | "requires_external_decision";
  readonly preferredRoute?: FormalRoute;
  readonly dominance: readonly {
    readonly dominant: FormalRoute;
    readonly dominated: FormalRoute;
  }[];
  readonly reproductionHash: AssessmentDigest;
  readonly routes: readonly RouteAssessmentResult[];
  readonly warnings: readonly string[];
}

export class AssessmentError extends Error {
  public constructor(
    public readonly code:
      | "currency-mismatch"
      | "calculation-input-mismatch"
      | "duplicate"
      | "functional-unit-mismatch"
      | "invalid-input"
      | "route-mismatch"
      | "scenario-mismatch"
      | "unit-mismatch"
      | "weight-sum",
  ) {
    super("Deterministic assessment failed");
    this.name = "AssessmentError";
  }
}

export class RouteAssessmentService {
  public assess(
    basisInput: unknown,
    routeInputs: readonly RouteAssessmentInput[],
  ): AssessmentResult {
    const basis = assessmentInputPayload.parse(basisInput);
    if (
      routeInputs.length !== FORMAL_ROUTES.length ||
      routeInputs.some(({ routeId }, index) => routeId !== FORMAL_ROUTES[index]) ||
      basis.candidate_routes.length !== FORMAL_ROUTES.length ||
      basis.candidate_routes.some(
        ({ route_id: routeId }, index) => routeId !== FORMAL_ROUTES[index],
      )
    ) {
      throw new AssessmentError("route-mismatch");
    }
    const referenceFunctionalUnit = basis.candidate_routes[0].functional_unit;
    for (const [index, input] of routeInputs.entries()) {
      const declared = basis.candidate_routes[index]!.functional_unit;
      if (
        ExactDecimal.parse(declared.value).compare(ExactDecimal.parse(input.functionalUnit)) !==
          0 ||
        ExactDecimal.parse(declared.value).compare(
          ExactDecimal.parse(referenceFunctionalUnit.value),
        ) !== 0
      ) {
        throw new AssessmentError("functional-unit-mismatch");
      }
      if (
        declared.unit_id !== referenceFunctionalUnit.unit_id ||
        declared.unit_version !== referenceFunctionalUnit.unit_version
      ) {
        throw new AssessmentError("unit-mismatch");
      }
    }
    const calculationInputsDigest = routeCalculationInputsDigest(routeInputs);
    if (
      basis.calculation_inputs_digest.alg !== calculationInputsDigest.alg ||
      basis.calculation_inputs_digest.value !== calculationInputsDigest.value
    ) {
      throw new AssessmentError("calculation-input-mismatch");
    }
    if (new Set(routeInputs.map(({ economics }) => economics.currency)).size !== 1) {
      throw new AssessmentError("currency-mismatch");
    }
    validateUncertaintyScenarioRankValues(routeInputs);
    const results = routeInputs.map((input) => this.assessRoute(input));
    validateEnvironmentalResultUnits(results);
    const passResults = results.filter(({ G }) => G === "PASS");
    const passInputs = routeInputs.filter((_, index) => results[index]!.G === "PASS");
    validateUncertaintyScenarioComparability(passInputs);
    const sharedEnvironmentalCategories = environmentalCategoriesSharedBy(passResults);
    const hasSharedEnvironmentalBasis =
      passResults.length <= 1 || sharedEnvironmentalCategories.length > 0;
    const excludesNonSharedEnvironmentalCategories = hasNonSharedEnvironmentalCategories(
      passResults,
      sharedEnvironmentalCategories,
    );
    const allRanksStable = passResults.every(({ U }) => U.rankStable);
    const ranked = routeInputs
      .map((input, index) => ({
        result: results[index]!,
        ranks: input.uncertaintyScenarios.flatMap(({ routeRank }) =>
          routeRank === undefined ? [] : [routeRank],
        ),
      }))
      .filter(({ result, ranks }) => result.G === "PASS" && ranks.length > 0);
    const stableWinners = ranked.filter(
      ({ ranks }) => ranks.length > 0 && ranks.every((rank) => rank === 1),
    );
    const stableWinner = stableWinners.length === 1 ? stableWinners[0]?.result.routeId : undefined;
    const dominance = hasSharedEnvironmentalBasis
      ? paretoDominance(results, sharedEnvironmentalCategories)
      : [];
    const dominatedRoutes = new Set(dominance.map(({ dominated }) => dominated));
    const undominatedPassRoutes = passResults.filter(
      ({ routeId }) => !dominatedRoutes.has(routeId),
    );
    const uniquelySupportedWinner =
      hasSharedEnvironmentalBasis &&
      stableWinner !== undefined &&
      undominatedPassRoutes.length === 1 &&
      undominatedPassRoutes[0]?.routeId === stableWinner
        ? stableWinner
        : undefined;
    const hasUnknown = results.some(({ G }) => G === "UNKNOWN");
    const hasCriticalConflict = routeInputs.some(({ evidence }) =>
      evidence.some(({ conflicting, critical }) => conflicting && critical),
    );
    const decisionState: AssessmentResult["decisionState"] = hasCriticalConflict
      ? "requires_external_decision"
      : hasUnknown || !allRanksStable || uniquelySupportedWinner === undefined
        ? "abstain"
        : "answer";
    const unsigned = {
      schema: "EVLLM_DETERMINISTIC_ROUTE_ASSESSMENT_V1" as const,
      assessmentInputId: basis.assessment_input_id,
      assessmentInputVersion: basis.assessment_input_version,
      decisionState,
      ...(decisionState === "answer" && uniquelySupportedWinner !== undefined
        ? { preferredRoute: uniquelySupportedWinner }
        : {}),
      dominance,
      routes: results,
      warnings: [
        ...(hasUnknown ? ["MISSING_OR_INSUFFICIENT_CRITICAL_EVIDENCE"] : []),
        ...(!allRanksStable || stableWinner === undefined ? ["ROUTE_RANK_UNSTABLE"] : []),
        ...(stableWinner !== undefined && uniquelySupportedWinner === undefined
          ? ["ROUTE_NOT_UNIQUELY_PARETO_SUPPORTED"]
          : []),
        ...(!hasSharedEnvironmentalBasis ? ["NO_SHARED_ENVIRONMENTAL_CATEGORY"] : []),
        ...(excludesNonSharedEnvironmentalCategories
          ? ["NON_SHARED_ENVIRONMENTAL_CATEGORIES_EXCLUDED"]
          : []),
        ...(hasCriticalConflict ? ["CRITICAL_EVIDENCE_CONFLICT"] : []),
      ],
    };
    return {
      ...unsigned,
      reproductionHash: sha256(canonicalJsonBytes({ basis, routeInputs, unsigned })),
    };
  }

  private assessRoute(input: RouteAssessmentInput): RouteAssessmentResult {
    const evidence = evidenceAdequacy(input.evidence);
    const criticalEvidenceUnknown = evidence.missingCritical.length > 0;
    const G =
      input.ruleEvaluation.outcome === "FAIL"
        ? "FAIL"
        : input.ruleEvaluation.outcome === "UNKNOWN" || criticalEvidenceUnknown
          ? "UNKNOWN"
          : "PASS";
    const circularity = circularityScore(input.circularity);
    const environmental = environmentalIndicators(input.environmental, input.functionalUnit);
    const economics = economicResult(input.economics);
    const scenarios = input.uncertaintyScenarios;
    const passCount = scenarios.filter(({ gate }) => gate === "PASS").length;
    const ranks = scenarios.flatMap(({ routeRank }) =>
      routeRank === undefined ? [] : [routeRank],
    );
    const U = {
      gatePassFrequency: fraction(passCount, scenarios.length),
      rankStable:
        passCount === scenarios.length &&
        ranks.length > 0 &&
        ranks.length === scenarios.length &&
        ranks.every((rank) => rank === ranks[0]),
      scenarioCount: scenarios.length,
      percentiles: validatePercentiles(input.uncertaintyPercentiles ?? []),
    };
    return {
      routeId: input.routeId,
      G,
      C: circularity,
      I: environmental,
      E: economics,
      A: evidence,
      U,
      reasonCodes: [
        ...input.ruleEvaluation.reasonCodes,
        ...(criticalEvidenceUnknown ? ["CRITICAL_EVIDENCE_UNKNOWN"] : []),
        ...(G === "FAIL" ? ["TECHNICAL_GATE_FAILED"] : []),
        ...(passCount < scenarios.length ? ["SCENARIO_GATE_NOT_PASSED"] : []),
        ...(!U.rankStable ? ["RANK_UNSTABLE"] : []),
      ],
    };
  }
}

export function routeCalculationInputsDigest(
  routeInputs: readonly RouteAssessmentInput[],
): AssessmentDigest {
  return sha256(
    canonicalJsonBytes({
      schema: "EVLLM_ROUTE_CALCULATION_INPUTS_V1",
      routes: routeInputs,
    }),
  );
}

function circularityScore(criteria: readonly CircularityCriterion[]): RouteAssessmentResult["C"] {
  if (criteria.length === 0 || new Set(criteria.map(({ id }) => id)).size !== criteria.length) {
    throw new AssessmentError("duplicate");
  }
  const totalWeight = criteria.reduce(
    (total, { weight }) => total.add(ExactDecimal.parse(weight)),
    ExactDecimal.fromInteger(0),
  );
  if (totalWeight.compare(ExactDecimal.fromInteger(1)) !== 0)
    throw new AssessmentError("weight-sum");
  let lower = ExactDecimal.fromInteger(0);
  let upper = ExactDecimal.fromInteger(0);
  let complete = true;
  for (const criterion of criteria) {
    const weight = ExactDecimal.parse(criterion.weight);
    if (criterion.rating === undefined) complete = false;
    lower = lower.add(weight.multiply(ExactDecimal.fromInteger(criterion.rating ?? 1)));
    upper = upper.add(weight.multiply(ExactDecimal.fromInteger(criterion.rating ?? 5)));
  }
  const normalize = (weighted: ExactDecimal) =>
    weighted
      .subtract(ExactDecimal.fromInteger(1))
      .multiply(ExactDecimal.fromInteger(100))
      .divide(ExactDecimal.fromInteger(4), 6)
      .toCanonical();
  const result = { lower: normalize(lower), upper: normalize(upper) };
  return complete ? { ...result, value: result.lower } : result;
}

function environmentalIndicators(
  terms: readonly EnvironmentalTerm[],
  functionalUnit: string,
): RouteAssessmentResult["I"] {
  const divisor = ExactDecimal.parse(functionalUnit);
  if (divisor.compare(ExactDecimal.fromInteger(0)) <= 0) throw new AssessmentError("invalid-input");
  const categories = new Map<string, { total: ExactDecimal; unit: string }>();
  for (const term of terms) {
    const contribution = ExactDecimal.parse(term.quantity).multiply(
      ExactDecimal.parse(term.factor),
    );
    const prior = categories.get(term.category);
    if (prior !== undefined && prior.unit !== term.resultUnit)
      throw new AssessmentError("unit-mismatch");
    const signed = term.recovered
      ? ExactDecimal.fromInteger(0).subtract(contribution)
      : contribution;
    categories.set(term.category, {
      total: (prior?.total ?? ExactDecimal.fromInteger(0)).add(signed),
      unit: term.resultUnit,
    });
  }
  return [...categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, { total, unit }]) => ({
      category,
      unit,
      value: total.divide(divisor, 6).toCanonical(),
    }));
}

function economicResult(scenario: EconomicScenario): RouteAssessmentResult["E"] {
  if (!/^[A-Z]{3}$/u.test(scenario.currency)) throw new AssessmentError("currency-mismatch");
  const rate = ExactDecimal.parse(scenario.discountRate);
  if (rate.compare(ExactDecimal.fromInteger(-1)) <= 0) throw new AssessmentError("invalid-input");
  let npv = ExactDecimal.parse(scenario.initialInvestment);
  let cumulative = npv;
  let paybackPeriod: number | undefined;
  const flows = [...scenario.cashFlows].sort((left, right) => left.period - right.period);
  if (new Set(flows.map(({ period }) => period)).size !== flows.length) {
    throw new AssessmentError("duplicate");
  }
  for (const flow of flows) {
    if (!Number.isSafeInteger(flow.period) || flow.period < 1)
      throw new AssessmentError("invalid-input");
    let denominator = ExactDecimal.fromInteger(1);
    const factor = ExactDecimal.fromInteger(1).add(rate);
    for (let period = 0; period < flow.period; period += 1)
      denominator = denominator.multiply(factor);
    const amount = ExactDecimal.parse(flow.amount);
    npv = npv.add(amount.divide(denominator, 18));
    cumulative = cumulative.add(amount);
    if (paybackPeriod === undefined && cumulative.compare(ExactDecimal.fromInteger(0)) >= 0) {
      paybackPeriod = flow.period;
    }
  }
  return {
    currency: scenario.currency,
    netPresentValue: npv.round(2).toCanonical(),
    ...(paybackPeriod === undefined ? {} : { paybackPeriod }),
  };
}

function evidenceAdequacy(items: readonly EvidenceFieldState[]): RouteAssessmentResult["A"] {
  if (items.length === 0 || new Set(items.map(({ field }) => field)).size !== items.length) {
    throw new AssessmentError("duplicate");
  }
  const usable = items.filter(
    ({ authorized, conflicting, current, present, revoked }) =>
      present && authorized && current && !revoked && !conflicting,
  );
  const missingCritical = items
    .filter((item) => item.critical && !usable.includes(item))
    .map(({ field }) => field)
    .sort();
  const critical = items.filter(({ critical: isCritical }) => isCritical);
  const weakestCriticalVerification = critical.some((item) => !usable.includes(item))
    ? "missing"
    : critical.some(({ verified }) => !verified)
      ? "unverified"
      : "verified";
  return {
    coverage: fraction(usable.length, items.length),
    verifiedFraction: fraction(usable.filter(({ verified }) => verified).length, items.length),
    freshnessFraction: fraction(items.filter(({ current }) => current).length, items.length),
    conflictCount: items.filter(({ conflicting }) => conflicting).length,
    missingCritical,
    weakestCriticalVerification,
  };
}

function validatePercentiles(
  points: readonly { readonly probability: string; readonly value: string }[],
): readonly { readonly probability: string; readonly value: string }[] {
  let prior: ExactDecimal | undefined;
  return points.map((point) => {
    const probability = ExactDecimal.parse(point.probability);
    if (
      probability.compare(ExactDecimal.fromInteger(0)) < 0 ||
      probability.compare(ExactDecimal.fromInteger(1)) > 0 ||
      (prior !== undefined && probability.compare(prior) <= 0)
    ) {
      throw new AssessmentError("invalid-input");
    }
    prior = probability;
    return {
      probability: probability.toCanonical(),
      value: ExactDecimal.parse(point.value).toCanonical(),
    };
  });
}

function validateEnvironmentalResultUnits(routes: readonly RouteAssessmentResult[]): void {
  const unitByCategory = new Map<string, string>();
  for (const route of routes) {
    for (const indicator of route.I) {
      const priorUnit = unitByCategory.get(indicator.category);
      if (priorUnit !== undefined && priorUnit !== indicator.unit) {
        throw new AssessmentError("unit-mismatch");
      }
      unitByCategory.set(indicator.category, indicator.unit);
    }
  }
}

function validateUncertaintyScenarioComparability(routes: readonly RouteAssessmentInput[]): void {
  const scenarioSets = routes.map(({ uncertaintyScenarios }) => {
    const ids = uncertaintyScenarios.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new AssessmentError("duplicate");
    return [...ids].sort();
  });
  const reference = scenarioSets[0] ?? [];
  if (
    scenarioSets.some(
      (ids) => ids.length !== reference.length || ids.some((id, index) => id !== reference[index]),
    )
  ) {
    throw new AssessmentError("scenario-mismatch");
  }

  for (const scenarioId of reference) {
    const ranks = routes.map(
      ({ uncertaintyScenarios }) =>
        uncertaintyScenarios.find(({ id }) => id === scenarioId)?.routeRank,
    );
    // A missing rank represents insufficient information and is handled as an
    // unstable ranking. When every passing route is ranked, however, the ranks
    // must form exactly one complete ordering from 1 through the route count.
    if (ranks.some((rank) => rank === undefined)) continue;
    const ordered = (ranks as number[]).toSorted((left, right) => left - right);
    if (ordered.some((rank, index) => rank !== index + 1)) {
      throw new AssessmentError("invalid-input");
    }
  }
}

function validateUncertaintyScenarioRankValues(routes: readonly RouteAssessmentInput[]): void {
  for (const { uncertaintyScenarios } of routes) {
    for (const { gate, routeRank } of uncertaintyScenarios) {
      if (routeRank !== undefined && (!Number.isSafeInteger(routeRank) || routeRank <= 0)) {
        throw new AssessmentError("invalid-input");
      }
      if (gate !== "PASS" && routeRank !== undefined) {
        throw new AssessmentError("invalid-input");
      }
    }
  }
}

function environmentalCategoriesSharedBy(
  routes: readonly RouteAssessmentResult[],
): readonly string[] {
  if (routes.length === 0) return [];
  const shared = new Set(routes[0]!.I.map(({ category }) => category));
  for (const route of routes.slice(1)) {
    const present = new Set(route.I.map(({ category }) => category));
    for (const category of shared) {
      if (!present.has(category)) shared.delete(category);
    }
  }
  return [...shared].sort();
}

function hasNonSharedEnvironmentalCategories(
  routes: readonly RouteAssessmentResult[],
  sharedCategories: readonly string[],
): boolean {
  const allCategories = new Set(
    routes.flatMap(({ I: indicators }) => indicators.map(({ category }) => category)),
  );
  return allCategories.size > sharedCategories.length;
}

function paretoDominance(
  routes: readonly RouteAssessmentResult[],
  sharedEnvironmentalCategories: readonly string[],
): AssessmentResult["dominance"] {
  const pairs: { dominant: FormalRoute; dominated: FormalRoute }[] = [];
  for (const left of routes) {
    for (const right of routes) {
      if (left.routeId === right.routeId || left.G !== "PASS" || right.G !== "PASS") continue;
      const leftImpacts = new Map(
        left.I.filter(({ category }) => sharedEnvironmentalCategories.includes(category)).map(
          ({ category, value }) => [category, ExactDecimal.parse(value)],
        ),
      );
      const rightImpacts = new Map(
        right.I.filter(({ category }) => sharedEnvironmentalCategories.includes(category)).map(
          ({ category, value }) => [category, ExactDecimal.parse(value)],
        ),
      );
      const comparisons = [
        ExactDecimal.parse(left.C.lower).compare(ExactDecimal.parse(right.C.lower)),
        ExactDecimal.parse(left.A.coverage).compare(ExactDecimal.parse(right.A.coverage)),
        ExactDecimal.parse(left.E.netPresentValue).compare(
          ExactDecimal.parse(right.E.netPresentValue),
        ),
        ...sharedEnvironmentalCategories.map(
          (category) => -leftImpacts.get(category)!.compare(rightImpacts.get(category)!),
        ),
      ];
      if (comparisons.every((value) => value >= 0) && comparisons.some((value) => value > 0)) {
        pairs.push({ dominant: left.routeId, dominated: right.routeId });
      }
    }
  }
  return pairs;
}

function fraction(numerator: number, denominator: number): string {
  if (denominator === 0) return "0";
  return ExactDecimal.fromInteger(numerator)
    .divide(ExactDecimal.fromInteger(denominator), 6)
    .toCanonical();
}

function sha256(bytes: Uint8Array): AssessmentDigest {
  return { alg: "SHA-256", value: createHash("sha256").update(bytes).digest("base64url") };
}
