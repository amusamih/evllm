import { createHash, randomUUID } from "node:crypto";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import type { ActorSession, AssistantCandidate, AssistantToolName, ModelResult } from "./types.js";

export interface AssistantAuditEvent {
  readonly schema: "EVLLM_ASSISTANT_AUDIT_EVENT_V1";
  readonly event_id: string;
  readonly sequence: number;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly actor_id: string;
  readonly organization_id: string;
  readonly session_id: string;
  readonly purpose_id: string;
  readonly question_digest: string;
  readonly tool_names: readonly AssistantToolName[];
  readonly support_ids: readonly string[];
  readonly outcome: AssistantCandidate["outcome"];
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
    readonly question: string;
    readonly toolNames: readonly AssistantToolName[];
    readonly supportIds: readonly string[];
    readonly model: ModelResult;
    readonly outcome: AssistantCandidate["outcome"];
    readonly validationCodes: readonly string[];
    readonly recordedAt: number;
  }): AssistantAuditEvent {
    const unsigned = {
      schema: "EVLLM_ASSISTANT_AUDIT_EVENT_V1" as const,
      event_id: `urn:evllm:event:${randomUUID()}`,
      sequence: this.#events.length + 1,
      request_id: input.requestId,
      correlation_id: input.correlationId,
      actor_id: input.session.actorId,
      organization_id: input.session.organizationId,
      session_id: input.session.sessionId,
      purpose_id: input.purposeId,
      question_digest: hash(input.question),
      tool_names: [...input.toolNames],
      support_ids: [...input.supportIds].sort(),
      outcome: input.outcome,
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
    return this.#events.every((event, index) => {
      const { event_hash: eventHash, ...unsigned } = event;
      return (
        event.sequence === index + 1 &&
        event.previous_event_hash === (this.#events[index - 1]?.event_hash ?? null) &&
        eventHash === hash(canonicalJsonBytes(unsigned))
      );
    });
  }
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}
