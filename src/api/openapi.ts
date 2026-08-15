import { registry } from "../nodetypes/registry.ts";
import { loadSchema } from "../schema/index.ts";

export const OPENAPI_MEDIA_TYPE = "application/vnd.oai.openapi+json";

const API_VERSION = "0.3.0";

const defsUrl = new URL("../schema/defs.json", import.meta.url);

type Json = Record<string, unknown>;

const EFFECTIVE_STATUS = ["draft", "active", "stale", "disputed", "deprecated"];
const SEVERITY = ["critical", "high", "medium", "low"];
const SORT_FIELDS = ["created_at", "last_verified", "confidence_score"];

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
  const filter = (name: string, schema: Json): Json => ({
    name,
    in: "query",
    required: false,
    description: `Filter by ${name.slice(8, -1)}.`,
    schema,
  });
  return [
    filter("filter[node_type]", {
      type: "string",
      enum: ["problems", "recipes", "guides", "verifications"],
    }),
    filter("filter[effective_status]", { enum: EFFECTIVE_STATUS }),
    filter("filter[severity]", { enum: SEVERITY }),
    filter("filter[title]", {
      type: "string",
      description: "Case-insensitive substring match on the node title.",
    }),
    filter("filter[public_key]", {
      $ref: "#/components/schemas/ed25519PublicKey",
    }),
    filter("filter[node_id]", { $ref: "#/components/schemas/uuidv7" }),
    filter("filter[framework_name]", { type: "string" }),
    {
      name: "sort",
      in: "query",
      required: false,
      description:
        "Sort field. Prefix with a minus sign for descending order. Sorted descending in all cases.",
      schema: { enum: SORT_FIELDS },
    },
    {
      name: "page[limit]",
      in: "query",
      required: false,
      description: "Maximum number of resources to return. Defaults to 25.",
      schema: { type: "integer", minimum: 1, maximum: 100 },
    },
    {
      name: "page[offset]",
      in: "query",
      required: false,
      description: "Number of resources to skip. Defaults to 0.",
      schema: { type: "integer", minimum: 0 },
    },
  ];
}

function searchOperation(): Json {
  return {
    tags: ["search"],
    summary: "Search the signed node index.",
    parameters: queryParameters(),
    responses: {
      "200": DOCUMENTED_RESPONSES["200"],
      "406": ERROR_RESPONSES["406"],
    },
  };
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
          description: "Relationship name: solutions, prerequisites, target.",
          schema: { enum: ["solutions", "prerequisites", "target"] },
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
          "503": ERROR_RESPONSES["503"],
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

  for (const collection of ["problems", "recipes", "guides", "verifications"]) {
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
