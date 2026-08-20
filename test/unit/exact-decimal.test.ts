import { describe, expect, it } from "vitest";

import { ExactDecimal } from "../../src/decision/index.js";

describe("exact decimal arithmetic", () => {
  it("uses canonical decimal strings and round-half-to-even", () => {
    expect(ExactDecimal.parse("1.25").toCanonical()).toBe("1.25");
    expect(() => ExactDecimal.parse("1.250")).toThrow();
  });

  it("reproduces half-even ties, signs, multiplication and division", () => {
    expect(ExactDecimal.parse("1.25").round(1).toCanonical()).toBe("1.2");
    expect(ExactDecimal.parse("1.35").round(1).toCanonical()).toBe("1.4");
    expect(ExactDecimal.parse("-1.25").round(1).toCanonical()).toBe("-1.2");
    expect(ExactDecimal.parse("2.5").multiply(ExactDecimal.parse("4")).toCanonical()).toBe("10");
    expect(ExactDecimal.parse("1").divide(ExactDecimal.parse("8"), 3).toCanonical()).toBe("0.125");
  });

  it("rejects noncanonical, unsafe and undefined arithmetic", () => {
    for (const value of ["01", "1.0", "1e2", "NaN", "Infinity"]) {
      expect(() => ExactDecimal.parse(value)).toThrow();
    }
    expect(() => ExactDecimal.parse("1").divide(ExactDecimal.parse("0"))).toThrow();
    expect(() => ExactDecimal.fromInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
