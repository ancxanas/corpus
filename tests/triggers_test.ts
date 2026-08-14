import { assertEquals, assertThrows } from "@std/assert";
import { cachedVersionPins, loadPins } from "../src/storage/triggers.ts";

function tempPinPath(): string {
  return `/tmp/opencode/corpus-pins-${crypto.randomUUID()}.json`;
}

Deno.test("loadPins reads a JSON object", () => {
  const path = tempPinPath();
  Deno.writeTextFileSync(path, JSON.stringify({ python: "3.12.1" }));
  assertEquals(loadPins(path), { python: "3.12.1" });
  Deno.removeSync(path);
});

Deno.test("loadPins returns empty pins when the file is absent", () => {
  assertEquals(loadPins("/tmp/opencode/does-not-exist.json"), {});
});

Deno.test("loadPins throws on invalid JSON", () => {
  const path = tempPinPath();
  Deno.writeTextFileSync(path, "not json");
  assertThrows(() => loadPins(path));
  Deno.removeSync(path);
});

Deno.test("loadPins throws when the root value is not an object", () => {
  const path = tempPinPath();
  Deno.writeTextFileSync(path, "[1, 2]");
  assertThrows(() => loadPins(path));
  Deno.removeSync(path);
});

Deno.test("cachedVersionPins reloads when the file changes", () => {
  const path = tempPinPath();
  Deno.writeTextFileSync(path, JSON.stringify({ python: "3.12" }));
  const pins = cachedVersionPins(path);
  assertEquals(pins(), { python: "3.12" });
  assertEquals(pins(), { python: "3.12" });
  Deno.writeTextFileSync(path, JSON.stringify({ python: "3.13.0" }));
  const updated = pins();
  assertEquals(updated, { python: "3.13.0" });
  Deno.removeSync(path);
});

Deno.test("cachedVersionPins with no path stays empty", () => {
  const pins = cachedVersionPins(undefined);
  assertEquals(pins(), {});
  assertEquals(pins(), {});
});
