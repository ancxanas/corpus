import { SqliteQueryIndex } from "./storage/index.ts";
import { FileBlockstore } from "./storage/blockstore.ts";
import { IngestService } from "./storage/ingest.ts";
import { startServer } from "./api/server.ts";
import { type EnvSpec, PlaygroundRegistry } from "./verify/registry.ts";
import {
  type ReplayExecutor,
  SandboxReplayExecutor,
  StubReplayExecutor,
} from "./verify/replay.ts";
import { cachedVersionPins } from "./storage/triggers.ts";

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid PORT=${raw} (use an integer between 1 and 65535)`);
    Deno.exit(1);
  }
  return port;
}

const root = Deno.env.get("CORPUS_DATA_DIR") ?? "data";
const dbPath = `${root}/corpus.db`;
const blockDir = `${root}/blocks`;
const port = parsePort(Deno.env.get("PORT"));
const host = Deno.env.get("CORPUS_HOST") ?? "0.0.0.0";

const index = new SqliteQueryIndex(dbPath, {
  versionPins: cachedVersionPins(Deno.env.get("CORPUS_VERSIONS")),
});
index.init();

let registry: PlaygroundRegistry | null = null;
const registryText = await Deno.readTextFile(`${root}/registry.json`).catch(
  () => null,
);
if (registryText !== null) {
  let envs: EnvSpec[];
  try {
    envs = JSON.parse(registryText) as EnvSpec[];
  } catch (e) {
    console.error(`registry.json is not valid JSON: ${(e as Error).message}`);
    Deno.exit(1);
  }
  registry = new PlaygroundRegistry(envs);
}

const replayMode = Deno.env.get("CORPUS_REPLAY") ?? "stub";
let replay: ReplayExecutor = new StubReplayExecutor();
if (replayMode === "sandbox") {
  const sandboxCmd = Deno.env.get("CORPUS_SANDBOX_CMD");
  if (!sandboxCmd) {
    console.error(
      "CORPUS_REPLAY=sandbox requires CORPUS_SANDBOX_CMD to be set",
    );
    Deno.exit(1);
  }
  if (!registry) {
    console.error(
      "CORPUS_REPLAY=sandbox requires a registry.json in CORPUS_DATA_DIR",
    );
    Deno.exit(1);
  }
  replay = new SandboxReplayExecutor(sandboxCmd.split(/\s+/));
} else if (replayMode !== "stub") {
  console.error(`unknown CORPUS_REPLAY=${replayMode} (use stub or sandbox)`);
  Deno.exit(1);
}

const ingest = new IngestService(
  new FileBlockstore({ dir: blockDir }),
  index,
  registry,
  replay,
);

const server = startServer(ingest, index, { port, hostname: host });
const bound = await server.listening;
const boundUrl = Deno.env.get("CORPUS_BASE_URL") ??
  `http://${bound.hostname}:${bound.port}`;
console.log(
  `The Corpus listening on http://${bound.hostname}:${bound.port} (base URL: ${boundUrl})`,
);

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
