import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const seeds = [
  "0x041a076a761a615d8a650b80aa8fb177c435d6a53883c3bf97a9a9136f4b20e4",
  "0x2f433fce563371238c0ed3e25855f3660daf467136697e247d6bb7d580bae630",
  "0x630ee00d85f46acf16b5a9266c2caf3377343ca75ee9f6161b05ba5683b05508",
  "0x9ae6716d9d77c1654a666874d2d207675e01f8b36231e1a377c26ea9b44b9b15",
  "0xf353f78340110772d0be269f98e3c3e032a22ff612cff256cd77bd9641c95da3",
] as const;
const fuzzRuns = 10_000;
const invariantRuns = 512;
const invariantDepth = 500;
const fuzzFunctions = 3;
const invariantFunctions = 2;
const hardhatCli = resolve("node_modules/hardhat/dist/src/cli.js");
const results = [];

for (const seed of seeds) {
  const started = Date.now();
  const run = spawnSync(process.execPath, [hardhatCli, "test", "solidity", "--no-compile"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      CONTRACT_FUZZ_RUNS: String(fuzzRuns),
      CONTRACT_INVARIANT_RUNS: String(invariantRuns),
      CONTRACT_INVARIANT_DEPTH: String(invariantDepth),
      CONTRACT_TEST_SEED: seed,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  if (run.status !== 0) {
    throw new Error(`Contract security run failed for seed ${seed} with status ${run.status}`);
  }
  results.push({ seed, durationMs: Date.now() - started, status: "passed" });
}

const outputDirectory = resolve("evaluation/final/assurance/contracts");
await mkdir(outputDirectory, { recursive: true });
const document = {
  schema: "EVLLM_CONTRACT_SECURITY_FREEZE_V1",
  hardhat: "3.12.0",
  compiler: "0.8.36-wasm",
  fuzzRunsPerSeed: fuzzRuns,
  invariantRunsPerSeed: invariantRuns,
  invariantDepth,
  fuzzFunctions,
  invariantFunctions,
  totalFuzzCases: fuzzRuns * seeds.length * fuzzFunctions,
  totalInvariantRuns: invariantRuns * seeds.length * invariantFunctions,
  results,
};
await writeFile(
  resolve(outputDirectory, "security.json"),
  `${JSON.stringify(document, null, 2)}\n`,
  "utf8",
);
