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
  assertEquals(version, 4);
  for (const table of ["nodes", "verifications", "deprecation_triggers"]) {
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
  assertEquals(version, 4);
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
  assertEquals(version, 4);
  assertEquals(tableNames(db).includes("nodes"), true);
  assertEquals(tableNames(db).includes("verifications"), true);
  db.close();
  Deno.removeSync(path);
});
