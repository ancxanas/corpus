import type { IndexedNode } from "../storage/types.ts";
import type { Node } from "../core/types.ts";
import { pluralOf, registry } from "../nodetypes/registry.ts";
import { type ResourceId, serializeResource } from "./jsonapi.ts";
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
  return target ? pluralOf(target.node_type) : fallback;
}

export function extractRelationships(
  index: QueryIndex,
  node: Node,
  cid: string,
): Record<string, RelationshipView> {
  const result: Record<string, RelationshipView> = {};
  for (const def of registry[node.osk.node_type].relationships(node)) {
    result[def.name] = {
      related: `/nodes/${cid}/${def.name}`,
      data: def.links.map((l) => ({
        type: typeOfLinked(index, l.cid, l.fallback),
        id: l.cid,
        ...(l.meta ? { meta: l.meta } : {}),
      })),
    };
  }
  return result;
}

export function linkedCidsOf(
  node: Node,
  relationship: string,
): string[] {
  return registry[node.osk.node_type].linkedCids(node, relationship);
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
