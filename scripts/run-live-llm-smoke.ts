import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import dotenv from "dotenv";
import {
  AssistantAuditLedger,
  AssistantRequestStore,
  AssistantToolRegistry,
  GovernedAssistantService,
  OpenAIAssistantModel,
  type ActorSession,
  type AssistantTool,
} from "../src/assistant/index.js";

dotenv.config({ path: resolve(".env/local.env"), quiet: true });
const apiKey = process.env.OPENAI_API_KEY?.trim();
const model = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini-2024-07-18";
if (apiKey === undefined || apiKey.length === 0 || apiKey.startsWith("replace_with_")) {
  throw new Error("OPENAI_API_KEY is not configured");
}

const session: ActorSession = {
  sessionId: urn("session", 1),
  actorId: urn("actor", 1),
  organizationId: urn("org", 1),
  credentialId: urn("credential", 1),
  address: "0x1111111111111111111111111111111111111111",
  issuedAt: 100,
  expiresAt: 300,
};
const tool: AssistantTool = {
  name: "facts",
  execute: () =>
    Promise.resolve([
      {
        support_id: "live-support-1",
        resource_id: urn("evidence", 1),
        resource_version: 1,
        issuer_organization_id: urn("org", 2),
        custodian_organization_id: urn("org", 2),
        as_of: 200,
        status: "active",
        commitment: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        chain_reference: "controlled-fixture:1",
        content: "The controlled fixture records battery inspection status as active at time 200.",
      },
    ]),
};
const audit = new AssistantAuditLedger();
const service = new GovernedAssistantService(
  new AssistantToolRegistry([tool], () => Promise.resolve(true)),
  new OpenAIAssistantModel(apiKey, model),
  audit,
  new AssistantRequestStore(),
  () => 200,
);
const started = Date.now();
const response = await service.answer(
  {
    question: "What inspection status does the controlled fixture record?",
    mode: "explain_records",
    purpose_id: urn("policy", 1),
    as_of: 200,
    requests: [{ tool: "facts", arguments: { fixture: "controlled-live-smoke" } }],
  },
  session,
  "00000000-0000-4000-8000-000000000099",
);
if (response.outcome !== "answer" || response.validation.status !== "passed") {
  throw new Error(`Live response failed validation: ${response.validation.codes.join(",")}`);
}
const output = {
  schema: "EVLLM_LIVE_LLM_SMOKE_V1",
  status: "passed",
  model: response.model.model,
  provider: response.model.provider,
  outcome: response.outcome,
  validation: response.validation.status,
  claim_count: response.claims.length,
  citation_count: response.citations.length,
  audit_chain_valid: audit.verify(),
  store: false,
  duration_ms: Date.now() - started,
};
const directory = resolve("test-results/live-llm-smoke");
await mkdir(directory, { recursive: true });
await writeFile(
  resolve(directory, "live-smoke.json"),
  `${JSON.stringify(output, null, 2)}\n`,
  "utf8",
);
process.stdout.write(`Live LLM smoke passed with ${output.model}.\n`);

function urn(kind: string, value: number): string {
  return `urn:evllm:${kind}:00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
}
