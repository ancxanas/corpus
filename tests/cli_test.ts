import { assert, assertEquals } from "@std/assert";
import { generateKeyPair } from "../src/core/sign.ts";
import { validateNode } from "../src/schema/validate.ts";
import { problemNode, signed } from "./fixtures.ts";

async function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/cli/main.ts", ...args],
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

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

function tempKey(): string {
  return `/tmp/opencode/corpus-cli-key-${crypto.randomUUID()}.json`;
}

Deno.test("cli keygen writes a key file", async () => {
  const file = tempKey();
  const out = await run(["keygen", "--output", file]);
  assertEquals(out.code, 0);
  const fromFile = JSON.parse(Deno.readTextFileSync(file)) as {
    public_key: string;
    secret_key: string;
  };
  assertEquals(typeof fromFile.public_key, "string");
  assertEquals(fromFile.public_key.length, 64);
  assertEquals(fromFile.secret_key.length, 64);
  await Deno.remove(file).catch(() => {});
});

Deno.test("cli node template recipe passes schema validation", async () => {
  const key = generateKeyPair();
  const file = tempKey();
  Deno.writeTextFileSync(
    file,
    JSON.stringify({ public_key: key.publicKeyHex }),
  );
  const out = await run([
    "node",
    "template",
    "--type",
    "recipe",
    "--key",
    file,
  ]);
  assertEquals(out.code, 0);
  const template = JSON.parse(out.stdout) as unknown;
  const issues = await validateNode(template);
  assertEquals(issues, []);
  await Deno.remove(file).catch(() => {});
});

Deno.test("cli node template problem passes schema validation", async () => {
  const key = generateKeyPair();
  const file = tempKey();
  Deno.writeTextFileSync(
    file,
    JSON.stringify({ public_key: key.publicKeyHex }),
  );
  const out = await run([
    "node",
    "template",
    "--type",
    "problem",
    "--key",
    file,
  ]);
  assertEquals(out.code, 0);
  const template = JSON.parse(out.stdout) as unknown;
  const issues = await validateNode(template);
  assertEquals(issues, []);
  await Deno.remove(file).catch(() => {});
});

Deno.test("cli node template guide passes schema validation", async () => {
  const key = generateKeyPair();
  const file = tempKey();
  Deno.writeTextFileSync(
    file,
    JSON.stringify({ public_key: key.publicKeyHex }),
  );
  const out = await run([
    "node",
    "template",
    "--type",
    "guide",
    "--key",
    file,
  ]);
  assertEquals(out.code, 0);
  const template = JSON.parse(out.stdout) as unknown;
  const issues = await validateNode(template);
  assertEquals(issues, []);
  await Deno.remove(file).catch(() => {});
});

Deno.test("cli usage errors exit 2", async () => {
  const noArgs = await run([]);
  assertEquals(noArgs.code, 2);
  const noSubcommand = await run(["node"]);
  assertEquals(noSubcommand.code, 2);
  const missingFlags = await run(["get"]);
  assertEquals(missingFlags.code, 2);
  const unknown = await run(["frobnicate"]);
  assertEquals(unknown.code, 2);
});

Deno.test("cli --help exits 0 with usage text", async () => {
  const top = await run(["--help"]);
  assertEquals(top.code, 0);
  assertEquals(top.stdout.includes("keygen"), true);
  const sub = await run(["node", "create", "--help"]);
  assertEquals(sub.code, 0);
  assertEquals(sub.stdout.includes("--file"), true);
});

Deno.test("cli search supports keyword and tag filters", async () => {
  const dir = `/tmp/opencode/corpus-cli-search-${crypto.randomUUID()}`;
  const port = 19000 + Math.floor(Math.random() * 1000);
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/main.ts"],
    env: { CORPUS_DATA_DIR: dir, PORT: String(port), CORPUS_HOST: "127.0.0.1" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  try {
    await waitReady(port);
    const base = `http://127.0.0.1:${port}`;
    const key = generateKeyPair();
    const node = problemNode(key.publicKeyHex, {
      title: "Heap exhaustion on big payloads",
    }) as ReturnType<typeof problemNode> & {
      payload: { problem: { tags?: string[] } };
    };
    node.payload.problem.tags = ["json", "oom"];
    const nodeSigned = signed(node, key.secretKeyHex);
    const post = await fetch(`${base}/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({
        data: { type: "problems", attributes: nodeSigned },
      }),
    });
    assertEquals(post.status, 201);
    const created = await post.json() as { meta: { cid: string } };
    const cid = created.meta.cid;

    const env = { CORPUS_BASE_URL: base };
    const bySearch = await run(["search", "--search", "heap"], env);
    assertEquals(bySearch.code, 0, bySearch.stderr);
    assert(bySearch.stdout.includes(cid), bySearch.stdout);
    assert(bySearch.stdout.includes("Heap exhaustion"), bySearch.stdout);

    const byTag = await run(["search", "--tag", "json"], env);
    assertEquals(byTag.code, 0, byTag.stderr);
    assert(byTag.stdout.includes(cid), byTag.stdout);

    const both = await run(
      ["search", "--search", "heap", "--tag", "oom"],
      env,
    );
    assertEquals(both.code, 0, both.stderr);
    assert(both.stdout.includes(cid), both.stdout);

    const miss = await run(["search", "--search", "zzznope"], env);
    assertEquals(miss.code, 0, miss.stderr);
    assert(miss.stdout.includes("total: 0"), miss.stdout);
  } finally {
    proc.kill("SIGTERM");
    await proc.status;
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
