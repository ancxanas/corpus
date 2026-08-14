import type { EffectiveStatus, Node } from "../core/types.ts";
import type { IndexedVerification } from "./types.ts";

export interface StatusContext {
  latestReceipt: IndexedVerification | null;
  triggerFired: boolean;
  now: string;
}

export function computeEffectiveStatus(
  node: Node,
  ctx: StatusContext,
): EffectiveStatus {
  const declared = node.osk.knowledge_lifecycle.status;
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
  if (node.osk.node_type === "Recipe") {
    if (declared === "draft") {
      return "draft";
    }
    return receipt ? "active" : "draft";
  }
  return declared;
}

function latestReceipt(receipts: IndexedVerification[]): IndexedVerification {
  return receipts.reduce((
    a,
    b,
  ) => (Date.parse(a.timestamp) > Date.parse(b.timestamp) ? a : b));
}

function independentSourceCount(receipts: IndexedVerification[]): number {
  const n = receipts.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (
        receipts[i]!.public_key === receipts[j]!.public_key ||
        receipts[i]!.environment_hash === receipts[j]!.environment_hash
      ) {
        union(i, j);
      }
    }
  }
  return new Set(receipts.map((_, i) => find(i))).size;
}

export function computeConfidence(receipts: IndexedVerification[]): number {
  if (receipts.length === 0) {
    return 0.0;
  }
  const latest = latestReceipt(receipts);
  if (latest.failed > 0) {
    return 0.0;
  }
  const sources = independentSourceCount(receipts);
  if (sources === 1) {
    return 0.5;
  }
  return 1.0 - Math.pow(0.5, sources);
}
