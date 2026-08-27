import { describe, expect, it } from "vitest";

import { ExactDecimal } from "../../src/decision/index.js";

describe("published arithmetic reproduction", () => {
  it("reproduces the public battery circularity-design example exactly", () => {
    // Public battery-passport method example: Kühn et al. (2025), DOI 10.3390/su17030969.
    // Ten equally weighted scores (0,3,1,2,3,5,5,3,2,1) yield 2.5.
    const publishedScores = [0, 3, 1, 2, 3, 5, 5, 3, 2, 1];
    const reproduced = publishedScores.reduce(
      (total, score) =>
        total.add(ExactDecimal.fromInteger(score).multiply(ExactDecimal.parse("0.1"))),
      ExactDecimal.fromInteger(0),
    );
    expect(reproduced.toCanonical()).toBe("2.5");
  });
});
