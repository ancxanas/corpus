import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { ConfigError, loadConfig } from "../src/config.ts";

const BASE_ENV: Record<string, string> = {
  CORPUS_DATA_DIR: "/tmp/data",
  PORT: "8123",
  CORPUS_HOST: "127.0.0.1",
  CORPUS_BASE_URL: "https://corpus.example",
  CORPUS_VERSIONS: "/tmp/pins.json",
  CORPUS_REPLAY: "sandbox",
  CORPUS_SANDBOX_CMD: "/bin/true --flag",
  CORPUS_MAX_BODY_BYTES: "2048",
};

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...BASE_ENV, ...overrides };
}

Deno.test("loadConfig reads every variable", () => {
  const c = loadConfig(env());
  assertEquals(c.root, "/tmp/data");
  assertEquals(c.dbPath, "/tmp/data/corpus.db");
  assertEquals(c.blockDir, "/tmp/data/blocks");
  assertEquals(c.registryPath, "/tmp/data/registry.json");
  assertEquals(c.host, "127.0.0.1");
  assertEquals(c.port, 8123);
  assertEquals(c.baseUrl, "https://corpus.example");
  assertEquals(c.versionsPath, "/tmp/pins.json");
  assertEquals(c.replay, "sandbox");
  assertEquals(c.sandboxCmd, "/bin/true --flag");
  assertEquals(c.maxBodyBytes, 2048);
});

Deno.test("loadConfig applies defaults", () => {
  const c = loadConfig({});
  assertEquals(c.root, "data");
  assertEquals(c.dbPath, "data/corpus.db");
  assertEquals(c.host, "0.0.0.0");
  assertEquals(c.port, 8000);
  assertEquals(c.baseUrl, undefined);
  assertEquals(c.versionsPath, undefined);
  assertEquals(c.replay, "stub");
  assertEquals(c.sandboxCmd, undefined);
  assertEquals(c.maxBodyBytes, 1_048_576);
});

Deno.test("loadConfig rejects a non-numeric PORT", () => {
  assertThrows(() => loadConfig(env({ PORT: "abc" })), ConfigError);
});

Deno.test("loadConfig rejects a PORT out of range", () => {
  assertThrows(() => loadConfig(env({ PORT: "70000" })), ConfigError);
  assertThrows(() => loadConfig(env({ PORT: "0" })), ConfigError);
});

Deno.test("loadConfig rejects an unknown replay mode", () => {
  assertThrows(() => loadConfig(env({ CORPUS_REPLAY: "jail" })), ConfigError);
});

Deno.test("loadConfig falls back to the default body limit on garbage input", () => {
  const c = loadConfig(env({ CORPUS_MAX_BODY_BYTES: "nope" }));
  assertEquals(c.maxBodyBytes, 1_048_576);
});

Deno.test("ConfigError has the expected name", () => {
  const err = new ConfigError("boom");
  assertInstanceOf(err, Error);
  assertEquals(err.name, "ConfigError");
  assertEquals(err.message, "boom");
});
