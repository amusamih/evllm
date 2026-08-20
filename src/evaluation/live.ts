import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";

import { z } from "zod";

import type { FormalScore } from "./formal.js";

const storedObservation = z
  .object({
    schema: z.literal("EVLLM_LIVE_EVALUATION_OBSERVATION_V1"),
    observation_id: z.string().min(1),
    formal_evidence: z.boolean(),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    case_id: z.string().min(1),
    configuration_id: z.string().min(1),
    repetition: z.number().int().positive(),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    duration_ms: z.number().int().nonnegative(),
    attempts: z.number().int().min(1).max(3),
    provider: z.string().min(1),
    model: z.string().min(1),
    response_id: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    outcome: z.enum(["answer", "abstain", "requires_external_decision"]),
    summary: z.string(),
    warnings: z.array(z.string()),
    missing_requirements: z.array(z.string()),
    evidence_reason_codes: z.array(z.string()),
    validation_codes: z.array(z.string()),
    claims: z.array(
      z
        .object({
          text: z.string(),
          citation_ids: z.array(z.string()),
        })
        .strict(),
    ),
    score: z.custom<FormalScore>(),
  })
  .strict();
export type StoredObservation = z.infer<typeof storedObservation>;

export class JsonlObservationStore {
  readonly #path: string;
  readonly #records = new Map<string, StoredObservation>();

  public constructor(path: string) {
    this.#path = resolve(path);
  }

  public async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    let content = "";
    try {
      content = await readFile(this.#path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    for (const [index, line] of content.split("\n").entries()) {
      if (line.trim().length === 0) continue;
      let record: StoredObservation;
      try {
        record = storedObservation.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid observation JSONL at line ${String(index + 1)}`, { cause: error });
      }
      if (this.#records.has(record.observation_id)) {
        throw new Error(`Duplicate stored observation ${record.observation_id}`);
      }
      this.#records.set(record.observation_id, record);
    }
  }

  public get(observationId: string): StoredObservation | undefined {
    const value = this.#records.get(observationId);
    return value === undefined ? undefined : structuredClone(value);
  }

  public values(): readonly StoredObservation[] {
    return [...this.#records.values()].map((value) => structuredClone(value));
  }

  public async append(raw: StoredObservation): Promise<void> {
    const record = storedObservation.parse(raw);
    if (this.#records.has(record.observation_id)) {
      throw new Error(`Observation already stored: ${record.observation_id}`);
    }
    const handle = await open(this.#path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#records.set(record.observation_id, record);
  }
}

export async function withBoundedTransportRetries<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
): Promise<{ value: T; attempts: number }> {
  let attempts = 0;
  while (attempts < 3) {
    attempts += 1;
    try {
      return { value: await operation(), attempts };
    } catch (error) {
      if (attempts >= 3 || !isTransientTransportError(error)) throw error;
      await wait(250 * 2 ** (attempts - 1));
    }
  }
  throw new Error("Unreachable retry state");
}

function isTransientTransportError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; code?: unknown };
  if (
    typeof candidate.status === "number" &&
    (candidate.status === 408 ||
      candidate.status === 409 ||
      candidate.status === 429 ||
      candidate.status >= 500)
  ) {
    return true;
  }
  return (
    typeof candidate.code === "string" &&
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(candidate.code)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
