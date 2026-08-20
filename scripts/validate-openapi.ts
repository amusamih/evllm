import { resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";

const documentPath = resolve("contracts/generated/openapi.json");
const api = (await SwaggerParser.validate(documentPath)) as unknown as {
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
};
const operations = Object.values(api.paths ?? {}).reduce(
  (count, pathItem) =>
    count +
    Object.keys(pathItem ?? {}).filter((key) =>
      ["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(key),
    ).length,
  0,
);

if (api.openapi !== "3.1.1" || operations !== 19) {
  throw new Error(
    `Unexpected validated OpenAPI surface: version=${api.openapi} operations=${operations}`,
  );
}

process.stdout.write(`Validated OpenAPI ${api.openapi}: ${operations} operations.\n`);
