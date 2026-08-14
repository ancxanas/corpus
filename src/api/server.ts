import type { IngestService } from "../storage/ingest.ts";
import type { QueryIndex } from "../storage/index.ts";
import type { Node } from "../core/types.ts";
import {
  ReplayUnavailableError,
  SignatureError,
  ValidationError,
} from "../storage/ingest.ts";
import { InvalidNodeError } from "../storage/types.ts";
import { loadSchema } from "../schema/index.ts";
import {
  document,
  errorDocument,
  resourceIdentifier,
  serializeResource,
} from "./jsonapi.ts";
import {
  byPluralOrSingular,
  isVerification,
  pluralOf,
} from "../nodetypes/registry.ts";
import {
  extractRelationships,
  linkedCidsOf,
  serializeWithIncludes,
} from "./relationships.ts";
import {
  acceptsJsonApi,
  DEFAULT_BODY_LIMIT,
  hasJsonApiContentType,
  jsonResponse,
  methodNotAllowed,
  notAcceptable,
  notFoundResponse,
  parseBody,
  payloadTooLarge,
  unsupportedMediaType,
  unsupportedNodeTypeError,
} from "./http.ts";

const SPEC_COLLECTIONS = [
  "problems",
  "guides",
  "recipes",
  "references",
  "comparisons",
  "improvements",
  "blueprints",
  "verifications",
] as const;

const ADVERTISED_COLLECTIONS = new Set<string>(SPEC_COLLECTIONS);

function entryPoint(baseUrl: string): Record<string, unknown> {
  const collectionLinks: Record<string, string> = {};
  for (const name of SPEC_COLLECTIONS) {
    collectionLinks[name] = `${baseUrl}/${name}`;
  }
  return document(null, {
    baseUrl,
    links: {
      self: baseUrl,
      ...collectionLinks,
      schemas: `${baseUrl}/schemas/{node_type}`,
      submit: `${baseUrl}/nodes`,
    },
  });
}

export interface CreateAppOptions {
  bodyLimit?: number;
  baseUrl?: string | null;
  corsOrigins?: string[];
  logger?: (line: string) => void;
}

export function createApp(
  ingest: IngestService,
  index: QueryIndex,
  options: CreateAppOptions = {},
) {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const logger = options.logger ?? ((line: string) => console.log(line));
  const baseUrlOption = options.baseUrl ?? null;
  const corsOrigins = options.corsOrigins ?? [];
  const allowAllOrigins = corsOrigins.includes("*");

  function allowedOrigin(request: Request): string | null {
    const origin = request.headers.get("origin");
    if (origin === null) {
      return null;
    }
    if (allowAllOrigins) {
      return origin;
    }
    return corsOrigins.includes(origin) ? origin : null;
  }

  function withCorsHeaders(response: Response, request: Request): Response {
    const origin = allowedOrigin(request);
    if (origin === null) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
    return new Response(response.body, { status: response.status, headers });
  }

  function preflightResponse(origin: string): Response {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin",
      },
    });
  }

  return async function handler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const started = performance.now();
    if (request.method === "OPTIONS") {
      const origin = allowedOrigin(request);
      if (origin !== null) {
        return preflightResponse(origin);
      }
    }
    const isHead = request.method === "HEAD";
    const response = await route(
      request,
      url,
      isHead ? "GET" : request.method,
      requestId,
    );
    const finished = isHead
      ? new Response(null, {
        status: response.status,
        headers: response.headers,
      })
      : response;
    const duration = Math.round(performance.now() - started);
    logger(
      `${request.method} ${url.pathname} ${finished.status} ${duration}ms ${requestId}`,
    );
    const headers = new Headers(finished.headers);
    headers.set("X-Request-Id", requestId);
    const final = new Response(finished.body, {
      status: finished.status,
      headers,
    });
    return withCorsHeaders(final, request);
  };

  async function route(
    request: Request,
    url: URL,
    method: string,
    requestId: string,
  ): Promise<Response> {
    if (!acceptsJsonApi(request)) {
      return notAcceptable();
    }
    const baseUrl = (baseUrlOption ?? url.origin).replace(/\/+$/, "");
    const segments = url.pathname.split("/").filter(Boolean);

    try {
      if (segments.length === 0 && method === "GET") {
        return jsonResponse(entryPoint(baseUrl));
      }

      if (
        segments[0] === "nodes" && method === "POST" && segments.length === 1
      ) {
        return await createNode(request, baseUrl);
      }

      if (
        segments[0] === "nodes" && method === "GET" && segments.length === 1
      ) {
        return await searchNodes(request, baseUrl);
      }

      if (
        segments[0] === "nodes" && segments.length === 1 &&
        method !== "GET" && method !== "POST"
      ) {
        return methodNotAllowed("GET, POST");
      }

      if (segments[0] === "nodes" && segments[1] === "by-node-id") {
        if (segments.length !== 3 && segments.length !== 4) {
          return notFoundResponse();
        }
        if (method !== "GET") {
          return methodNotAllowed("GET");
        }
        return await byNodeId(segments, baseUrl);
      }

      if (segments[0] === "nodes" && segments.length === 2) {
        if (method !== "GET") {
          return methodNotAllowed("GET");
        }
        return await getNode(request, segments[1]!, baseUrl);
      }

      if (segments[0] === "nodes" && segments.length === 3) {
        if (method !== "GET") {
          return methodNotAllowed("GET");
        }
        return await getRelationship(segments[1]!, segments[2]!, baseUrl);
      }

      if (segments[0] === "verifications" && method === "POST") {
        return await createVerification(request, baseUrl);
      }

      if (segments.length === 1 && ADVERTISED_COLLECTIONS.has(segments[0]!)) {
        if (method !== "GET") {
          return methodNotAllowed("GET");
        }
        return await searchNodes(request, baseUrl, segments[0]);
      }

      if (
        segments[0] === "schemas" && segments.length === 2 && method === "GET"
      ) {
        return await getSchema(segments[1]!);
      }

      if (segments[0] === "schemas" && segments.length === 2) {
        return methodNotAllowed("GET");
      }

      return notFoundResponse();
    } catch (e) {
      if (e instanceof ValidationError) {
        return jsonResponse(
          errorDocument(
            e.issues.map((i) => ({
              status: "422",
              title: "validation failed",
              detail: i.message,
              source: { pointer: i.pointer || "/" },
            })),
          ),
          422,
        );
      }
      if (e instanceof SignatureError) {
        return jsonResponse(
          errorDocument([
            {
              status: "422",
              title: "invalid signature",
              detail: "The node signature is invalid.",
            },
          ]),
          422,
        );
      }
      if (e instanceof ReplayUnavailableError) {
        return jsonResponse(
          errorDocument([
            {
              status: "503",
              title: "verification execution unavailable",
              detail: e.message,
            },
          ]),
          503,
        );
      }
      if (e instanceof InvalidNodeError) {
        return jsonResponse(
          errorDocument([
            { status: "422", title: "invalid node", detail: e.message },
          ]),
          422,
        );
      }
      console.error(`[${requestId}]`, e);
      return jsonResponse(
        errorDocument([{
          status: "500",
          title: "internal error",
          detail: "An unexpected error occurred.",
        }]),
        500,
      );
    }
  }

  async function createNode(
    request: Request,
    baseUrl: string,
  ): Promise<Response> {
    if (!hasJsonApiContentType(request)) {
      return unsupportedMediaType();
    }
    const parsed = await parseBody(request, bodyLimit);
    if (parsed.tooLarge) {
      return payloadTooLarge(bodyLimit);
    }
    const data =
      (parsed.body as { data?: { type?: string; attributes?: unknown } } | null)
        ?.data;
    if (!data?.attributes) {
      return jsonResponse(
        errorDocument([
          {
            status: "422",
            title: "invalid request",
            detail: "Expected a data.attributes object.",
            source: { pointer: "/data/attributes" },
          },
        ]),
        422,
      );
    }
    const node = data.attributes as Node;
    const declared = byPluralOrSingular(data.type ?? "");
    if (!declared) {
      return unsupportedNodeTypeError();
    }
    if (node.osk?.node_type !== declared) {
      return jsonResponse(
        errorDocument([
          {
            status: "422",
            title: "node type mismatch",
            detail: "data.type does not match osk.node_type.",
          },
        ]),
        422,
      );
    }
    if (declared === "Verification") {
      return jsonResponse(
        errorDocument([
          {
            status: "422",
            title: "wrong endpoint",
            detail: "Post Verification nodes via POST /verifications.",
            source: { pointer: "/data/type" },
          },
        ]),
        422,
      );
    }
    const indexed = await ingest.ingestNode(node);
    const relationships = await extractRelationships(
      index,
      indexed.node,
      indexed.cid,
    );
    const resource = serializeResource(indexed, baseUrl, relationships);
    return jsonResponse(
      document(resource, { baseUrl, meta: { cid: indexed.cid } }),
      201,
    );
  }

  async function createVerification(
    request: Request,
    baseUrl: string,
  ): Promise<Response> {
    if (!hasJsonApiContentType(request)) {
      return unsupportedMediaType();
    }
    const parsed = await parseBody(request, bodyLimit);
    if (parsed.tooLarge) {
      return payloadTooLarge(bodyLimit);
    }
    const data =
      (parsed.body as { data?: { type?: string; attributes?: unknown } } | null)
        ?.data;
    if (!data?.attributes) {
      return jsonResponse(
        errorDocument([
          {
            status: "422",
            title: "invalid request",
            detail: "Expected a data.attributes object.",
            source: { pointer: "/data/attributes" },
          },
        ]),
        422,
      );
    }
    const node = data.attributes as Node;
    if (!isVerification(node)) {
      return jsonResponse(
        errorDocument([
          {
            status: "422",
            title: "node type mismatch",
            detail: "This endpoint only accepts Verification nodes.",
          },
        ]),
        422,
      );
    }
    const result = await ingest.ingestVerification(node);
    const indexed = await index.getNode(result.cid);
    const relationships = indexed
      ? await extractRelationships(index, indexed.node, indexed.cid)
      : {};
    const resource = indexed
      ? serializeResource(indexed, baseUrl, relationships)
      : null;
    return jsonResponse(
      document(resource, {
        baseUrl,
        meta: {
          cid: result.cid,
          solution_cid: node.payload.verification.target.solution_id["/"],
        },
      }),
      201,
    );
  }

  async function getNode(
    request: Request,
    cid: string,
    baseUrl: string,
  ): Promise<Response> {
    const indexed = await index.getNode(cid);
    if (!indexed) {
      return jsonResponse(
        errorDocument([{
          status: "404",
          title: "not found",
          detail: `No node with CID ${cid}.`,
        }]),
        404,
      );
    }
    const params = new URL(request.url).searchParams;
    const include = (params.get("include") ?? "").split(",").map((s) =>
      s.trim()
    ).filter(Boolean);
    const { resource, included } = await serializeWithIncludes(
      index,
      indexed,
      baseUrl,
      include,
    );
    return jsonResponse(document(resource, { baseUrl, included }));
  }

  async function getRelationship(
    cid: string,
    name: string,
    baseUrl: string,
  ): Promise<Response> {
    const indexed = await index.getNode(cid);
    if (!indexed) {
      return jsonResponse(
        errorDocument([{
          status: "404",
          title: "not found",
          detail: `No node with CID ${cid}.`,
        }]),
        404,
      );
    }
    const cids = linkedCidsOf(indexed.node, name);
    const nodes = (await Promise.all(cids.map((c) => index.getNode(c)))).filter(
      (n): n is NonNullable<typeof n> => n !== null,
    );
    const resources = nodes.map((n) => serializeResource(n, baseUrl));
    return jsonResponse(document(resources, { baseUrl }));
  }

  async function searchNodes(
    request: Request,
    baseUrl: string,
    collectionType?: string,
  ): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const filter: Record<string, unknown> = {};
    for (const [key, value] of params) {
      const m = key.match(/^filter\[(.+)\]$/);
      if (m) {
        if (m[1] === "node_type") {
          const t = byPluralOrSingular(value);
          if (t) {
            filter.node_type = t;
          }
        } else {
          filter[m[1]!] = value;
        }
      }
    }
    if (collectionType) {
      const t = byPluralOrSingular(collectionType);
      if (!t) {
        return jsonResponse(document([], { baseUrl, meta: { total: 0 } }));
      }
      filter.node_type = t;
    }
    const limit = Math.min(
      Math.max(Number(params.get("page[limit]")) || 25, 1),
      100,
    );
    const offset = Math.max(Number(params.get("page[offset]")) || 0, 0);
    const sort = (params.get("sort") ?? "-created_at").replace(/^-/, "");

    const result = await index.search({ filter, sort, limit, offset });
    const resources = [];
    for (const n of result.data) {
      const relationships = await extractRelationships(
        index,
        n.node,
        n.cid,
      );
      resources.push(serializeResource(n, baseUrl, relationships));
    }

    const pageLinks: Record<string, string> = {
      first: "",
      last: "",
      next: "",
      prev: "",
    };
    const lastOffset = Math.max(0, Math.ceil(result.total / limit) - 1) * limit;
    const setParams = (o: number) => {
      const p = new URL(request.url);
      p.searchParams.set("page[offset]", String(o));
      return p.toString();
    };
    pageLinks.first = setParams(0);
    pageLinks.last = setParams(lastOffset);
    pageLinks.next = offset + limit < result.total
      ? setParams(offset + limit)
      : "";
    pageLinks.prev = offset > 0 ? setParams(Math.max(0, offset - limit)) : "";

    return jsonResponse(
      document(resources, {
        baseUrl,
        links: {
          first: pageLinks.first,
          last: pageLinks.last,
          next: pageLinks.next || null,
          prev: pageLinks.prev || null,
        },
        meta: { total: result.total },
      }),
    );
  }

  async function byNodeId(
    segments: string[],
    baseUrl: string,
  ): Promise<Response> {
    const nodeId = segments[2]!;
    if (segments.length === 4 && segments[3] === "versions") {
      const versions = await index.getVersions(nodeId);
      if (versions.length === 0) {
        return jsonResponse(
          errorDocument([{
            status: "404",
            title: "not found",
            detail: `No node with node_id ${nodeId}.`,
          }]),
          404,
        );
      }
      const resources = versions.map((n) => serializeResource(n, baseUrl));
      return jsonResponse(
        document(resources, { baseUrl, meta: { node_id: nodeId } }),
      );
    }

    const heads = await index.getHeadVersion(nodeId);
    if (heads.length === 0) {
      return jsonResponse(
        errorDocument([{
          status: "404",
          title: "not found",
          detail: `No node with node_id ${nodeId}.`,
        }]),
        404,
      );
    }
    if (heads.length > 1) {
      return jsonResponse(
        errorDocument([
          {
            status: "409",
            title: "forked node",
            detail: `node_id ${nodeId} has multiple heads.`,
            source: { parameter: "node_id" },
          },
          ...heads.map((h) => ({
            status: "409",
            title: "fork head",
            detail: h.cid,
          })),
        ]),
        409,
      );
    }
    const head = heads[0]!;
    const versions = await index.getVersions(nodeId);
    const relationship = {
      related: `${baseUrl}/nodes/by-node-id/${nodeId}/versions`,
      data: versions.map((v) =>
        resourceIdentifier(pluralOf(v.node_type), v.cid)
      ),
    };
    const relationships = await extractRelationships(
      index,
      head.node,
      head.cid,
    );
    return jsonResponse(
      document(
        serializeResource(head, baseUrl, {
          ...relationships,
          versions: relationship,
        }),
        { baseUrl },
      ),
    );
  }

  async function getSchema(nodeType: string): Promise<Response> {
    const singular = byPluralOrSingular(nodeType);
    if (!singular) {
      return unsupportedNodeTypeError();
    }
    const schema = await loadSchema(singular);
    return jsonResponse(
      document({ type: "schemas", id: nodeType, attributes: schema }, {
        baseUrl: `/${nodeType}`,
      }),
    );
  }
}

export interface StartServerOptions {
  port?: number;
  hostname?: string;
  bodyLimit?: number;
  baseUrl?: string | null;
  corsOrigins?: string[];
}

export function startServer(
  ingest: IngestService,
  index: QueryIndex,
  options: StartServerOptions = {},
) {
  const handler = createApp(ingest, index, {
    bodyLimit: options.bodyLimit,
    baseUrl: options.baseUrl,
    corsOrigins: options.corsOrigins,
  });
  let resolveAddr: (info: { hostname: string; port: number }) => void =
    () => {};
  const listening = new Promise<{ hostname: string; port: number }>(
    (resolve) => {
      resolveAddr = resolve;
    },
  );
  const server = Deno.serve(
    {
      port: options.port ?? 8000,
      hostname: options.hostname ?? "0.0.0.0",
      onListen: (info) => resolveAddr(info),
    },
    handler,
  );
  return {
    listening,
    async shutdown(): Promise<void> {
      await server.shutdown();
    },
    get finished(): Promise<void> {
      return server.finished;
    },
  };
}
