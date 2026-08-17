import { assertEquals, assertMatch, assertObjectMatch } from "@std/assert";
import { SqliteNodeStore } from "../src/storage/node_store.ts";
import { FileBlockstore } from "../src/storage/blockstore.ts";
import { IngestService } from "../src/storage/ingest.ts";
import { createApp } from "../src/api/server.ts";
import {
  QUERY_FILTERS,
  QUERY_PAGE_LIMIT_MAX,
  QUERY_SORTABLE,
} from "../src/api/selfdescription.ts";
import { registry } from "../src/nodetypes/registry.ts";

function tempDir(): string {
  return `/tmp/opencode/corpus-entrypoint-${crypto.randomUUID()}`;
}

async function makeHandler() {
  const dir = tempDir();
  const index = new SqliteNodeStore(`${dir}/index.db`);
  await index.init();
  const ingest = new IngestService(
    new FileBlockstore({ dir: `${dir}/blocks` }),
    index,
  );
  const handler = createApp(ingest, index, { logger: () => {} });
  return { handler, dir };
}

async function req(
  handler: (request: Request) => Promise<Response>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return await handler(new Request(`http://127.0.0.1${path}`, init));
}

Deno.test("entrypoint meta describes the corpus", async () => {
  const { handler, dir } = await makeHandler();
  const res = await req(handler, "/");
  assertEquals(res.status, 200);
  const body = await res.json();
  assertObjectMatch(body.meta, {
    name: "Corpus",
    version: "0.3.0",
    description: body.meta.description,
    how_to_write: body.meta.how_to_write,
    trust_model: body.meta.trust_model,
  });
  await Deno.remove(dir, { recursive: true });
});

Deno.test("node_types derive from the registry", async () => {
  const { handler, dir } = await makeHandler();
  const body = await (await req(handler, "/")).json();
  for (const module of Object.values(registry)) {
    assertEquals(body.meta.node_types[module.nodeType], {
      summary: module.description,
      plural: module.plural,
      schema: `/schemas/${module.nodeType}`,
    });
  }
  assertEquals(
    Object.keys(body.meta.node_types).length,
    Object.keys(registry).length,
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("query block matches the canonical lists", async () => {
  const { handler, dir } = await makeHandler();
  const body = await (await req(handler, "/")).json();
  assertEquals(body.meta.query.filters, [...QUERY_FILTERS]);
  assertEquals(body.meta.query.sortable, [...QUERY_SORTABLE]);
  assertEquals(body.meta.query.page.limit_max, QUERY_PAGE_LIMIT_MAX);
  assertEquals(body.meta.docs.openapi, "http://127.0.0.1/openapi.json");
  assertEquals(body.meta.docs.llms, "http://127.0.0.1/llms.txt");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("query example uses only supported filters", async () => {
  const { handler, dir } = await makeHandler();
  const body = await (await req(handler, "/")).json();
  const mentions = [...body.meta.query.example.matchAll(/filter\[([^\]]+)\]/g)]
    .map((m) => m[1]);
  assertEquals(mentions.length > 0, true);
  for (const name of mentions) {
    assertEquals(
      (QUERY_FILTERS as readonly string[]).includes(name),
      true,
      `example uses unsupported filter ${name}`,
    );
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("how_to_write and trust_model state the exact rules", async () => {
  const { handler, dir } = await makeHandler();
  const body = await (await req(handler, "/")).json();
  assertMatch(body.meta.how_to_write, /Ed25519/);
  assertMatch(body.meta.how_to_write, /DAG-JSON/);
  assertMatch(body.meta.how_to_write, /public_key/);
  assertMatch(body.meta.how_to_write, /POST \/nodes/);
  assertMatch(body.meta.trust_model, /confidence_score 0\.0/);
  assertMatch(body.meta.trust_model, /disputed/);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("/llms.txt serves a plain-text brief", async () => {
  const { handler, dir } = await makeHandler();
  const res = await req(handler, "/llms.txt");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Content-Type"), "text/plain; charset=utf-8");
  const text = await res.text();
  assertMatch(text, /# Corpus/);
  assertMatch(text, /DAG-JSON/);
  assertMatch(text, /http:\/\/127\.0\.0\.1\/openapi\.json/);
  assertMatch(text, /filter\[severity\]=critical/);
  assertMatch(text, /Ed25519/);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("llms.txt ignores the JSON:API accept gate", async () => {
  const { handler, dir } = await makeHandler();
  const res = await req(handler, "/llms.txt", {
    headers: { Accept: "text/html" },
  });
  assertEquals(res.status, 200);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("openapi filter parameters match the canonical list", async () => {
  const { handler, dir } = await makeHandler();
  const doc = await (await req(handler, "/openapi.json")).json();
  const params = doc.paths["/nodes"].get.parameters;
  const filterNames = params
    .filter((p: { name: string }) => p.name.startsWith("filter["))
    .map((p: { name: string }) => p.name.slice(7, -1));
  assertEquals(filterNames.sort(), [...QUERY_FILTERS].sort());
  const sortParam = params.find((p: { name: string }) => p.name === "sort");
  assertEquals(sortParam.schema.enum, [...QUERY_SORTABLE]);
  const limitParam = params.find(
    (p: { name: string }) => p.name === "page[limit]",
  );
  assertEquals(limitParam.schema.maximum, QUERY_PAGE_LIMIT_MAX);
  await Deno.remove(dir, { recursive: true });
});
