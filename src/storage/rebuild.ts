import type { Blockstore } from "./blockstore.ts";
import type { NodeStore } from "./node_store.ts";
import { verifyNodeSignature } from "../core/sign.ts";
import type { Node } from "../core/types.ts";

interface Indexed {
  cid: string;
  node: Node;
}

function orderByDepth(nodes: Indexed[]): Indexed[] {
  const byCid = new Map(nodes.map((n) => [n.cid, n]));
  const memo = new Map<string, number>();
  const depth = (n: Indexed): number => {
    const cached = memo.get(n.cid);
    if (cached !== undefined) {
      return cached;
    }
    const parent = n.node.corpus.supersedes_cid?.["/"];
    if (!parent) {
      memo.set(n.cid, 0);
      return 0;
    }
    const parentNode = byCid.get(parent);
    if (!parentNode) {
      throw new Error(`rebuild: ${n.cid} supersedes missing block ${parent}`);
    }
    const d = depth(parentNode) + 1;
    memo.set(n.cid, d);
    return d;
  };
  const withDepth = nodes.map((n) => ({ entry: n, depth: depth(n) }));
  return withDepth
    .sort((a, b) => a.depth - b.depth)
    .map((n) => n.entry);
}

export async function rebuildIndex(
  blockstore: Blockstore,
  store: NodeStore,
): Promise<number> {
  const blocks = await blockstore.list();
  const nodes: Indexed[] = [];
  const receipts: Indexed[] = [];
  for (const block of blocks) {
    const node = JSON.parse(new TextDecoder().decode(block.bytes)) as Node;
    if (!verifyNodeSignature(node)) {
      throw new Error(`rebuild: block ${block.cid} has an invalid signature`);
    }
    const entry = { cid: block.cid, node };
    (node.corpus.node_type === "Verification" ? receipts : nodes).push(entry);
  }
  await store.reset();
  const now = new Date().toISOString();
  for (const { cid, node } of orderByDepth(nodes)) {
    await store.indexNode(node, cid, now);
  }
  for (const { cid, node } of receipts) {
    await store.addVerification(node, cid, now, {
      server_replayed: false,
      replayed_at: null,
      replayed_by: "rebuild",
    });
  }
  return blocks.length;
}
