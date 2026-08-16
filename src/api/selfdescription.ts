import { registry } from "../nodetypes/registry.ts";

export const OSK_VERSION = "0.3.0";

export const QUERY_FILTERS = [
  "node_type",
  "effective_status",
  "severity",
  "title",
  "public_key",
  "node_id",
  "framework_name",
] as const;

export const QUERY_SORTABLE = [
  "created_at",
  "last_verified",
  "confidence_score",
] as const;

export const QUERY_PAGE_LIMIT_MAX = 100;

const NAME = "OSK Corpus";

const DESCRIPTION =
  "Signed, content-addressed library of software engineering problems, " +
  "fixes, and verification receipts. Nodes are immutable, Ed25519-signed, " +
  "and versioned via supersedes_cid.";

const QUERY_EXAMPLE =
  "GET /problems?filter[severity]=critical&filter[framework_name]=deno" +
  "&sort=-confidence_score";

const HOW_TO_WRITE =
  "POST /nodes with data.attributes = {osk, payload}. The signature is " +
  "Ed25519 over the canonical DAG-JSON bytes of {osk, payload} with " +
  "attribution.signature omitted. attribution.public_key must match the " +
  "signing key. Validate against /schemas/{node_type} before submitting. " +
  "Submit verification receipts via POST /verifications.";

const TRUST_MODEL =
  "effective_status is a computed verdict. confidence_score 0.0 means no " +
  "replayed receipts or the latest receipt failed; it never sets " +
  "effective_status. disputed means a failed receipt or an authorship " +
  "conflict. disputed and deprecated nodes stay queryable. confidence_score " +
  "is per-solution: it reflects the receipts on one recipe, not its linked " +
  "problem. Problems are never verified directly, so a problem score stays " +
  "0. The score counts replayed receipts only: receipts the server did not " +
  "replay (stub mode) never move the score. A receipt counts as one source " +
  "per distinct key, weighted by verifier reputation. Operator-trusted keys " +
  "weight 1.0. Other keys earn weight from key age, authored nodes, and " +
  "cross-verified solutions, so fresh keys contribute almost nothing. The " +
  "score caps untrusted sources at two unless a trusted key verified the " +
  "recipe. This raises the cost of a Sybil attack: new keys cannot pump a " +
  "score. Each receipt exposes its replay status, environment, and verifier " +
  "reputation, so you can recompute trust client-side from the signed, " +
  "content-addressed receipts and apply your own policy.";

export function buildSelfDescription(baseUrl: string): Record<string, unknown> {
  const nodeTypes: Record<string, unknown> = {};
  for (const module of Object.values(registry)) {
    nodeTypes[module.nodeType] = {
      summary: module.description,
      plural: module.plural,
      schema: `/schemas/${module.nodeType}`,
    };
  }
  return {
    name: NAME,
    version: OSK_VERSION,
    description: DESCRIPTION,
    node_types: nodeTypes,
    query: {
      example: QUERY_EXAMPLE,
      filters: QUERY_FILTERS,
      sortable: QUERY_SORTABLE,
      page: { limit_max: QUERY_PAGE_LIMIT_MAX },
    },
    how_to_write: HOW_TO_WRITE,
    trust_model: TRUST_MODEL,
    docs: {
      openapi: `${baseUrl}/openapi.json`,
      llms: `${baseUrl}/llms.txt`,
    },
  };
}

export function buildLlmsText(baseUrl: string): string {
  const types = Object.values(registry)
    .map((m) => `- ${m.nodeType}: ${m.description}`)
    .join("\n");
  const filters = QUERY_FILTERS.join(", ");
  const sortable = QUERY_SORTABLE.join(", ");
  return [
    `# ${NAME}`,
    "",
    DESCRIPTION,
    "",
    `Version: ${OSK_VERSION}`,
    "",
    "## Node types",
    "",
    types,
    "",
    "## Querying",
    "",
    "Search any collection or the whole index with GET /nodes.",
    "",
    `1. \`GET /problems?filter[severity]=critical\` — critical problems.`,
    "2. `GET /recipes?filter[framework_name]=deno&sort=-confidence_score`",
    "   — most-confident deno recipes.",
    "3. `GET /nodes/{cid}?include=solutions` — a node with its solutions",
    "   inlined.",
    "",
    `Follow \`relationships.<name>.links.related\` for linked resources.`,
    `Filters: ${filters}.`,
    `Sort: ${sortable} (prefix \`-\` for descending).`,
    `Pagination: \`page[limit]\` (max ${QUERY_PAGE_LIMIT_MAX}), \`page[offset]\`.`,
    "",
    "## Writing nodes",
    "",
    "POST /nodes with Content-Type application/vnd.api+json and body",
    "`{data: {type, attributes}}`. The signature is Ed25519 over the",
    "canonical DAG-JSON bytes of {osk, payload} with attribution.signature",
    "omitted. attribution.public_key must match the signing key. Validate",
    "against /schemas/{node_type} before submitting. Submit verification",
    "receipts via POST /verifications.",
    "",
    "## Trust model",
    "",
    TRUST_MODEL,
    "",
    "## Machine-readable",
    "",
    `- OpenAPI: ${baseUrl}/openapi.json`,
    `- This file: ${baseUrl}/llms.txt`,
    "",
  ].join("\n");
}
