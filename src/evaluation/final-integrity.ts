import {
  finalEvaluationSetId,
  sha256Bytes,
  sha256Json,
  type CorpusBinding,
  type RegulatorySourceBinding,
} from "./final-freeze.js";

export interface FinalEvaluationBranchInput {
  readonly label: "primary" | "synthesis";
  readonly freezeBytes: Uint8Array;
  readonly corpusBytes: Uint8Array;
  readonly observationBytes: Uint8Array;
  readonly transportJournalBytes: Uint8Array;
  readonly regulatorySourceFiles?: ReadonlyArray<{
    readonly path: string;
    readonly bytes: Uint8Array;
  }>;
  readonly configManifest: EvaluationBinding;
  readonly runSummary: EvaluationBinding & {
    readonly transport_attempt_journal_sha256: string;
  };
  readonly analysis: {
    readonly integrity: EvaluationBinding & {
      readonly analysis_source_commit: string;
      readonly observations_sha256: string;
      readonly transport_attempt_journal_sha256: string;
    };
  };
}

export interface EvaluationBinding {
  readonly evaluation_set_id: string;
  readonly source_commit: string;
  readonly freeze_sha256: string;
  readonly corpus_file_sha256: string;
  readonly logical_corpus_sha256: string;
}

export interface EvaluationObservationBinding {
  readonly evaluation_set_id?: string | undefined;
  readonly source_commit?: string;
  readonly freeze_sha256?: string | undefined;
  readonly corpus_file_sha256?: string | undefined;
  readonly logical_corpus_sha256?: string | undefined;
}

export interface EvaluationObservationCell {
  readonly observation_id: string;
  readonly case_id: string;
  readonly repetition: number;
  readonly configuration_id?: string;
}

export interface FinalEvaluationIntegrity {
  readonly evaluation_set_id: string;
  readonly source_commit: string;
  readonly primary: BranchIntegrity;
  readonly synthesis: BranchIntegrity;
}

interface BranchIntegrity extends EvaluationBinding {
  readonly observations_sha256: string;
  readonly transport_attempt_journal_sha256: string;
}

export function assertFinalEvaluationIntegrity(
  primaryInput: FinalEvaluationBranchInput,
  synthesisInput: FinalEvaluationBranchInput,
): FinalEvaluationIntegrity {
  const primaryFreeze = parseFreeze(primaryInput.freezeBytes);
  const synthesisFreeze = parseFreeze(synthesisInput.freezeBytes);
  if (
    primaryFreeze.taskCorpus === undefined ||
    synthesisFreeze.corpus === undefined ||
    primaryFreeze.regulatorySources === undefined
  ) {
    throw new Error("Final freezes lack the inputs needed to reproduce their evaluation set ID");
  }
  const expectedEvaluationSetId = finalEvaluationSetId(
    primaryFreeze.taskCorpus,
    synthesisFreeze.corpus,
    primaryFreeze.regulatorySources,
  );
  equal(
    "primary freeze has a non-reproducible evaluation set ID",
    primaryFreeze.evaluation_set_id,
    expectedEvaluationSetId,
  );
  equal(
    "synthesis freeze has a non-reproducible evaluation set ID",
    synthesisFreeze.evaluation_set_id,
    expectedEvaluationSetId,
  );
  const primary = assertBranchIntegrity(primaryInput);
  const synthesis = assertBranchIntegrity(synthesisInput);
  equal(
    "evaluation branches use different evaluation set IDs",
    primary.evaluation_set_id,
    synthesis.evaluation_set_id,
  );
  equal(
    "evaluation branches use different source commits",
    primary.source_commit,
    synthesis.source_commit,
  );
  return {
    evaluation_set_id: primary.evaluation_set_id,
    source_commit: primary.source_commit,
    primary,
    synthesis,
  };
}

export function assertObservationEvaluationBinding(
  observationId: string,
  observation: EvaluationObservationBinding,
  expected: EvaluationBinding,
): void {
  for (const key of [
    "evaluation_set_id",
    "source_commit",
    "freeze_sha256",
    "corpus_file_sha256",
    "logical_corpus_sha256",
  ] as const) {
    equal(`Observation ${observationId} has a mismatched ${key}`, observation[key], expected[key]);
  }
}

export function assertExactObservationPlan(
  label: string,
  observations: readonly EvaluationObservationCell[],
  plan: readonly EvaluationObservationCell[],
): void {
  const expectedById = uniqueCells(`${label} plan`, plan);
  const observedById = uniqueCells(`${label} observations`, observations);
  const missing = [...expectedById.keys()].filter((id) => !observedById.has(id));
  const unexpected = [...observedById.keys()].filter((id) => !expectedById.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} observation IDs do not match the frozen plan; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
  for (const [observationId, expected] of expectedById) {
    const observed = observedById.get(observationId)!;
    for (const key of ["case_id", "repetition", "configuration_id"] as const) {
      if (observed[key] !== expected[key]) {
        throw new Error(
          `${label} observation ${observationId} has a mismatched ${key}: expected ${String(expected[key])}, received ${String(observed[key])}`,
        );
      }
    }
  }
}

function uniqueCells(
  label: string,
  cells: readonly EvaluationObservationCell[],
): Map<string, EvaluationObservationCell> {
  const output = new Map<string, EvaluationObservationCell>();
  for (const cell of cells) {
    if (output.has(cell.observation_id)) {
      throw new Error(`${label} contains duplicate observation ID ${cell.observation_id}`);
    }
    output.set(cell.observation_id, cell);
  }
  return output;
}

function assertBranchIntegrity(input: FinalEvaluationBranchInput): BranchIntegrity {
  const freeze = parseFreeze(input.freezeBytes);
  const corpus = parseJson(input.corpusBytes) as Record<string, unknown> & {
    corpus_sha256?: string;
  };
  const binding = freeze.taskCorpus ?? freeze.corpus;
  if (freeze.evaluation_set_id === undefined || binding === undefined)
    throw new Error(`${input.label} freeze lacks its V2 provenance binding`);
  if (input.label === "primary") {
    if (freeze.regulatorySources === undefined || freeze.regulatorySources.length === 0)
      throw new Error("primary freeze lacks its regulatory-source bindings");
    assertRegulatorySourceBindings(freeze.regulatorySources, input.regulatorySourceFiles ?? []);
  }
  if (typeof corpus.corpus_sha256 !== "string")
    throw new Error(`${input.label} corpus lacks its logical digest`);

  const unsignedCorpus = { ...corpus };
  delete unsignedCorpus.corpus_sha256;
  const actual = {
    evaluation_set_id: freeze.evaluation_set_id,
    source_commit: input.configManifest.source_commit,
    freeze_sha256: sha256Bytes(input.freezeBytes),
    corpus_file_sha256: sha256Bytes(input.corpusBytes),
    logical_corpus_sha256: sha256Json(unsignedCorpus),
    observations_sha256: sha256Bytes(input.observationBytes),
    transport_attempt_journal_sha256: sha256Bytes(input.transportJournalBytes),
  };
  assertObservationFileBindings(input.label, input.observationBytes, actual);
  equal(
    `${input.label} corpus records a different logical digest`,
    corpus.corpus_sha256,
    actual.logical_corpus_sha256,
  );
  equal(
    `${input.label} freeze has a different logical corpus digest`,
    binding.logicalCorpusSha256,
    actual.logical_corpus_sha256,
  );
  equal(
    `${input.label} freeze has a different corpus file digest`,
    binding.corpusFileSha256,
    actual.corpus_file_sha256,
  );
  assertBinding(`${input.label} configuration manifest`, input.configManifest, actual);
  assertBinding(`${input.label} run summary`, input.runSummary, actual);
  assertBinding(`${input.label} analysis`, input.analysis.integrity, actual);
  equal(
    `${input.label} analysis was generated by a different source commit`,
    input.analysis.integrity.analysis_source_commit,
    actual.source_commit,
  );
  equal(
    `${input.label} analysis has a different observation digest`,
    input.analysis.integrity.observations_sha256,
    actual.observations_sha256,
  );
  equal(
    `${input.label} run summary has a different transport-attempt journal digest`,
    input.runSummary.transport_attempt_journal_sha256,
    actual.transport_attempt_journal_sha256,
  );
  equal(
    `${input.label} analysis has a different transport-attempt journal digest`,
    input.analysis.integrity.transport_attempt_journal_sha256,
    actual.transport_attempt_journal_sha256,
  );
  return actual;
}

function assertObservationFileBindings(
  label: string,
  bytes: Uint8Array,
  expected: EvaluationBinding,
): void {
  const lines = Buffer.from(bytes)
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error(`${label} observation file is empty`);
  for (const [index, line] of lines.entries()) {
    let observation: EvaluationObservationBinding & { observation_id?: string };
    try {
      observation = JSON.parse(line) as EvaluationObservationBinding & {
        observation_id?: string;
      };
    } catch (error) {
      throw new Error(`${label} observation line ${String(index + 1)} is not valid JSON`, {
        cause: error,
      });
    }
    assertObservationEvaluationBinding(
      observation.observation_id ?? `${label}-line-${String(index + 1)}`,
      observation,
      expected,
    );
  }
}

function parseFreeze(bytes: Uint8Array): {
  readonly evaluation_set_id?: string;
  readonly taskCorpus?: CorpusBinding;
  readonly corpus?: CorpusBinding;
  readonly regulatorySources?: RegulatorySourceBinding[];
} {
  return parseJson(bytes) as {
    evaluation_set_id?: string;
    taskCorpus?: CorpusBinding;
    corpus?: CorpusBinding;
    regulatorySources?: RegulatorySourceBinding[];
  };
}

function assertRegulatorySourceBindings(
  bindings: readonly RegulatorySourceBinding[],
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
): void {
  if (bindings.length !== files.length)
    throw new Error("primary regulatory-source file set does not match its freeze");
  const filesByPath = new Map(files.map((file) => [file.path, file.bytes]));
  if (filesByPath.size !== files.length)
    throw new Error("primary regulatory-source file paths are not unique");
  for (const binding of bindings) {
    const bytes = filesByPath.get(binding.path);
    if (bytes === undefined)
      throw new Error(`primary regulatory-source file is missing: ${binding.path}`);
    equal(
      `primary regulatory-source file has a mismatched digest: ${binding.path}`,
      sha256Bytes(bytes),
      binding.fixtureFileSha256,
    );
    const fixture = parseJson(bytes) as {
      fixture_id?: string;
      source?: {
        celex_identifier?: string;
        eli_uri?: string;
        official_eur_lex_uri?: string;
        jurisdiction?: string;
      };
      clauses?: unknown[];
    };
    equal(
      "primary regulatory fixture ID differs from its freeze",
      fixture.fixture_id,
      binding.fixtureId,
    );
    equal(
      "primary regulatory source identifier differs from its freeze",
      fixture.source?.celex_identifier === undefined
        ? undefined
        : `CELEX:${fixture.source.celex_identifier}`,
      binding.sourceIdentifier,
    );
    equal(
      "primary regulatory ELI URI differs from its freeze",
      fixture.source?.eli_uri,
      binding.eliUri,
    );
    equal(
      "primary regulatory EUR-Lex URI differs from its freeze",
      fixture.source?.official_eur_lex_uri,
      binding.officialEurLexUri,
    );
    equal(
      "primary regulatory jurisdiction differs from its freeze",
      fixture.source?.jurisdiction,
      binding.jurisdiction,
    );
    equal(
      "primary regulatory clause count differs from its freeze",
      fixture.clauses?.length,
      binding.clauseCount,
    );
  }
}

function assertBinding(
  label: string,
  binding: EvaluationBinding,
  expected: EvaluationBinding,
): void {
  for (const key of [
    "evaluation_set_id",
    "source_commit",
    "freeze_sha256",
    "corpus_file_sha256",
    "logical_corpus_sha256",
  ] as const) {
    equal(`${label} has a mismatched ${key}`, binding[key], expected[key]);
  }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
}

function equal(message: string, actual: unknown, expected: unknown): void {
  if (actual !== expected)
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
}
