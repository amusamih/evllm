import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const manifestBoundGeneratedMarkdownPaths = [
  "evaluation/final/FINAL_RESULTS.md",
  "evaluation/final/SUSTAINABILITY_RESULTS.md",
  "evaluation/final/BLOCKCHAIN_RESULTS.md",
  "evaluation/final/RESOURCE_RESULTS.md",
  "evaluation/final/results/primary/summary.md",
  "evaluation/final/results/synthesis/summary.md",
] as const;

export const internalOnlyLanguage =
  /reader-facing|published source commit|earlier development outputs|internal milestone|final run|corrected synthesis|fresh synthetic corpus|author approval|not silently bypassed|bootstrap closure|chain truth|outside this prototype|manuscript|reviewer/iu;

export async function assertManifestBoundGeneratedMarkdown(root = "."): Promise<void> {
  const documents = await Promise.all(
    manifestBoundGeneratedMarkdownPaths.map(async (path) => {
      try {
        return { path, content: await readFile(resolve(root, path), "utf8") };
      } catch (error) {
        throw new Error(`Required generated evidence document is missing: ${path}`, {
          cause: error,
        });
      }
    }),
  );
  assertGeneratedMarkdownContent(documents);
}

export function assertGeneratedMarkdownContent(
  documents: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): void {
  const byPath = new Map(documents.map((document) => [document.path, document.content]));
  for (const path of manifestBoundGeneratedMarkdownPaths) {
    const content = byPath.get(path);
    if (content === undefined) {
      throw new Error(`Required generated evidence document is missing: ${path}`);
    }
    if (internalOnlyLanguage.test(content)) {
      throw new Error(`Generated evidence document contains internal-only language: ${path}`);
    }
  }
}
