import type { FormalCase } from "../../src/evaluation/formal.js";

/** Identifies observations whose case contains one active, typed recorded decision. */
export function isTypedDecisionCase(item: Pick<FormalCase, "query_mode" | "supports">): boolean {
  return (
    item.query_mode === "explain_recorded_decision" &&
    item.supports.filter(
      (support) => support.status === "active" && support.recorded_decision !== undefined,
    ).length === 1
  );
}

/** Binary response-level event used to compare whether a released response has any unsupported claim. */
export function unsupportedClaimResponseEvent(
  item: Readonly<{ unsupported_claim_rate: number | null }>,
): 0 | 1 {
  return item.unsupported_claim_rate !== null && item.unsupported_claim_rate > 0 ? 1 : 0;
}
