import { authoritativeSource, ruleProfile } from "../schemas/index.js";
import { ExactDecimal } from "./decimal.js";

type SourceRecord = ReturnType<typeof authoritativeSource.parse>;
type RuleRecord = ReturnType<typeof ruleProfile.parse>;

export interface RegisteredSource {
  readonly authority: string;
  readonly jurisdiction: string;
  readonly officialUrl: string;
  readonly record: SourceRecord;
  readonly title: string;
}

export type PredicateOperator = "eq" | "gte" | "lte" | "present";

export interface ExecutablePredicate {
  readonly field: string;
  readonly id: string;
  readonly operator: PredicateOperator;
  readonly threshold?: string | boolean;
  readonly critical: boolean;
}

export interface ExecutableRuleProfile {
  readonly record: RuleRecord;
  readonly predicates: readonly ExecutablePredicate[];
}

export interface RuleEvaluation {
  readonly outcome: "FAIL" | "PASS" | "UNKNOWN";
  readonly predicateResults: readonly {
    id: string;
    state: "FAIL" | "PASS" | "UNKNOWN";
  }[];
  readonly reasonCodes: readonly string[];
  readonly rule: { id: string; version: number };
  readonly sources: readonly { id: string; version: number }[];
}

export class RuleRegistryError extends Error {
  public constructor(
    public readonly code:
      "conflict" | "inactive-source" | "invalid-transition" | "not-found" | "out-of-scope",
  ) {
    super("Rule registry operation failed");
    this.name = "RuleRegistryError";
  }
}

export class DatedRuleRegistry {
  readonly #rules = new Map<string, ExecutableRuleProfile>();
  readonly #sources = new Map<string, RegisteredSource>();

  public registerSource(input: RegisteredSource): SourceRecord {
    const record = authoritativeSource.parse(input.record);
    const key = versionKey(record.source_id, record.source_version);
    if (this.#sources.has(key)) throw new RuleRegistryError("conflict");
    if (!/^https:\/\//u.test(input.officialUrl) || input.authority.trim().length === 0) {
      throw new RuleRegistryError("out-of-scope");
    }
    this.#sources.set(key, { ...input, record });
    return structuredClone(record);
  }

  public transitionSource(
    sourceId: string,
    version: number,
    lifecycle: SourceRecord["lifecycle"],
    actorId: string,
    reason: string,
    at: number,
  ): SourceRecord {
    const source = this.source(sourceId, version);
    if (!allowedSourceTransition(source.record.lifecycle, lifecycle)) {
      throw new RuleRegistryError("invalid-transition");
    }
    const changed = authoritativeSource.parse({
      ...source.record,
      lifecycle,
      transition_actor_id: actorId,
      transition_reason: reason,
      effective_at: at,
      reviewed_at: at,
    });
    this.#sources.set(versionKey(sourceId, version), { ...source, record: changed });
    if (["unavailable", "superseded", "withdrawn", "expired"].includes(lifecycle)) {
      for (const [key, candidate] of this.#rules) {
        const usesSource = candidate.record.source_clauses.some(
          ({ id, version: sourceVersion }) => id === sourceId && sourceVersion === version,
        );
        if (usesSource && candidate.record.status === "active") {
          this.#rules.set(key, {
            ...candidate,
            record: ruleProfile.parse({ ...candidate.record, status: "disabled" }),
          });
        }
      }
    }
    return structuredClone(changed);
  }

  public registerRule(input: ExecutableRuleProfile, at: number): RuleRecord {
    const record = ruleProfile.parse(input.record);
    const key = versionKey(record.rule_id, record.rule_version);
    if (this.#rules.has(key)) throw new RuleRegistryError("conflict");
    if (
      input.predicates.length === 0 ||
      new Set(input.predicates.map(({ id }) => id)).size !== input.predicates.length
    ) {
      throw new RuleRegistryError("conflict");
    }
    for (const sourceRef of record.source_clauses) {
      const source = this.source(sourceRef.id, sourceRef.version).record;
      if (
        source.lifecycle !== "active" ||
        source.review_due_at < at ||
        !source.permitted_rule_ids.includes(record.rule_id)
      ) {
        throw new RuleRegistryError("inactive-source");
      }
    }
    this.#rules.set(key, { record, predicates: structuredClone(input.predicates) });
    return structuredClone(record);
  }

  public selectRule(input: {
    readonly asOf: number;
    readonly jurisdiction: string;
    readonly ruleId: string;
    readonly subjectScope: string;
  }): ExecutableRuleProfile {
    const candidates = [...this.#rules.values()].filter(
      ({ record }) =>
        record.rule_id === input.ruleId &&
        record.status === "active" &&
        record.jurisdiction === input.jurisdiction &&
        record.subject_scope.includes(input.subjectScope) &&
        record.effective_from <= input.asOf &&
        (record.effective_until === undefined || input.asOf < record.effective_until),
    );
    candidates.sort((left, right) => right.record.rule_version - left.record.rule_version);
    const selected = candidates[0];
    if (selected === undefined) throw new RuleRegistryError("out-of-scope");
    for (const sourceRef of selected.record.source_clauses) {
      const source = this.source(sourceRef.id, sourceRef.version).record;
      if (source.lifecycle !== "active" || source.review_due_at < input.asOf) {
        throw new RuleRegistryError("inactive-source");
      }
    }
    return structuredClone(selected);
  }

  public evaluate(
    profile: ExecutableRuleProfile,
    facts: Readonly<Record<string, string | boolean | undefined>>,
  ): RuleEvaluation {
    const predicateResults = profile.predicates.map((predicate) => ({
      id: predicate.id,
      state: evaluatePredicate(predicate, facts[predicate.field]),
    }));
    const critical = profile.predicates.map((predicate, index) => ({
      critical: predicate.critical,
      state: predicateResults[index]?.state ?? "UNKNOWN",
    }));
    const outcome = critical.some(
      ({ critical: isCritical, state }) => isCritical && state === "FAIL",
    )
      ? "FAIL"
      : critical.some(({ critical: isCritical, state }) => isCritical && state === "UNKNOWN")
        ? "UNKNOWN"
        : "PASS";
    return {
      outcome,
      predicateResults,
      reasonCodes: predicateResults
        .filter(({ state }) => state !== "PASS")
        .map(({ id, state }) => `RULE_${state}_${id}`),
      rule: { id: profile.record.rule_id, version: profile.record.rule_version },
      sources: profile.record.source_clauses.map(({ id, version }) => ({ id, version })),
    };
  }

  public source(sourceId: string, version: number): RegisteredSource {
    const source = this.#sources.get(versionKey(sourceId, version));
    if (source === undefined) throw new RuleRegistryError("not-found");
    return structuredClone(source);
  }
}

function evaluatePredicate(
  predicate: ExecutablePredicate,
  value: string | boolean | undefined,
): "FAIL" | "PASS" | "UNKNOWN" {
  if (value === undefined) return "UNKNOWN";
  if (predicate.operator === "present") return value === false ? "FAIL" : "PASS";
  if (predicate.threshold === undefined) return "UNKNOWN";
  if (predicate.operator === "eq") return value === predicate.threshold ? "PASS" : "FAIL";
  if (typeof value !== "string" || typeof predicate.threshold !== "string") return "UNKNOWN";
  const comparison = ExactDecimal.parse(value).compare(ExactDecimal.parse(predicate.threshold));
  return predicate.operator === "gte"
    ? comparison >= 0
      ? "PASS"
      : "FAIL"
    : comparison <= 0
      ? "PASS"
      : "FAIL";
}

function allowedSourceTransition(
  from: SourceRecord["lifecycle"],
  to: SourceRecord["lifecycle"],
): boolean {
  if (from === "pending") return to === "active" || to === "withdrawn" || to === "expired";
  if (from === "active") return ["unavailable", "superseded", "withdrawn", "expired"].includes(to);
  if (from === "unavailable") return to === "active" || to === "withdrawn" || to === "expired";
  return false;
}

function versionKey(id: string, version: number): string {
  return `${id}:${version}`;
}
