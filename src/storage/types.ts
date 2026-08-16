import type { EffectiveStatus, Node, NodeType } from "../core/types.ts";

export class InvalidNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNodeError";
  }
}

export interface IndexedNode {
  cid: string;
  node_id: string;
  node_type: NodeType;
  version_seq: number;
  supersedes_cid: string | null;
  author_public_key: string;
  author_declared_status: string;
  effective_status: EffectiveStatus;
  confidence_score: number;
  last_verified: string;
  severity: string | null;
  framework_name: string | null;
  language: string | null;
  runtime_name: string | null;
  title: string | null;
  created_at: string;
  head: boolean;
  node: Node;
}

export interface IndexedVerification {
  receipt_cid: string;
  problem_cid: string;
  solution_cid: string;
  environment_hash: string;
  public_key: string;
  timestamp: string;
  valid_until: string | null;
  total: number;
  passed: number;
  failed: number;
  server_replayed: boolean;
  replayed_at: string | null;
  replayed_by: string | null;
}

export interface VerifierMetrics {
  first_seen: string | null;
  authored_count: number;
  cross_verified_count: number;
}

export interface ReplayRecord {
  server_replayed: boolean;
  replayed_at: string | null;
  replayed_by: string;
}

export interface KeyReputation {
  trusted: boolean;
  weight: number;
  metrics: VerifierMetrics;
}

export interface SearchFilter {
  node_type?: NodeType;
  node_id?: string;
  effective_status?: string;
  public_key?: string;
  severity?: string;
  framework_name?: string;
  title?: string;
  [key: string]: unknown;
}

export interface SearchOptions {
  filter: SearchFilter;
  sort?: string;
  limit: number;
  offset: number;
}

export interface SearchResult {
  data: IndexedNode[];
  total: number;
}
