import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  cid TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  version_seq INTEGER NOT NULL,
  supersedes_cid TEXT,
  author_public_key TEXT NOT NULL,
  author_declared_status TEXT NOT NULL,
  effective_status TEXT NOT NULL,
  confidence_score REAL NOT NULL DEFAULT 0,
  last_verified TEXT NOT NULL,
  severity TEXT,
  framework_name TEXT,
  created_at TEXT NOT NULL,
  head INTEGER NOT NULL DEFAULT 1,
  node_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  receipt_cid TEXT PRIMARY KEY,
  problem_cid TEXT NOT NULL,
  solution_cid TEXT NOT NULL,
  environment_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  valid_until TEXT,
  total INTEGER NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deprecation_triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_cid TEXT NOT NULL,
  scope TEXT NOT NULL,
  versioning_scheme TEXT NOT NULL,
  condition TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_node_id ON nodes(node_id);
CREATE INDEX IF NOT EXISTS idx_nodes_effective_status ON nodes(effective_status);
CREATE INDEX IF NOT EXISTS idx_nodes_author_public_key ON nodes(author_public_key);
CREATE INDEX IF NOT EXISTS idx_nodes_severity ON nodes(severity);
CREATE INDEX IF NOT EXISTS idx_nodes_framework_name ON nodes(framework_name);
CREATE INDEX IF NOT EXISTS idx_nodes_created_at ON nodes(created_at);
CREATE INDEX IF NOT EXISTS idx_nodes_last_verified ON nodes(last_verified);
CREATE INDEX IF NOT EXISTS idx_nodes_confidence ON nodes(confidence_score);
CREATE INDEX IF NOT EXISTS idx_verif_solution ON verifications(solution_cid);
`;

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
}
