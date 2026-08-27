import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import OpenAI from "openai";
import { z } from "zod";

import type { AssistantModelProvider, ModelInput } from "../assistant/model.js";
import type { ModelResult } from "../assistant/types.js";
import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";

const digest = z.string().regex(/^0x[0-9a-f]{64}$/u);
const sourceCommit = z.string().regex(/^[0-9a-f]{40}$/u);
const eventBase = z.object({
  schema: z.literal("EVLLM_MODEL_TRANSPORT_ATTEMPT_EVENT_V1"),
  event_id: z.string().uuid(),
  previous_event_sha256: digest.nullable(),
  event_sha256: digest,
  evaluation_set_id: z.string().min(1),
  source_commit: sourceCommit,
  freeze_sha256: digest,
  corpus_file_sha256: digest,
  logical_corpus_sha256: digest,
  observation_id: z.string().min(1),
  case_id: z.string().min(1),
  configuration_id: z.string().min(1),
  repetition: z.number().int().positive(),
  attempt_sequence: z.number().int().positive(),
  cycle_id: z.string().uuid(),
  cycle_attempt: z.number().int().min(1).max(3),
  recorded_at: z.string().datetime(),
});

export const transportAttemptStartedSchema = eventBase
  .extend({
    event_type: z.literal("started"),
    provider: z.string().min(1),
    model: z.string().min(1),
    model_input_sha256: digest,
    presented_support_ids: z.array(z.string()),
    retry: z.boolean(),
  })
  .strict();

const terminalBase = eventBase.extend({
  started_event_id: z.string().uuid(),
  duration_ms: z.number().int().nonnegative(),
});

export const transportAttemptSucceededSchema = terminalBase
  .extend({
    event_type: z.literal("succeeded"),
    provider: z.string().min(1),
    model: z.string().min(1),
    response_id: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const transportAttemptFailedSchema = terminalBase
  .extend({
    event_type: z.literal("failed"),
    transient: z.boolean(),
    error_category: z.enum([
      "http-408",
      "http-409",
      "http-429",
      "http-5xx",
      "connection-reset",
      "timeout",
      "dns-temporary",
      "connection-refused",
      "connection-error",
      "provider-error",
    ]),
  })
  .strict();

export const transportAttemptInterruptedSchema = terminalBase
  .extend({
    event_type: z.literal("interrupted"),
    reason: z.literal("process-interruption-before-terminal-event"),
  })
  .strict();

export const transportAttemptEventSchema = z.discriminatedUnion("event_type", [
  transportAttemptStartedSchema,
  transportAttemptSucceededSchema,
  transportAttemptFailedSchema,
  transportAttemptInterruptedSchema,
]);
export type TransportAttemptEvent = z.infer<typeof transportAttemptEventSchema>;
export type TransportAttemptStarted = z.infer<typeof transportAttemptStartedSchema>;

export interface TransportJournalBinding {
  readonly evaluation_set_id: string;
  readonly source_commit: string;
  readonly freeze_sha256: string;
  readonly corpus_file_sha256: string;
  readonly logical_corpus_sha256: string;
}

export interface TransportAttemptIdentity {
  readonly observation_id: string;
  readonly case_id: string;
  readonly configuration_id: string;
  readonly repetition: number;
  readonly provider: string;
  readonly model: string;
}

export interface TransportJournalObservation {
  readonly observation_id: string;
  readonly model_invoked: boolean;
  readonly transport_attempts: number;
  readonly response_id: string | null;
  readonly provider: string;
  readonly model: string;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly model_input_sha256: string | null;
  readonly presented_support_ids: readonly string[];
}

export interface TransportAttemptSummary {
  readonly observations_attempted: number;
  readonly transport_attempts: number;
  readonly retry_attempts: number;
  readonly successful_invocations: number;
  readonly failed_attempts: number;
  readonly interrupted_attempts: number;
  readonly open_attempts: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/** Append-only, hash-chained provider-attempt journal. It never stores prompt or support content. */
export class TransportAttemptJournal {
  readonly #path: string;
  readonly #binding: TransportJournalBinding;
  readonly #events: TransportAttemptEvent[] = [];
  #appendTail: Promise<void> = Promise.resolve();

  public constructor(path: string, binding: TransportJournalBinding) {
    this.#path = resolve(path);
    this.#binding = transportJournalBindingSchema.parse(binding);
  }

  public async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    let content = "";
    try {
      content = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    let previousDigest: string | null = null;
    for (const [index, line] of content.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      let event: TransportAttemptEvent;
      try {
        event = transportAttemptEventSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid transport-attempt journal JSONL at line ${String(index + 1)}`, {
          cause: error,
        });
      }
      if (!bindingMatches(event, this.#binding)) {
        throw new Error(`Transport-attempt journal binding mismatch at line ${String(index + 1)}`);
      }
      if (event.previous_event_sha256 !== previousDigest) {
        throw new Error(`Broken transport-attempt journal chain at line ${String(index + 1)}`);
      }
      const expectedDigest = eventDigest(event);
      if (event.event_sha256 !== expectedDigest) {
        throw new Error(`Invalid transport-attempt event digest at line ${String(index + 1)}`);
      }
      this.#events.push(event);
      previousDigest = event.event_sha256;
    }
    this.assertInternalConsistency();
  }

  public events(): readonly TransportAttemptEvent[] {
    return structuredClone(this.#events);
  }

  public attemptsFor(observationId: string): number {
    return this.startsFor(observationId).length;
  }

  public remainingAttemptBudget(observationId: string, maximum = 3): number {
    const starts = this.startsFor(observationId);
    const terminals = this.terminalsFor(observationId);
    if (terminals.some((event) => event.event_type === "succeeded")) return 0;
    if (terminals.some((event) => event.event_type === "interrupted")) return 0;
    if (terminals.some((event) => event.event_type === "failed" && !event.transient)) return 0;
    return Math.max(0, maximum - starts.length);
  }

  public async beginAttempt(
    identity: TransportAttemptIdentity,
    input: ModelInput,
    cycleId: string,
    cycleAttempt: number,
  ): Promise<TransportAttemptStarted> {
    return this.enqueue(async () => {
      const event = this.makeEvent({
        event_type: "started",
        event_id: randomUUID(),
        ...identity,
        attempt_sequence: this.startsFor(identity.observation_id).length + 1,
        cycle_id: cycleId,
        cycle_attempt: cycleAttempt,
        recorded_at: new Date().toISOString(),
        model_input_sha256: sha256Canonical(input),
        presented_support_ids: input.supports.map(({ support_id: supportId }) => supportId),
        retry: this.startsFor(identity.observation_id).length > 0,
      });
      const parsed = transportAttemptStartedSchema.parse(event);
      await this.appendEvent(parsed);
      return parsed;
    });
  }

  public async completeSuccess(
    started: TransportAttemptStarted,
    result: ModelResult,
    durationMs: number,
  ): Promise<void> {
    await this.enqueue(async () => {
      await this.appendEvent(
        transportAttemptSucceededSchema.parse(
          this.makeEvent({
            ...attemptReference(started),
            event_type: "succeeded",
            event_id: randomUUID(),
            started_event_id: started.event_id,
            recorded_at: new Date().toISOString(),
            duration_ms: durationMs,
            provider: result.provider,
            model: result.model,
            response_id: result.responseId,
            input_tokens: result.inputTokens,
            output_tokens: result.outputTokens,
          }),
        ),
      );
    });
  }

  public async completeFailure(
    started: TransportAttemptStarted,
    error: unknown,
    durationMs: number,
  ): Promise<void> {
    await this.enqueue(async () => {
      await this.appendEvent(
        transportAttemptFailedSchema.parse(
          this.makeEvent({
            ...attemptReference(started),
            event_type: "failed",
            event_id: randomUUID(),
            started_event_id: started.event_id,
            recorded_at: new Date().toISOString(),
            duration_ms: durationMs,
            transient: isTransientTransportError(error),
            error_category: transportErrorCategory(error),
          }),
        ),
      );
    });
  }

  /** Marks starts left open by a terminated process, then returns their count. */
  public async markOpenAttemptsInterrupted(): Promise<number> {
    const open = this.openStarts();
    for (const started of open) {
      await this.enqueue(async () => {
        await this.appendEvent(
          transportAttemptInterruptedSchema.parse(
            this.makeEvent({
              ...attemptReference(started),
              event_type: "interrupted",
              event_id: randomUUID(),
              started_event_id: started.event_id,
              recorded_at: new Date().toISOString(),
              duration_ms: Math.max(0, Date.now() - Date.parse(started.recorded_at)),
              reason: "process-interruption-before-terminal-event",
            }),
          ),
        );
      });
    }
    return open.length;
  }

  public assertCanResumeObservation(observationId: string, maximum = 3): void {
    const starts = this.startsFor(observationId);
    const terminals = this.terminalsFor(observationId);
    if (terminals.some((event) => event.event_type === "succeeded")) {
      throw new Error(
        `Cannot resume ${observationId}: a successful invocation lacks an observation`,
      );
    }
    if (terminals.some((event) => event.event_type === "interrupted")) {
      throw new Error(`Cannot resume ${observationId}: an interrupted attempt has unknown outcome`);
    }
    if (terminals.some((event) => event.event_type === "failed" && !event.transient)) {
      throw new Error(`Cannot resume ${observationId}: its provider failure was not transient`);
    }
    if (starts.length >= maximum) {
      throw new Error(`Cannot resume ${observationId}: its transport-attempt budget is exhausted`);
    }
  }

  public assertReconciled(
    observations: readonly TransportJournalObservation[],
    options: { readonly allow_unobserved_attempts?: boolean } = {},
  ): void {
    const byId = new Map(observations.map((item) => [item.observation_id, item]));
    for (const observation of observations) {
      const starts = this.startsFor(observation.observation_id);
      const successes = this.terminalsFor(observation.observation_id).filter(
        (event) => event.event_type === "succeeded",
      );
      if (!observation.model_invoked) {
        if (starts.length !== 0)
          throw new Error(
            `Non-model observation ${observation.observation_id} has journal attempts`,
          );
        continue;
      }
      if (starts.length !== observation.transport_attempts || successes.length !== 1) {
        throw new Error(
          `Observation ${observation.observation_id} does not reconcile with its journal`,
        );
      }
      const success = successes[0]!;
      if (
        success.event_type !== "succeeded" ||
        success.provider !== observation.provider ||
        success.model !== observation.model ||
        success.response_id !== observation.response_id ||
        success.input_tokens !== observation.input_tokens ||
        success.output_tokens !== observation.output_tokens
      ) {
        throw new Error(
          `Observation ${observation.observation_id} token or response provenance differs`,
        );
      }
      const successfulStart = starts.find((item) => item.event_id === success.started_event_id)!;
      if (
        successfulStart.model_input_sha256 !== observation.model_input_sha256 ||
        JSON.stringify(successfulStart.presented_support_ids) !==
          JSON.stringify(observation.presented_support_ids)
      ) {
        throw new Error(`Observation ${observation.observation_id} input provenance differs`);
      }
    }
    for (const start of this.#events.filter(
      (event): event is TransportAttemptStarted => event.event_type === "started",
    )) {
      if (!byId.has(start.observation_id) && !options.allow_unobserved_attempts) {
        const success = this.terminalForStart(start.event_id)?.event_type === "succeeded";
        if (success)
          throw new Error(`Successful journal attempt ${start.event_id} has no stored observation`);
      }
    }
  }

  public summary(): TransportAttemptSummary {
    const starts = this.#events.filter((event) => event.event_type === "started");
    const terminals = this.#events.filter((event) => event.event_type !== "started");
    const successes = terminals.filter((event) => event.event_type === "succeeded");
    return {
      observations_attempted: new Set(starts.map((event) => event.observation_id)).size,
      transport_attempts: starts.length,
      retry_attempts: starts.length - new Set(starts.map((event) => event.observation_id)).size,
      successful_invocations: successes.length,
      failed_attempts: terminals.filter((event) => event.event_type === "failed").length,
      interrupted_attempts: terminals.filter((event) => event.event_type === "interrupted").length,
      open_attempts: this.openStarts().length,
      input_tokens: successes.reduce(
        (total, event) =>
          total + (event.event_type === "succeeded" ? (event.input_tokens ?? 0) : 0),
        0,
      ),
      output_tokens: successes.reduce(
        (total, event) =>
          total + (event.event_type === "succeeded" ? (event.output_tokens ?? 0) : 0),
        0,
      ),
    };
  }

  public async fileSha256(): Promise<string> {
    try {
      return `0x${createHash("sha256")
        .update(await readFile(this.#path))
        .digest("hex")}`;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      return `0x${createHash("sha256").update("").digest("hex")}`;
    }
  }

  private startsFor(observationId: string): TransportAttemptStarted[] {
    return this.#events.filter(
      (event): event is TransportAttemptStarted =>
        event.event_type === "started" && event.observation_id === observationId,
    );
  }

  private terminalsFor(
    observationId: string,
  ): Exclude<TransportAttemptEvent, TransportAttemptStarted>[] {
    return this.#events.filter(
      (event): event is Exclude<TransportAttemptEvent, TransportAttemptStarted> =>
        event.event_type !== "started" && event.observation_id === observationId,
    );
  }

  private terminalForStart(startedEventId: string): TransportAttemptEvent | undefined {
    return this.#events.find(
      (event) => event.event_type !== "started" && event.started_event_id === startedEventId,
    );
  }

  private openStarts(): TransportAttemptStarted[] {
    return this.#events.filter(
      (event): event is TransportAttemptStarted =>
        event.event_type === "started" && this.terminalForStart(event.event_id) === undefined,
    );
  }

  private assertInternalConsistency(): void {
    const eventIds = new Set<string>();
    const attempts = new Map<string, number>();
    const starts = new Map<string, TransportAttemptStarted>();
    const terminals = new Set<string>();
    for (const event of this.#events) {
      if (eventIds.has(event.event_id))
        throw new Error(`Duplicate transport event ${event.event_id}`);
      eventIds.add(event.event_id);
      if (event.event_type === "started") {
        if (new Set(event.presented_support_ids).size !== event.presented_support_ids.length)
          throw new Error(`Transport attempt ${event.event_id} repeats a support identifier`);
        const expected = (attempts.get(event.observation_id) ?? 0) + 1;
        if (event.attempt_sequence !== expected)
          throw new Error(`Non-sequential transport attempt for ${event.observation_id}`);
        if (event.retry !== event.attempt_sequence > 1)
          throw new Error(`Invalid retry marker for ${event.observation_id}`);
        attempts.set(event.observation_id, expected);
        starts.set(event.event_id, event);
      } else {
        const started = starts.get(event.started_event_id);
        if (started === undefined || terminals.has(event.started_event_id))
          throw new Error(`Invalid terminal transport event ${event.event_id}`);
        if (!sameAttempt(started, event))
          throw new Error(`Terminal transport event ${event.event_id} does not match its start`);
        terminals.add(event.started_event_id);
      }
    }
  }

  private makeEvent(value: Record<string, unknown>): Record<string, unknown> {
    const unsigned = {
      schema: "EVLLM_MODEL_TRANSPORT_ATTEMPT_EVENT_V1",
      previous_event_sha256: this.#events.at(-1)?.event_sha256 ?? null,
      ...this.#binding,
      ...value,
    };
    return { ...unsigned, event_sha256: sha256Canonical(unsigned) };
  }

  private async appendEvent(event: TransportAttemptEvent): Promise<void> {
    const handle = await open(this.#path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#events.push(event);
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#appendTail.then(operation);
    this.#appendTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class JournaledAssistantModel implements AssistantModelProvider {
  public lastResult: ModelResult | null = null;
  public lastInput: ModelInput | null = null;
  #cycleAttempt = 0;

  public constructor(
    private readonly delegate: AssistantModelProvider,
    private readonly journal: TransportAttemptJournal,
    private readonly identity: TransportAttemptIdentity,
    private readonly cycleId = randomUUID(),
  ) {}

  public async generate(input: ModelInput): Promise<ModelResult> {
    this.lastInput = structuredClone(input);
    this.#cycleAttempt += 1;
    const started = await this.journal.beginAttempt(
      this.identity,
      input,
      this.cycleId,
      this.#cycleAttempt,
    );
    const before = Date.now();
    try {
      const result = await this.delegate.generate(input);
      await this.journal.completeSuccess(started, result, Date.now() - before);
      this.lastResult = structuredClone(result);
      return result;
    } catch (error) {
      await this.journal.completeFailure(started, error, Date.now() - before);
      throw error;
    }
  }
}

const transportJournalBindingSchema = z
  .object({
    evaluation_set_id: z.string().min(1),
    source_commit: sourceCommit,
    freeze_sha256: digest,
    corpus_file_sha256: digest,
    logical_corpus_sha256: digest,
  })
  .strict();

function attemptReference(started: TransportAttemptStarted): Record<string, unknown> {
  return {
    observation_id: started.observation_id,
    case_id: started.case_id,
    configuration_id: started.configuration_id,
    repetition: started.repetition,
    attempt_sequence: started.attempt_sequence,
    cycle_id: started.cycle_id,
    cycle_attempt: started.cycle_attempt,
  };
}

function sameAttempt(
  start: TransportAttemptStarted,
  terminal: Exclude<TransportAttemptEvent, TransportAttemptStarted>,
): boolean {
  return (
    start.observation_id === terminal.observation_id &&
    start.case_id === terminal.case_id &&
    start.configuration_id === terminal.configuration_id &&
    start.repetition === terminal.repetition &&
    start.attempt_sequence === terminal.attempt_sequence &&
    start.cycle_id === terminal.cycle_id &&
    start.cycle_attempt === terminal.cycle_attempt
  );
}

function bindingMatches(event: TransportAttemptEvent, binding: TransportJournalBinding): boolean {
  return (
    event.evaluation_set_id === binding.evaluation_set_id &&
    event.source_commit === binding.source_commit &&
    event.freeze_sha256 === binding.freeze_sha256 &&
    event.corpus_file_sha256 === binding.corpus_file_sha256 &&
    event.logical_corpus_sha256 === binding.logical_corpus_sha256
  );
}

function eventDigest(event: TransportAttemptEvent): string {
  const unsigned = Object.fromEntries(
    Object.entries(event).filter(([key]) => key !== "event_sha256"),
  );
  return sha256Canonical(unsigned);
}

function sha256Canonical(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

export function isTransientTransportError(error: unknown): boolean {
  return transientTransportCategory(error) !== null;
}

function transportErrorCategory(
  error: unknown,
): z.infer<typeof transportAttemptFailedSchema>["error_category"] {
  return transientTransportCategory(error) ?? "provider-error";
}

function transientTransportCategory(
  error: unknown,
  visited = new Set<object>(),
): z.infer<typeof transportAttemptFailedSchema>["error_category"] | null {
  if (typeof error !== "object" || error === null || visited.has(error)) return null;
  visited.add(error);
  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    (error as { name?: unknown }).name === "APIConnectionTimeoutError"
  ) {
    return "timeout";
  }
  if (
    error instanceof OpenAI.APIConnectionError ||
    (error as { name?: unknown }).name === "APIConnectionError"
  ) {
    return nestedTransportCategory(error, visited) ?? "connection-error";
  }
  const candidate = error as { status?: unknown; code?: unknown };
  if (candidate.status === 408) return "http-408";
  if (candidate.status === 409) return "http-409";
  if (candidate.status === 429) return "http-429";
  if (typeof candidate.status === "number" && candidate.status >= 500) return "http-5xx";
  if (candidate.code === "ECONNRESET") return "connection-reset";
  if (candidate.code === "ETIMEDOUT") return "timeout";
  if (candidate.code === "EAI_AGAIN") return "dns-temporary";
  if (candidate.code === "ECONNREFUSED") return "connection-refused";
  return nestedTransportCategory(error, visited);
}

function nestedTransportCategory(
  error: object,
  visited: Set<object>,
): z.infer<typeof transportAttemptFailedSchema>["error_category"] | null {
  const cause = (error as { cause?: unknown }).cause;
  return cause === undefined ? null : transientTransportCategory(cause, visited);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
