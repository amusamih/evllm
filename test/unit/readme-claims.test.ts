import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertGeneratedMarkdownContent,
  internalOnlyLanguage,
  manifestBoundGeneratedMarkdownPaths,
} from "../../scripts/lib/public-evidence.js";

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
    ];

    for (const path of publicMarkdownPaths) {
      const document = await readFile(resolve(path), "utf8");
      expect(document, path).not.toMatch(internalOnlyLanguage);
    }
  });

  it("requires every manifest-bound Markdown result and rejects internal-only language", () => {
    const documents = manifestBoundGeneratedMarkdownPaths.map((path) => ({
      path,
      content: "# Reproducible evaluation result\n",
    }));
    expect(() => assertGeneratedMarkdownContent(documents)).not.toThrow();
    expect(() => assertGeneratedMarkdownContent(documents.slice(1))).toThrow(
      /Required generated evidence document is missing/u,
    );
    expect(() =>
      assertGeneratedMarkdownContent(
        documents.map((document, index) =>
          index === 0 ? { ...document, content: "Internal milestone note" } : document,
        ),
      ),
    ).toThrow(/contains internal-only language/u);
  });

  it("binds the immutable primary score-derivation audit into the final evidence manifest", async () => {
    const generator = await readFile(resolve("scripts/generate-final-evidence.ts"), "utf8");
    expect(generator).toContain('"evaluation/final/results/primary/score-derivation-audit.json"');
    expect(generator).toContain("await assertManifestBoundGeneratedMarkdown(root)");
  });

  it("checksum-lists both provider-attempt journals in the final evidence manifest", async () => {
    const generator = await readFile(resolve("scripts/generate-final-evidence.ts"), "utf8");
    expect(generator).toContain('"evaluation/final/results/primary/transport-attempts.jsonl"');
    expect(generator).toContain('"evaluation/final/results/synthesis/transport-attempts.jsonl"');
  });
});
