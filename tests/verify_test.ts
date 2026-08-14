import { assertEquals, assertRejects } from "@std/assert";
import { SqliteQueryIndex } from "../src/storage/index.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { IngestService, ValidationError, ReplayUnavailableError } from "../src/storage/ingest.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import { PlaygroundRegistry } from "../src/verify/registry.ts";
import { StubReplayExecutor, type ReplayExecutor, type ReplayResult } from "../src/verify/replay.ts";
import { computeEffectiveStatus, computeConfidence } from "../src/storage/status.ts";
import type { IndexedVerification } from "../src/storage/types.ts";
import {
  problemNode,
  recipeNode,
  verificationNode,
  signed,
  cidOf,
} from "./fixtures.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-verify-${crypto.randomUUID()}`;
}

async function env() {
  const dir = tempDir();
  const index = new SqliteQueryIndex(`${dir}/index.db`);
  index.init();
  const ingest = new IngestService(new FileBlockstore({ dir: `${dir}/blocks` }), index);
  const authorKey = generateKeyPair();
  const verifierKey = generateKeyPair();

  const problem = signed(problemNode(authorKey.publicKeyHex), authorKey.secretKeyHex);
  const problemCid = await cidOf(problem);
  await ingest.ingestNode(problem);

  const recipe = signed(recipeNode(authorKey.publicKeyHex), authorKey.secretKeyHex);
  const recipeCid = await cidOf(recipe);
  await ingest.ingestNode(recipe);

  return { dir, index, ingest, authorKey, verifierKey, problemCid, recipeCid };
}

Deno.test("fork: two heads become disputed", async () => {
  const e = await env();
  const original = await e.index.getNode(e.problemCid);

  const a = signed(
    problemNode(e.authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: e.problemCid,
      title: "fork variant A",
    }),
    e.authorKey.secretKeyHex,
  );
  const b = signed(
    problemNode(e.authorKey.publicKeyHex, {
      nodeId: original!.node_id,
      supersedesCid: e.problemCid,
      title: "fork variant B",
    }),
    e.authorKey.secretKeyHex,
  );
  await e.ingest.ingestNode(a);
  await e.ingest.ingestNode(b);

  const heads = await e.index.getHeadVersion(original!.node_id);
  assertEquals(heads.length, 2);
  for (const h of heads) {
    assertEquals(h.effective_status, "disputed");
  }
  await Deno.remove(e.dir, { recursive: true });
});

Deno.test("registry rejects unregistered environment hash", async () => {
  const e = await env();
  const registry = new PlaygroundRegistry([{
    environment_hash: "d".repeat(64),
    playground: "sandbox-den",
    platform: "linux",
    version: "1.0",
    config_hash: "cfg-1",
  }]);
  const strict = new IngestService(
    new FileBlockstore({ dir: `${e.dir}/strict-blocks` }),
    e.index,
    registry,
  );
  const receipt = signed(
    verificationNode(e.verifierKey.publicKeyHex, e.problemCid, e.recipeCid, "e".repeat(64)),
    e.verifierKey.secretKeyHex,
  );
  await assertRejects(
    () => strict.ingestVerification(receipt),
    ValidationError,
  );
  await Deno.remove(e.dir, { recursive: true });
});

Deno.test("registry accepts registered environment hash", async () => {
  const e = await env();
  const registry = new PlaygroundRegistry([{
    environment_hash: "d".repeat(64),
    playground: "sandbox-den",
    platform: "linux",
    version: "1.0",
    config_hash: "cfg-1",
  }]);
  const strict = new IngestService(
    new FileBlockstore({ dir: `${e.dir}/strict-blocks` }),
    e.index,
    registry,
  );
  const receipt = signed(
    verificationNode(e.verifierKey.publicKeyHex, e.problemCid, e.recipeCid, "d".repeat(64)),
    e.verifierKey.secretKeyHex,
  );
  const result = await strict.ingestVerification(receipt);
  assertEquals(typeof result.cid, "string");
  const recipe = await e.index.getNode(e.recipeCid);
  assertEquals(recipe?.confidence_score, 0.5);
  await Deno.remove(e.dir, { recursive: true });
});

Deno.test("stub replay executor returns pass", async () => {
  const executor = new StubReplayExecutor();
  const key = generateKeyPair();
  const problem = signed(problemNode(key.publicKeyHex), key.secretKeyHex);
  const recipe = signed(recipeNode(key.publicKeyHex), key.secretKeyHex);
  const result = await executor.replay(recipe, problem, {
    environment_hash: "d".repeat(64),
    playground: "sandbox-den",
    platform: "linux",
    version: "1.0",
    config_hash: "cfg-1",
  });
  assertEquals(result.outcome, "pass");
  assertEquals(result.failed, 0);
});

class FakeReplay implements ReplayExecutor {
  readonly enforced = true;

  constructor(private result: () => ReplayResult) {}

  async replay(): Promise<ReplayResult> {
    return await this.result();
  }
}

function strictIngest(e: Awaited<ReturnType<typeof env>>, fake: FakeReplay): IngestService {
  const registry = new PlaygroundRegistry([{
    environment_hash: "f".repeat(64),
    playground: "sandbox-den",
    platform: "linux",
    version: "1.0",
    config_hash: "cfg-1",
  }]);
  return new IngestService(
    new FileBlockstore({ dir: `${e.dir}/strict-blocks` }),
    e.index,
    registry,
    fake,
  );
}

const passingResult = (): ReplayResult => ({
  outcome: "pass",
  total: 2,
  passed: 2,
  failed: 0,
  log: "ok",
  cases: [
    { name: "small", result: "pass" },
    { name: "large", result: "pass" },
  ],
});

Deno.test("enforced replay matching the claim accepts the receipt", async () => {
  const e = await env();
  const ingest = strictIngest(e, new FakeReplay(passingResult));
  const receipt = signed(
    verificationNode(e.verifierKey.publicKeyHex, e.problemCid, e.recipeCid, "f".repeat(64)),
    e.verifierKey.secretKeyHex,
  );
  const result = await ingest.ingestVerification(receipt);
  assertEquals(typeof result.cid, "string");
  const recipe = await e.index.getNode(e.recipeCid);
  assertEquals(recipe?.confidence_score, 0.5);
  await Deno.remove(e.dir, { recursive: true });
});

Deno.test("enforced replay with mismatched counts rejects the receipt", async () => {
  const e = await env();
  const ingest = strictIngest(e, new FakeReplay(() => ({
    outcome: "pass",
    total: 2,
    passed: 1,
    failed: 1,
    log: "mismatch",
    cases: passingResult().cases,
  })));
  const receipt = signed(
    verificationNode(e.verifierKey.publicKeyHex, e.problemCid, e.recipeCid, "f".repeat(64)),
    e.verifierKey.secretKeyHex,
  );
  await assertRejects(
    () => ingest.ingestVerification(receipt),
    ValidationError,
  );
  await Deno.remove(e.dir, { recursive: true });
});

Deno.test("enforced replay with mismatched cases rejects the receipt", async () => {
  const e = await env();
  const ingest = strictIngest(e, new FakeReplay(() => ({
    outcome: "pass",
    total: 2,
    passed: 2,
    failed: 0,
    log: "case mismatch",
    cases: [{ name: "small", result: "fail" }, { name: "large", result: "pass" }],
  })));
  const receipt = signed(
    verificationNode(e.verifierKey.publicKeyHex, e.problemCid, e.recipeCid, "f".repeat(64)),
    e.verifierKey.secretKeyHex,
  );
  await assertRejects(
    () => ingest.ingestVerification(receipt),
    ValidationError,
  );
  await Deno.remove(e.dir, { recursive: true });
});

Deno.test("enforced replay that throws surfaces 503 (ReplayUnavailableError)", async () => {
  const e = await env();
  const ingest = strictIngest(e, new FakeReplay(() => {
    throw new Error("sandbox down");
  }));
  const receipt = signed(
    verificationNode(e.verifierKey.publicKeyHex, e.problemCid, e.recipeCid, "f".repeat(64)),
    e.verifierKey.secretKeyHex,
  );
  await assertRejects(
    () => ingest.ingestVerification(receipt),
    ReplayUnavailableError,
  );
  await Deno.remove(e.dir, { recursive: true });
});

function receipt(overrides: Partial<IndexedVerification>): IndexedVerification {
  return {
    receipt_cid: "cid",
    problem_cid: "p",
    solution_cid: "s",
    environment_hash: "e".repeat(64),
    public_key: "k",
    timestamp: "2026-08-14T00:00:00Z",
    valid_until: null,
    total: 2,
    passed: 2,
    failed: 0,
    ...overrides,
  };
}

Deno.test("confidence: no receipts 0.0, one source 0.5, two sources 0.75", () => {
  assertEquals(computeConfidence([]), 0.0);
  assertEquals(computeConfidence([receipt({})]), 0.5);
  const independent = computeConfidence([
    receipt({ environment_hash: "e".repeat(64) }),
    receipt({ environment_hash: "f".repeat(64), public_key: "k2" }),
  ]);
  assertEquals(independent, 0.75);
  assertEquals(computeConfidence([receipt({ failed: 1 })]), 0.0);
});

Deno.test("confidence: same key different env counts one source", () => {
  const score = computeConfidence([
    receipt({ environment_hash: "e".repeat(64) }),
    receipt({ environment_hash: "f".repeat(64) }),
  ]);
  assertEquals(score, 0.5);
});

Deno.test("confidence: same env different keys counts one source", () => {
  const score = computeConfidence([
    receipt({ public_key: "k" }),
    receipt({ public_key: "k2" }),
  ]);
  assertEquals(score, 0.5);
});

Deno.test("confidence: chain of shared envs and keys counts one source", () => {
  const score = computeConfidence([
    receipt({ public_key: "k1", environment_hash: "e".repeat(64) }),
    receipt({ public_key: "k2", environment_hash: "e".repeat(64) }),
    receipt({ public_key: "k2", environment_hash: "f".repeat(64) }),
    receipt({ public_key: "k3", environment_hash: "f".repeat(64) }),
  ]);
  assertEquals(score, 0.5);
});

Deno.test("effective_status: valid_until expiry makes recipe stale", () => {
  const key = generateKeyPair();
  const recipe = signed(recipeNode(key.publicKeyHex), key.secretKeyHex);
  const stale = computeEffectiveStatus(recipe, {
    latestReceipt: receipt({ valid_until: "2026-08-01T00:00:00Z" }),
    triggerFired: false,
    now: "2026-08-14T00:00:00Z",
  });
  assertEquals(stale, "stale");
  const stillActive = computeEffectiveStatus(recipe, {
    latestReceipt: receipt({ valid_until: "2026-09-01T00:00:00Z" }),
    triggerFired: false,
    now: "2026-08-14T00:00:00Z",
  });
  assertEquals(stillActive, "active");
});

Deno.test("effective_status: failed receipt makes recipe disputed", () => {
  const key = generateKeyPair();
  const recipe = signed(recipeNode(key.publicKeyHex), key.secretKeyHex);
  const disputed = computeEffectiveStatus(recipe, {
    latestReceipt: receipt({ failed: 2 }),
    triggerFired: false,
    now: "2026-08-14T00:00:00Z",
  });
  assertEquals(disputed, "disputed");
});
