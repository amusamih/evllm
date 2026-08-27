import { describe, expect, it } from "vitest";

import { sustainabilityValidationEvidence } from "../../scripts/lib/sustainability-evidence.js";

describe("sustainability validation evidence", () => {
  it("includes a genuinely unstable scenario ranking that withholds a preference", () => {
    const evidence = sustainabilityValidationEvidence();
    const unstable = evidence.scenarios.unstableRanking;

    expect(evidence.assertions.unstableRankingAbstains).toBe(true);
    expect(unstable.routes[0]?.U.rankStable).toBe(false);
    expect(unstable.decisionState).toBe("abstain");
    expect(unstable).not.toHaveProperty("preferredRoute");
    expect(unstable.warnings).toContain("ROUTE_RANK_UNSTABLE");
  });
});
