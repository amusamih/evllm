import { describe, expect, it } from "vitest";

import {
  CanonicalProjector,
  evidenceProjectionReducer,
  type EvidenceProjectionEvent,
} from "../../src/indexer/index.js";

describe("reorganization-safe deterministic evidence projector", () => {
  it("projects only confirmed blocks and deterministically rolls back an orphaned branch", () => {
    const projector = new CanonicalProjector(evidenceProjectionReducer, 1);
    const genesis = block(0, "g", "", []);
    const first = block(1, "a1", "g", [{ kind: "activated", claimId: "claim-1", version: 1 }]);
    const second = block(2, "a2", "a1", []);
    projector.ingest(genesis);
    projector.ingest(first);
    projector.ingest(second);
    expect(projector.selectHead("a2")).toEqual({
      confirmedHead: { hash: "a1", number: 1 },
      state: { claims: { "claim-1": { status: "active", version: 1 } } },
    });

    const forkOne = block(1, "b1", "g", [{ kind: "activated", claimId: "claim-1", version: 2 }]);
    const forkTwo = block(2, "b2", "b1", [{ kind: "revoked", claimId: "claim-1", version: 2 }]);
    const forkThree = block(3, "b3", "b2", []);
    for (const candidate of [forkOne, forkTwo, forkThree]) projector.ingest(candidate);
    expect(projector.selectHead("b3")).toEqual({
      confirmedHead: { hash: "b2", number: 2 },
      state: { claims: { "claim-1": { status: "revoked", version: 2 } } },
    });
  });

  it("makes duplicate ingestion idempotent and rejects conflicting/gapped history", () => {
    const projector = new CanonicalProjector(evidenceProjectionReducer, 0);
    const genesis = block(0, "g", "", []);
    projector.ingest(genesis);
    projector.ingest(genesis);
    expect(projector.checkpoint()).toBe(projector.checkpoint());
    expect(() =>
      projector.ingest(block(0, "g", "", [{ kind: "revoked", claimId: "x", version: 1 }])),
    ).toThrow();
    expect(() => projector.ingest(block(2, "gap", "missing", []))).toThrow();
  });
});

function block(
  number: number,
  hash: string,
  parentHash: string,
  events: readonly EvidenceProjectionEvent[],
) {
  return { events, hash, number, parentHash };
}
