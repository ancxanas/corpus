import { assertEquals, assertRejects } from "@std/assert";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { canonicalBytes } from "../src/core/serialize.ts";
import { problemNode, signed } from "./fixtures.ts";
import { generateKeyPair } from "../src/core/sign.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-test-${crypto.randomUUID()}`;
}

Deno.test("blockstore stores by CID", async () => {
  const dir = tempDir();
  const bs = new FileBlockstore({ dir });
  const { secretKeyHex } = generateKeyPair();
  const node = signed(problemNode("a".repeat(64)), secretKeyHex);
  const bytes = canonicalBytes(node);
  const cid = await bs.put(bytes);
  assertEquals(cid.startsWith("b"), true);
  await Deno.stat(`${dir}/${cid}.json`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("blockstore is content-addressed", async () => {
  const dir = tempDir();
  const bs = new FileBlockstore({ dir });
  const { secretKeyHex } = generateKeyPair();
  const node = signed(problemNode("a".repeat(64)), secretKeyHex);
  const bytes = canonicalBytes(node);
  const cidA = await bs.put(bytes);
  const cidB = await bs.put(bytes);
  assertEquals(cidA, cidB);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("blockstore delete removes the block file", async () => {
  const dir = tempDir();
  const bs = new FileBlockstore({ dir });
  const { secretKeyHex } = generateKeyPair();
  const node = signed(problemNode("a".repeat(64)), secretKeyHex);
  const cid = await bs.put(canonicalBytes(node));
  await bs.delete(cid);
  await assertRejects(() => Deno.stat(`${dir}/${cid}.json`));
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

Deno.test("blockstore delete of an absent block is a no-op", async () => {
  const dir = tempDir();
  const bs = new FileBlockstore({ dir });
  await bs.delete("baguqeeranonexistent");
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});
