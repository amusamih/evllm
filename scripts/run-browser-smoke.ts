import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createApp } from "../src/app.js";
import { ScriptedAssistantModel } from "../src/assistant/index.js";
import { createResearchRuntime } from "../src/interface/runtime.js";

const browserCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];
let browser: string | undefined;
for (const candidate of browserCandidates) {
  try {
    await access(candidate);
    browser = candidate;
    break;
  } catch {
    // Try the next locally installed Chromium browser.
  }
}
if (browser === undefined) throw new Error("Browser smoke requires local Edge or Chrome");

const runtime = createResearchRuntime({
  controlledWalletAddress: `0x${"1".repeat(40)}`,
  corpusPath: resolve("evaluation/final/synthesis-corpus.json"),
  modelName: "scripted-browser-smoke-model",
  modelProvider: new ScriptedAssistantModel(
    ({ supports }) => ({
      outcome: "answer",
      decision_code: null,
      summary:
        "The deterministic service records outcome answer and decision code eligible-for-resale for Battery ID 101.",
      evidence_reason_codes: [],
      claims: supports.map((support, index) => ({
        claim_id: `claim-${String(index + 1)}`,
        text: support.content,
        citation_ids: [support.support_id],
      })),
      warnings: [],
      missing_requirements: [],
    }),
    "scripted-browser-smoke-model",
  ),
  now: () => 1_776_033_600,
});
const server = createApp({
  appEnvironment: "test",
  rateLimit: false,
  assistant: { sessions: runtime.sessions, service: runtime.assistant, audit: runtime.audit },
  interface: { service: runtime.interfaceService },
}).listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address() as AddressInfo;
const profile = await mkdtemp(join(tmpdir(), "evllm-browser-smoke-"));
try {
  const rendered = await run(browser, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    "--virtual-time-budget=3000",
    `--user-data-dir=${profile}`,
    "--dump-dom",
    `http://127.0.0.1:${String(address.port)}/?view=assistant&question=${encodeURIComponent("Is Battery ID 101 ready to be listed for resale? Please cite the records used.")}`,
  ]);
  for (const required of [
    '<html lang="en">',
    "Second-Life Battery Decision Support",
    "Decision support",
    "Route assessment",
    "Workflow state",
    "Battery ID 101 has recorded owner Seller organization 101.",
    "Record 1",
    "scripted-browser-smoke-model",
  ]) {
    if (!rendered.includes(required)) throw new Error(`Browser output omitted: ${required}`);
  }
  if (rendered.includes("synthesis-101-record-1")) {
    throw new Error("Browser output exposed an internal controlled-case record ID");
  }
  process.stdout.write("Browser smoke passed in a real headless Chromium renderer.\n");
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true });
}

function run(executable: string, arguments_: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Headless browser exited with ${String(code)}`));
    });
  });
}
