import { z } from "zod";

export const EU_BATTERIES_REGULATION_CELEX = "32023R1542";
export const EU_BATTERIES_REGULATION_ELI = "http://data.europa.eu/eli/reg/2023/1542/oj";
export const EU_BATTERIES_REGULATION_EUR_LEX =
  "https://eur-lex.europa.eu/eli/reg/2023/1542/oj?locale=en";

export const EU_BATTERY_PASSPORT_CLAUSE_IDS = [
  "eu-2023-1542-art-77-1",
  "eu-2023-1542-art-77-3-first-subparagraph",
  "eu-2023-1542-art-77-4",
  "eu-2023-1542-art-77-5",
  "eu-2023-1542-art-77-7-first-subparagraph",
  "eu-2023-1542-art-78-f",
  "eu-2023-1542-art-78-g",
  "eu-2023-1542-art-78-h",
] as const;

const clause = z
  .object({
    clause_id: z.enum(EU_BATTERY_PASSPORT_CLAUSE_IDS),
    reference: z.string().min(1),
    article: z.union([z.literal(77), z.literal(78)]),
    paragraph: z.string().min(1).optional(),
    subparagraph: z.string().min(1).optional(),
    point: z.string().min(1).optional(),
    topic: z.string().min(1),
    official_text: z.string().min(1),
    normalized_requirement: z.string().min(1),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.article === 77 && item.paragraph === undefined) {
      context.addIssue({
        code: "custom",
        path: ["paragraph"],
        message: "Article 77 needs a paragraph",
      });
    }
    if (item.article === 78 && item.point === undefined) {
      context.addIssue({ code: "custom", path: ["point"], message: "Article 78 needs a point" });
    }
  });

export const euRegulatorySourceFixture = z
  .object({
    schema: z.literal("EU_REGULATORY_SOURCE_FIXTURE_V1"),
    version: z.literal(1),
    fixture_id: z.literal("eu-regulation-2023-1542-battery-passport"),
    source: z
      .object({
        title: z.string().includes("Regulation (EU) 2023/1542"),
        jurisdiction: z.literal("EU"),
        celex_identifier: z.literal(EU_BATTERIES_REGULATION_CELEX),
        eli_uri: z.literal(EU_BATTERIES_REGULATION_ELI),
        official_eur_lex_uri: z.literal(EU_BATTERIES_REGULATION_EUR_LEX),
        official_journal_reference: z.string().min(1),
        language: z.literal("en"),
        source_form: z.literal("Official Journal legal act"),
      })
      .strict(),
    scope_boundary: z
      .object({
        purpose: z.string().min(1),
        legal_compliance_validation: z.literal(false),
        legal_advice: z.literal(false),
        synthetic_elements: z.tuple([
          z.literal("actor identities"),
          z.literal("battery facts"),
          z.literal("route parameters"),
          z.literal("expected outcomes"),
        ]),
        statement: z.string().includes("does not validate legal compliance"),
      })
      .strict(),
    clauses: z.array(clause).length(EU_BATTERY_PASSPORT_CLAUSE_IDS.length),
  })
  .strict()
  .superRefine((fixture, context) => {
    const clauseIds = fixture.clauses.map((item) => item.clause_id);
    if (new Set(clauseIds).size !== clauseIds.length) {
      context.addIssue({ code: "custom", path: ["clauses"], message: "Clause IDs must be unique" });
    }
    for (const clauseId of EU_BATTERY_PASSPORT_CLAUSE_IDS) {
      if (!clauseIds.includes(clauseId)) {
        context.addIssue({ code: "custom", path: ["clauses"], message: `Missing ${clauseId}` });
      }
    }
  });

export type EuRegulatorySourceFixture = z.infer<typeof euRegulatorySourceFixture>;
export type EuRegulatoryClause = EuRegulatorySourceFixture["clauses"][number];
