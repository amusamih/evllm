import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJsonBytes } from "../protected-bundles/crypto/index.js";
import { canonicalAddress, positiveSafeInteger, uint256Hex, urn } from "../schemas/common.js";

export const marketplaceCommand = z
  .object({
    schema: z.literal("EVLLM_MARKETPLACE_COMMAND_V1"),
    command_id: urn("command"),
    kind: z.enum([
      "create-listing",
      "withdraw-listing",
      "submit-offer",
      "withdraw-offer",
      "reject-offer",
      "expire-listing",
      "expire-offer",
      "select-offer",
      "confirm-agreement",
      "fund-agreement",
      "record-dispatch",
      "record-delivery",
      "accept-delivery",
      "open-dispute",
      "resolve-dispute",
      "apply-timeout",
      "settle",
      "withdraw-credit",
    ]),
    signer_actor_id: urn("actor"),
    signer_organization_id: urn("org"),
    signer_credential_id: urn("credential"),
    signer_address: canonicalAddress,
    issued_at: positiveSafeInteger,
    expires_at: positiveSafeInteger,
    nonce: uint256Hex,
    idempotency_key_hash: z.string().regex(/^0x[0-9a-f]{64}$/),
    payload: z.record(z.string(), z.unknown()),
    signature: z.string().regex(/^0x[0-9a-f]{130}$/),
  })
  .strict()
  .superRefine(({ expires_at: expiresAt, issued_at: issuedAt }, context) => {
    if (expiresAt <= issuedAt)
      context.addIssue({ code: "custom", message: "Invalid proof window" });
  });

export type MarketplaceCommand = z.infer<typeof marketplaceCommand>;

export interface MarketplaceCommandResult {
  readonly commandId: string;
  readonly transactionHash: string;
  readonly status: "submitted";
}

export class MarketplaceGatewayError extends Error {
  public constructor(
    public readonly code: "conflict" | "expired" | "invalid" | "signature" | "unknown",
  ) {
    super("Marketplace command rejected");
    this.name = "MarketplaceGatewayError";
  }
}

export class MarketplaceCommandGateway {
  readonly #commands = new Map<string, { fingerprint: string; result: MarketplaceCommandResult }>();

  public constructor(
    private readonly verify: (command: MarketplaceCommand) => boolean | Promise<boolean>,
    private readonly execute: (command: MarketplaceCommand) => Promise<string>,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    private readonly validatePolicy: (
      command: MarketplaceCommand,
    ) => boolean | Promise<boolean> = () => true,
  ) {}

  public async submit(input: unknown): Promise<MarketplaceCommandResult> {
    const parsed = marketplaceCommand.safeParse(input);
    if (!parsed.success) throw new MarketplaceGatewayError("invalid");
    const command = parsed.data;
    const fingerprint = createHash("sha256")
      .update(canonicalJsonBytes(command))
      .digest("base64url");
    const prior = this.#commands.get(command.command_id);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) throw new MarketplaceGatewayError("conflict");
      return structuredClone(prior.result);
    }
    const at = this.now();
    if (at < command.issued_at || at >= command.expires_at) {
      throw new MarketplaceGatewayError("expired");
    }
    if (!(await this.verify(command))) throw new MarketplaceGatewayError("signature");
    if (!(await this.validatePolicy(command))) throw new MarketplaceGatewayError("signature");
    const transactionHash = await this.execute(structuredClone(command));
    if (!/^0x[0-9a-f]{64}$/u.test(transactionHash)) throw new MarketplaceGatewayError("invalid");
    const result: MarketplaceCommandResult = {
      commandId: command.command_id,
      transactionHash,
      status: "submitted",
    };
    this.#commands.set(command.command_id, { fingerprint, result });
    return structuredClone(result);
  }

  public result(commandId: string): MarketplaceCommandResult {
    const result = this.#commands.get(commandId)?.result;
    if (result === undefined) throw new MarketplaceGatewayError("unknown");
    return structuredClone(result);
  }
}
