import {
  FINAL_PRIMARY_CONDITIONS,
  FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES,
  FINAL_PRIMARY_OUTCOMES,
  FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES,
  FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL,
  FINAL_SYNTHESIS_CONDITIONS,
  FINAL_SYNTHESIS_PRIMARY_METRICS,
  FINAL_TRANSPORT_RETRIES,
} from "./final-freeze.js";
import { OPENAI_ASSISTANT_PROVIDER_MAX_RETRIES } from "../assistant/model.js";

export interface PrimaryFreezeProtocol {
  readonly conditions: unknown;
  readonly primaryOutcomes: unknown;
  readonly taskSuccessReasonSemantics: unknown;
  readonly analysis: {
    readonly pairedContrastOutcomes?: unknown;
    readonly descriptiveOutcomes?: unknown;
  };
  readonly model: {
    readonly maximumTransportRetriesPerInvocation?: unknown;
    readonly providerMaxRetries?: unknown;
  };
}

export interface SynthesisFreezeProtocol {
  readonly conditions: unknown;
  readonly primaryMetrics: unknown;
  readonly model: {
    readonly transportRetries?: unknown;
    readonly providerMaxRetries?: unknown;
  };
}

export function assertPrimaryFreezeProtocol(freeze: PrimaryFreezeProtocol): void {
  assertExactFrozenSequence("Primary condition list", freeze.conditions, FINAL_PRIMARY_CONDITIONS);
  assertExactFrozenSequence("Primary outcome list", freeze.primaryOutcomes, FINAL_PRIMARY_OUTCOMES);
  assertExactFrozenValue(
    "Primary task-success reason semantics",
    freeze.taskSuccessReasonSemantics,
    FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL,
  );
  assertExactFrozenSequence(
    "Primary paired-contrast outcome list",
    freeze.analysis.pairedContrastOutcomes,
    FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES,
  );
  assertExactFrozenSequence(
    "Primary descriptive outcome list",
    freeze.analysis.descriptiveOutcomes,
    FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES,
  );
  assertRetryPolicy(
    "Primary",
    freeze.model.maximumTransportRetriesPerInvocation,
    FINAL_TRANSPORT_RETRIES,
  );
  assertProviderRetryPolicy("Primary", freeze.model.providerMaxRetries);
}

export function assertSynthesisFreezeProtocol(freeze: SynthesisFreezeProtocol): void {
  assertExactFrozenSequence(
    "Synthesis condition list",
    freeze.conditions,
    FINAL_SYNTHESIS_CONDITIONS,
  );
  assertExactFrozenSequence(
    "Synthesis primary metric list",
    freeze.primaryMetrics,
    FINAL_SYNTHESIS_PRIMARY_METRICS,
  );
  assertRetryPolicy("Synthesis", freeze.model.transportRetries, FINAL_TRANSPORT_RETRIES);
  assertProviderRetryPolicy("Synthesis", freeze.model.providerMaxRetries);
}

export function assertExactFrozenSequence(
  label: string,
  actual: unknown,
  expected: readonly string[],
): void {
  if (!Array.isArray(actual) || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the prespecified protocol`);
  }
}

function assertExactFrozenValue(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match the prespecified protocol`);
  }
}

function assertRetryPolicy(label: string, actual: unknown, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `${label} transport retry policy mismatch: expected ${String(expected)}, received ${String(actual)}`,
    );
  }
}

function assertProviderRetryPolicy(label: string, actual: unknown): void {
  if (actual !== OPENAI_ASSISTANT_PROVIDER_MAX_RETRIES) {
    throw new Error(
      `${label} provider retry policy mismatch: expected ${String(OPENAI_ASSISTANT_PROVIDER_MAX_RETRIES)}, received ${String(actual)}`,
    );
  }
}
