import type { Node, RecipePayload } from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isRecipe(node: Node): node is Node<RecipePayload> {
  return node.corpus.node_type === "Recipe";
}

export const recipeModule: NodeTypeModule = {
  nodeType: "Recipe",
  plural: "recipes",
  schemaFile: "recipe.json",
  description: "A verified fix with code, steps, and caveats.",
  template(publicKey) {
    return {
      corpus: {
        version: "0.3.0",
        node_type: "Recipe",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        recipe: {
          title: "A short title for the recipe",
          summary: "A 2-3 sentence overview of the approach.",
          code: {
            language: "typescript",
            framework: "deno",
            body: "// paste the recipe code here",
          },
          explanation: "Explain how the recipe fixes the problem.",
          prerequisites: [
            { description: "What must be in place before this applies" },
          ],
          steps: [
            { title: "First step", body: "describe what to do" },
          ],
          verification: "How to confirm the recipe works in practice.",
          caveats: [
            { condition: "when X happens", warning: "do Y instead" },
          ],
          tags: ["keyword1", "keyword2"],
          references: [{
            title: "Reference title",
            url: "https://example.com",
          }],
        },
      },
    };
  },
  title(node) {
    return isRecipe(node) ? node.payload.recipe.title : null;
  },
  meta(node) {
    if (!isRecipe(node)) {
      return {
        severity: null,
        framework_name: null,
        language: null,
        runtime_name: null,
        tags: [],
      };
    }
    return {
      severity: null,
      framework_name: node.payload.recipe.code.framework ?? null,
      language: node.payload.recipe.code.language,
      runtime_name: null,
      tags: node.payload.recipe.tags ?? [],
    };
  },
  lifecycle(declared, verified) {
    if (declared === "draft") {
      return "draft";
    }
    return verified ? "active" : "draft";
  },
  relationshipNames: ["prerequisites"],
  relationships(node) {
    if (!isRecipe(node)) {
      return [];
    }
    const prereqs = node.payload.recipe.prerequisites ?? [];
    const links = prereqs
      .filter((p): p is Required<typeof p> => Boolean(p.node))
      .map((p) => ({ cid: p.node["/"], fallback: "nodes" }));
    return links.length ? [{ name: "prerequisites", links }] : [];
  },
  reverseRelationships: [{ name: "problems", forwardName: "solutions" }],
  linkedCids(node, relationship) {
    if (!isRecipe(node) || relationship !== "prerequisites") {
      return [];
    }
    return (node.payload.recipe.prerequisites ?? [])
      .map((p) => p.node?.["/"])
      .filter((c): c is string => Boolean(c));
  },
  crossFieldChecks() {
    return [];
  },
};
