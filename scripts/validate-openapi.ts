import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import SwaggerParser from "@apidevtools/swagger-parser";

const documentPath = resolve("contracts/generated/openapi.json");
const catalogPath = resolve("contracts/generated/architecture/api-operations.json");
const api = (await SwaggerParser.validate(documentPath)) as unknown as {
  openapi?: string;
  "x-evllm-artifact-kind"?: string;
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
const assistantPath = api.paths?.["/api/v1/query/assistant"];
const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
  schema?: string;
  artifact_kind?: string;
  operations?: Array<{ method?: string; path?: string; operationId?: string }>;
};
const documentedOperations = Object.entries(api.paths ?? {})
  .flatMap(([path, pathItem]) =>
    Object.entries(pathItem).flatMap(([method, operation]) => {
      if (!["get", "put", "post", "delete", "options", "head", "patch", "trace"].includes(method)) {
        return [];
      }
      const operationId =
        typeof operation === "object" &&
        operation !== null &&
        "operationId" in operation &&
        typeof operation.operationId === "string"
          ? operation.operationId
          : "";
      return [{ method, path, operationId }];
    }),
  )
  .sort(operationOrder);
const catalogOperations = (catalog.operations ?? [])
  .map(({ method = "", path = "", operationId = "" }) => ({ method, path, operationId }))
  .sort(operationOrder);

if (
  api.openapi !== "3.1.1" ||
  api["x-evllm-artifact-kind"] !== "multi-organization-design-contract" ||
  operations !== 19 ||
  assistantPath?.post === undefined ||
  assistantPath?.get !== undefined ||
  catalog.schema !== "EVLLM_DESIGN_API_OPERATION_CATALOG_V1" ||
  catalog.artifact_kind !== "multi-organization-design-contract" ||
  JSON.stringify(catalogOperations) !== JSON.stringify(documentedOperations)
) {
  throw new Error(
    `Unexpected validated OpenAPI design contract: version=${api.openapi} kind=${String(api["x-evllm-artifact-kind"])} operations=${operations}`,
  );
}

process.stdout.write(
  `Validated OpenAPI ${api.openapi} multi-organization design contract: ${operations} operations.\n`,
);

function operationOrder(
  left: { method: string; path: string; operationId: string },
  right: { method: string; path: string; operationId: string },
): number {
  return `${left.path}:${left.method}:${left.operationId}`.localeCompare(
    `${right.path}:${right.method}:${right.operationId}`,
  );
}
