import type { BlueprintPayload, Node, ValidationIssue } from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isBlueprint(node: Node): node is Node<BlueprintPayload> {
  return node.osk.node_type === "Blueprint";
}

export const blueprintModule: NodeTypeModule = {
  nodeType: "Blueprint",
  plural: "blueprints",
  schemaFile: "blueprint.json",
  description:
    "Architectural vision with feasibility analysis and adoption trajectory.",
  template(publicKey) {
    return {
      osk: {
        version: "0.3.0",
        node_type: "Blueprint",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        blueprint: {
          title: "A short title for the blueprint",
          current_landscape: {
            fragments: [{
              technology: "existing-technology",
              purpose: "What it does",
              limitations: ["limitation 1"],
            }],
            systemic_friction: "The core problem with the current state.",
          },
          proposed_architecture: {
            core_principle: "A single-sentence architectural thesis.",
            layers: [{
              layer: 1,
              name: "layer-name",
              technology: "technology",
              responsibility: "What this layer does",
            }],
          },
          rationale: ["Why this architecture is better"],
          feasibility: {
            blockers: [{
              issue: "What blocks this",
              type: "implementation",
              severity: "medium",
            }],
            enablers: ["condition that makes this possible"],
          },
          adoption_trajectory: {
            phase_1: "near-term milestone",
            phase_2: "mid-term milestone",
            phase_3: "long-term milestone",
          },
          related_nodes: [{
            node: { "/": `b${"a".repeat(60)}` },
            relation: "enables",
          }],
          epistemic_status: "vision",
          confidence: "medium",
        },
      },
    };
  },
  title(node) {
    return isBlueprint(node) ? node.payload.blueprint.title : null;
  },
  meta(node) {
    if (!isBlueprint(node)) {
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
      framework_name: null,
      language: null,
      runtime_name: null,
      tags: node.payload.blueprint.tags ?? [],
    };
  },
  lifecycle(declared) {
    return declared === "draft" ? "draft" : "active";
  },
  relationshipNames: ["related_nodes"],
  relationships(node) {
    if (!isBlueprint(node)) {
      return [];
    }
    const links = (node.payload.blueprint.related_nodes ?? []).map((link) => ({
      cid: link.node["/"],
      fallback: "nodes",
      meta: { relation: link.relation },
    }));
    return links.length ? [{ name: "related_nodes", links }] : [];
  },
  linkedCids(node, relationship) {
    if (!isBlueprint(node) || relationship !== "related_nodes") {
      return [];
    }
    return (node.payload.blueprint.related_nodes ?? []).map((link) =>
      link.node["/"]
    );
  },
  crossFieldChecks(node): ValidationIssue[] {
    if (!isBlueprint(node)) {
      return [];
    }
    const issues: ValidationIssue[] = [];
    const trajectory = node.payload.blueprint.adoption_trajectory;
    if (trajectory) {
      for (const key of ["phase_1", "phase_2", "phase_3"] as const) {
        if (!trajectory[key]) {
          issues.push({
            pointer: `/payload/blueprint/adoption_trajectory/${key}`,
            message: "adoption_trajectory phases must not be empty",
          });
        }
      }
    }
    return issues;
  },
};
