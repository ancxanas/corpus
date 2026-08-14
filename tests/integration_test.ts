import { assertEquals } from "@std/assert";
import { generateKeyPair } from "../src/core/sign.ts";
import { problemNode, recipeNode, signed } from "./fixtures.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitReady(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) {
        return;
      }
    } catch {
      // server not listening yet
    }
    await sleep(100);
  }
  throw new Error("server did not become ready");
}

Deno.test("integration: full authoring flow through the real server", async () => {
  const dir = `/tmp/opencode/corpus-integration-${crypto.randomUUID()}`;
  const port = 18000 + Math.floor(Math.random() * 1000);
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/main.ts"],
    env: { CORPUS_DATA_DIR: dir, PORT: String(port), CORPUS_HOST: "127.0.0.1" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    await waitReady(port);
    const base = `http://127.0.0.1:${port}`;

    const entry = await fetch(`${base}/`);
    assertEquals(entry.status, 200);
    const entryBody = await entry.json();
    assertEquals(entryBody.jsonapi.version, "1.0");

    const key = generateKeyPair();
    const recipe = signed(recipeNode(key.publicKeyHex), key.secretKeyHex);
    const recipeRes = await fetch(`${base}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "recipes", attributes: recipe } }),
    });
    assertEquals(recipeRes.status, 201);
    const recipeBody = await recipeRes.json();
    const recipeCid: string = recipeBody.meta.cid;

    const problem = signed(
      problemNode(key.publicKeyHex, { solutionCids: [recipeCid] }),
      key.secretKeyHex,
    );
    const problemRes = await fetch(`${base}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type: "problems", attributes: problem } }),
    });
    assertEquals(problemRes.status, 201);
    const problemBody = await problemRes.json();
    const problemCid: string = problemBody.meta.cid;

    const getRes = await fetch(`${base}/nodes/${recipeCid}`);
    assertEquals(getRes.status, 200);
    const getBody = await getRes.json();
    assertEquals(getBody.data.id, recipeCid);
    assertEquals(getBody.data.type, "recipes");

    const search = await fetch(`${base}/nodes?filter[node_type]=problems`);
    assertEquals(search.status, 200);
    const searchBody = await search.json();
    assertEquals(searchBody.meta.total, 1);
    assertEquals(searchBody.data[0].id, problemCid);
  } finally {
    proc.kill("SIGTERM");
    const status = await proc.status;
    assertEquals(status.code, 0);
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
