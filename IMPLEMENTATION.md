# The Corpus — Implementation Tracker

Stack: Deno + TypeScript. MVP = Problem / Recipe / Verification triangle.

## Phase 1 — Scaffolding

- [x] `deno.json`: tasks (`test`, `start`, `cli`), dependency map
- [x] Directory layout (`src/core`, `src/schema`, `src/storage`, `src/verify`,
      `src/api`, `src/cli`, `tests`)
- [x] `deno test` harness runs on `tests/`
- [x] Pin dependency versions and lockfile

## Phase 2 — Core primitives (pure, tested)

- [x] `uuidv7.ts`: timestamp (48 bit) + version nibble + random
- [x] `serialize.ts`: canonical DAG-JSON encode via `@ipld/dag-json`
- [x] `sign.ts`: Ed25519 via built-in `node:crypto` (no noble/postgres deps)
- [x] `cid.ts`: CIDv1 (dag-json codec, sha2-256, base32)
- [x] Common `osk` JSON Schema
- [x] `problem` JSON Schema (severity enum, >=1 symptom, agent_context optional)
- [x] `recipe` JSON Schema (language id, code body, caveats)
- [x] `verification` JSON Schema (hex64 env hash, >=1 test case)
- [x] Cross-field checks (total = passed + failed = cases.length = fail count)
- [x] Tests: serialization stability, CID determinism, signature round-trip

## Phase 3 — Storage

> SQLite (`node:sqlite`) behind the `QueryIndex` interface; Postgres can swap in
> later.

- [x] File blockstore: `data/blocks/<cid>.json`
- [x] SQLite schema: `nodes`, `verifications`, `deprecation_triggers` (see Phase
      9: `blocks` removed)
- [x] Ingestion pipeline: validate -> verify sig -> store -> index
- [x] Idempotent re-POST (same CID returned)
- [x] Test: block round-trip

## Phase 4 — API server

> Reads use `JSON.parse` on stored dag-json. `ipldLink` validation enforces a
> parseable CID pattern.

- [x] JSON:API error and document serializers
- [x] `GET /` entry point with all links
- [x] `POST /nodes` -> 201 + `meta.cid`, or 422 with pointers
- [x] `GET /nodes/{cid}` with relationships; `?include=` compound documents
- [x] `GET /nodes` filter + sort + pagination links (limit clamped to [1,100])
- [x] `POST /verifications`
- [x] `GET /schemas/{node_type}`
- [x] `GET /nodes/by-node-id/{id}` + `/versions`, 409 on fork
- [x] Method gating: 405 + `Allow` header

## Phase 5 — Status + confidence engine

- [x] `confidence_score` per 6.2 (`1 - 0.5^n`), independence by (key, env hash)
- [x] Reject verification authored by Recipe author (422)
- [x] `effective_status` overlay (draft/active/stale/disputed/deprecated)
- [x] Latest failure -> `disputed` + score 0.0; `valid_until` expiry -> `stale`
      (lazy refresh on read)
- [x] Fork detection -> all heads `disputed`
- [x] Playground registry (optional; enforced when `registry.json` present)
- [x] Tests: confidence math, status transitions

## Phase 6 — CLI

> HTTP client to the API. `deno task cli -- <args>`.

- [x] `keygen`, `node template` (problem only), `node create`, `verify`, `get`,
      `search`
- [x] End-to-end smoke test passed

---

## Phase 7 — HTTP correctness (JSON:API compliance)

> Audit: Accept/Content-Type never checked; no body limit; HEAD and path
> variants unhandled.

- [x] Content-Type enforcement (server.ts)
  - [x] `POST /nodes` and `POST /verifications`: require
        `Content-Type: application/vnd.api+json`
  - [x] Missing or mismatched -> `415 Unsupported Media Type`, JSON:API error
- [x] Accept negotiation (server.ts)
  - [x] `Accept` missing -> serve JSONAPI (current default)
  - [x] `Accept` not matching `application/vnd.api+json` / `application/json` /
        `*/*` -> `406 Not Acceptable`
- [x] Request body size limit (server.ts)
  - [x] Constant `MAX_BODY_BYTES` (default 1 MB), env-overridable via
        `CORPUS_MAX_BODY_BYTES`
  - [x] Stream-read body with cap; exceed -> `413 Payload Too Large`; reject
        before validation
  - [x] `parseBody` replaced by capped reader
- [x] `HEAD` support for GET routes (entry point, nodes, collections, schemas):
      same headers, no body
- [x] Strict path validation (server.ts `byNodeId`)
  - [x] Accept only `/nodes/by-node-id/{id}` (len 3) and
        `/nodes/by-node-id/{id}/versions` (len 4)
  - [x] Any other segment count -> `404`
- [x] Tests: 406, 415, 413 (limit injectable via `createApp` option for fast
      tests), HEAD, path variants

## Phase 8 — Verification: wire replay into ingest

> Audit: `ReplayExecutor` defined but never called. Spec 5.4.5 requires replay +
> result comparison.

- [x] `ReplayExecutor` interface gains `readonly enforced: boolean` (replay.ts)
  - [x] `StubReplayExecutor.enforced = false` (keeps tests fast; current
        behavior)
  - [x] `SandboxReplayExecutor.enforced = true` (shells out to
        `CORPUS_SANDBOX_CMD`)
- [x] `ReplayResult` gains `total` and
      `cases: Array<{ name: string; result: string }>` (replay.ts)
- [x] `IngestService` constructor accepts `replay: ReplayExecutor` (ingest.ts)
  - [x] In `ingestVerification`, after registry lookup + prechecks:
        `replay.enforced` -> call `replay.replay(solution, problem, env)`
  - [x] Compare outcome + totals + per-case results against the claimed suite
  - [x] Mismatch -> `ValidationError` (422), pointer
        `/payload/verification/execution/test_suite`
  - [x] Executor throws (sandbox down) -> `503 Service Unavailable`
- [x] `main.ts` wiring
  - [x] Env `CORPUS_REPLAY=stub|sandbox` (default `stub`)
  - [x] Real executor requires `registry.json` at startup; fail fast with clear
        message otherwise
  - [x] Injectable for tests (fake enforced executor)
- [x] Tests (verify_test.ts): enforced executor matching -> accepted; mismatched
      counts -> 422; per-case mismatch -> 422; executor error -> 503 mapping
- [x] Real sandbox infra stays post-MVP; this phase delivers the trust gate

## Phase 9 — Durability + storage hygiene

> Audit: orphan blocks on index failure; dead `blocks` table; unused
> `get`/`has`; lazy dynamic import.

- [x] Add `FileBlockstore.delete(cid)` (blockstore.ts)
  - [x] In `ingestNode` / `ingestVerification`: if index step throws, delete the
        just-written block in `catch`
  - [x] Test: forced index failure leaves no block (unit test on `delete`)
- [x] Remove dead `blocks` table from `db.ts` schema
- [x] Remove unused `get`/`has` from `Blockstore` interface + `FileBlockstore`
      (reads go through the index)
- [x] Replace lazy `await import("../core/cid.ts")` with a top-level import in
      `blockstore.ts`

## Phase 10 — Server operations

> Audit: no graceful shutdown; self-links use request origin; bind host fixed;
> no observability.

- [x] Graceful shutdown (main.ts)
  - [x] `Deno.addSignalListener` for `SIGINT` / `SIGTERM` -> `server.shutdown()`
        then `index.close()` then exit 0
  - [x] `startServer` returns the `Deno.serve` server handle (options object:
        `{ port, hostname }`)
  - [x] `SqliteQueryIndex.close()` is idempotent (double-close safe)
- [x] Configurable base URL (server.ts, main.ts)
  - [x] Env `CORPUS_BASE_URL` used for `self`/`related`/entry-point links
  - [x] Fall back to request origin when unset
- [x] Bind host (main.ts)
  - [x] Env `CORPUS_HOST` (default `0.0.0.0`)
  - [x] Log line shows the real bound address; when host is wildcard, note the
        external base URL
- [x] Minimal observability (server.ts)
  - [x] Request logger: `method path status durationMs requestId`, no bodies
  - [x] `X-Request-Id` (random UUID) on every response, included in error logs
- [x] Tests: logger + X-Request-Id assertion; `CORPUS_BASE_URL` override;
      graceful-shutdown smoke test (spawn `src/main.ts`, send SIGTERM, assert
      exit 0)

## Phase 11 — Test hardening

> Audit: no integration test booting the real server; API negative paths
> under-tested.

- [x] Integration test (tests/integration_test.ts)
  - [x] Spawn `src/main.ts` via `Deno.Command` with `CORPUS_DATA_DIR` +
        ephemeral port
  - [x] GET / -> POST problem -> POST recipe -> GET by cid -> cleanup on exit
- [x] API negative tests (api_test.ts): 404 unknown route, 500-mapped input,
      `?include=unknown` -> empty `included`, bad `sort` falls back to
      `created_at`, unknown filter field ignored, pagination boundaries (offset
      at/over total)
- [x] Coverage gate: add `deno task cov` (`deno test --coverage`) and report
      line coverage per file
- [x] All suites must run under `deno task test` with no network access

## Phase 12 — CLI polish

- [x] `node template --type recipe` (templates.ts): mirror of the recipe schema,
      public key + uuidv7
- [x] `--help` / `-h` per subcommand; usage errors exit 2, operational errors
      exit 1
- [x] API error output includes `source.pointer` when present

## Phase 13 — Improvement audit

> Full review of the MVP for spec conformance and robustness. Fixes below are
> all green under `deno task test` (108 tests).

- [x] Endpoint correctness
  - [x] `POST /nodes` rejects Verification nodes (422, pointer `/data/type`);
        verifications go through `POST /verifications`
  - [x] `supersedes_cid` validated in `indexNode`: target must exist and share
        the `node_id`; cycles become impossible (spec 4.2). New
        `InvalidNodeError` maps to 422 (also covers self-verification and
        unknown-target receipts)
- [x] Deprecation triggers (spec 6.3, partial)
  - [x] `src/storage/triggers.ts`: `CORPUS_VERSIONS` JSON pins
        `{scope:
        version}`; conditions evaluated per `versioning_scheme`
        (semver/calver/year/custom) with ops `>= > < <= =`
  - [x] `#refreshEffectiveStatus` now evaluates triggers for recipes without
        receipts (stale overlay)
  - [x] Background release-feed watcher remains post-MVP
- [x] Index rebuild (spec 4.2)
  - [x] `FileBlockstore.list()` traverses block files
  - [x] `src/storage/rebuild.ts`: signature-verified, depth-ordered re-indexing;
        receipts replayed into confidence; orphans (missing supersede target)
        rejected
  - [x] CLI `corpus rebuild [--data-dir DIR]`
- [x] Robustness
  - [x] `SandboxReplayExecutor`: empty-command validation, configurable timeout
        with child kill (default 30 s)
  - [x] UNIQUE-constraint races in `indexNode`/`addVerification` -> idempotent
        success instead of 500
  - [x] `PORT` validated (1-65535, exit 1); corrupt `registry.json` fails loud
  - [x] CLI fetch errors report cleanly; `startServer` exposes the real bound
        address
- [x] Hygiene
  - [x] `deno fmt` applied repo-wide; `fmt`/`fmt:check`/`lint`/`check` tasks
  - [x] GitHub Actions CI: fmt:check, lint, check, test, cov, cov:report
  - [x] `README.md`, `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md`

---

## Post-MVP (tracked, not in scope)

- [ ] Guide, Reference, Comparison, Improvement, Blueprint nodes (5 of 8 spec
      types)
- [ ] Release-feed watcher that auto-resolves current versions (spec 6.3);
      version-pin evaluation shipped in Phase 13
- [ ] Real sandbox replay infra (the trust gate wiring lands in Phase 8)
- [ ] Reputation/rate limits/proof-of-work (spec 5.5 deferral)
- [ ] Web view + contribution form
- [ ] MCP adapter
- [ ] Postgres backend swap

## Audit record

- 2026-08-14: full code review against OSK Spec v0.3.0. Findings moved to Phases
  7-12. HIGH: replay not wired, no content negotiation, no body limit,
  orphan-block risk, dead scaffolding. MEDIUM: no shutdown, origin-based links,
  wildcard bind + wrong log, lax by-node-id paths, no observability.
- 2026-08-14: improvement audit. Found and fixed: Verification bypass via
  `POST /nodes`; unvalidated `supersedes_cid` (cycles possible); deprecation
  triggers never evaluated; no index rebuild; no sandbox timeout; UNIQUE-race
  500s; lax PORT/registry/CLI error handling; 25 unformatted files; no CI,
  README, LICENSE, or third-party notices.
