import type { Node, ProblemPayload } from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isProblem(node: Node): node is Node<ProblemPayload> {
  return node.osk.node_type === "Problem";
}

export const problemModule: NodeTypeModule = {
  nodeType: "Problem",
  plural: "problems",
  schemaFile: "problem.json",
  description:
    "A diagnosed failure: symptoms, root cause, and reproduction. Links to solution recipes.",
  template(publicKey) {
    return {
      osk: {
        version: "0.3.0",
        node_type: "Problem",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        problem: {
          title: "A short title for the problem",
          severity: "high",
          summary: "A 2-3 sentence overview of the problem and its context.",
          impact: "What breaks for users or systems when this occurs.",
          symptoms: [
            {
              type: "runtime_behavior",
              description: "describe the symptom",
              observable: "describe the observable signal",
              frequency: "intermittent",
            },
          ],
          reproduction: [
            { title: "First step", body: "describe what to do" },
          ],
          diagnosis: [
            { title: "Confirm the cause", body: "describe how to verify" },
          ],
          root_cause: {
            mechanism: "describe the root cause",
            causal_chain: ["link1", "link2"],
          },
          environment: {
            runtime: { type: "node", versions: ["22.x"] },
            framework: { name: "deno", version: "2.x" },
          },
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
    return isProblem(node) ? node.payload.problem.title : null;
  },
  meta(node) {
    if (!isProblem(node)) {
      return {
        severity: null,
        framework_name: null,
        language: null,
        runtime_name: null,
      };
    }
    return {
      severity: node.payload.problem.severity,
      framework_name: node.payload.problem.environment.framework.name,
      language: null,
      runtime_name: node.payload.problem.environment.runtime.type,
    };
  },
  lifecycle(declared) {
    return declared;
  },
  relationshipNames: ["solutions"],
  relationships(node) {
    if (!isProblem(node)) {
      return [];
    }
    const solutions = node.payload.problem.solutions ?? [];
    return [{
      name: "solutions",
      links: solutions.map((s) => ({
        cid: s.node["/"],
        fallback: "recipes",
        ...(s.applies_to ? { meta: { applies_to: s.applies_to } } : {}),
      })),
    }];
  },
  linkedCids(node, relationship) {
    if (!isProblem(node) || relationship !== "solutions") {
      return [];
    }
    return (node.payload.problem.solutions ?? []).map((s) => s.node["/"]);
  },
  crossFieldChecks() {
    return [];
  },
};
