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
  trustProxy: boolean;
  versionsPath: string | undefined;
  replay: "stub" | "trusted-stub" | "sandbox";
  sandboxCmd: string | undefined;
  trustedKeys: string[];
  verificationRateLimit: number;
  maxBodyBytes: number;
  corsOrigins: string[];
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

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw.split(",").map((origin) => origin.trim()).filter(Boolean);
}

function parseTrustProxy(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  throw new ConfigError(
    `invalid CORPUS_TRUST_PROXY=${raw} (use 1, 0, true, or false)`,
  );
}

export function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Config {
  const root = env.CORPUS_DATA_DIR ?? "data";
  const replay = env.CORPUS_REPLAY ?? "stub";
  if (replay !== "stub" && replay !== "trusted-stub" && replay !== "sandbox") {
    throw new ConfigError(
      `unknown CORPUS_REPLAY=${replay} (use stub, trusted-stub, or sandbox)`,
    );
  }
  const trustedKeys = (env.CORPUS_TRUSTED_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return {
    root,
    dbPath: `${root}/corpus.db`,
    blockDir: `${root}/blocks`,
    registryPath: `${root}/registry.json`,
    host: env.CORPUS_HOST ?? "0.0.0.0",
    port: parsePort(env.PORT),
    baseUrl: env.CORPUS_BASE_URL,
    trustProxy: parseTrustProxy(env.CORPUS_TRUST_PROXY),
    versionsPath: env.CORPUS_VERSIONS,
    replay,
    sandboxCmd: env.CORPUS_SANDBOX_CMD,
    trustedKeys,
    verificationRateLimit: Number(env.CORPUS_VERIFICATION_RATE_LIMIT) || 60,
    maxBodyBytes: Number(env.CORPUS_MAX_BODY_BYTES) || 1_048_576,
    corsOrigins: parseOrigins(env.CORPUS_CORS_ORIGINS),
  };
}
