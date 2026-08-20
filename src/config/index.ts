import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { z } from "zod";

const packageName = "evllm-second-hand-battery-marketplace";

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

const canonicalBase64Key = nonPlaceholder.refine((value) => {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    return false;
  }

  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value;
}, "must be the canonical padded Base64 encoding of exactly 32 bytes");

const environmentSchema = z.object({
  APP_ENV: z.enum(["development", "test", "production"]).default("development"),
  DOCUMENT_ENCRYPTION_KEY: canonicalBase64Key,
  DOCUMENT_STORE_PATH: z.string().trim().min(1).default("data/protected-evidence"),
  EVLLM_DB_HOST: z.string().trim().min(1).default("127.0.0.1"),
  EVLLM_DB_NAME: z.string().trim().min(1).default("evllm"),
  EVLLM_DB_PASSWORD: nonPlaceholder,
  EVLLM_DB_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  EVLLM_DB_USER: z.string().trim().min(1).default("evllm"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  OPENAI_API_KEY: nonPlaceholder.optional(),
  OPENAI_MODEL: z.string().trim().min(1).default("gpt-4o-mini-2024-07-18"),
  SESSION_SECRET: nonPlaceholder.min(32),
});

export interface AppConfig {
  readonly appEnvironment: "development" | "test" | "production";
  readonly database: Readonly<{
    database: string;
    host: string;
    password: string;
    port: number;
    user: string;
  }>;
  readonly documentEncryptionKey: Buffer;
  readonly documentStorePath: string;
  readonly port: number;
  readonly openai: Readonly<{ apiKey?: string; model: string }>;
  readonly projectRoot: string;
  readonly sessionSecret: string;
}

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.parse(environment);
  const documentStorePath = path.isAbsolute(parsed.DOCUMENT_STORE_PATH)
    ? parsed.DOCUMENT_STORE_PATH
    : path.join(projectRoot, parsed.DOCUMENT_STORE_PATH);

  return Object.freeze({
    appEnvironment: parsed.APP_ENV,
    database: Object.freeze({
      database: parsed.EVLLM_DB_NAME,
      host: parsed.EVLLM_DB_HOST,
      password: parsed.EVLLM_DB_PASSWORD,
      port: parsed.EVLLM_DB_PORT,
      user: parsed.EVLLM_DB_USER,
    }),
    documentEncryptionKey: Buffer.from(parsed.DOCUMENT_ENCRYPTION_KEY, "base64"),
    documentStorePath,
    port: parsed.PORT,
    openai: Object.freeze({
      ...(parsed.OPENAI_API_KEY === undefined ? {} : { apiKey: parsed.OPENAI_API_KEY }),
      model: parsed.OPENAI_MODEL,
    }),
    projectRoot,
    sessionSecret: parsed.SESSION_SECRET,
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
