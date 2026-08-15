import { generateKeyPair, signNode } from "../src/core/sign.ts";
import { computeCid } from "../src/core/cid.ts";
import { dirname } from "node:path";
import type {
  Node,
  ProblemPayload,
  RecipePayload,
  VerificationPayload,
} from "../src/core/types.ts";

const BASE_URL = Deno.env.get("CORPUS_BASE_URL") ?? "http://127.0.0.1:8000";

const NOW = "2026-08-01T00:00:00.000Z";
const STALE_VERIFIED_AT = "2026-05-01T00:00:00.000Z";
const STALE_VALID_UNTIL = "2026-04-15T00:00:00.000Z";

const ID = (n: number): string =>
  `01800000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function usage(): never {
  console.log(
    "usage: corpus-seed [--url URL] [--data-dir DIR]\n" +
      "  --url URL      corpus server base URL (default: CORPUS_BASE_URL or http://127.0.0.1:8000)\n" +
      "  --data-dir DIR directory for demo keys (default: data)",
  );
  Deno.exit(2);
}

function flagsOf(argv: string[]): { url: string; dataDir: string } {
  let url = BASE_URL;
  let dataDir = "data";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--url") {
      url = argv[++i] ?? usage();
    } else if (arg === "--data-dir") {
      dataDir = argv[++i] ?? usage();
    } else {
      usage();
    }
  }
  return { url, dataDir };
}

interface KeyPair {
  publicKeyHex: string;
  secretKeyHex: string;
}

async function loadOrCreateKey(path: string): Promise<KeyPair> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as {
      public_key?: string;
      secret_key?: string;
    };
    if (parsed.public_key && parsed.secret_key) {
      return {
        publicKeyHex: parsed.public_key,
        secretKeyHex: parsed.secret_key,
      };
    }
  } catch {
    // fall through to generating a fresh key
  }
  const key = generateKeyPair();
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(
    path,
    JSON.stringify(
      { public_key: key.publicKeyHex, secret_key: key.secretKeyHex },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${path}`);
  return key;
}

function fail(message: string): never {
  console.error(message);
  Deno.exit(1);
}

async function api(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, init);
  } catch (e) {
    fail(`cannot reach the server at ${url}: ${(e as Error).message}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const errors = (body as {
      errors?: Array<
        { title?: string; detail?: string; source?: { pointer?: string } }
      >;
    })?.errors ?? [];
    const details = errors
      .map((e) =>
        `${e.title}${e.detail ? `: ${e.detail}` : ""}${
          e.source?.pointer ? ` (${e.source.pointer})` : ""
        }`
      )
      .join("; ");
    fail(
      `request to ${path} failed (${res.status}): ${details || res.statusText}`,
    );
  }
  return body;
}

function osk(
  nodeId: string,
  nodeType: Node["osk"]["node_type"],
  publicKey: string,
  status: "active" | "deprecated" | "disputed" | "draft",
  overrides: Partial<Node["osk"]> = {},
): Node["osk"] {
  return {
    version: "0.3.0",
    node_type: nodeType,
    node_id: nodeId,
    knowledge_lifecycle: {
      status,
      last_verified: NOW,
    },
    attribution: { author_type: "agent", public_key: publicKey },
    ...overrides,
  };
}

function problemNode(
  nodeId: string,
  publicKey: string,
  payload: ProblemPayload["problem"],
  status: "active" | "deprecated" | "disputed" | "draft" = "active",
  oskOverrides: Partial<Node["osk"]> = {},
): Node<ProblemPayload> {
  return {
    osk: osk(nodeId, "Problem", publicKey, status, oskOverrides),
    payload: { problem: payload },
  };
}

function recipeNode(
  nodeId: string,
  publicKey: string,
  payload: RecipePayload["recipe"],
): Node<RecipePayload> {
  return {
    osk: osk(nodeId, "Recipe", publicKey, "active"),
    payload: { recipe: payload },
  };
}

function verificationNode(
  nodeId: string,
  publicKey: string,
  problemCid: string,
  solutionCid: string,
  overrides: Partial<VerificationPayload["verification"]> = {},
): Node<VerificationPayload> {
  return {
    osk: osk(nodeId, "Verification", publicKey, "active"),
    payload: {
      verification: {
        target: {
          problem_id: { "/": problemCid },
          solution_id: { "/": solutionCid },
        },
        execution: {
          playground: "sandbox-den",
          environment_hash: "a".repeat(64),
          test_suite: {
            total: 2,
            passed: 2,
            failed: 0,
            cases: [
              { name: "small", expected: "ok", actual: "ok", result: "pass" },
              { name: "large", expected: "ok", actual: "ok", result: "pass" },
            ],
          },
        },
        timestamp: NOW,
        ...overrides,
      },
    },
  };
}

async function stored(cid: string): Promise<boolean> {
  const res = await fetch(`${url}/nodes/${cid}`, {
    headers: { Accept: "application/vnd.api+json" },
  });
  return res.status === 200;
}

async function ingest(type: string, node: Node): Promise<string> {
  const signed = signNode(node, author.secretKeyHex);
  const cid = await computeCid(signed);
  const skip = await stored(cid);
  if (!skip) {
    await api("/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json" },
      body: JSON.stringify({ data: { type, attributes: signed } }),
    });
  }
  console.log(`${skip ? "skipped" : "stored "} ${type} ${cid.slice(0, 12)}`);
  return cid;
}

async function ingestVerification(
  node: Node,
  secretKeyHex: string,
): Promise<void> {
  const signed = signNode(node, secretKeyHex);
  const cid = await computeCid(signed);
  await api("/verifications", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: { type: "verifications", attributes: signed },
    }),
  });
  console.log(`posted  verification ${cid.slice(0, 12)}`);
}

const args = flagsOf(Deno.args);
const url = args.url.replace(/\/+$/, "");
const authorPath = `${args.dataDir}/demo-key.json`;
const verifierPath = `${args.dataDir}/verifier-key.json`;
const reviewerPath = `${args.dataDir}/reviewer-key.json`;
const author = await loadOrCreateKey(authorPath);
const verifier = await loadOrCreateKey(verifierPath);
const reviewer = await loadOrCreateKey(reviewerPath);

console.log(`seeding into ${url} using keys under ${args.dataDir}`);

const recipeCsv = recipeNode(ID(1), author.publicKeyHex, {
  title: "Stream CSV parsing in batches",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const reader = file.readable.getReader();\nlet buffer = '';\nwhile (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n  buffer += new TextDecoder().decode(value);\n  const rows = buffer.split('\\n');\n  buffer = rows.pop() ?? '';\n  for (const row of rows) parse(row);\n}",
  },
  explanation:
    "Read the upload as a stream and parse one row at a time, so memory stays bounded regardless of file size.",
  caveats: [
    {
      condition: "quoted fields contain newlines",
      warning:
        "the split approach needs a real CSV tokenizer for quoted fields.",
    },
  ],
});

const recipeMem = recipeNode(ID(2), author.publicKeyHex, {
  title: "Bound worker memory pools",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const pool = new Map();\nconst MAX = 1024;\nfor (const item of items) {\n  pool.set(item.id, item);\n  if (pool.size > MAX) pool.delete(pool.keys().next().value);\n}",
  },
  explanation:
    "Keep a fixed-size LRU pool per worker so retained objects cannot grow without bound.",
});

const recipeConfig = recipeNode(ID(3), author.publicKeyHex, {
  title: "Validate config against safe defaults",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const cfg = { ...DEFAULTS, ...(parsed ?? {}) };\nif (typeof cfg.timeout !== 'number') throw new Error('invalid timeout');",
  },
  explanation:
    "Merge parsed configuration over built-in defaults and validate types before use, so a missing file cannot yield nulls.",
});

const recipeTz = recipeNode(ID(4), author.publicKeyHex, {
  title: "Timezone-safe scheduler",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const at = new Date(cron);\nif (at.getTimezoneOffset() !== offset) { adjust(at); }",
  },
  explanation:
    "Compute schedule times in UTC and convert only at display time, preventing DST drift.",
});

const rCsv = await ingest("recipes", recipeCsv);
const rMem = await ingest("recipes", recipeMem);
const rConfig = await ingest("recipes", recipeConfig);
const rTz = await ingest("recipes", recipeTz);

const problemCrash = problemNode(
  ID(5),
  author.publicKeyHex,
  {
    title: "Web server crashes on large CSV upload",
    severity: "high",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "the process exits abruptly during upload",
        observable: "exit code 137 on files above 100MB",
        frequency: "always",
      },
    ],
    root_cause: {
      mechanism: "the whole file is buffered in memory before parsing",
      causal_chain: ["buffering", "memory", "oom-killer", "crash"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rCsv } }],
  },
);

const problemLeakV1 = problemNode(
  ID(6),
  author.publicKeyHex,
  {
    title: "Memory usage grows unbounded under sustained load",
    severity: "critical",
    symptoms: [
      {
        type: "performance_degradation",
        description: "resident memory climbs steadily",
        observable: "rss grows ~20MB per hour",
        frequency: "always",
      },
    ],
    root_cause: {
      mechanism: "workers retain every processed item",
      causal_chain: ["retention", "heap", "growth"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
    },
  },
);

const pLeakV1 = await ingest("problems", problemLeakV1);

const problemLeakV2 = problemNode(
  ID(6),
  author.publicKeyHex,
  {
    title: "Memory usage grows unbounded under sustained load",
    severity: "critical",
    symptoms: [
      {
        type: "performance_degradation",
        description: "resident memory climbs steadily",
        observable: "rss grows ~20MB per hour",
        frequency: "always",
      },
    ],
    root_cause: {
      mechanism: "workers retain every processed item",
      causal_chain: ["retention", "heap", "growth"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rMem } }],
  },
  "active",
  { supersedes_cid: { "/": pLeakV1 } },
);

const problemNull = problemNode(
  ID(8),
  author.publicKeyHex,
  {
    title: "Null pointer on empty config file",
    severity: "medium",
    symptoms: [
      {
        type: "error_message",
        description: "server throws on startup",
        observable: "TypeError: Cannot read properties of null",
        frequency: "always",
      },
    ],
    root_cause: {
      mechanism: "no defaults exist for missing sections",
      causal_chain: ["parsing", "null", "throw"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rConfig } }],
  },
  "draft",
);

const problemDeprecated = problemNode(
  ID(9),
  author.publicKeyHex,
  {
    title: "Legacy endpoint returns wrong status codes",
    severity: "medium",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "404s instead of 410 on removed resources",
        observable: "curl returns 404",
        frequency: "always",
      },
    ],
    root_cause: {
      mechanism: "the legacy route handler was never updated",
      causal_chain: ["legacy route", "mapping", "wrong code"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
    },
  },
  "deprecated",
);

const problemTz = problemNode(
  ID(10),
  author.publicKeyHex,
  {
    title: "Scheduler drifts across timezones",
    severity: "low",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "jobs fire one hour late after DST change",
        observable: "cron misses the scheduled minute",
        frequency: "intermittent",
      },
    ],
    root_cause: {
      mechanism: "schedule times are stored in local time",
      causal_chain: ["local time", "dst", "drift"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rTz } }],
  },
);

const pCrash = await ingest("problems", problemCrash);
const pLeakV2 = await ingest("problems", problemLeakV2);
const pNull = await ingest("problems", problemNull);
await ingest("problems", problemDeprecated);
const pTz = await ingest("problems", problemTz);

await ingestVerification(
  verificationNode(ID(11), verifier.publicKeyHex, pCrash, rCsv),
  verifier.secretKeyHex,
);

await ingestVerification(
  verificationNode(ID(12), verifier.publicKeyHex, pLeakV2, rMem),
  verifier.secretKeyHex,
);

await ingestVerification(
  verificationNode(ID(13), reviewer.publicKeyHex, pLeakV2, rMem),
  reviewer.secretKeyHex,
);

await ingestVerification(
  verificationNode(ID(14), verifier.publicKeyHex, pNull, rConfig, {
    execution: {
      playground: "sandbox-den",
      environment_hash: "b".repeat(64),
      test_suite: {
        total: 2,
        passed: 1,
        failed: 1,
        cases: [
          { name: "small", expected: "ok", actual: "ok", result: "pass" },
          { name: "empty", expected: "ok", actual: "throw", result: "fail" },
        ],
      },
    },
  }),
  verifier.secretKeyHex,
);

await ingestVerification(
  verificationNode(ID(15), verifier.publicKeyHex, pTz, rTz, {
    timestamp: STALE_VERIFIED_AT,
    valid_until: STALE_VALID_UNTIL,
  }),
  verifier.secretKeyHex,
);

console.log("seed complete");
