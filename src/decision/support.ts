import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import type { AssessmentResult, FormalRoute } from "./assessment.js";

export interface SupportCitation {
  readonly asOf: number;
  readonly commitment: string;
  readonly custodianOrganizationId: string;
  readonly issuerOrganizationId: string;
  readonly resourceId: string;
  readonly resourceVersion: number;
  readonly status: "active" | "superseded" | "revoked";
  readonly supports: readonly string[];
}

export interface RuleCitation {
  readonly asOf: number;
  readonly jurisdiction: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly sourceId: string;
  readonly sourceVersion: number;
  readonly supports: readonly string[];
}

export interface AssessmentAuditBundle {
  readonly schema: "EVLLM_ASSESSMENT_AUDIT_BUNDLE_V1";
  readonly auditId: string;
  readonly assessmentInputId: string;
  readonly assessmentInputVersion: number;
  readonly assessmentReproductionHash: string;
  readonly evidenceCitations: readonly SupportCitation[];
  readonly ruleCitations: readonly RuleCitation[];
  readonly createdAt: number;
  readonly bundleHash: string;
}

export class SupportValidationError extends Error {
  public constructor(public readonly code: "incomplete" | "invalid" | "stale") {
    super("Assessment support validation failed");
    this.name = "SupportValidationError";
  }
}

export function buildAssessmentAuditBundle(input: {
  readonly assessment: AssessmentResult;
  readonly auditId: string;
  readonly createdAt: number;
  readonly evidenceCitations: readonly SupportCitation[];
  readonly ruleCitations: readonly RuleCitation[];
}): AssessmentAuditBundle {
  if (
    !/^urn:evllm:audit:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.auditId,
    )
  ) {
    throw new SupportValidationError("invalid");
  }
  validateAssessmentSupport(input.assessment, input.evidenceCitations, input.ruleCitations);
  const unsigned = {
    schema: "EVLLM_ASSESSMENT_AUDIT_BUNDLE_V1" as const,
    auditId: input.auditId,
    assessmentInputId: input.assessment.assessmentInputId,
    assessmentInputVersion: input.assessment.assessmentInputVersion,
    assessmentReproductionHash: input.assessment.reproductionHash.value,
    evidenceCitations: sortedEvidence(input.evidenceCitations),
    ruleCitations: sortedRules(input.ruleCitations),
    createdAt: input.createdAt,
  };
  return {
    ...unsigned,
    bundleHash: createHash("sha256").update(canonicalJsonBytes(unsigned)).digest("base64url"),
  };
}

export function validateAssessmentSupport(
  assessment: AssessmentResult,
  evidenceCitations: readonly SupportCitation[],
  ruleCitations: readonly RuleCitation[],
): void {
  if (evidenceCitations.some(({ status }) => status !== "active")) {
    throw new SupportValidationError("stale");
  }
  if (
    evidenceCitations.some(
      ({ commitment, custodianOrganizationId, issuerOrganizationId, resourceId, supports }) =>
        commitment.length === 0 ||
        custodianOrganizationId.length === 0 ||
        issuerOrganizationId.length === 0 ||
        resourceId.length === 0 ||
        supports.length === 0,
    ) ||
    ruleCitations.some(
      ({ jurisdiction, ruleId, sourceId, supports }) =>
        jurisdiction.length === 0 ||
        ruleId.length === 0 ||
        sourceId.length === 0 ||
        supports.length === 0,
    )
  ) {
    throw new SupportValidationError("invalid");
  }
  const supported = new Set([
    ...evidenceCitations.flatMap(({ supports }) => supports),
    ...ruleCitations.flatMap(({ supports }) => supports),
  ]);
  const required = assessment.routes.flatMap(({ routeId }) =>
    (["G", "C", "I", "E", "A", "U"] as const).map((component) => componentPath(routeId, component)),
  );
  if (required.some((path) => !supported.has(path))) throw new SupportValidationError("incomplete");
}

export function componentPath(
  route: FormalRoute,
  component: "A" | "C" | "E" | "G" | "I" | "U",
): string {
  return `routes.${route}.${component}`;
}

function sortedEvidence(citations: readonly SupportCitation[]): readonly SupportCitation[] {
  return citations
    .map((citation) => structuredClone(citation))
    .sort(
      (left, right) =>
        left.resourceId.localeCompare(right.resourceId) ||
        left.resourceVersion - right.resourceVersion ||
        left.supports.join("\u0000").localeCompare(right.supports.join("\u0000")),
    );
}

function sortedRules(citations: readonly RuleCitation[]): readonly RuleCitation[] {
  return citations
    .map((citation) => structuredClone(citation))
    .sort(
      (left, right) =>
        left.ruleId.localeCompare(right.ruleId) ||
        left.ruleVersion - right.ruleVersion ||
        left.supports.join("\u0000").localeCompare(right.supports.join("\u0000")),
    );
}
