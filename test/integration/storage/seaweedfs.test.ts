import { S3Client } from "@aws-sdk/client-s3";
import { describe } from "vitest";

import { S3ObjectStore } from "../../../src/protected-bundles/storage/index.js";
import { runOpaqueObjectStoreConformance } from "../../support/storage-conformance.js";

const enabled = process.env.RUN_STORAGE_INTEGRATION === "1";
const integrationDescribe = enabled ? describe : describe.skip;
const orgA = "urn:evllm:org:123e4567-e89b-42d3-a456-426614174000";
const orgB = "urn:evllm:org:223e4567-e89b-42d3-a456-426614174000";
const maxObjectBytes = 1024;

function client(endpoint: string, accessKeyId: string, secretAccessKey: string): S3Client {
  return new S3Client({
    credentials: { accessKeyId, secretAccessKey },
    endpoint,
    forcePathStyle: true,
    region: "us-east-1",
  });
}

integrationDescribe("SeaweedFS reference adapter", () => {
  const stores = new Map([
    [
      orgA,
      new S3ObjectStore({
        bucket: "evllm",
        client: client(
          process.env.EVLLM_ORG_A_S3_ENDPOINT ?? "http://127.0.0.1:18333",
          process.env.EVLLM_ORG_A_S3_ACCESS_KEY ?? "",
          process.env.EVLLM_ORG_A_S3_SECRET_KEY ?? "",
        ),
        maxObjectBytes,
        organizationId: orgA,
      }),
    ],
    [
      orgB,
      new S3ObjectStore({
        bucket: "evllm",
        client: client(
          process.env.EVLLM_ORG_B_S3_ENDPOINT ?? "http://127.0.0.1:28333",
          process.env.EVLLM_ORG_B_S3_ACCESS_KEY ?? "",
          process.env.EVLLM_ORG_B_S3_SECRET_KEY ?? "",
        ),
        maxObjectBytes,
        organizationId: orgB,
      }),
    ],
  ]);

  runOpaqueObjectStoreConformance({
    create: (organizationId) => {
      const store = stores.get(organizationId);
      if (store === undefined) throw new Error("Unknown test organization");
      return store;
    },
    maxObjectBytes,
    organizations: [orgA, orgB],
  });
});
