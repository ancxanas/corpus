import type { Node, RecipePayload } from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isRecipe(node: Node): node is Node<RecipePayload> {
  return node.osk.node_type === "Recipe";
}

export const recipeModule: NodeTypeModule = {
  nodeType: "Recipe",
  plural: "recipes",
  schemaFile: "recipe.json",
  template(publicKey) {
    return {
      osk: {
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
          code: {
            language: "typescript",
            framework: "deno",
            body: "// paste the recipe code here",
          },
          explanation: "Explain how the recipe fixes the problem.",
          caveats: [
            { condition: "when X happens", warning: "do Y instead" },
          ],
        },
      },
    };
  },
  meta() {
    return { severity: null, framework_name: null };
  },
  lifecycle(declared, verified) {
    if (declared === "draft") {
      return "draft";
    }
    return verified ? "active" : "draft";
  },
  relationships() {
    return [];
  },
  linkedCids() {
    return [];
  },
  crossFieldChecks() {
    return [];
  },
};
