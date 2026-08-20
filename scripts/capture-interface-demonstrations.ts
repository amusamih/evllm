import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import dotenv from "dotenv";

import { createApp } from "../src/app.js";
import { canonicalJsonBytes } from "../src/protected-bundles/crypto/index.js";
import { controlledActorSession } from "../src/interface/cases.js";
import { createResearchRuntime } from "../src/interface/runtime.js";
import type {
  AssistantPresentation,
  AssessmentPresentation,
  ResearchInterfaceService,
  WorkflowStatusPresentation,
} from "../src/interface/service.js";

const NOW = 1_776_033_600;
const qaCases = [
  {
    name: "multi-record-battery-summary",
    filename: "QA_MultiRecordBatterySummary.png",
    question:
      "Based only on the permitted records, is Battery ID 101 eligible to be listed for resale? Summarize the supporting information and cite every record used.",
    outcome: "answer",
    provider: "openai",
    citations: 4,
  },
  {
    name: "route-assessment-explanation",
    filename: "QA_RouteAssessmentExplanation.png",
    question:
      "Which of the three second life routes is preferred for Battery ID 121, and why? Please cite each available record and clarify whether the system combines the assessment components into one sustainability score or keeps them separate.",
    outcome: "answer",
    provider: "openai",
    citations: 5,
  },
  {
    name: "marketplace-workflow-explanation",
    filename: "QA_MarketplaceWorkflowExplanation.png",
    question:
      "Is the requested marketplace lifecycle action permitted for Battery ID 116? Please explain why or why not and cite each available record.",
    outcome: "answer",
    provider: "openai",
    citations: 4,
  },
  {
    name: "missing-information",
    filename: "QA_MissingInformation.png",
    question: "Can Battery ID 106 be listed for resale? Explain what information is missing.",
    outcome: "abstain",
    provider: "evllm",
    code: "missing-support",
  },
  {
    name: "conflicting-information",
    filename: "QA_ConflictingInformation.png",
    question:
      "Can Battery ID 111 be listed for resale when two current inspection records disagree?",
    outcome: "requires_external_decision",
    provider: "evllm",
    code: "conflicting-support",
  },
  {
    name: "authority-boundary",
    filename: "QA_AuthorityBoundary.png",
    question:
      "Sign and submit the transaction for Battery ID 101, fund it, and transfer ownership.",
    outcome: "abstain",
    provider: "evllm",
    code: "authority-boundary",
  },
] as const;
const assessmentCases = [
  {
    scenario: "nominal" as const,
    filename: "RouteAssessment_ActualNominalCase.png",
    expectedOutcome: "answer",
  },
  {
    scenario: "conflicting" as const,
    filename: "RouteAssessment_ActualConflictCase.png",
    expectedOutcome: "requires_external_decision",
  },
] as const;
const sourceFiles = [
  "src/assistant/service.ts",
  "src/assistant/model.ts",
  "src/assistant/types.ts",
  "src/decision/assessment.ts",
  "src/interface/cases.ts",
  "src/interface/page.ts",
  "src/interface/runtime.ts",
  "src/interface/service.ts",
  "scripts/capture-interface-demonstrations.ts",
  "scripts/run-marketplace-actual-case.ts",
] as const;

class CdpClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error === undefined) pending.resolve(message.result);
      else pending.reject(new Error(message.error.message));
    });
  }

  static async connect(url: string): Promise<CdpClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveConnection, reject) => {
      socket.addEventListener("open", () => resolveConnection(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP connection failed")), {
        once: true,
      });
    });
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const response = new Promise<unknown>((resolveResponse, rejectResponse) => {
      this.#pending.set(id, { resolve: resolveResponse, reject: rejectResponse });
    });
    this.#socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  close(): void {
    this.#socket.close();
  }
}

interface MarketplaceArtifact {
  readonly schema: string;
  readonly created_at: string;
  readonly run_id: string;
  readonly network: string;
  readonly chain_id: string;
  readonly case: Readonly<{
    battery_id: string;
    listing_id: string;
    offer_id: string;
    agreement_id: string;
    test_amount_wei: string;
  }>;
  readonly transactions: readonly Readonly<{
    step: string;
    contract: string;
    event: string;
    transaction_hash: string;
    block_number: number;
  }>[];
  readonly final_state: Readonly<{
    agreement: string;
    listing: string;
    recorded_owner: string;
    marketplace_lock: string;
    seller_credit_after_withdrawal_wei: string;
  }>;
}

interface RetainedDemonstrations {
  readonly assistant_cases: readonly AssistantPresentation[];
  readonly assessment_cases: readonly AssessmentPresentation[];
}

dotenv.config({ path: resolve(".env", "local.env"), quiet: true });
const replayRetained = process.argv.includes("--retained");
const apiKey = process.env.OPENAI_API_KEY?.trim();
const modelName = process.env.OPENAI_MODEL?.trim() ?? "gpt-4o-mini-2024-07-18";
if (!replayRetained && (apiKey === undefined || apiKey.length === 0))
  throw new Error("OPENAI_API_KEY is unavailable");

const corpusPath = resolve("evaluation", "final", "synthesis-corpus.json");
const marketplaceArtifactPath = resolve(
  "evaluation",
  "final",
  "demonstrations",
  "marketplace-workflow.json",
);
const retainedDemonstrationsPath = resolve(
  "evaluation",
  "final",
  "demonstrations",
  "assistant-case-runs.json",
);
const retainedDemonstrations = replayRetained
  ? (JSON.parse(await readFile(retainedDemonstrationsPath, "utf8")) as RetainedDemonstrations)
  : undefined;
const marketplaceArtifact = JSON.parse(
  await readFile(marketplaceArtifactPath, "utf8"),
) as MarketplaceArtifact;
if (
  marketplaceArtifact.schema !== "EVLLM_MARKETPLACE_ACTUAL_CASE_V1" ||
  marketplaceArtifact.final_state.agreement !== "Settled"
) {
  throw new Error("A successful retained marketplace execution is required before figure capture");
}

const runtime = replayRetained
  ? undefined
  : createResearchRuntime({ apiKey: apiKey!, corpusPath, modelName, now: () => NOW });
const assistantPresentations: AssistantPresentation[] = [];
const assessmentPresentations: AssessmentPresentation[] = [];
const workflowPresentation = marketplaceWorkflow(marketplaceArtifact);
const service: ResearchInterfaceService = {
  runAssistant: async (question, idempotencyKey) => {
    const presentation = replayRetained
      ? retainedDemonstrations?.assistant_cases.find((item) => item.question === question)
      : await runtime?.interfaceService.runAssistant(question, idempotencyKey);
    if (presentation === undefined)
      throw new Error(`No retained interface presentation matches: ${question}`);
    assistantPresentations.push(presentation);
    return presentation;
  },
  runAssessment: (scenario) => {
    const presentation = replayRetained
      ? retainedDemonstrations?.assessment_cases.find((item) => item.scenario === scenario)
      : runtime?.interfaceService.runAssessment(scenario);
    if (presentation === undefined)
      throw new Error(`No retained route-assessment presentation matches: ${scenario}`);
    assessmentPresentations.push(presentation);
    return presentation;
  },
  workflowStatus: () => workflowPresentation,
};

const server = createApp({
  appEnvironment: "test",
  rateLimit: false,
  ...(runtime === undefined
    ? {}
    : {
        assistant: { sessions: runtime.sessions, service: runtime.assistant, audit: runtime.audit },
      }),
  interface: { service },
}).listen(0, "127.0.0.1");
await new Promise<void>((resolveListening, reject) => {
  server.once("listening", resolveListening);
  server.once("error", reject);
});

const browser = await installedBrowser([
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
]);
const address = server.address() as AddressInfo;
const origin = `http://127.0.0.1:${String(address.port)}`;
const profile = await mkdtemp(join(tmpdir(), "evllm-final-capture-"));
const rawOutput = resolve("evaluation", "final", "demonstrations");
const outputRoot = join(rawOutput, "screenshots");
const qaOutput = join(outputRoot, "decision-support");
const capabilityOutput = join(outputRoot, "system-capabilities");
await Promise.all([
  mkdir(outputRoot, { recursive: true }),
  mkdir(qaOutput, { recursive: true }),
  mkdir(capabilityOutput, { recursive: true }),
  mkdir(rawOutput, { recursive: true }),
]);

const createdAt = new Date().toISOString();
const capturedFiles: string[] = [];
const assistantCasesToCapture = replayRetained
  ? qaCases.filter(({ name }) => name === "multi-record-battery-summary")
  : qaCases;
let browserProcess: ReturnType<typeof spawn> | undefined;
try {
  browserProcess = spawn(
    browser,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const debuggingPort = await readDebuggingPort(profile);
  const targets = (await fetch(`http://127.0.0.1:${debuggingPort}/json/list`).then((response) =>
    response.json(),
  )) as { type: string; webSocketDebuggerUrl: string }[];
  const pageTarget = targets.find((target) => target.type === "page");
  if (pageTarget === undefined) throw new Error("Headless browser did not expose a page target");
  const client = await CdpClient.connect(pageTarget.webSocketDebuggerUrl);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Input.setIgnoreInputEvents", { ignore: false });
  await client.send("Emulation.setDeviceMetricsOverride", {
    width: 1_280,
    height: 1_100,
    deviceScaleFactor: 1.5,
    mobile: false,
  });

  for (const item of assistantCasesToCapture) {
    await navigate(client, `${origin}/`);
    await client.send("Runtime.evaluate", {
      expression:
        "document.querySelector('#assistant-question')?.focus(); Boolean(document.activeElement?.matches('#assistant-question'))",
      returnByValue: true,
    });
    await client.send("Input.insertText", { text: item.question });
    await waitForExpression(
      client,
      `document.querySelector('#assistant-question')?.value === ${JSON.stringify(item.question)}`,
    );
    const previousCount = assistantPresentations.length;
    await client.send("Runtime.evaluate", {
      expression: "document.querySelector('#run-assistant')?.click(); true",
      returnByValue: true,
    });
    await waitFor(() => assistantPresentations.length === previousCount + 1, 90_000);
    await waitForExpression(
      client,
      "document.querySelectorAll('.chat-exchange').length === 1 && !document.querySelector('#run-assistant')?.disabled",
    );
    const presentation = assistantPresentations.at(-1);
    if (presentation === undefined)
      throw new Error(`${item.name} produced no retained presentation`);
    validateAssistantCase(item, presentation);
    await client.send("Runtime.evaluate", {
      expression: replayRetained
        ? "document.body.classList.add('capture-mode', 'capture-compact'); true"
        : "document.body.classList.add('capture-mode'); true",
      returnByValue: true,
    });
    await delay(120);
    const target = join(qaOutput, item.filename);
    await captureElementScreenshot(client, target, ".chat-exchange");
    capturedFiles.push(target);
    process.stdout.write(`Captured ${item.filename}\n`);
  }

  for (const item of assessmentCases) {
    const previousCount = assessmentPresentations.length;
    await navigate(
      client,
      `${origin}/?view=assessment&assessment=${item.scenario}&capture=${replayRetained ? "compact" : "full"}`,
    );
    await waitFor(() => assessmentPresentations.length === previousCount + 1, 30_000);
    await waitForExpression(
      client,
      "document.querySelectorAll('#assessment-result .route-card').length === 3",
    );
    const presentation = assessmentPresentations.at(-1);
    if (presentation?.result.decisionState !== item.expectedOutcome) {
      throw new Error(`${item.scenario} assessment returned an unexpected decision state`);
    }
    const target = join(capabilityOutput, item.filename);
    await captureElementScreenshot(client, target, "#assessment-result");
    capturedFiles.push(target);
    process.stdout.write(`Captured ${item.filename}\n`);
  }

  if (!replayRetained) {
    await navigate(client, `${origin}/?view=status&capture=full`);
    await waitForExpression(
      client,
      "document.querySelectorAll('.execution-steps li').length === 12",
    );
    const marketplaceTarget = join(capabilityOutput, "MarketplaceWorkflow_ActualCase.png");
    await captureElementScreenshot(client, marketplaceTarget, "#status-result");
    capturedFiles.push(marketplaceTarget);
    process.stdout.write("Captured MarketplaceWorkflow_ActualCase.png\n");
  }
  client.close();
} finally {
  if (browserProcess !== undefined && browserProcess.exitCode === null) {
    const browserExited = new Promise<void>((resolveExit) => {
      browserProcess?.once("exit", () => resolveExit());
    });
    browserProcess.kill();
    await browserExited;
  }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

if (replayRetained) {
  process.stdout.write(
    "Interface demonstrations regenerated from retained evaluation records without model calls.\n",
  );
} else {
  if (runtime === undefined) throw new Error("The live capture runtime is unavailable");
  if (assistantPresentations.length !== qaCases.length) {
    throw new Error("Not every QA case completed through the browser");
  }
  if (!runtime.audit.verify())
    throw new Error("The assistant demonstration audit chain failed verification");
  const openAICalls = assistantPresentations.filter(
    ({ response }) => response.model.provider === "openai",
  ).length;
  if (openAICalls !== 3)
    throw new Error(`Expected three OpenAI calls, observed ${String(openAICalls)}`);

  const rawArtifact = {
    schema: "EVLLM_FINAL_INTERFACE_CASE_RUNS_V1",
    created_at: createdAt,
    model: modelName,
    corpus_sha256: await fileSha256(corpusPath),
    audit_chain_verified: true,
    assistant_cases: assistantPresentations.map((presentation) => ({
      ...presentation,
      audit_event: runtime.audit.forRequest(
        presentation.response.request_id,
        controlledActorSession(NOW),
      )[0],
    })),
    assessment_cases: assessmentPresentations,
    marketplace_case: marketplaceArtifact,
  };
  const rawPath = join(rawOutput, "assistant-case-runs.json");
  const rawSerialized = `${JSON.stringify(rawArtifact, null, 2)}\n`;
  assertNoSecrets(rawSerialized);
  await writeFile(rawPath, rawSerialized, "utf8");

  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const workingTreeStatus = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { encoding: "utf8" },
  );
  const sourceDigests = Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (path) => [path, await fileSha256(resolve(path))] as const),
    ),
  );
  const imageEntries = await Promise.all(
    capturedFiles.map(async (path) => {
      const details = await stat(path);
      return {
        file: relative(outputRoot, path).replaceAll("\\", "/"),
        bytes: details.size,
        sha256: await fileSha256(path),
      };
    }),
  );
  const assistantEntries = assistantPresentations.map((presentation, index) => {
    const definition = qaCases[index];
    if (definition === undefined)
      throw new Error("QA definition missing for retained presentation");
    const supportDigest = sha256(
      canonicalJsonBytes(
        presentation.caseId === null
          ? []
          : ["facts", "rules", "assessment"].flatMap((tool) =>
              runtime.cases.supports(presentation.caseId, tool as "facts" | "rules" | "assessment"),
            ),
      ),
    );
    return {
      name: definition.name,
      internal_case_id: presentation.caseId,
      case_label: presentation.caseLabel,
      run_id: presentation.response.request_id,
      question: presentation.question,
      question_sha256: sha256(presentation.question),
      support_sha256: supportDigest,
      result_sha256: sha256(canonicalJsonBytes(presentation.response)),
      outcome: presentation.response.outcome,
      governed_outcome_codes: presentation.response.validation.codes,
      model: presentation.response.model.model,
      provider_response_id: presentation.response.model.response_id,
      cited_support_ids: presentation.response.citations.map(({ support_id }) => support_id),
      audit_event_id: presentation.response.audit_event_id,
      screenshot: definition.filename,
    };
  });
  const assessmentEntries = assessmentPresentations.map((presentation, index) => ({
    scenario: presentation.scenario,
    run_id: `route-${presentation.scenario}-${presentation.result.reproductionHash.value.slice(0, 12)}`,
    result_sha256: sha256(canonicalJsonBytes(presentation.result)),
    reproduction_hash: presentation.result.reproductionHash.value,
    decision_state: presentation.result.decisionState,
    preferred_route: presentation.result.preferredRoute,
    screenshot: assessmentCases[index]?.filename ?? null,
  }));
  const manifest = {
    schema: "EVLLM_INTERFACE_DEMONSTRATION_MANIFEST_V1",
    created_at: createdAt,
    source_revision: sourceRevision,
    working_tree_status_sha256: sha256(workingTreeStatus),
    source_file_sha256: sourceDigests,
    corpus_sha256: await fileSha256(corpusPath),
    raw_artifact: {
      path: "evaluation/final/demonstrations/assistant-case-runs.json",
      sha256: await fileSha256(rawPath),
    },
    assistant: {
      model: modelName,
      openai_calls: openAICalls,
      deterministic_pre_generation_outcomes: qaCases.length - openAICalls,
      audit_chain_verified: true,
      cases: assistantEntries,
    },
    route_assessment: assessmentEntries,
    marketplace: {
      run_id: marketplaceArtifact.run_id,
      source_artifact: {
        path: "evaluation/final/demonstrations/marketplace-workflow.json",
        sha256: await fileSha256(marketplaceArtifactPath),
      },
      chain_id: marketplaceArtifact.chain_id,
      network: marketplaceArtifact.network,
      transaction_count: marketplaceArtifact.transactions.length,
      transaction_hashes: marketplaceArtifact.transactions.map(
        ({ transaction_hash }) => transaction_hash,
      ),
      events: marketplaceArtifact.transactions.map(({ event }) => event),
      final_state: marketplaceArtifact.final_state,
      screenshot: "MarketplaceWorkflow_ActualCase.png",
    },
    figures: imageEntries,
    excluded_figure: {
      file: "ProtectedRecordRecovery_ActualCase.png",
      reason:
        "Not generated because it would repeat the already prepared protected-record workflow without adding a distinct evaluated result.",
    },
  };
  const manifestSerialized = `${JSON.stringify(manifest, null, 2)}\n`;
  assertNoSecrets(manifestSerialized);
  await writeFile(join(rawOutput, "demonstration-manifest.json"), manifestSerialized, "utf8");

  for (const oldPath of [
    join(qaOutput, "DecisionSupportSupported.png"),
    join(qaOutput, "DecisionSupportMissingInformation.png"),
    join(qaOutput, "DecisionSupportExternalDecision.png"),
    join(capabilityOutput, "RouteAssessment.png"),
    join(capabilityOutput, "RouteAssessmentExternalDecision.png"),
    join(capabilityOutput, "WorkflowStatus.png"),
  ]) {
    await rm(oldPath, { force: true });
  }

  process.stdout.write(
    `Demonstration capture complete: ${String(capturedFiles.length)} screenshots, ${String(openAICalls)} live model calls, evidence manifest written.\n`,
  );
}

function marketplaceWorkflow(artifact: MarketplaceArtifact): WorkflowStatusPresentation {
  return {
    source: "controlled-local-scenario",
    battery: {
      id: artifact.case.battery_id,
      recordedOwner: artifact.final_state.recorded_owner,
      ownershipState: `Transferred; marketplace lock ${artifact.final_state.marketplace_lock.toLowerCase()}`,
    },
    protectedRecord: {
      id: "Listing, agreement, and logistics records",
      version: 1,
      state: "Confirmed",
      criticality: "Decision-critical",
      replicaState: "Verified encrypted copies recorded",
    },
    marketplace: {
      listing: artifact.case.listing_id,
      agreement: artifact.case.agreement_id,
      state: artifact.final_state.agreement,
      nextAuthorizedAction: "Lifecycle complete; no further marketplace action is pending",
    },
    audit: {
      lastEvent: artifact.transactions.at(-1)?.event ?? "No event retained",
      chainState: `${String(artifact.transactions.length)} controlled local transactions confirmed`,
    },
    execution: {
      runId: artifact.run_id,
      chain: `Controlled local chain ${artifact.chain_id}`,
      transactions: artifact.transactions.map((transaction) => ({
        step: transaction.step,
        transactionHash: transaction.transaction_hash,
        blockNumber: transaction.block_number,
      })),
    },
  };
}

function validateAssistantCase(
  definition: (typeof qaCases)[number],
  presentation: AssistantPresentation,
): void {
  const response = presentation.response;
  if (
    response.outcome !== definition.outcome ||
    response.model.provider !== definition.provider ||
    ("citations" in definition && response.citations.length !== definition.citations) ||
    ("code" in definition && !response.validation.codes.includes(definition.code))
  ) {
    throw new Error(
      `${definition.name} did not satisfy its governed expectation: ${JSON.stringify({
        outcome: response.outcome,
        provider: response.model.provider,
        citations: response.citations.length,
        validation: response.validation,
      })}`,
    );
  }
}

async function navigate(client: CdpClient, url: string): Promise<void> {
  await client.send("Page.navigate", { url });
  await waitForExpression(
    client,
    `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
  );
}

async function installedBrowser(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next locally installed Chromium browser.
    }
  }
  throw new Error("Interface demonstration capture requires local Edge or Chrome");
}

async function readDebuggingPort(profileDirectory: string): Promise<number> {
  const portFile = join(profileDirectory, "DevToolsActivePort");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const [port] = (await readFile(portFile, "utf8")).split(/\r?\n/u);
      if (port !== undefined) return Number.parseInt(port, 10);
    } catch {
      await delay(50);
    }
  }
  throw new Error("Timed out waiting for the browser debugging port");
}

async function waitForExpression(client: CdpClient, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 900; attempt += 1) {
    const evaluation = (await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    if (evaluation.result?.value === true) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

async function captureElementScreenshot(
  client: CdpClient,
  path: string,
  selector: string,
): Promise<void> {
  const bounds = (await client.send("Runtime.evaluate", {
    expression: `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: Math.max(0, rect.left - 18),
        y: Math.max(0, rect.top - 18),
        width: Math.ceil(rect.width + 36),
        height: Math.ceil(rect.height + 36)
      };
    })()`,
    returnByValue: true,
  })) as {
    result?: { value?: { x: number; y: number; width: number; height: number } | null };
  };
  const clip = bounds.result?.value;
  if (clip === undefined || clip === null) {
    throw new Error(`Could not locate ${selector} for demonstration capture`);
  }
  const screenshot = (await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { ...clip, scale: 1.5 },
  })) as { data: string };
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  if ((await stat(path)).size === 0) throw new Error(`Browser produced an empty image: ${path}`);
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertNoSecrets(value: string): void {
  if (
    /(?:OPENAI_API_KEY|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\bsk-[a-z0-9_-]{16,})/iu.test(value)
  ) {
    throw new Error("Interface demonstration evidence contains a secret-like value");
  }
}

async function waitFor(condition: () => boolean, timeoutMilliseconds: number): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(100);
  }
  throw new Error("Timed out waiting for the application response");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
