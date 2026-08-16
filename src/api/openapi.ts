import { registry } from "../nodetypes/registry.ts";
import { loadSchema } from "../schema/index.ts";
import {
  QUERY_FILTERS,
  QUERY_PAGE_LIMIT_MAX,
  QUERY_SORTABLE,
} from "./selfdescription.ts";

export const OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json";

const API_VERSION = "0.3.0";

const defsUrl = new URL("../schema/defs.json", import.meta.url);

type Json = Record<string, unknown>;

const EFFECTIVE_STATUS = ["draft", "active", "stale", "disputed", "deprecated"];
const SEVERITY = ["critical", "high", "medium", "low"];

const FILTER_SCHEMAS: Record<string, Json> = {
  node_type: {
    type: "string",
    enum: ["problems", "recipes", "guides", "verifications"],
  },
  effective_status: { enum: EFFECTIVE_STATUS },
  severity: { enum: SEVERITY },
  title: {
    type: "string",
    description: "Case-insensitive substring match on the node title.",
  },
  tag: {
    type: "string",
    description:
      "Matches nodes that carry the tag in their payload (title, summary, symptoms, steps, and guide sections are also searchable via the search parameter).",
  },
  public_key: { $ref: "#/components/schemas/ed25519PublicKey" },
  node_id: { $ref: "#/components/schemas/uuidv7" },
  framework_name: {
    type: "string",
    description:
      "Primary technology name (case-insensitive). Problems use environment.framework.name; recipes and guides use their code.framework.",
  },
  language: {
    type: "string",
    description:
      "Tree-sitter language identifier from recipe or guide code (case-insensitive).",
  },
  runtime_name: {
    type: "string",
    description:
      "Runtime type from problem.environment.runtime (case-insensitive).",
  },
};

function rewriteRefs(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^(?:corpus:defs)?#\/\$defs\/(.+)$/);
    if (m) {
      return `#/components/schemas/${m[1]}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }
  if (value !== null && typeof value === "object") {
    const out: Json = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$id" || key === "$schema") {
        continue;
      }
      out[key] = rewriteRefs(child);
    }
    return out;
  }
  return value;
}

async function defsComponents(): Promise<Json> {
  const defs = JSON.parse(await Deno.readTextFile(defsUrl)) as {
    $defs?: Record<string, unknown>;
  };
  const out: Json = {};
  for (const [name, schema] of Object.entries(defs.$defs ?? {})) {
    out[name] = rewriteRefs(schema);
  }
  return out;
}

async function nodeSchemaComponents(): Promise<Json> {
  const out: Json = {};
  for (const module of Object.values(registry)) {
    out[module.nodeType] = rewriteRefs(await loadSchema(module.nodeType));
  }
  return out;
}

const ENVELOPE_SCHEMAS: Json = {
  JsonApiVersion: {
    type: "object",
    required: ["version"],
    properties: { version: { type: "string" } },
  },
  Measurement: {
    type: "object",
    required: ["name", "value"],
    properties: {
      name: { type: "string" },
      value: { type: "number" },
      unit: { type: "string" },
      description: { type: "string" },
    },
  },
  AgentContext: {
    type: "object",
    required: [
      "model",
      "context_window_size",
      "context_window_used",
      "tool_count",
      "reasoning_chain_length",
    ],
    properties: {
      model: { type: "string" },
      context_window_size: { type: "integer" },
      context_window_used: { type: "integer" },
      tool_count: { type: "integer" },
      reasoning_chain_length: { type: "integer" },
    },
  },
  Evidence: {
    type: "object",
    required: [
      "receipt_cid",
      "verifier_key",
      "verified_at",
      "environment_hash",
      "total",
      "passed",
      "failed",
    ],
    properties: {
      receipt_cid: { type: "string" },
      verifier_key: { $ref: "#/components/schemas/ed25519PublicKey" },
      verified_at: { $ref: "#/components/schemas/iso8601" },
      environment_hash: { type: "string" },
      total: { type: "integer" },
      passed: { type: "integer" },
      failed: { type: "integer" },
      replayed_by: {
        type: ["string", "null"],
        description:
          "The replay mechanism that produced the receipt. trusted-stub is an operator voucher for a claimed suite, not an execution; sandbox receipts are executed in an isolated environment.",
      },
      measurements: {
        type: ["array", "null"],
        items: { $ref: "#/components/schemas/Measurement" },
      },
    },
  },
  ResourceIdentifier: {
    type: "object",
    required: ["type", "id"],
    properties: {
      type: { type: "string" },
      id: { type: "string" },
      meta: { type: "object" },
    },
  },
  Relationship: {
    type: "object",
    required: ["links"],
    properties: {
      links: {
        type: "object",
        required: ["related"],
        properties: { related: { type: "string", format: "uri-reference" } },
      },
      data: {
        type: "array",
        items: { $ref: "#/components/schemas/ResourceIdentifier" },
      },
    },
  },
  NodeMeta: {
    type: "object",
    required: [
      "cid",
      "effective_status",
      "confidence_score",
      "created_at",
      "head",
      "version",
    ],
    properties: {
      cid: { type: "string" },
      effective_status: { enum: EFFECTIVE_STATUS },
      confidence_score: { type: "number", minimum: 0, maximum: 1 },
      created_at: { type: "string", format: "date-time" },
      head: { type: "integer" },
      version: { type: "integer" },
    },
  },
  Resource: {
    type: "object",
    required: ["type", "id", "links", "attributes", "meta"],
    properties: {
      type: { type: "string" },
      id: { type: "string" },
      links: {
        type: "object",
        required: ["self"],
        properties: { self: { type: "string", format: "uri-reference" } },
      },
      attributes: {
        type: "object",
        description: "The signed node: its OSK header and payload.",
        properties: {
          osk: { $ref: "#/components/schemas/osk" },
          payload: { type: "object" },
        },
      },
      relationships: {
        type: "object",
        additionalProperties: { $ref: "#/components/schemas/Relationship" },
      },
      meta: { $ref: "#/components/schemas/NodeMeta" },
    },
  },
  ReceiptResource: {
    type: "object",
    required: ["type", "id", "links", "attributes"],
    properties: {
      type: { const: "verifications" },
      id: { type: "string" },
      links: {
        type: "object",
        required: ["self"],
        properties: { self: { type: "string", format: "uri-reference" } },
      },
      attributes: {
        type: "object",
        properties: {
          target: {
            type: "object",
            properties: {
              problem_id: { $ref: "#/components/schemas/ipldLink" },
              solution_id: { $ref: "#/components/schemas/ipldLink" },
            },
          },
          environment_hash: { type: "string" },
          public_key: { $ref: "#/components/schemas/ed25519PublicKey" },
          timestamp: { $ref: "#/components/schemas/iso8601" },
          valid_until: { $ref: "#/components/schemas/iso8601" },
          test_suite: {
            type: "object",
            properties: {
              total: { type: "integer" },
              passed: { type: "integer" },
              failed: { type: "integer" },
              measurements: {
                type: "array",
                items: { $ref: "#/components/schemas/Measurement" },
              },
            },
          },
          agent_context: { $ref: "#/components/schemas/AgentContext" },
          environment: {
            type: "object",
            properties: {
              playground: { type: "string" },
              platform: { type: "string" },
              version: { type: "string" },
              config_hash: { type: "string" },
            },
          },
          server_replayed: { type: "boolean" },
          replayed_at: { $ref: "#/components/schemas/iso8601" },
          replayed_by: { type: "string" },
        },
      },
      meta: {
        type: "object",
        properties: {
          verifier: {
            type: "object",
            properties: {
              key: { $ref: "#/components/schemas/ed25519PublicKey" },
              trusted: { type: "boolean" },
              weight: { type: "number" },
              first_seen: { $ref: "#/components/schemas/iso8601" },
              authored_count: { type: "integer" },
              cross_verified_count: { type: "integer" },
            },
          },
        },
      },
    },
  },
  SchemaResource: {
    type: "object",
    required: ["type", "id", "attributes"],
    properties: {
      type: { const: "schemas" },
      id: { type: "string" },
      attributes: { type: "object" },
    },
  },
  Document: {
    type: "object",
    required: ["jsonapi", "links"],
    properties: {
      jsonapi: { $ref: "#/components/schemas/JsonApiVersion" },
      links: { type: "object" },
      data: {
        oneOf: [
          { $ref: "#/components/schemas/Resource" },
          { type: "array", items: { $ref: "#/components/schemas/Resource" } },
          { $ref: "#/components/schemas/ReceiptResource" },
          {
            type: "array",
            items: { $ref: "#/components/schemas/ReceiptResource" },
          },
          { $ref: "#/components/schemas/SchemaResource" },
          { type: "null" },
        ],
      },
      meta: { type: "object" },
      included: {
        type: "array",
        items: { $ref: "#/components/schemas/Resource" },
      },
    },
  },
  Error: {
    type: "object",
    required: ["status", "title"],
    properties: {
      status: { type: "string" },
      title: { type: "string" },
      detail: { type: "string" },
      source: {
        type: "object",
        properties: {
          pointer: { type: "string" },
          parameter: { type: "string" },
        },
      },
    },
  },
  ErrorDocument: {
    type: "object",
    required: ["jsonapi", "errors"],
    properties: {
      jsonapi: { $ref: "#/components/schemas/JsonApiVersion" },
      errors: { type: "array", items: { $ref: "#/components/schemas/Error" } },
    },
  },
  NodeSubmission: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["type", "attributes"],
        properties: {
          type: { enum: ["problems", "recipes", "guides"] },
          attributes: {
            oneOf: [
              { $ref: "#/components/schemas/Problem" },
              { $ref: "#/components/schemas/Recipe" },
              { $ref: "#/components/schemas/Guide" },
            ],
          },
        },
      },
    },
  },
  VerificationSubmission: {
    type: "object",
    required: ["data"],
    properties: {
      data: {
        type: "object",
        required: ["type", "attributes"],
        properties: {
          type: { const: "verifications" },
          attributes: { $ref: "#/components/schemas/Verification" },
        },
      },
    },
  },
  AgentQueryRequest: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description:
          "Full-text description of the problem, as in the search= parameter.",
      },
      language: {
        type: "string",
        description:
          "Optional. Restricts solutions to recipes written in this language (case-insensitive).",
      },
      framework: {
        type: "string",
        description:
          "Optional. Narrows matching problems and restricts solutions to this framework (case-insensitive).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 20,
        default: 5,
        description:
          "Maximum number of matching problems to return. Defaults to 5.",
      },
    },
  },
  AgentQuerySolution: {
    type: "object",
    required: ["cid", "title", "language", "framework", "confidence", "links"],
    properties: {
      cid: { type: "string" },
      node_id: { type: "string" },
      title: { type: "string" },
      summary: { type: "string" },
      language: { type: "string" },
      framework: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      status: { enum: EFFECTIVE_STATUS },
      last_verified: { type: "string", format: "date-time" },
      applies_to: { type: ["string", "null"] },
      evidence: {
        type: ["object", "null"],
        $ref: "#/components/schemas/Evidence",
      },
      explanation: { type: "string" },
      steps: { type: "array" },
      code: { type: "object" },
      caveats: { type: "array" },
      links: {
        type: "object",
        required: ["self", "receipts"],
        properties: {
          self: { type: "string", format: "uri-reference" },
          receipts: { type: "string", format: "uri-reference" },
        },
      },
    },
  },
  AgentQueryDocument: {
    type: "object",
    required: ["jsonapi", "meta"],
    properties: {
      jsonapi: { $ref: "#/components/schemas/JsonApiVersion" },
      meta: {
        type: "object",
        required: ["query", "matched_problems", "total_solutions_considered"],
        properties: {
          query: { type: "string" },
          language: { type: "string" },
          framework: { type: "string" },
          matched_problems: { type: "integer" },
          total_solutions_considered: { type: "integer" },
          best: {
            type: ["object", "null"],
            required: ["problem_cid", "solution_cid"],
            properties: {
              problem_cid: { type: "string" },
              solution_cid: { type: "string" },
            },
          },
        },
      },
      data: {
        type: "array",
        items: {
          type: "object",
          required: ["problem", "solutions"],
          properties: {
            problem: { type: "object" },
            solutions: {
              type: "array",
              items: { $ref: "#/components/schemas/AgentQuerySolution" },
            },
          },
        },
      },
    },
  },
};

const ERROR_RESPONSES: Json = {
  "400": {
    description: "Malformed JSON in the request body.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "404": {
    description: "No resource exists at this path.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "405": {
    description: "The method is not allowed on this path.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "406": {
    description: "The Accept header does not allow a JSON:API response.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "429": {
    description: "The key exceeded the hourly verification rate limit.",
    headers: {
      "retry-after": {
        description: "Seconds until the window resets.",
        schema: { type: "string" },
      },
    },
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "409": {
    description: "The node_id has multiple heads (forked).",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "413": {
    description: "The request body exceeds the server limit.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "415": {
    description: "The Content-Type header is not application/vnd.api+json.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "422": {
    description: "The request body failed validation or is not allowed.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "500": {
    description: "An unexpected server error occurred.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
  "503": {
    description: "Verification execution is unavailable.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/ErrorDocument" },
      },
    },
  },
};

const DOCUMENTED_RESPONSES: Json = {
  "200": {
    description: "The JSON:API document.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/Document" },
      },
    },
  },
  "201": {
    description: "The created resource.",
    content: {
      "application/vnd.api+json": {
        schema: { $ref: "#/components/schemas/Document" },
      },
    },
  },
};

function queryParameters(): Json[] {
  const params: Json[] = QUERY_FILTERS.map((name) => ({
    name: `filter[${name}]`,
    in: "query",
    required: false,
    description: `Filter by ${name}.`,
    schema: FILTER_SCHEMAS[name]!,
  }));
  params.push(
    {
      name: "search",
      in: "query",
      required: false,
      description:
        "Full-text keyword search across the title, summary, tags, symptoms, root cause, recipe steps, and guide sections.",
      schema: { type: "string" },
    },
    {
      name: "sort",
      in: "query",
      required: false,
      description:
        "Sort field. Prefix with a minus sign for descending order. Sorted descending in all cases.",
      schema: { enum: QUERY_SORTABLE },
    },
    {
      name: "page[limit]",
      in: "query",
      required: false,
      description:
        "Maximum number of resources to return. Defaults to 25; clamps to 1-100.",
      schema: { type: "integer", minimum: 1, maximum: QUERY_PAGE_LIMIT_MAX },
    },
    {
      name: "page[offset]",
      in: "query",
      required: false,
      description:
        "Number of resources to skip. Defaults to 0; offsets past the last page clamp to it.",
      schema: { type: "integer", minimum: 0 },
    },
    {
      name: "include",
      in: "query",
      required: false,
      description:
        "Comma-separated relationship names to inline: solutions, prerequisites, target.",
      schema: { type: "string" },
    },
  );
  return params;
}

function searchOperation(): Json {
  return {
    tags: ["search"],
    summary: "Search the signed node index.",
    parameters: queryParameters(),
    responses: {
      "200": DOCUMENTED_RESPONSES["200"],
      "400": {
        description: "A page[limit] or page[offset] value is not an integer.",
        content: {
          "application/vnd.api+json": {
            schema: { $ref: "#/components/schemas/ErrorDocument" },
          },
        },
      },
      "406": ERROR_RESPONSES["406"],
    },
  };
}

function receiptParameters(): Json[] {
  return [
    {
      name: "sort",
      in: "query",
      required: false,
      description:
        "Sort by receipt timestamp. Prefix with a minus sign for descending.",
      schema: { enum: ["timestamp", "-timestamp"] },
    },
    {
      name: "page[limit]",
      in: "query",
      required: false,
      description:
        "Maximum number of receipts to return. Defaults to 25; clamps to 1-100.",
      schema: { type: "integer", minimum: 1, maximum: QUERY_PAGE_LIMIT_MAX },
    },
    {
      name: "page[offset]",
      in: "query",
      required: false,
      description:
        "Number of receipts to skip. Defaults to 0; offsets past the last page clamp to it.",
      schema: { type: "integer", minimum: 0 },
    },
  ];
}

function buildPaths(): Json {
  const cidParam: Json = {
    name: "cid",
    in: "path",
    required: true,
    description: "The CID of the node.",
    schema: { type: "string" },
  };
  const nodeIdParam: Json = {
    name: "node_id",
    in: "path",
    required: true,
    description: "The stable node identifier.",
    schema: { $ref: "#/components/schemas/uuidv7" },
  };
  const nodeTypeParam: Json = {
    name: "node_type",
    in: "path",
    required: true,
    description: "The node type, singular or plural.",
    schema: { enum: ["problems", "recipes", "guides", "verifications"] },
  };

  const paths: Json = {
    "/": {
      get: {
        tags: ["entrypoint"],
        summary: "Discover the API links.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    },
    "/agent/query": {
      post: {
        tags: ["agent"],
        summary:
          "Answer a question in one call: match problems and rank their solutions.",
        description:
          "Plain JSON task endpoint. Searches active problems by keyword, " +
          "loads their linked solution recipes, ranks them by confidence " +
          "and status, and points at the single best solution. Returns " +
          "problem and solution CIDs as citations so the agent can open, " +
          "verify, or reuse the nodes.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AgentQueryRequest" },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Matched problems with ranked solutions and the best pick.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AgentQueryDocument" },
              },
            },
          },
          "400": {
            description: "Malformed JSON in the request body.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorDocument" },
              },
            },
          },
          "413": {
            description: "The request body exceeds the byte limit.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorDocument" },
              },
            },
          },
          "415": {
            description: "The Content-Type header is not application/json.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorDocument" },
              },
            },
          },
          "422": {
            description: "The request body failed validation.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorDocument" },
              },
            },
          },
        },
      },
    },
    "/nodes": {
      get: searchOperation(),
      post: {
        tags: ["nodes"],
        summary: "Create a signed Problem, Recipe, or Guide node.",
        requestBody: {
          required: true,
          content: {
            "application/vnd.api+json": {
              schema: { $ref: "#/components/schemas/NodeSubmission" },
            },
          },
        },
        responses: {
          "201": DOCUMENTED_RESPONSES["201"],
          "406": ERROR_RESPONSES["406"],
          "413": ERROR_RESPONSES["413"],
          "415": ERROR_RESPONSES["415"],
          "422": ERROR_RESPONSES["422"],
        },
      },
    },
    "/nodes/{cid}": {
      parameters: [cidParam],
      get: {
        tags: ["nodes"],
        summary: "Get a single node by CID.",
        parameters: [
          {
            name: "include",
            in: "query",
            required: false,
            description:
              "Comma-separated relationship names to inline: solutions, prerequisites, target.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "404": ERROR_RESPONSES["404"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    },
    "/nodes/{cid}/verifications": {
      parameters: [cidParam],
      get: {
        tags: ["nodes"],
        summary: "List the verification receipts for a node.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "404": ERROR_RESPONSES["404"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    },
    "/nodes/{cid}/{relationship}": {
      parameters: [
        cidParam,
        {
          name: "relationship",
          in: "path",
          required: true,
          description:
            "Relationship name: solutions, prerequisites, target, problems.",
          schema: {
            enum: ["solutions", "prerequisites", "target", "problems"],
          },
        },
      ],
      get: {
        tags: ["nodes"],
        summary: "List the resources linked by a relationship.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "404": ERROR_RESPONSES["404"],
          "405": ERROR_RESPONSES["405"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    },
    "/nodes/by-node-id/{node_id}": {
      parameters: [nodeIdParam],
      get: {
        tags: ["nodes"],
        summary: "Get the head version of a node by its node_id.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "404": ERROR_RESPONSES["404"],
          "405": ERROR_RESPONSES["405"],
          "406": ERROR_RESPONSES["406"],
          "409": ERROR_RESPONSES["409"],
        },
      },
    },
    "/nodes/by-node-id/{node_id}/versions": {
      parameters: [nodeIdParam],
      get: {
        tags: ["nodes"],
        summary: "List every version of a node by its node_id.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "404": ERROR_RESPONSES["404"],
          "405": ERROR_RESPONSES["405"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    },
    "/verifications": {
      get: {
        tags: ["verifications"],
        summary: "List the verification receipts, newest first.",
        parameters: receiptParameters(),
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "400": {
            description:
              "A page[limit] or page[offset] value is not an integer.",
            content: {
              "application/vnd.api+json": {
                schema: { $ref: "#/components/schemas/ErrorDocument" },
              },
            },
          },
          "406": ERROR_RESPONSES["406"],
        },
      },
      post: {
        tags: ["verifications"],
        summary: "Submit a signed Verification receipt.",
        requestBody: {
          required: true,
          content: {
            "application/vnd.api+json": {
              schema: { $ref: "#/components/schemas/VerificationSubmission" },
            },
          },
        },
        responses: {
          "201": DOCUMENTED_RESPONSES["201"],
          "406": ERROR_RESPONSES["406"],
          "413": ERROR_RESPONSES["413"],
          "415": ERROR_RESPONSES["415"],
          "422": ERROR_RESPONSES["422"],
          "429": ERROR_RESPONSES["429"],
          "503": ERROR_RESPONSES["503"],
        },
      },
    },
    "/verifications/{cid}": {
      parameters: [cidParam],
      get: {
        tags: ["verifications"],
        summary: "Get a single verification receipt by its receipt CID.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "404": ERROR_RESPONSES["404"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    },
    "/schemas/{node_type}": {
      parameters: [nodeTypeParam],
      get: {
        tags: ["schemas"],
        summary: "Get the JSON Schema for a node type.",
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "406": ERROR_RESPONSES["406"],
          "422": ERROR_RESPONSES["422"],
        },
      },
    },
  };

  for (const collection of ["problems", "recipes", "guides"]) {
    paths[`/${collection}`] = {
      get: {
        tags: ["search"],
        summary: `Search nodes restricted to the ${collection} collection.`,
        parameters: queryParameters(),
        responses: {
          "200": DOCUMENTED_RESPONSES["200"],
          "406": ERROR_RESPONSES["406"],
        },
      },
    };
  }

  return paths;
}

function buildInfo(): Json {
  return {
    title: "The Corpus API",
    summary:
      "An append-only signed-knowledge store. Agents publish problem, recipe, and guide nodes, and verify recipes with receipts.",
    version: API_VERSION,
  };
}

function buildStaticPart(): Promise<Json> {
  return (async () => {
    return {
      openapi: "3.1.0",
      info: buildInfo(),
      servers: [{ url: "" }],
      paths: buildPaths(),
      components: {
        schemas: {
          ...(await defsComponents()),
          ...(await nodeSchemaComponents()),
          ...ENVELOPE_SCHEMAS,
        },
      },
    };
  })();
}

let cachedDoc: Promise<Json> | null = null;

export async function buildOpenApiDocument(baseUrl: string): Promise<Json> {
  cachedDoc ??= buildStaticPart();
  const doc = await cachedDoc;
  return { ...doc, servers: [{ url: baseUrl }] };
}
