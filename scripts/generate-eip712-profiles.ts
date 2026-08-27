import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { format } from "prettier";

import { eip712Profiles } from "../src/schemas/index.js";

const checkOnly = process.argv.includes("--check");
const outputPath = resolve("contracts/generated/eip712/profiles.json");
const document = {
  schema: "EVLLM_EIP712_PROFILES_V1",
  profiles: eip712Profiles,
};
const expected = await format(JSON.stringify(document), {
  endOfLine: "lf",
  parser: "json",
  printWidth: 100,
});

if (checkOnly) {
  const actual = await readFile(outputPath, "utf8").catch(() => "");
  if (actual !== expected) {
    process.stderr.write(
      "Generated EIP-712 profile drift: contracts/generated/eip712/profiles.json\n",
    );
    process.exitCode = 1;
  }
} else {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected, "utf8");
}
