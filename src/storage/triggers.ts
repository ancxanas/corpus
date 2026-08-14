import type { Node } from "../core/types.ts";

export interface VersionPin {
  [scope: string]: string;
}

export function loadPins(path: string | undefined): VersionPin {
  if (!path) {
    return {};
  }
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch {
    return {};
  }
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`version pins file ${path} must contain a JSON object`);
  }
  return parsed as VersionPin;
}

export function cachedVersionPins(path: string | undefined): () => VersionPin {
  let cached: { pins: VersionPin; mtimeMs: number | null } | null = null;
  return () => {
    if (!path) {
      return {};
    }
    let mtimeMs: number | null = null;
    try {
      mtimeMs = Deno.statSync(path).mtime?.getTime() ?? null;
    } catch {
      // file missing or unreadable; reload below to recover when it returns
    }
    if (cached !== null && cached.mtimeMs === mtimeMs) {
      return cached.pins;
    }
    const pins = loadPins(path);
    cached = { pins, mtimeMs };
    return pins;
  };
}

export function deprecationTriggerFired(node: Node, pins: VersionPin): boolean {
  const triggers = node.osk.knowledge_lifecycle.deprecation_triggers ?? [];
  for (const trigger of triggers) {
    const current = pins[trigger.scope];
    if (current === undefined) {
      continue;
    }
    if (
      evaluateCondition(
        current,
        trigger.condition,
        trigger.versioning_scheme ?? "semver",
      )
    ) {
      return true;
    }
  }
  return false;
}

type Op = ">=" | ">" | "<" | "<=" | "=";

function parseCondition(condition: string): { op: Op; version: string } {
  const match = /^(<=|>=|<|>|=)?(.*)$/.exec(condition.trim());
  return { op: (match?.[1] || ">=") as Op, version: (match?.[2] ?? "").trim() };
}

function compareNumbers(a: number, b: number, op: Op): boolean {
  switch (op) {
    case ">=":
      return a >= b;
    case ">":
      return a > b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "=":
      return a === b;
  }
}

function parseParts(v: string): number[] {
  return v.split(".").map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

function compareLists(a: number[], b: number[], op: Op): boolean {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) {
      return compareNumbers(av, bv, op);
    }
  }
  return op === "=" || op === "<=" || op === ">=";
}

function evaluateCondition(
  current: string,
  condition: string,
  scheme: string,
): boolean {
  const { op, version } = parseCondition(condition);
  switch (scheme) {
    case "year": {
      const a = Number.parseInt(current, 10);
      const b = Number.parseInt(version, 10);
      return Number.isNaN(a) || Number.isNaN(b)
        ? false
        : compareNumbers(a, b, op);
    }
    case "calver":
      return compareLists(
        parseParts(current).slice(0, 2),
        parseParts(version).slice(0, 2),
        op,
      );
    case "custom":
      return op === "=" && current === version;
    default:
      return compareLists(
        parseParts(current).slice(0, 3),
        parseParts(version).slice(0, 3),
        op,
      );
  }
}
