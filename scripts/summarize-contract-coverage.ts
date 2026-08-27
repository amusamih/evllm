import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const lcov = await readFile(resolve("coverage/lcov.info"), "utf8");
const required = new Set([
  "AuditAnchor.sol",
  "AuthorityProfileRegistry.sol",
  "BatteryOwnershipRegistry.sol",
  "DeploymentRegistry.sol",
  "EvidenceRegistry.sol",
  "Marketplace.sol",
  "ProtectedBundleRegistry.sol",
]);
const files: Array<{ file: string; found: number; hit: number; linePercent: number }> = [];
for (const record of lcov.split("end_of_record")) {
  const source = /^SF:(.+)$/mu.exec(record)?.[1];
  if (source === undefined) continue;
  const file = source.replaceAll("\\", "/").split("/").at(-1) ?? source;
  if (!required.has(file)) continue;
  const found = Number(/^LF:(\d+)$/mu.exec(record)?.[1] ?? 0);
  const hit = Number(/^LH:(\d+)$/mu.exec(record)?.[1] ?? 0);
  files.push({ file, found, hit, linePercent: found === 0 ? 0 : (hit / found) * 100 });
}
files.sort((left, right) => left.file.localeCompare(right.file));
if (files.length !== required.size || files.some(({ linePercent }) => linePercent < 80)) {
  throw new Error("Every production contract must have at least 80% executable-line coverage");
}
const totalFound = files.reduce((sum, file) => sum + file.found, 0);
const totalHit = files.reduce((sum, file) => sum + file.hit, 0);
const document = {
  schema: "EVLLM_CONTRACT_COVERAGE_V1",
  thresholdPercent: 80,
  totalLinePercent: (totalHit / totalFound) * 100,
  files,
};
await mkdir(resolve("evaluation/final/assurance/contracts"), { recursive: true });
await writeFile(
  resolve("evaluation/final/assurance/contracts/coverage.json"),
  `${JSON.stringify(document, null, 2)}\n`,
);
process.stdout.write(
  `Contract coverage passed: ${document.totalLinePercent.toFixed(2)}% total; every production contract >= 80%.\n`,
);
