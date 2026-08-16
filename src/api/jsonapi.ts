import type { IndexedNode } from "../storage/types.ts";
import { pluralOf, registry } from "../nodetypes/registry.ts";

export interface JsonApiError {
  status: string;
  title: string;
  detail?: string;
  source?: { pointer?: string; parameter?: string };
}

export function errorDocument(errors: JsonApiError[]): Record<string, unknown> {
  return { jsonapi: { version: "1.0" }, errors };
}

export interface ResourceId {
  type: string;
  id: string;
  meta?: Record<string, unknown>;
}

export function resourceIdentifier(type: string, id: string): ResourceId {
  return { type, id };
}

export function serializeResource(
  indexed: IndexedNode,
  baseUrl: string,
  relationships: Record<string, { related: string; data: ResourceId[] }> = {},
): Record<string, unknown> {
  return {
    type: pluralOf(indexed.node_type),
    id: indexed.cid,
    links: { self: `${baseUrl}/nodes/${indexed.cid}` },
    attributes: {
      osk: indexed.node.osk,
      payload: indexed.node.payload,
    },
    relationships: Object.fromEntries(
      Object.entries(relationships).map(([name, rel]) => [
        name,
        {
          links: { related: `${baseUrl}/nodes/${indexed.cid}/${name}` },
          data: rel.data,
        },
      ]),
    ),
    meta: {
      cid: indexed.cid,
      title: registry[indexed.node_type].title(indexed.node),
      effective_status: indexed.effective_status,
      confidence_score: indexed.confidence_score,
      created_at: indexed.created_at,
      head: indexed.head,
      version: indexed.version_seq,
    },
  };
}

export function document(
  data: unknown,
  options: {
    baseUrl: string;
    self?: string;
    included?: unknown[];
    links?: Record<string, string | null | undefined>;
    meta?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    jsonapi: { version: "1.0" },
    links: {
      self: options.self ?? options.baseUrl,
      ...options.links,
    },
  };
  if (data !== null) {
    doc.data = data;
  }
  if (options.included && options.included.length > 0) {
    doc.included = options.included;
  }
  if (options.meta) {
    doc.meta = options.meta;
  }
  return doc;
}
