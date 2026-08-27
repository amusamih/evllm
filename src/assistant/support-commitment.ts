import { createHash } from "node:crypto";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";

export const RECORDED_DECISION_SUPPORT_COMMITMENT_DOMAIN =
  "EVLLM_RECORDED_DECISION_SUPPORT_COMMITMENT_V1";

export interface RecordedDecisionSupportCommitmentInput {
  readonly resource_id: string;
  readonly resource_version: number;
  readonly issuer_organization_id: string;
  readonly content: string;
  readonly recorded_decision: Readonly<{
    readonly outcome: string;
    readonly code: string;
    readonly reason_codes: readonly string[];
  }>;
}

/**
 * Commits a typed decision to the support that carries it. The domain tag prevents
 * the digest from being confused with commitments used for other record types.
 */
export function recordedDecisionSupportCommitment(
  support: RecordedDecisionSupportCommitmentInput,
): string {
  const committed = {
    domain: RECORDED_DECISION_SUPPORT_COMMITMENT_DOMAIN,
    resource_id: support.resource_id,
    resource_version: support.resource_version,
    issuer_organization_id: support.issuer_organization_id,
    content: support.content,
    recorded_decision: {
      outcome: support.recorded_decision.outcome,
      code: support.recorded_decision.code,
      reason_codes: [...support.recorded_decision.reason_codes].sort(),
    },
  };
  return `sha256:${createHash("sha256").update(canonicalJsonBytes(committed)).digest("base64url")}`;
}
