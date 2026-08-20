import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface FrozenActor {
  actorId: string;
}
interface FrozenEvaluation {
  schema: string;
  formalOutputsCollected: boolean;
  pilotOutputsAreFormalEvidence: boolean;
  model: Record<string, unknown>;
  researchQuestions: unknown[];
  conditions: unknown[];
  primaryOutcomes: unknown[];
  scriptedActors: FrozenActor[];
  taskCorpus: { logicalCorpusSha256: string };
  systemProfile: {
    artifactHashes: Record<string, string>;
    images: Record<"postgres" | "seaweedfs" | "slither", string>;
  };
}
interface FrozenCase {
  case_id: string;
  stratum: string;
  formal_only: boolean;
  prompt: string;
  applicable_conditions: unknown[];
  supports: unknown[];
}
interface FrozenCorpus {
  schema: string;
  generated_after_pilot_freeze: boolean;
  case_count: number;
  strata: string[];
  cases: FrozenCase[];
  corpus_sha256: string;
}

const freeze = JSON.parse(
  readFileSync(resolve("evaluation/formal/evaluation-freeze-v1.json"), "utf8"),
) as FrozenEvaluation;
const corpus = JSON.parse(
  readFileSync(resolve("evaluation/formal/task-corpus-v1.json"), "utf8"),
) as FrozenCorpus;

describe("formal evaluation freeze", () => {
  it("freezes the model, conditions, repetitions, outcomes, analysis and non-formal pilot boundary", () => {
    expect(freeze.schema).toBe("EVLLM_FORMAL_EVALUATION_FREEZE_V1");
    expect(freeze.formalOutputsCollected).toBe(false);
    expect(freeze.pilotOutputsAreFormalEvidence).toBe(false);
    expect(freeze.model).toMatchObject({
      model: "gpt-4o-mini-2024-07-18",
      store: false,
      temperature: 0,
      repetitionsPerStochasticCondition: 5,
    });
    expect(freeze.researchQuestions).toHaveLength(3);
    expect(freeze.conditions).toHaveLength(7);
    expect(freeze.primaryOutcomes).toHaveLength(8);
    expect(freeze.scriptedActors).toHaveLength(9);
    expect(new Set(freeze.scriptedActors.map((actor) => actor.actorId)).size).toBe(9);
  });

  it("contains a fresh balanced 96-case held-out corpus with executable ground truth", () => {
    expect(corpus.schema).toBe("EVLLM_FORMAL_TASK_CORPUS_V1");
    expect(corpus.generated_after_pilot_freeze).toBe(true);
    expect(corpus.case_count).toBe(96);
    expect(corpus.cases).toHaveLength(96);
    expect(new Set(corpus.cases.map((item) => item.case_id)).size).toBe(96);
    for (const stratum of corpus.strata) {
      expect(corpus.cases.filter((item) => item.stratum === stratum)).toHaveLength(8);
    }
    for (const item of corpus.cases) {
      expect(item.formal_only).toBe(true);
      expect(item.prompt.length).toBeGreaterThan(20);
      expect(item.applicable_conditions).toHaveLength(7);
      expect(Array.isArray(item.supports)).toBe(true);
    }
    const { corpus_sha256: recorded, ...unsigned } = corpus;
    const computed = `0x${createHash("sha256").update(JSON.stringify(unsigned)).digest("hex")}`;
    expect(recorded).toBe(computed);
    expect(freeze.taskCorpus.logicalCorpusSha256).toBe(computed);
  });

  it("pins every declared implementation/profile artifact and repository image", () => {
    const hashes = freeze.systemProfile.artifactHashes;
    expect(Object.values(hashes).every((value) => /^0x[0-9a-f]{64}$/u.test(value))).toBe(true);
    const files: Record<string, string> = {
      solidityManifestSha256: "contracts/generated/solidity/manifest.json",
      openApiSha256: "contracts/generated/openapi.json",
      eip712ProfilesSha256: "contracts/generated/eip712/profiles.json",
      governanceActionsSha256: "contracts/generated/governance/actions.json",
      centralComposeSha256: "infra/docker-compose.yml",
      storageTestComposeSha256: "infra/docker-compose.storage-test.yml",
      formalTopologyComposeSha256: "infra/docker-compose.formal.yml",
    };
    for (const [name, path] of Object.entries(files)) {
      const computed = `0x${createHash("sha256")
        .update(readFileSync(resolve(path)))
        .digest("hex")}`;
      expect(hashes[name], name).toBe(computed);
    }
    const corpusFileHash = `0x${createHash("sha256")
      .update(readFileSync(resolve("evaluation/formal/task-corpus-v1.json")))
      .digest("hex")}`;
    expect(corpusFileHash).toBe(
      "0x0ff27f482e878b300dc4a115c23b648075409d4fd64e2d3530db6bacc1b36bd7",
    );
    expect(freeze.systemProfile.images.postgres).toContain("@sha256:");
    expect(freeze.systemProfile.images.seaweedfs).toContain("@sha256:");
    expect(freeze.systemProfile.images.slither).toContain("@sha256:");
  });
});
