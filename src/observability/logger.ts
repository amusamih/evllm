import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import { redactForLog } from "./redaction.js";

const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const correlationStorage = new AsyncLocalStorage<string>();

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export interface StructuredLogger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export function canonicalCorrelationId(candidate: unknown): string {
  return typeof candidate === "string" && correlationIdPattern.test(candidate)
    ? candidate
    : randomUUID();
}

export function runWithCorrelation<T>(correlationId: string, callback: () => T): T {
  return correlationStorage.run(correlationId, callback);
}

export function currentCorrelationId(): string | undefined {
  return correlationStorage.getStore();
}

export function createStructuredLogger(
  sink: LogSink = (line) => console.log(line),
): StructuredLogger {
  return {
    log(level, event, fields = {}) {
      sink(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          event,
          correlation_id: currentCorrelationId() ?? null,
          fields: redactForLog(fields),
        }),
      );
    },
  };
}
