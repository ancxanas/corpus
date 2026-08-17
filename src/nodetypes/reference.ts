import type { Node, ReferencePayload, ValidationIssue } from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isReference(node: Node): node is Node<ReferencePayload> {
  return node.corpus.node_type === "Reference";
}

export const referenceModule: NodeTypeModule = {
  nodeType: "Reference",
  plural: "references",
  schemaFile: "reference.json",
  description:
    "Factual API/behavior documentation; each entry maps to a source pointer.",
  template(publicKey) {
    return {
      corpus: {
        version: "0.3.0",
        node_type: "Reference",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        reference: {
          title: "A short title for the reference",
          topic: "technology-name",
          source: {
            type: "official_docs",
            url: "https://example.com/docs",
            synced_at: new Date().toISOString(),
          },
          entries: [{
            name: "api-name",
            kind: "function",
            signature: "api-name(arg): void",
            description: "Describe the behavior.",
            version: ">=1.0.0",
            source_pointer: "https://example.com/docs#api-name",
          }],
          consistency: {
            method: "agent_verification",
            last_checked: new Date().toISOString(),
            result: "confirmed",
          },
        },
      },
    };
  },
  title(node) {
    return isReference(node) ? node.payload.reference.title : null;
  },
  meta(node) {
    if (!isReference(node)) {
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
      framework_name: node.payload.reference.topic,
      language: null,
      runtime_name: null,
      tags: node.payload.reference.tags ?? [],
    };
  },
  lifecycle(declared) {
    return declared === "draft" ? "draft" : "active";
  },
  relationshipNames: [],
  relationships() {
    return [];
  },
  linkedCids() {
    return [];
  },
  crossFieldChecks(node): ValidationIssue[] {
    if (!isReference(node)) {
      return [];
    }
    const reference = node.payload.reference;
    const issues: ValidationIssue[] = [];
    if (
      node.corpus.knowledge_lifecycle.status === "active" &&
      reference.consistency.result !== "confirmed"
    ) {
      issues.push({
        pointer: "/payload/reference/consistency/result",
        message: "active references must have consistency.result 'confirmed'",
      });
    }
    if (
      reference.consistency.method === "agent_verification" &&
      !reference.source.url &&
      !reference.source.snapshot_cid
    ) {
      issues.push({
        pointer: "/payload/reference/source",
        message:
          "agent_verification requires source.url or source.snapshot_cid",
      });
    }
    return issues;
  },
};
