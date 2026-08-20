import { z } from "zod";

export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const identifierKinds = [
  "org",
  "actor",
  "battery",
  "claim",
  "evidence",
  "bundle",
  "verification",
  "assessment",
  "repository",
  "profile",
  "source",
  "listing",
  "offer",
  "agreement",
  "ownership",
  "delivery",
  "dispute",
  "assistant",
  "audit",
  "command",
  "grant",
  "authorization",
  "key",
  "policy",
  "schema",
  "rule",
  "deployment",
  "envelope",
  "staging",
  "receipt",
  "replica",
  "transition",
  "attempt",
  "challenge",
  "link",
  "assertion",
  "credential",
  "case",
  "event",
  "batch",
  "unit",
  "campaign",
  "decision",
  "session",
  "role",
  "capability",
] as const;

export type IdentifierKind = (typeof identifierKinds)[number];

export function urn(kind: IdentifierKind) {
  return z.string().regex(new RegExp(`^urn:evllm:${kind}:${UUID_PATTERN}$`));
}

export const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const canonicalAddress = z.string().regex(/^0x[0-9a-f]{40}$/);

export const bytes32Hex = z.string().regex(/^0x[0-9a-f]{64}$/);

export const uint256Hex = bytes32Hex;

export const base64Url = z
  .string()
  .regex(/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/)
  .superRefine((value, context) => {
    if (Buffer.from(value, "base64url").toString("base64url") !== value) {
      context.addIssue({ code: "custom", message: "Noncanonical base64url encoding" });
    }
  });

export const base64Url32 = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .superRefine((value, context) => {
    if (Buffer.from(value, "base64url").toString("base64url") !== value) {
      context.addIssue({ code: "custom", message: "Noncanonical base64url encoding" });
    }
  });

export const opaqueObjectId = base64Url32;

export const mediaType = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*$/,
  );

export const semver = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/);

export const canonicalDecimal = z
  .string()
  .regex(/^(?:0|-?(?:[1-9][0-9]*)(?:\.[0-9]*[1-9])?|-?0\.[0-9]*[1-9])$/)
  .superRefine((value, context) => {
    const digits = value.replace(/[-.]/g, "");
    const fraction = value.split(".")[1] ?? "";
    if (digits.length > 38 || fraction.length > 18) {
      context.addIssue({
        code: "custom",
        message: "Canonical decimals allow at most 38 significant and 18 fractional digits",
      });
    }
  });

export const digest = z
  .object({
    alg: z.literal("SHA-256"),
    value: base64Url32,
  })
  .strict();
