import { z } from "zod";

import { canonicalDecimal, positiveSafeInteger, urn } from "./common.js";

export const decimalQuantity = z
  .object({
    value: canonicalDecimal,
    unit_id: urn("unit"),
    unit_version: positiveSafeInteger,
  })
  .strict();

export const decimalRange = z
  .object({
    lower: canonicalDecimal,
    upper: canonicalDecimal,
  })
  .strict()
  .superRefine(({ lower, upper }, context) => {
    if (compareCanonicalDecimals(lower, upper) > 0) {
      context.addIssue({ code: "custom", message: "lower must be less than or equal to upper" });
    }
  });

export const moneyValue = z
  .object({
    amount: canonicalDecimal,
    currency: z.string().regex(/^[A-Z]{3}$/),
    currency_profile_id: urn("profile"),
    currency_profile_version: positiveSafeInteger,
  })
  .strict();

export const percentilePoint = z
  .object({
    probability: canonicalDecimal.refine(
      (value) =>
        compareCanonicalDecimals(value, "0") >= 0 && compareCanonicalDecimals(value, "1") <= 0,
      "probability must be between 0 and 1 inclusive",
    ),
    value: canonicalDecimal,
  })
  .strict();

export const weiAmount = z.string().regex(/^0x[0-9a-f]{64}$/);

function compareCanonicalDecimals(left: string, right: string): number {
  const [leftInteger = "0", leftFraction = ""] = left.split(".");
  const [rightInteger = "0", rightFraction = ""] = right.split(".");
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const scaleFactor = 10n ** BigInt(scale);
  const normalize = (integer: string, fraction: string) =>
    BigInt(integer) * scaleFactor +
    BigInt(`${fraction}${"0".repeat(scale - fraction.length)}` || "0") *
      (integer.startsWith("-") ? -1n : 1n);
  const leftValue = normalize(leftInteger, leftFraction);
  const rightValue = normalize(rightInteger, rightFraction);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
