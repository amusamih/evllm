import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";

import { OPENAI_ASSISTANT_MODEL } from "../assistant/model.js";

const packageName = "second-life-ev-battery-decision-support";

function findProjectRoot(startDirectory: string): string {
  let candidate = startDirectory;

  while (true) {
    const manifestPath = path.join(candidate, "package.json");

    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === packageName) {
        return candidate;
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Could not locate the ${packageName} project root.`);
    }
    candidate = parent;
  }
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = findProjectRoot(moduleDirectory);
const defaultEnvironmentPath = path.join(projectRoot, ".env", "local.env");

const nonPlaceholder = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.startsWith("replace_with_"), "must be replaced");

const ipLiteral = z
  .string()
  .trim()
  .refine((value) => isIP(value) !== 0, "must be a valid IP address");

const ethereumAddress = nonPlaceholder
  .refine((value) => isAddress(value), "must be a valid Ethereum address")
  .transform((value) => getAddress(value).toLowerCase());

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  EVLLM_CONTROLLED_WALLET_ADDRESS: ethereumAddress.optional(),
  EVLLM_DB_HOST: z.string().trim().min(1).default("127.0.0.1"),
  EVLLM_DB_NAME: z.string().trim().min(1).default("evllm"),
  EVLLM_DB_PASSWORD: nonPlaceholder,
  EVLLM_DB_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  EVLLM_DB_USER: z.string().trim().min(1).default("evllm"),
  EVLLM_HTTP_HOST: ipLiteral.default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  OPENAI_API_KEY: nonPlaceholder.optional(),
  OPENAI_MODEL: z.string().trim().min(1).default(OPENAI_ASSISTANT_MODEL),
});

export interface AppConfig {
  readonly appEnvironment: "development" | "test" | "production";
  readonly controlledWalletAddress?: string;
  readonly database: Readonly<{
    database: string;
    host: string;
    password: string;
    port: number;
    user: string;
  }>;
  readonly httpHost: string;
  readonly port: number;
  readonly openai: Readonly<{ apiKey?: string; model: string }>;
  readonly projectRoot: string;
}

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(environment);
  return Object.freeze({
    appEnvironment: parsed.APP_ENV,
    ...(parsed.EVLLM_CONTROLLED_WALLET_ADDRESS === undefined
      ? {}
      : { controlledWalletAddress: parsed.EVLLM_CONTROLLED_WALLET_ADDRESS }),
    database: Object.freeze({
      database: parsed.EVLLM_DB_NAME,
      host: parsed.EVLLM_DB_HOST,
      password: parsed.EVLLM_DB_PASSWORD,
      port: parsed.EVLLM_DB_PORT,
      user: parsed.EVLLM_DB_USER,
    }),
    httpHost: parsed.EVLLM_HTTP_HOST,
    port: parsed.PORT,
    openai: Object.freeze({
      ...(parsed.OPENAI_API_KEY === undefined ? {} : { apiKey: parsed.OPENAI_API_KEY }),
      model: parsed.OPENAI_MODEL,
    }),
    projectRoot,
  });
}

export function loadConfig(): AppConfig {
  const configuredPath = process.env.EVLLM_ENV_FILE?.trim();
  const environmentPath = configuredPath
    ? path.resolve(projectRoot, configuredPath)
    : defaultEnvironmentPath;
  dotenv.config({ path: environmentPath, quiet: true });
  return parseConfig(process.env);
}
