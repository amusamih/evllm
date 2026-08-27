import { isAbsolute, relative, resolve, sep } from "node:path";

export interface AssuranceTotals {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ParsedVitestFile {
  path: string;
  status: "passed" | "failed" | "skipped";
  tests: AssuranceTotals;
}

export interface ParsedVitestRun {
  success: boolean;
  test_files: AssuranceTotals;
  tests: AssuranceTotals;
  files: ParsedVitestFile[];
}

export interface AssuranceGroupSummary {
  name: AssuranceGroupName;
  files: string[];
  test_files: AssuranceTotals;
  tests: AssuranceTotals;
}

export const assuranceGroupOrder = [
  "Protected records, authorization and storage",
  "Decision support and route assessment",
  "Application interfaces and operations",
  "Data models and PostgreSQL integration",
  "Evaluation methods and reproducibility",
] as const;

export type AssuranceGroupName = (typeof assuranceGroupOrder)[number];

/**
 * Every executable application-assurance test belongs to one reader-facing group.
 * Exact paths make category membership reviewable and prevent filename heuristics from
 * silently changing published totals.
 */
export const assuranceTestPathToGroup: Readonly<Record<string, AssuranceGroupName>> = {
  "test/integration/evidence-postgres.test.ts": "Protected records, authorization and storage",
  "test/integration/key-operation-authorization-postgres.test.ts":
    "Protected records, authorization and storage",
  "test/integration/migrations.test.ts": "Data models and PostgreSQL integration",
  "test/integration/postgres.test.ts": "Data models and PostgreSQL integration",
  "test/unit/application-assurance.test.ts": "Evaluation methods and reproducibility",
  "test/unit/assistant-governance.test.ts": "Decision support and route assessment",
  "test/unit/assistant-http.test.ts": "Decision support and route assessment",
  "test/unit/assistant-model-config.test.ts": "Decision support and route assessment",
  "test/unit/canonical-projector.test.ts": "Decision support and route assessment",
  "test/unit/combined-command-routing.test.ts": "Application interfaces and operations",
  "test/unit/complementary-evaluation-freeze.test.ts": "Evaluation methods and reproducibility",
  "test/unit/complementary-evaluation-preflight.test.ts": "Evaluation methods and reproducibility",
  "test/unit/complementary-evaluation.test.ts": "Evaluation methods and reproducibility",
  "test/unit/config.test.ts": "Application interfaces and operations",
  "test/unit/contract-source-isolation.test.ts": "Protected records, authorization and storage",
  "test/unit/contract-toolchain.test.ts": "Application interfaces and operations",
  "test/unit/dated-rules.test.ts": "Decision support and route assessment",
  "test/unit/decision-query-http.test.ts": "Decision support and route assessment",
  "test/unit/decision-source-example.test.ts": "Decision support and route assessment",
  "test/unit/domain-payload-schemas.test.ts": "Data models and PostgreSQL integration",
  "test/unit/eip712-profile-artifact.test.ts": "Protected records, authorization and storage",
  "test/unit/eip712-signatures.test.ts": "Protected records, authorization and storage",
  "test/unit/eu-regulatory-fixture.test.ts": "Evaluation methods and reproducibility",
  "test/unit/evaluation-freeze.test.ts": "Evaluation methods and reproducibility",
  "test/unit/evaluation-manifests.test.ts": "Evaluation methods and reproducibility",
  "test/unit/evaluation-source.test.ts": "Evaluation methods and reproducibility",
  "test/unit/evaluation-statistics.test.ts": "Evaluation methods and reproducibility",
  "test/unit/evidence-bundle-service.test.ts": "Protected records, authorization and storage",
  "test/unit/evidence-http.test.ts": "Protected records, authorization and storage",
  "test/unit/evidence-ledger.test.ts": "Protected records, authorization and storage",
  "test/unit/exact-decimal.test.ts": "Data models and PostgreSQL integration",
  "test/unit/final-evaluation-corpus.test.ts": "Evaluation methods and reproducibility",
  "test/unit/final-evaluation-freeze.test.ts": "Evaluation methods and reproducibility",
  "test/unit/final-evaluation-provenance.test.ts": "Evaluation methods and reproducibility",
  "test/unit/final-evidence-provenance.test.ts": "Evaluation methods and reproducibility",
  "test/unit/final-results-rendering.test.ts": "Evaluation methods and reproducibility",
  "test/unit/formal-analysis-metrics.test.ts": "Evaluation methods and reproducibility",
  "test/unit/formal-condition-adapters.test.ts": "Evaluation methods and reproducibility",
  "test/unit/formal-evaluation-runner.test.ts": "Evaluation methods and reproducibility",
  "test/unit/formal-failure-taxonomy.test.ts": "Evaluation methods and reproducibility",
  "test/unit/formal-rescoring.test.ts": "Evaluation methods and reproducibility",
  "test/unit/formal-score.test.ts": "Evaluation methods and reproducibility",
  "test/unit/health.test.ts": "Application interfaces and operations",
  "test/unit/key-lifecycle.test.ts": "Protected records, authorization and storage",
  "test/unit/live-evaluation-runner.test.ts": "Evaluation methods and reproducibility",
  "test/unit/marketplace-http.test.ts": "Application interfaces and operations",
  "test/unit/migration-catalog.test.ts": "Data models and PostgreSQL integration",
  "test/unit/migration-policy.test.ts": "Data models and PostgreSQL integration",
  "test/unit/model-pricing-snapshot.test.ts": "Evaluation methods and reproducibility",
  "test/unit/observability.test.ts": "Application interfaces and operations",
  "test/unit/operations.test.ts": "Application interfaces and operations",
  "test/unit/persistent-crypto-leakage.test.ts": "Protected records, authorization and storage",
  "test/unit/protected-content-crypto.test.ts": "Protected records, authorization and storage",
  "test/unit/readme-claims.test.ts": "Evaluation methods and reproducibility",
  "test/unit/recipient-envelope-crypto.test.ts": "Protected records, authorization and storage",
  "test/unit/repository-object-operations.test.ts": "Protected records, authorization and storage",
  "test/unit/research-interface.test.ts": "Decision support and route assessment",
  "test/unit/route-assessment.test.ts": "Decision support and route assessment",
  "test/unit/schemas.test.ts": "Data models and PostgreSQL integration",
  "test/unit/sepolia-deployment-verification.test.ts": "Evaluation methods and reproducibility",
  "test/unit/storage-conformance.test.ts": "Protected records, authorization and storage",
  "test/unit/sustainability-evidence.test.ts": "Evaluation methods and reproducibility",
  "test/unit/transport-attempt-journal.test.ts": "Evaluation methods and reproducibility",
};

export const postgresqlIntegrationTestPaths = [
  "test/integration/postgres.test.ts",
  "test/integration/migrations.test.ts",
  "test/integration/evidence-postgres.test.ts",
  "test/integration/key-operation-authorization-postgres.test.ts",
] as const;

export const unitTestPaths = Object.freeze(
  Object.keys(assuranceTestPathToGroup)
    .filter((path) => path.startsWith("test/unit/"))
    .sort(),
);

export function parseVitestJsonReport(reportText: string, projectRoot: string): ParsedVitestRun {
  let value: unknown;
  try {
    value = JSON.parse(reportText) as unknown;
  } catch (error) {
    throw new Error("Vitest did not produce a valid JSON report", { cause: error });
  }
  assertRecord(value, "Vitest report");
  if (typeof value.success !== "boolean") throw new Error("Vitest report is missing success");
  if (!Array.isArray(value.testResults)) {
    throw new Error("Vitest report is missing testResults");
  }

  const files = value.testResults.map((entry, index) => parseVitestFile(entry, projectRoot, index));
  assertUniquePaths(files.map(({ path }) => path));
  const testFiles = countStatuses(files.map(({ status }) => status));
  const tests = mergeTotals(...files.map((file) => file.tests));

  assertDeclaredCount(value, "numTotalTests", tests.total);
  assertDeclaredCount(value, "numPassedTests", tests.passed);
  assertDeclaredCount(value, "numFailedTests", tests.failed);

  return { success: value.success, test_files: testFiles, tests, files };
}

export function groupVitestFiles(files: readonly ParsedVitestFile[]): AssuranceGroupSummary[] {
  assertUniquePaths(files.map(({ path }) => path));
  const groups = new Map<AssuranceGroupName, AssuranceGroupSummary>(
    assuranceGroupOrder.map((name) => [
      name,
      { name, files: [], test_files: emptyTotals(), tests: emptyTotals() },
    ]),
  );

  for (const file of files) {
    const groupName = assuranceTestPathToGroup[file.path];
    if (groupName === undefined) {
      throw new Error(`No application-assurance group is mapped for ${file.path}`);
    }
    const group = groups.get(groupName)!;
    group.files.push(file.path);
    group.test_files = mergeTotals(group.test_files, countStatuses([file.status]));
    group.tests = mergeTotals(group.tests, file.tests);
  }

  return assuranceGroupOrder
    .map((name) => groups.get(name)!)
    .filter(({ test_files }) => test_files.total > 0)
    .map((group) => ({ ...group, files: group.files.sort() }));
}

export function assertExactTestPaths(
  observedPaths: readonly string[],
  expectedPaths: readonly string[],
  label: string,
): void {
  const observed = new Set(observedPaths);
  const expected = new Set(expectedPaths);
  const missing = [...expected].filter((path) => !observed.has(path)).sort();
  const unexpected = [...observed].filter((path) => !expected.has(path)).sort();
  if (missing.length === 0 && unexpected.length === 0) return;
  throw new Error(
    `${label} test-file scope differs from its explicit map` +
      `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}` +
      `${unexpected.length > 0 ? `; unexpected: ${unexpected.join(", ")}` : ""}`,
  );
}

export function mergeTotals(...items: readonly AssuranceTotals[]): AssuranceTotals {
  return items.reduce(
    (total, item) => ({
      total: total.total + item.total,
      passed: total.passed + item.passed,
      failed: total.failed + item.failed,
      skipped: total.skipped + item.skipped,
    }),
    emptyTotals(),
  );
}

function parseVitestFile(value: unknown, projectRoot: string, index: number): ParsedVitestFile {
  assertRecord(value, `Vitest test result ${index}`);
  if (typeof value.name !== "string") {
    throw new Error(`Vitest test result ${index} is missing its file name`);
  }
  if (value.status !== "passed" && value.status !== "failed") {
    throw new Error(`Vitest test result ${index} has an unsupported file status`);
  }
  if (!Array.isArray(value.assertionResults)) {
    throw new Error(`Vitest test result ${index} is missing assertionResults`);
  }
  const statuses = value.assertionResults.map((assertion, assertionIndex) => {
    assertRecord(assertion, `Vitest assertion ${index}:${assertionIndex}`);
    return normalizeTestStatus(assertion.status, index, assertionIndex);
  });
  const tests = countStatuses(statuses);
  const status =
    value.status === "failed" || tests.failed > 0
      ? "failed"
      : tests.passed > 0
        ? "passed"
        : "skipped";
  return {
    path: repositoryRelativePath(value.name, projectRoot),
    status,
    tests,
  };
}

function normalizeTestStatus(
  value: unknown,
  fileIndex: number,
  assertionIndex: number,
): "passed" | "failed" | "skipped" {
  if (value === "passed" || value === "failed") return value;
  if (value === "skipped" || value === "pending" || value === "todo" || value === "disabled") {
    return "skipped";
  }
  throw new Error(`Vitest assertion ${fileIndex}:${assertionIndex} has an unsupported status`);
}

function repositoryRelativePath(fileName: string, projectRoot: string): string {
  const absolutePath = isAbsolute(fileName) ? resolve(fileName) : resolve(projectRoot, fileName);
  const relativePath = relative(resolve(projectRoot), absolutePath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Vitest reported a file outside the repository: ${fileName}`);
  }
  return relativePath.split(sep).join("/");
}

function countStatuses(statuses: readonly ("passed" | "failed" | "skipped")[]): AssuranceTotals {
  return statuses.reduce(
    (totals, status) => ({
      total: totals.total + 1,
      passed: totals.passed + Number(status === "passed"),
      failed: totals.failed + Number(status === "failed"),
      skipped: totals.skipped + Number(status === "skipped"),
    }),
    emptyTotals(),
  );
}

function assertDeclaredCount(
  report: Record<string, unknown>,
  field: string,
  observed: number,
): void {
  if (typeof report[field] !== "number" || report[field] !== observed) {
    throw new Error(
      `Vitest report ${field} does not match its per-file assertion results: ` +
        `${String(report[field])} !== ${observed}`,
    );
  }
}

function assertUniquePaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`Vitest reported the test file more than once: ${path}`);
    seen.add(path);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function emptyTotals(): AssuranceTotals {
  return { total: 0, passed: 0, failed: 0, skipped: 0 };
}
