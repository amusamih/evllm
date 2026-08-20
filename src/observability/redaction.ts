const redacted = "[REDACTED]";
const sensitiveKey =
  /(?:password|secret|token|private.?key|plaintext|\bdek\b|salt|prompt|domain.?payload|protected.?content|recipient.?envelope|controller.?envelope|object.?id|locator|credential)/iu;

export function redactForLog(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (value instanceof Error) {
    return { name: value.name, error_code: "INTERNAL_DEPENDENCY_ERROR" };
  }
  if (Array.isArray(value)) return value.map((item) => redactForLog(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? redacted : redactForLog(item, depth + 1),
      ]),
    );
  }
  return value;
}
