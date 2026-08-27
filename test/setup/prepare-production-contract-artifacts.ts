import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(".");
const hardhatCli = resolve(root, "node_modules/hardhat/dist/src/cli.js");

export default function prepareProductionContractArtifacts(): void {
  const arguments_ = [
    hardhatCli,
    "compile",
    "--build-profile",
    "production",
    "--no-tests",
    "--force",
  ];
  const result = spawnSync(process.execPath, arguments_, {
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
      ? `Production contract compilation failed with exit code ${String(result.status)}`
      : `Production contract compilation could not start: ${result.error.message}`,
  );
}
