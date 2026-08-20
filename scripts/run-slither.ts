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

type Finding = { check: string; impact: string; confidence: string; description: string };
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
for (const finding of report.results.detectors) {
  if (finding.impact === "High" || finding.impact === "Medium") {
    throw new Error(`Unresolved ${finding.impact} Slither finding: ${finding.check}`);
  }
  const accepted = review.accepted_findings.some(
    (item) =>
      item.check === finding.check &&
      item.impact === finding.impact &&
      item.confidence === finding.confidence &&
      finding.description.includes(item.scope),
  );
  if (!accepted) throw new Error(`Unreviewed Slither finding: ${finding.check}`);
}
if (report.results.detectors.length !== review.accepted_findings.length) {
  throw new Error("Slither review contains stale or missing findings");
}

process.stdout.write(
  `Slither assurance passed: 0 medium/high, ${String(report.results.detectors.length)} reviewed low/informational.\n`,
);
