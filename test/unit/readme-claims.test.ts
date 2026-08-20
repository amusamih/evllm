import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("README runnable-surface claims", () => {
  it("mentions only npm commands that exist in package.json", async () => {
    const readme = await readFile(resolve("README.md"), "utf8");
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const commands = [...readme.matchAll(/npm run ([a-z0-9:-]+)/gu)].map((match) => match[1]);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(packageJson.scripts).toHaveProperty(command ?? "");
  });

  it("documents the reproducible public surface without internal workflow language", async () => {
    const readme = await readFile(resolve("README.md"), "utf8");

    expect(readme).toContain("## Core capabilities");
    expect(readme).toContain("### Protected records and controlled access");
    expect(readme).toContain("### Second-life route assessment");
    expect(readme).toContain("### Governed conversational decision support");
    expect(readme).toContain("### Blockchain coordination and audit");
    expect(readme).toContain("### Battery transaction workflow");
    expect(readme).toContain("## Install and verify");
    expect(readme).toContain("OPERATIONS.md");
    expect(readme).not.toMatch(/GATE_[1-9]_STATUS/u);
    expect(readme).not.toContain("Remaining target architecture");

    const publicMarkdownPaths = [
      "README.md",
      "OPERATIONS.md",
      "SECURITY.md",
      "evaluation/complementary/README.md",
      "evaluation/final/README.md",
      "evaluation/final/FINAL_RESULTS.md",
      "evaluation/final/SUSTAINABILITY_RESULTS.md",
      "evaluation/final/BLOCKCHAIN_RESULTS.md",
      "evaluation/final/RESOURCE_RESULTS.md",
      "evaluation/final/results/primary/summary.md",
      "evaluation/final/results/synthesis/summary.md",
    ];
    const internalLanguage =
      /reader-facing|published source commit|earlier development outputs|internal milestone|final run|corrected synthesis|fresh synthetic corpus|author approval|not silently bypassed|bootstrap closure|chain truth|outside this prototype|manuscript|reviewer/iu;

    for (const path of publicMarkdownPaths) {
      const document = await readFile(resolve(path), "utf8");
      expect(document, path).not.toMatch(internalLanguage);
    }
  });
});
