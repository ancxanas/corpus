import { assertEquals, assertRejects } from "@std/assert";
import { SqliteQueryIndex } from "../src/storage/index.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { IngestService } from "../src/storage/ingest.ts";
import { rebuildIndex } from "../src/storage/rebuild.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import {
  cidOf,
  problemNode,
  recipeNode,
  signed,
  verificationNode,
} from "./fixtures.ts";
import { canonicalBytes } from "../src/core/serialize.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-rebuild-${crypto.randomUUID()}`;
}

async function buildCorpus() {
  const dir = tempDir();
  const index = new SqliteQueryIndex(`${dir}/index.db`);
  index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
  );
  const authorKey = generateKeyPair();
  const verifierKey = generateKeyPair();
  const verifierKey2 = generateKeyPair();

  const problem = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  await ingest.ingestNode(problem);

  const recipe = signed(
    recipeNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const recipeCid = await cidOf(recipe);
  await ingest.ingestNode(recipe);

  const receipt = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "c".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  await ingest.ingestVerification(receipt);

  const original = await index.getNode(problemCid);
  const v2 = signed(
    problemNode(authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: problemCid,
      title: "v2 problem",
    }),
    authorKey.secretKeyHex,
  );
  await ingest.ingestNode(v2);

  const receipt2 = signed(
    verificationNode(
      verifierKey2.publicKeyHex,
      problemCid,
      recipeCid,
      "d".repeat(64),
    ),
    verifierKey2.secretKeyHex,
  );
  await ingest.ingestVerification(receipt2);

  index.close();
  return { dir, problemCid, recipeCid, v2 };
}

Deno.test("rebuild restores index, confidence, and heads", async () => {
  const built = await buildCorpus();
  const { dir, problemCid, recipeCid, v2 } = built;
  const fresh = new SqliteQueryIndex(`${dir}/index.db`);
  fresh.init();
  const blockstore = new FileBlockstore({ dir: `${dir}/blocks` });
  const count = await rebuildIndex(blockstore, fresh);
  assertEquals(count, 5);

  const recipe = fresh.getNode(recipeCid);
  assertEquals(recipe?.confidence_score, 0.75);
  assertEquals(recipe?.effective_status, "active");

  const v2Cid = await cidOf(v2);
  const v2Node = fresh.getNode(v2Cid);
  assertEquals(v2Node?.head, true);
  const v1Node = fresh.getNode(problemCid);
  assertEquals(v1Node?.head, false);

  const search = fresh.search({
    filter: { node_type: "Problem" },
    limit: 10,
    offset: 0,
  });
  assertEquals(search.total, 2);

  fresh.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("rebuild rejects a block whose supersedes target is missing", async () => {
  const dir = tempDir();
  const index = new SqliteQueryIndex(`${dir}/index.db`);
  index.init();
  const blockstore = new FileBlockstore({ dir: `${dir}/blocks` });
  const authorKey = generateKeyPair();
  const other = generateKeyPair();
  const ghost = signed(recipeNode(other.publicKeyHex), other.secretKeyHex);
  const ghostCid = await cidOf(ghost);

  const orphan = signed(
    problemNode(authorKey.publicKeyHex, { supersedesCid: ghostCid }),
    authorKey.secretKeyHex,
  );
  await blockstore.put(canonicalBytes(orphan));

  const fresh = new SqliteQueryIndex(`${dir}/index.db`);
  fresh.init();
  await assertRejects(
    () => rebuildIndex(blockstore, fresh),
    Error,
    "supersedes missing block",
  );
  fresh.close();
  await Deno.remove(dir, { recursive: true });
});
