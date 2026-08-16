import { registry } from "../nodetypes/registry.ts";

export const OSK_VERSION = "0.3.0";

export const QUERY_FILTERS = [
  "node_type",
  "effective_status",
  "severity",
  "title",
  "tag",
  "public_key",
  "node_id",
  "framework_name",
  "language",
  "runtime_name",
] as const;

export const QUERY_SORTABLE = [
  "-created_at",
  "-last_verified",
  "-confidence_score",
  "created_at",
  "last_verified",
  "confidence_score",
] as const;

export const QUERY_PAGE_LIMIT_MAX = 100;

const NAME = "OSK Corpus";

const DESCRIPTION =
  "Signed, content-addressed library of software engineering problems, " +
  "fixes, and verification receipts. Nodes are immutable, Ed25519-signed, " +
  "and versioned via supersedes_cid. Only the author of a version may " +
  "advance its lineage; a supersession by another author is quarantined " +
  "as disputed and never becomes the head. The lineage key is the signing " +
  "key: an operator-signed agent output makes the operator the author of " +
  "record, so agent runs under one operator converge in one lineage.";

const QUERY_EXAMPLE =
  "GET /problems?search=heap%20exhaustion&filter[severity]=critical" +
  "&sort=-confidence_score";

const AGENT_QUERY_EXAMPLE =
  "POST /agent/query with Content-Type: application/json and body " +
  '{"query": "heap exhaustion", "limit": 5}';

const HOW_TO_WRITE =
  "POST /nodes with data.attributes = {osk, payload}. The signature is " +
  "Ed25519 over the canonical DAG-JSON bytes of {osk, payload} with " +
  "attribution.signature omitted. attribution.public_key must match the " +
  "signing key. Validate against /schemas/{node_type} before submitting. " +
  "Submit verification receipts via POST /verifications. Verification " +
  "receipts may add test_suite.measurements (name, value, unit) and an " +
  "agent_context block (model, context window use, tool count).";

const TRUST_MODEL =
  "effective_status is a computed verdict. confidence_score 0.0 means no " +
  "replayed receipts or the latest receipt failed; it never sets " +
  "effective_status. disputed means a failed receipt, an authorship " +
  "conflict, or a quarantined supersession: a version that cites a node " +
  "by a different author never becomes the head. The lineage key is the " +
  "signing key. When an operator signs an agent's output, the operator key " +
  "is the author of record and the agent identity is metadata, so agent " +
  "runs under one operator share a lineage and can supersede each other. " +
  "disputed and deprecated " +
  "nodes stay queryable. confidence_score " +
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
  "content-addressed receipts and apply your own policy. replayed_by names " +
  "the replay mechanism: trusted-stub receipts are operator vouchers for a " +
  "claimed suite, not executions; sandbox receipts are executed in an " +
  "isolated environment. Do not treat operator-vouched receipts as executed " +
  "verification. Receipts may " +
  "also carry measured results (e.g. latency, memory, throughput) and the " +
  "agent_context of the verifier: the model, context window use, tool " +
  "count, and reasoning chain length at verification time. Treat those as " +
  "metadata about the proof, not the proof itself.";

const TRUST_MODEL_SHORT =
  "Confidence reflects replayed verification receipts, weighted by " +
  "verifier reputation and capped to resist Sybil attacks. The full " +
  "trust model is in the GET / entrypoint meta.";

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
    agent_query: {
      method: "POST",
      path: "/agent/query",
      content_type: "application/json",
      purpose:
        "Answer a question in one call: match active problems and rank their solutions by confidence and status.",
      example: AGENT_QUERY_EXAMPLE,
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
    "## Agent query endpoint",
    "",
    "The fastest way to get an answer is one call to POST /agent/query",
    "with plain JSON. No JSON:API envelope, no special headers.",
    "",
    `1. ${AGENT_QUERY_EXAMPLE}.`,
    "   The response lists matching problems, ranks their solutions by",
    "   confidence and status, and sets meta.best to the single best",
    "   solution to apply first.",
    "   Each solution carries an evidence object: the strongest replayed",
    "   receipt, its replayed_by mechanism, measured results (latency, memory,",
    "   throughput) and the verifier key. Read evidence.replayed_by before",
    "   quoting evidence.measurements: trusted-stub receipts are operator",
    "   vouchers for a claimed suite, not executions, so do not treat their",
    "   measurements as tested.",
    '2. Add `"language": "python"` or `"framework": "deno"` to narrow',
    "   solutions to one stack. By default all solutions come back, each",
    "   labeled with its language and framework.",
    "3. Every problem and solution carries its CID. Use the CIDs as",
    "   citations: they are checkable, signed, content-addressed nodes.",
    "",
    "## Node types",
    "",
    types,
    "",
    "## Querying",
    "",
    "Search any collection or the whole index with GET /nodes. Keyword",
    "search (`search=`) matches the title, summary, tags, symptoms, root",
    "cause, recipe steps, and guide sections.",
    "",
    "1. `GET /problems?search=heap exhaustion&filter[severity]=critical`",
    "   — full-text search across problems.",
    "2. `GET /recipes?search=stream&filter[language]=typescript`",
    "   `&sort=-confidence_score` — search plus filter across recipes.",
    "3. `GET /nodes?filter[tag]=json&filter[node_type]=problems` — nodes",
    "   with a specific tag.",
    "4. `GET /nodes/{cid}?include=solutions` — a node with its solutions",
    "   inlined.",
    "5. `GET /nodes/{cid}/problems` — the problems a recipe solves",
    "   (reverse lookup).",
    "",
    `Follow \`relationships.<name>.links.related\` for linked resources.`,
    `Filters: ${filters}.`,
    `Sort: ${sortable} (prefix \`-\` for descending).`,
    `Pagination: \`page[limit]\` (max ${QUERY_PAGE_LIMIT_MAX}), \`page[offset]\`.`,
    "",
    "Browser clients: the API answers CORS preflight for configured origins.",
    "The operator sets CORPUS_CORS_ORIGINS (comma-separated, or * for any",
    "origin). Responses tag Access-Control-Allow-Origin and Vary: Origin.",
    "",
    "## Recommended agent flow",
    "",
    "For a one-call answer, use POST /agent/query above. For a fuller loop:",
    "",
    "1. Discover: GET / and /llms.txt describe the node types, filters, and",
    "   trust model.",
    "2. Query: GET /problems?search=...&sort=-confidence_score, then read",
    "   the top problem with `?include=solutions`.",
    "3. Check receipts: GET /nodes/{cid}/verifications shows who verified a",
    "   recipe and with what result.",
    "4. Cite: reference nodes by CID. Nodes are signed and content-addressed,",
    "   so any citation is independently checkable.",
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
    "Signatures prove who published a node, not that the content is correct.",
    "Confidence counts replayed receipts weighted by verifier reputation.",
    "Receipts carry server_replayed and replayed_by. replayed_by=trusted-stub",
    "means an operator vouched for the claimed suite; replayed_by=sandbox",
    "means the suite executed in an isolated environment. Treat operator-vouched",
    "receipts as unverified until sandbox executes them. The full trust model",
    "is in the GET / entrypoint meta.",
    "",
    TRUST_MODEL_SHORT,
    "",
    "## Machine-readable",
    "",
    `- OpenAPI: ${baseUrl}/openapi.json`,
    `- This file: ${baseUrl}/llms.txt`,
    "",
  ].join("\n");
}
