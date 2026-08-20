import { evidenceClaimPayload, verificationPayload } from "../schemas/index.js";

type EvidencePayload = ReturnType<typeof evidenceClaimPayload.parse>;
type VerificationPayload = ReturnType<typeof verificationPayload.parse>;

export type EvidenceLifecycle = "active" | "revoked" | "superseded";
export type AssertionLifecycle = "active" | "superseded" | "withdrawn";
export type DisputeLifecycle =
  | "closed-by-assertion-withdrawal"
  | "closed-by-supersession"
  | "open"
  | "referred-external"
  | "withdrawn";

export interface EvidenceRecord {
  readonly activatedAt: number;
  readonly payload: EvidencePayload;
  readonly status: EvidenceLifecycle;
}

export interface AssertionRecord {
  readonly payload: VerificationPayload;
  readonly status: AssertionLifecycle;
}

export interface DisputeRecord {
  readonly claimId: string;
  readonly claimVersion: number;
  readonly disputeId: string;
  readonly openedByOrganizationId: string;
  readonly reason: string;
  readonly status: DisputeLifecycle;
}

export class EvidenceLedgerError extends Error {
  public constructor(
    public readonly code:
      "conflict" | "invalid-prior" | "invalid-state" | "not-found" | "self-verification",
  ) {
    super("Evidence lifecycle operation failed");
    this.name = "EvidenceLedgerError";
  }
}

export class EvidenceLedger {
  readonly #assertions = new Map<string, AssertionRecord>();
  readonly #disputes = new Map<string, DisputeRecord>();
  readonly #versions = new Map<string, EvidenceRecord[]>();

  public activate(
    payloadInput: unknown,
    expectedPriorVersion: number,
    activatedAt: number,
  ): EvidenceRecord {
    const payload = evidenceClaimPayload.parse(payloadInput);
    const versions = this.#versions.get(payload.claim_id) ?? [];
    const prior = versions.at(-1);
    if ((prior?.payload.claim_version ?? 0) !== expectedPriorVersion) {
      throw new EvidenceLedgerError("invalid-prior");
    }
    if (
      payload.claim_version !== expectedPriorVersion + 1 ||
      versions.some((record) => record.payload.claim_version === payload.claim_version)
    ) {
      throw new EvidenceLedgerError("conflict");
    }
    if (prior !== undefined) {
      if (prior.status !== "active") throw new EvidenceLedgerError("invalid-state");
      versions[versions.length - 1] = { ...prior, status: "superseded" };
      this.closeDisputes(payload.claim_id, expectedPriorVersion, "closed-by-supersession");
    }
    const record: EvidenceRecord = { activatedAt, payload, status: "active" };
    versions.push(record);
    this.#versions.set(payload.claim_id, versions);
    return structuredClone(record);
  }

  public revoke(claimId: string, version: number): EvidenceRecord {
    const record = this.mutableVersion(claimId, version);
    if (record.status !== "active") throw new EvidenceLedgerError("invalid-state");
    const changed = { ...record, status: "revoked" as const };
    this.replaceVersion(claimId, version, changed);
    this.closeDisputes(claimId, version, "referred-external");
    return structuredClone(changed);
  }

  public addVerification(payloadInput: unknown): AssertionRecord {
    const payload = verificationPayload.parse(payloadInput);
    const evidence = this.version(payload.claim_id, payload.claim_version);
    if (evidence.status !== "active") throw new EvidenceLedgerError("invalid-state");
    if (evidence.payload.issuer_organization_id === payload.verifier_organization_id) {
      throw new EvidenceLedgerError("self-verification");
    }
    const key = `${payload.verification_id}:${payload.verification_version}`;
    if (this.#assertions.has(key)) throw new EvidenceLedgerError("conflict");
    const record: AssertionRecord = { payload, status: "active" };
    this.#assertions.set(key, record);
    return structuredClone(record);
  }

  public withdrawVerification(verificationId: string, version: number): AssertionRecord {
    const key = `${verificationId}:${version}`;
    const record = this.#assertions.get(key);
    if (record === undefined) throw new EvidenceLedgerError("not-found");
    if (record.status !== "active") throw new EvidenceLedgerError("invalid-state");
    const changed: AssertionRecord = { ...record, status: "withdrawn" };
    this.#assertions.set(key, changed);
    return structuredClone(changed);
  }

  public openDispute(input: Omit<DisputeRecord, "status">): DisputeRecord {
    if (this.#disputes.has(input.disputeId)) throw new EvidenceLedgerError("conflict");
    if (this.version(input.claimId, input.claimVersion).status !== "active") {
      throw new EvidenceLedgerError("invalid-state");
    }
    const record: DisputeRecord = { ...input, status: "open" };
    this.#disputes.set(input.disputeId, record);
    return structuredClone(record);
  }

  public changeDispute(disputeId: string, state: "referred-external" | "withdrawn"): DisputeRecord {
    const record = this.#disputes.get(disputeId);
    if (record === undefined) throw new EvidenceLedgerError("not-found");
    if (record.status !== "open") throw new EvidenceLedgerError("invalid-state");
    const changed = { ...record, status: state };
    this.#disputes.set(disputeId, changed);
    return structuredClone(changed);
  }

  public current(claimId: string): EvidenceRecord {
    const record = this.#versions.get(claimId)?.at(-1);
    if (record === undefined) throw new EvidenceLedgerError("not-found");
    return structuredClone(record);
  }

  public history(claimId: string): readonly EvidenceRecord[] {
    return structuredClone(this.#versions.get(claimId) ?? []);
  }

  public assertion(verificationId: string, version: number): AssertionRecord {
    const record = this.#assertions.get(`${verificationId}:${version}`);
    if (record === undefined) throw new EvidenceLedgerError("not-found");
    return structuredClone(record);
  }

  public dispute(disputeId: string): DisputeRecord {
    const record = this.#disputes.get(disputeId);
    if (record === undefined) throw new EvidenceLedgerError("not-found");
    return structuredClone(record);
  }

  private closeDisputes(claimId: string, version: number, status: DisputeLifecycle): void {
    for (const [id, dispute] of this.#disputes) {
      if (
        dispute.claimId === claimId &&
        dispute.claimVersion === version &&
        dispute.status === "open"
      ) {
        this.#disputes.set(id, { ...dispute, status });
      }
    }
  }

  private mutableVersion(claimId: string, version: number): EvidenceRecord {
    return this.version(claimId, version);
  }

  private replaceVersion(claimId: string, version: number, changed: EvidenceRecord): void {
    const versions = this.#versions.get(claimId);
    if (versions === undefined) throw new EvidenceLedgerError("not-found");
    const index = versions.findIndex((record) => record.payload.claim_version === version);
    if (index < 0) throw new EvidenceLedgerError("not-found");
    versions[index] = changed;
  }

  private version(claimId: string, version: number): EvidenceRecord {
    const record = this.#versions
      .get(claimId)
      ?.find((candidate) => candidate.payload.claim_version === version);
    if (record === undefined) throw new EvidenceLedgerError("not-found");
    return record;
  }
}
