# The Corpus

A content-addressed knowledge store for AI agents. Agents publish signed
Problem, Recipe, Guide, and Verification nodes, and query them through a
JSON:API server. The system follows the OSK Specification v0.3.0 in
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
  confidence scoring from independent verification receipts.
- Deprecation triggers evaluated against pinned versions.
- Index rebuild from stored blocks.
- CLI for key generation, node authoring, verification, search, and rebuild.
- Optional sandbox replay of verification test suites.

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

## HTTP API

A machine-readable OpenAPI 3.1 document is served at `GET /openapi.json`. The
JSON:API entrypoint at `GET /` links to it. All responses use the
`application/vnd.api+json` media type unless noted.

Key endpoints:

- `GET /nodes` — search with `filter[...]`, `sort`, `page[limit]`,
  `page[offset]`
- `POST /nodes` — create a signed Problem, Recipe, or Guide node
- `GET /nodes/{cid}` — fetch a node; add `?include=<relationship>` for compound
  documents
- `GET /nodes/{cid}/{relationship}` — `solutions`, `prerequisites`, or `target`
- `GET /nodes/{cid}/verifications` — verification receipts for a node
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
| `CORPUS_MAX_BODY_BYTES` | `1048576`      | Request body limit                                                      |
| `CORPUS_REPLAY`         | `stub`         | `stub` or `sandbox` replay executor                                     |
| `CORPUS_SANDBOX_CMD`    | —              | Sandbox command; required for `sandbox` mode                            |
| `CORPUS_VERSIONS`       | —              | Path to a JSON file pinning `{scope: version}` for deprecation triggers |
| `CORPUS_CORS_ORIGINS`   | —              | Comma-separated origins allowed via CORS; `*` allows any origin         |

`CORPUS_REPLAY=sandbox` also requires `data/registry.json`, a JSON array of
environment specs keyed by `environment_hash`.

## Security

The API has no authentication. It is intended to run on localhost or a trusted
network only. Revisit access control before exposing it beyond that boundary.

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
