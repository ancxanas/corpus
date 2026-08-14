import { assertEquals } from "@std/assert";
import { SqliteQueryIndex } from "../src/storage/index.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { IngestService } from "../src/storage/ingest.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import { createApp } from "../src/api/server.ts";
import type { Node, ProblemPayload } from "../src/core/types.ts";
import {
  cidOf,
  problemNode,
  recipeNode,
  signed,
  verificationNode,
} from "./fixtures.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-api-${crypto.randomUUID()}`;
}

async function makeServer() {
  const dir = tempDir();
  const index = new SqliteQueryIndex(`${dir}/index.db`);
  index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
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

  const handler = createApp(ingest, index, { logger: () => {} });
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

Deno.test("CORPUS_BASE_URL overrides self links", async () => {
  const { handler, dir } = await makeServer();
  Deno.env.set("CORPUS_BASE_URL", "https://corpus.example");
  try {
    const res = await req(handler, "/");
    const body = await res.json();
    assertEquals(body.links.self, "https://corpus.example");
    assertEquals(body.links.problems, "https://corpus.example/problems");
  } finally {
    Deno.env.delete("CORPUS_BASE_URL");
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

Deno.test("unknown filter fields are ignored", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(
    handler,
    "/nodes?filter[bogus_field]=x&filter[node_type]=problems",
  );
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.meta.total, 1);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("pagination offset at and over the total yields empty data", async () => {
  const { handler, dir } = await makeServer();
  const atTotal = await req(handler, "/nodes?page[limit]=25&page[offset]=2");
  const atBody = await atTotal.json();
  assertEquals(atBody.data.length, 0);
  assertEquals(atBody.meta.total, 2);
  const overTotal = await req(handler, "/nodes?page[offset]=100");
  const overBody = await overTotal.json();
  assertEquals(overBody.data.length, 0);
  assertEquals(overBody.meta.total, 2);
  await Deno.remove(dir, { recursive: true });
});

class FlakyIndex extends SqliteQueryIndex {
  override search(): never {
    throw new Error("boom");
  }
}

Deno.test("internal errors map to 500 with a JSON:API error body", async () => {
  const dir = tempDir();
  const flaky = new FlakyIndex(`${dir}/index.db`);
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
