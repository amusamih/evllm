import { describe, expect, it } from "vitest";

import { DatedRuleRegistry } from "../../src/decision/index.js";
import { EU_BATTERIES_REGULATION_EUR_LEX } from "../../src/evaluation/regulatory.js";

const sourceId = urn("source", 1);
const ruleId = urn("rule", 2);
const actorId = urn("actor", 3);

describe("dated authoritative rules", () => {
  it("selects the exact current jurisdiction/scope/version and evaluates predicates", () => {
    const registry = fixture();
    const selected = registry.selectRule({
      asOf: 150,
      jurisdiction: "EU",
      ruleId,
      subjectScope: "nmc-pack",
    });
    expect(selected.record.rule_version).toBe(1);
    expect(registry.source(sourceId, 1).officialUrl).toBe(EU_BATTERIES_REGULATION_EUR_LEX);
    expect(registry.evaluate(selected, { capacity: "75", safety_report: true })).toMatchObject({
      outcome: "PASS",
      sources: [{ id: sourceId, version: 1 }],
    });
    expect(registry.evaluate(selected, { capacity: "69", safety_report: true }).outcome).toBe(
      "FAIL",
    );
    expect(registry.evaluate(selected, { capacity: "75" }).outcome).toBe("UNKNOWN");
  });

  it("fails closed for the wrong date, jurisdiction, scope and inactive source", () => {
    const registry = fixture();
    for (const request of [
      { asOf: 99, jurisdiction: "EU", ruleId, subjectScope: "nmc-pack" },
      { asOf: 150, jurisdiction: "US", ruleId, subjectScope: "nmc-pack" },
      { asOf: 150, jurisdiction: "EU", ruleId, subjectScope: "lfp-module" },
    ]) {
      expect(() => registry.selectRule(request)).toThrow();
    }
    registry.transitionSource(sourceId, 1, "withdrawn", actorId, "source withdrawn", 160);
    expect(() =>
      registry.selectRule({ asOf: 161, jurisdiction: "EU", ruleId, subjectScope: "nmc-pack" }),
    ).toThrow();
    expect(() =>
      registry.transitionSource(sourceId, 1, "active", actorId, "invalid", 162),
    ).toThrow();
  });

  it("rejects duplicate records and activation from stale or unauthorized sources", () => {
    const registry = fixture(false);
    expect(() => registry.registerSource(sourceRecord())).toThrow();
    registry.transitionSource(sourceId, 1, "expired", actorId, "review expired", 201);
    expect(() => registry.registerRule(executableRule(), 202)).toThrow();
  });

  it("evaluates a separately versioned marketplace policy without hidden thresholds", () => {
    const registry = new DatedRuleRegistry();
    const marketplaceRuleId = urn("rule", 20);
    const marketplaceSourceId = urn("source", 21);
    registry.registerSource({
      ...sourceRecord(),
      record: {
        ...sourceRecord().record,
        source_id: marketplaceSourceId,
        permitted_rule_ids: [marketplaceRuleId],
        dependent_rule_ids: [marketplaceRuleId],
      },
    });
    registry.registerRule(
      {
        record: {
          ...executableRule().record,
          rule_id: marketplaceRuleId,
          source_clauses: [{ id: marketplaceSourceId, version: 1 }],
          subject_scope: ["second-hand-listing"],
          predicates: ["seller_is_owner", "bundle_confirmed"],
          required_evidence: ["seller_is_owner", "bundle_confirmed"],
        },
        predicates: [
          {
            id: "owner",
            field: "seller_is_owner",
            operator: "eq",
            threshold: true,
            critical: true,
          },
          {
            id: "bundle",
            field: "bundle_confirmed",
            operator: "eq",
            threshold: true,
            critical: true,
          },
        ],
      },
      100,
    );
    const selected = registry.selectRule({
      asOf: 150,
      jurisdiction: "EU",
      ruleId: marketplaceRuleId,
      subjectScope: "second-hand-listing",
    });
    expect(
      registry.evaluate(selected, { seller_is_owner: true, bundle_confirmed: true }).outcome,
    ).toBe("PASS");
    expect(
      registry.evaluate(selected, { seller_is_owner: false, bundle_confirmed: true }).outcome,
    ).toBe("FAIL");
  });

  it("covers every closed source lifecycle and rejects terminal reactivation", () => {
    for (const terminal of ["superseded", "withdrawn", "expired"] as const) {
      const registry = new DatedRuleRegistry();
      registry.registerSource({
        ...sourceRecord(),
        record: { ...sourceRecord().record, lifecycle: "pending" },
      });
      registry.transitionSource(sourceId, 1, "active", actorId, "approved review", 101);
      registry.transitionSource(sourceId, 1, terminal, actorId, terminal, 102);
      expect(() =>
        registry.transitionSource(sourceId, 1, "active", actorId, "forbidden", 103),
      ).toThrow();
    }
    const temporarilyUnavailable = new DatedRuleRegistry();
    temporarilyUnavailable.registerSource(sourceRecord());
    temporarilyUnavailable.transitionSource(
      sourceId,
      1,
      "unavailable",
      actorId,
      "official host unavailable",
      101,
    );
    expect(
      temporarilyUnavailable.transitionSource(
        sourceId,
        1,
        "active",
        actorId,
        "new recorded review",
        102,
      ).lifecycle,
    ).toBe("active");
  });
});

function fixture(registerRule = true): DatedRuleRegistry {
  const registry = new DatedRuleRegistry();
  registry.registerSource(sourceRecord());
  if (registerRule) registry.registerRule(executableRule(), 100);
  return registry;
}

function sourceRecord() {
  return {
    authority: "European Union",
    jurisdiction: "EU",
    officialUrl: EU_BATTERIES_REGULATION_EUR_LEX,
    title: "Regulation (EU) 2023/1542 source with synthetic test predicates",
    record: {
      schema: "EVLLM_AUTHORITATIVE_SOURCE_V1" as const,
      source_id: sourceId,
      source_version: 1,
      source_class: "legal" as const,
      access_state: "public" as const,
      licence_state: "permitted" as const,
      review_due_at: 200,
      lifecycle: "active" as const,
      transition_actor_id: actorId,
      transition_reason: "reviewed for controlled fixture",
      effective_at: 100,
      reviewed_at: 100,
      permitted_rule_ids: [ruleId],
      dependent_rule_ids: [ruleId],
    },
  };
}

function executableRule() {
  return {
    record: {
      schema: "EVLLM_RULE_PROFILE_V1" as const,
      rule_id: ruleId,
      rule_version: 1,
      source_clauses: [{ id: sourceId, version: 1 }],
      jurisdiction: "EU",
      effective_from: 100,
      effective_until: 200,
      subject_scope: ["nmc-pack"],
      predicates: ["capacity", "safety_report"],
      required_evidence: ["capacity", "safety_report"],
      outcomes: ["PASS", "FAIL", "UNKNOWN"],
      reason_codes: ["CAPACITY", "SAFETY_REPORT"],
      status: "active" as const,
      review_due_at: 200,
    },
    predicates: [
      {
        id: "capacity",
        field: "capacity",
        operator: "gte" as const,
        threshold: "70",
        critical: true,
      },
      { id: "safety", field: "safety_report", operator: "present" as const, critical: true },
    ],
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
