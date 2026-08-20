import { z } from "zod";

import { bytes32Hex, positiveSafeInteger, urn } from "./common.js";

const fixtureSourceClass = z.enum(["public-data-replay", "synthetic-generator", "scripted-report"]);

export const fixtureManifest = z
  .object({
    schema: z.literal("EVLLM_FIXTURE_MANIFEST_V1"),
    fixture_id: urn("source"),
    fixture_version: positiveSafeInteger,
    source_class: fixtureSourceClass,
    source_uri: z.string().url().optional(),
    licence_id: z.string().min(1).optional(),
    generator_id: z.string().min(1).optional(),
    generator_version: z.string().min(1).optional(),
    content_sha256: bytes32Hex,
    derived_from: z.array(urn("source")).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source_class === "public-data-replay" && (!value.source_uri || !value.licence_id)) {
      context.addIssue({
        code: "custom",
        message: "public replay requires source_uri and licence_id",
      });
    }
    if (
      value.source_class !== "public-data-replay" &&
      (!value.generator_id || !value.generator_version)
    ) {
      context.addIssue({
        code: "custom",
        message: "generated fixtures require generator identity/version",
      });
    }
  });

export const evaluationConfigManifest = z
  .object({
    schema: z.literal("EVLLM_EVALUATION_CONFIG_V1"),
    evaluation_id: urn("case"),
    evaluation_version: positiveSafeInteger,
    mode: z.enum(["development", "formal"]),
    frozen: z.boolean(),
    dirty_generated_artifacts: z.boolean(),
    source_commit: z.string().regex(/^[0-9a-f]{40}$/u),
    generated_contracts_sha256: bytes32Hex,
    fixtures: z.array(urn("source")).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "formal" && (!value.frozen || value.dirty_generated_artifacts)) {
      context.addIssue({
        code: "custom",
        message: "formal evaluation requires a frozen config and clean generated artifacts",
      });
    }
  });

export const evaluationRunManifest = z
  .object({
    schema: z.literal("EVLLM_EVALUATION_RUN_V1"),
    run_id: urn("event"),
    config_id: urn("case"),
    config_version: positiveSafeInteger,
    config_sha256: bytes32Hex,
    started_at: z.string().datetime({ offset: true }),
    completed_at: z.string().datetime({ offset: true }),
    result_directory: z
      .string()
      .regex(/^(?:evaluation\/development|evaluation\/formal)\/[a-z0-9][a-z0-9_-]*$/u),
    secrets_included: z.literal(false),
    metrics: z.array(
      z
        .object({
          metric_id: z.string().regex(/^[a-z][a-z0-9_.-]*$/u),
          value: z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u),
        })
        .strict(),
    ),
  })
  .strict()
  .refine((value) => Date.parse(value.completed_at) >= Date.parse(value.started_at), {
    message: "completed_at must not precede started_at",
    path: ["completed_at"],
  });
