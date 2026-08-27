import { createHash, randomUUID } from "node:crypto";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import { assistantRequest } from "../schemas/domain-records.js";
import type {
  AssistantAuditLedger,
  AssistantDecisionSource,
  AssistantRecordedDecisionAuditReference,
} from "./audit.js";
import type { AssistantModelProvider } from "./model.js";
import {
  hasJointSemanticSupport,
  isNonFactualBoilerplate,
  looksLikeEmbeddedInstruction,
  semanticDisclosureMatch,
} from "./semantic-support.js";
import {
  AssistantSupportValidationError,
  ProtectedRetrievalError,
  ToolAuthorizationError,
} from "./tools.js";
import type { AssistantToolRegistry } from "./tools.js";
import {
  assistantQuery,
  type ActorSession,
  type AssistantCandidate,
  type AssistantQuery,
  type AssistantQueryMode,
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
    let responseSupports: readonly AssistantSupport[] = [];
    let toolNames: AssistantQuery["requests"][number]["tool"][] = [];
    let validationCodes: string[];
    let result: ModelResult;
    let decisionSource: AssistantDecisionSource = "deterministic-control";
    try {
      const execution = await this.tools.execute(query, session);
      responseSupports = supportsForQueryMode(execution.supports, query.mode);
      toolNames = [...execution.toolNames];
      const responseInjectionDetected = responseSupports.some(({ content }) =>
        looksLikeEmbeddedInstruction(content),
      );
      const defect = precondition(responseSupports, responseInjectionDetected);
      if (defect !== null) {
        validationCodes = [defect.code];
        result = deterministicResult(defect.outcome, defect.message);
      } else if (totalContent(responseSupports) > this.maxContextCharacters) {
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
      } else if (isExternalDecisionRequest(query.question)) {
        validationCodes = ["external-decision-boundary"];
        result = deterministicResult(
          "requires_external_decision",
          "The request requires a decision by an accountable external authority.",
          citedActiveClaims(responseSupports),
        );
      } else {
        const recordedDecision = resolveActiveRecordedDecision(responseSupports);
        if (query.mode === "explain_recorded_decision" && recordedDecision.kind === "absent") {
          validationCodes = ["missing-recorded-decision"];
          result = deterministicResult(
            "abstain",
            "No active recorded decision is available for explanation.",
          );
        } else if (recordedDecision.kind === "conflicting") {
          validationCodes = ["conflicting-recorded-decision"];
          result = deterministicResult(
            "requires_external_decision",
            "Active supports contain conflicting recorded decisions and require accountable external review.",
            [],
            null,
            ["conflicting-evidence", "external-decision-required"],
          );
        } else {
          result = await this.model.generate({
            question: query.question,
            purposeId: query.purpose_id,
            asOf: query.as_of,
            session,
            supports: responseSupports,
          });
          const release = releaseAssistantCandidateWithRecordedDecision(
            result.candidate,
            responseSupports,
            query.question,
            { screenExplanation: true },
          );
          decisionSource =
            release.resolution.kind === "consistent" ? "typed-record" : "model-candidate";
          result = { ...result, candidate: release.candidate };
          validationCodes = [...release.validation_codes];
          if (validationCodes.length > 0) {
            decisionSource = "validation-fallback";
            result = deterministicResult(
              "abstain",
              "The generated response failed support validation.",
            );
          }
        }
      }
    } catch (error) {
      if (!(
        error instanceof ToolAuthorizationError ||
        error instanceof ProtectedRetrievalError ||
        error instanceof AssistantSupportValidationError
      )) {
        throw error;
      }
      validationCodes = [
        error instanceof ProtectedRetrievalError
          ? "retrieval-verification-failed"
          : error instanceof AssistantSupportValidationError
            ? "invalid-support"
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
      queryMode: query.mode,
      question: query.question,
      toolNames,
      supportIds: responseSupports.map(({ support_id }) => support_id),
      model: result,
      outcome: result.candidate.outcome,
      decisionCode: result.candidate.decision_code,
      decisionSource,
      recordedDecisionSupportReferences: activeRecordedDecisionSupportReferences(responseSupports),
      validationCodes,
      recordedAt: this.now(),
    });
    this.requests.put({
      schema: "EVLLM_ASSISTANT_REQUEST_V1",
      request_id: requestId,
      request_version: 1,
      requesting_actor_id: session.actorId,
      requesting_organization_id: session.organizationId,
      minimized_question_metadata: [
        hash(query.question),
        query.purpose_id,
        `query-mode:${query.mode}`,
        ...toolNames,
      ],
      minimized_result_metadata: [
        result.candidate.outcome,
        `decision-code:${result.candidate.decision_code ?? "none"}`,
        `decision-source:${decisionSource}`,
        result.provider,
        result.model,
      ],
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
      decision_code: result.candidate.decision_code,
      summary: result.candidate.summary,
      claims: result.candidate.claims,
      citations: responseSupports
        .filter(({ support_id }) =>
          result.candidate.claims.some(({ citation_ids }) => citation_ids.includes(support_id)),
        )
        .map(stripContent),
      as_of: query.as_of,
      evidence_state:
        responseSupports.length === 0
          ? "not-evaluated"
          : responseSupports.every(({ status }) => status === "active")
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

function supportsForQueryMode(
  supports: readonly AssistantSupport[],
  mode: AssistantQueryMode,
): readonly AssistantSupport[] {
  if (mode === "explain_recorded_decision") return supports;
  return supports.filter(({ recorded_decision }) => recorded_decision === undefined);
}

export type ActiveRecordedDecisionResolution =
  | Readonly<{ kind: "absent" }>
  | Readonly<{
      kind: "consistent";
      decision: NonNullable<AssistantSupport["recorded_decision"]>;
    }>
  | Readonly<{ kind: "conflicting" }>;

/** Resolves active typed decisions without relying on natural-language record content. */
export function resolveActiveRecordedDecision(
  supports: readonly AssistantSupport[],
): ActiveRecordedDecisionResolution {
  const decisions = supports
    .filter(
      (
        support,
      ): support is AssistantSupport & {
        recorded_decision: NonNullable<AssistantSupport["recorded_decision"]>;
      } => support.status === "active" && support.recorded_decision !== undefined,
    )
    .map(({ recorded_decision: decision }) => normalizeRecordedDecision(decision));
  if (decisions.length === 0) return { kind: "absent" };
  const [first] = decisions;
  if (first === undefined) return { kind: "absent" };
  const key = recordedDecisionKey(first);
  if (decisions.some((decision) => recordedDecisionKey(decision) !== key)) {
    return { kind: "conflicting" };
  }
  return { kind: "consistent", decision: first };
}

function activeRecordedDecisionSupportReferences(
  supports: readonly AssistantSupport[],
): readonly AssistantRecordedDecisionAuditReference[] {
  return supports
    .filter(
      (
        support,
      ): support is AssistantSupport & {
        recorded_decision: NonNullable<AssistantSupport["recorded_decision"]>;
      } => support.status === "active" && support.recorded_decision !== undefined,
    )
    .map((support) => ({
      support_id: support.support_id,
      resource_id: support.resource_id,
      resource_version: support.resource_version,
      commitment: support.commitment,
      recorded_decision: normalizeRecordedDecision(support.recorded_decision),
    }));
}

/** Returns a bound copy so collector-held raw model output remains unchanged. */
export function bindAssistantCandidateToRecordedDecision(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
): Readonly<{
  candidate: AssistantCandidate;
  resolution: ActiveRecordedDecisionResolution;
}> {
  return materializeAssistantCandidateWithRecordedDecision(candidate, supports, {
    screenExplanation: false,
  });
}

export function materializeAssistantCandidateWithRecordedDecision(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
  options: Readonly<{ screenExplanation: boolean }>,
): Readonly<{
  candidate: AssistantCandidate;
  resolution: ActiveRecordedDecisionResolution;
}> {
  const resolution = resolveActiveRecordedDecision(supports);
  if (resolution.kind !== "consistent") return { candidate, resolution };
  const decisionSupports = supports
    .filter(
      (support) =>
        support.status === "active" &&
        support.recorded_decision !== undefined &&
        recordedDecisionKey(support.recorded_decision) === recordedDecisionKey(resolution.decision),
    )
    .sort((left, right) => left.support_id.localeCompare(right.support_id));
  const decisionSupportIds = decisionSupports.map(({ support_id: supportId }) => supportId);
  const fixedDecisionText = recordedDecisionStatement(resolution.decision);
  const explanatoryClaims = candidate.claims
    .filter(({ text }) => isModelAuthoredExplanation(text, resolution.decision.code))
    .filter(
      (claim) => !options.screenExplanation || validateAssistantClaim(claim, supports).length === 0,
    )
    .map((claim, index) => ({
      ...claim,
      claim_id: `claim-${String(index + 2)}`,
      citation_ids: [...claim.citation_ids],
    }));
  const explanatorySupports: Array<Pick<AssistantSupport, "content">> = [
    ...supports.filter(({ status }) => status === "active"),
    { content: fixedDecisionText },
  ];
  const retainVisibleExplanation = (text: string): boolean =>
    isModelAuthoredExplanation(text, resolution.decision.code) &&
    (!options.screenExplanation ||
      isNonFactualBoilerplate(text) ||
      hasJointSemanticSupport(text, explanatorySupports, false));
  return {
    candidate: {
      outcome: resolution.decision.outcome,
      decision_code: resolution.decision.code,
      summary: fixedDecisionText,
      claims: [
        {
          claim_id: "claim-1",
          text: fixedDecisionText,
          citation_ids: decisionSupportIds,
        },
        ...explanatoryClaims,
      ],
      evidence_reason_codes: [...resolution.decision.reason_codes],
      warnings: candidate.warnings.filter(retainVisibleExplanation),
      missing_requirements: candidate.missing_requirements.filter(retainVisibleExplanation),
    },
    resolution,
  };
}

/**
 * Applies the same deterministic decision rendering and explanation screening used by the
 * production service. If a model explanation fails screening, the typed decision remains
 * releasable while the model-authored explanation is withheld.
 */
export function releaseAssistantCandidateWithRecordedDecision(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
  question: string,
  options: Readonly<{ screenExplanation: boolean }>,
): Readonly<{
  candidate: AssistantCandidate;
  validation_candidate: AssistantCandidate;
  validation_codes: readonly string[];
  resolution: ActiveRecordedDecisionResolution;
  explanation_withheld: boolean;
}> {
  const materialized = materializeAssistantCandidateWithRecordedDecision(
    candidate,
    supports,
    options,
  );
  if (!options.screenExplanation) {
    return {
      candidate: materialized.candidate,
      validation_candidate: materialized.candidate,
      validation_codes: [],
      resolution: materialized.resolution,
      explanation_withheld: false,
    };
  }
  const validationCodes = validateAssistantCandidate(materialized.candidate, supports, question);
  if (validationCodes.length === 0 || materialized.resolution.kind !== "consistent") {
    return {
      candidate: materialized.candidate,
      validation_candidate: materialized.candidate,
      validation_codes: validationCodes,
      resolution: materialized.resolution,
      explanation_withheld: false,
    };
  }

  const fixedOnly = materializeAssistantCandidateWithRecordedDecision(
    emptyExplanationCandidate(),
    supports,
    { screenExplanation: true },
  ).candidate;
  const fixedValidationCodes = validateAssistantCandidate(fixedOnly, supports, question);
  if (fixedValidationCodes.length > 0) {
    throw new Error(
      `Deterministic recorded-decision rendering failed validation: ${fixedValidationCodes.join(",")}`,
    );
  }
  return {
    candidate: fixedOnly,
    validation_candidate: fixedOnly,
    validation_codes: [],
    resolution: materialized.resolution,
    explanation_withheld: true,
  };
}

function emptyExplanationCandidate(): AssistantCandidate {
  return {
    outcome: "abstain",
    decision_code: null,
    summary: "",
    claims: [],
    evidence_reason_codes: ["missing-evidence"],
    warnings: [],
    missing_requirements: [],
  };
}

function isModelAuthoredExplanation(text: string, decisionCode: string): boolean {
  return (
    !containsExactDecisionCode(text, decisionCode) &&
    !/\b(?:recorded\s+)?decision\s+code\b/iu.test(text) &&
    !containsUnboundOperativeDecision(text)
  );
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

export function validateAssistantCandidate(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
  question: string,
): string[] {
  const codes: string[] = [];
  if (candidate.outcome === "answer" && candidate.claims.length === 0) codes.push("empty-answer");
  const validatedClaimTexts: string[] = [];
  const claimValidation = new Map<AssistantCandidate["claims"][number], readonly string[]>();
  for (const claim of candidate.claims) {
    const claimCodes = validateAssistantClaim(claim, supports);
    claimValidation.set(claim, claimCodes);
    codes.push(...claimCodes);
    if (claimCodes.length === 0) validatedClaimTexts.push(claim.text);
  }
  const recordedDecision = resolveActiveRecordedDecision(supports);
  if (recordedDecision.kind === "conflicting") {
    codes.push("conflicting-recorded-decision");
  } else if (recordedDecision.kind === "absent") {
    if (candidate.decision_code !== null) codes.push("unexpected-decision-code");
  } else if (
    candidate.outcome !== recordedDecision.decision.outcome ||
    candidate.decision_code !== recordedDecision.decision.code ||
    !sameReasonCodes(candidate.evidence_reason_codes, recordedDecision.decision.reason_codes)
  ) {
    codes.push("recorded-decision-mismatch");
  }
  const userVisibleTexts = [
    candidate.summary,
    ...candidate.claims.map(({ text }) => text),
    ...candidate.warnings,
    ...candidate.missing_requirements,
  ];
  if (
    recordedDecision.kind === "absent" &&
    userVisibleTexts.some((text) => containsUnboundOperativeDecision(text))
  ) {
    codes.push("unbound-decision-assertion");
  }
  if (
    recordedDecision.kind === "consistent" &&
    userVisibleTexts.some((text) =>
      contradictsRecordedDecision(text, recordedDecision.decision.code),
    )
  ) {
    codes.push("recorded-decision-contradiction");
  }
  if (recordedDecision.kind === "consistent") {
    const { decision } = recordedDecision;
    if (!containsExactDecisionCode(candidate.summary, decision.code)) {
      codes.push("recorded-decision-summary-code-missing");
    }
    const decisionSupportIds = new Set(
      supports
        .filter(
          (support) =>
            support.status === "active" &&
            support.recorded_decision !== undefined &&
            recordedDecisionKey(support.recorded_decision) === recordedDecisionKey(decision),
        )
        .map(({ support_id }) => support_id),
    );
    const citedDecisionClaim = candidate.claims.some(
      (claim) =>
        claimValidation.get(claim)?.length === 0 &&
        containsExactDecisionCode(claim.text, decision.code) &&
        !contradictsRecordedDecision(claim.text, decision.code) &&
        claim.citation_ids.some((citationId) => decisionSupportIds.has(citationId)),
    );
    if (!citedDecisionClaim) codes.push("recorded-decision-cited-claim-missing");
    if (userVisibleTexts.some((text) => containsAlternateDecisionCode(text, decision.code))) {
      codes.push("recorded-decision-user-visible-code-mismatch");
    }
    const semanticDecisionTexts = [
      candidate.summary,
      ...candidate.claims
        .filter((claim) => claimValidation.get(claim)?.length === 0)
        .map(({ text }) => text),
      ...candidate.warnings,
      ...candidate.missing_requirements,
    ];
    if (
      semanticDecisionTexts.some((text) => contradictsRecordedDecisionSemantics(text, decision))
    ) {
      codes.push("recorded-decision-semantic-contradiction");
    }
  }
  const userVisibleSupports: Array<Pick<AssistantSupport, "content">> = [
    ...supports.filter(({ status }) => status === "active"),
    ...validatedClaimTexts.map((content) => ({ content })),
    ...(recordedDecision.kind === "consistent"
      ? [{ content: recordedDecisionStatement(recordedDecision.decision) }]
      : []),
  ];
  for (const text of [
    candidate.summary,
    ...candidate.warnings,
    ...candidate.missing_requirements,
  ]) {
    if (
      text.trim().length > 0 &&
      !isNonFactualBoilerplate(text) &&
      !hasJointSemanticSupport(text, userVisibleSupports, false)
    ) {
      codes.push("unsupported-user-visible-text");
    }
  }
  if (!reasonCodesAreCoherent(candidate, supports)) codes.push("incoherent-reason-code");
  if (containsSecretLikeOutput(candidate)) codes.push("prohibited-disclosure");
  if (containsProhibitedSupportDisclosure(candidate, supports)) {
    codes.push("prohibited-disclosure");
  }
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

/**
 * Validates only model-authored explanatory prose. Structured decision-tuple fidelity is measured
 * separately, and the application—not this prose—renders any recorded decision.
 */
export function validateAssistantExplanationCandidate(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
): string[] {
  const codes: string[] = [];
  if (candidate.claims.length === 0) codes.push("empty-explanation");
  const validatedClaimTexts: string[] = [];
  for (const claim of candidate.claims) {
    const claimCodes = validateAssistantClaim(claim, supports);
    codes.push(...claimCodes);
    if (claimCodes.length === 0) validatedClaimTexts.push(claim.text);
  }
  const visibleTexts = [
    candidate.summary,
    ...candidate.claims.map(({ text }) => text),
    ...candidate.warnings,
    ...candidate.missing_requirements,
  ];
  if (visibleTexts.some((text) => containsUnboundOperativeDecision(text))) {
    codes.push("model-authored-decision-assertion");
  }
  const userVisibleSupports: Array<Pick<AssistantSupport, "content">> = [
    ...supports.filter(({ status }) => status === "active").map(({ content }) => ({ content })),
    ...validatedClaimTexts.map((content) => ({ content })),
  ];
  for (const text of [
    candidate.summary,
    ...candidate.warnings,
    ...candidate.missing_requirements,
  ]) {
    if (
      text.trim().length > 0 &&
      !isNonFactualBoilerplate(text) &&
      !hasJointSemanticSupport(text, userVisibleSupports, false)
    ) {
      codes.push("unsupported-user-visible-text");
    }
  }
  if (containsSecretLikeOutput(candidate)) codes.push("prohibited-disclosure");
  if (containsProhibitedSupportDisclosure(candidate, supports)) {
    codes.push("prohibited-disclosure");
  }
  if (claimsUnsupportedCompositeScore(candidate, supports)) codes.push("composite-score-claim");
  return [...new Set(codes)].sort();
}

export function validateAssistantClaim(
  claim: AssistantCandidate["claims"][number],
  supports: readonly AssistantSupport[],
): string[] {
  const codes: string[] = [];
  const support = new Map(supports.map((item) => [item.support_id, item]));
  const citationIds = [...new Set(claim.citation_ids)];
  if (citationIds.length === 0) {
    codes.push("uncited-claim");
    return codes;
  }

  const citedSupports: AssistantSupport[] = [];
  for (const citationId of citationIds) {
    const citation = support.get(citationId);
    if (citation === undefined || citation.status !== "active") {
      codes.push("invalid-citation");
    } else {
      citedSupports.push(citation);
    }
  }
  if (
    citedSupports.length === citationIds.length &&
    !hasJointSemanticSupport(
      claim.text,
      citedSupports.map((support) => ({
        content:
          support.recorded_decision === undefined
            ? support.content
            : `${support.content}\n${recordedDecisionStatement(support.recorded_decision)}`,
      })),
    )
  ) {
    codes.push("unsupported-claim");
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
    /(?:no overall sustainability score(?: (?:is |was )?(?:calculated|computed|reported|produced))?|does not (?:calculate|compute|report|produce) an? overall sustainability score)/giu,
    "",
  );
  const ambiguousComponentScore = candidate.claims.some(
    ({ text }) =>
      /\b(?:score(?: of)?\s+)?[0-9]+(?:\.[0-9]+)?\s*\/\s*100\b/iu.test(text) &&
      !/\bcircularity\b|\bC\s*(?:=|(?:component\s+)?is)\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*100\b/iu.test(
        text,
      ),
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
  const recorded = resolveActiveRecordedDecision(supports);
  if (recorded.kind === "consistent") return recorded.decision.code;
  for (const support of supports) {
    const match = support.content.match(
      /(?:recorded deterministic outcome code|exact decision code) is '([a-z0-9-]+)'/iu,
    );
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return null;
}

function reasonCodesAreCoherent(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
): boolean {
  const typedDecision = resolveActiveRecordedDecision(supports);
  if (typedDecision.kind === "conflicting") return false;
  if (
    typedDecision.kind === "consistent" &&
    !sameReasonCodes(candidate.evidence_reason_codes, typedDecision.decision.reason_codes)
  ) {
    return false;
  }
  const expected = new Set<AssistantCandidate["evidence_reason_codes"][number]>();
  const recordedOutcome = expectedDeterministicOutcome(supports);
  if (supports.length === 0 || supports.some(({ status }) => status === "missing")) {
    expected.add("missing-evidence");
  }
  if (supports.some(({ status }) => status === "conflicting")) {
    expected.add("conflicting-evidence");
  }
  if (
    supports.some(({ status }) => ["restricted", "stale", "revoked", "superseded"].includes(status))
  ) {
    expected.add("inactive-evidence");
  }
  if (supports.some(({ content }) => looksLikeEmbeddedInstruction(content))) {
    expected.add("prompt-injection");
  }
  if (
    recordedOutcome === "insufficient-evidence" ||
    supports.some(({ content }) =>
      /\b(?:missing|no current)\b.{0,80}\b(?:evidence|record|report|inspection)\b/iu.test(content),
    )
  ) {
    expected.add("missing-evidence");
  }
  if (
    recordedOutcome === "external-decision-required" ||
    supports.some(({ content }) =>
      /\b(?:conflict|conflicting|disagree|incompatible)\b/iu.test(content),
    )
  ) {
    expected.add("conflicting-evidence");
  }
  if (candidate.outcome === "requires_external_decision") {
    expected.add("external-decision-required");
  }
  const reported = new Set(candidate.evidence_reason_codes);
  if (candidate.outcome === "answer" && reported.size > 0) return false;
  for (const code of reported) if (!expected.has(code)) return false;
  if (
    candidate.outcome === "requires_external_decision" &&
    !reported.has("external-decision-required") &&
    !reported.has("conflicting-evidence")
  ) {
    return false;
  }
  return true;
}

function containsSecretLikeOutput(candidate: AssistantCandidate): boolean {
  return /(?:-----begin (?:rsa |ec )?private key-----|sk-[a-z0-9_-]{16,}|0x[0-9a-f]{64}\b|document_encryption_key|openai_api_key)/iu.test(
    JSON.stringify(candidate),
  );
}

function containsProhibitedSupportDisclosure(
  candidate: AssistantCandidate,
  supports: readonly AssistantSupport[],
): boolean {
  const output = JSON.stringify(candidate);
  return supports.some(
    (support) => support.status !== "active" && semanticDisclosureMatch(support.content, output),
  );
}

function looksLikeAuthorityEscalation(question: string): boolean {
  return /(?:sign (?:the )?transaction|submit (?:the )?transaction|fund (?:the )?(?:agreement|escrow|transaction)|settle (?:the )?(?:agreement|escrow|transaction)|refund (?:the )?(?:buyer|payment|funds|escrow)|send (?:the )?(?:payment|funds)|release escrow|transfer ownership|resolve (?:the )?dispute|reveal (?:the )?(?:key|token|system prompt))/iu.test(
    question,
  );
}

export function isExternalDecisionRequest(question: string): boolean {
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
  decisionCode: string | null = null,
  reasonCodes: AssistantCandidate["evidence_reason_codes"] = reasonCodesForOutcome(
    outcome,
    summary,
  ),
): ModelResult {
  return {
    candidate: {
      outcome,
      decision_code: decisionCode,
      summary,
      claims,
      evidence_reason_codes: [...reasonCodes],
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

function normalizeRecordedDecision(
  decision: NonNullable<AssistantSupport["recorded_decision"]>,
): NonNullable<AssistantSupport["recorded_decision"]> {
  return {
    outcome: decision.outcome,
    code: decision.code,
    reason_codes: [...new Set(decision.reason_codes)].sort(),
  };
}

function recordedDecisionKey(decision: NonNullable<AssistantSupport["recorded_decision"]>): string {
  return JSON.stringify(normalizeRecordedDecision(decision));
}

function sameReasonCodes(
  left: readonly AssistantCandidate["evidence_reason_codes"][number][],
  right: readonly AssistantCandidate["evidence_reason_codes"][number][],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((code, index) => code === sortedRight[index]);
}

function recordedDecisionStatement(
  decision: NonNullable<AssistantSupport["recorded_decision"]>,
): string {
  if (decision.outcome === "abstain") {
    return `The recorded decision withholds an answer because required evidence is insufficient. The recorded decision code is ${decision.code}.`;
  }
  if (decision.outcome === "requires_external_decision") {
    return `The recorded decision requires review by a responsible organization. The recorded decision code is ${decision.code}.`;
  }
  const expectation = answerDecisionExpectation(decision.code);
  if (expectation === null) {
    throw new Error(`Unsupported answer decision code: ${decision.code}`);
  }
  const target = humanizeDecisionTarget(expectation.target);
  const conclusion =
    expectation.relation === "preferred"
      ? `${capitalizeSentence(target)} is the recorded preferred route.`
      : expectation.relation === "eligible"
        ? `The battery is recorded as eligible for ${target}.`
        : expectation.relation === "applicable"
          ? `${capitalizeSentence(target)} is recorded as applicable.`
          : `${capitalizeSentence(target)} is recorded as permitted.`;
  return `${conclusion} The recorded decision code is ${decision.code}.`;
}

function humanizeDecisionTarget(target: string): string {
  return target
    .replace(/^continued-compatible-ev-use$/u, "continued compatible EV use")
    .replace(/^battery-passport-requirement$/u, "the battery passport requirement")
    .replaceAll("-", " ");
}

function capitalizeSentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function contradictsRecordedDecision(text: string, decisionCode: string): boolean {
  const code = normalizeDecisionProse(decisionCode);
  if (code.length === 0) return false;
  for (const rawSentence of text.split(/[.!?;\n]+/u)) {
    const sentence = normalizeDecisionProse(rawSentence);
    const codeIndex = sentence.indexOf(code);
    if (codeIndex < 0) continue;
    const before = sentence.slice(0, codeIndex).trim();
    const after = sentence.slice(codeIndex + code.length).trim();
    if (
      /^(?:(?:is|was|remains)\s+)?(?:incorrect|invalid|wrong|false|inapplicable)\b/u.test(after)
    ) {
      return true;
    }
    if (repudiatesExactDecisionCode(before, after)) return true;
    if (/(?:^|\s)(?:(?:is|was|were|does|do|can)\s+not|cannot|never|not)$/u.test(before)) {
      return true;
    }
    if (
      /^(?:(?:[a-z0-9]+)\s+){0,4}(?:(?:does|do|is|was|were|can)\s+not|cannot|never)\s+(?:apply|applies|applicable|valid|supported|recorded|correct|(?:the\s+)?(?:recorded\s+)?(?:decision|outcome|code))\b/u.test(
        after,
      )
    ) {
      return true;
    }
  }
  return false;
}

function repudiatesExactDecisionCode(before: string, after: string): boolean {
  const directPrefix =
    /^(?:(?:is\s+)?the\s+(?:recorded\s+)?(?:decision|outcome|code)\s+)?(?:(?:and|but|yet|however)\s+)?(?:(?:it|this|that|the\s+(?:decision|outcome|code))\s+)?/u;
  const direct = after.slice(after.match(directPrefix)?.[0].length ?? 0);
  const directRepudiation = direct.match(
    /^(?:(?:should|must|can|may|will)\s+not\s+(?:be\s+)?(?:followed|acted\s+on|applied|implemented|used|executed|relied\s+on|accepted|adopted|observed)|(?:is|was|remains)\s+not\s+to\s+be\s+(?:followed|acted\s+on|applied|implemented|used|executed|relied\s+on|accepted|adopted|observed)|(?:should|must|can|may|will)\s+be\s+(?:ignored|disregarded|rejected|overridden|dismissed))\b(.*)$/u,
  );
  if (
    directRepudiation !== null &&
    !isQualifiedDecisionBoundaryCaveat(directRepudiation[1] ?? "")
  ) {
    return true;
  }

  if (
    /(?:^|\s)(?:(?:do|does|should|must|can|may|will)\s+not\s+)?(?:follow|act\s+on|apply|implement|use|execute|rely\s+on|accept|adopt|observe|ignore|disregard|reject|override|dismiss)\s*$/u.test(
      before,
    )
  ) {
    return true;
  }

  const gerundTargetsCode =
    /(?:^|\s)(?:following|acting\s+on|applying|implementing|using|executing|relying\s+on|accepting|adopting|observing)\s*$/u.test(
      before,
    );
  if (!gerundTargetsCode) return false;
  const gerundRepudiation = after.match(
    /^(?:(?:is|was|remains|would\s+be|should\s+be|must\s+be)\s+(?:(?:not|never)\s+(?:appropriate|recommended|permitted|allowed|authorized|valid|advisable|acceptable)|prohibited|forbidden|invalid|inappropriate|inadvisable|unacceptable))\b(.*)$/u,
  );
  return (
    gerundRepudiation !== null && !isQualifiedDecisionBoundaryCaveat(gerundRepudiation[1] ?? "")
  );
}

function isQualifiedDecisionBoundaryCaveat(tail: string): boolean {
  const normalized = tail.trim();
  return (
    /^without\s+(?:(?:the|an?)\s+)?(?:(?:responsible|accountable|authorized|legal|regulatory|safety|transaction|ownership)\s+)*(?:organization|authority|actor|approval|review|decision|authorization|confirmation)\b/u.test(
      normalized,
    ) ||
    /^(?:until|unless|before|pending)\b/u.test(normalized) ||
    /^as\s+(?:legal|regulatory|safety|transaction|ownership)\b/u.test(normalized)
  );
}

function containsExactDecisionCode(text: string, decisionCode: string): boolean {
  const escaped = decisionCode.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`, "iu").test(text);
}

function containsAlternateDecisionCode(text: string, expectedCode: string): boolean {
  const normalizedText = ` ${normalizeDecisionProse(text)} `;
  if (
    expectedCode === "external-decision-required" &&
    containsAffirmativeAutomaticApproval(normalizedText)
  ) {
    return true;
  }
  const expectedTokens = expectedCode.toLowerCase().split("-");
  const opposites: Readonly<Record<string, readonly string[]>> = {
    sufficient: ["insufficient"],
    insufficient: ["sufficient"],
    eligible: ["ineligible"],
    ineligible: ["eligible"],
    permitted: ["prohibited"],
    prohibited: ["permitted"],
    accepted: ["rejected"],
    rejected: ["accepted", "approved"],
    approved: ["rejected"],
    available: ["unavailable"],
    unavailable: ["available"],
    pass: ["fail"],
    fail: ["pass"],
  };
  for (const [index, token] of expectedTokens.entries()) {
    for (const opposite of opposites[token] ?? []) {
      const alternate = [...expectedTokens];
      alternate[index] = opposite;
      if (normalizedText.includes(` ${alternate.join(" ")} `)) return true;
    }
  }
  for (const match of text.matchAll(
    /\b(?:(?:recorded\s+)?decision\s+code(?:\s+is)?|the\s+code)\s+['"]?([a-z0-9]+(?:-[a-z0-9]+)+)\b/giu,
  )) {
    const code = match[1];
    if (code !== undefined && code.toLowerCase() !== expectedCode.toLowerCase()) return true;
  }
  return false;
}

type DecisionRelation = "preference" | "authorization" | "applicability" | "action";
type DecisionAssertion = Readonly<{
  polarity: "affirmative" | "negative";
  relation: DecisionRelation;
  target: string;
  source: string;
}>;
type AnswerDecisionExpectation = Readonly<{
  relation: "preferred" | "eligible" | "permitted" | "applicable";
  target: string;
}>;

function contradictsRecordedDecisionSemantics(
  text: string,
  decision: NonNullable<AssistantSupport["recorded_decision"]>,
): boolean {
  const prose = removeExactDecisionCode(text, decision.code);
  const assertions = decisionAssertions(prose);
  if (decision.outcome !== "answer") {
    if (contradictsNonAnswerDecisionSemantics(prose, decision)) return true;
    return assertions.some(
      ({ polarity, relation, target, source }) =>
        polarity === "affirmative" &&
        isOperativeDecisionAssertion(relation, target, source) &&
        !isClearlyNonOperativeAssertion(relation, source),
    );
  }

  const expectation = answerDecisionExpectation(decision.code);
  if (expectation === null) return false;
  return assertions.some((assertion) => {
    const targetsExpectedAction = decisionTargetMatches(assertion.target, expectation.target);
    if (assertion.polarity === "negative") return targetsExpectedAction;
    if (expectation.relation === "applicable") {
      return assertion.relation === "applicability" && !targetsExpectedAction;
    }
    if (
      expectation.relation === "preferred" &&
      assertion.relation !== "preference" &&
      assertion.relation !== "action"
    ) {
      return false;
    }
    return !targetsExpectedAction;
  });
}

function answerDecisionExpectation(decisionCode: string): AnswerDecisionExpectation | null {
  const normalized = decisionCode.toLowerCase();
  for (const suffix of ["preferred", "recommended", "selected"] as const) {
    if (normalized.endsWith(`-${suffix}`)) {
      const target = normalized.slice(0, -(suffix.length + 1));
      return target.length === 0 ? null : { relation: "preferred", target };
    }
  }
  if (normalized.startsWith("eligible-for-")) {
    const target = normalized.slice("eligible-for-".length);
    return target.length === 0 ? null : { relation: "eligible", target };
  }
  for (const suffix of ["permitted", "allowed", "authorized"] as const) {
    if (normalized.endsWith(`-${suffix}`)) {
      const target = normalized.slice(0, -(suffix.length + 1));
      return target.length === 0 ? null : { relation: "permitted", target };
    }
  }
  if (normalized.endsWith("-applicable")) {
    const target = normalized.slice(0, -"-applicable".length);
    return target.length === 0 ? null : { relation: "applicable", target };
  }
  return null;
}

function decisionAssertions(text: string): readonly DecisionAssertion[] {
  const assertions: DecisionAssertion[] = [];
  const clauses = text
    .split(/[.!?;\n]+/u)
    .flatMap((sentence) =>
      normalizeDecisionProse(sentence).split(
        /\s+(?:and|but|while|whereas|although|however|yet)\s+/u,
      ),
    )
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  for (const clause of clauses) {
    const negativeApplicability =
      clause.match(/^(?:the\s+)?(.+?)\s+(?:does|do)\s+not\s+apply\b/u) ??
      clause.match(/^(?:the\s+)?(.+?)\s+(?:is|was|remains)\s+not\s+applicable\b/u);
    if (negativeApplicability?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "applicability",
        target: negativeApplicability[1],
        source: clause,
      });
      continue;
    }
    const affirmativeApplicability =
      clause.match(/^(?:the\s+)?(.+?)\s+(?:does|do)\s+apply\b/u) ??
      clause.match(/^(?:the\s+)?(.+?)\s+(?:is|was|remains)\s+applicable\b/u);
    if (affirmativeApplicability?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "applicability",
        target: affirmativeApplicability[1],
        source: clause,
      });
      continue;
    }
    const negativePassiveAction = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:is|was|should be|must be|can be|may be|will be)\s+(?:not|never)\s+(used|reused|resold|sold|recycled|repurposed|recovered|listed|purchased|transferred|funded|settled)(?:\s+for\s+(.+))?$/u,
    );
    if (negativePassiveAction?.[1] !== undefined && negativePassiveAction[2] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "action",
        target: `${negativePassiveAction[2]} ${negativePassiveAction[1]} ${negativePassiveAction[3] ?? ""}`,
        source: clause,
      });
      continue;
    }
    const negativeModalAction = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:should|must|can|may|will)\s+not\s+(use|reuse|resell|sell|recycle|repurpose|recover|enter|perform|execute|proceed with|list|purchase|transfer|fund|settle)\s+(.+)$/u,
    );
    if (
      negativeModalAction?.[1] !== undefined &&
      negativeModalAction[2] !== undefined &&
      negativeModalAction[3] !== undefined
    ) {
      assertions.push({
        polarity: "negative",
        relation: "action",
        target: `${negativeModalAction[2]} ${negativeModalAction[1]} ${negativeModalAction[3]}`,
        source: clause,
      });
      continue;
    }
    const negativeActive = clause.match(
      /^(?:please\s+)?(?:avoid|reject|exclude|forbid|prohibit|rule out)\s+(.+)$/u,
    );
    if (negativeActive?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "action",
        target: negativeActive[1],
        source: clause,
      });
      continue;
    }
    const negatedVerb = clause.match(
      /^(?:(?:the\s+)?(?:system|user|organization|operator|buyer|seller|you|we|i)\s+)?(?:do|does|should|must|can|may|will)\s+not\s+(use|reuse|resell|sell|recycle|repurpose|recover|enter|perform|execute|proceed with|go ahead with|move forward with|list|purchase|transfer|fund|settle|prefer|recommend|select|choose|permit|allow|authorize|approve)\s+(.+)$/u,
    );
    if (negatedVerb?.[1] !== undefined && negatedVerb[2] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "action",
        target: `${negatedVerb[1]} ${negatedVerb[2]}`,
        source: clause,
      });
      continue;
    }
    const negativeProceed = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:should|must|can|may|will)\s+not\s+(?:proceed|go ahead|move forward)$/u,
    );
    if (negativeProceed?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "action",
        target: negativeProceed[1],
        source: clause,
      });
      continue;
    }
    const noAuthorization = clause.match(
      /^no\s+(.+?)\s+(?:is|was|remains|has been|should be|must be|can be|may be)\s+(?:preferred|recommended|selected|chosen|permitted|allowed|authorized|approved|eligible)\b/u,
    );
    if (noAuthorization?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "authorization",
        target: noAuthorization[1],
        source: clause,
      });
      continue;
    }
    const negativeEligibleFor = clause.match(
      /^(?:the\s+)?(?:.+?)\s+(?:is|was|remains)\s+(?:not|never)\s+eligible\s+for\s+(.+)$/u,
    );
    if (negativeEligibleFor?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "authorization",
        target: negativeEligibleFor[1],
        source: clause,
      });
      continue;
    }
    const negativeSuitableFor = clause.match(
      /^(?:the\s+)?(?:.+?)\s+(?:is|was|remains)\s+(?:not|never|un)suitable\s+for\s+(.+)$/u,
    );
    if (negativeSuitableFor?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "authorization",
        target: negativeSuitableFor[1],
        source: clause,
      });
      continue;
    }
    const negativePassive = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:is|was|remains|should be|must be)\s+(?:(?:not|never)\s+(?:preferred|recommended|selected|chosen|advisable|appropriate|permitted|allowed|authorized|approved|eligible)|prohibited|forbidden|rejected|excluded|ineligible|unavailable|unsuitable)\b/u,
    );
    if (negativePassive?.[1] !== undefined) {
      assertions.push({
        polarity: "negative",
        relation: "authorization",
        target: negativePassive[1],
        source: clause,
      });
      continue;
    }

    const preferenceActive = clause.match(
      /^(?:(?:the\s+)?(?:system|assessment|record|records|we|i)\s+)?(?:prefer|recommend|select|choose)\s+(.+)$/u,
    );
    if (preferenceActive?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "preference",
        target: preferenceActive[1],
        source: clause,
      });
      continue;
    }
    const namedPreference = clause.match(
      /^(?:the\s+)?(?:preferred|recommended|selected|chosen)\s+(?:route|option|alternative|choice)\s+(?:is|remains)\s+(.+)$/u,
    );
    if (namedPreference?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "preference",
        target: namedPreference[1],
        source: clause,
      });
      continue;
    }
    const preferencePassive = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:is|was|remains|should be|must be|has been)\s+(?:the\s+)?(?:preferred|recommended|selected|chosen|advisable|appropriate)\b/u,
    );
    if (preferencePassive?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "preference",
        target: preferencePassive[1],
        source: clause,
      });
      continue;
    }
    const comparativePreference = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:is|was|remains)\s+(?:the\s+)?(?:best|better|superior)(?:\s+(?:route|option|alternative|choice))?(?:\s+than|\s+to|$)/u,
    );
    if (comparativePreference?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "preference",
        target: comparativePreference[1],
        source: clause,
      });
      continue;
    }
    const rankedFirst = clause.match(/^(?:the\s+)?(.+?)\s+(?:ranks|ranked)\s+first\b/u);
    if (rankedFirst?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "preference",
        target: rankedFirst[1],
        source: clause,
      });
      continue;
    }

    const authorizationActive = clause.match(
      /^(?:(?:the\s+)?(?:system|assessment|record|records|we|i)\s+)?(?:permit|allow|authorize|approve)\s+(.+)$/u,
    );
    if (authorizationActive?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "authorization",
        target: authorizationActive[1],
        source: clause,
      });
      continue;
    }
    const eligibleFor = clause.match(
      /^(?:the\s+)?(?:.+?)\s+(?:is|was|remains|has been|should be|must be)\s+eligible\s+for\s+(.+)$/u,
    );
    if (eligibleFor?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "authorization",
        target: eligibleFor[1],
        source: clause,
      });
      continue;
    }
    const suitableFor = clause.match(
      /^(?:the\s+)?(?:.+?)\s+(?:is|was|remains|has been|should be|must be)\s+suitable\s+for\s+(.+)$/u,
    );
    if (suitableFor?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "authorization",
        target: suitableFor[1],
        source: clause,
      });
      continue;
    }
    const authorizationPassive = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:is|was|remains|has been|should be|must be)\s+(?:permitted|allowed|authorized|approved|eligible)\b/u,
    );
    if (authorizationPassive?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "authorization",
        target: authorizationPassive[1],
        source: clause,
      });
      continue;
    }
    const modalAction = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:should|must|can|may|will)\s+(use|reuse|resell|sell|recycle|repurpose|recover|enter|perform|execute|proceed with|go ahead with|move forward with|list|purchase|transfer|fund|settle)\s+(.+)$/u,
    );
    if (
      modalAction?.[1] !== undefined &&
      modalAction[2] !== undefined &&
      modalAction[3] !== undefined
    ) {
      assertions.push({
        polarity: "affirmative",
        relation: "action",
        target: `${modalAction[2]} ${modalAction[1]} ${modalAction[3]}`,
        source: clause,
      });
      continue;
    }
    const affirmativeProceed = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:should|must|can|may|will)\s+(?:proceed|go ahead|move forward)$/u,
    );
    if (affirmativeProceed?.[1] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "action",
        target: affirmativeProceed[1],
        source: clause,
      });
      continue;
    }
    const passiveAction = clause.match(
      /^(?:the\s+)?(.+?)\s+(?:is|was|should be|must be|can be|may be|will be)\s+(used|reused|resold|sold|recycled|repurposed|recovered|listed|purchased|transferred|funded|settled)(?:\s+for\s+(.+))?$/u,
    );
    if (passiveAction?.[1] !== undefined && passiveAction[2] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "action",
        target: `${passiveAction[2]} ${passiveAction[1]} ${passiveAction[3] ?? ""}`,
        source: clause,
      });
      continue;
    }
    const subjectAction = clause.match(
      /^(?:(?:the\s+)?(?:system|user|organization|operator|buyer|seller|you|we|i)\s+)?(?:should|must|can|may|will)\s+(use|reuse|resell|sell|recycle|repurpose|recover|enter|perform|execute|proceed with|go ahead with|move forward with|list|purchase|transfer|fund|settle)\s+(.+)$/u,
    );
    if (subjectAction?.[1] !== undefined && subjectAction[2] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "action",
        target: `${subjectAction[1]} ${subjectAction[2]}`,
        source: clause,
      });
      continue;
    }
    const gerundAction = clause.match(
      /^(using|reusing|reselling|selling|recycling|repurposing|recovering|listing|purchasing|transferring|funding|settling)\s+(.+?)\s+(?:is|remains|would be)\s+(?:appropriate|recommended|preferred|permitted|allowed|authorized|approved)\b/u,
    );
    if (gerundAction?.[1] !== undefined && gerundAction[2] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "action",
        target: `${gerundAction[1]} ${gerundAction[2]}`,
        source: clause,
      });
      continue;
    }
    const actionDirective = clause.match(
      /^(?:please\s+)?(use|reuse|resell|sell|recycle|repurpose|recover|enter|perform|execute|proceed with|go ahead with|move forward with|list|purchase|transfer|fund|settle)\s+(.+)$/u,
    );
    if (actionDirective?.[1] !== undefined && actionDirective[2] !== undefined) {
      assertions.push({
        polarity: "affirmative",
        relation: "action",
        target: `${actionDirective[1]} ${actionDirective[2]}`,
        source: clause,
      });
    }
  }
  return assertions;
}

function contradictsNonAnswerDecisionSemantics(
  text: string,
  decision: NonNullable<AssistantSupport["recorded_decision"]>,
): boolean {
  const normalized = normalizeDecisionProse(text);
  const requiresExternalDecision =
    decision.outcome === "requires_external_decision" ||
    decision.reason_codes.includes("external-decision-required");
  if (
    requiresExternalDecision &&
    (/(?:^|\b)no\s+(?:accountable\s+)?external\s+(?:review|decision)\s+(?:is\s+)?(?:needed|required|necessary)\b/u.test(
      normalized,
    ) ||
      /\b(?:accountable\s+)?external\s+(?:review|decision)\s+(?:is|was|remains)\s+not\s+(?:needed|required|necessary)\b/u.test(
        normalized,
      ))
  ) {
    return true;
  }
  const lacksEvidence =
    decision.outcome === "abstain" &&
    (decision.code === "insufficient-evidence" ||
      decision.reason_codes.includes("missing-evidence"));
  return (
    lacksEvidence &&
    (/\b(?:the\s+|all\s+|required\s+)?evidence\s+(?:is|was|remains)\s+(?:sufficient|complete|available)\b/u.test(
      normalized,
    ) ||
      /\bno\s+(?:required\s+)?evidence\s+(?:is|was|remains)\s+missing\b/u.test(normalized))
  );
}

function containsUnboundOperativeDecision(text: string): boolean {
  const normalized = normalizeDecisionProse(text);
  const lowered = text.toLowerCase();
  if (
    /\b(?:recorded\s+)?decision\s+code\b.{0,40}\b[a-z0-9]+(?:-[a-z0-9]+)+\b/u.test(lowered) ||
    /\b(?:eligible-for-[a-z0-9]+(?:-[a-z0-9]+)*|[a-z0-9]+(?:-[a-z0-9]+)*-(?:preferred|recommended|selected|permitted|allowed|authorized|applicable))\b/u.test(
      lowered,
    ) ||
    /\b(?:eligibility|permission|authorization|preference|recommendation|selection)\s+(?:of|for)\s+.{1,80}\s+(?:is|was|remains|has\s+been)\s+(?:recorded|established|confirmed|supported|approved)\b/u.test(
      normalized,
    ) ||
    /\b(?:the\s+)?(?:battery|pack|module|it|this\s+(?:battery|pack|module))\s+(?:qualifies|is\s+fit)\s+for\s+(?:resale|reuse|recycling|repurposing|continued\s+(?:compatible\s+)?ev\s+use)\b/u.test(
      normalized,
    ) ||
    /\b(?:green\s+light|go\s+ahead)\s+(?:for|to)\s+(?:resale|reuse|recycling|repurposing|listing|continued\s+(?:compatible\s+)?ev\s+use)\b/u.test(
      normalized,
    ) ||
    /\b(?:resale|reuse|recycling|repurposing|continued\s+(?:compatible\s+)?ev\s+use)\s+(?:is|remains)\s+the\s+way\s+forward\b/u.test(
      normalized,
    ) ||
    /\b(?:resale|reuse|recycling|repurposing|listing|continued\s+(?:compatible\s+)?ev\s+use)\s+has\s+(?:recorded|confirmed|established)\s+(?:eligibility|permission|authorization|approval|preference)\b/u.test(
      normalized,
    ) ||
    /\b(?:resale|reuse|recycling|repurposing|listing|continued\s+(?:compatible\s+)?ev\s+use)\s+(?:receives|gets|has)\s+the\s+(?:green\s+light|go\s+ahead)\b/u.test(
      normalized,
    ) ||
    /\b(?:the\s+)?(?:battery|pack|module|it|this\s+(?:battery|pack|module))\s+can\s+go\s+to\s+(?:resale|reuse|recycling|repurposing)\b/u.test(
      normalized,
    ) ||
    /\bproceeding(?:\s+with\s+.{1,80})?\s+(?:is|remains)\s+warranted\b/u.test(normalized)
  ) {
    return true;
  }
  return decisionAssertions(text).some(({ relation, target, source }) => {
    if (isClearlyNonOperativeAssertion(relation, source)) return false;
    if (!isOperativeDecisionAssertion(relation, target, source)) return false;
    if (relation !== "action") return true;
    const normalized = normalizeDecisionProse(source);
    return (
      /\b(?:should|must|can|may|will)\b/u.test(normalized) ||
      /\b(?:appropriate|recommended|preferred|permitted|allowed|authorized|approved)\b/u.test(
        normalized,
      ) ||
      /^(?:please\s+)?(?:use|reuse|resell|sell|recycle|repurpose|recover|enter|perform|execute|proceed|list|purchase|transfer|fund|settle)\b/u.test(
        normalized,
      )
    );
  });
}

function removeExactDecisionCode(text: string, decisionCode: string): string {
  const escaped = decisionCode.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return text.replace(new RegExp(escaped, "giu"), "recorded-code-token");
}

function decisionTargetMatches(actual: string, expected: string): boolean {
  const actualTokens = new Set(decisionTargetTokens(actual));
  const expectedTokens = decisionTargetTokens(expected);
  return expectedTokens.length > 0 && expectedTokens.every((token) => actualTokens.has(token));
}

function decisionTargetTokens(value: string): string[] {
  return normalizeDecisionProse(value)
    .replace(/\bcontinued automotive use\b/gu, "continued compatible ev use")
    .replace(/\bcontinued ev use\b/gu, "continued compatible ev use")
    .replace(/\belectric vehicle\b/gu, "ev")
    .replace(/\bstationary energy storage\b/gu, "stationary storage repurposing")
    .replace(/\b(?:recover|recovered|recovering)\b/gu, "recovery")
    .replace(/\b(?:resell|resold|reselling|sell|sold|selling)\b/gu, "resale")
    .replace(/\b(?:recycle|recycled|recycling)\b/gu, "recycling")
    .replace(/\b(?:repurpose|repurposed|repurposing)\b/gu, "repurposing")
    .replace(/\b(?:use|used|using)\b/gu, "use")
    .split(" ")
    .filter(
      (token) =>
        token.length > 0 &&
        ![
          "a",
          "an",
          "the",
          "this",
          "that",
          "route",
          "option",
          "alternative",
          "choice",
          "battery",
          "for",
          "to",
          "with",
          "under",
          "enter",
          "perform",
          "execute",
          "proceed",
          "list",
        ].includes(token),
    );
}

function isOperativeDecisionAssertion(
  relation: DecisionRelation,
  target: string,
  source = "",
): boolean {
  if (
    relation === "authorization" &&
    /\bunavailable\b/u.test(source) &&
    !/\b(?:resale|listing|reuse|recycling|repurposing|route|option|transaction|recovery|lifecycle\s+action)\b/u.test(
      target,
    )
  ) {
    return false;
  }
  return relation !== "action" || !/^(?:use|reuse)\s+of\b/u.test(target.trim());
}

function isClearlyNonOperative(text: string): boolean {
  const normalized = normalizeDecisionProse(text);
  return (
    /\b(?:could|may) be considered\b/u.test(normalized) ||
    /\b(?:possible|potential|candidate)\s+(?:route|option|alternative)\b/u.test(normalized) ||
    /\b(?:for consideration|pending (?:review|approval|a decision))\b/u.test(normalized)
  );
}

function isClearlyNonOperativeAssertion(relation: DecisionRelation, source: string): boolean {
  return relation !== "action" && isClearlyNonOperative(source);
}

function containsAffirmativeAutomaticApproval(normalizedText: string): boolean {
  const pattern =
    /\b(?:automatic approval|automatically approve(?:d|s)?|approved automatically|approves automatically)\b/gu;
  for (const match of normalizedText.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    const before = normalizedText.slice(Math.max(0, index - 35), index).trimEnd();
    if (/\b(?:no|not|never|without|cannot|does not|is not|will not)$/u.test(before)) continue;
    const after = normalizedText.slice(index + match[0].length).trimStart();
    if (/^(?:is|was|remains)\s+(?:not|prohibited|forbidden|blocked)\b/u.test(after)) continue;
    return true;
  }
  return false;
}

function normalizeDecisionProse(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bcan(?:'|\u2019)?t\b/gu, "can not")
    .replace(/\bwon(?:'|\u2019)?t\b/gu, "will not")
    .replace(/\bcannot\b/gu, "can not")
    .replace(/\b(does|do|is|are|was|were|could|should|must|would|may)n(?:'|\u2019)?t\b/gu, "$1 not")
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
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
