import type {
  ComparisonPayload,
  Node,
  ValidationIssue,
} from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isComparison(node: Node): node is Node<ComparisonPayload> {
  return node.osk.node_type === "Comparison";
}

export const comparisonModule: NodeTypeModule = {
  nodeType: "Comparison",
  plural: "comparisons",
  schemaFile: "comparison.json",
  description:
    "Trade-off analysis; quantitative option values are benchmark-backed.",
  template(publicKey) {
    return {
      osk: {
        version: "0.3.0",
        node_type: "Comparison",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        comparison: {
          title: "A short title for the comparison",
          decision_context: "What decision this comparison informs.",
          dimensions: [{
            name: "dimension-name",
            options: [
              {
                name: "option-a",
                value: 1.0,
                benchmark_receipt: { "/": `b${"a".repeat(60)}` },
              },
            ],
          }],
          recommendations: [{
            condition: "when to choose",
            choice: "option-a",
            reason: "why this option wins",
          }],
        },
      },
    };
  },
  title(node) {
    return isComparison(node) ? node.payload.comparison.title : null;
  },
  meta(node) {
    if (!isComparison(node)) {
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
  relationshipNames: ["benchmarks"],
  relationships(node) {
    if (!isComparison(node)) {
      return [];
    }
    const receipts = new Set<string>();
    for (const dimension of node.payload.comparison.dimensions) {
      for (const option of dimension.options) {
        if (option.benchmark_receipt) {
          receipts.add(option.benchmark_receipt["/"]);
        }
      }
    }
    const links = [...receipts].map((cid) => ({
      cid,
      fallback: "verifications" as const,
    }));
    return links.length ? [{ name: "benchmarks", links }] : [];
  },
  linkedCids(node, relationship) {
    if (!isComparison(node) || relationship !== "benchmarks") {
      return [];
    }
    const receipts = new Set<string>();
    for (const dimension of node.payload.comparison.dimensions) {
      for (const option of dimension.options) {
        if (option.benchmark_receipt) {
          receipts.add(option.benchmark_receipt["/"]);
        }
      }
    }
    return [...receipts];
  },
  crossFieldChecks(node): ValidationIssue[] {
    if (!isComparison(node)) {
      return [];
    }
    const comparison = node.payload.comparison;
    const issues: ValidationIssue[] = [];
    const optionNames = new Set<string>();
    let index = 0;
    for (const dimension of comparison.dimensions) {
      let oi = 0;
      for (const option of dimension.options) {
        optionNames.add(option.name);
        if (
          node.osk.knowledge_lifecycle.status === "active" &&
          typeof option.value === "number" &&
          !option.benchmark_receipt
        ) {
          issues.push({
            pointer:
              `/payload/comparison/dimensions/${index}/options/${oi}/benchmark_receipt`,
            message:
              "active comparisons require a benchmark_receipt for numeric option values",
          });
        }
        oi += 1;
      }
      index += 1;
    }
    for (const recommendation of comparison.recommendations) {
      if (!optionNames.has(recommendation.choice)) {
        issues.push({
          pointer: `/payload/comparison/recommendations/${
            comparison.recommendations.indexOf(recommendation)
          }/choice`,
          message: "recommendations.choice must name an option from dimensions",
        });
      }
    }
    return issues;
  },
};
