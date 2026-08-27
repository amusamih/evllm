import { describe, expect, it } from "vitest";

import {
  clusteredBootstrapMean,
  holmAdjust,
  pairedBootstrapMeanDifference,
  pairedClusterBootstrapMeanDifference,
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

  it("resamples whole clusters instead of individual observations", () => {
    const clusters = [
      [1, 1, 1, 1, 1],
      [0, 0, 0, 0, 0],
    ];
    const first = clusteredBootstrapMean(clusters, 2_000, 11);
    const second = clusteredBootstrapMean(clusters, 2_000, 11);
    expect(first).toEqual(second);
    expect(first).toEqual({ estimate: 0.5, lower: 0, upper: 1 });
  });

  it("keeps paired repetitions together when bootstrapping case effects", () => {
    const clusters = [
      [
        [1, 1, 1, 1, 1],
        [0, 0, 0, 0, 0],
      ],
      [
        [0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0],
      ],
    ] as const;
    const effect = pairedClusterBootstrapMeanDifference(clusters, 2_000, 13);
    expect(effect.estimate).toBe(0.5);
    expect(effect.lower).toBe(0);
    expect(effect.upper).toBe(1);
  });

  it("uses a paired randomization test rather than bootstrap-tail counts", () => {
    const consistent = Array.from(
      { length: 20 },
      () =>
        [
          [1, 1, 1, 1, 1],
          [0, 0, 0, 0, 0],
        ] as const,
    );
    expect(pairedClusterBootstrapMeanDifference(consistent, 2_000, 19).p_value).toBeLessThan(0.01);

    const tied = [
      [
        [1, 0],
        [1, 0],
      ],
      [
        [0, 1],
        [0, 1],
      ],
    ] as const;
    expect(pairedClusterBootstrapMeanDifference(tied, 2_000, 23).p_value).toBe(1);
  });

  it("enumerates small paired cluster randomization designs exactly", () => {
    const clusters = [
      [[1], [0]],
      [[1], [0]],
      [[1], [0]],
    ] as const;
    expect(pairedClusterBootstrapMeanDifference(clusters, 2_000, 29).p_value).toBe(0.25);
  });

  it("rejects empty case clusters", () => {
    expect(() => clusteredBootstrapMean([[1], []], 100, 17)).toThrow(
      "Insufficient clustered bootstrap input",
    );
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
