import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { assistantDecisionCode } from "../assistant/types.js";
import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import { isTransientTransportError } from "./transport-attempt-journal.js";

const decisionCode = assistantDecisionCode.nullable();
export const candidateSnapshot = z
  .object({
    outcome: z.enum(["answer", "abstain", "requires_external_decision"]),
    decision_code: decisionCode,
    summary: z.string(),
    warnings: z.array(z.string()),
    missing_requirements: z.array(z.string()),
    evidence_reason_codes: z.array(z.string()),
    claims: z.array(
      z
        .object({
          claim_id: z.string().regex(/^claim-[1-9][0-9]*$/u),
          text: z.string(),
          citation_ids: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();
export type CandidateSnapshot = z.infer<typeof candidateSnapshot>;

export const complementaryCandidateSnapshot = candidateSnapshot;
export type ComplementaryCandidateSnapshot = CandidateSnapshot;

const rate = z.number().min(0).max(1);
const binary = z.union([z.literal(0), z.literal(1)]);
const formalScore = z
  .object({
    required_record_coverage: rate.nullable(),
    citation_validity: rate.nullable(),
    unsupported_claim_rate: rate.nullable(),
    released_response_validation_failure_event: binary,
    appropriate_outcome: binary,
    decision_correct: binary,
    authorization_accuracy: binary.nullable(),
    prohibited_disclosure_count: z.number().int().nonnegative(),
    task_success: binary,
    covered_required_record_count: z.number().int().nonnegative(),
    required_record_count: z.number().int().nonnegative(),
    valid_citation_count: z.number().int().nonnegative(),
    citation_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((score, context) => {
    if (score.covered_required_record_count > score.required_record_count) {
      context.addIssue({
        code: "custom",
        path: ["covered_required_record_count"],
        message: "Covered required records cannot exceed required records",
      });
    }
    if (score.valid_citation_count > score.citation_count) {
      context.addIssue({
        code: "custom",
        path: ["valid_citation_count"],
        message: "Valid citations cannot exceed citations",
      });
    }
    if ((score.required_record_count === 0) !== (score.required_record_coverage === null)) {
      context.addIssue({
        code: "custom",
        path: ["required_record_coverage"],
        message: "Required-record coverage must be null exactly when no records are required",
      });
    }
    if ((score.citation_count === 0) !== (score.citation_validity === null)) {
      context.addIssue({
        code: "custom",
        path: ["citation_validity"],
        message: "Citation validity must be null exactly when no citations are present",
      });
    }
  });

const evaluatedResponseFields = {
  outcome: z.enum(["answer", "abstain", "requires_external_decision"]),
  decision_code: decisionCode,
  summary: z.string(),
  warnings: z.array(z.string()),
  missing_requirements: z.array(z.string()),
  evidence_reason_codes: z.array(z.string()),
  claims: candidateSnapshot.shape.claims,
} as const;

export const storedObservationSchema = z
  .object({
    schema: z.literal("EVLLM_LIVE_EVALUATION_OBSERVATION_V2"),
    observation_id: z.string().min(1),
    formal_evidence: z.boolean(),
    evaluation_set_id: z.string().min(1),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    freeze_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    corpus_file_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    logical_corpus_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    case_id: z.string().min(1),
    configuration_id: z.string().min(1),
    repetition: z.number().int().positive(),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    duration_ms: z.number().int().nonnegative(),
    attempts: z.number().int().min(1).max(3),
    transport_attempts: z.number().int().min(0),
    model_invoked: z.boolean(),
    provider: z.string().min(1),
    model: z.string().min(1),
    response_id: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    raw_model_candidate: candidateSnapshot.nullable(),
    released_candidate: candidateSnapshot,
    raw_validation_codes: z.array(z.string()),
    presented_support_ids: z.array(z.string()),
    model_input_sha256: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/u)
      .nullable(),
    ...evaluatedResponseFields,
    validation_codes: z.array(z.string()),
    score: formalScore,
  })
  .strict()
  .superRefine((record, context) => {
    assertReleasedCandidateMatches(record, context);
    if (new Set(record.presented_support_ids).size !== record.presented_support_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["presented_support_ids"],
        message: "Presented support IDs must be exact and unique",
      });
    }
    if (record.model_invoked) {
      if (record.raw_model_candidate === null) {
        context.addIssue({
          code: "custom",
          path: ["raw_model_candidate"],
          message: "A successful model invocation must retain its raw structured candidate",
        });
      }
      if (record.model_input_sha256 === null) {
        context.addIssue({
          code: "custom",
          path: ["model_input_sha256"],
          message: "A successful model invocation must retain its canonical input digest",
        });
      }
      if (record.transport_attempts < record.attempts) {
        context.addIssue({
          code: "custom",
          path: ["transport_attempts"],
          message: "Cumulative model transport attempts cannot be fewer than collection attempts",
        });
      }
    } else if (
      record.raw_model_candidate !== null ||
      record.model_input_sha256 !== null ||
      record.transport_attempts !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["model_invoked"],
        message: "A non-model observation cannot retain model output, input, or transport attempts",
      });
    }
    if ((record.claims.length === 0) !== (record.score.unsupported_claim_rate === null)) {
      context.addIssue({
        code: "custom",
        path: ["score", "unsupported_claim_rate"],
        message:
          "Unsupported-claim rate must be null exactly when the released response has no claims",
      });
    }
  });
export type StoredObservation = z.infer<typeof storedObservationSchema>;

export const complementarySynthesisObservationSchema = z
  .object({
    schema: z.literal("EVLLM_COMPLEMENTARY_SYNTHESIS_OBSERVATION_V2"),
    observation_id: z.string().min(1),
    evaluation_set_id: z.string().min(1),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    freeze_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    corpus_file_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    logical_corpus_sha256: z.string().regex(/^0x[0-9a-f]{64}$/u),
    case_id: z.string().min(1),
    stratum: z.string().min(1),
    repetition: z.number().int().positive(),
    started_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    duration_ms: z.number().int().nonnegative(),
    attempts: z.number().int().min(1).max(3),
    transport_attempts: z.number().int().min(0),
    model_invoked: z.boolean(),
    provider: z.string().min(1),
    model: z.string().min(1),
    response_id: z.string().nullable(),
    input_tokens: z.number().int().nonnegative().nullable(),
    output_tokens: z.number().int().nonnegative().nullable(),
    raw_model_candidate: complementaryCandidateSnapshot.nullable(),
    released_candidate: complementaryCandidateSnapshot,
    raw_validation_codes: z.array(z.string()),
    presented_support_ids: z.array(z.string()),
    model_input_sha256: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/u)
      .nullable(),
    ...evaluatedResponseFields,
    validation_status: z.enum(["passed", "rejected"]),
    validation_codes: z.array(z.string()),
  })
  .strict()
  .superRefine((record, context) => {
    assertComplementaryReleasedCandidateMatches(record, context);
    if (new Set(record.presented_support_ids).size !== record.presented_support_ids.length) {
      context.addIssue({
        code: "custom",
        path: ["presented_support_ids"],
        message: "Presented support IDs must be exact and unique",
      });
    }
    if (record.model_invoked) {
      if (record.raw_model_candidate === null || record.model_input_sha256 === null) {
        context.addIssue({
          code: "custom",
          path: ["model_invoked"],
          message: "A successful model invocation must retain its raw candidate and input digest",
        });
      }
      if (record.transport_attempts < record.attempts) {
        context.addIssue({
          code: "custom",
          path: ["transport_attempts"],
          message: "Cumulative model transport attempts cannot be fewer than collection attempts",
        });
      }
    } else if (
      record.raw_model_candidate !== null ||
      record.model_input_sha256 !== null ||
      record.transport_attempts !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["model_invoked"],
        message: "A non-model observation cannot retain model output, input, or transport attempts",
      });
    }
    if ((record.validation_status === "passed") !== (record.validation_codes.length === 0)) {
      context.addIssue({
        code: "custom",
        path: ["validation_status"],
        message: "Validation status and validation codes do not reconcile",
      });
    }
  });
export type ComplementarySynthesisStoredObservation = z.infer<
  typeof complementarySynthesisObservationSchema
>;

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
        record = storedObservationSchema.parse(JSON.parse(line));
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
    const record = storedObservationSchema.parse(raw);
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

function assertComplementaryReleasedCandidateMatches(
  record: {
    readonly released_candidate: ComplementaryCandidateSnapshot;
    readonly outcome: ComplementaryCandidateSnapshot["outcome"];
    readonly decision_code: string | null;
    readonly summary: string;
    readonly warnings: readonly string[];
    readonly missing_requirements: readonly string[];
    readonly evidence_reason_codes: readonly string[];
    readonly claims: ComplementaryCandidateSnapshot["claims"];
  },
  context: z.RefinementCtx,
): void {
  const released: ComplementaryCandidateSnapshot = {
    outcome: record.outcome,
    decision_code: record.decision_code,
    summary: record.summary,
    warnings: [...record.warnings],
    missing_requirements: [...record.missing_requirements],
    evidence_reason_codes: [...record.evidence_reason_codes],
    claims: [...record.claims],
  };
  if (
    !Buffer.from(canonicalJsonBytes(record.released_candidate)).equals(
      Buffer.from(canonicalJsonBytes(released)),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["released_candidate"],
      message: "Released complementary candidate must match the scored user-visible response",
    });
  }
}

export interface EvaluationRunDirectoryOptions {
  readonly directory: string;
  readonly manifestPath: string;
  readonly expectedManifest: unknown;
  readonly finalRun: boolean;
  readonly resume: boolean;
  readonly allowedResumeEntries: readonly string[];
}

/**
 * Starts a final evidence run only in an empty directory. An interrupted run can
 * be resumed only when the caller explicitly requests it and the persisted
 * manifest remains exactly bound to the current source, freeze, corpus, plan,
 * and model configuration represented by `expectedManifest`.
 */
export async function prepareEvaluationRunDirectory(
  options: EvaluationRunDirectoryOptions,
): Promise<"fresh" | "resume"> {
  const directory = resolve(options.directory);
  const manifestPath = resolve(options.manifestPath);
  await mkdir(directory, { recursive: true });
  const entries = await readdir(directory);

  if (!options.finalRun) {
    await establishExactManifest(manifestPath, options.expectedManifest);
    return entries.length === 0 ? "fresh" : "resume";
  }

  if (!options.resume) {
    if (entries.length > 0) {
      throw new Error(
        "Final evaluation output directory is not empty; use --resume only for an interrupted run bound to the same manifest",
      );
    }
    await writeFile(manifestPath, `${JSON.stringify(options.expectedManifest, null, 2)}\n`, {
      flag: "wx",
    });
    return "fresh";
  }

  const allowed = new Set(options.allowedResumeEntries);
  const unexpected = entries.filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw new Error(`Final evaluation resume contains unexpected files: ${unexpected.join(", ")}`);
  }
  if (!entries.includes(manifestPath.split(/[\\/]/u).at(-1)!)) {
    throw new Error("Final evaluation resume requires an existing configuration manifest");
  }
  await assertExactManifest(manifestPath, options.expectedManifest);
  if (
    !entries.includes("observations.jsonl") &&
    (entries.includes("progress.json") || entries.includes("run-summary.json"))
  ) {
    throw new Error("Final evaluation resume metadata exists without its observation file");
  }
  return "resume";
}

export function sha256CanonicalJson(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalJsonBytes(value)).digest("hex")}`;
}

async function establishExactManifest(path: string, expected: unknown): Promise<void> {
  try {
    await assertExactManifest(path, expected);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    await writeFile(path, `${JSON.stringify(expected, null, 2)}\n`, { flag: "wx" });
  }
}

async function assertExactManifest(path: string, expected: unknown): Promise<void> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Buffer.from(canonicalJsonBytes(parsed)).equals(Buffer.from(canonicalJsonBytes(expected)))) {
    throw new Error("Existing evaluation manifest differs from this source/configuration");
  }
}

function assertReleasedCandidateMatches(
  record: {
    readonly released_candidate: CandidateSnapshot;
    readonly outcome: CandidateSnapshot["outcome"];
    readonly decision_code: string | null;
    readonly summary: string;
    readonly warnings: readonly string[];
    readonly missing_requirements: readonly string[];
    readonly evidence_reason_codes: readonly string[];
    readonly claims: CandidateSnapshot["claims"];
  },
  context: z.RefinementCtx,
): void {
  const released: CandidateSnapshot = {
    outcome: record.outcome,
    decision_code: record.decision_code,
    summary: record.summary,
    warnings: [...record.warnings],
    missing_requirements: [...record.missing_requirements],
    evidence_reason_codes: [...record.evidence_reason_codes],
    claims: [...record.claims],
  };
  if (
    !Buffer.from(canonicalJsonBytes(record.released_candidate)).equals(
      Buffer.from(canonicalJsonBytes(released)),
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["released_candidate"],
      message: "Released candidate must match the scored user-visible response",
    });
  }
}

export async function withBoundedTransportRetries<T>(
  operation: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  maximumAttempts = 3,
): Promise<{ value: T; attempts: number }> {
  if (!Number.isInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 3)
    throw new Error("Transport retry budget must be an integer from one to three");
  let attempts = 0;
  while (attempts < maximumAttempts) {
    attempts += 1;
    try {
      return { value: await operation(), attempts };
    } catch (error) {
      if (attempts >= maximumAttempts || !isTransientTransportError(error)) throw error;
      await wait(250 * 2 ** (attempts - 1));
    }
  }
  throw new Error("Unreachable retry state");
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
