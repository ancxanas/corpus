import type {
  ImprovementPayload,
  Node,
  ValidationIssue,
} from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule, RelationshipDef } from "./types.ts";

export function isImprovement(node: Node): node is Node<ImprovementPayload> {
  return node.osk.node_type === "Improvement";
}

export const improvementModule: NodeTypeModule = {
  nodeType: "Improvement",
  plural: "improvements",
  schemaFile: "improvement.json",
  description:
    "Phased migration plan with before/after metrics and linked recipes.",
  template(publicKey) {
    return {
      osk: {
        version: "0.3.0",
        node_type: "Improvement",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        improvement: {
          title: "A short title for the improvement",
          current_state: {
            description: "Describe the current state.",
            metrics: { latency_ms: 1000 },
          },
          target_state: {
            description: "Describe the target state.",
            expected_metrics: { latency_ms: 200 },
          },
          rationale: "Why this improvement is needed.",
          implementation: {
            approach: "incremental",
            phases: [
              {
                phase: 1,
                title: "First phase",
                effort: "S",
                recipe_links: [{
                  node: { "/": `b${"a".repeat(60)}` },
                  relation: "uses",
                }],
              },
            ],
          },
          trade_offs: [{
            aspect: "What is traded",
            downside: "Negative consequence",
            mitigation: "How to address it",
          }],
          validation: {
            success_criteria: "Measurable success condition",
            verification_plan: "How to measure success",
          },
        },
      },
    };
  },
  title(node) {
    return isImprovement(node) ? node.payload.improvement.title : null;
  },
  meta(node) {
    if (!isImprovement(node)) {
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
      tags: [],
    };
  },
  lifecycle(declared) {
    return declared === "draft" ? "draft" : "active";
  },
  relationshipNames: ["recipes", "benchmarks"],
  relationships(node) {
    if (!isImprovement(node)) {
      return [];
    }
    const improvement = node.payload.improvement;
    const out: RelationshipDef[] = [];
    const recipes = improvement.implementation.phases.flatMap((phase) =>
      (phase.recipe_links ?? []).map((link) => ({
        cid: link.node["/"],
        fallback: "recipes",
        meta: { relation: link.relation },
      }))
    );
    if (recipes.length) {
      out.push({ name: "recipes", links: recipes });
    }
    const receipts = (improvement.validation.benchmark_receipts ?? []).map((
      link,
    ) => ({ cid: link["/"], fallback: "verifications" }));
    if (receipts.length) {
      out.push({ name: "benchmarks", links: receipts });
    }
    return out;
  },
  linkedCids(node, relationship) {
    if (!isImprovement(node)) {
      return [];
    }
    const improvement = node.payload.improvement;
    if (relationship === "recipes") {
      return improvement.implementation.phases.flatMap((phase) =>
        (phase.recipe_links ?? []).map((link) => link.node["/"])
      );
    }
    if (relationship === "benchmarks") {
      return (improvement.validation.benchmark_receipts ?? []).map((link) =>
        link["/"]
      );
    }
    return [];
  },
  crossFieldChecks(node): ValidationIssue[] {
    if (!isImprovement(node)) {
      return [];
    }
    const validation = node.payload.improvement.validation;
    const issues: ValidationIssue[] = [];
    const hasBenchmarks = (validation.benchmark_receipts ?? []).length > 0;
    const hasCriteria = Boolean(
      validation.success_criteria && validation.verification_plan,
    );
    if (!hasBenchmarks && !hasCriteria) {
      issues.push({
        pointer: "/payload/improvement/validation",
        message:
          "validation must include benchmark_receipts or success_criteria with verification_plan",
      });
    }
    return issues;
  },
};
