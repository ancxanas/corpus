import type { GuidePayload, Node, ValidationIssue } from "../core/types.ts";
import { uuidv7 } from "../core/uuidv7.ts";
import type { NodeTypeModule } from "./types.ts";

export function isGuide(node: Node): node is Node<GuidePayload> {
  return node.osk.node_type === "Guide";
}

export const guideModule: NodeTypeModule = {
  nodeType: "Guide",
  plural: "guides",
  schemaFile: "guide.json",
  template(publicKey) {
    return {
      osk: {
        version: "0.3.0",
        node_type: "Guide",
        node_id: uuidv7(),
        knowledge_lifecycle: {
          status: "active",
          last_verified: new Date().toISOString(),
        },
        attribution: { author_type: "agent", public_key: publicKey },
      },
      payload: {
        guide: {
          title: "A short title for the guide",
          epistemic_status: "verified",
          sections: [
            {
              heading: "Section heading",
              claim: "A specific, testable claim.",
              depth: "beginner",
              verification: {
                type: "demonstration",
                demonstration_cid: { "/": `b${"a".repeat(60)}` },
                playground_receipt: { "/": `b${"a".repeat(60)}` },
                result: "confirmed",
              },
            },
          ],
        },
      },
    };
  },
  meta() {
    return { severity: null, framework_name: null };
  },
  lifecycle(declared) {
    return declared === "draft" ? "draft" : "active";
  },
  relationships(node) {
    if (!isGuide(node)) {
      return [];
    }
    const prereqs = node.payload.guide.prerequisites ?? [];
    const links = prereqs.map((p) => ({ cid: p.node["/"], fallback: "nodes" }));
    return links.length ? [{ name: "prerequisites", links }] : [];
  },
  linkedCids(node, relationship) {
    if (!isGuide(node) || relationship !== "prerequisites") {
      return [];
    }
    return (node.payload.guide.prerequisites ?? []).map((p) => p.node["/"]);
  },
  crossFieldChecks(node): ValidationIssue[] {
    if (!isGuide(node)) {
      return [];
    }
    const guide = node.payload.guide;
    const issues: ValidationIssue[] = [];
    if (guide.epistemic_status === "verified") {
      for (const section of guide.sections) {
        if (section.verification.type === "source_attestation") {
          issues.push({
            pointer: `/payload/guide/sections/${
              guide.sections.indexOf(section)
            }/verification/type`,
            message:
              "a source-attestation claim caps the guide at epistemic_status 'heuristic'",
          });
        }
        if (!section.verification.playground_receipt) {
          issues.push({
            pointer: `/payload/guide/sections/${
              guide.sections.indexOf(section)
            }/verification/playground_receipt`,
            message: "verified claims require a playground_receipt",
          });
        }
      }
    }
    if (guide.epistemic_status === "heuristic" && !guide.caveats?.length) {
      issues.push({
        pointer: "/payload/guide/caveats",
        message: "heuristic guides must include caveats",
      });
    }
    for (const section of guide.sections) {
      if (
        section.verification.type === "source_attestation" &&
        !section.verification.attested_source
      ) {
        issues.push({
          pointer: `/payload/guide/sections/${
            guide.sections.indexOf(section)
          }/verification/attested_source`,
          message: "source-attestation claims require an attested_source",
        });
      }
    }
    return issues;
  },
};
