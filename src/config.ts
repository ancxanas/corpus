export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  root: string;
  dbPath: string;
  blockDir: string;
  registryPath: string;
  host: string;
  port: number;
  baseUrl: string | undefined;
  versionsPath: string | undefined;
  replay: "stub" | "sandbox";
  sandboxCmd: string | undefined;
  maxBodyBytes: number;
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `invalid PORT=${raw} (use an integer between 1 and 65535)`,
    );
  }
  return port;
}

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Config {
  const root = env.CORPUS_DATA_DIR ?? "data";
  const replay = env.CORPUS_REPLAY ?? "stub";
  if (replay !== "stub" && replay !== "sandbox") {
    throw new ConfigError(
      `unknown CORPUS_REPLAY=${replay} (use stub or sandbox)`,
    );
  }
  return {
    root,
    dbPath: `${root}/corpus.db`,
    blockDir: `${root}/blocks`,
    registryPath: `${root}/registry.json`,
    host: env.CORPUS_HOST ?? "0.0.0.0",
    port: parsePort(env.PORT),
    baseUrl: env.CORPUS_BASE_URL,
    versionsPath: env.CORPUS_VERSIONS,
    replay,
    sandboxCmd: env.CORPUS_SANDBOX_CMD,
    maxBodyBytes: Number(env.CORPUS_MAX_BODY_BYTES) || 1_048_576,
  };
}
