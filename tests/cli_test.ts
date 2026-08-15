import { assertEquals } from "@std/assert";
import { generateKeyPair } from "../src/core/sign.ts";
import { validateNode } from "../src/schema/validate.ts";

async function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/cli/main.ts", ...args],
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
