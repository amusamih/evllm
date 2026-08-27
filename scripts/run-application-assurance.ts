import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  assertExactTestPaths,
  groupVitestFiles,
  mergeTotals,
  parseVitestJsonReport,
  postgresqlIntegrationTestPaths,
  unitTestPaths,
  type AssuranceTotals,
  type ParsedVitestRun,
} from "./lib/application-assurance.js";
import { assertCommittedEvaluationSource } from "./lib/evaluation-source.js";

const root = resolve(".");
const outputPath = resolve(root, "evaluation/final/assurance/application-tests.json");
const allowedEvidenceChanges = [
  "evaluation/final/results",
  "evaluation/final/assurance",
  "evaluation/final/demonstrations",
  "evaluation/final/sustainability-validation.json",
  "evaluation/final/SUSTAINABILITY_RESULTS.md",
  "evaluation/final/FINAL_RESULTS.md",
  "evaluation/final/RESOURCE_RESULTS.md",
  "evaluation/final/BLOCKCHAIN_RESULTS.md",
  "evaluation/final/evidence-manifest.json",
] as const;
const { sourceCommit } = assertCommittedEvaluationSource(allowedEvidenceChanges);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "application-assurance-"));

try {
  const unit = await runVitest("unit", ["test/unit"], resolve(temporaryDirectory, "unit.json"));
  assertExactTestPaths(
    unit.files.map(({ path }) => path),
    unitTestPaths,
    "Unit",
  );

  const integration = await runVitest(
    "postgresql-integration",
    [...postgresqlIntegrationTestPaths, "--no-file-parallelism", "--maxWorkers=1"],
    resolve(temporaryDirectory, "postgresql-integration.json"),
    ["--env-file=.env/test.env"],
  );
  assertExactTestPaths(
    integration.files.map(({ path }) => path),
    postgresqlIntegrationTestPaths,
    "PostgreSQL integration",
  );

  const typecheckArguments = [
    "./node_modules/typescript/bin/tsc",
    "-p",
    "tsconfig.json",
    "--noEmit",
  ];
  const typecheckCommand = formatCommand("node", typecheckArguments);
  runCommand(process.execPath, typecheckArguments, typecheckCommand);
  const completedSource = assertCommittedEvaluationSource(allowedEvidenceChanges);
  if (completedSource.sourceCommit !== sourceCommit) {
    throw new Error("The source commit changed during application assurance");
  }

  const allFiles = [...unit.files, ...integration.files];
  const summary = {
    schema: "APPLICATION_ASSURANCE_SUMMARY_V2",
    generated_at: new Date().toISOString(),
    source_commit: sourceCommit,
    status: "passed",
    commands: [
      commandSummary("unit", unit.command, unit.report),
      commandSummary("postgresql-integration", integration.command, integration.report),
      { id: "typecheck", command: typecheckCommand, status: "passed" },
    ],
    test_files: mergeTotals(unit.report.test_files, integration.report.test_files),
    tests: mergeTotals(unit.report.tests, integration.report.tests),
    groups: groupVitestFiles(allFiles),
    typecheck: { command: typecheckCommand, status: "passed", errors: 0 },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(
      {
        output: relative(root, outputPath).replaceAll("\\", "/"),
        source_commit: sourceCommit,
        test_files: summary.test_files,
        tests: summary.tests,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  assertOwnedTemporaryDirectory(temporaryDirectory);
  await rm(temporaryDirectory, { recursive: true, force: true });
}

async function runVitest(
  id: string,
  selectorsAndOptions: string[],
  reportPath: string,
  nodeOptions: string[] = [],
): Promise<{ command: string; report: ParsedVitestRun; files: ParsedVitestRun["files"] }> {
  const reportArgument = relative(root, reportPath);
  const args = [
    ...nodeOptions,
    "./node_modules/vitest/vitest.mjs",
    "run",
    ...selectorsAndOptions,
    "--reporter=json",
    "--outputFile",
    reportArgument,
  ];
  const command = formatCommand("node", args);
  runCommand(process.execPath, args, command);
  const report = parseVitestJsonReport(await readFile(reportPath, "utf8"), root);
  if (!report.success) throw new Error(`${id} Vitest report did not record a successful run`);
  return { command, report, files: report.files };
}

function commandSummary(
  id: string,
  command: string,
  report: ParsedVitestRun,
): {
  id: string;
  command: string;
  status: "passed";
  test_files: AssuranceTotals;
  tests: AssuranceTotals;
} {
  return {
    id,
    command,
    status: "passed",
    test_files: report.test_files,
    tests: report.tests,
  };
}

function runCommand(executable: string, args: string[], displayCommand: string): void {
  process.stdout.write(`Running ${displayCommand}\n`);
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.status === 0 && result.error === undefined) return;
  if ((result.stdout ?? "").length > 0) process.stderr.write(result.stdout ?? "");
  if ((result.stderr ?? "").length > 0) process.stderr.write(result.stderr ?? "");
  throw new Error(
    result.error === undefined
      ? `Command failed with exit code ${String(result.status)}: ${displayCommand}`
      : `Could not execute ${displayCommand}: ${result.error.message}`,
  );
}

function formatCommand(executable: string, args: readonly string[]): string {
  return [executable, ...args].map(quoteCommandArgument).join(" ");
}

function quoteCommandArgument(argument: string): string {
  return /^[A-Za-z0-9_./:=\\-]+$/u.test(argument)
    ? argument
    : `"${argument.replaceAll('"', '\\"')}"`;
}

function assertOwnedTemporaryDirectory(path: string): void {
  const resolvedTemporaryRoot = resolve(tmpdir());
  const resolvedPath = resolve(path);
  if (
    !resolvedPath.startsWith(`${resolvedTemporaryRoot}${sep}`) ||
    !basename(resolvedPath).startsWith("application-assurance-")
  ) {
    throw new Error(`Refusing to remove an unexpected temporary directory: ${resolvedPath}`);
  }
}
