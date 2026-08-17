import type { EffectiveStatus, Node } from "../core/types.ts";
import type { IndexedVerification, VerifierMetrics } from "./types.ts";
import { registry } from "../nodetypes/registry.ts";

export interface StatusContext {
  latestReceipt: IndexedVerification | null;
  triggerFired: boolean;
  now: string;
}

export function computeEffectiveStatus(
  node: Node,
  ctx: StatusContext,
): EffectiveStatus {
  const declared = node.corpus.knowledge_lifecycle.status;
  if (declared === "deprecated") {
    return "deprecated";
  }
  const receipt = ctx.latestReceipt;
  if (receipt && receipt.failed > 0) {
    return "disputed";
  }
  if (receipt?.valid_until && ctx.now > receipt.valid_until) {
    return "stale";
  }
  if (ctx.triggerFired) {
    return "stale";
  }
  return registry[node.corpus.node_type].lifecycle(declared, receipt !== null);
}

function latestReceipt(receipts: IndexedVerification[]): IndexedVerification {
  return receipts.reduce((
    a,
    b,
  ) => (Date.parse(a.timestamp) > Date.parse(b.timestamp) ? a : b));
}

export function earnedKeyWeight(metrics: VerifierMetrics, now: string): number {
  const ageDays = metrics.first_seen
    ? Math.max(
      0,
      (Date.parse(now) - Date.parse(metrics.first_seen)) / 86_400_000,
    )
    : 0;
  const age = 0.4 * Math.min(ageDays / 90, 1);
  const cross = 0.3 * Math.min(metrics.cross_verified_count / 3, 1);
  const authored = 0.3 * Math.min(metrics.authored_count / 5, 1);
  return Math.min(1, age + cross + authored);
}

const MAX_UNTRUSTED_SOURCES = 2;

export function computeConfidence(
  receipts: IndexedVerification[],
  keyWeights: Map<string, number>,
  hasTrustedVerifier: boolean,
): number {
  if (receipts.length === 0) {
    return 0.0;
  }
  const latest = latestReceipt(receipts);
  if (latest.failed > 0) {
    return 0.0;
  }
  const keys = new Set(receipts.map((r) => r.public_key));
  let sources = 0;
  for (const key of keys) {
    sources += keyWeights.get(key) ?? 0;
  }
  if (!hasTrustedVerifier) {
    sources = Math.min(sources, MAX_UNTRUSTED_SOURCES);
  }
  return 1.0 - Math.pow(0.5, sources);
}
