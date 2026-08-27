import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp } from "../../src/app.js";
import { MarketplaceCommandGateway } from "../../src/marketplace/index.js";

describe("marketplace command/query boundary", () => {
  it("requires API authorization and a verified expiring actor signature", async () => {
    const execute = vi.fn(() => Promise.resolve(transactionHash));
    const gateway = new MarketplaceCommandGateway(
      (command) => command.signature === signature,
      execute,
      () => 150,
    );
    const query = vi.fn(() => Promise.resolve({ state: "active", listing_id: listingId }));
    const app = createApp({
      appEnvironment: "test",
      marketplace: {
        authorize: (incoming) => incoming.header("authorization") === "Bearer marketplace-actor",
        gateway,
        query,
      },
    });

    await request(app).post("/api/v1/commands").send(command()).expect(403);
    await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer marketplace-actor")
      .send({ ...command(), signature: `0x${"11".repeat(65)}` })
      .expect(403);
    const submitted = await request(app)
      .post("/api/v1/commands")
      .set("authorization", "Bearer marketplace-actor")
      .send(command())
      .expect(202);
    const result = z
      .object({ result: z.object({ status: z.literal("submitted"), transactionHash: z.string() }) })
      .parse(submitted.body);
    expect(result.result.transactionHash).toBe(transactionHash);
    expect(execute).toHaveBeenCalledTimes(1);

    await request(app)
      .get("/api/v1/query/marketplace")
      .set("authorization", "Bearer marketplace-actor")
      .query({ listing_id: listingId })
      .expect(200);
    expect(query).toHaveBeenCalledWith({ listingId });
  });

  it("replays an identical command idempotently and rejects changed or expired commands", async () => {
    const execute = vi.fn(() => Promise.resolve(transactionHash));
    const gateway = new MarketplaceCommandGateway(
      () => true,
      execute,
      () => 150,
    );
    expect(await gateway.submit(command())).toEqual(await gateway.submit(command()));
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(
      gateway.submit({ ...command(), payload: { listing_id: listingId, changed: true } }),
    ).rejects.toMatchObject({ code: "conflict" });
    const expired = command(urn("command", 9));
    await expect(gateway.submit({ ...expired, expires_at: 150 })).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("keeps query routes read-only and rejects ambiguous IDs", async () => {
    const query = vi.fn(() => Promise.resolve({ state: "active" }));
    const app = createApp({
      appEnvironment: "test",
      marketplace: {
        authorize: () => true,
        gateway: new MarketplaceCommandGateway(
          () => true,
          () => Promise.resolve(transactionHash),
        ),
        query,
      },
    });
    await request(app).get("/api/v1/query/marketplace").expect(400);
    await request(app)
      .get("/api/v1/query/marketplace")
      .query({ listing_id: listingId, offer_id: urn("offer", 2) })
      .expect(400);
    expect(query).not.toHaveBeenCalled();
  });

  it("blocks buyer confirmation when the scoped agreement grant is not currently usable", async () => {
    const gateway = new MarketplaceCommandGateway(
      () => true,
      () => Promise.resolve(transactionHash),
      () => 150,
      (candidate) =>
        candidate.kind !== "confirm-agreement" || candidate.payload.grant_state === "active",
    );
    const confirmation = {
      ...command(urn("command", 8)),
      kind: "confirm-agreement",
      payload: { agreement_id: urn("agreement", 8), grant_state: "revoked" },
    };
    await expect(gateway.submit(confirmation)).rejects.toMatchObject({ code: "signature" });
    await expect(
      gateway.submit({
        ...confirmation,
        payload: { ...confirmation.payload, grant_state: "active" },
      }),
    ).resolves.toMatchObject({ status: "submitted" });
  });
});

const listingId = urn("listing", 1);
const signature = `0x${"22".repeat(65)}`;
const transactionHash = `0x${"33".repeat(32)}`;

function command(commandId = urn("command", 1)) {
  return {
    schema: "EVLLM_MARKETPLACE_COMMAND_V1",
    command_id: commandId,
    kind: "create-listing",
    signer_actor_id: urn("actor", 2),
    signer_organization_id: urn("org", 3),
    signer_credential_id: urn("credential", 4),
    signer_address: "0x1111111111111111111111111111111111111111",
    issued_at: 100,
    expires_at: 200,
    nonce: `0x${"00".repeat(31)}01`,
    idempotency_key_hash: `0x${"44".repeat(32)}`,
    payload: { listing_id: listingId },
    signature,
  };
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
