import type { IndexedNode } from "../storage/types.ts";
import type { Node } from "../core/types.ts";
import { PLURAL, type ResourceId, serializeResource } from "./jsonapi.ts";
import type { QueryIndex } from "../storage/index.ts";

export interface RelationshipView {
  related: string;
  data: ResourceId[];
}

export function typeOfLinked(
  index: QueryIndex,
  cid: string,
  fallback: string,
): string {
  const target = index.getNode(cid);
  return target ? PLURAL[target.node_type] : fallback;
}

function toResourceIds(
  index: QueryIndex,
  links: { cid: string; meta?: Record<string, unknown>; fallback: string }[],
): ResourceId[] {
  return links.map((l) => ({
    type: typeOfLinked(index, l.cid, l.fallback),
    id: l.cid,
    ...(l.meta ? { meta: l.meta } : {}),
  }));
}

export function extractRelationships(
  index: QueryIndex,
  node: Node,
  cid: string,
): Record<string, RelationshipView> {
  const result: Record<string, RelationshipView> = {};
  const related = (name: string) => ({
    related: `/nodes/${cid}/${name}`,
  });

  if (node.osk.node_type === "Problem") {
    const solutions = (node.payload as { problem: { solutions?: Array<{ node: { "/": string }; applies_to?: string }> } })
      .problem.solutions ?? [];
    result.solutions = {
      ...related("solutions"),
      data: toResourceIds(
        index,
        solutions.map((s) => ({
          cid: s.node["/"],
          fallback: "recipes",
          ...(s.applies_to ? { meta: { applies_to: s.applies_to } } : {}),
        })),
      ),
    };
  }

  if (node.osk.node_type === "Verification") {
    const verification = (node.payload as { verification: { target: { problem_id: { "/": string }; solution_id: { "/": string } } } })
      .verification;
    result.target = {
      ...related("target"),
      data: [
        {
          type: typeOfLinked(index, verification.target.problem_id["/"], "problems"),
          id: verification.target.problem_id["/"],
        },
        {
          type: typeOfLinked(index, verification.target.solution_id["/"], "recipes"),
          id: verification.target.solution_id["/"],
        },
      ],
    };
  }

  return result;
}

export function linkedCidsOf(
  node: Node,
  relationship: string,
): string[] {
  if (node.osk.node_type === "Problem" && relationship === "solutions") {
    const solutions = (node.payload as { problem: { solutions?: Array<{ node: { "/": string } }> } })
      .problem.solutions ?? [];
    return solutions.map((s) => s.node["/"]);
  }
  if (node.osk.node_type === "Verification" && relationship === "target") {
    const verification = (node.payload as { verification: { target: { problem_id: { "/": string }; solution_id: { "/": string } } } })
      .verification;
    return [verification.target.problem_id["/"], verification.target.solution_id["/"]];
  }
  return [];
}

export function serializeWithIncludes(
  index: QueryIndex,
  indexed: IndexedNode,
  baseUrl: string,
  includePaths: string[],
): { resource: Record<string, unknown>; included: Record<string, unknown>[] } {
  const relationships = extractRelationships(index, indexed.node, indexed.cid);
  const resource = serializeResource(indexed, baseUrl, relationships);
  const included: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const path of includePaths) {
    if (path !== "solutions" && path !== "target") {
      continue;
    }
    for (const cid of linkedCidsOf(indexed.node, path)) {
      if (seen.has(cid)) {
        continue;
      }
      seen.add(cid);
      const target = index.getNode(cid);
      if (target) {
        included.push(serializeResource(target, baseUrl));
      }
    }
  }
  return { resource, included };
}
