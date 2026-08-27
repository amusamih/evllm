import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe } from "vitest";

import {
  FilesystemObjectStore,
  MemoryObjectStoreBackend,
  type OpaqueObjectStore,
} from "../../src/protected-bundles/storage/index.js";
import { runOpaqueObjectStoreConformance } from "../support/storage-conformance.js";

const orgA = "urn:evllm:org:123e4567-e89b-42d3-a456-426614174000";
const orgB = "urn:evllm:org:223e4567-e89b-42d3-a456-426614174000";
const maxObjectBytes = 1024;

describe("memory object-store adapter", () => {
  const backend = new MemoryObjectStoreBackend();
  runOpaqueObjectStoreConformance({
    create: (organizationId) => backend.forOrganization(organizationId, { maxObjectBytes }),
    maxObjectBytes,
    organizations: [orgA, orgB],
  });
});

describe("filesystem object-store adapter", () => {
  let rootDirectory = "";

  beforeAll(async () => {
    rootDirectory = await mkdtemp(join(tmpdir(), "evllm-object-store-"));
  });

  afterAll(async () => {
    await rm(rootDirectory, { force: true, recursive: true });
  });

  runOpaqueObjectStoreConformance({
    create: (organizationId): OpaqueObjectStore =>
      new FilesystemObjectStore(organizationId, { maxObjectBytes, rootDirectory }),
    maxObjectBytes,
    organizations: [orgA, orgB],
  });
});
