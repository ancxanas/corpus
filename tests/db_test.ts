import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/storage/db.ts";

function tempDbPath(): string {
  return `/tmp/opencode/corpus-db-${crypto.randomUUID()}.db`;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as { name: string }[];
  return rows.map((r) => r.name);
}

Deno.test("migrate creates the schema and sets user_version", () => {
  const path = tempDbPath();
  const db = new DatabaseSync(path);
  migrate(db);
  const version = (db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  assertEquals(version, 7);
  for (
    const table of [
      "nodes",
      "verifications",
      "deprecation_triggers",
      "node_links",
      "search_index",
    ]
  ) {
    assertEquals(tableNames(db).includes(table), true);
  }
  db.close();
  Deno.removeSync(path);
});

Deno.test("migrate is idempotent on an already-migrated database", () => {
  const path = tempDbPath();
  const db = new DatabaseSync(path);
  migrate(db);
  db.exec(
    "INSERT INTO nodes (cid, node_id, node_type, version_seq, author_public_key, author_declared_status, effective_status, last_verified, created_at, head, node_json) VALUES ('c1', 'n1', 'Problem', 1, 'pk', 'draft', 'draft', '2024-01-01', '2024-01-01', 1, '{}')",
  );
  migrate(db);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as {
    n: number;
  }).n;
  assertEquals(count, 1);
  const version = (db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  assertEquals(version, 7);
  db.close();
  Deno.removeSync(path);
});

Deno.test("migrate backfills node_links from existing rows", () => {
  const path = tempDbPath();
  const db = new DatabaseSync(path);
  migrate(db);
  const node = {
    corpus: {
      version: "0.3.0",
      node_type: "Problem",
      node_id: "n1",
      knowledge_lifecycle: { status: "draft", last_verified: "2024-01-01" },
      attribution: { public_key: "pk" },
    },
    payload: {
      problem: { solutions: [{ node: { "/": "r1" } }] },
    },
  };
  db.prepare(
    `INSERT INTO nodes (cid, node_id, node_type, version_seq, author_public_key,
       author_declared_status, effective_status, confidence_score, last_verified,
       created_at, head, node_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "p1",
    "n1",
    "Problem",
    1,
    "pk",
    "draft",
    "draft",
    0,
    "2024-01-01",
    "2024-01-01",
    1,
    JSON.stringify(node),
  );
  db.exec("DROP TABLE IF EXISTS node_links");
  db.exec("PRAGMA user_version = 4");
  migrate(db);
  const links = db.prepare(
    "SELECT source_cid, name, target_cid FROM node_links",
  ).all() as { source_cid: string; name: string; target_cid: string }[];
  assertEquals(links, [{
    source_cid: "p1",
    name: "solutions",
    target_cid: "r1",
  }]);
  db.close();
  Deno.removeSync(path);
});

Deno.test("migrate after reset (drop + user_version 0) recreates the tables", () => {
  const path = tempDbPath();
  const db = new DatabaseSync(path);
  migrate(db);
  db.exec("DROP TABLE IF EXISTS nodes");
  db.exec("DROP TABLE IF EXISTS verifications");
  db.exec("DROP TABLE IF EXISTS deprecation_triggers");
  db.exec("PRAGMA user_version = 0");
  migrate(db);
  const version = (db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  assertEquals(version, 7);
  assertEquals(tableNames(db).includes("nodes"), true);
  assertEquals(tableNames(db).includes("verifications"), true);
  db.close();
  Deno.removeSync(path);
});

Deno.test("migrate backfills search_index from existing rows", () => {
  const path = tempDbPath();
  const db = new DatabaseSync(path);
  migrate(db);
  const node = {
    corpus: {
      version: "0.3.0",
      node_type: "Problem",
      node_id: "n2",
      knowledge_lifecycle: { status: "active", last_verified: "2024-01-01" },
      attribution: { public_key: "pk" },
    },
    payload: {
      problem: {
        title: "Worker heap exhaustion",
        summary: "Large JSON responses blow up the heap.",
        tags: ["json", "memory"],
        symptoms: [{
          description: "process dies",
          observable: "OOM",
          frequency: "always",
        }],
        root_cause: {
          mechanism: "unbounded buffer",
          causal_chain: ["serialization"],
        },
        environment: {
          runtime: { type: "deno", versions: ["2.x"] },
          framework: { name: "deno", version: "2.x" },
        },
        severity: "critical",
      },
    },
  };
  db.prepare(
    `INSERT INTO nodes (cid, node_id, node_type, version_seq, author_public_key,
       author_declared_status, effective_status, confidence_score, last_verified,
       created_at, head, node_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "p2",
    "n2",
    "Problem",
    1,
    "pk",
    "active",
    "active",
    0,
    "2024-01-01",
    "2024-01-01",
    1,
    JSON.stringify(node),
  );
  db.exec("DROP TABLE IF EXISTS search_index");
  db.exec("PRAGMA user_version = 5");
  migrate(db);
  const hits = db.prepare(
    "SELECT rowid FROM search_index WHERE search_index MATCH ?",
  ).all('"heap"');
  assertEquals(hits.length, 1);
  const tagHits = db.prepare(
    "SELECT rowid FROM search_index WHERE search_index MATCH ?",
  ).all('tags:"json"');
  assertEquals(tagHits.length, 1);
  db.close();
  Deno.removeSync(path);
});
