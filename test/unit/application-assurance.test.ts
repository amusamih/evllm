import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertExactTestPaths,
  groupVitestFiles,
  mergeTotals,
  parseVitestJsonReport,
  unitTestPaths,
  type ParsedVitestFile,
} from "../../scripts/lib/application-assurance.js";

describe("application-assurance result accounting", () => {
  it("maps every retained unit-test file exactly once", () => {
    const retainedUnitTests = readdirSync(resolve("test/unit"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => `test/unit/${entry.name}`)
      .sort();

    expect(unitTestPaths).toEqual(retainedUnitTests);
  });

  it("parses assertion and file statuses without treating Vitest suites as files", () => {
    const root = resolve(".");
    const report = parseVitestJsonReport(
      JSON.stringify({
        success: false,
        numTotalTests: 5,
        numPassedTests: 2,
        numFailedTests: 1,
        testResults: [
          result(resolve(root, "test/unit/exact-decimal.test.ts"), "passed", ["passed", "skipped"]),
          result(resolve(root, "test/unit/route-assessment.test.ts"), "passed", ["todo"]),
          result(resolve(root, "test/unit/evidence-ledger.test.ts"), "failed", [
            "passed",
            "failed",
          ]),
        ],
      }),
      root,
    );

    expect(report).toMatchObject({
      success: false,
      test_files: { total: 3, passed: 1, failed: 1, skipped: 1 },
      tests: { total: 5, passed: 2, failed: 1, skipped: 2 },
    });
    expect(report.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "test/unit/exact-decimal.test.ts", status: "passed" },
      { path: "test/unit/route-assessment.test.ts", status: "skipped" },
      { path: "test/unit/evidence-ledger.test.ts", status: "failed" },
    ]);
  });

  it("groups exact paths in stable reader-facing order and computes every total", () => {
    const files: ParsedVitestFile[] = [
      parsedFile("test/unit/route-assessment.test.ts", "passed", 2, 0, 1),
      parsedFile("test/unit/exact-decimal.test.ts", "passed", 1, 0, 0),
      parsedFile("test/integration/evidence-postgres.test.ts", "passed", 3, 0, 0),
      parsedFile("test/unit/application-assurance.test.ts", "passed", 2, 0, 0),
    ];

    const groups = groupVitestFiles(files);

    expect(groups.map(({ name }) => name)).toEqual([
      "Protected records, authorization and storage",
      "Decision support and route assessment",
      "Data models and PostgreSQL integration",
      "Evaluation methods and reproducibility",
    ]);
    expect(groups[1]).toMatchObject({
      files: ["test/unit/route-assessment.test.ts"],
      test_files: { total: 1, passed: 1, failed: 0, skipped: 0 },
      tests: { total: 3, passed: 2, failed: 0, skipped: 1 },
    });
    expect(mergeTotals(...groups.map(({ tests }) => tests))).toEqual({
      total: 9,
      passed: 8,
      failed: 0,
      skipped: 1,
    });
  });

  it("rejects unmapped, omitted, duplicated, or internally inconsistent results", () => {
    expect(() =>
      groupVitestFiles([parsedFile("test/unit/not-mapped.test.ts", "passed", 1, 0, 0)]),
    ).toThrow("No application-assurance group is mapped");
    expect(() =>
      assertExactTestPaths(
        ["test/unit/exact-decimal.test.ts", "test/unit/extra.test.ts"],
        ["test/unit/exact-decimal.test.ts", "test/unit/route-assessment.test.ts"],
        "Unit",
      ),
    ).toThrow("missing: test/unit/route-assessment.test.ts; unexpected: test/unit/extra.test.ts");
    expect(() =>
      groupVitestFiles([
        parsedFile("test/unit/exact-decimal.test.ts", "passed", 1, 0, 0),
        parsedFile("test/unit/exact-decimal.test.ts", "passed", 1, 0, 0),
      ]),
    ).toThrow("more than once");
    expect(() =>
      parseVitestJsonReport(
        JSON.stringify({
          success: true,
          numTotalTests: 2,
          numPassedTests: 1,
          numFailedTests: 0,
          testResults: [result(resolve("test/unit/exact-decimal.test.ts"), "passed", ["passed"])],
        }),
        resolve("."),
      ),
    ).toThrow("numTotalTests");
  });
});

function result(name: string, status: "passed" | "failed", statuses: string[]) {
  return {
    name,
    status,
    assertionResults: statuses.map((assertionStatus) => ({ status: assertionStatus })),
  };
}

function parsedFile(
  path: string,
  status: ParsedVitestFile["status"],
  passed: number,
  failed: number,
  skipped: number,
): ParsedVitestFile {
  return {
    path,
    status,
    tests: { total: passed + failed + skipped, passed, failed, skipped },
  };
}
