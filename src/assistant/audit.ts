import { createHash, randomUUID } from "node:crypto";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import type {
  ActorSession,
  AssistantCandidate,
  AssistantQueryMode,
  AssistantToolName,
  ModelResult,
} from "./types.js";

export type AssistantDecisionSource =
  "typed-record" | "deterministic-control" | "model-candidate" | "validation-fallback";

export interface AssistantRecordedDecisionAuditReference {
  readonly support_id: string;
  readonly resource_id: string;
  readonly resource_version: number;
  readonly commitment: string;
  readonly recorded_decision: Readonly<{
    readonly outcome: AssistantCandidate["outcome"];
    readonly code: string;
    readonly reason_codes: readonly string[];
  }>;
}

export interface AssistantAuditEvent {
  readonly schema: "EVLLM_ASSISTANT_AUDIT_EVENT_V2";
  readonly event_id: string;
  readonly sequence: number;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly actor_id: string;
  readonly organization_id: string;
  readonly session_id: string;
  readonly purpose_id: string;
  readonly query_mode: AssistantQueryMode;
  readonly question_digest: string;
  readonly tool_names: readonly AssistantToolName[];
  readonly support_ids: readonly string[];
  readonly outcome: AssistantCandidate["outcome"];
  readonly decision_code: string | null;
  readonly decision_source: AssistantDecisionSource;
  readonly recorded_decision_support_ids: readonly string[];
  readonly recorded_decision_support_references: readonly AssistantRecordedDecisionAuditReference[];
  readonly model: string;
  readonly provider: string;
  readonly validation_codes: readonly string[];
  readonly recorded_at: number;
  readonly previous_event_hash: string | null;
  readonly event_hash: string;
}

export class AssistantAuditLedger {
  readonly #events: AssistantAuditEvent[] = [];

  public append(input: {
    readonly requestId: string;
    readonly correlationId: string;
    readonly session: ActorSession;
    readonly purposeId: string;
    readonly queryMode: AssistantQueryMode;
    readonly question: string;
    readonly toolNames: readonly AssistantToolName[];
    readonly supportIds: readonly string[];
    readonly model: ModelResult;
    readonly outcome: AssistantCandidate["outcome"];
    readonly decisionCode: string | null;
    readonly decisionSource: AssistantDecisionSource;
    readonly recordedDecisionSupportReferences: readonly AssistantRecordedDecisionAuditReference[];
    readonly validationCodes: readonly string[];
    readonly recordedAt: number;
  }): AssistantAuditEvent {
    const decisionReferences = input.recordedDecisionSupportReferences
      .map((reference) => ({
        support_id: reference.support_id,
        resource_id: reference.resource_id,
        resource_version: reference.resource_version,
        commitment: reference.commitment,
        recorded_decision: {
          outcome: reference.recorded_decision.outcome,
          code: reference.recorded_decision.code,
          reason_codes: [...reference.recorded_decision.reason_codes].sort(),
        },
      }))
      .sort((left, right) =>
        [left.support_id, left.resource_id, left.resource_version, left.commitment]
          .join("\u0000")
          .localeCompare(
            [right.support_id, right.resource_id, right.resource_version, right.commitment].join(
              "\u0000",
            ),
          ),
      );
    const unsigned = {
      schema: "EVLLM_ASSISTANT_AUDIT_EVENT_V2" as const,
      event_id: `urn:evllm:event:${randomUUID()}`,
      sequence: this.#events.length + 1,
      request_id: input.requestId,
      correlation_id: input.correlationId,
      actor_id: input.session.actorId,
      organization_id: input.session.organizationId,
      session_id: input.session.sessionId,
      purpose_id: input.purposeId,
      query_mode: input.queryMode,
      question_digest: hash(input.question),
      tool_names: [...input.toolNames],
      support_ids: [...input.supportIds].sort(),
      outcome: input.outcome,
      decision_code: input.decisionCode,
      decision_source: input.decisionSource,
      recorded_decision_support_ids: decisionReferences.map(({ support_id }) => support_id),
      recorded_decision_support_references: decisionReferences,
      model: input.model.model,
      provider: input.model.provider,
      validation_codes: [...input.validationCodes],
      recorded_at: input.recordedAt,
      previous_event_hash: this.#events.at(-1)?.event_hash ?? null,
    };
    const event: AssistantAuditEvent = Object.freeze({
      ...unsigned,
      event_hash: hash(canonicalJsonBytes(unsigned)),
    });
    this.#events.push(event);
    return structuredClone(event);
  }

  public forRequest(requestId: string, session: ActorSession): readonly AssistantAuditEvent[] {
    return structuredClone(
      this.#events.filter(
        (event) =>
          event.request_id === requestId &&
          event.actor_id === session.actorId &&
          event.organization_id === session.organizationId,
      ),
    );
  }

  public verify(): boolean {
    return verifyAssistantAuditEvents(this.#events);
  }
}

export function verifyAssistantAuditEvents(events: readonly AssistantAuditEvent[]): boolean {
  return events.every((event, index) => {
    const { event_hash: eventHash, ...unsigned } = event;
    return (
      event.sequence === index + 1 &&
      event.previous_event_hash === (events[index - 1]?.event_hash ?? null) &&
      eventHash === hash(canonicalJsonBytes(unsigned))
    );
  });
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}
