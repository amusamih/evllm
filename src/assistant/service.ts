import { createHash, randomUUID } from "node:crypto";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import { assistantRequest } from "../schemas/domain-records.js";
import type { AssistantAuditLedger } from "./audit.js";
import type { AssistantModelProvider } from "./model.js";
import { ProtectedRetrievalError, ToolAuthorizationError } from "./tools.js";
import type { AssistantToolRegistry } from "./tools.js";
import {
  assistantQuery,
  type ActorSession,
  type AssistantCandidate,
  type AssistantQuery,
  type AssistantResponse,
  type AssistantSupport,
  type ModelResult,
} from "./types.js";

export class AssistantRequestStore {
  readonly #records = new Map<string, unknown>();
  public put(record: unknown): void {
    const parsed = assistantRequest.parse(record);
    if (this.#records.has(parsed.request_id)) throw new Error("Duplicate assistant request");
    this.#records.set(parsed.request_id, structuredClone(parsed));
  }
  public get(requestId: string): unknown {
    const record = this.#records.get(requestId);
    if (record === undefined) throw new Error("Assistant request not found");
    return structuredClone(record);
  }
}

export class AssistantIdempotencyError extends Error {}

export class GovernedAssistantService {
  readonly #idempotentAnswers = new Map<
    string,
    { readonly fingerprint: string; readonly response: Promise<AssistantResponse> }
  >();

  public constructor(
    private readonly tools: AssistantToolRegistry,
    private readonly model: AssistantModelProvider,
    private readonly audit: AssistantAuditLedger,
    private readonly requests: AssistantRequestStore,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly maxContextCharacters = 12_000,
  ) {}

  public async answer(
    raw: unknown,
    session: ActorSession,
    correlationId: string,
  ): Promise<AssistantResponse> {
    const query = assistantQuery.parse(raw);
    if (query.idempotency_key === undefined) {
      return this.answerOnce(query, session, correlationId);
    }
    const key = [
      session.actorId,
      session.organizationId,
      session.credentialId,
      query.idempotency_key,
    ].join("\u0000");
    const fingerprint = hash(
      canonicalJsonBytes({
        query,
        actor_id: session.actorId,
        organization_id: session.organizationId,
        credential_id: session.credentialId,
      }),
    );
    const existing = this.#idempotentAnswers.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new AssistantIdempotencyError("Idempotency key was reused for another request");
      }
      return structuredClone(await existing.response);
    }
    const response = this.answerOnce(query, session, correlationId);
    this.#idempotentAnswers.set(key, { fingerprint, response });
    try {
      return structuredClone(await response);
    } catch (error) {
      if (this.#idempotentAnswers.get(key)?.response === response) {
        this.#idempotentAnswers.delete(key);
      }
      throw error;
    }
  }

  private async answerOnce(
    query: AssistantQuery,
    session: ActorSession,
    correlationId: string,
  ): Promise<AssistantResponse> {
    const requestId = `urn:evllm:assistant:${randomUUID()}`;
    let supports: readonly AssistantSupport[] = [];
    let toolNames: AssistantQuery["requests"][number]["tool"][] = [];
    let validationCodes: string[];
    let result: ModelResult;
    try {
      const execution = await this.tools.execute(query, session);
      supports = execution.supports;
      toolNames = [...execution.toolNames];
      const defect = precondition(execution.supports, execution.injectionDetected);
      if (defect !== null) {
        validationCodes = [defect.code];
        result = deterministicResult(defect.outcome, defect.message);
      } else if (totalContent(supports) > this.maxContextCharacters) {
        validationCodes = ["context-limit"];
        result = deterministicResult(
          "abstain",
          "Authorized support exceeds the bounded model context.",
        );
      } else if (looksLikeAuthorityEscalation(query.question)) {
        validationCodes = ["authority-boundary"];
        result = deterministicResult(
          "abstain",
          "The request crosses the read-only assistant authority boundary.",
        );
      } else if (looksLikeExternalDecision(query.question)) {
        validationCodes = ["external-decision-boundary"];
        result = deterministicResult(
          "requires_external_decision",
          "The request requires a decision by an accountable external authority.",
          citedActiveClaims(supports),
        );
      } else {
        result = await this.model.generate({
          question: query.question,
          purposeId: query.purpose_id,
          asOf: query.as_of,
          session,
          supports,
        });
        validationCodes = validateCandidate(result.candidate, supports, query.question);
        if (validationCodes.length > 0) {
          result = deterministicResult(
            "abstain",
            "The generated response failed support validation.",
          );
        }
      }
    } catch (error) {
      if (!(error instanceof ToolAuthorizationError || error instanceof ProtectedRetrievalError)) {
        throw error;
      }
      validationCodes = [
        error instanceof ProtectedRetrievalError
          ? "retrieval-verification-failed"
          : "access-denied",
      ];
      result = deterministicResult(
        "abstain",
        "Authorized support is unavailable for this request.",
      );
    }

    const validationStatus = validationCodes.length === 0 ? "passed" : "rejected";
    const event = this.audit.append({
      requestId,
      correlationId,
      session,
      purposeId: query.purpose_id,
      question: query.question,
      toolNames,
      supportIds: supports.map(({ support_id }) => support_id),
      model: result,
      outcome: result.candidate.outcome,
      validationCodes,
      recordedAt: this.now(),
    });
    this.requests.put({
      schema: "EVLLM_ASSISTANT_REQUEST_V1",
      request_id: requestId,
      request_version: 1,
      requesting_actor_id: session.actorId,
      requesting_organization_id: session.organizationId,
      minimized_question_metadata: [hash(query.question), query.purpose_id, ...toolNames],
      minimized_result_metadata: [result.candidate.outcome, result.provider, result.model],
      response_state: result.candidate.outcome === "answer" ? "completed" : "refused",
      validation_event_ids: [event.event_id],
      audit_event_id: event.event_id,
      created_at: this.now(),
    });
    return {
      schema: "EVLLM_ASSISTANT_RESPONSE_V1",
      request_id: requestId,
      request_version: 1,
      correlation_id: correlationId,
      outcome: result.candidate.outcome,
      summary: result.candidate.summary,
      claims: result.candidate.claims,
      citations: supports
        .filter(({ support_id }) =>
          result.candidate.claims.some(({ citation_ids }) => citation_ids.includes(support_id)),
        )
        .map(stripContent),
      as_of: query.as_of,
      evidence_state:
        supports.length === 0
          ? "not-evaluated"
          : supports.every(({ status }) => status === "active")
            ? "active"
            : "defective",
      warnings: result.candidate.warnings,
      missing_requirements: result.candidate.missing_requirements,
      evidence_reason_codes: result.candidate.evidence_reason_codes,
      validation: { status: validationStatus, codes: validationCodes },
      model: {
        provider: result.provider,
        model: result.model,
        response_id: result.responseId,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      },
      audit_event_id: event.event_id,
    };
  }
}

function precondition(
  supports: readonly AssistantSupport[],
  injection: boolean,
): { outcome: AssistantCandidate["outcome"]; code: string; message: string } | null {
  if (injection)
    return {
      outcome: "abstain",
      code: "prompt-injection",
      message: "Untrusted support contained instruction-like content.",
    };
  if (supports.length === 0)
    return {
      outcome: "abstain",
      code: "missing-support",
      message: "No authorized support was available.",
    };
  if (supports.some(({ status }) => status === "missing"))
    return {
      outcome: "abstain",
      code: "missing-support",
      message: "A required current support record is missing.",
    };
  if (supports.some(({ status }) => status === "conflicting"))
    return {
      outcome: "requires_external_decision",
      code: "conflicting-support",
      message: "Conflicting support requires accountable external review.",
    };
  if (supports.some(({ status }) => status !== "active"))
    return {
      outcome: "abstain",
      code: "inactive-support",
      message: "Required support is missing, restricted, stale, revoked, or superseded.",
    };
  return null;
}

function validateCandidate(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
  question: string,
): string[] {
  const codes: string[] = [];
  const support = new Map(supports.map((item) => [item.support_id, item]));
  if (candidate.outcome === "answer" && candidate.claims.length === 0) codes.push("empty-answer");
  for (const claim of candidate.claims) {
    if (claim.citation_ids.length === 0) codes.push("uncited-claim");
    for (const citationId of claim.citation_ids) {
      const citation = support.get(citationId);
      if (citation === undefined || citation.status !== "active") codes.push("invalid-citation");
      else if (!hasLexicalEntailment(claim.text, citation.content)) codes.push("unsupported-claim");
    }
  }
  if (containsSecretLikeOutput(candidate)) codes.push("prohibited-disclosure");
  if (claimsUnsupportedCompositeScore(candidate, supports)) codes.push("composite-score-claim");
  const deterministicOutcome = expectedDeterministicOutcome(supports);
  const normalizedSummary = candidate.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
  const expectedNaturalOutcome = deterministicOutcome
    ?.replace(/-preferred$/u, "")
    .replaceAll("-", " ");
  const naturallyStatesExpectedOutcome =
    expectedNaturalOutcome !== undefined &&
    normalizedSummary.includes(expectedNaturalOutcome) &&
    (!deterministicOutcome?.endsWith("-preferred") ||
      /\b(?:preferred|recommended|selected)\b/iu.test(normalizedSummary));
  const naturallyStatesPermittedLifecycle =
    deterministicOutcome === "lifecycle-action-permitted" &&
    /\b(?:lifecycle|workflow|action)\b.{0,50}\b(?:is )?permitted\b/iu.test(normalizedSummary);
  if (
    deterministicOutcome !== null &&
    /(?:route|assessment|workflow|lifecycle)/iu.test(question) &&
    !candidate.summary.toLowerCase().includes(deterministicOutcome) &&
    !naturallyStatesExpectedOutcome &&
    !naturallyStatesPermittedLifecycle
  ) {
    codes.push("deterministic-outcome-mismatch");
  }
  return [...new Set(codes)].sort();
}

function claimsUnsupportedCompositeScore(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
): boolean {
  if (!supports.some(({ content }) => /no overall sustainability score/iu.test(content))) {
    return false;
  }
  const candidateText = JSON.stringify(candidate).replace(
    /(?:no overall sustainability score (?:is |was )?(?:calculated|computed|reported|produced)|does not (?:calculate|compute|report|produce) an? overall sustainability score)/giu,
    "",
  );
  const ambiguousComponentScore = candidate.claims.some(
    ({ text }) =>
      /\b(?:score(?: of)?\s+)?[0-9]+(?:\.[0-9]+)?\s*\/\s*100\b/iu.test(text) &&
      !/\bcircularity\b/iu.test(text),
  );
  const unsupportedComponentInference =
    /\b(?:circularity|component)\b.{0,100}\b(?:indicat|show|demonstrat)[a-z]*\b.{0,80}\b(?:sustainability performance|overall performance|more sustainable|most sustainable|optimal(?:ity)?)\b/iu.test(
      candidateText,
    );
  return (
    ambiguousComponentScore ||
    unsupportedComponentInference ||
    /(?:scores? (?:the )?highest overall|highest overall score|overall sustainability score (?:of|is|equals)|overall score (?:of|is|equals))/iu.test(
      candidateText,
    )
  );
}

function expectedDeterministicOutcome(supports: readonly AssistantSupport[]): string | null {
  for (const support of supports) {
    const match = support.content.match(
      /(?:recorded deterministic outcome code|exact decision code) is '([a-z0-9-]+)'/iu,
    );
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return null;
}

function hasLexicalEntailment(claim: string, support: string): boolean {
  const tokens = claim.toLowerCase().match(/[a-z0-9]{4,}/gu) ?? [];
  const source = support.toLowerCase();
  return tokens.length > 0 && tokens.some((token) => source.includes(token));
}

function containsSecretLikeOutput(candidate: AssistantCandidate): boolean {
  return /(?:-----begin (?:rsa |ec )?private key-----|sk-[a-z0-9_-]{16,}|0x[0-9a-f]{64}\b|document_encryption_key|openai_api_key)/iu.test(
    JSON.stringify(candidate),
  );
}

function looksLikeAuthorityEscalation(question: string): boolean {
  return /(?:sign (?:the )?transaction|submit (?:the )?transaction|fund (?:the )?(?:agreement|escrow|transaction)|settle (?:the )?(?:agreement|escrow|transaction)|refund (?:the )?(?:buyer|payment|funds|escrow)|send (?:the )?(?:payment|funds)|release escrow|transfer ownership|resolve (?:the )?dispute|reveal (?:the )?(?:key|token|system prompt))/iu.test(
    question,
  );
}

function looksLikeExternalDecision(question: string): boolean {
  return /(?:(?:can|could|will|would) (?:you|the system|the assistant) .{0,60}(?:legally |formally )?(?:certify|approve|accredit)|should .{0,80}(?:legally |formally )?(?:certify|approve|accredit)|(?:legal |formal )?(?:certification|accreditation|liability|arbitration) decision)/iu.test(
    question,
  );
}

function totalContent(supports: readonly AssistantSupport[]): number {
  return supports.reduce((total, support) => total + support.content.length, 0);
}

function deterministicResult(
  outcome: AssistantCandidate["outcome"],
  summary: string,
  claims: AssistantCandidate["claims"] = [],
): ModelResult {
  return {
    candidate: {
      outcome,
      summary,
      claims,
      evidence_reason_codes: reasonCodesForOutcome(outcome, summary),
      warnings: [summary],
      missing_requirements: [],
    },
    model: "deterministic-precondition-engine-v1",
    provider: "evllm",
    responseId: null,
    inputTokens: null,
    outputTokens: null,
  };
}

function citedActiveClaims(supports: readonly AssistantSupport[]): AssistantCandidate["claims"] {
  return supports
    .filter(({ status }) => status === "active")
    .map((support, index) => ({
      claim_id: `claim-${String(index + 1)}`,
      text: support.content,
      citation_ids: [support.support_id],
    }));
}

function reasonCodesForOutcome(
  outcome: AssistantCandidate["outcome"],
  summary: string,
): AssistantCandidate["evidence_reason_codes"] {
  if (/conflict/iu.test(summary)) return ["conflicting-evidence"];
  if (/missing|no authorized support/iu.test(summary)) return ["missing-evidence"];
  if (/inactive|restricted|stale|revoked|superseded/iu.test(summary)) return ["inactive-evidence"];
  if (/injection/iu.test(summary)) return ["prompt-injection"];
  return outcome === "requires_external_decision" ? ["external-decision-required"] : [];
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

function stripContent(support: AssistantSupport): Omit<AssistantSupport, "content"> {
  const citation = { ...support };
  delete (citation as Partial<AssistantSupport>).content;
  return citation;
}
