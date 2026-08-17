import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { SqliteNodeStore } from "../src/storage/node_store.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import {
  IngestService,
  SignatureError,
  ValidationError,
} from "../src/storage/ingest.ts";
import { InvalidNodeError } from "../src/storage/types.ts";
import { PlaygroundRegistry } from "../src/execution/registry.ts";
import { TrustedStubReplayExecutor } from "../src/execution/replay.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import {
  cidOf,
  problemNode,
  recipeNode,
  signed,
  verificationNode,
} from "./fixtures.ts";
import type { Node } from "../src/core/types.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-test-${crypto.randomUUID()}`;
}

function makeIngest(dir: string, index: SqliteNodeStore): IngestService {
  const registry = new PlaygroundRegistry([
    {
      environment_hash: "e".repeat(64),
      playground: "sandbox-den",
      platform: "linux",
      version: "1.0",
      config_hash: "cfg-e",
    },
    {
      environment_hash: "f".repeat(64),
      playground: "sandbox-den",
      platform: "linux",
      version: "1.0",
      config_hash: "cfg-f",
    },
  ]);
  return new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
    registry,
    new TrustedStubReplayExecutor(),
  );
}

interface Env {
  dir: string;
  ingest: IngestService;
  index: SqliteNodeStore;
  authorKey: { publicKeyHex: string; secretKeyHex: string };
  verifierKey: { publicKeyHex: string; secretKeyHex: string };
  problemCid: string;
  recipeCid: string;
}

async function makeEnv(): Promise<Env> {
  const dir = tempDir();
  const authorKey = generateKeyPair();
  const verifierKey = generateKeyPair();
  const index = new SqliteNodeStore(`${dir}/index.db`, {
    trustedKeys: [verifierKey.publicKeyHex],
  });
  await index.init();
  const ingest = makeIngest(dir, index);

  const problem = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  const indexedProblem = await ingest.ingestNode(problem);

  const recipe = signed(
    recipeNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const recipeCid = await cidOf(recipe);
  const indexedRecipe = await ingest.ingestNode(recipe);

  assertEquals(indexedProblem.effective_status, "active");
  assertEquals(indexedRecipe.effective_status, "draft");
  return {
    dir,
    ingest,
    index,
    authorKey,
    verifierKey,
    problemCid,
    recipeCid,
  };
}

Deno.test("ingest problem and recipe, fetch by cid", async () => {
  const env = await makeEnv();
  const problem = await env.index.getNode(env.problemCid);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(problem?.node_type, "Problem");
  assertEquals(recipe?.node_type, "Recipe");
  assertEquals(recipe?.confidence_score, 0.0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("node_links tracks solutions and supports reverse lookup", async () => {
  const env = await makeEnv();
  const problem = signed(
    problemNode(env.authorKey.publicKeyHex, {
      solutionCids: [env.recipeCid],
    }),
    env.authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  await env.ingest.ingestNode(problem);
  assertEquals(env.index.linkedFrom(env.recipeCid), [problemCid]);
  assertEquals(env.index.linkedFrom(env.recipeCid, "solutions"), [problemCid]);
  assertEquals(env.index.linkedFrom(env.recipeCid, "nope"), []);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("rebuild recreates node_links from blocks", async () => {
  const env = await makeEnv();
  const problem = signed(
    problemNode(env.authorKey.publicKeyHex, {
      solutionCids: [env.recipeCid],
    }),
    env.authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  await env.ingest.ingestNode(problem);
  await env.index.reset();
  const { rebuildIndex } = await import("../src/storage/rebuild.ts");
  await rebuildIndex(
    new FileBlockstore({ dir: `${env.dir}/blocks` }),
    env.index,
  );
  assertEquals(env.index.linkedFrom(env.recipeCid, "solutions"), [problemCid]);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("keyword search matches body and tags across types", async () => {
  const env = await makeEnv();
  const customNode = problemNode(env.authorKey.publicKeyHex, {
    title: "JSON heap exhaustion",
    solutionCids: [env.recipeCid],
  }) as ReturnType<typeof problemNode> & {
    payload: { problem: { tags?: string[] } };
  };
  customNode.payload.problem.tags = ["json", "oom"];
  const custom = signed(customNode, env.authorKey.secretKeyHex);
  const customCid = await cidOf(custom);
  await env.ingest.ingestNode(custom);

  const byBody = await env.index.search({
    filter: {},
    search: "explicit stack",
    limit: 25,
    offset: 0,
  });
  assertEquals(
    byBody.data.map((r) => r.cid).includes(env.recipeCid),
    true,
    "recipe body text must be searchable",
  );

  const byTag = await env.index.search({
    filter: {},
    search: "oom",
    limit: 25,
    offset: 0,
  });
  assertEquals(
    byTag.data.map((r) => r.cid).includes(customCid),
    true,
    "tags must be searchable",
  );

  const byTitle = await env.index.search({
    filter: {},
    search: "heap exhaustion",
    limit: 25,
    offset: 0,
  });
  assertEquals(
    byTitle.data.map((r) => r.cid).includes(customCid),
    true,
    "title must be searchable",
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("tag filter restricts and intersects with keyword search", async () => {
  const env = await makeEnv();
  const customNode = problemNode(env.authorKey.publicKeyHex, {
    title: "JSON heap exhaustion",
    solutionCids: [env.recipeCid],
  }) as ReturnType<typeof problemNode> & {
    payload: { problem: { tags?: string[] } };
  };
  customNode.payload.problem.tags = ["json"];
  const custom = signed(customNode, env.authorKey.secretKeyHex);
  const customCid = await cidOf(custom);
  await env.ingest.ingestNode(custom);

  const byTag = await env.index.search({
    filter: { tag: "json" },
    limit: 25,
    offset: 0,
  });
  assertEquals(byTag.data.map((r) => r.cid), [customCid]);

  const taggedNode = recipeNode(env.authorKey.publicKeyHex) as
    & ReturnType<
      typeof recipeNode
    >
    & { payload: { recipe: { tags?: string[] } } };
  taggedNode.payload.recipe.tags = ["json"];
  const taggedRecipe = signed(taggedNode, env.authorKey.secretKeyHex);
  await env.ingest.ingestNode(taggedRecipe);

  const both = await env.index.search({
    filter: { tag: "json" },
    search: "heap",
    limit: 25,
    offset: 0,
  });
  assertEquals(
    both.data.map((r) => r.cid),
    [customCid],
    "keyword and tag filters must intersect",
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("keyword search handles FTS special characters safely", async () => {
  const env = await makeEnv();
  const res = await env.index.search({
    filter: {},
    search: 'OR NOT (json AND -"oom")',
    limit: 25,
    offset: 0,
  });
  assertEquals(res.total, 0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("recipe with one verification gets confidence 0.5", async () => {
  const env = await makeEnv();
  const receipt = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  await env.ingest.ingestVerification(receipt);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(recipe?.confidence_score, 0.5);
  assertEquals(recipe?.effective_status, "active");
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("two verifications with different env hashes give 0.75", async () => {
  const env = await makeEnv();
  const secondKey = generateKeyPair();
  env.index.addTrustedKeys([secondKey.publicKeyHex]);
  const r1 = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  const r2 = signed(
    verificationNode(
      secondKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "f".repeat(64),
    ),
    secondKey.secretKeyHex,
  );
  await env.ingest.ingestVerification(r1);
  await env.ingest.ingestVerification(r2);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(recipe?.confidence_score, 1 - Math.pow(0.5, 2));
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("verifications sharing env hash count as one source", async () => {
  const env = await makeEnv();
  const secondKey = generateKeyPair();
  const r1 = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  const r2 = signed(
    verificationNode(
      secondKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    secondKey.secretKeyHex,
  );
  await env.ingest.ingestVerification(r1);
  await env.ingest.ingestVerification(r2);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(recipe?.confidence_score, 0.5);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("failed receipt sets disputed and zero confidence", async () => {
  const env = await makeEnv();
  const receipt = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
      {
        execution: {
          playground: "sandbox-den",
          environment_hash: "e".repeat(64),
          test_suite: {
            total: 1,
            passed: 0,
            failed: 1,
            cases: [
              {
                name: "fails",
                expected: "ok",
                actual: "crash",
                result: "fail",
              },
            ],
          },
        },
      },
    ),
    env.verifierKey.secretKeyHex,
  );
  await env.ingest.ingestVerification(receipt);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(recipe?.effective_status, "disputed");
  assertEquals(recipe?.confidence_score, 0.0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("self-verification is rejected", async () => {
  const env = await makeEnv();
  const receipt = signed(
    verificationNode(
      env.authorKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    env.authorKey.secretKeyHex,
  );
  await assertRejects(
    () => env.ingest.ingestVerification(receipt),
    ValidationError,
    "a verifier must not verify their own solution",
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("verification with unknown target is rejected", async () => {
  const env = await makeEnv();
  const missing = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      "b".repeat(61),
      env.recipeCid,
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  await assertRejects(
    () => env.ingest.ingestVerification(missing),
    ValidationError,
    "target problem does not exist",
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("verification with missing solution is rejected", async () => {
  const env = await makeEnv();
  const missing = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      "b".repeat(61),
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  await assertRejects(
    () => env.ingest.ingestVerification(missing),
    ValidationError,
    "target solution does not exist",
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("invalid signature is rejected", async () => {
  const env = await makeEnv();
  const tampered = signed(
    problemNode(env.authorKey.publicKeyHex),
    env.authorKey.secretKeyHex,
  ) as Node<import("../src/core/types.ts").ProblemPayload>;
  tampered.payload.problem.title = "tampered title";
  await assertRejects(
    () => env.ingest.ingestNode(tampered),
    SignatureError,
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("invalid node shape is rejected", async () => {
  const env = await makeEnv();
  const bad = signed(
    problemNode(env.authorKey.publicKeyHex),
    env.authorKey.secretKeyHex,
  ) as Node<import("../src/core/types.ts").ProblemPayload>;
  bad.payload.problem.symptoms = [];
  await assertRejects(
    () => env.ingest.ingestNode(bad),
    ValidationError,
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("re-posting the same node returns the same cid", async () => {
  const env = await makeEnv();
  const problem = signed(
    problemNode(env.authorKey.publicKeyHex),
    env.authorKey.secretKeyHex,
  );
  const first = await env.ingest.ingestNode(problem);
  const second = await env.ingest.ingestNode(problem);
  assertEquals(first.cid, second.cid);
  assertEquals(second.effective_status, first.effective_status);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("re-posting the same receipt is idempotent", async () => {
  const env = await makeEnv();
  const receipt = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  const first = await env.ingest.ingestVerification(receipt);
  const second = await env.ingest.ingestVerification(receipt);
  assertEquals(first.cid, second.cid);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("concurrent duplicate posts are idempotent", async () => {
  const env = await makeEnv();
  const node = signed(
    problemNode(env.authorKey.publicKeyHex, { title: "concurrent" }),
    env.authorKey.secretKeyHex,
  );
  const cid = await cidOf(node);
  const results = await Promise.all([
    env.ingest.ingestNode(node),
    env.ingest.ingestNode(node),
  ]);
  assertEquals(results[0].cid, cid);
  assertEquals(results[1].cid, cid);

  const receipt = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
    ),
    env.verifierKey.secretKeyHex,
  );
  const receiptCid = await cidOf(receipt);
  const v = await Promise.all([
    env.ingest.ingestVerification(receipt),
    env.ingest.ingestVerification(receipt),
  ]);
  assertEquals(v[0].cid, receiptCid);
  assertEquals(v[1].cid, receiptCid);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("recipe with expired valid_until reads as stale", async () => {
  const env = await makeEnv();
  const receipt = signed(
    verificationNode(
      env.verifierKey.publicKeyHex,
      env.problemCid,
      env.recipeCid,
      "e".repeat(64),
      { valid_until: "2026-08-01T00:00:00Z" },
    ),
    env.verifierKey.secretKeyHex,
  );
  await env.ingest.ingestVerification(receipt);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(recipe?.effective_status, "stale");
  assertEquals(recipe?.confidence_score, 0.5);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("deprecation trigger matching the pinned version sets stale", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`, {
    versionPins: () => ({ deno: "3.0.0" }),
  });
  await index.init();
  const ingest = makeIngest(dir, index);
  const authorKey = generateKeyPair();
  const recipe = signed(
    recipeNode(authorKey.publicKeyHex, {
      deprecationTriggers: [{
        type: "runtime_change",
        scope: "deno",
        condition: ">=3",
        versioning_scheme: "semver",
      }],
    }),
    authorKey.secretKeyHex,
  );
  await ingest.ingestNode(recipe);
  const cid = await cidOf(recipe);
  const stored = await index.getNode(cid);
  assertEquals(stored?.effective_status, "stale");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("deprecation trigger below the pinned version stays draft", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`, {
    versionPins: () => ({ deno: "2.0.0" }),
  });
  await index.init();
  const ingest = makeIngest(dir, index);
  const authorKey = generateKeyPair();
  const recipe = signed(
    recipeNode(authorKey.publicKeyHex, {
      deprecationTriggers: [{
        type: "runtime_change",
        scope: "deno",
        condition: ">=3",
        versioning_scheme: "semver",
      }],
    }),
    authorKey.secretKeyHex,
  );
  await ingest.ingestNode(recipe);
  const cid = await cidOf(recipe);
  const stored = await index.getNode(cid);
  assertEquals(stored?.effective_status, "draft");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("deprecation trigger stays stale even with a passing receipt", async () => {
  const dir = tempDir();
  const authorKey = generateKeyPair();
  const verifierKey = generateKeyPair();
  const index = new SqliteNodeStore(`${dir}/index.db`, {
    versionPins: () => ({ deno: "3.0.0" }),
    trustedKeys: [verifierKey.publicKeyHex],
  });
  await index.init();
  const ingest = makeIngest(dir, index);
  const problem = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  await ingest.ingestNode(problem);
  const recipe = signed(
    recipeNode(authorKey.publicKeyHex, {
      deprecationTriggers: [{
        type: "runtime_change",
        scope: "deno",
        condition: ">=3",
        versioning_scheme: "semver",
      }],
    }),
    authorKey.secretKeyHex,
  );
  const recipeCid = await cidOf(recipe);
  await ingest.ingestNode(recipe);
  const receipt = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "f".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  await ingest.ingestVerification(receipt);
  const stored = await index.getNode(recipeCid);
  assertEquals(stored?.effective_status, "stale");
  assertEquals(stored?.confidence_score, 0.5);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("version chain: new version supersedes old, one head", async () => {
  const env = await makeEnv();
  const authorKey = env.authorKey;
  const original = await env.index.getNode(env.problemCid);
  const v2 = signed(
    problemNode(authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: env.problemCid,
    }),
    authorKey.secretKeyHex,
  );
  await env.ingest.ingestNode(v2);
  const v2Cid = await cidOf(v2);
  const v2Head = (await env.index.getNode(v2Cid))?.head;
  const v1Head = (await env.index.getNode(env.problemCid))?.head;
  assertEquals(v2Head, true);
  assertEquals(v1Head, false);
  const versions = await env.index.getVersions(v2.corpus.node_id);
  assertEquals(versions.length, 2);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("supersedes_cid targeting a missing node is rejected", async () => {
  const env = await makeEnv();
  const other = generateKeyPair();
  const ghost = await cidOf(
    signed(recipeNode(other.publicKeyHex), other.secretKeyHex),
  );
  const node = signed(
    problemNode(env.authorKey.publicKeyHex, { supersedesCid: ghost }),
    env.authorKey.secretKeyHex,
  );
  await assertRejects(
    () => env.ingest.ingestNode(node),
    InvalidNodeError,
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("supersedes_cid crossing node_id is rejected", async () => {
  const env = await makeEnv();
  const node = signed(
    problemNode(env.authorKey.publicKeyHex, { supersedesCid: env.recipeCid }),
    env.authorKey.secretKeyHex,
  );
  await assertRejects(
    () => env.ingest.ingestNode(node),
    InvalidNodeError,
  );
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("fork: two versions supersede the same head", async () => {
  const env = await makeEnv();
  const original = await env.index.getNode(env.problemCid);
  const a = signed(
    problemNode(env.authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: env.problemCid,
      title: "fork variant A",
    }),
    env.authorKey.secretKeyHex,
  );
  const b = signed(
    problemNode(env.authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: env.problemCid,
      title: "fork variant B",
    }),
    env.authorKey.secretKeyHex,
  );
  await env.ingest.ingestNode(a);
  await env.ingest.ingestNode(b);
  const heads = await env.index.getHeadVersion(original!.node_id);
  assertEquals(heads.length, 2);
  for (const h of heads) {
    assertEquals(h.head, true);
  }
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("cross-author supersession is quarantined, owner stays head", async () => {
  const env = await makeEnv();
  const original = await env.index.getNode(env.problemCid);
  const intruder = generateKeyPair();
  const hostile = signed(
    problemNode(intruder.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: env.problemCid,
      title: "hostile takeover attempt",
    }),
    intruder.secretKeyHex,
  );
  await env.ingest.ingestNode(hostile);
  const hostileCid = await cidOf(hostile);

  const ownerHead = await env.index.getHeadVersion(original!.node_id);
  const ownerNode = await env.index.getNode(env.problemCid);
  const hostileNode = await env.index.getNode(hostileCid);
  assertEquals(ownerHead.length, 1);
  assertEquals(ownerHead[0]!.cid, env.problemCid);
  assertEquals(ownerNode?.head, true);
  assertEquals(ownerNode?.effective_status, "active");
  assertEquals(hostileNode?.head, false);
  assertEquals(hostileNode?.effective_status, "disputed");
  const versions = await env.index.getVersions(original!.node_id);
  assertEquals(versions.length, 2);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("quarantine persists across later same-author supersessions", async () => {
  const env = await makeEnv();
  const original = await env.index.getNode(env.problemCid);
  const intruder = generateKeyPair();
  const hostile = signed(
    problemNode(intruder.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: env.problemCid,
      title: "hostile takeover attempt",
    }),
    intruder.secretKeyHex,
  );
  await env.ingest.ingestNode(hostile);
  const hostileCid = await cidOf(hostile);

  const v2 = signed(
    problemNode(env.authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: env.problemCid,
      title: "owner v2",
    }),
    env.authorKey.secretKeyHex,
  );
  await env.ingest.ingestNode(v2);
  const v2Cid = await cidOf(v2);

  const heads = await env.index.getHeadVersion(original!.node_id);
  const hostileNode = await env.index.getNode(hostileCid);
  assertEquals(heads.length, 1);
  assertEquals(heads[0]!.cid, v2Cid);
  assertEquals(heads[0]!.effective_status, "active");
  assertEquals(hostileNode?.head, false);
  assertEquals(hostileNode?.effective_status, "disputed");
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("index failure deletes the just-written block", async () => {
  const env = await makeEnv();
  const blocksDir = `${env.dir}/blocks`;
  const node = signed(
    problemNode(env.authorKey.publicKeyHex),
    env.authorKey.secretKeyHex,
  );
  const cid = await cidOf(node);
  await env.index.close();
  await assertRejects(() => env.ingest.ingestNode(node));
  await assertRejects(() => Deno.stat(`${blocksDir}/${cid}.json`));
  await Deno.remove(env.dir, { recursive: true }).catch(() => {});
});

Deno.test("search filters by node_type and severity", async () => {
  const env = await makeEnv();
  const problems = await env.index.search({
    filter: { node_type: "Problem" },
    limit: 10,
    offset: 0,
  });
  assertEquals(problems.total, 1);
  const high = await env.index.search({
    filter: { severity: "high" },
    limit: 10,
    offset: 0,
  });
  assertEquals(high.total, 1);
  const none = await env.index.search({
    filter: { severity: "low" },
    limit: 10,
    offset: 0,
  });
  assertEquals(none.total, 0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("search matches title case-insensitively", async () => {
  const env = await makeEnv();
  const indexed = await env.index.getNode(env.problemCid);
  assertEquals(indexed?.title, "Process crashes on large input");

  const exact = await env.index.search({
    filter: { title: "Process crashes" },
    limit: 10,
    offset: 0,
  });
  assertEquals(exact.total, 1);

  const lower = await env.index.search({
    filter: { title: "crashes on large" },
    limit: 10,
    offset: 0,
  });
  assertEquals(lower.total, 1);

  const missing = await env.index.search({
    filter: { title: "unrelated" },
    limit: 10,
    offset: 0,
  });
  assertEquals(missing.total, 0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("search title does not match recipes by node payload only", async () => {
  const env = await makeEnv();
  const recipes = await env.index.search({
    filter: { node_type: "Recipe" },
    limit: 10,
    offset: 0,
  });
  assertEquals(recipes.total, 1);
  const byTitle = await env.index.search({
    filter: { node_type: "Recipe", title: "Process crashes" },
    limit: 10,
    offset: 0,
  });
  assertEquals(byTitle.total, 0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("search filters by framework_name, language, and runtime_name", async () => {
  const env = await makeEnv();
  const byFramework = await env.index.search({
    filter: { framework_name: "deno" },
    limit: 10,
    offset: 0,
  });
  assertEquals(byFramework.total, 2);
  const byLanguage = await env.index.search({
    filter: { language: "typescript" },
    limit: 10,
    offset: 0,
  });
  assertEquals(byLanguage.total, 1);
  const byRuntime = await env.index.search({
    filter: { runtime_name: "deno" },
    limit: 10,
    offset: 0,
  });
  assertEquals(byRuntime.total, 1);
  const none = await env.index.search({
    filter: { language: "python", runtime_name: "deno" },
    limit: 10,
    offset: 0,
  });
  assertEquals(none.total, 0);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("search matches framework_name, language, and runtime_name case-insensitively", async () => {
  const env = await makeEnv();
  const framework = await env.index.search({
    filter: { framework_name: "DENO" },
    limit: 10,
    offset: 0,
  });
  assertEquals(framework.total, 2);
  const language = await env.index.search({
    filter: { language: "TypeScript" },
    limit: 10,
    offset: 0,
  });
  assertEquals(language.total, 1);
  const runtime = await env.index.search({
    filter: { runtime_name: "Deno" },
    limit: 10,
    offset: 0,
  });
  assertEquals(runtime.total, 1);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("indexed meta carries language and runtime_name", async () => {
  const env = await makeEnv();
  const problem = await env.index.getNode(env.problemCid);
  assertEquals(problem?.severity, "high");
  assertEquals(problem?.framework_name, "deno");
  assertEquals(problem?.runtime_name, "deno");
  assertEquals(problem?.language, null);
  const recipe = await env.index.getNode(env.recipeCid);
  assertEquals(recipe?.language, "typescript");
  assertEquals(recipe?.framework_name, "deno");
  assertEquals(recipe?.runtime_name, null);
  assertEquals(recipe?.severity, null);
  await Deno.remove(env.dir, { recursive: true });
});

Deno.test("v1 database migrates to v2 and indexes titles", async () => {
  const dir = tempDir();
  const dbPath = `${dir}/index.db`;
  await Deno.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE nodes (
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
    CREATE TABLE verifications (
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
    CREATE TABLE deprecation_triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_cid TEXT NOT NULL,
      scope TEXT NOT NULL,
      versioning_scheme TEXT NOT NULL,
      condition TEXT NOT NULL
    );
    PRAGMA user_version = 1;
  `);
  db.close();

  const store = new SqliteNodeStore(dbPath);
  await store.init();
  const authorKey = generateKeyPair();
  const node = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const cid = await cidOf(node);
  await store.indexNode(node, cid, new Date().toISOString());
  const indexed = await store.getNode(cid);
  assertEquals(indexed?.title, "Process crashes on large input");
  await store.close();
  await Deno.remove(dir, { recursive: true });
});
