import type { IngestService } from "../storage/ingest.ts";
import type { NodeStore } from "../storage/node_store.ts";
import type { Node } from "../core/types.ts";
import { join, normalize } from "node:path";
import {
  ReplayUnavailableError,
  SignatureError,
  ValidationError,
} from "../storage/ingest.ts";
import { InvalidNodeError } from "../storage/types.ts";
import type {
  IndexedNode,
  IndexedVerification,
  KeyReputation,
} from "../storage/types.ts";
import type { EnvSpec, PlaygroundRegistry } from "../execution/registry.ts";
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
  registry,
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
  JSONAPI,
  jsonResponse,
  methodNotAllowed,
  notAcceptable,
  notFoundResponse,
  parseBody,
  payloadTooLarge,
  unsupportedMediaType,
  unsupportedNodeTypeError,
} from "./http.ts";
import { buildOpenApiDocument, OPENAPI_MEDIA_TYPE } from "./openapi.ts";
import { agentQueryHandler } from "./agentquery.ts";
import {
  buildLlmsText,
  buildSelfDescription,
  QUERY_FILTERS,
} from "./selfdescription.ts";
import { matchRoute, pattern, type RouteEntry } from "./router.ts";

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
    meta: buildSelfDescription(baseUrl),
    links: {
      self: baseUrl,
      ...collectionLinks,
      schemas: `${baseUrl}/schemas/{node_type}`,
      openapi: `${baseUrl}/openapi.json`,
      submit: `${baseUrl}/nodes`,
    },
  });
}

export interface CreateAppOptions {
  bodyLimit?: number;
  baseUrl?: string | null;
  trustProxy?: boolean;
  corsOrigins?: string[];
  webDir?: string;
  logger?: (line: string) => void;
  registry?: PlaygroundRegistry | null;
  verificationRateLimit?: number;
}

const UI_INDEX = "index.html";

function parsePageLimit(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return 25;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

function parsePageOffset(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return null;
  }
  return n > 0 ? Math.floor(n) : 0;
}

function mimeFor(path: string): string {
  const ext = path.split(".").pop() ?? "";
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
      return "text/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "ico":
      return "image/x-icon";
    case "txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function originFor(request: Request, trustProxy: boolean): string {
  const url = new URL(request.url);
  if (!trustProxy) {
    return url.origin;
  }
  const proto = (request.headers.get("x-forwarded-proto") ?? url.protocol)
    .replace(/:$/, "");
  const host = (request.headers.get("x-forwarded-host") ?? url.host).split(
    ",",
  )[0]!
    .trim();
  return `${proto}://${host}`;
}

function serializeReceipt(
  receipt: IndexedVerification,
  baseUrl: string,
  provenance: { reputation: KeyReputation; env: EnvSpec | null },
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    target: {
      problem_id: { "/": receipt.problem_cid },
      solution_id: { "/": receipt.solution_cid },
    },
    environment_hash: receipt.environment_hash,
    public_key: receipt.public_key,
    timestamp: receipt.timestamp,
    valid_until: receipt.valid_until,
    test_suite: {
      total: receipt.total,
      passed: receipt.passed,
      failed: receipt.failed,
    },
    server_replayed: receipt.server_replayed,
    replayed_at: receipt.replayed_at,
    replayed_by: receipt.replayed_by,
  };
  if (receipt.measurements) {
    attributes.test_suite = {
      ...(attributes.test_suite as Record<string, unknown>),
      measurements: receipt.measurements,
    };
  }
  if (receipt.agent_context) {
    attributes.agent_context = receipt.agent_context;
  }
  if (provenance.env) {
    attributes.environment = {
      playground: provenance.env.playground,
      platform: provenance.env.platform,
      version: provenance.env.version,
      config_hash: provenance.env.config_hash,
    };
  }
  return {
    type: "verifications",
    id: receipt.receipt_cid,
    links: { self: `${baseUrl}/verifications/${receipt.receipt_cid}` },
    attributes,
    meta: {
      verifier: {
        key: receipt.public_key,
        trusted: provenance.reputation.trusted,
        weight: provenance.reputation.weight,
        first_seen: provenance.reputation.metrics.first_seen,
        authored_count: provenance.reputation.metrics.authored_count,
        cross_verified_count:
          provenance.reputation.metrics.cross_verified_count,
      },
    },
  };
}

export function createApp(
  ingest: IngestService,
  store: NodeStore,
  options: CreateAppOptions = {},
) {
  const bodyLimit = options.bodyLimit ?? DEFAULT_BODY_LIMIT;
  const logger = options.logger ?? ((line: string) => console.log(line));
  const baseUrlOption = options.baseUrl ?? null;
  const trustProxy = options.trustProxy ?? false;
  const corsOrigins = options.corsOrigins ?? [];
  const allowAllOrigins = corsOrigins.includes("*");
  const envRegistry = options.registry ?? null;
  const verificationRateLimit = options.verificationRateLimit ?? 60;
  const verificationHits = new Map<string, number[]>();
  const webDir =
    (options.webDir ?? new URL("../../web/", import.meta.url).pathname)
      .replace(/\/+$/, "");

  const routes: RouteEntry<string>[] = [
    {
      method: "GET",
      gate: "none",
      pattern: pattern("/openapi.json"),
      handler: async (_request, _groups, baseUrl) => {
        const doc = await buildOpenApiDocument(baseUrl);
        return new Response(JSON.stringify(doc, null, 2), {
          headers: { "Content-Type": `${OPENAPI_MEDIA_TYPE}; charset=utf-8` },
        });
      },
    },
    {
      method: "GET",
      gate: "none",
      pattern: pattern("/llms.txt"),
      handler: (_request, _groups, baseUrl) =>
        new Response(buildLlmsText(baseUrl), {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        }),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/"),
      handler: (_request, _groups, baseUrl) =>
        jsonResponse(entryPoint(baseUrl)),
    },
    {
      method: "POST",
      gate: "accept",
      pattern: pattern("/nodes"),
      handler: (request, _groups, baseUrl) => createNode(request, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/nodes"),
      handler: (request, _groups, baseUrl) => searchNodes(request, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/nodes/by-node-id/:id/versions"),
      handler: (_request, groups, baseUrl) =>
        byNodeId(groups.id!, true, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/nodes/by-node-id/:id"),
      handler: (_request, groups, baseUrl) =>
        byNodeId(groups.id!, false, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/nodes/:cid/verifications"),
      handler: (_request, groups, baseUrl) => getReceipts(groups.cid!, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/nodes/:cid/:rel"),
      handler: (_request, groups, baseUrl) =>
        getRelationship(groups.cid!, groups.rel!, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/nodes/:cid"),
      handler: (request, groups, baseUrl) =>
        getNode(request, groups.cid!, baseUrl),
    },
    {
      method: "POST",
      gate: "accept",
      pattern: pattern("/verifications"),
      handler: (request, _groups, baseUrl) =>
        createVerification(request, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/verifications"),
      handler: (request, _groups, baseUrl) =>
        getVerificationsCollection(request, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/verifications/:cid"),
      handler: (_request, groups, baseUrl) =>
        getVerification(groups.cid!, baseUrl),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/schemas/:type"),
      handler: (_request, groups, _baseUrl) => getSchema(groups.type!),
    },
    {
      method: "POST",
      gate: "none",
      pattern: pattern("/agent/query"),
      handler: (request, _groups, baseUrl) =>
        agentQueryHandler(request, baseUrl, store, bodyLimit),
    },
    {
      method: "GET",
      gate: "accept",
      pattern: pattern("/:collection"),
      matches: (groups) => ADVERTISED_COLLECTIONS.has(groups.collection!),
      handler: (request, groups, baseUrl) =>
        searchNodes(request, baseUrl, groups.collection),
    },
  ];

  function rateLimited(publicKey: string, now: number): boolean {
    const windowStart = now - 3_600_000;
    const hits = (verificationHits.get(publicKey) ?? []).filter(
      (t) => t >= windowStart,
    );
    if (hits.length >= verificationRateLimit) {
      verificationHits.set(publicKey, hits);
      return true;
    }
    hits.push(now);
    verificationHits.set(publicKey, hits);
    return false;
  }

  function serializeReceiptWith(
    receipt: IndexedVerification,
    baseUrl: string,
  ): Record<string, unknown> {
    return serializeReceipt(receipt, baseUrl, {
      reputation: store.keyReputation(receipt.public_key),
      env: envRegistry?.lookup(receipt.environment_hash) ?? null,
    });
  }

  async function provenanceFor(
    cid: string,
  ): Promise<Record<string, unknown> | null> {
    const node = await store.getNode(cid);
    if (!node || node.node_type !== "Recipe") {
      return null;
    }
    const receipts = await store.getReceiptsFor(cid);
    if (receipts.length === 0) {
      return { receipt_count: 0 };
    }
    const replayed = receipts.filter((r) => r.server_replayed);
    const keys = [...new Set(replayed.map((r) => r.public_key))];
    const reps = keys.map((k) => store.keyReputation(k));
    const now = Date.now();
    const ages = reps
      .map((r) =>
        r.metrics.first_seen
          ? Math.max(0, (now - Date.parse(r.metrics.first_seen)) / 86_400_000)
          : null
      )
      .filter((age): age is number => age !== null);
    const provenance: Record<string, unknown> = {
      receipt_count: receipts.length,
      replayed_count: replayed.length,
      distinct_keys: keys.length,
      has_trusted_verifier: reps.some((r) => r.trusted),
    };
    if (ages.length > 0) {
      provenance.min_key_age_days = Math.round(Math.min(...ages));
    }
    return provenance;
  }

  async function withProvenance(
    resource: Record<string, unknown>,
    indexed: IndexedNode,
  ): Promise<Record<string, unknown>> {
    if (indexed.node_type !== "Recipe") {
      return resource;
    }
    const provenance = await provenanceFor(indexed.cid);
    if (!provenance) {
      return resource;
    }
    return {
      ...resource,
      meta: { ...(resource.meta as Record<string, unknown>), provenance },
    };
  }

  function serveStatic(segments: string[]): Response | null {
    if (segments[0] !== "ui") {
      return null;
    }
    const parts = segments.slice(1);
    let relative: string;
    try {
      relative = decodeURIComponent(
        parts.length === 0 ? UI_INDEX : parts.join("/"),
      );
    } catch {
      return notFoundResponse();
    }
    const resolved = normalize(join(webDir, relative));
    if (!resolved.startsWith(`${webDir}/`)) {
      return notFoundResponse();
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(Deno.readFileSync(resolved));
    } catch {
      return notFoundResponse();
    }
    return new Response(body.buffer as ArrayBuffer, {
      headers: { "Content-Type": mimeFor(resolved) },
    });
  }

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
    const baseUrl = (baseUrlOption ?? originFor(request, trustProxy)).replace(
      /\/+$/,
      "",
    );
    const segments = url.pathname.split("/").filter(Boolean);

    try {
      const staticResponse = serveStatic(segments);
      if (staticResponse !== null) {
        return staticResponse;
      }

      const result = matchRoute(routes, "/" + segments.join("/"), method);
      switch (result.kind) {
        case "handler": {
          if (result.entry.gate === "accept" && !acceptsJsonApi(request)) {
            return notAcceptable();
          }
          return await result.entry.handler(request, result.groups, baseUrl);
        }
        case "notAllowed": {
          if (!acceptsJsonApi(request)) {
            return notAcceptable();
          }
          return methodNotAllowed(result.allow);
        }
        case "notFound":
          return notFoundResponse();
        default: {
          const unreachable: never = result;
          throw unreachable;
        }
      }
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
      store,
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
    const publicKey = node.osk.attribution.public_key;
    if (rateLimited(publicKey, Date.now())) {
      return jsonResponse(
        errorDocument([
          {
            status: "429",
            title: "rate limited",
            detail:
              `This key exceeds ${verificationRateLimit} verifications per hour.`,
          },
        ]),
        429,
        JSONAPI,
        { "retry-after": "3600" },
      );
    }
    const result = await ingest.ingestVerification(node);
    const receipt = store.getReceipt(result.cid);
    const resource = receipt ? serializeReceiptWith(receipt, baseUrl) : null;
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
    const indexed = await store.getNode(cid);
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
    const { resource: rawResource, included } = await serializeWithIncludes(
      store,
      indexed,
      baseUrl,
      include,
    );
    const resource = await withProvenance(rawResource, indexed);
    return jsonResponse(document(resource, { baseUrl, included }));
  }

  async function getRelationship(
    cid: string,
    name: string,
    baseUrl: string,
  ): Promise<Response> {
    const indexed = await store.getNode(cid);
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
    const reverse = registry[indexed.node.osk.node_type].reverseRelationships
      ?.find((r) => r.name === name);
    const cids = reverse
      ? store.linkedFrom(cid, reverse.forwardName)
      : linkedCidsOf(indexed.node, name);
    const nodes = (await Promise.all(cids.map((c) => store.getNode(c)))).filter(
      (n): n is NonNullable<typeof n> => n !== null,
    );
    const resources = nodes.map((n) => serializeResource(n, baseUrl));
    return jsonResponse(
      document(resources, {
        baseUrl,
        self: `${baseUrl}/nodes/${cid}/${name}`,
      }),
    );
  }

  async function getReceipts(
    cid: string,
    baseUrl: string,
  ): Promise<Response> {
    const indexed = await store.getNode(cid);
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
    const receipts = await store.getReceiptsFor(cid);
    const resources = receipts.map((r) => serializeReceiptWith(r, baseUrl));
    return jsonResponse(
      document(resources, {
        baseUrl,
        self: `${baseUrl}/nodes/${cid}/verifications`,
        meta: { total: receipts.length },
      }),
    );
  }

  async function getVerification(
    cid: string,
    baseUrl: string,
  ): Promise<Response> {
    const receipt = await store.getReceipt(cid);
    if (!receipt) {
      return jsonResponse(
        errorDocument([{
          status: "404",
          title: "not found",
          detail: `No receipt with CID ${cid}.`,
        }]),
        404,
      );
    }
    return jsonResponse(
      document(serializeReceiptWith(receipt, baseUrl), { baseUrl }),
    );
  }

  function getVerificationsCollection(
    request: Request,
    baseUrl: string,
  ): Response {
    const params = new URL(request.url).searchParams;
    const limit = parsePageLimit(params.get("page[limit]"));
    const offset = parsePageOffset(params.get("page[offset]"));
    if (limit === null || offset === null) {
      return jsonResponse(
        errorDocument([{
          status: "400",
          title: "invalid page parameter",
          detail: `page[limit] and page[offset] must be an integer.`,
          source: {
            parameter: limit === null ? "page[limit]" : "page[offset]",
          },
        }]),
        400,
      );
    }
    const ascending = !(params.get("sort") ?? "-timestamp").startsWith("-");
    const all = store.getAllReceipts();
    const sorted = [...all].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
    if (!ascending) {
      sorted.reverse();
    }
    const lastOffset = Math.max(0, Math.ceil(all.length / limit) - 1) * limit;
    const page = sorted.slice(offset, offset + limit);
    const resources = page.map((r) => serializeReceiptWith(r, baseUrl));

    const requestUrl = new URL(request.url);
    const selfUrl = new URL(requestUrl.pathname, baseUrl);
    selfUrl.search = requestUrl.search;
    const pageLinks: Record<string, string> = {
      first: "",
      last: "",
      next: "",
      prev: "",
    };
    const setParams = (o: number) => {
      const p = new URL(requestUrl.pathname, baseUrl);
      p.search = requestUrl.search;
      p.searchParams.set("page[offset]", String(o));
      return p.toString();
    };
    pageLinks.first = setParams(0);
    pageLinks.last = setParams(lastOffset);
    pageLinks.next = offset + limit < all.length
      ? setParams(offset + limit)
      : "";
    pageLinks.prev = offset > 0 ? setParams(Math.max(0, offset - limit)) : "";

    return jsonResponse(
      document(resources, {
        baseUrl,
        self: selfUrl.toString(),
        links: {
          first: pageLinks.first,
          last: pageLinks.last,
          next: pageLinks.next || null,
          prev: pageLinks.prev || null,
        },
        meta: { total: all.length },
      }),
    );
  }

  async function searchNodes(
    request: Request,
    baseUrl: string,
    collectionType?: string,
  ): Promise<Response> {
    const params = new URL(request.url).searchParams;
    const filter: Record<string, unknown> = {};
    const filterKeys = new Set<string>(QUERY_FILTERS);
    const invalid: Array<{ key: string; note: string }> = [];
    for (const [key, value] of params) {
      const m = key.match(/^filter\[(.+)\]$/);
      if (m) {
        const name = m[1]!;
        if (!filterKeys.has(name)) {
          invalid.push({ key: name, note: name });
          continue;
        }
        if (name === "node_type") {
          const t = byPluralOrSingular(value);
          if (!t) {
            invalid.push({ key: name, note: `${name}=${value}` });
            continue;
          }
          filter.node_type = t;
        } else {
          filter[name] = value;
        }
      }
    }
    if (invalid.length > 0) {
      return jsonResponse(
        errorDocument([{
          status: "400",
          title: "invalid filter",
          detail: `Unknown or invalid filter${invalid.length > 1 ? "s" : ""}: ${
            invalid.map((i) => i.note).join(", ")
          }.`,
          source: { parameter: `filter[${invalid[0]!.key}]` },
        }]),
        400,
      );
    }
    if (collectionType) {
      const t = byPluralOrSingular(collectionType);
      if (!t) {
        return jsonResponse(
          document([], {
            baseUrl,
            self: `${baseUrl}/${collectionType}`,
            meta: { total: 0 },
          }),
        );
      }
      filter.node_type = t;
    }
    const limit = parsePageLimit(params.get("page[limit]"));
    const offset = parsePageOffset(params.get("page[offset]"));
    if (limit === null || offset === null) {
      return jsonResponse(
        errorDocument([{
          status: "400",
          title: "invalid page parameter",
          detail: `page[limit] and page[offset] must be an integer.`,
          source: {
            parameter: limit === null ? "page[limit]" : "page[offset]",
          },
        }]),
        400,
      );
    }
    const sort = params.get("sort") ?? "-created_at";
    const include = (params.get("include") ?? "").split(",").map((s) =>
      s.trim()
    ).filter(Boolean);
    const search = (params.get("search") ?? "").trim();

    const searchOptions = { filter, search, sort, limit, offset };
    const result = await store.search(searchOptions);
    const lastOffset = Math.max(0, Math.ceil(result.total / limit) - 1) * limit;
    const resources = [];
    for (const n of result.data) {
      const relationships = await extractRelationships(
        store,
        n.node,
        n.cid,
      );
      resources.push(
        await withProvenance(serializeResource(n, baseUrl, relationships), n),
      );
    }

    const included: Record<string, unknown>[] = [];
    if (include.length > 0) {
      const valid = new Set<string>();
      if (collectionType) {
        const t = byPluralOrSingular(collectionType);
        if (t) {
          for (const name of registry[t].relationshipNames) {
            valid.add(name);
          }
        }
      }
      for (const n of result.data) {
        for (const name of registry[n.node_type].relationshipNames) {
          valid.add(name);
        }
      }
      const unsupported = include.filter((path) => !valid.has(path));
      if (unsupported.length > 0) {
        return jsonResponse(
          errorDocument([
            {
              status: "400",
              title: "unsupported include",
              detail: `Unsupported include path${
                unsupported.length > 1 ? "s" : ""
              }: ${unsupported.join(", ")}.`,
              source: { parameter: "include" },
            },
          ]),
          400,
        );
      }
      const seen = new Set<string>();
      for (const n of result.data) {
        for (const path of include) {
          for (const cid of linkedCidsOf(n.node, path)) {
            if (seen.has(cid)) {
              continue;
            }
            seen.add(cid);
            const target = await store.getNode(cid);
            if (target) {
              included.push(serializeResource(target, baseUrl));
            }
          }
        }
      }
    }

    const requestUrl = new URL(request.url);
    const selfUrl = new URL(requestUrl.pathname, baseUrl);
    selfUrl.search = requestUrl.search;
    const pageLinks: Record<string, string> = {
      first: "",
      last: "",
      next: "",
      prev: "",
    };
    const setParams = (o: number) => {
      const p = new URL(requestUrl.pathname, baseUrl);
      p.search = requestUrl.search;
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
        self: selfUrl.toString(),
        links: {
          first: pageLinks.first,
          last: pageLinks.last,
          next: pageLinks.next || null,
          prev: pageLinks.prev || null,
        },
        included,
        meta: { total: result.total },
      }),
    );
  }

  async function byNodeId(
    nodeId: string,
    versions: boolean,
    baseUrl: string,
  ): Promise<Response> {
    if (versions) {
      const versionNodes = await store.getVersions(nodeId);
      if (versionNodes.length === 0) {
        return jsonResponse(
          errorDocument([{
            status: "404",
            title: "not found",
            detail: `No node with node_id ${nodeId}.`,
          }]),
          404,
        );
      }
      const resources = versionNodes.map((n) => serializeResource(n, baseUrl));
      return jsonResponse(
        document(resources, {
          baseUrl,
          self: `${baseUrl}/nodes/by-node-id/${nodeId}/versions`,
          meta: { node_id: nodeId },
        }),
      );
    }

    const heads = await store.getHeadVersion(nodeId);
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
    const versionNodes = await store.getVersions(nodeId);
    const relationship = {
      related: `${baseUrl}/nodes/by-node-id/${nodeId}/versions`,
      data: versionNodes.map((v) =>
        resourceIdentifier(pluralOf(v.node_type), v.cid)
      ),
    };
    const relationships = await extractRelationships(
      store,
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
  trustProxy?: boolean;
  corsOrigins?: string[];
  registry?: PlaygroundRegistry | null;
  verificationRateLimit?: number;
}

export function startServer(
  ingest: IngestService,
  store: NodeStore,
  options: StartServerOptions = {},
) {
  const handler = createApp(ingest, store, {
    bodyLimit: options.bodyLimit,
    baseUrl: options.baseUrl,
    trustProxy: options.trustProxy,
    corsOrigins: options.corsOrigins,
    registry: options.registry,
    verificationRateLimit: options.verificationRateLimit,
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
