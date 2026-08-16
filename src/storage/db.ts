import { DatabaseSync } from "node:sqlite";
import type { Node } from "../core/types.ts";
import { registry } from "../nodetypes/registry.ts";

const SCHEMA_V1 = `
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

const SCHEMA_V2 = `
ALTER TABLE nodes ADD COLUMN title TEXT;
CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title);
`;

const SCHEMA_V3 = `
ALTER TABLE verifications ADD COLUMN server_replayed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE verifications ADD COLUMN replayed_at TEXT;
ALTER TABLE verifications ADD COLUMN replayed_by TEXT;
CREATE INDEX IF NOT EXISTS idx_verif_key ON verifications(public_key);
`;

const SCHEMA_V4 = `
ALTER TABLE nodes ADD COLUMN language TEXT;
ALTER TABLE nodes ADD COLUMN runtime_name TEXT;
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_runtime_name ON nodes(runtime_name);
`;

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS node_links (
  source_cid TEXT NOT NULL,
  name TEXT NOT NULL,
  target_cid TEXT NOT NULL,
  PRIMARY KEY (source_cid, name, target_cid)
);
CREATE INDEX IF NOT EXISTS idx_node_links_target ON node_links(target_cid);
`;

const SCHEMA_V6 = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  title,
  summary,
  tags,
  body,
  tokenize = 'porter unicode61'
);
`;

export interface FtsFields {
  title: string;
  summary: string;
  tags: string;
  body: string;
}

export function ftsFields(node: Node): FtsFields {
  const payload = node.payload as Record<string, Record<string, unknown>>;
  const inner = Object.values(payload)[0] as {
    title?: string;
    summary?: string;
    tags?: string[];
    impact?: string;
    symptoms?: Array<{ description?: string; observable?: string }>;
    reproduction?: Array<{ title?: string; body?: string }>;
    diagnosis?: Array<{ title?: string; body?: string }>;
    root_cause?: { mechanism?: string; causal_chain?: string[] };
    explanation?: string;
    steps?: Array<{ title?: string; body?: string }>;
    caveats?: Array<{ condition?: string; warning?: string }>;
    verification?: string;
    code?: { body?: string };
    sections?: Array<{
      heading?: string;
      claim?: string;
      body?: {
        explanation?: string;
        example?: string;
        code?: { body?: string };
      };
    }>;
  } | undefined;
  const parts: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === "string" && value) {
      parts.push(value);
    }
  };
  push(inner?.impact);
  for (const s of inner?.symptoms ?? []) {
    push(s.description);
    push(s.observable);
  }
  for (const s of inner?.reproduction ?? []) {
    push(s.title);
    push(s.body);
  }
  for (const s of inner?.diagnosis ?? []) {
    push(s.title);
    push(s.body);
  }
  push(inner?.root_cause?.mechanism);
  for (const c of inner?.root_cause?.causal_chain ?? []) {
    push(c);
  }
  push(inner?.explanation);
  for (const s of inner?.steps ?? []) {
    push(s.title);
    push(s.body);
  }
  for (const c of inner?.caveats ?? []) {
    push(c.condition);
    push(c.warning);
  }
  push(inner?.verification);
  push(inner?.code?.body);
  for (const s of inner?.sections ?? []) {
    push(s.heading);
    push(s.claim);
    push(s.body?.explanation);
    push(s.body?.example);
    push(s.body?.code?.body);
  }
  return {
    title: inner?.title ?? "",
    summary: inner?.summary ?? "",
    tags: (inner?.tags ?? []).join(" "),
    body: parts.join(" "),
  };
}

function backfillLinks(db: DatabaseSync): void {
  const rows = db.prepare("SELECT cid, node_json FROM nodes").all() as {
    cid: string;
    node_json: string;
  }[];
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO node_links (source_cid, name, target_cid) VALUES (?, ?, ?)",
  );
  for (const row of rows) {
    let node: Node;
    try {
      node = JSON.parse(row.node_json) as Node;
    } catch {
      continue;
    }
    const module = registry[node.osk.node_type];
    if (!module) {
      continue;
    }
    for (const def of module.relationships(node)) {
      for (const link of def.links) {
        stmt.run(row.cid, def.name, link.cid);
      }
    }
  }
}

function backfillSearchIndex(db: DatabaseSync): void {
  const rows = db.prepare("SELECT rowid, node_json FROM nodes").all() as {
    rowid: number;
    node_json: string;
  }[];
  const stmt = db.prepare(
    "INSERT INTO search_index (rowid, title, summary, tags, body) VALUES (?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    let node: Node;
    try {
      node = JSON.parse(row.node_json) as Node;
    } catch {
      continue;
    }
    const fields = ftsFields(node);
    stmt.run(row.rowid, fields.title, fields.summary, fields.tags, fields.body);
  }
}

const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  (db) => {
    db.exec(SCHEMA_V1);
  },
  (db) => {
    db.exec(SCHEMA_V2);
  },
  (db) => {
    db.exec(SCHEMA_V3);
  },
  (db) => {
    db.exec(SCHEMA_V4);
  },
  (db) => {
    db.exec(SCHEMA_V5);
    backfillLinks(db);
  },
  (db) => {
    db.exec(SCHEMA_V6);
    backfillSearchIndex(db);
  },
];

export function migrate(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  let version = (db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  }).user_version;
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      MIGRATIONS[version]!(db);
      version += 1;
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec("COMMIT;");
    } catch (e) {
      db.exec("ROLLBACK;");
      throw e;
    }
  }
}
