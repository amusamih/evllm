import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import type {
  AssistantQuery,
  AssistantSupport,
  AssistantToolName,
  ActorSession,
} from "../assistant/index.js";

export const CONTROLLED_PURPOSE_ID = urn("policy", 1);
export const CONTROLLED_ACTOR_ID = urn("actor", 1);
export const CONTROLLED_ORGANIZATION_ID = urn("org", 1);
export const CONTROLLED_CREDENTIAL_ID = urn("credential", 1);

const requiredCaseIds = [
  "synthesis-final-001",
  "synthesis-final-006",
  "synthesis-final-011",
  "synthesis-final-016",
  "synthesis-final-021",
] as const;
export type ControlledCaseId = (typeof requiredCaseIds)[number];

const presentationBatteryIds: Readonly<Record<ControlledCaseId, string>> = {
  "synthesis-final-001": "Battery ID 101",
  "synthesis-final-006": "Battery ID 106",
  "synthesis-final-011": "Battery ID 111",
  "synthesis-final-016": "Battery ID 116",
  "synthesis-final-021": "Battery ID 121",
};

const evaluationBatteryIds: Readonly<Record<ControlledCaseId, string>> = {
  "synthesis-final-001": "FINAL-101",
  "synthesis-final-006": "FINAL-106",
  "synthesis-final-011": "FINAL-111",
  "synthesis-final-016": "FINAL-116",
  "synthesis-final-021": "FINAL-121",
};

const recordSchema = z.object({
  support_id: z.string().min(1),
  resource_id: z.string().min(1),
  resource_version: z.number().int().positive(),
  status: z.literal("active"),
  content: z.string().min(1),
});
const caseSchema = z.object({
  case_id: z.string().min(1),
  expected_conclusion: z.string().min(1),
  expected_detection: z.enum(["missing", "conflict"]).nullable(),
  records: z.array(recordSchema).min(1),
});
const corpusSchema = z.object({ cases: z.array(caseSchema) });
type CorpusCase = z.infer<typeof caseSchema>;

export interface ResolvedControlledQuestion {
  readonly caseId: ControlledCaseId | null;
  readonly caseLabel: string;
  readonly query: AssistantQuery;
}

export class ControlledCaseCatalog {
  readonly #cases = new Map<ControlledCaseId, CorpusCase>();

  public static load(path: string): ControlledCaseCatalog {
    return new ControlledCaseCatalog(
      corpusSchema.parse(JSON.parse(readFileSync(path, "utf8"))).cases,
    );
  }

  public constructor(cases: readonly CorpusCase[]) {
    for (const caseId of requiredCaseIds) {
      const item = cases.find(({ case_id: candidate }) => candidate === caseId);
      if (item === undefined) throw new Error(`Required controlled case ${caseId} is missing`);
      this.#cases.set(caseId, structuredClone(item));
    }
  }

  public resolve(question: string, asOf: number): ResolvedControlledQuestion {
    const caseId = caseIdForQuestion(question);
    return {
      caseId,
      caseLabel: caseId === null ? "No matching controlled record" : label(caseId),
      query: {
        question,
        purpose_id: CONTROLLED_PURPOSE_ID,
        as_of: asOf,
        requests:
          caseId === "synthesis-final-021"
            ? [{ tool: "assessment", arguments: { case_id: caseId } }]
            : [
                {
                  tool: "facts",
                  arguments: { case_id: caseId ?? "unresolved" },
                },
                {
                  tool: "rules",
                  arguments: { case_id: caseId ?? "unresolved" },
                },
              ],
      },
    };
  }

  public supports(caseId: unknown, tool: AssistantToolName): readonly AssistantSupport[] {
    if (typeof caseId !== "string" || !isControlledCaseId(caseId)) return [];
    const item = this.#cases.get(caseId);
    if (item === undefined) return [];
    const lastIndex = item.records.length - 1;
    return item.records
      .map((record, index) => ({ record, index }))
      .filter(({ index }) => recordBelongsToTool(caseId, tool, index, lastIndex))
      .map(({ record, index }) => toSupport(item, record, index));
  }

  public authorizes(
    session: ActorSession,
    purposeId: string,
    tool: AssistantToolName,
    arguments_: Readonly<Record<string, boolean | number | string>>,
  ): boolean {
    if (
      session.actorId !== CONTROLLED_ACTOR_ID ||
      session.organizationId !== CONTROLLED_ORGANIZATION_ID ||
      session.credentialId !== CONTROLLED_CREDENTIAL_ID ||
      purposeId !== CONTROLLED_PURPOSE_ID
    ) {
      return false;
    }
    const caseId = arguments_.case_id;
    if (caseId === "unresolved") return tool === "facts" || tool === "rules";
    return typeof caseId === "string" && isControlledCaseId(caseId);
  }
}

export function controlledActorSession(now: number): ActorSession {
  return Object.freeze({
    sessionId: urn("session", 1),
    actorId: CONTROLLED_ACTOR_ID,
    organizationId: CONTROLLED_ORGANIZATION_ID,
    credentialId: CONTROLLED_CREDENTIAL_ID,
    address: `0x${"1".repeat(40)}`,
    issuedAt: now,
    expiresAt: now + 900,
  });
}

function caseIdForQuestion(question: string): ControlledCaseId | null {
  if (/(?:\bFINAL-101\b|\bbattery\s+(?:ID\s+)?101\b)/iu.test(question))
    return "synthesis-final-001";
  if (/(?:\bFINAL-106\b|\bbattery\s+(?:ID\s+)?106\b)/iu.test(question))
    return "synthesis-final-006";
  if (/(?:\bFINAL-111\b|\bbattery\s+(?:ID\s+)?111\b)/iu.test(question))
    return "synthesis-final-011";
  if (/(?:\bFINAL-116\b|\bbattery\s+(?:ID\s+)?116\b)/iu.test(question))
    return "synthesis-final-016";
  if (/(?:\bFINAL-121\b|\bbattery\s+(?:ID\s+)?121\b)/iu.test(question))
    return "synthesis-final-021";
  if (/(?:legally certify|formal(?:ly)? approve|accredit)/iu.test(question)) {
    return "synthesis-final-001";
  }
  return null;
}

function recordBelongsToTool(
  caseId: ControlledCaseId,
  tool: AssistantToolName,
  index: number,
  lastIndex: number,
): boolean {
  if (caseId === "synthesis-final-021") return tool === "assessment";
  if (tool === "facts") return index < lastIndex;
  if (tool === "rules") return index === lastIndex;
  return false;
}

function toSupport(
  item: CorpusCase,
  record: z.infer<typeof recordSchema>,
  index: number,
): AssistantSupport {
  const status = supportStatus(item.case_id, index);
  const conclusion =
    index === item.records.length - 1
      ? ` The recorded deterministic outcome code is '${item.expected_conclusion}'.`
      : "";
  const caseId = item.case_id as ControlledCaseId;
  const evaluationBatteryId = evaluationBatteryIds[caseId];
  const presentationBatteryId = presentationBatteryIds[caseId];
  const content = `${record.content
    .replaceAll(`battery ${evaluationBatteryId}`, presentationBatteryId)
    .replaceAll(evaluationBatteryId, presentationBatteryId)
    .replace(/Organization Seller-([0-9]+)/gu, "Seller organization $1")}${conclusion}`;
  return {
    support_id: record.support_id,
    resource_id: record.resource_id,
    resource_version: record.resource_version,
    issuer_organization_id: urn("org", 2),
    custodian_organization_id: urn("org", 3),
    as_of: 1_776_033_600,
    status,
    commitment: `sha256:${createHash("sha256").update(content).digest("base64url")}`,
    chain_reference: `controlled-corpus:${item.case_id}:${record.support_id}`,
    content,
  };
}

function supportStatus(caseId: string, index: number): AssistantSupport["status"] {
  if (caseId === "synthesis-final-006" && index === 2) return "missing";
  if (caseId === "synthesis-final-011" && (index === 0 || index === 1)) return "conflicting";
  return "active";
}

function isControlledCaseId(value: string): value is ControlledCaseId {
  return requiredCaseIds.some((caseId) => caseId === value);
}

function label(caseId: ControlledCaseId): string {
  switch (caseId) {
    case "synthesis-final-001":
      return "Resale readiness";
    case "synthesis-final-006":
      return "Missing required information";
    case "synthesis-final-011":
      return "Conflicting current information";
    case "synthesis-final-016":
      return "Marketplace workflow explanation";
    case "synthesis-final-021":
      return "Second-life route explanation";
  }
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
