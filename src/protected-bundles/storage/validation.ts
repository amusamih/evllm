import { opaqueObjectId, urn } from "../../schemas/index.js";
import { ObjectStoreError } from "./types.js";

export function validateObjectId(value: string): string {
  const result = opaqueObjectId.safeParse(value);
  if (!result.success) {
    throw new ObjectStoreError("invalid-object-id", "Invalid opaque object identifier");
  }
  return result.data;
}

export function namespaceKey(organizationId: string): string {
  const parsed = urn("org").parse(organizationId);
  return parsed.slice(parsed.lastIndexOf(":") + 1);
}
