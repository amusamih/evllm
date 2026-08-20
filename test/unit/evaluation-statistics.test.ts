import { describe, expect, it } from "vitest";

import {
  holmAdjust,
  pairedBootstrapMeanDifference,
  quantiles,
  wilsonInterval,
} from "../../src/evaluation/statistics.js";

describe("formal evaluation statistics", () => {
  it("computes bounded Wilson intervals including the zero-failure upper bound", () => {
    expect(wilsonInterval(0, 100)).toMatchObject({ lower: 0 });
    expect(wilsonInterval(0, 100).upper).toBeCloseTo(0.03699, 4);
    expect(wilsonInterval(100, 100).upper).toBe(1);
  });

  it("produces deterministic paired bootstrap effects", () => {
    const pairs = Array.from({ length: 40 }, (_, index) => [index % 2, 0] as const);
    const first = pairedBootstrapMeanDifference(pairs, 1_000, 7);
    const second = pairedBootstrapMeanDifference(pairs, 1_000, 7);
    expect(first).toEqual(second);
    expect(first.estimate).toBe(0.5);
    expect(first.lower).toBeGreaterThan(0.3);
  });

  it("applies monotone Holm correction and exact quantiles", () => {
    expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
    expect(quantiles([1, 2, 3, 4, 5])).toEqual({
      median: 3,
      p50: 3,
      p95: 4.8,
      q1: 2,
      q3: 4,
      iqr: 2,
    });
  });
});
