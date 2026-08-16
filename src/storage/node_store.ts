import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./db.ts";
import {
  computeConfidence,
  computeEffectiveStatus,
  earnedKeyWeight,
} from "./status.ts";
import {
  cachedVersionPins,
  deprecationTriggerFired,
  type VersionPin,
} from "./triggers.ts";
import { canonicalString } from "../core/serialize.ts";
import type { EffectiveStatus, Node, NodeType } from "../core/types.ts";
import type { NodeMeta } from "../nodetypes/types.ts";
import { isVerification, registry } from "../nodetypes/registry.ts";
import {
  type IndexedNode,
  type IndexedVerification,
  InvalidNodeError,
  type KeyReputation,
  type ReplayRecord,
  type SearchOptions,
  type SearchResult,
  type VerifierMetrics,
} from "./types.ts";

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed/i.test(e.message);
}

function latestByTimestamp(
  receipts: IndexedVerification[],
): IndexedVerification {
  return receipts.reduce((a, b) =>
    Date.parse(a.timestamp) > Date.parse(b.timestamp) ? a : b
  );
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK;");
  } catch {
    // no active transaction (e.g., BEGIN failed): keep the original error
  }
}

export interface NodeStore {
  init(): Promise<void>;
  reset(): Promise<void>;
  indexNode(node: Node, cid: string, createdAt: string): Promise<IndexedNode>;
  addVerification(
    receipt: Node,
    cid: string,
    createdAt: string,
    replay: ReplayRecord,
  ): Promise<void>;
  getNode(cid: string): Promise<IndexedNode | null>;
  getHeadVersion(nodeId: string): Promise<IndexedNode[]>;
  getVersions(nodeId: string): Promise<IndexedNode[]>;
  getReceiptsFor(solutionCid: string): Promise<IndexedVerification[]>;
  getReceipt(receiptCid: string): IndexedVerification | null;
  getAllReceipts(): IndexedVerification[];
  keyReputation(publicKey: string): KeyReputation;
  addTrustedKeys(keys: string[]): void;
  hasVerification(cid: string): Promise<boolean>;
  precheckVerification(
    receipt: Node,
  ): Promise<{ pointer: string; message: string }[]>;
  search(options: SearchOptions): Promise<SearchResult>;
  close(): Promise<void>;
}

const SORT_COLUMNS: Record<string, string> = {
  last_verified: "last_verified",
  created_at: "created_at",
  confidence_score: "confidence_score",
};

function extractMeta(node: Node): NodeMeta {
  return registry[node.osk.node_type].meta(node);
}

function rowToIndexedVerification(
  row: Record<string, unknown>,
): IndexedVerification {
  return {
    receipt_cid: row.receipt_cid as string,
    problem_cid: row.problem_cid as string,
    solution_cid: row.solution_cid as string,
    environment_hash: row.environment_hash as string,
    public_key: row.public_key as string,
    timestamp: row.timestamp as string,
    valid_until: row.valid_until as string | null,
    total: row.total as number,
    passed: row.passed as number,
    failed: row.failed as number,
    server_replayed: (row.server_replayed as number) === 1,
    replayed_at: row.replayed_at as string | null,
    replayed_by: row.replayed_by as string | null,
  };
}

function rowToIndexedNode(row: Record<string, unknown>): IndexedNode {
  const node = JSON.parse(row.node_json as string) as Node;
  return {
    cid: row.cid as string,
    node_id: row.node_id as string,
    node_type: row.node_type as NodeType,
    version_seq: row.version_seq as number,
    supersedes_cid: row.supersedes_cid as string | null,
    author_public_key: row.author_public_key as string,
    author_declared_status: row.author_declared_status as string,
    effective_status: row.effective_status as EffectiveStatus,
    confidence_score: row.confidence_score as number,
    last_verified: row.last_verified as string,
    severity: row.severity as string | null,
    framework_name: row.framework_name as string | null,
    language: row.language as string | null,
    runtime_name: row.runtime_name as string | null,
    title: row.title as string | null,
    created_at: row.created_at as string,
    head: (row.head as number) === 1,
    node,
  };
}

export class SqliteNodeStore implements NodeStore {
  #db: DatabaseSync;
  #closed = false;
  #versionPins: () => VersionPin;
  #trustedKeys: Set<string>;

  constructor(
    path: string,
    options: {
      versionPins?: () => VersionPin;
      trustedKeys?: string[];
    } = {},
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#versionPins = options.versionPins ?? cachedVersionPins(undefined);
    this.#trustedKeys = new Set(options.trustedKeys ?? []);
  }

  #triggerFired(node: Node): boolean {
    return deprecationTriggerFired(node, this.#versionPins());
  }

  async init(): Promise<void> {
    await migrate(this.#db);
  }

  async reset(): Promise<void> {
    this.#db.exec("DROP TABLE IF EXISTS nodes");
    this.#db.exec("DROP TABLE IF EXISTS verifications");
    this.#db.exec("DROP TABLE IF EXISTS deprecation_triggers");
    this.#db.exec("PRAGMA user_version = 0");
    await migrate(this.#db);
  }

  async indexNode(
    node: Node,
    cid: string,
    createdAt: string,
  ): Promise<IndexedNode> {
    const nodeId = node.osk.node_id;
    const meta = extractMeta(node);
    const supersededCid = node.osk.supersedes_cid?.["/"] ?? null;

    const db = this.#db;
    db.exec("BEGIN IMMEDIATE;");
    try {
      let versionSeq = 1;
      if (supersededCid) {
        const prev = db.prepare(
          "SELECT version_seq, node_id FROM nodes WHERE cid = ?",
        ).get(supersededCid) as
          | { version_seq: number; node_id: string }
          | undefined;
        if (!prev) {
          throw new InvalidNodeError(
            "supersedes_cid target does not exist in the index",
          );
        }
        if (prev.node_id !== nodeId) {
          throw new InvalidNodeError(
            "supersedes_cid must reference a version of the same node_id",
          );
        }
        versionSeq = prev.version_seq + 1;
      }

      const effective = computeEffectiveStatus(node, {
        latestReceipt: null,
        triggerFired: this.#triggerFired(node),
        now: createdAt,
      });

      db.prepare(
        `INSERT INTO nodes (cid, node_id, node_type, version_seq, supersedes_cid, author_public_key,
           author_declared_status, effective_status, confidence_score, last_verified,
           severity, framework_name, language, runtime_name, title, created_at, head, node_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        cid,
        nodeId,
        node.osk.node_type,
        versionSeq,
        supersededCid,
        node.osk.attribution.public_key,
        node.osk.knowledge_lifecycle.status,
        effective,
        0.0,
        node.osk.knowledge_lifecycle.last_verified,
        meta.severity,
        meta.framework_name,
        meta.language,
        meta.runtime_name,
        registry[node.osk.node_type].title(node),
        createdAt,
        0,
        canonicalString(node),
      );

      this.#recomputeHeads(nodeId);
      const headCount = (db.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE node_id = ? AND head = 1",
      ).get(nodeId) as { n: number }).n;
      if (headCount > 1) {
        db.prepare(
          "UPDATE nodes SET effective_status = 'disputed' WHERE node_id = ? AND head = 1",
        ).run(nodeId);
      }
      this.#indexTriggers(node, cid);
      db.exec("COMMIT;");
    } catch (e) {
      rollbackQuietly(db);
      if (isUniqueViolation(e)) {
        const existing = await this.getNode(cid);
        if (existing) {
          return existing;
        }
      }
      throw e;
    }

    const indexed = await this.getNode(cid);
    if (!indexed) {
      throw new Error("indexed node disappeared");
    }
    return indexed;
  }

  // Async to match the NodeStore contract. The SQLite driver is synchronous,
  // so awaits must stay out of the BEGIN/COMMIT block: a concurrent caller on
  // the shared connection would otherwise interleave inside the transaction.
  // deno-lint-ignore require-await
  async addVerification(
    receipt: Node,
    cid: string,
    createdAt: string,
    replay: ReplayRecord,
  ): Promise<void> {
    if (!isVerification(receipt)) {
      throw new InvalidNodeError("receipt is not a Verification node");
    }
    const verification = receipt.payload.verification;
    const solutionCid = verification.target.solution_id["/"];
    const problemCid = verification.target.problem_id["/"];

    const db = this.#db;
    db.exec("BEGIN IMMEDIATE;");
    try {
      const solution = db.prepare(
        "SELECT author_public_key FROM nodes WHERE cid = ?",
      ).get(solutionCid) as
        | { author_public_key: string }
        | undefined;
      if (!solution) {
        throw new InvalidNodeError("target solution does not exist in index");
      }
      if (solution.author_public_key === receipt.osk.attribution.public_key) {
        throw new InvalidNodeError(
          "verifier must not verify their own solution",
        );
      }

      db.prepare(
        `INSERT INTO verifications (receipt_cid, problem_cid, solution_cid, environment_hash,
           public_key, timestamp, valid_until, total, passed, failed,
           server_replayed, replayed_at, replayed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        cid,
        problemCid,
        solutionCid,
        verification.execution.environment_hash,
        receipt.osk.attribution.public_key,
        verification.timestamp,
        verification.valid_until ?? null,
        verification.execution.test_suite.total,
        verification.execution.test_suite.passed,
        verification.execution.test_suite.failed,
        replay.server_replayed ? 1 : 0,
        replay.replayed_at,
        replay.replayed_by,
      );

      const receipts = this.#replayedReceiptsFor(solutionCid);
      const confidence = this.#confidenceFor(solutionCid, createdAt);
      const latest = receipts.length > 0 ? latestByTimestamp(receipts) : null;
      const nodeJson =
        (db.prepare("SELECT node_json FROM nodes WHERE cid = ?").get(
          solutionCid,
        ) as { node_json: string }).node_json;
      const recipeNode = JSON.parse(nodeJson) as Node;
      const effective = computeEffectiveStatus(recipeNode, {
        latestReceipt: latest,
        triggerFired: this.#triggerFired(recipeNode),
        now: createdAt,
      });
      db.prepare(
        "UPDATE nodes SET confidence_score = ?, effective_status = ? WHERE cid = ?",
      ).run(confidence, effective, solutionCid);

      db.exec("COMMIT;");
    } catch (e) {
      rollbackQuietly(db);
      if (isUniqueViolation(e)) {
        return;
      }
      throw e;
    }
  }

  async getNode(cid: string): Promise<IndexedNode | null> {
    const row = this.#db.prepare("SELECT * FROM nodes WHERE cid = ?").get(
      cid,
    ) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    return await this.#refreshEffectiveStatus(
      rowToIndexedNode(row),
      new Date().toISOString(),
    );
  }

  async getHeadVersion(nodeId: string): Promise<IndexedNode[]> {
    const rows = this.#db.prepare(
      "SELECT * FROM nodes WHERE node_id = ? AND head = 1 ORDER BY created_at DESC",
    ).all(nodeId) as Record<string, unknown>[];
    const now = new Date().toISOString();
    return await rows.map((row) =>
      this.#refreshEffectiveStatus(rowToIndexedNode(row), now)
    );
  }

  async getVersions(nodeId: string): Promise<IndexedNode[]> {
    const rows = this.#db.prepare(
      "SELECT * FROM nodes WHERE node_id = ? ORDER BY version_seq DESC",
    ).all(nodeId) as Record<string, unknown>[];
    const now = new Date().toISOString();
    return await rows.map((row) =>
      this.#refreshEffectiveStatus(rowToIndexedNode(row), now)
    );
  }

  async getReceiptsFor(solutionCid: string): Promise<IndexedVerification[]> {
    return await this.#receiptsFor(solutionCid);
  }

  getAllReceipts(): IndexedVerification[] {
    const rows = this.#db.prepare("SELECT * FROM verifications")
      .all() as Record<string, unknown>[];
    return rows.map(rowToIndexedVerification);
  }

  getReceipt(receiptCid: string): IndexedVerification | null {
    const row = this.#db.prepare(
      "SELECT * FROM verifications WHERE receipt_cid = ?",
    ).get(receiptCid) as Record<string, unknown> | undefined;
    return row ? rowToIndexedVerification(row) : null;
  }

  async hasVerification(cid: string): Promise<boolean> {
    return await this.#db.prepare(
      "SELECT 1 AS one FROM verifications WHERE receipt_cid = ?",
    ).get(cid) !== undefined;
  }

  async precheckVerification(
    receipt: Node,
  ): Promise<{ pointer: string; message: string }[]> {
    if (!isVerification(receipt)) {
      return [{
        pointer: "/osk/node_type",
        message: "receipt is not a Verification node",
      }];
    }
    const verification = receipt.payload.verification;
    const solutionCid = verification.target.solution_id["/"];
    const problemCid = verification.target.problem_id["/"];
    const issues: { pointer: string; message: string }[] = [];

    const solution = await this.#db.prepare(
      "SELECT author_public_key, node_type FROM nodes WHERE cid = ?",
    ).get(solutionCid) as
      | { author_public_key: string; node_type: string }
      | undefined;
    if (!solution) {
      issues.push({
        pointer: "/payload/verification/target/solution_id",
        message: "target solution does not exist in the index",
      });
    } else if (solution.node_type !== "Recipe") {
      issues.push({
        pointer: "/payload/verification/target/solution_id",
        message: "target solution must be a Recipe node",
      });
    }

    const problem = this.#db.prepare("SELECT cid FROM nodes WHERE cid = ?").get(
      problemCid,
    );
    if (!problem) {
      issues.push({
        pointer: "/payload/verification/target/problem_id",
        message: "target problem does not exist in the index",
      });
    }

    if (
      solution &&
      solution.author_public_key === receipt.osk.attribution.public_key
    ) {
      issues.push({
        pointer: "/osk/attribution/public_key",
        message: "a verifier must not verify their own solution",
      });
    }
    return issues;
  }

  // Recomputes and persists the effective status on read. The stored column
  // backs search filters, so writes must follow the read. The Postgres port
  // should revisit this write-on-read tradeoff.
  #refreshEffectiveStatus(indexed: IndexedNode, now: string): IndexedNode {
    if (indexed.node_type !== "Recipe") {
      return indexed;
    }
    const receipts = this.#replayedReceiptsFor(indexed.cid);
    const latest = receipts.length > 0 ? latestByTimestamp(receipts) : null;
    const effective = computeEffectiveStatus(indexed.node, {
      latestReceipt: latest,
      triggerFired: this.#triggerFired(indexed.node),
      now,
    });
    if (effective !== indexed.effective_status) {
      this.#db.prepare("UPDATE nodes SET effective_status = ? WHERE cid = ?")
        .run(effective, indexed.cid);
      return { ...indexed, effective_status: effective };
    }
    return indexed;
  }

  #replayedReceiptsFor(solutionCid: string): IndexedVerification[] {
    const rows = this.#db.prepare(
      "SELECT * FROM verifications WHERE solution_cid = ? AND server_replayed = 1",
    ).all(solutionCid) as Record<string, unknown>[];
    return rows.map(rowToIndexedVerification);
  }

  #receiptsFor(solutionCid: string): IndexedVerification[] {
    const rows = this.#db.prepare(
      "SELECT * FROM verifications WHERE solution_cid = ?",
    ).all(solutionCid) as Record<string, unknown>[];
    return rows.map(rowToIndexedVerification);
  }

  #keyMetrics(publicKey: string): VerifierMetrics {
    const nodeRow = this.#db.prepare(
      "SELECT MIN(created_at) AS first_seen, COUNT(*) AS authored_count FROM nodes WHERE author_public_key = ?",
    ).get(publicKey) as { first_seen: string | null; authored_count: number };
    const crossRow = this.#db.prepare(
      `SELECT COUNT(*) AS c FROM verifications v JOIN nodes n ON n.cid = v.solution_cid
       WHERE n.author_public_key = ? AND v.public_key != ? AND v.server_replayed = 1`,
    ).get(publicKey, publicKey) as { c: number };
    return {
      first_seen: nodeRow.first_seen,
      authored_count: nodeRow.authored_count,
      cross_verified_count: crossRow.c,
    };
  }

  #keyWeight(publicKey: string, now: string): number {
    if (this.#trustedKeys.has(publicKey)) {
      return 1.0;
    }
    return earnedKeyWeight(this.#keyMetrics(publicKey), now);
  }

  keyReputation(publicKey: string): KeyReputation {
    const now = new Date().toISOString();
    const trusted = this.#trustedKeys.has(publicKey);
    const metrics = this.#keyMetrics(publicKey);
    return {
      trusted,
      metrics,
      weight: trusted ? 1.0 : earnedKeyWeight(metrics, now),
    };
  }

  addTrustedKeys(keys: string[]): void {
    for (const key of keys) {
      this.#trustedKeys.add(key);
    }
  }

  #confidenceFor(solutionCid: string, now: string): number {
    const receipts = this.#replayedReceiptsFor(solutionCid);
    const keyWeights = new Map<string, number>();
    let hasTrustedVerifier = false;
    for (const r of receipts) {
      if (!keyWeights.has(r.public_key)) {
        keyWeights.set(r.public_key, this.#keyWeight(r.public_key, now));
      }
      if (this.#trustedKeys.has(r.public_key)) {
        hasTrustedVerifier = true;
      }
    }
    return computeConfidence(receipts, keyWeights, hasTrustedVerifier);
  }

  async search(options: SearchOptions): Promise<SearchResult> {
    const where: string[] = [];
    const params: unknown[] = [];
    const f = options.filter;
    const columnMap: Record<string, string> = {
      node_type: "node_type",
      node_id: "node_id",
      effective_status: "effective_status",
      public_key: "author_public_key",
      severity: "severity",
      framework_name: "framework_name",
      language: "language",
      runtime_name: "runtime_name",
      title: "title",
    };
    const nocase = new Set(["framework_name", "language", "runtime_name"]);
    for (const [key, value] of Object.entries(f)) {
      const col = columnMap[key];
      if (col === undefined || value === undefined) {
        continue;
      }
      if (key === "title") {
        where.push(`${col} LIKE ? COLLATE NOCASE`);
        params.push(`%${String(value)}%`);
        continue;
      }
      if (nocase.has(key)) {
        where.push(`${col} = ? COLLATE NOCASE`);
        params.push(value);
        continue;
      }
      where.push(`${col} = ?`);
      params.push(value);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sortCol = SORT_COLUMNS[options.sort ?? ""] ?? "created_at";
    const orderSql = `ORDER BY ${sortCol} DESC`;
    const total = (await this.#db.prepare(
      `SELECT COUNT(*) AS n FROM nodes ${whereSql}`,
    ).get(...(params as never[])) as { n: number }).n;
    const rows = await this.#db.prepare(
      `SELECT * FROM nodes ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    ).all(...(params as never[]), options.limit, options.offset) as Record<
      string,
      unknown
    >[];
    const now = new Date().toISOString();
    return {
      data: rows.map((row) =>
        this.#refreshEffectiveStatus(rowToIndexedNode(row), now)
      ),
      total,
    };
  }

  #recomputeHeads(nodeId: string): void {
    const db = this.#db;
    db.prepare("UPDATE nodes SET head = 0 WHERE node_id = ?").run(nodeId);
    db.prepare(
      `UPDATE nodes SET head = 1 WHERE node_id = ? AND cid NOT IN (
         SELECT supersedes_cid FROM nodes WHERE node_id = ? AND supersedes_cid IS NOT NULL
       )`,
    ).run(nodeId, nodeId);
  }

  #indexTriggers(node: Node, cid: string): void {
    const triggers = node.osk.knowledge_lifecycle.deprecation_triggers ?? [];
    const stmt = this.#db.prepare(
      `INSERT INTO deprecation_triggers (node_cid, scope, versioning_scheme, condition)
       VALUES (?, ?, ?, ?)`,
    );
    for (const t of triggers) {
      stmt.run(cid, t.scope, t.versioning_scheme ?? "semver", t.condition);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#db.close();
  }
}
