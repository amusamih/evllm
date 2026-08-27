import { z } from "zod";

import { recordedDecisionSupportCommitment } from "./support-commitment.js";

const urn =
  /^urn:evllm:[a-z][a-z0-9-]*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export const assistantToolName = z.enum([
  "facts",
  "history",
  "rules",
  "assessment",
  "audit",
  "protected-search",
]);
export type AssistantToolName = z.infer<typeof assistantToolName>;

export const assistantQueryMode = z.enum(["explain_records", "explain_recorded_decision"]);
export type AssistantQueryMode = z.infer<typeof assistantQueryMode>;

export const assistantQuery = z
  .object({
    question: z.string().trim().min(1).max(4_000),
    mode: assistantQueryMode.default("explain_records"),
    purpose_id: z.string().regex(urn),
    as_of: z.number().int().positive(),
    idempotency_key: z.string().uuid().optional(),
    requests: z
      .array(
        z
          .object({
            tool: assistantToolName,
            arguments: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type AssistantQuery = z.infer<typeof assistantQuery>;

export const supportState = z.enum([
  "active",
  "missing",
  "restricted",
  "stale",
  "revoked",
  "superseded",
  "conflicting",
]);
export type SupportState = z.infer<typeof supportState>;

export const evidenceReasonCode = z.enum([
  "missing-evidence",
  "conflicting-evidence",
  "inactive-evidence",
  "access-denied",
  "prompt-injection",
  "external-decision-required",
]);
export type EvidenceReasonCode = z.infer<typeof evidenceReasonCode>;

export const assistantOutcome = z.enum(["answer", "abstain", "requires_external_decision"]);
export type AssistantOutcome = z.infer<typeof assistantOutcome>;

export const assistantDecisionCode = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
  .max(128);

export function isSupportedAnswerDecisionCode(code: string): boolean {
  return (
    /^eligible-for-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(code) ||
    /^[a-z0-9]+(?:-[a-z0-9]+)*-(?:preferred|recommended|selected|permitted|allowed|authorized|applicable)$/u.test(
      code,
    )
  );
}
export const recordedDecision = z
  .object({
    outcome: assistantOutcome,
    code: assistantDecisionCode,
    reason_codes: z.array(evidenceReasonCode).max(8),
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.reason_codes).size !== decision.reason_codes.length) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "Recorded decision reason codes must be unique",
      });
    }
    if (decision.outcome === "answer" && decision.reason_codes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "Answer decisions cannot contain evidence reason codes",
      });
    }
    if (decision.outcome === "answer" && !isSupportedAnswerDecisionCode(decision.code)) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "Answer decision codes must name a supported semantic decision family",
      });
    }
    if (decision.outcome === "abstain" && decision.reason_codes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "Abstain decisions require at least one evidence reason code",
      });
    }
    if (decision.outcome === "abstain" && decision.code !== "insufficient-evidence") {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "Abstain decisions require the insufficient-evidence code",
      });
    }
    if (
      decision.outcome === "abstain" &&
      decision.reason_codes.includes("external-decision-required")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "Abstain decisions cannot use external-decision-required",
      });
    }
    if (
      decision.outcome === "requires_external_decision" &&
      !decision.reason_codes.includes("external-decision-required")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason_codes"],
        message: "External decisions require external-decision-required",
      });
    }
    if (
      decision.outcome === "requires_external_decision" &&
      decision.code !== "external-decision-required"
    ) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "External decisions require the external-decision-required code",
      });
    }
  });
export type RecordedDecision = z.infer<typeof recordedDecision>;

export const assistantSupport = z
  .object({
    support_id: z.string().min(1).max(128),
    resource_id: z.string().regex(urn),
    resource_version: z.number().int().positive(),
    issuer_organization_id: z.string().regex(urn),
    custodian_organization_id: z.string().regex(urn),
    as_of: z.number().int().positive(),
    status: supportState,
    commitment: z.string().min(16).max(256),
    chain_reference: z.string().max(256).nullable(),
    content: z.string().max(4_000),
    recorded_decision: recordedDecision.optional(),
  })
  .strict()
  .superRefine((support, context) => {
    if (
      support.recorded_decision !== undefined &&
      support.commitment !==
        recordedDecisionSupportCommitment({
          ...support,
          recorded_decision: support.recorded_decision,
        })
    ) {
      context.addIssue({
        code: "custom",
        path: ["commitment"],
        message: "Typed recorded decision is not bound to this support commitment",
      });
    }
  });
export type AssistantSupport = z.infer<typeof assistantSupport>;

const candidateFields = {
  summary: z.string().max(1_500),
  evidence_reason_codes: z.array(evidenceReasonCode).max(8),
  warnings: z.array(z.string().min(1).max(300)).max(32),
  missing_requirements: z.array(z.string().min(1).max(300)).max(32),
} as const;
const claim = z
  .object({
    claim_id: z.string().regex(/^claim-[1-9][0-9]*$/u),
    text: z.string().min(1).max(800),
    citation_ids: z.array(z.string().min(1).max(128)).min(1).max(16),
  })
  .strict();
/** Provider-facing wire schema. Semantic decision checks run only after raw output capture. */
export const assistantModelOutputCandidate = z
  .object({
    outcome: assistantOutcome,
    decision_code: assistantDecisionCode.nullable(),
    ...candidateFields,
    claims: z.array(claim).max(32),
  })
  .strict();

export const assistantCandidate = assistantModelOutputCandidate.superRefine(
  (candidate, context) => {
    if (candidate.outcome === "answer" && candidate.claims.length === 0)
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Answer outcomes require at least one structured cited claim",
      });
    if (
      candidate.outcome === "answer" &&
      candidate.decision_code !== null &&
      !isSupportedAnswerDecisionCode(candidate.decision_code)
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision_code"],
        message: "Answer decision codes must name a supported semantic decision family",
      });
    }
  },
);
export type AssistantCandidate = z.infer<typeof assistantCandidate>;

export interface ModelResult {
  readonly candidate: AssistantCandidate;
  readonly model: string;
  readonly provider: string;
  readonly responseId: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface AssistantResponse {
  readonly schema: "EVLLM_ASSISTANT_RESPONSE_V1";
  readonly request_id: string;
  readonly request_version: 1;
  readonly correlation_id: string;
  readonly outcome: AssistantCandidate["outcome"];
  readonly decision_code: string | null;
  readonly summary: string;
  readonly claims: AssistantCandidate["claims"];
  readonly citations: readonly Omit<AssistantSupport, "content">[];
  readonly as_of: number;
  readonly evidence_state: "active" | "defective" | "not-evaluated";
  readonly warnings: readonly string[];
  readonly missing_requirements: readonly string[];
  readonly evidence_reason_codes: readonly EvidenceReasonCode[];
  readonly validation: Readonly<{ status: "passed" | "rejected"; codes: readonly string[] }>;
  readonly model: Readonly<{
    provider: string;
    model: string;
    response_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
  }>;
  readonly audit_event_id: string;
}

export interface ActorSession {
  readonly sessionId: string;
  readonly actorId: string;
  readonly organizationId: string;
  readonly credentialId: string;
  readonly address: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
