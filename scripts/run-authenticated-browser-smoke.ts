import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Wallet } from "ethers";

import { createApp } from "../src/app.js";
import { ScriptedAssistantModel, encodeAssistantQuery } from "../src/assistant/index.js";
import {
  CONTROLLED_ACTOR_ID,
  CONTROLLED_CREDENTIAL_ID,
  CONTROLLED_ORGANIZATION_ID,
  CONTROLLED_PURPOSE_ID,
} from "../src/interface/cases.js";
import { createResearchRuntime } from "../src/interface/runtime.js";

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

const modelCalls: string[] = [];
const runtime = createResearchRuntime({
  corpusPath: resolve("evaluation", "final", "synthesis-corpus.json"),
  modelName: "authenticated-browser-smoke-model",
  modelProvider: new ScriptedAssistantModel(({ question, supports }) => {
    modelCalls.push(question);
    return {
      outcome: "answer",
      summary: "The permitted records support the recorded resale decision.",
      evidence_reason_codes: [],
      claims: supports.map((support, index) => ({
        claim_id: `claim-${String(index + 1)}`,
        text: support.content,
        citation_ids: [support.support_id],
      })),
      warnings: [],
      missing_requirements: [],
    };
  }, "authenticated-browser-smoke-model"),
  now: () => 1_776_033_600,
});
const server = createApp({
  appEnvironment: "test",
  rateLimit: false,
  assistant: { sessions: runtime.sessions, service: runtime.assistant, audit: runtime.audit },
  interface: { service: runtime.interfaceService },
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
const profile = await mkdtemp(join(tmpdir(), "evllm-authenticated-browser-smoke-"));
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
      origin,
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
  await client.send("Page.navigate", { url: origin });
  await waitForExpression(
    client,
    `location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`,
  );

  const wallet = Wallet.createRandom();
  const challenge = await browserFetch<{ challenge_id: string; message: string }>(
    client,
    "/api/v1/auth",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "challenge",
        identity: {
          actorId: CONTROLLED_ACTOR_ID,
          organizationId: CONTROLLED_ORGANIZATION_ID,
          credentialId: CONTROLLED_CREDENTIAL_ID,
          address: wallet.address.toLowerCase(),
        },
      }),
    },
  );
  const signature = await wallet.signMessage(challenge.message);
  const verified = await browserFetch<{ token: string }>(client, "/api/v1/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "verify",
      challenge_id: challenge.challenge_id,
      signature,
    }),
  });

  const query = encodeAssistantQuery({
    question: "Is Battery ID 101 ready to be listed for resale?",
    purpose_id: CONTROLLED_PURPOSE_ID,
    as_of: 1_776_033_600,
    idempotency_key: "00000000-0000-4000-8000-000000000779",
    requests: [
      { tool: "facts", arguments: { case_id: "synthesis-final-001" } },
      { tool: "rules", arguments: { case_id: "synthesis-final-001" } },
    ],
  });
  const path = `/api/v1/query/assistant?request=${encodeURIComponent(query)}`;
  const options = { headers: { authorization: `Bearer ${verified.token}` } };
  const first = await browserFetch<{ request_id: string; outcome: string }>(client, path, options);
  const replay = await browserFetch<{ request_id: string; outcome: string }>(client, path, options);
  if (first.outcome !== "answer" || replay.request_id !== first.request_id) {
    throw new Error("Authenticated browser query or idempotent replay failed");
  }
  const audit = await browserFetch<unknown[]>(
    client,
    `/api/v1/query/audit?request_id=${encodeURIComponent(first.request_id)}`,
    options,
  );
  if (audit.length !== 1 || modelCalls.length !== 1 || !runtime.audit.verify()) {
    throw new Error("Authenticated browser retry duplicated the model call or audit outcome");
  }
  client.close();
  process.stdout.write(
    "Authenticated browser-to-assistant smoke passed with one-use wallet login and idempotent replay.\n",
  );
} finally {
  if (browserProcess !== undefined && browserProcess.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => {
      browserProcess?.once("exit", () => resolveExit());
    });
    browserProcess.kill();
    await exited;
  }
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function browserFetch<T>(
  client: CdpClient,
  path: string,
  options: Record<string, unknown>,
): Promise<T> {
  const evaluation = (await client.send("Runtime.evaluate", {
    expression: `(async () => {
      const response = await fetch(${JSON.stringify(path)}, ${JSON.stringify(options)});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || "Browser request failed");
      return body.result;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })) as {
    exceptionDetails?: { text?: string };
    result?: { value?: unknown };
  };
  if (evaluation.exceptionDetails !== undefined) {
    throw new Error(evaluation.exceptionDetails.text ?? "Browser evaluation failed");
  }
  return evaluation.result?.value as T;
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
  throw new Error("Authenticated browser smoke requires local Edge or Chrome");
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
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const evaluation = (await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    if (evaluation.result?.value === true) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
