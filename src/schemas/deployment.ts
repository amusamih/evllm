import { z } from "zod";

import { bytes32Hex, canonicalAddress } from "./common.js";

export const deploymentReceipt = z
  .object({
    schema: z.literal("EVLLM_DEPLOYMENT_RECEIPT_V1"),
    network: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
    chain_id: z.string().regex(/^[1-9][0-9]*$/u),
    deployed_at: z.string().datetime({ offset: true }),
    artifact_manifest_sha256: bytes32Hex,
    deployer: canonicalAddress,
    governance: canonicalAddress,
    review_delay_seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contracts: z
      .object({
        AuthorityProfileRegistry: canonicalAddress,
        ProtectedBundleRegistry: canonicalAddress,
        BatteryOwnershipRegistry: canonicalAddress,
        DeploymentRegistry: canonicalAddress,
        EvidenceRegistry: canonicalAddress,
        Marketplace: canonicalAddress,
        AuditAnchor: canonicalAddress,
      })
      .strict(),
  })
  .strict();
