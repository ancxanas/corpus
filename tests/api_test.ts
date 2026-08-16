import { assert, assertEquals } from "@std/assert";
import { SqliteNodeStore } from "../src/storage/node_store.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { IngestService } from "../src/storage/ingest.ts";
import { PlaygroundRegistry } from "../src/execution/registry.ts";
import { TrustedStubReplayExecutor } from "../src/execution/replay.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import { createApp } from "../src/api/server.ts";
import type { Node, ProblemPayload } from "../src/core/types.ts";
import {
  cidOf,
  guideNode,
  problemNode,
  recipeNode,
  signed,
  verificationNode,
} from "./fixtures.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-api-${crypto.randomUUID()}`;
}

async function webDirWith(): Promise<string> {
  const dir = tempDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/index.html`, "<h1>The Corpus</h1>");
  await Deno.writeTextFile(`${dir}/app.js`, "console.log('ui');");
  return dir;
}

async function makeServer() {
  const dir = tempDir();
  const authorKey = generateKeyPair();
  const verifierKey = generateKeyPair();
  const index = new SqliteNodeStore(`${dir}/index.db`, {
    trustedKeys: [verifierKey.publicKeyHex],
  });
  await index.init();
  const registry = new PlaygroundRegistry(
    ["a", "b", "d", "e"].map((letter) => ({
      environment_hash: letter.repeat(64),
      playground: "sandbox-den",
      platform: "linux",
      version: "1.0",
      config_hash: `cfg-${letter}`,
    })),
  );
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
    registry,
    new TrustedStubReplayExecutor(),
  );

  const recipe = signed(
    recipeNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const recipeCid = await cidOf(recipe);
  await ingest.ingestNode(recipe);

  const problem = signed(
    problemNode(authorKey.publicKeyHex, { solutionCids: [recipeCid] }),
    authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  await ingest.ingestNode(problem);

  const receipt = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "a".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  await ingest.ingestVerification(receipt);

  const handler = createApp(ingest, index, {
    logger: () => {},
    registry,
  });
  return {
    handler,
    index,
    ingest,
    authorKey,
    verifierKey,
    problemCid,
    recipeCid,
    dir,
  };
}

async function req(
  handler: (request: Request) => Promise<Response>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return await handler(new Request(`http://127.0.0.1${path}`, init));
}

function postNode(
  type: string,
  node: unknown,
): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({ data: { type, attributes: node } }),
  };
}

Deno.test("entry point lists API links", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.jsonapi.version, "1.0");
  assertEquals(body.links.problems, "http://127.0.0.1/problems");
  assertEquals(body.links.submit, "http://127.0.0.1/nodes");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/{cid} returns resource with relationships", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${recipeCid}`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.type, "recipes");
  assertEquals(body.data.id, recipeCid);
  assertEquals(body.data.attributes.osk.node_type, "Recipe");
  assertEquals(body.data.meta.effective_status, "active");
  assertEquals(body.data.links.self, `http://127.0.0.1/nodes/${recipeCid}`);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("collection include returns linked resources", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, "/problems?include=solutions");
  const body = await res.json();
  assertEquals(res.status, 200);
  const ids = (body.included ?? []).map((i: { id: string }) => i.id);
  assert(ids.includes(recipeCid), "included must contain the linked recipe");
  assertEquals(body.data[0].relationships.solutions.data[0].id, recipeCid);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("single node include=solutions returns the linked recipe", async () => {
  const { handler, problemCid, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${problemCid}?include=solutions`);
  const body = await res.json();
  assertEquals(res.status, 200);
  const ids = (body.included ?? []).map((i: { id: string }) => i.id);
  assert(ids.includes(recipeCid), "included must contain the linked recipe");
  assertEquals(body.data.relationships.solutions.data[0].id, recipeCid);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("recipe problems relationship resolves linked problems", async () => {
  const { handler, problemCid, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${recipeCid}/problems`);
  const body = await res.json();
  assertEquals(res.status, 200);
  const ids = (body.data ?? []).map((r: { id: string }) => r.id);
  assert(ids.includes(problemCid), "reverse lookup must find the problem");
  const type = (body.data ?? []).find((r: { id: string }) =>
    r.id === problemCid
  );
  assertEquals(type.type, "problems");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("recipe problems relationship is empty without links", async () => {
  const { handler, ingest, authorKey, dir } = await makeServer();
  const unlinked = signed(
    recipeNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const unlinkedCid = await cidOf(unlinked);
  await ingest.ingestNode(unlinked);
  const res = await req(handler, `/nodes/${unlinkedCid}/problems`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("collection include rejects an unsupported path with 400", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/problems?include=not_a_relationship");
  const body = await res.json();
  assertEquals(res.status, 400);
  assertEquals(body.errors[0].status, "400");
  assertEquals(body.errors[0].title, "unsupported include");
  assertEquals(body.errors[0].source.parameter, "include");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("single node include stays permissive for unknown paths", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${recipeCid}?include=relationships`);
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(body.included === undefined || body.included.length === 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/{cid} include=relationships embeds linked resources", async () => {
  const { handler, problemCid, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${problemCid}?include=solutions`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.relationships.solutions.data.length, 1);
  assertEquals(body.data.relationships.solutions.data[0].id, recipeCid);
  assertEquals(body.included.length, 1);
  assertEquals(body.included[0].id, recipeCid);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes stores a signed node and returns meta.cid", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const node = problemNode(authorKey.publicKeyHex, {
    title: "API posted problem",
  });
  const res = await req(
    handler,
    "/nodes",
    postNode("problems", signed(node, authorKey.secretKeyHex)),
  );
  const body = await res.json();
  assertEquals(res.status, 201);
  assertEquals(typeof body.meta.cid, "string");
  assertEquals(body.data.type, "problems");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /verifications returns a resource document", async () => {
  const { handler, verifierKey, problemCid, recipeCid, dir } =
    await makeServer();
  const receipt = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "d".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  const res = await req(
    handler,
    "/verifications",
    postNode(
      "verifications",
      receipt,
    ),
  );
  const body = await res.json();
  assertEquals(res.status, 201);
  assert(body.data, "data must not be null");
  assertEquals(body.data.type, "verifications");
  assertEquals(body.data.id, body.meta.cid);
  assertEquals(
    body.data.links.self,
    `http://127.0.0.1/verifications/${body.meta.cid}`,
  );
  assertEquals(
    body.data.attributes.target.solution_id["/"],
    recipeCid,
  );
  assertEquals(body.data.attributes.test_suite.passed, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes rejects mismatched data.type", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const node = problemNode(authorKey.publicKeyHex);
  const res = await req(
    handler,
    "/nodes",
    postNode("recipes", signed(node, authorKey.secretKeyHex)),
  );
  assertEquals(res.status, 422);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes rejects Verification nodes with 422", async () => {
  const { handler, verifierKey, problemCid, recipeCid, dir } =
    await makeServer();
  const node = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "a".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  const res = await req(handler, "/nodes", postNode("verifications", node));
  const body = await res.json();
  assertEquals(res.status, 422);
  assertEquals(body.errors[0].title, "wrong endpoint");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes rejects bad signature with 422", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const other = generateKeyPair();
  const node = signed(problemNode(other.publicKeyHex), authorKey.secretKeyHex);
  const res = await req(handler, "/nodes", postNode("problems", node));
  const body = await res.json();
  assertEquals(res.status, 422);
  assertEquals(body.errors[0].title, "invalid signature");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /verifications returns meta with solution_cid", async () => {
  const { handler, verifierKey, problemCid, recipeCid, dir } =
    await makeServer();
  const receipt = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "b".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  const res = await req(
    handler,
    "/verifications",
    postNode("verifications", receipt),
  );
  const body = await res.json();
  assertEquals(res.status, 201);
  assertEquals(body.meta.solution_cid, recipeCid);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes?filter[node_type]=recipes returns only recipes", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes?filter[node_type]=recipes");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  assertEquals(body.data[0].type, "recipes");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes?filter[title] searches case-insensitively", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(
    handler,
    "/nodes?filter[title]=process%20crashes",
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  assertEquals(body.data[0].type, "problems");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes?search matches body text across types", async () => {
  const { handler, problemCid, recipeCid, dir } = await makeServer();
  const res = await req(handler, "/nodes?search=recursion");
  const body = await res.json();
  assertEquals(res.status, 200);
  const ids = (body.data as { id: string }[]).map((r) => r.id);
  assert(ids.includes(problemCid), "problem body must be searchable");
  assert(ids.includes(recipeCid), "recipe body must be searchable");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("collection search= filters by node_type", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, "/recipes?search=explicit%20stack");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  assertEquals(body.data[0].id, recipeCid);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes?filter[tag] returns tagged nodes only", async () => {
  const { handler, ingest, authorKey, problemCid, dir } = await makeServer();
  const tagged = recipeNode(authorKey.publicKeyHex) as
    & ReturnType<
      typeof recipeNode
    >
    & { payload: { recipe: { tags?: string[] } } };
  tagged.payload.recipe.tags = ["json"];
  const taggedSigned = signed(tagged, authorKey.secretKeyHex);
  const taggedCid = await cidOf(taggedSigned);
  await ingest.ingestNode(taggedSigned);

  const res = await req(handler, "/nodes?filter[tag]=json");
  const body = await res.json();
  assertEquals(res.status, 200);
  const ids = (body.data as { id: string }[]).map((r) => r.id);
  assert(ids.includes(taggedCid), "tagged node must match");
  assert(!ids.includes(problemCid), "untagged node must not match");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /llms.txt documents the query surface", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/llms.txt");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
  const text = await res.text();
  assert(text.includes("search="), "llms.txt must document keyword search");
  assert(text.includes("filter[tag]"), "llms.txt must document tag filter");
  assert(text.includes("/openapi.json"), "llms.txt must link the OpenAPI doc");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/{cid}/verifications returns receipts", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${recipeCid}/verifications`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  assertEquals(body.data[0].type, "verifications");
  assertEquals(typeof body.data[0].id, "string");
  assertEquals(body.data[0].attributes.test_suite.passed, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/{cid}/verifications 404s for unknown node", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, `/nodes/${"b".repeat(61)}/verifications`);
  assertEquals(res.status, 404);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/{cid}/verifications is read-only", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${recipeCid}/verifications`, {
    method: "DELETE",
  });
  assertEquals(res.status, 405);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /verifications lists receipts newest first", async () => {
  const { handler, verifierKey, problemCid, recipeCid, dir } =
    await makeServer();
  const newer = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "e".repeat(64),
      { timestamp: "2026-08-15T00:00:00Z" },
    ),
    verifierKey.secretKeyHex,
  );
  const created = await req(
    handler,
    "/verifications",
    postNode("verifications", newer),
  );
  const newerCid = (await created.json()).meta.cid;

  const res = await req(handler, "/verifications");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 2);
  assertEquals(body.data.length, 2);
  assertEquals(body.data[0].id, newerCid);
  assertEquals(body.data[0].attributes.timestamp, "2026-08-15T00:00:00Z");

  const paged = await req(handler, "/verifications?page[limit]=1");
  const pagedBody = await paged.json();
  assertEquals(pagedBody.meta.total, 2);
  assertEquals(pagedBody.data.length, 1);
  assertEquals(pagedBody.data[0].id, newerCid);
  assertEquals(typeof pagedBody.links.next, "string");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /verifications/{cid} returns a single receipt", async () => {
  const { handler, verifierKey, problemCid, recipeCid, dir } =
    await makeServer();
  const newer = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "e".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  const created = await req(
    handler,
    "/verifications",
    postNode("verifications", newer),
  );
  const cid = (await created.json()).meta.cid;

  const res = await req(handler, `/verifications/${cid}`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.type, "verifications");
  assertEquals(body.data.id, cid);
  assertEquals(body.data.links.self, `http://127.0.0.1/verifications/${cid}`);

  const nodeRes = await req(handler, `/nodes/${cid}`);
  assertEquals(nodeRes.status, 404);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /verifications/{cid} 404s for an unknown cid", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, `/verifications/${"b".repeat(61)}`);
  assertEquals(res.status, 404);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /verifications is read-only", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/verifications", { method: "DELETE" });
  assertEquals(res.status, 405);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/by-node-id returns head and versions relationship", async () => {
  const { handler, index, authorKey, dir } = await makeServer();
  const node = problemNode(authorKey.publicKeyHex, { title: "v1" });
  const signed1 = signed(node, authorKey.secretKeyHex);
  const cid1 = await cidOf(signed1);
  await index.indexNode(signed1, cid1, new Date().toISOString());

  const v2 = signed(
    problemNode(authorKey.publicKeyHex, {
      nodeId: node.osk.node_id,
      supersedesCid: cid1,
      title: "v2",
    }),
    authorKey.secretKeyHex,
  );
  const cid2 = await cidOf(v2);
  await index.indexNode(v2, cid2, new Date().toISOString());

  const res = await req(handler, `/nodes/by-node-id/${node.osk.node_id}`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.id, cid2);
  assertEquals(body.data.relationships.versions.data.length, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes/by-node-id returns 409 on fork", async () => {
  const { handler, index, authorKey, dir } = await makeServer();
  const node = problemNode(authorKey.publicKeyHex, { title: "fork root" });
  const signed1 = signed(node, authorKey.secretKeyHex);
  const cid1 = await cidOf(signed1);
  await index.indexNode(signed1, cid1, new Date().toISOString());

  const a = signed(
    problemNode(authorKey.publicKeyHex, {
      nodeId: node.osk.node_id,
      supersedesCid: cid1,
      title: "fork variant A",
    }),
    authorKey.secretKeyHex,
  );
  const b = signed(
    problemNode(authorKey.publicKeyHex, {
      nodeId: node.osk.node_id,
      supersedesCid: cid1,
      title: "fork variant B",
    }),
    authorKey.secretKeyHex,
  );
  await index.indexNode(a, await cidOf(a), new Date().toISOString());
  await index.indexNode(b, await cidOf(b), new Date().toISOString());

  const res = await req(handler, `/nodes/by-node-id/${node.osk.node_id}`);
  const body = await res.json();
  assertEquals(res.status, 409);
  assertEquals(body.errors.length, 3);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /schemas/{node_type} returns the JSON Schema", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/schemas/recipes");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.id, "recipes");
  assertEquals(
    body.data.attributes.properties.osk.allOf[1].properties.node_type.const,
    "Recipe",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /schemas/guides returns the Guide JSON Schema", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/schemas/guides");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.id, "guides");
  assertEquals(
    body.data.attributes.properties.osk.allOf[1].properties.node_type.const,
    "Guide",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes stores a signed guide", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const node = signed(
    guideNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const res = await req(handler, "/nodes", postNode("guides", node));
  const body = await res.json();
  assertEquals(res.status, 201);
  assertEquals(body.data.type, "guides");
  assertEquals(typeof body.meta.cid, "string");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /nodes?filter[node_type]=guides returns guides", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const node = signed(
    guideNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  await req(handler, "/nodes", postNode("guides", node));
  const res = await req(handler, "/nodes?filter[node_type]=guides");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  assertEquals(body.data[0].type, "guides");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("unknown route returns 404 JSON:API error", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nope");
  assertEquals(res.status, 404);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /recipes returns only recipes", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/recipes");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  assertEquals(body.data[0].type, "recipes");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /guides returns an empty collection", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/guides");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 0);
  assertEquals(body.data.length, 0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("wrong method on a read route returns 405", async () => {
  const { handler, recipeCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${recipeCid}`, { method: "DELETE" });
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("allow"), "GET");
  const collection = await req(handler, "/problems", { method: "POST" });
  assertEquals(collection.status, 405);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("negative page limit is clamped", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes?page[limit]=-5&page[offset]=-3");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.data.length, 1);
  const clamped = await req(handler, "/nodes?page[limit]=2000");
  const clampedBody = await clamped.json();
  assertEquals(clampedBody.data.length, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes without the JSON:API content type returns 415", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const node = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const res = await req(handler, "/nodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { type: "problems", attributes: node } }),
  });
  assertEquals(res.status, 415);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET / with an unsupported Accept header returns 406", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/", { headers: { Accept: "text/html" } });
  assertEquals(res.status, 406);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes over the body limit returns 413", async () => {
  const { index, ingest, authorKey, dir } = await makeServer();
  const small = createApp(ingest, index, { bodyLimit: 64 });
  const node = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const res = await req(small, "/nodes", postNode("problems", node));
  assertEquals(res.status, 413);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("OPTIONS preflight succeeds for an allowed origin", async () => {
  const { ingest, index, dir } = await makeServer();
  const cors = createApp(ingest, index, {
    corsOrigins: ["https://app.example"],
    logger: () => {},
  });
  const res = await req(cors, "/nodes", {
    method: "OPTIONS",
    headers: {
      Origin: "https://app.example",
      "Access-Control-Request-Method": "POST",
    },
  });
  assertEquals(res.status, 204);
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  assertEquals(
    res.headers.get("access-control-allow-methods"),
    "GET, POST, HEAD, OPTIONS",
  );
  assertEquals(
    res.headers.get("access-control-allow-headers"),
    "Content-Type, Accept",
  );
  assertEquals(res.headers.get("access-control-max-age"), "600");
  assertEquals(await res.text(), "");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("OPTIONS preflight from a disallowed origin gets no CORS headers", async () => {
  const { ingest, index, dir } = await makeServer();
  const cors = createApp(ingest, index, {
    corsOrigins: ["https://app.example"],
    logger: () => {},
  });
  const res = await req(cors, "/nodes", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example" },
  });
  assertEquals(res.headers.get("access-control-allow-origin"), null);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET from an allowed origin echoes Access-Control-Allow-Origin", async () => {
  const { ingest, index, dir } = await makeServer();
  const cors = createApp(ingest, index, {
    corsOrigins: ["https://app.example"],
    logger: () => {},
  });
  const res = await req(cors, "/", {
    headers: { Origin: "https://app.example" },
  });
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://app.example",
  );
  assertEquals(res.headers.get("vary"), "Origin");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET from a disallowed origin gets no CORS headers", async () => {
  const { ingest, index, dir } = await makeServer();
  const cors = createApp(ingest, index, {
    corsOrigins: ["https://app.example"],
    logger: () => {},
  });
  const res = await req(cors, "/", {
    headers: { Origin: "https://evil.example" },
  });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("wildcard CORS echoes any origin", async () => {
  const { ingest, index, dir } = await makeServer();
  const cors = createApp(ingest, index, {
    corsOrigins: ["*"],
    logger: () => {},
  });
  const res = await req(cors, "/", {
    headers: { Origin: "https://any.example" },
  });
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://any.example",
  );
  const preflight = await req(cors, "/nodes", {
    method: "OPTIONS",
    headers: { Origin: "https://any.example" },
  });
  assertEquals(preflight.status, 204);
  assertEquals(
    preflight.headers.get("access-control-allow-origin"),
    "https://any.example",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("no CORS config leaves responses unchanged", async () => {
  const { ingest, index, dir } = await makeServer();
  const plain = createApp(ingest, index, { logger: () => {} });
  const res = await req(plain, "/", {
    headers: { Origin: "https://app.example" },
  });
  assertEquals(res.headers.get("access-control-allow-origin"), null);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("HEAD / returns headers without a body", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/", { method: "HEAD" });
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "");
  assertEquals(res.headers.get("content-type"), "application/vnd.api+json");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("by-node-id rejects extra path segments with 404", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes/by-node-id/some-id/versions/extra");
  assertEquals(res.status, 404);
  const bare = await req(handler, "/nodes/by-node-id");
  assertEquals(bare.status, 404);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("responses carry X-Request-Id and the logger sees one line", async () => {
  const { ingest, index, dir } = await makeServer();
  const lines: string[] = [];
  const logged = createApp(ingest, index, {
    logger: (line) => lines.push(line),
  });
  const res = await req(logged, "/nodes");
  const requestId = res.headers.get("x-request-id");
  assertEquals(requestId === null, false);
  assertEquals(lines.length, 1);
  assertEquals(lines[0]!.includes("GET /nodes 200"), true);
  assertEquals(lines[0]!.endsWith(requestId!), true);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("baseUrl option overrides self links", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
  );
  const handler = createApp(ingest, index, {
    baseUrl: "https://corpus.example",
    logger: () => {},
  });
  try {
    const res = await req(handler, "/");
    const body = await res.json();
    assertEquals(body.links.self, "https://corpus.example");
    assertEquals(body.links.problems, "https://corpus.example/problems");
  } finally {
    await index.close();
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("trusted proxy headers set the base URL everywhere", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
  );
  const key = generateKeyPair();
  const recipe = signed(recipeNode(key.publicKeyHex), key.secretKeyHex);
  await ingest.ingestNode(recipe);
  const handler = createApp(ingest, index, {
    trustProxy: true,
    logger: () => {},
  });
  const forwarded = {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "corpus.example",
    },
  };
  try {
    const root = await (await req(handler, "/", forwarded)).json();
    assertEquals(root.links.self, "https://corpus.example");
    assertEquals(root.links.openapi, "https://corpus.example/openapi.json");
    assertEquals(root.meta.docs.llms, "https://corpus.example/llms.txt");

    const doc = await (await req(handler, "/openapi.json", forwarded)).json();
    assertEquals(doc.servers, [{ url: "https://corpus.example" }]);

    const llms = await (await req(handler, "/llms.txt", forwarded)).text();
    assertEquals(llms.includes("https://corpus.example/openapi.json"), true);

    const nodes = await (await req(handler, "/nodes", forwarded)).json();
    assertEquals(nodes.links.self, "https://corpus.example");
    assertEquals(
      nodes.links.first.startsWith("https://corpus.example/nodes"),
      true,
    );
    assertEquals(
      nodes.data[0].links.self,
      `https://corpus.example/nodes/${nodes.data[0].id}`,
    );
  } finally {
    await index.close();
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("forwarded headers are ignored by default", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
  );
  const handler = createApp(ingest, index, { logger: () => {} });
  const forwarded = {
    headers: {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "corpus.example",
    },
  };
  try {
    const root = await (await req(handler, "/", forwarded)).json();
    assertEquals(root.links.self, "http://127.0.0.1");
    assertEquals(root.links.openapi, "http://127.0.0.1/openapi.json");
  } finally {
    await index.close();
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("baseUrl option wins over forwarded headers", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
  );
  const handler = createApp(ingest, index, {
    baseUrl: "https://corpus.example",
    trustProxy: true,
    logger: () => {},
  });
  try {
    const root = await (await req(handler, "/", {
      headers: {
        "x-forwarded-proto": "http",
        "x-forwarded-host": "evil.example",
      },
    })).json();
    assertEquals(root.links.self, "https://corpus.example");
  } finally {
    await index.close();
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /nodes rejects a non-CID link with 422", async () => {
  const { handler, authorKey, dir } = await makeServer();
  const node = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  ) as Node<ProblemPayload>;
  const tampered = {
    ...node,
    payload: {
      problem: {
        ...node.payload.problem,
        solutions: [{ node: { "/": "not-a-cid" } }],
      },
    },
  };
  const res = await req(handler, "/nodes", postNode("problems", tampered));
  const body = await res.json();
  assertEquals(res.status, 422);
  assertEquals(body.errors[0].source.pointer.includes("solutions"), true);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("unknown include path yields no included array", async () => {
  const { handler, problemCid, dir } = await makeServer();
  const res = await req(handler, `/nodes/${problemCid}?include=bogus`);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.included, undefined);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("bad sort falls back to created_at", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes?sort=total_bogus");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 2);
  assertEquals(body.data.length, 2);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("unknown filter fields are rejected", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(
    handler,
    "/nodes?filter[bogus_field]=x&filter[node_type]=problems",
  );
  const body = await res.json();
  assertEquals(res.status, 400);
  assertEquals(body.errors[0].title, "invalid filter");
  assertEquals(body.errors[0].source.parameter, "filter[bogus_field]");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("invalid filter node_type value is rejected", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes?filter[node_type]=nonsense");
  const body = await res.json();
  assertEquals(res.status, 400);
  assertEquals(body.errors[0].source.parameter, "filter[node_type]");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("pagination offset past the total clamps to the last page", async () => {
  const { handler, dir } = await makeServer();
  const atTotal = await req(handler, "/nodes?page[limit]=25&page[offset]=2");
  const atBody = await atTotal.json();
  assertEquals(atBody.data.length, 2);
  assertEquals(atBody.meta.total, 2);
  assertEquals(atBody.links.next, null);
  assertEquals(atBody.links.prev, null);
  const overTotal = await req(handler, "/nodes?page[offset]=100");
  const overBody = await overTotal.json();
  assertEquals(overBody.data.length, 2);
  assertEquals(overBody.meta.total, 2);
  assertEquals(overBody.links.next, null);
  assertEquals(overBody.links.prev, null);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("page[limit]=0 clamps to 1 item", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes?page[limit]=0");
  const body = await res.json();
  assertEquals(body.data.length, 1);
  assertEquals(
    decodeURIComponent(body.links.next),
    "http://127.0.0.1/nodes?page[limit]=0&page[offset]=1",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("pagination offset past the end on a paged collection clamps and links correctly", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes?page[limit]=1&page[offset]=50");
  const body = await res.json();
  assertEquals(body.data.length, 1);
  assertEquals(body.meta.total, 2);
  assertEquals(
    decodeURIComponent(body.links.last),
    "http://127.0.0.1/nodes?page[limit]=1&page[offset]=1",
  );
  assertEquals(body.links.next, null);
  assertEquals(
    decodeURIComponent(body.links.prev),
    "http://127.0.0.1/nodes?page[limit]=1&page[offset]=0",
  );
  await Deno.remove(dir, { recursive: true });
});

class FlakyStore extends SqliteNodeStore {
  override search(): never {
    throw new Error("boom");
  }
}

Deno.test("internal errors map to 500 with a JSON:API error body", async () => {
  const dir = tempDir();
  const flaky = new FlakyStore(`${dir}/index.db`);
  flaky.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    flaky,
  );
  const handler = createApp(ingest, flaky, { logger: () => {} });
  const res = await req(handler, "/nodes");
  const body = await res.json();
  assertEquals(res.status, 500);
  assertEquals(body.errors[0].status, "500");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("error documents carry the JSON:API version and error fields", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/nodes/nonexistent-cid");
  const body = await res.json();
  assertEquals(res.status, 404);
  assertEquals(body.jsonapi.version, "1.0");
  assertEquals(Array.isArray(body.errors), true);
  assertEquals(body.errors.length, 1);
  assertEquals(body.errors[0].status, "404");
  assertEquals(typeof body.errors[0].title, "string");
  assertEquals(body.errors[0].title.length > 0, true);
  assertEquals(typeof body.errors[0].detail, "string");
  assertEquals(body.errors[0].detail.length > 0, true);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("multi-page results expose first, last, next, and prev links", async () => {
  const { handler, ingest, authorKey, dir } = await makeServer();
  for (const title of ["second problem", "third problem"]) {
    const extra = signed(
      problemNode(authorKey.publicKeyHex, { title }),
      authorKey.secretKeyHex,
    );
    await ingest.ingestNode(extra);
  }
  const res = await req(handler, "/nodes?page[limit]=1&page[offset]=1");
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 4);
  assertEquals(body.data.length, 1);
  assertEquals(
    decodeURIComponent(body.links.first).endsWith("page[offset]=0"),
    true,
  );
  assertEquals(
    decodeURIComponent(body.links.last).endsWith("page[offset]=3"),
    true,
  );
  assertEquals(
    decodeURIComponent(body.links.next).endsWith("page[offset]=2"),
    true,
  );
  assertEquals(
    decodeURIComponent(body.links.prev).endsWith("page[offset]=0"),
    true,
  );

  const firstPage = await req(handler, "/nodes?page[limit]=1");
  const firstBody = await firstPage.json();
  assertEquals(
    decodeURIComponent(firstBody.links.next).endsWith("page[offset]=1"),
    true,
  );
  assertEquals(firstBody.links.prev, null);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("HEAD returns empty bodies on collection and resource routes", async () => {
  const { handler, problemCid, dir } = await makeServer();
  const recipes = await req(handler, "/recipes", { method: "HEAD" });
  assertEquals(recipes.status, 200);
  assertEquals(await recipes.text(), "");
  assertEquals(recipes.headers.get("content-type"), "application/vnd.api+json");

  const node = await req(handler, `/nodes/${problemCid}`, { method: "HEAD" });
  assertEquals(node.status, 200);
  assertEquals(await node.text(), "");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /ui serves the index page", async () => {
  const { ingest, index, dir } = await makeServer();
  const web = await webDirWith();
  const handler = createApp(ingest, index, { webDir: web, logger: () => {} });
  const res = await req(handler, "/ui/");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  assertEquals(await res.text(), "<h1>The Corpus</h1>");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(web, { recursive: true });
});

Deno.test("GET /ui uses the default web directory", async () => {
  const { ingest, index, dir } = await makeServer();
  const handler = createApp(ingest, index, { logger: () => {} });
  const res = await req(handler, "/ui/");
  assertEquals(res.status, 200);
  assertEquals(await res.text().then((t) => t.includes("The Corpus")), true);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("GET /ui without a trailing slash serves the index page", async () => {
  const { ingest, index, dir } = await makeServer();
  const web = await webDirWith();
  const handler = createApp(ingest, index, { webDir: web, logger: () => {} });
  const res = await req(handler, "/ui");
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "<h1>The Corpus</h1>");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(web, { recursive: true });
});

Deno.test("GET /ui assets are served with the right content type", async () => {
  const { ingest, index, dir } = await makeServer();
  const web = await webDirWith();
  const handler = createApp(ingest, index, { webDir: web, logger: () => {} });
  const res = await req(handler, "/ui/app.js");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "text/javascript; charset=utf-8",
  );
  assertEquals(await res.text(), "console.log('ui');");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(web, { recursive: true });
});

Deno.test("missing UI assets return 404", async () => {
  const { ingest, index, dir } = await makeServer();
  const web = await webDirWith();
  const handler = createApp(ingest, index, { webDir: web, logger: () => {} });
  const res = await req(handler, "/ui/nope.js");
  assertEquals(res.status, 404);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(web, { recursive: true });
});

Deno.test("encoded UI path traversal is rejected", async () => {
  const { ingest, index, dir } = await makeServer();
  const web = await webDirWith();
  const handler = createApp(ingest, index, { webDir: web, logger: () => {} });
  const res = await req(handler, "/ui/%252e%252e/secret");
  assertEquals(res.status, 404);
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(web, { recursive: true });
});

Deno.test("HEAD /ui/ returns headers without a body", async () => {
  const { ingest, index, dir } = await makeServer();
  const web = await webDirWith();
  const handler = createApp(ingest, index, { webDir: web, logger: () => {} });
  const res = await req(handler, "/ui/", { method: "HEAD" });
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "");
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
  await Deno.remove(dir, { recursive: true });
  await Deno.remove(web, { recursive: true });
});

Deno.test("receipt resource exposes replay status and verifier reputation", async () => {
  const { handler, verifierKey, problemCid, recipeCid, dir } =
    await makeServer();
  const receipt = signed(
    verificationNode(
      verifierKey.publicKeyHex,
      problemCid,
      recipeCid,
      "a".repeat(64),
    ),
    verifierKey.secretKeyHex,
  );
  const res = await req(
    handler,
    "/verifications",
    postNode("verifications", receipt),
  );
  const body = await res.json();
  assertEquals(res.status, 201);
  assertEquals(body.data.attributes.server_replayed, true);
  assertEquals(body.data.attributes.replayed_by, "trusted-stub");
  assertEquals(typeof body.data.attributes.replayed_at, "string");
  assertEquals(body.data.attributes.environment.playground, "sandbox-den");
  assertEquals(body.data.meta.verifier.key, verifierKey.publicKeyHex);
  assertEquals(body.data.meta.verifier.trusted, true);
  assertEquals(body.data.meta.verifier.weight, 1.0);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("POST /verifications rate-limits a key", async () => {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
  const registry = new PlaygroundRegistry([{
    environment_hash: "a".repeat(64),
    playground: "sandbox-den",
    platform: "linux",
    version: "1.0",
    config_hash: "cfg-a",
  }]);
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
    registry,
    new TrustedStubReplayExecutor(),
  );
  const authorKey = generateKeyPair();
  const verifierKey = generateKeyPair();
  const recipe = signed(
    recipeNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const recipeCid = await cidOf(recipe);
  await ingest.ingestNode(recipe);
  const problem = signed(
    problemNode(authorKey.publicKeyHex, { solutionCids: [recipeCid] }),
    authorKey.secretKeyHex,
  );
  const problemCid = await cidOf(problem);
  await ingest.ingestNode(problem);
  const handler = createApp(ingest, index, {
    verificationRateLimit: 2,
    logger: () => {},
  });
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    const receipt = signed(
      verificationNode(
        verifierKey.publicKeyHex,
        problemCid,
        recipeCid,
        "a".repeat(64),
      ),
      verifierKey.secretKeyHex,
    );
    const res = await req(
      handler,
      "/verifications",
      postNode("verifications", receipt),
    );
    statuses.push(res.status);
    if (res.status === 429) {
      assertEquals(res.headers.get("retry-after"), "3600");
    }
  }
  assertEquals(statuses, [201, 201, 429]);
  await index.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("fresh untrusted keys get zero weight and cannot raise confidence", async () => {
  const { handler, problemCid, recipeCid, dir } = await makeServer();
  for (const envLetter of ["b", "d"]) {
    const fresh = generateKeyPair();
    const receipt = signed(
      verificationNode(
        fresh.publicKeyHex,
        problemCid,
        recipeCid,
        envLetter.repeat(64),
      ),
      fresh.secretKeyHex,
    );
    const res = await req(
      handler,
      "/verifications",
      postNode("verifications", receipt),
    );
    const body = await res.json();
    assertEquals(res.status, 201);
    assertEquals(body.data.meta.verifier.trusted, false);
    assertEquals(body.data.meta.verifier.weight, 0);
  }
  const res = await req(handler, `/nodes/${recipeCid}`);
  const body = await res.json();
  assertEquals(body.data.meta.confidence_score, 0.5);
  assertEquals(body.data.meta.provenance.has_trusted_verifier, true);
  assertEquals(body.data.meta.provenance.replayed_count, 3);
  assertEquals(body.data.meta.provenance.distinct_keys, 3);
  await Deno.remove(dir, { recursive: true });
});
