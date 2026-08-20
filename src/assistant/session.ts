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
  public constructor(public readonly code: "expired" | "invalid" | "replay") {
    super("Session operation rejected");
  }
}

export class WalletSessionManager {
  readonly #challenges = new Map<string, Challenge>();
  readonly #sessions = new Map<string, ActorSession>();

  public constructor(
    private readonly verifySignature: (input: Challenge, signature: string) => Promise<boolean>,
    private readonly credentialIsCurrent: (input: z.infer<typeof identity>) => Promise<boolean>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1_000),
    private readonly sessionLifetimeSeconds = 900,
  ) {}

  public challenge(
    raw: unknown,
  ): Readonly<{ challenge_id: string; message: string; expires_at: number }> {
    const input = identity.parse(raw);
    const challengeId = randomUUID();
    const expiresAt = this.now() + 300;
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
    if (challenge.expiresAt < this.now()) throw new SessionError("expired");
    if (!(await this.credentialIsCurrent(challenge))) throw new SessionError("invalid");
    if (!(await this.verifySignature(challenge, signature))) throw new SessionError("invalid");
    const token = randomBytes(32).toString("base64url");
    const issuedAt = this.now();
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
    if (session.expiresAt < this.now()) {
      this.#sessions.delete(key);
      throw new SessionError("expired");
    }
    return session;
  }

  public logout(token: string): void {
    this.#sessions.delete(digest(token));
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
