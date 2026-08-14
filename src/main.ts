import { SqliteQueryIndex } from "./storage/index.ts";
import { FileBlockstore } from "./storage/blockstore.ts";
import { IngestService } from "./storage/ingest.ts";
import { startServer } from "./api/server.ts";
import { PlaygroundRegistry, type EnvSpec } from "./verify/registry.ts";
import { StubReplayExecutor, SandboxReplayExecutor, type ReplayExecutor } from "./verify/replay.ts";

const root = Deno.env.get("CORPUS_DATA_DIR") ?? "data";
const dbPath = `${root}/corpus.db`;
const blockDir = `${root}/blocks`;
const port = Number(Deno.env.get("PORT") ?? 8000);
const host = Deno.env.get("CORPUS_HOST") ?? "0.0.0.0";

const index = new SqliteQueryIndex(dbPath);
index.init();

let registry: PlaygroundRegistry | null = null;
try {
  const text = await Deno.readTextFile(`${root}/registry.json`);
  registry = new PlaygroundRegistry(JSON.parse(text) as EnvSpec[]);
} catch {
  // no registry file: playground enforcement is disabled
}

const replayMode = Deno.env.get("CORPUS_REPLAY") ?? "stub";
let replay: ReplayExecutor = new StubReplayExecutor();
if (replayMode === "sandbox") {
  const sandboxCmd = Deno.env.get("CORPUS_SANDBOX_CMD");
  if (!sandboxCmd) {
    console.error("CORPUS_REPLAY=sandbox requires CORPUS_SANDBOX_CMD to be set");
    Deno.exit(1);
  }
  if (!registry) {
    console.error("CORPUS_REPLAY=sandbox requires a registry.json in CORPUS_DATA_DIR");
    Deno.exit(1);
  }
  replay = new SandboxReplayExecutor(sandboxCmd.split(/\s+/));
} else if (replayMode !== "stub") {
  console.error(`unknown CORPUS_REPLAY=${replayMode} (use stub or sandbox)`);
  Deno.exit(1);
}

const ingest = new IngestService(new FileBlockstore({ dir: blockDir }), index, registry, replay);

const server = startServer(ingest, index, { port, hostname: host });
const bound = Deno.env.get("CORPUS_BASE_URL") ?? (host === "0.0.0.0" ? `http://127.0.0.1:${port}` : `http://${host}:${port}`);
console.log(`The Corpus listening on http://${host}:${port} (base URL: ${bound})`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received: shutting down`);
  await server.shutdown();
  index.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    void shutdown(signal);
  });
}

await server.finished;
index.close();
