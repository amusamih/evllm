import { spawn } from "node:child_process";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { once } from "node:events";
import { resolve } from "node:path";

const image =
  "ghcr.io/crytic/slither:0.11.6@sha256:89d4127ec3bfeba9725a863c58dd96b01781ff73737871dd3b07606ebc4cf16b";
const projectRoot = resolve(".");
const outputDirectory = resolve("evaluation/final/assurance/contracts");
const reportPath = resolve(outputDirectory, "slither.json");

await mkdir(outputDirectory, { recursive: true });
await unlink(reportPath).catch((error: unknown) => {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
});

const child = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${projectRoot}:/src:ro`,
    "-v",
    `${outputDirectory}:/out`,
    "-w",
    "/src",
    image,
    "slither",
    "contracts",
    "--compile-force-framework",
    "solc",
    "--solc-remaps",
    "@openzeppelin/=node_modules/@openzeppelin/",
    "--solc-args",
    "--base-path /src --include-path /src/node_modules",
    "--filter-paths",
    "(node_modules/|contracts/test/)",
    "--json",
    "/out/slither.json",
    "--fail-medium",
  ],
  { stdio: "inherit" },
);
const [exitCode] = (await once(child, "exit")) as [number | null];
if (exitCode !== 0) throw new Error(`Slither exited with status ${String(exitCode)}`);

type Finding = {
  id: string;
  check: string;
  impact: string;
  confidence: string;
  description: string;
  first_markdown_element: string;
  elements: unknown[];
};
const report = JSON.parse(await readFile(reportPath, "utf8")) as {
  success: boolean;
  results: { detectors: Finding[] };
};
const review = JSON.parse(
  await readFile(resolve(outputDirectory, "slither-review.json"), "utf8"),
) as {
  image: string;
  accepted_findings: Array<Pick<Finding, "check" | "impact" | "confidence"> & { scope: string }>;
};

if (!report.success || review.image !== image)
  throw new Error("Slither report/review identity mismatch");
const detectorIds = new Set<string>();
const detectorScopes = new Set<string>();
const matchedReviewScopes = new Set<string>();
for (const finding of report.results.detectors) {
  if (finding.impact === "High" || finding.impact === "Medium") {
    throw new Error(`Unresolved ${finding.impact} Slither finding: ${finding.check}`);
  }
  const { location, scope } = detectorLocationAndScope(finding);
  if (detectorIds.has(finding.id) || detectorScopes.has(scope)) {
    throw new Error("Slither report contains a duplicate detector identity or scope");
  }
  detectorIds.add(finding.id);
  detectorScopes.add(scope);
  const accepted = review.accepted_findings.filter(
    (item) =>
      item.check === finding.check &&
      item.impact === finding.impact &&
      item.confidence === finding.confidence &&
      item.scope === scope,
  );
  if (accepted.length !== 1 || matchedReviewScopes.has(scope)) {
    throw new Error(`Unreviewed or ambiguously reviewed Slither finding: ${finding.check}`);
  }
  if (finding.first_markdown_element !== location || !finding.description.includes(scope)) {
    throw new Error(`Slither detector location or scope mismatch: ${finding.check}`);
  }
  matchedReviewScopes.add(scope);
}
if (
  report.results.detectors.length !== review.accepted_findings.length ||
  matchedReviewScopes.size !== review.accepted_findings.length
) {
  throw new Error("Slither review contains stale or missing findings");
}

process.stdout.write(
  `Slither assurance passed: 0 medium/high, ${String(report.results.detectors.length)} reviewed low/informational.\n`,
);

function detectorLocationAndScope(finding: Finding): { location: string; scope: string } {
  const element = finding.elements[0];
  if (element === null || typeof element !== "object") {
    throw new Error(`Slither detector ${finding.id} has no primary element`);
  }
  const fields = unknownProperty(element, "type_specific_fields");
  const mapping = unknownProperty(element, "source_mapping");
  if (
    fields === null ||
    typeof fields !== "object" ||
    mapping === null ||
    typeof mapping !== "object"
  ) {
    throw new Error(`Slither detector ${finding.id} has incomplete element metadata`);
  }
  const parent = unknownProperty(fields, "parent");
  const signature = unknownProperty(fields, "signature");
  const filename = unknownProperty(mapping, "filename_relative");
  const lines = unknownProperty(mapping, "lines");
  const parentName =
    parent !== null && typeof parent === "object" ? unknownProperty(parent, "name") : undefined;
  if (
    parent === null ||
    typeof parent !== "object" ||
    typeof parentName !== "string" ||
    typeof signature !== "string" ||
    typeof filename !== "string" ||
    !Array.isArray(lines) ||
    lines.length === 0
  ) {
    throw new Error(`Slither detector ${finding.id} has invalid location or scope metadata`);
  }
  return {
    location: `${filename}#L${String(lines[0])}-L${String(lines.at(-1))}`,
    scope: `${parentName}.${signature}`,
  };
}

function unknownProperty(target: object, key: string): unknown {
  return Reflect.get(target, key) as unknown;
}
