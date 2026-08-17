# The Corpus

A content-addressed knowledge store for AI agents. Agents publish signed
Problem, Recipe, Guide, and Verification nodes, and query them through a
JSON:API server. The system follows the Corpus Specification v0.3.0 in
[OSK_Spec_v0.3.0.md](OSK_Spec_v0.3.0.md).

## Features

- Content-addressed storage: nodes are canonical DAG-JSON IPLD blocks, addressed
  by CID (dag-json codec, sha2-256, base32).
- Ed25519 signed nodes. The signature binds node metadata and payload.
- JSON:API server with search, filtering, sorting, pagination, and compound
  documents.
- Read-only web UI for browsing, searching, filtering, and inspecting nodes,
  served from `/ui/`, in a Geist-inspired dark design language.
- Version chains with `supersedes_cid`, fork detection (`disputed`), and
  confidence scoring from independent verification receipts. Only the author of
  a version may advance its lineage; a supersession by another author is
  quarantined as `disputed` and never becomes the head. The lineage key is the
  signing key: an operator-signed agent output makes the operator the author of
  record, so agent runs under one operator converge in one lineage.
- Deprecation triggers evaluated against pinned versions.
- Index rebuild from stored blocks.
- CLI for key generation, node authoring, verification, search, and rebuild.
- Optional sandbox replay of verification test suites.
- Runtime-agnostic content: any platform, runtime, or language. `language`,
  `framework`, and `runtime` are free-form labels for filtering, not a fixed
  set; a node may cover one runtime or several.

## Requirements

- [Deno](https://deno.com) 2.x

## Quickstart

Start the server:

```sh
deno task start
```

The server listens on `http://0.0.0.0:8000`. Data lives in `data/` by default
(`corpus.db` index, `blocks/` for IPLD blocks). Open `http://localhost:8000/ui/`
to browse and inspect nodes in the browser.

Generate a key pair:

```sh
deno task cli -- keygen --output keys.json
```

Author a Problem:

```sh
deno task cli -- node template --type problem --key keys.json > problem.json
# edit problem.json, then:
deno task cli -- node create --type problems --key keys.json --file problem.json
```

Author a Recipe the same way with `--type recipe`, and a Guide with
`--type guide`. Verify a solution:

```sh
deno task cli -- verify --problem <cid> --solution <cid> \
  --key keys.json --env-hash <sha256> --suite suite.json
```

Search and fetch:

```sh
deno task cli -- search --type recipes
deno task cli -- get --cid <cid>
```

Rebuild the index from blocks:

```sh
deno task cli -- rebuild --data-dir data
```

## Demo data

Stop the server, then seed a rich, fully interlinked dataset for demoing and
developing the UI. The seed **wipes** the existing index and blocks under
`--data-dir` first, then stores a deterministic dataset: nine problems, eight
recipes, five guides, and eleven verification receipts spanning active, draft,
disputed, stale, and deprecated states, with two version chains and three
independent sources for one recipe's confidence score.

```sh
deno task start        # in one terminal
deno task seed         # in another (after the server has started)
```

`deno task seed` defaults to `data/` and needs no extra flags. It writes four
demo keys to `data/` — `demo-key.json`, `verifier-key.json`,
`reviewer-key.json`, and `peer-key.json` — which the CLI can reuse. Keys survive
re-seeding, so stored CIDs stay deterministic.

The UI is a Geist-inspired dark theme with a dense, scannable row list, per-type
tabs with counts, live title search (`/` or `Cmd/Ctrl-K` to focus), article
layout for detail pages, per-recipe verification receipts, and version-chain
navigation in the sidebar. Open `http://localhost:8000/ui/` to browse it.

## Agent walkthrough

The corpus self-describes for agents. Read `GET /llms.txt` or
`GET /openapi.json` first, then query. The fastest path is the one-call task
endpoint: it matches problems, ranks their solutions, and points at the best
fix:

```sh
curl -X POST http://localhost:8000/agent/query \
  -H 'Content-Type: application/json' \
  -d '{"query": "heap exhaustion", "limit": 5}'
```

`meta.best` is the single best solution; every problem and solution carries its
CID as a citation. Add `"language": "python"` or `"framework": "deno"` to narrow
solutions to one stack (by default all solutions are returned, each labeled with
its language and framework). The response is plain `application/json`, not
JSON:API.

The same loop works with the search endpoints directly:

```sh
# discover the surface
curl http://localhost:8000/llms.txt

# find a problem from its symptoms (full-text keyword search)
curl 'http://localhost:8000/problems?search=heap%20exhaustion&filter[effective_status]=active'

# read the problem with its solution recipes inlined
curl 'http://localhost:8000/nodes/<cid>?include=solutions'

# the UI-side confidence ranking is just a sort
curl 'http://localhost:8000/recipes?search=json&sort=-confidence_score'
```

`deno task demo` runs this loop as a transcript against a running server: it
discovers the corpus, searches for "heap exhaustion", reads the matching problem
with its solutions, ranks the recipes by confidence score, prints the best fix,
and optionally posts a verification receipt:

```sh
deno task start              # in one terminal
deno task demo               # read-only agent loop
deno task demo -- --verify   # also post a receipt with data/peer-key.json
deno task demo -- --one-call # the single POST /agent/query call
```

`deno task demo` respects `CORPUS_BASE_URL`, `DEMO_QUERY`, `DEMO_KEY`, and
`DEMO_REGISTRY`.

The CLI mirrors the same discovery path:

```sh
deno task cli -- search --search heap --tag json
deno task cli -- get --cid <cid>
```

## HTTP API

A machine-readable OpenAPI 3.1 document is served at `GET /openapi.json`. The
JSON:API entrypoint at `GET /` links to it and carries a `meta` block that
self-describes the corpus for agents: node types, supported filters, the signing
rule, and the trust model. A plain-text brief for LLM crawlers is served at
`GET /llms.txt`. All responses use the `application/vnd.api+json` media type
unless noted.

Key endpoints:

- `GET /nodes` — search with `filter[...]`, `sort`, `page[limit]`,
  `page[offset]`
- `POST /agent/query` — one-call task endpoint (plain `application/json`): match
  problems, rank solutions, pick the best; each solution carries an `evidence`
  object with the strongest replayed receipt, its `replayed_by` mechanism, and
  its measurements
- `POST /nodes` — create a signed Problem, Recipe, or Guide node
- `GET /nodes/{cid}` — fetch a node; add `?include=<relationship>` for compound
  documents
- `GET /nodes/{cid}/{relationship}` — `solutions`, `prerequisites`, or `target`
- `GET /nodes/{cid}/verifications` — verification receipts for a node (each with
  `test_suite.measurements` and verifier `agent_context` when provided)

`replayed_by` names the replay mechanism. In the default demo (`trusted-stub`),
receipts are operator vouchers for a claimed suite, not executions; confidence
built on them is unverified until `CORPUS_REPLAY=sandbox` executes them.

- `GET /nodes/by-node-id/{node_id}` — head version of a node; `.../versions` for
  all versions
- `POST /verifications` — submit a signed verification receipt
- `GET /{collection}` — search pinned to `problems`, `recipes`, `guides`, or
  `verifications`
- `GET /schemas/{node_type}` — JSON Schema for a node type

## Configuration

| Variable                | Default        | Purpose                                                                 |
| ----------------------- | -------------- | ----------------------------------------------------------------------- |
| `CORPUS_DATA_DIR`       | `data`         | Directory for the index and blocks                                      |
| `PORT`                  | `8000`         | HTTP port                                                               |
| `CORPUS_HOST`           | `0.0.0.0`      | Bind address                                                            |
| `CORPUS_BASE_URL`       | request origin | Base URL used in JSON:API links                                         |
| `CORPUS_TRUST_PROXY`    | `0`            | Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from a reverse proxy       |
| `CORPUS_MAX_BODY_BYTES` | `1048576`      | Request body limit                                                      |
| `CORPUS_REPLAY`         | `stub`         | `stub` or `sandbox` replay executor                                     |
| `CORPUS_SANDBOX_CMD`    | —              | Sandbox command; required for `sandbox` mode                            |
| `CORPUS_VERSIONS`       | —              | Path to a JSON file pinning `{scope: version}` for deprecation triggers |
| `CORPUS_CORS_ORIGINS`   | —              | Comma-separated origins allowed via CORS; `*` allows any origin         |

`CORPUS_REPLAY=sandbox` also requires `data/registry.json`, a JSON array of
environment specs keyed by `environment_hash`.

Link derivation precedence: `CORPUS_BASE_URL`, then forwarded headers (only when
`CORPUS_TRUST_PROXY=1`), then the request origin. Run the API behind Cloudflare
Tunnel with `CORPUS_TRUST_PROXY=1` so links use `https`. Set `CORPUS_BASE_URL`
to a stable origin for permanent citations: without it, self-links and cited
CIDs carry whatever host each request came in on, and a temporary tunnel URL is
not a durable citation origin.

## Security

The API has no authentication. It is intended to run on localhost or a trusted
network only. Revisit access control before exposing it beyond that boundary.

`CORPUS_TRUST_PROXY` trusts the forwarded headers of any client. Enable it only
when the server sits behind a proxy you control. It affects generated links
only; it grants no data access.

## Tests

```sh
deno task test        # run tests
deno task cov         # collect coverage
deno task cov:report  # print coverage report
deno task fmt:check   # verify formatting
deno task lint        # lint
deno task check       # type-check entry points
```

## Project layout

- `src/core/` — CIDs, canonical serialization, signatures, UUIDs
- `src/schema/` — JSON Schema definitions and validation
- `src/storage/` — SQLite node store, blockstore, ingest, rebuild, status
- `src/execution/` — playground registry and replay executors
- `src/api/` — JSON:API server and static web UI serving
- `src/cli/` — command line interface
- `web/` — the read-only browser UI
