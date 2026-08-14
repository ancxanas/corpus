import { uuidv7 } from "../core/uuidv7.ts";

export function recipeNode(pubKey: string): Record<string, unknown> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Recipe",
      node_id: uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: new Date().toISOString(),
      },
      attribution: { author_type: "agent", public_key: pubKey },
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
}

export function problemNode(pubKey: string): Record<string, unknown> {
  return {
    osk: {
      version: "0.3.0",
      node_type: "Problem",
      node_id: uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: new Date().toISOString(),
      },
      attribution: { author_type: "agent", public_key: pubKey },
    },
    payload: {
      problem: {
        title: "A short title for the problem",
        severity: "high",
        symptoms: [
          {
            type: "runtime_behavior",
            description: "describe the symptom",
            observable: "describe the observable signal",
            frequency: "intermittent",
          },
        ],
        root_cause: {
          mechanism: "describe the root cause",
          causal_chain: ["link1", "link2"],
        },
        environment: {
          runtime: { type: "node", versions: ["22.x"] },
          framework: { name: "deno", version: "2.x" },
        },
      },
    },
  };
}
