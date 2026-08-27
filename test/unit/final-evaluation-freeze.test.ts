import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isFormalAccessPermitted, type FormalCase } from "../../src/evaluation/formal.js";

import { OPENAI_ASSISTANT_CONFIG } from "../../src/assistant/model.js";
import {
  COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP,
  COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS,
} from "../../src/evaluation/complementary-metrics.js";
import {
  FINAL_PRIMARY_CONDITIONS,
  FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES,
  FINAL_PRIMARY_OUTCOMES,
  FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES,
  FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL,
  FINAL_SYNTHESIS_CONDITIONS,
  FINAL_SYNTHESIS_PRIMARY_METRICS,
  FINAL_TRANSPORT_RETRIES,
} from "../../src/evaluation/final-freeze.js";
import {
  assertPrimaryFreezeProtocol,
  assertSynthesisFreezeProtocol,
} from "../../src/evaluation/final-freeze-validation.js";

describe("final evaluation freeze", () => {
  it("binds fresh primary and synthesis corpora before collection", () => {
    for (const [freezeName, corpusName, expectedCases] of [
      ["primary-freeze.json", "primary-corpus.json", 96],
      ["synthesis-freeze.json", "synthesis-corpus.json", 30],
    ] as const) {
      const freeze = JSON.parse(
        readFileSync(resolve(`evaluation/final/${freezeName}`), "utf8"),
      ) as Record<string, unknown> & {
        formalOutputsCollected?: boolean;
        outputsCollected?: boolean;
        model?: Record<string, unknown>;
        taskCorpus?: { corpusFileSha256: string; logicalCorpusSha256: string };
        corpus?: { corpusFileSha256: string; logicalCorpusSha256: string };
      };
      const corpusBytes = readFileSync(resolve(`evaluation/final/${corpusName}`));
      const corpus = JSON.parse(corpusBytes.toString("utf8")) as {
        case_count: number;
        corpus_sha256: string;
      };
      const binding = freeze.taskCorpus ?? freeze.corpus;
      expect(freeze.formalOutputsCollected ?? freeze.outputsCollected).toBe(false);
      expect(freeze.model).toMatchObject(OPENAI_ASSISTANT_CONFIG);
      expect(corpus.case_count).toBe(expectedCases);
      expect(binding?.logicalCorpusSha256).toBe(corpus.corpus_sha256);
      expect(binding?.corpusFileSha256).toBe(
        `0x${createHash("sha256").update(corpusBytes).digest("hex")}`,
      );
    }
  });

  it("uses the implemented six-component route assessment rather than an overall score", () => {
    const corpus = JSON.parse(
      readFileSync(resolve("evaluation/final/synthesis-corpus.json"), "utf8"),
    ) as {
      cases: Array<{
        stratum: string;
        prompt: string;
        records: Array<{
          content: string;
          recorded_decision?: {
            outcome: string;
            code: string;
            reason_codes: string[];
          };
        }>;
      }>;
    };
    const routeCases = corpus.cases.filter(({ stratum }) => stratum === "route-comparison");
    expect(routeCases).toHaveLength(5);
    for (const item of routeCases) {
      const text = [item.prompt, ...item.records.map(({ content }) => content)].join(" ");
      expect(text).toContain("continued compatible EV use");
      expect(text).toContain("stationary-storage repurposing");
      expect(text).toContain("recycling");
      expect(text).toContain("G=PASS");
      expect(text).toContain("C=");
      expect(text).toContain("I=[");
      expect(text).toContain("E=NPV");
      expect(text).toContain("A=usable-field coverage");
      expect(text).toContain("U=eligibility-pass frequency");
      expect(text).toContain("no overall sustainability score");
      expect(text).not.toContain("remanufacturing route score");
      expect(item.prompt).toContain("Battery SYN-");
      expect(item.prompt).toContain("three recorded routes");
      expect(item.prompt).toContain("six components separately");
      expect(item.prompt).toContain("G is the technical and safety gate");
      expect(item.prompt).toContain("C is circularity");
      expect(item.prompt).toContain("I contains the environmental indicators");
      expect(item.prompt).toContain("E is economics");
      expect(item.prompt).toContain("A is information adequacy");
      expect(item.prompt).toContain("U is uncertainty");
      const decisions = item.records.flatMap(({ recorded_decision: decision }) =>
        decision === undefined ? [] : [decision],
      );
      expect(decisions).toEqual([
        {
          outcome: "answer",
          code: "continued-compatible-ev-use-preferred",
          reason_codes: [],
        },
      ]);
    }
  });

  it("binds reader-facing raw diagnostics to retained machine-artifact fields", () => {
    const freeze = JSON.parse(
      readFileSync(resolve("evaluation/final/synthesis-freeze.json"), "utf8"),
    ) as {
      rawGenerationDiagnostics: unknown;
      rawGenerationDiagnosticFieldMap: unknown;
    };
    expect(freeze.rawGenerationDiagnostics).toEqual(COMPLEMENTARY_RAW_GENERATION_DIAGNOSTICS);
    expect(freeze.rawGenerationDiagnosticFieldMap).toEqual(COMPLEMENTARY_RAW_DIAGNOSTIC_FIELD_MAP);
  });

  it("freezes and validates the exact conditions, metrics, and retry policies", () => {
    const primary = JSON.parse(
      readFileSync(resolve("evaluation/final/primary-freeze.json"), "utf8"),
    ) as Parameters<typeof assertPrimaryFreezeProtocol>[0];
    const synthesis = JSON.parse(
      readFileSync(resolve("evaluation/final/synthesis-freeze.json"), "utf8"),
    ) as Parameters<typeof assertSynthesisFreezeProtocol>[0];

    expect(primary.conditions).toEqual(FINAL_PRIMARY_CONDITIONS);
    expect(primary.primaryOutcomes).toEqual(FINAL_PRIMARY_OUTCOMES);
    expect(primary.analysis.pairedContrastOutcomes).toEqual(FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES);
    expect(primary.analysis.descriptiveOutcomes).toEqual(FINAL_PRIMARY_DESCRIPTIVE_OUTCOMES);
    expect(primary.taskSuccessReasonSemantics).toEqual(FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL);
    expect(primary.model.maximumTransportRetriesPerInvocation).toBe(FINAL_TRANSPORT_RETRIES);
    expect(synthesis.conditions).toEqual(FINAL_SYNTHESIS_CONDITIONS);
    expect(synthesis.primaryMetrics).toEqual(FINAL_SYNTHESIS_PRIMARY_METRICS);
    expect(synthesis.model.transportRetries).toBe(FINAL_TRANSPORT_RETRIES);
    expect(() => assertPrimaryFreezeProtocol(primary)).not.toThrow();
    expect(() => assertSynthesisFreezeProtocol(synthesis)).not.toThrow();

    expect(() =>
      assertPrimaryFreezeProtocol({
        ...primary,
        conditions: [...FINAL_PRIMARY_CONDITIONS].reverse(),
      }),
    ).toThrow(/condition list/u);
    expect(() =>
      assertSynthesisFreezeProtocol({
        ...synthesis,
        primaryMetrics: FINAL_SYNTHESIS_PRIMARY_METRICS.slice(0, -1),
      }),
    ).toThrow(/primary metric list/u);
    expect(() =>
      assertPrimaryFreezeProtocol({
        ...primary,
        taskSuccessReasonSemantics: {
          ...FINAL_PRIMARY_TASK_SUCCESS_REASON_PROTOCOL,
          internalValidationCodes: "required-for-task-success",
        },
      }),
    ).toThrow(/task-success reason semantics/u);
    expect(() =>
      assertPrimaryFreezeProtocol({
        ...primary,
        analysis: {
          ...primary.analysis,
          pairedContrastOutcomes: FINAL_PRIMARY_PAIRED_CONTRAST_OUTCOMES.slice(0, -1),
        },
      }),
    ).toThrow(/paired-contrast outcome list/u);
  });

  it("wires a synthesis preflight that does not construct or require a model client", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const preflightSource = readFileSync(
      resolve("scripts/preflight-complementary-evaluation.ts"),
      "utf8",
    );
    expect(packageJson.scripts["evaluation:final:preflight"]).toContain(
      "evaluation:final:preflight:synthesis",
    );
    expect(packageJson.scripts["evaluation:final:preflight:synthesis"]).toContain(
      "preflight-complementary-evaluation.ts",
    );
    expect(preflightSource).not.toContain("OpenAIAssistantModel");
    expect(preflightSource).not.toContain("OPENAI_API_KEY");
  });

  it("binds every denied-authority case to an access-denied result", () => {
    const corpus = JSON.parse(
      readFileSync(resolve("evaluation/final/primary-corpus.json"), "utf8"),
    ) as { cases: FormalCase[] };
    const denied = corpus.cases.filter((item) => !isFormalAccessPermitted(item));
    expect(denied).toHaveLength(13);
    expect(
      denied.every(({ expected_validation_code }) => expected_validation_code === "access-denied"),
    ).toBe(true);
  });
});
