import { SqliteQueryIndex } from "./storage/index.ts";
import { FileBlockstore } from "./storage/blockstore.ts";
import { IngestService } from "./storage/ingest.ts";
import { startServer } from "./api/server.ts";
import { type Config, ConfigError, loadConfig } from "./config.ts";
import { type EnvSpec, PlaygroundRegistry } from "./verify/registry.ts";
import {
  type ReplayExecutor,
  SandboxReplayExecutor,
  StubReplayExecutor,
} from "./verify/replay.ts";
import { cachedVersionPins } from "./storage/triggers.ts";

function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    fail(e.message);
  }
  throw e;
}

const index = new SqliteQueryIndex(config.dbPath, {
  versionPins: cachedVersionPins(config.versionsPath),
});
await index.init();

let registry: PlaygroundRegistry | null = null;
const registryText = await Deno.readTextFile(config.registryPath).catch(
  () => null,
);
if (registryText !== null) {
  let envs: EnvSpec[];
  try {
    envs = JSON.parse(registryText) as EnvSpec[];
  } catch (e) {
    fail(`registry.json is not valid JSON: ${(e as Error).message}`);
  }
  registry = new PlaygroundRegistry(envs);
}

let replay: ReplayExecutor = new StubReplayExecutor();
if (config.replay === "sandbox") {
  if (!config.sandboxCmd) {
    fail("CORPUS_REPLAY=sandbox requires CORPUS_SANDBOX_CMD to be set");
  }
  if (!registry) {
    fail("CORPUS_REPLAY=sandbox requires a registry.json in CORPUS_DATA_DIR");
  }
  replay = new SandboxReplayExecutor(config.sandboxCmd.split(/\s+/));
}

const ingest = new IngestService(
  new FileBlockstore({ dir: config.blockDir }),
  index,
  registry,
  replay,
);

const server = startServer(ingest, index, {
  port: config.port,
  hostname: config.host,
  baseUrl: config.baseUrl,
  bodyLimit: config.maxBodyBytes,
});
const bound = await server.listening;
const boundUrl = config.baseUrl ?? `http://${bound.hostname}:${bound.port}`;
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
  await index.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    void shutdown(signal);
  });
}

await server.finished;
await index.close();
