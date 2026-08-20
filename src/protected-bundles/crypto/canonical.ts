import canonicalize from "canonicalize";

const encoder = new TextEncoder();

export function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) throw new TypeError("Value cannot be represented as canonical JSON");
  return result;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

export function parseExactCanonicalJson(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  if (canonicalJson(parsed) !== text) throw new TypeError("JSON bytes are not exact RFC 8785 form");
  return parsed;
}
