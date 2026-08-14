import { assertEquals } from "@std/assert";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("SIGTERM shuts the server down cleanly", async () => {
  const dir = `/tmp/opencode/corpus-shutdown-${crypto.randomUUID()}`;
  const port = 19000 + Math.floor(Math.random() * 1000);
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", "src/main.ts"],
    env: {
      CORPUS_DATA_DIR: dir,
      PORT: String(port),
      CORPUS_HOST: "127.0.0.1",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) {
        ready = true;
        break;
      }
    } catch {
      // server not listening yet
    }
    await sleep(100);
  }
  if (!ready) {
    proc.kill();
    const status = await proc.status;
    throw new Error(`server did not become ready (exit ${status.code})`);
  }

  proc.kill("SIGTERM");
  const status = await proc.status;
  assertEquals(status.code, 0);
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});
