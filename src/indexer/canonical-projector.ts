import { canonicalJson } from "../protected-bundles/crypto/index.js";

export interface ChainBlock<Event> {
  readonly events: readonly Event[];
  readonly hash: string;
  readonly number: number;
  readonly parentHash: string;
}

export interface ProjectionReducer<Event, State> {
  readonly initialState: State;
  apply(state: State, event: Event): State;
}

export interface ProjectorSnapshot<State> {
  readonly confirmedHead?: { readonly hash: string; readonly number: number };
  readonly state: State;
}

export class CanonicalProjectorError extends Error {
  public constructor(public readonly code: "conflict" | "gap" | "unknown-parent") {
    super("Canonical projection update failed");
    this.name = "CanonicalProjectorError";
  }
}

export class CanonicalProjector<Event, State> {
  readonly #blocks = new Map<string, ChainBlock<Event>>();
  #canonical: ChainBlock<Event>[] = [];
  #state: State;

  public constructor(
    private readonly reducer: ProjectionReducer<Event, State>,
    private readonly confirmationDepth: number,
  ) {
    if (!Number.isSafeInteger(confirmationDepth) || confirmationDepth < 0) {
      throw new RangeError("confirmationDepth must be a nonnegative safe integer");
    }
    this.#state = structuredClone(reducer.initialState);
  }

  public ingest(block: ChainBlock<Event>): void {
    if (!Number.isSafeInteger(block.number) || block.number < 0 || block.hash.length === 0) {
      throw new CanonicalProjectorError("gap");
    }
    const existing = this.#blocks.get(block.hash);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(block))
        throw new CanonicalProjectorError("conflict");
      return;
    }
    if (block.number > 0 && !this.#blocks.has(block.parentHash)) {
      throw new CanonicalProjectorError("unknown-parent");
    }
    this.#blocks.set(block.hash, structuredClone(block));
  }

  public selectHead(headHash: string): ProjectorSnapshot<State> {
    const path = this.pathToGenesis(headHash);
    this.#canonical = path;
    this.rebuild();
    return this.snapshot();
  }

  public snapshot(): ProjectorSnapshot<State> {
    const confirmedIndex = this.#canonical.length - 1 - this.confirmationDepth;
    const confirmed = confirmedIndex >= 0 ? this.#canonical[confirmedIndex] : undefined;
    return {
      ...(confirmed === undefined
        ? {}
        : { confirmedHead: { hash: confirmed.hash, number: confirmed.number } }),
      state: structuredClone(this.#state),
    };
  }

  public checkpoint(): string {
    return canonicalJson(this.snapshot());
  }

  private pathToGenesis(headHash: string): ChainBlock<Event>[] {
    const reversed: ChainBlock<Event>[] = [];
    const seen = new Set<string>();
    let block = this.#blocks.get(headHash);
    if (block === undefined) throw new CanonicalProjectorError("unknown-parent");
    while (block !== undefined) {
      if (seen.has(block.hash)) throw new CanonicalProjectorError("conflict");
      seen.add(block.hash);
      reversed.push(block);
      if (block.number === 0) break;
      const parent = this.#blocks.get(block.parentHash);
      if (parent === undefined || parent.number + 1 !== block.number) {
        throw new CanonicalProjectorError("gap");
      }
      block = parent;
    }
    return reversed.reverse();
  }

  private rebuild(): void {
    this.#state = structuredClone(this.reducer.initialState);
    const confirmedCount = Math.max(0, this.#canonical.length - this.confirmationDepth);
    for (const block of this.#canonical.slice(0, confirmedCount)) {
      for (const event of block.events) this.#state = this.reducer.apply(this.#state, event);
    }
  }
}

export type EvidenceProjectionEvent =
  | { readonly claimId: string; readonly kind: "activated"; readonly version: number }
  | { readonly claimId: string; readonly kind: "revoked"; readonly version: number }
  | { readonly claimId: string; readonly kind: "superseded"; readonly version: number };

export interface EvidenceProjectionState {
  readonly claims: Record<
    string,
    { readonly status: "active" | "revoked" | "superseded"; readonly version: number }
  >;
}

export const evidenceProjectionReducer: ProjectionReducer<
  EvidenceProjectionEvent,
  EvidenceProjectionState
> = {
  initialState: { claims: {} },
  apply(state, event) {
    const status =
      event.kind === "activated" ? "active" : event.kind === "revoked" ? "revoked" : "superseded";
    return {
      claims: {
        ...state.claims,
        [event.claimId]: { status, version: event.version },
      },
    };
  },
};
