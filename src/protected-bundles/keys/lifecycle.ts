export type EncryptionKeyState =
  "pending" | "active" | "retired" | "revoked" | "lost" | "compromised";

export type GrantStoredState = "prepared" | "active" | "revoked";
export type ControllerAuthorizationState = "staged" | "active" | "retired";

export interface EncryptionKeyRecord {
  readonly id: string;
  readonly organizationId: string;
  state: EncryptionKeyState;
}

export interface AccessGrantRecord {
  readonly effectiveAt: number;
  readonly envelopeId: string;
  readonly expiresAt: number;
  readonly grantId: string;
  readonly recipientKeyId: string;
  state: GrantStoredState;
}

export interface ControllerAuthorizationRecord {
  readonly authorizationId: string;
  readonly envelopeId: string;
  readonly keyId: string;
  state: ControllerAuthorizationState;
}

export interface KeyLifecycleSnapshot {
  readonly authorizations: ControllerAuthorizationRecord[];
  readonly grants: AccessGrantRecord[];
  readonly keys: EncryptionKeyRecord[];
}

export class KeyLifecycleError extends Error {
  public constructor(
    public readonly code:
      "invalid-transition" | "key-unavailable" | "last-controller" | "policy-denied",
  ) {
    super("Key operation is unavailable");
    this.name = "KeyLifecycleError";
  }
}

export class KeyLifecycleRegistry {
  readonly #authorizations = new Map<string, ControllerAuthorizationRecord>();
  readonly #grants = new Map<string, AccessGrantRecord>();
  readonly #keys = new Map<string, EncryptionKeyRecord>();

  public static fromSnapshot(value: unknown): KeyLifecycleRegistry {
    if (
      !isRecord(value) ||
      !Array.isArray(value.keys) ||
      !Array.isArray(value.authorizations) ||
      !Array.isArray(value.grants)
    ) {
      throw new KeyLifecycleError("invalid-transition");
    }
    const registry = new KeyLifecycleRegistry();
    for (const candidate of value.keys) {
      if (!isEncryptionKeyRecord(candidate)) throw new KeyLifecycleError("invalid-transition");
      registry.addKey(candidate);
    }
    for (const candidate of value.authorizations) {
      if (
        !isControllerAuthorizationRecord(candidate) ||
        !registry.#keys.has(candidate.keyId) ||
        registry.#authorizations.has(candidate.authorizationId)
      ) {
        throw new KeyLifecycleError("invalid-transition");
      }
      registry.#authorizations.set(candidate.authorizationId, { ...candidate });
    }
    for (const candidate of value.grants) {
      if (
        !isAccessGrantRecord(candidate) ||
        !registry.#keys.has(candidate.recipientKeyId) ||
        registry.#grants.has(candidate.grantId)
      ) {
        throw new KeyLifecycleError("invalid-transition");
      }
      registry.#grants.set(candidate.grantId, { ...candidate });
    }
    return registry;
  }

  public addKey(record: EncryptionKeyRecord): void {
    if (this.#keys.has(record.id)) throw new KeyLifecycleError("invalid-transition");
    this.#keys.set(record.id, { ...record });
  }

  public activateKey(keyId: string): void {
    const key = this.key(keyId);
    if (key.state !== "pending") throw new KeyLifecycleError("invalid-transition");
    key.state = "active";
  }

  public recordKeyFailure(keyId: string, state: "compromised" | "lost" | "revoked"): void {
    const key = this.key(keyId);
    if (isTerminalKeyState(key.state)) throw new KeyLifecycleError("invalid-transition");
    key.state = state;
  }

  public retireKey(keyId: string): void {
    const key = this.key(keyId);
    if (key.state !== "active") throw new KeyLifecycleError("invalid-transition");
    const lastControllerForKey = [...this.#authorizations.values()].some(
      (authorization) => authorization.keyId === keyId && authorization.state === "active",
    );
    if (lastControllerForKey && this.usableControllerCount() <= 1) {
      throw new KeyLifecycleError("last-controller");
    }
    key.state = "retired";
  }

  public stageControllerAuthorization(record: ControllerAuthorizationRecord): void {
    if (record.state !== "staged" || this.#authorizations.has(record.authorizationId)) {
      throw new KeyLifecycleError("invalid-transition");
    }
    this.requireActiveKey(record.keyId);
    this.#authorizations.set(record.authorizationId, { ...record });
  }

  public activateControllerAuthorization(authorizationId: string): void {
    const authorization = this.authorization(authorizationId);
    if (authorization.state !== "staged") throw new KeyLifecycleError("invalid-transition");
    this.requireActiveKey(authorization.keyId);
    authorization.state = "active";
  }

  public async rotateControllerAuthorization(
    predecessorId: string,
    successor: ControllerAuthorizationRecord,
    verifySuccessorEnvelope: () => Promise<boolean>,
  ): Promise<void> {
    const predecessor = this.authorization(predecessorId);
    if (predecessor.state !== "active") throw new KeyLifecycleError("key-unavailable");
    this.requireUsableKey(predecessor.keyId);
    if (successor.state !== "staged") throw new KeyLifecycleError("invalid-transition");
    this.requireActiveKey(successor.keyId);
    if (!(await verifySuccessorEnvelope())) throw new KeyLifecycleError("key-unavailable");
    this.#authorizations.set(successor.authorizationId, { ...successor, state: "active" });
    predecessor.state = "retired";
  }

  public prepareGrant(record: AccessGrantRecord): void {
    if (record.state !== "prepared" || record.effectiveAt >= record.expiresAt) {
      throw new KeyLifecycleError("invalid-transition");
    }
    this.requireActiveKey(record.recipientKeyId);
    if (this.usableControllerCount() === 0) throw new KeyLifecycleError("key-unavailable");
    if (this.#grants.has(record.grantId)) throw new KeyLifecycleError("invalid-transition");
    this.#grants.set(record.grantId, { ...record });
  }

  public async activateGrant(
    grantId: string,
    currentTime: number,
    verifyEnvelope: () => Promise<boolean>,
  ): Promise<void> {
    const grant = this.grant(grantId);
    if (grant.state !== "prepared" || currentTime >= grant.expiresAt) {
      throw new KeyLifecycleError("invalid-transition");
    }
    this.requireActiveKey(grant.recipientKeyId);
    if (!(await verifyEnvelope())) throw new KeyLifecycleError("key-unavailable");
    grant.state = "active";
  }

  public revokeGrant(grantId: string): void {
    const grant = this.grant(grantId);
    if (grant.state === "revoked") throw new KeyLifecycleError("invalid-transition");
    grant.state = "revoked";
  }

  public effectiveGrantState(grantId: string, currentTime: number): GrantStoredState | "expired" {
    const grant = this.grant(grantId);
    return grant.state !== "revoked" && currentTime >= grant.expiresAt ? "expired" : grant.state;
  }

  public authorizeRetrieval(grantId: string, currentTime: number): void {
    const grant = this.grant(grantId);
    if (
      this.effectiveGrantState(grantId, currentTime) !== "active" ||
      currentTime < grant.effectiveAt
    ) {
      throw new KeyLifecycleError("policy-denied");
    }
    this.requireUsableKey(grant.recipientKeyId);
  }

  public async rotateRecipientEnvelope(
    grantId: string,
    successorKeyId: string,
    successorEnvelopeId: string,
    verifyEnvelope: () => Promise<boolean>,
  ): Promise<void> {
    const grant = this.grant(grantId);
    if (grant.state !== "active") throw new KeyLifecycleError("policy-denied");
    this.requireActiveKey(successorKeyId);
    if (!(await verifyEnvelope())) throw new KeyLifecycleError("key-unavailable");
    this.#grants.set(grantId, {
      ...grant,
      envelopeId: successorEnvelopeId,
      recipientKeyId: successorKeyId,
    });
  }

  public snapshot(): KeyLifecycleSnapshot {
    return {
      authorizations: [...this.#authorizations.values()]
        .map((record) => ({ ...record }))
        .sort((left, right) => left.authorizationId.localeCompare(right.authorizationId)),
      grants: [...this.#grants.values()]
        .map((record) => ({ ...record }))
        .sort((left, right) => left.grantId.localeCompare(right.grantId)),
      keys: [...this.#keys.values()]
        .map((record) => ({ ...record }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  private usableControllerCount(): number {
    return [...this.#authorizations.values()].filter(
      (authorization) => authorization.state === "active" && this.isUsableKey(authorization.keyId),
    ).length;
  }

  private isUsableKey(keyId: string): boolean {
    const state = this.key(keyId).state;
    return state === "active" || state === "retired";
  }

  private requireActiveKey(keyId: string): void {
    if (this.key(keyId).state !== "active") throw new KeyLifecycleError("key-unavailable");
  }

  private requireUsableKey(keyId: string): void {
    if (!this.isUsableKey(keyId)) throw new KeyLifecycleError("key-unavailable");
  }

  private key(keyId: string): EncryptionKeyRecord {
    const key = this.#keys.get(keyId);
    if (key === undefined) throw new KeyLifecycleError("key-unavailable");
    return key;
  }

  private authorization(authorizationId: string): ControllerAuthorizationRecord {
    const authorization = this.#authorizations.get(authorizationId);
    if (authorization === undefined) throw new KeyLifecycleError("key-unavailable");
    return authorization;
  }

  private grant(grantId: string): AccessGrantRecord {
    const grant = this.#grants.get(grantId);
    if (grant === undefined) throw new KeyLifecycleError("policy-denied");
    return grant;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isEncryptionKeyRecord(value: unknown): value is EncryptionKeyRecord {
  return (
    isRecord(value) &&
    isNonemptyString(value.id) &&
    isNonemptyString(value.organizationId) &&
    ["pending", "active", "retired", "revoked", "lost", "compromised"].includes(String(value.state))
  );
}

function isControllerAuthorizationRecord(value: unknown): value is ControllerAuthorizationRecord {
  return (
    isRecord(value) &&
    isNonemptyString(value.authorizationId) &&
    isNonemptyString(value.envelopeId) &&
    isNonemptyString(value.keyId) &&
    ["staged", "active", "retired"].includes(String(value.state))
  );
}

function isAccessGrantRecord(value: unknown): value is AccessGrantRecord {
  return (
    isRecord(value) &&
    isNonemptyString(value.grantId) &&
    isNonemptyString(value.envelopeId) &&
    isNonemptyString(value.recipientKeyId) &&
    typeof value.effectiveAt === "number" &&
    Number.isSafeInteger(value.effectiveAt) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    value.effectiveAt < value.expiresAt &&
    ["prepared", "active", "revoked"].includes(String(value.state))
  );
}

function isTerminalKeyState(state: EncryptionKeyState): boolean {
  return state === "retired" || state === "revoked" || state === "lost" || state === "compromised";
}
