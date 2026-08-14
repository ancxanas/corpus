import type { NodeType } from "../core/types.ts";

const here = import.meta.dirname ?? ".";

const SCHEMA_FILES: Record<NodeType, string> = {
  Problem: "problem.json",
  Recipe: "recipe.json",
  Verification: "verification.json",
};

const cache = new Map<NodeType, unknown>();

export async function loadSchema(nodeType: NodeType): Promise<unknown> {
  const cached = cache.get(nodeType);
  if (cached) {
    return cached;
  }
  const file = SCHEMA_FILES[nodeType];
  if (!file) {
    throw new Error(`No schema registered for node type: ${nodeType}`);
  }
  const schema = JSON.parse(await Deno.readTextFile(`${here}/${file}`));
  cache.set(nodeType, schema);
  return schema;
}
