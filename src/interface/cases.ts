import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import {
  recordedDecision,
  recordedDecisionSupportCommitment,
  type ActorSession,
  type AssistantQuery,
  type AssistantSupport,
  type AssistantToolName,
} from "../assistant/index.js";

export const CONTROLLED_PURPOSE_ID = urn("policy", 1);
export const CONTROLLED_ACTOR_ID = urn("actor", 1);
export const CONTROLLED_ORGANIZATION_ID = urn("org", 1);
export const CONTROLLED_CREDENTIAL_ID = urn("credential", 1);

const requiredCaseIds = [
  "synthesis-101",
  "synthesis-106",
  "synthesis-111",
  "synthesis-116",
  "synthesis-121",
] as const;
export type ControlledCaseId = (typeof requiredCaseIds)[number];

const presentationBatteryIds: Readonly<Record<ControlledCaseId, string>> = {
  "synthesis-101": "Battery ID 101",
  "synthesis-106": "Battery ID 106",
  "synthesis-111": "Battery ID 111",
  "synthesis-116": "Battery ID 116",
  "synthesis-121": "Battery ID 121",
};

const evaluationBatteryIds: Readonly<Record<ControlledCaseId, string>> = {
  "synthesis-101": "SYN-101",
  "synthesis-106": "SYN-106",
  "synthesis-111": "SYN-111",
  "synthesis-116": "SYN-116",
  "synthesis-121": "SYN-121",
};

const recordSchema = z.object({
  support_id: z.string().min(1),
  resource_id: z.string().min(1),
  resource_version: z.number().int().positive(),
  status: z.literal("active"),
  content: z.string().min(1),
  recorded_decision: recordedDecision.optional(),
});
const caseSchema = z.object({
  case_id: z.string().min(1),
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
    const mode =
      caseId !== null && isDecisionExplanationQuestion(question)
        ? "explain_recorded_decision"
        : "explain_records";
    return {
      caseId,
      caseLabel: caseId === null ? "No matching controlled record" : label(caseId),
      query: {
        question,
        mode,
        purpose_id: CONTROLLED_PURPOSE_ID,
        as_of: asOf,
        requests:
          caseId === "synthesis-121"
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
      .map(({ record }) => toSupport(item.case_id, record));
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

function isDecisionExplanationQuestion(question: string): boolean {
  return /\b(?:recorded\s+(?:decision|outcome|conclusion)|decision\s+code|eligible|eligibility|ready\s+to\s+(?:be\s+)?(?:list(?:ed|ing)?|resell)|(?:can|may|should)\b.{0,60}\b(?:list(?:ed|ing)?|resell|recover|enter|proceed)|(?:route|option)\b.{0,50}\b(?:preferred|recommended|selected|supported)|(?:preferred|recommended|selected)\s+(?:route|option)|workflow\s+action\b.{0,40}\b(?:permitted|allowed|authorized)|information\s+(?:is\s+)?still\s+needed|inspections?\s+disagree)\b/iu.test(
    question,
  );
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
  if (/(?:\bSYN-101\b|\bbattery\s+(?:ID\s+)?101\b)/iu.test(question)) return "synthesis-101";
  if (/(?:\bSYN-106\b|\bbattery\s+(?:ID\s+)?106\b)/iu.test(question)) return "synthesis-106";
  if (/(?:\bSYN-111\b|\bbattery\s+(?:ID\s+)?111\b)/iu.test(question)) return "synthesis-111";
  if (/(?:\bSYN-116\b|\bbattery\s+(?:ID\s+)?116\b)/iu.test(question)) return "synthesis-116";
  if (/(?:\bSYN-121\b|\bbattery\s+(?:ID\s+)?121\b)/iu.test(question)) return "synthesis-121";
  if (/(?:legally certify|formal(?:ly)? approve|accredit)/iu.test(question)) {
    return "synthesis-101";
  }
  return null;
}

function recordBelongsToTool(
  caseId: ControlledCaseId,
  tool: AssistantToolName,
  index: number,
  lastIndex: number,
): boolean {
  if (caseId === "synthesis-121") return tool === "assessment";
  if (tool === "facts") return index < lastIndex;
  if (tool === "rules") return index === lastIndex;
  return false;
}

function toSupport(caseId: string, record: z.infer<typeof recordSchema>): AssistantSupport {
  const controlledCaseId = caseId as ControlledCaseId;
  const evaluationBatteryId = evaluationBatteryIds[controlledCaseId];
  const presentationBatteryId = presentationBatteryIds[controlledCaseId];
  const content = `${record.content
    .replaceAll(`battery ${evaluationBatteryId}`, presentationBatteryId)
    .replaceAll(evaluationBatteryId, presentationBatteryId)
    .replace(/Organization Seller-([0-9]+)/gu, "Seller organization $1")}`;
  const support = {
    support_id: record.support_id,
    resource_id: record.resource_id,
    resource_version: record.resource_version,
    issuer_organization_id: urn("org", 2),
    custodian_organization_id: urn("org", 3),
    as_of: 1_776_033_600,
    status: record.status,
    chain_reference: `controlled-corpus:${caseId}:${record.support_id}`,
    content,
    recorded_decision: record.recorded_decision,
  };
  return {
    ...support,
    commitment:
      support.recorded_decision === undefined
        ? `sha256:${createHash("sha256").update(content).digest("base64url")}`
        : recordedDecisionSupportCommitment({
            ...support,
            recorded_decision: support.recorded_decision,
          }),
  };
}

function isControlledCaseId(value: string): value is ControlledCaseId {
  return requiredCaseIds.some((caseId) => caseId === value);
}

function label(caseId: ControlledCaseId): string {
  switch (caseId) {
    case "synthesis-101":
      return "Resale readiness";
    case "synthesis-106":
      return "Missing required information";
    case "synthesis-111":
      return "Conflicting current information";
    case "synthesis-116":
      return "Marketplace workflow explanation";
    case "synthesis-121":
      return "Second-life route explanation";
  }
}

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
