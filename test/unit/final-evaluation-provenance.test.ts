import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildFinalEvaluationFreezes,
  jsonFileBytes,
  sha256Bytes,
  sha256Json,
  type CorpusBinding,
} from "../../src/evaluation/final-freeze.js";
import {
  assertExactObservationPlan,
  assertFinalEvaluationIntegrity,
  assertObservationEvaluationBinding,
  type EvaluationBinding,
  type FinalEvaluationBranchInput,
} from "../../src/evaluation/final-integrity.js";
import {
  assertEvaluationSourceCommit,
  assertEvaluationSourceState,
  unexpectedEvaluationSourcePaths,
} from "../../scripts/lib/evaluation-source.js";
import {
  generatedFormalFreeze,
  generatedRegulatorySourceBindings,
} from "../../scripts/generate-evaluation-corpus.js";

describe("final evaluation provenance", () => {
  it("builds deterministic freezes with one content-derived evaluation set ID", () => {
    const primary = binding("evaluation/final/primary-corpus.json", "a", 96, 12);
    const synthesis = binding("evaluation/final/synthesis-corpus.json", "b", 30, 6);
    const first = buildFinalEvaluationFreezes(
      primary,
      synthesis,
      generatedRegulatorySourceBindings,
      generatedFormalFreeze.sampleDesign,
    );
    const second = buildFinalEvaluationFreezes(
      primary,
      synthesis,
      generatedRegulatorySourceBindings,
      generatedFormalFreeze.sampleDesign,
    );
    expect(first).toEqual(second);
    expect(first.evaluationSetId).toMatch(/^evllm-final-evaluation-v2-[0-9a-f]{16}$/u);
    expect(first.primary).toMatchObject({ evaluation_set_id: first.evaluationSetId });
    expect(first.primary).toMatchObject({ regulatorySources: generatedRegulatorySourceBindings });
    expect(first.synthesis).toMatchObject({ evaluation_set_id: first.evaluationSetId });
    expect(jsonFileBytes(first.primary)).toEqual(jsonFileBytes(second.primary));
  });

  it("allows result changes while rejecting source changes", () => {
    expect(
      unexpectedEvaluationSourcePaths(
        [
          "evaluation/final/results/primary/observations.jsonl",
          "evaluation\\final\\results\\synthesis\\progress.json",
          "src/assistant/service.ts",
        ],
        ["evaluation/final/results/primary", "evaluation/final/results/synthesis"],
      ),
    ).toEqual(["src/assistant/service.ts"]);
    expect(() =>
      assertEvaluationSourceState(
        [],
        ["evaluation/final/results/primary/observations.jsonl"],
        ["evaluation/final/results"],
      ),
    ).not.toThrow();
    expect(() =>
      assertEvaluationSourceState(
        [],
        ["evaluation/final/results/primary/observations.jsonl", "src/assistant/service.ts"],
        ["evaluation/final/results"],
      ),
    ).toThrow(/source changes outside the result directories/u);
    expect(() =>
      assertEvaluationSourceState(
        ["evaluation/final/results/primary/observations.jsonl"],
        [],
        ["evaluation/final/results"],
      ),
    ).toThrow(/requires a clean index/u);
  });

  it("requires analysis and report generation to use the collection commit", () => {
    const commit = "a".repeat(40);
    expect(() => assertEvaluationSourceCommit(commit, commit, "Primary analysis")).not.toThrow();
    expect(() => assertEvaluationSourceCommit("b".repeat(40), commit, "Primary analysis")).toThrow(
      /Primary analysis requires the checked-out source commit/u,
    );
  });

  it("rejects a single observation whose provenance differs from its run", () => {
    const expected: EvaluationBinding = {
      evaluation_set_id: "set-1",
      source_commit: "a".repeat(40),
      freeze_sha256: `0x${"11".repeat(32)}`,
      corpus_file_sha256: `0x${"22".repeat(32)}`,
      logical_corpus_sha256: `0x${"33".repeat(32)}`,
    };
    expect(() =>
      assertObservationEvaluationBinding(
        "observation-1",
        { ...expected, corpus_file_sha256: `0x${"44".repeat(32)}` },
        expected,
      ),
    ).toThrow(/Observation observation-1 has a mismatched corpus_file_sha256/u);
  });

  it("requires the exact planned observation IDs and cells", () => {
    const plan = [
      {
        observation_id: "case-1:condition-a:1",
        case_id: "case-1",
        configuration_id: "condition-a",
        repetition: 1,
      },
      {
        observation_id: "case-1:condition-a:2",
        case_id: "case-1",
        configuration_id: "condition-a",
        repetition: 2,
      },
    ];
    expect(() => assertExactObservationPlan("Primary", plan, plan)).not.toThrow();
    expect(() => assertExactObservationPlan("Primary", plan.slice(0, 1), plan)).toThrow(
      /observation IDs do not match the frozen plan/u,
    );
    expect(() =>
      assertExactObservationPlan("Primary", [{ ...plan[0]!, repetition: 2 }, plan[1]!], plan),
    ).toThrow(/mismatched repetition/u);
  });

  it("accepts one exact source snapshot and rejects mixed commits, set IDs, and hashes", () => {
    const fixture = integrityFixture();
    expect(assertFinalEvaluationIntegrity(fixture.primary, fixture.synthesis)).toMatchObject({
      evaluation_set_id: fixture.evaluationSetId,
      source_commit: "a".repeat(40),
    });

    expect(() =>
      assertFinalEvaluationIntegrity(fixture.primary, {
        ...fixture.synthesis,
        runSummary: { ...fixture.synthesis.runSummary, source_commit: "b".repeat(40) },
      }),
    ).toThrow(/source_commit/u);
    const otherCommit = remapBinding(fixture.synthesis, {
      source_commit: "b".repeat(40),
    });
    expect(() => assertFinalEvaluationIntegrity(fixture.primary, otherCommit)).toThrow(
      /different source commits/u,
    );
    expect(() =>
      assertFinalEvaluationIntegrity(fixture.primary, {
        ...fixture.synthesis,
        configManifest: {
          ...fixture.synthesis.configManifest,
          evaluation_set_id: "different-set",
        },
      }),
    ).toThrow(/evaluation_set_id/u);
    const otherSet = remapBinding(fixture.synthesis, {
      evaluation_set_id: "different-set",
    });
    const otherSetFreeze = JSON.parse(Buffer.from(otherSet.freezeBytes).toString("utf8")) as Record<
      string,
      unknown
    >;
    const freezeBytes = jsonFileBytes({ ...otherSetFreeze, evaluation_set_id: "different-set" });
    const internallyConsistentOtherSet = remapBinding(
      { ...otherSet, freezeBytes },
      { freeze_sha256: sha256Bytes(freezeBytes) },
    );
    expect(() =>
      assertFinalEvaluationIntegrity(fixture.primary, internallyConsistentOtherSet),
    ).toThrow(/non-reproducible evaluation set ID/u);
    expect(() =>
      assertFinalEvaluationIntegrity(fixture.primary, {
        ...fixture.synthesis,
        configManifest: {
          ...fixture.synthesis.configManifest,
          corpus_file_sha256: `0x${"ff".repeat(32)}`,
        },
      }),
    ).toThrow(/corpus_file_sha256/u);
    expect(() =>
      assertFinalEvaluationIntegrity(fixture.primary, {
        ...fixture.synthesis,
        transportJournalBytes: Buffer.from("modified transport journal\n", "utf8"),
      }),
    ).toThrow(/transport-attempt journal digest/u);
    const mixedObservation = JSON.parse(
      Buffer.from(fixture.synthesis.observationBytes).toString("utf8"),
    ) as Record<string, unknown>;
    const mixedObservationBytes = Buffer.from(
      `${JSON.stringify({ ...mixedObservation, source_commit: "b".repeat(40) })}\n`,
      "utf8",
    );
    expect(() =>
      assertFinalEvaluationIntegrity(fixture.primary, {
        ...fixture.synthesis,
        observationBytes: mixedObservationBytes,
        analysis: {
          integrity: {
            ...fixture.synthesis.analysis.integrity,
            observations_sha256: sha256Bytes(mixedObservationBytes),
          },
        },
      }),
    ).toThrow(/Observation synthesis-observation has a mismatched source_commit/u);
    expect(() =>
      assertFinalEvaluationIntegrity(
        {
          ...fixture.primary,
          regulatorySourceFiles: fixture.primary.regulatorySourceFiles!.map((file) => ({
            ...file,
            bytes: Buffer.from(`${Buffer.from(file.bytes).toString("utf8")} `, "utf8"),
          })),
        },
        fixture.synthesis,
      ),
    ).toThrow(/regulatory-source file has a mismatched digest/u);

    expect(() =>
      assertFinalEvaluationIntegrity(
        {
          ...fixture.primary,
          analysis: {
            integrity: {
              ...fixture.primary.analysis.integrity,
              analysis_source_commit: "b".repeat(40),
            },
          },
        },
        fixture.synthesis,
      ),
    ).toThrow(/analysis was generated by a different source commit/u);
  });
});

function integrityFixture(): {
  evaluationSetId: string;
  primary: FinalEvaluationBranchInput;
  synthesis: FinalEvaluationBranchInput;
} {
  const primaryCorpus = corpus("primary");
  const synthesisCorpus = corpus("synthesis");
  const primaryCorpusBytes = jsonFileBytes(primaryCorpus);
  const synthesisCorpusBytes = jsonFileBytes(synthesisCorpus);
  const freezes = buildFinalEvaluationFreezes(
    bindingFromBytes("evaluation/final/primary-corpus.json", primaryCorpus, primaryCorpusBytes),
    bindingFromBytes(
      "evaluation/final/synthesis-corpus.json",
      synthesisCorpus,
      synthesisCorpusBytes,
    ),
    generatedRegulatorySourceBindings,
    generatedFormalFreeze.sampleDesign,
  );
  return {
    evaluationSetId: freezes.evaluationSetId,
    primary: branch(
      "primary",
      freezes.evaluationSetId,
      jsonFileBytes(freezes.primary),
      primaryCorpusBytes,
      [
        {
          path: generatedRegulatorySourceBindings[0]!.path,
          bytes: readFileSync(resolve(generatedRegulatorySourceBindings[0]!.path)),
        },
      ],
    ),
    synthesis: branch(
      "synthesis",
      freezes.evaluationSetId,
      jsonFileBytes(freezes.synthesis),
      synthesisCorpusBytes,
    ),
  };
}

function remapBinding(
  branchInput: FinalEvaluationBranchInput,
  changes: Partial<EvaluationBinding>,
): FinalEvaluationBranchInput {
  const observationBytes = Buffer.from(
    Buffer.from(branchInput.observationBytes)
      .toString("utf8")
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.stringify({ ...(JSON.parse(line) as object), ...changes }))
      .join("\n") + "\n",
    "utf8",
  );
  return {
    ...branchInput,
    observationBytes,
    configManifest: { ...branchInput.configManifest, ...changes },
    runSummary: { ...branchInput.runSummary, ...changes },
    analysis: {
      integrity: {
        ...branchInput.analysis.integrity,
        ...changes,
        analysis_source_commit:
          changes.source_commit ?? branchInput.analysis.integrity.analysis_source_commit,
        observations_sha256: sha256Bytes(observationBytes),
      },
    },
  };
}

function branch(
  label: "primary" | "synthesis",
  evaluationSetId: string,
  freezeBytes: Uint8Array,
  corpusBytes: Uint8Array,
  regulatorySourceFiles?: FinalEvaluationBranchInput["regulatorySourceFiles"],
): FinalEvaluationBranchInput {
  const corpus = JSON.parse(Buffer.from(corpusBytes).toString("utf8")) as {
    corpus_sha256: string;
  };
  const binding: EvaluationBinding = {
    evaluation_set_id: evaluationSetId,
    source_commit: "a".repeat(40),
    freeze_sha256: sha256Bytes(freezeBytes),
    corpus_file_sha256: sha256Bytes(corpusBytes),
    logical_corpus_sha256: corpus.corpus_sha256,
  };
  const observationBytes = Buffer.from(
    `${JSON.stringify({ observation_id: `${label}-observation`, ...binding })}\n`,
    "utf8",
  );
  const transportJournalBytes = Buffer.from(`${label}-transport-journal\n`, "utf8");
  const transportAttemptJournalSha256 = sha256Bytes(transportJournalBytes);
  return {
    label,
    freezeBytes,
    corpusBytes,
    observationBytes,
    transportJournalBytes,
    ...(regulatorySourceFiles === undefined ? {} : { regulatorySourceFiles }),
    configManifest: binding,
    runSummary: {
      ...binding,
      transport_attempt_journal_sha256: transportAttemptJournalSha256,
    },
    analysis: {
      integrity: {
        ...binding,
        analysis_source_commit: binding.source_commit,
        observations_sha256: sha256Bytes(observationBytes),
        transport_attempt_journal_sha256: transportAttemptJournalSha256,
      },
    },
  };
}

function corpus(name: string): Record<string, unknown> & { corpus_sha256: string } {
  const unsigned = { schema: `${name}-corpus`, case_count: 1, strata: ["nominal"], cases: [{}] };
  return { ...unsigned, corpus_sha256: sha256Json(unsigned) };
}

function bindingFromBytes(
  path: string,
  value: { corpus_sha256: string },
  bytes: Uint8Array,
): CorpusBinding {
  return {
    path,
    caseCount: 1,
    strataCount: 1,
    casesPerStratum: 1,
    logicalCorpusSha256: value.corpus_sha256,
    corpusFileSha256: sha256Bytes(bytes),
  };
}

function binding(
  path: string,
  marker: string,
  caseCount: number,
  strataCount: number,
): CorpusBinding {
  return {
    path,
    caseCount,
    strataCount,
    casesPerStratum: caseCount / strataCount,
    logicalCorpusSha256: `0x${marker.repeat(64)}`,
    corpusFileSha256: `0x${marker.repeat(64)}`,
  };
}
