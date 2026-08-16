import { assertEquals, assertMatch, assertObjectMatch } from "@std/assert";
import { SqliteNodeStore } from "../src/storage/node_store.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { IngestService } from "../src/storage/ingest.ts";
import { generateKeyPair } from "../src/core/sign.ts";
import { createApp } from "../src/api/server.ts";
import { OPENAPI_MEDIA_TYPE } from "../src/api/openapi.ts";
import {
  cidOf,
  problemNode,
  recipeNode,
  signed,
  verificationNode,
} from "./fixtures.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-openapi-${crypto.randomUUID()}`;
}

async function makeServer() {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
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
  return { handler, dir, recipeCid, problemCid, authorKey };
}

async function req(
  handler: (request: Request) => Promise<Response>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return await handler(new Request(`http://127.0.0.1${path}`, init));
}

function jsonApiPost(attributes: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({ data: { type: "problems", attributes } }),
  };
}

Deno.test("GET /openapi.json returns a valid OpenAPI 3.1 document", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/openapi.json");
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("Content-Type"),
    `${OPENAPI_MEDIA_TYPE}; charset=utf-8`,
  );
  const doc = await res.json();
  assertEquals(doc.openapi, "3.1.0");
  assertEquals(typeof doc.info.title, "string");
  assertMatch(doc.info.version, /^\d+\.\d+\.\d+$/);
  assertEquals(doc.servers, [{ url: "http://127.0.0.1" }]);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("openapi document contains every documented path", async () => {
  const { handler, dir } = await makeServer();
  const doc = await (await req(handler, "/openapi.json")).json();
  const expected = [
    "/",
    "/agent/query",
    "/nodes",
    "/nodes/{cid}",
    "/nodes/{cid}/verifications",
    "/nodes/{cid}/{relationship}",
    "/nodes/by-node-id/{node_id}",
    "/nodes/by-node-id/{node_id}/versions",
    "/verifications",
    "/schemas/{node_type}",
    "/problems",
    "/recipes",
    "/guides",
    "/references",
    "/comparisons",
    "/improvements",
    "/blueprints",
    "/verifications",
  ];
  for (const path of expected) {
    assertEquals(typeof doc.paths[path], "object", `missing path ${path}`);
  }
  assertEquals(typeof doc.paths["/nodes"].get, "object");
  assertEquals(typeof doc.paths["/nodes"].post, "object");
  assertEquals(typeof doc.paths["/agent/query"].post, "object");

  const relationshipParam = doc.paths["/nodes/{cid}/{relationship}"].parameters
    .find((p: { name: string }) => p.name === "relationship");
  assertEquals(relationshipParam.name, "relationship");
  for (const name of ["benchmarks", "recipes", "related_nodes", "solutions"]) {
    assertEquals(
      relationshipParam.schema.enum.includes(name),
      true,
      `relationship enum must include ${name}`,
    );
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("openapi document has no external corpus:defs refs", async () => {
  const { handler, dir } = await makeServer();
  const doc = await (await req(handler, "/openapi.json")).json();

  const refs: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        collect(item);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref") {
          refs.push(String(child));
        } else {
          collect(child);
        }
      }
    }
  };
  collect(doc);

  const s = JSON.stringify(doc);
  assertMatch(s, /"\$ref":/);
  assertEquals(s.includes("corpus:defs"), false);
  assertEquals(refs.some((r) => r.includes("$defs")), false);
  for (const r of refs) {
    assertMatch(r, /^#\/components\/schemas\//);
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("openapi document embeds the node and defs schemas", async () => {
  const { handler, dir } = await makeServer();
  const doc = await (await req(handler, "/openapi.json")).json();
  const schemas = doc.components.schemas;
  for (
    const name of [
      "Problem",
      "Recipe",
      "Guide",
      "Verification",
      "Reference",
      "Comparison",
      "Improvement",
      "Blueprint",
      "osk",
      "ipldLink",
      "iso8601",
      "attribution",
      "knowledgeLifecycle",
    ]
  ) {
    assertEquals(typeof schemas[name], "object", `missing schema ${name}`);
  }
  assertEquals(
    schemas.Problem.properties.osk.allOf[0].$ref,
    "#/components/schemas/osk",
  );
  assertEquals(schemas.ipldLink.properties["/"].pattern, "^b[a-z2-7]{60}$");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("entrypoint advertises the openapi link", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/");
  const body = await res.json();
  assertEquals(body.links.openapi, "http://127.0.0.1/openapi.json");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("documented paths respond with documented status codes", async () => {
  const { handler, dir, recipeCid, problemCid, authorKey } = await makeServer();
  const signedProblem = signed(
    problemNode(authorKey.publicKeyHex),
    authorKey.secretKeyHex,
  );
  const cases: Array<{ path: string; init?: RequestInit; status: number }> = [
    { path: "/", status: 200 },
    { path: "/nodes", status: 200 },
    { path: "/problems", status: 200 },
    { path: "/recipes", status: 200 },
    { path: "/guides", status: 200 },
    { path: "/verifications", status: 200 },
    { path: `/nodes/${recipeCid}`, status: 200 },
    { path: `/nodes/${problemCid}?include=solutions`, status: 200 },
    { path: `/nodes/${problemCid}/solutions`, status: 200 },
    { path: `/nodes/${problemCid}/verifications`, status: 200 },
    { path: `/nodes/${"b".repeat(61)}`, status: 404 },
    { path: `/nodes/by-node-id/${crypto.randomUUID()}`, status: 404 },
    { path: `/nodes/by-node-id/${crypto.randomUUID()}/versions`, status: 404 },
    { path: "/schemas/recipes", status: 200 },
    { path: "/schemas/unknown", status: 422 },
    { path: "/nodes", init: jsonApiPost({}), status: 422 },
    {
      path: "/verifications",
      init: jsonApiPost(signedProblem),
      status: 422,
    },
    {
      path: "/nodes",
      init: { method: "POST", body: "{}" },
      status: 415,
    },
  ];
  for (const c of cases) {
    const res = await req(handler, c.path, c.init);
    assertEquals(res.status, c.status, `${c.init?.method ?? "GET"} ${c.path}`);
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("openapi.json ignores the JSON:API accept gate", async () => {
  const { handler, dir } = await makeServer();
  const res = await req(handler, "/openapi.json", {
    headers: { Accept: "text/html" },
  });
  assertEquals(res.status, 200);
  const doc = await res.json();
  assertObjectMatch(doc, { openapi: "3.1.0" });
  await Deno.remove(dir, { recursive: true });
});
