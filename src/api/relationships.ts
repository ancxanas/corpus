import type { IndexedNode } from "../storage/types.ts";
import type { Node } from "../core/types.ts";
import { pluralOf, registry } from "../nodetypes/registry.ts";
import { type ResourceId, serializeResource } from "./jsonapi.ts";
import type { NodeStore } from "../storage/node_store.ts";

export interface RelationshipView {
  related: string;
  data: ResourceId[];
}

export async function typeOfLinked(
  store: NodeStore,
  cid: string,
  fallback: string,
): Promise<string> {
  const target = await store.getNode(cid);
  return target ? pluralOf(target.node_type) : fallback;
}

export async function extractRelationships(
  store: NodeStore,
  node: Node,
  cid: string,
): Promise<Record<string, RelationshipView>> {
  const result: Record<string, RelationshipView> = {};
  for (const def of registry[node.osk.node_type].relationships(node)) {
    result[def.name] = {
      related: `/nodes/${cid}/${def.name}`,
      data: await Promise.all(def.links.map(async (l) => ({
        type: await typeOfLinked(store, l.cid, l.fallback),
        id: l.cid,
        ...(l.meta ? { meta: l.meta } : {}),
      }))),
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

export async function serializeWithIncludes(
  store: NodeStore,
  indexed: IndexedNode,
  baseUrl: string,
  includePaths: string[],
  resolve?: (cid: string) => Promise<Record<string, unknown> | null>,
): Promise<{
  resource: Record<string, unknown>;
  included: Record<string, unknown>[];
}> {
  const relationships = await extractRelationships(
    store,
    indexed.node,
    indexed.cid,
  );
  const resource = serializeResource(indexed, baseUrl, relationships);
  const included: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const path of includePaths) {
    for (const cid of linkedCidsOf(indexed.node, path)) {
      if (seen.has(cid)) {
        continue;
      }
      seen.add(cid);
      const target = resolve
        ? await resolve(cid)
        : await resolveNode(store, cid, baseUrl);
      if (target) {
        included.push(target);
      }
    }
  }
  return { resource, included };
}

async function resolveNode(
  store: NodeStore,
  cid: string,
  baseUrl: string,
): Promise<Record<string, unknown> | null> {
  const target = await store.getNode(cid);
  return target ? serializeResource(target, baseUrl) : null;
}
