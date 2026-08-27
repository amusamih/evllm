import { createHash, randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import type { ActorSession } from "./types.js";

const identity = z
  .object({
    actorId: z.string().startsWith("urn:evllm:actor:"),
    organizationId: z.string().startsWith("urn:evllm:org:"),
    credentialId: z.string().startsWith("urn:evllm:credential:"),
    address: z.string().regex(/^0x[0-9a-f]{40}$/u),
  })
  .strict();

interface Challenge extends z.infer<typeof identity> {
  readonly challengeId: string;
  readonly message: string;
  readonly expiresAt: number;
}

export class SessionError extends Error {
  public constructor(public readonly code: "capacity" | "expired" | "invalid" | "replay") {
    super("Session operation rejected");
  }
}

export interface WalletSessionLimits {
  readonly challengeLifetimeSeconds?: number;
  readonly maxChallenges?: number;
  readonly maxSessions?: number;
}

export class WalletSessionManager {
  readonly #challenges = new Map<string, Challenge>();
  readonly #sessions = new Map<string, ActorSession>();
  readonly #challengeLifetimeSeconds: number;
  readonly #maxChallenges: number;
  readonly #maxSessions: number;

  public constructor(
    private readonly verifySignature: (input: Challenge, signature: string) => Promise<boolean>,
    private readonly credentialIsCurrent: (input: z.infer<typeof identity>) => Promise<boolean>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly sessionLifetimeSeconds = 900,
    limits: WalletSessionLimits = {},
  ) {
    this.#challengeLifetimeSeconds = positiveInteger(
      limits.challengeLifetimeSeconds ?? 300,
      "challenge lifetime",
    );
    this.#maxChallenges = positiveInteger(limits.maxChallenges ?? 1_024, "challenge capacity");
    this.#maxSessions = positiveInteger(limits.maxSessions ?? 1_024, "session capacity");
    positiveInteger(sessionLifetimeSeconds, "session lifetime");
  }

  public challenge(
    raw: unknown,
  ): Readonly<{ challenge_id: string; message: string; expires_at: number }> {
    const input = identity.parse(raw);
    const issuedAt = this.now();
    this.#removeExpired(issuedAt);
    if (this.#challenges.size >= this.#maxChallenges) throw new SessionError("capacity");
    const challengeId = randomUUID();
    const expiresAt = issuedAt + this.#challengeLifetimeSeconds;
    const nonce = randomBytes(32).toString("base64url");
    const message = [
      "EVLLM wallet session v1",
      `challenge=${challengeId}`,
      `actor=${input.actorId}`,
      `organization=${input.organizationId}`,
      `credential=${input.credentialId}`,
      `address=${input.address}`,
      `nonce=${nonce}`,
      `expires_at=${String(expiresAt)}`,
    ].join("\n");
    this.#challenges.set(challengeId, { ...input, challengeId, message, expiresAt });
    return { challenge_id: challengeId, message, expires_at: expiresAt };
  }

  public async verify(
    challengeId: string,
    signature: string,
  ): Promise<Readonly<{ token: string; session: ActorSession }>> {
    const challenge = this.#challenges.get(challengeId);
    if (challenge === undefined) throw new SessionError("replay");
    this.#challenges.delete(challengeId);
    const verificationStartedAt = this.now();
    this.#removeExpired(verificationStartedAt);
    if (challenge.expiresAt <= verificationStartedAt) throw new SessionError("expired");
    if (!(await this.credentialIsCurrent(challenge))) throw new SessionError("invalid");
    if (!(await this.verifySignature(challenge, signature))) throw new SessionError("invalid");
    if (challenge.expiresAt <= this.now()) throw new SessionError("expired");
    const token = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
    this.#removeExpired(issuedAt);
    if (this.#sessions.size >= this.#maxSessions) throw new SessionError("capacity");
    const session: ActorSession = Object.freeze({
      sessionId: `urn:evllm:session:${randomUUID()}`,
      actorId: challenge.actorId,
      organizationId: challenge.organizationId,
      credentialId: challenge.credentialId,
      address: challenge.address,
      issuedAt,
      expiresAt: issuedAt + this.sessionLifetimeSeconds,
    });
    this.#sessions.set(digest(token), session);
    return { token, session };
  }

  public require(token: string): ActorSession {
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (session === undefined) throw new SessionError("invalid");
    const currentTime = this.now();
    this.#removeExpired(currentTime, key);
    if (session.expiresAt <= currentTime) {
      this.#sessions.delete(key);
      throw new SessionError("expired");
    }
    return session;
  }

  public logout(token: string): void {
    this.#removeExpired(this.now());
    this.#sessions.delete(digest(token));
  }

  #removeExpired(currentTime: number, retainedSessionKey?: string): void {
    for (const [challengeId, challenge] of this.#challenges) {
      if (challenge.expiresAt <= currentTime) this.#challenges.delete(challengeId);
    }
    for (const [sessionKey, session] of this.#sessions) {
      if (sessionKey !== retainedSessionKey && session.expiresAt <= currentTime) {
        this.#sessions.delete(sessionKey);
      }
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}
