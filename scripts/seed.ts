import { generateKeyPair, signNode } from "../src/core/sign.ts";
import { computeCid } from "../src/core/cid.ts";
import { dirname } from "node:path";
import type {
  BlueprintPayload,
  ComparisonPayload,
  GuidePayload,
  ImprovementPayload,
  Node,
  ProblemPayload,
  RecipePayload,
  ReferencePayload,
  VerificationPayload,
} from "../src/core/types.ts";

const BASE_URL = Deno.env.get("CORPUS_BASE_URL") ?? "http://127.0.0.1:8000";

const NOW = "2026-08-01T00:00:00.000Z";
const STALE_VERIFIED_AT = "2026-05-01T00:00:00.000Z";
const STALE_VALID_UNTIL = "2026-04-15T00:00:00.000Z";
const V_CSV = "2026-06-20T10:00:00.000Z";
const V_CONFIG = "2026-06-15T12:00:00.000Z";
const V_MEM = "2026-06-22T11:00:00.000Z";
const V_MEM_REVIEW = "2026-07-01T09:00:00.000Z";
const V_RETRIES = "2026-07-05T08:00:00.000Z";
const V_RETRIES2 = "2026-07-06T10:00:00.000Z";
const V_QUEUE = "2026-07-15T14:00:00.000Z";
const V_BINARY = "2026-07-20T16:00:00.000Z";
const V_MEM3 = "2026-07-25T09:00:00.000Z";
const V_CSV_PEER = "2026-07-28T09:00:00.000Z";
const V_JSON_A = "2026-08-02T08:00:00.000Z";
const V_JSON_B = "2026-08-03T09:00:00.000Z";
const V_JSON_B2 = "2026-08-03T14:00:00.000Z";

const ENV_A = "a".repeat(64);
const ENV_B = "b".repeat(64);
const ENV_C = "c".repeat(64);

const ID = (n: number): string =>
  `01800000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function usage(): never {
  console.log(
    "usage: corpus-seed [--url URL] [--data-dir DIR]\n" +
      "  --url URL      corpus server base URL (default: CORPUS_BASE_URL or http://127.0.0.1:8000)\n" +
      "  --data-dir DIR directory for the keys (default: data)\n" +
      "\n" +
      "The seed stores a deterministic dataset through the running server.\n" +
      "It never deletes data. Re-running it skips nodes that already exist.\n" +
      "For a clean slate, stop the server, delete corpus.db* and blocks/ under\n" +
      "--data-dir, start the server, then seed.",
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
  status: "active" | "deprecated" | "disputed" | "draft" = "active",
  oskOverrides: Partial<Node["osk"]> = {},
): Node<RecipePayload> {
  return {
    osk: osk(nodeId, "Recipe", publicKey, status, oskOverrides),
    payload: { recipe: payload },
  };
}

function guideNode(
  nodeId: string,
  publicKey: string,
  payload: GuidePayload["guide"],
): Node<GuidePayload> {
  return {
    osk: osk(nodeId, "Guide", publicKey, "active"),
    payload: { guide: payload },
  };
}

function comparisonNode(
  nodeId: string,
  publicKey: string,
  payload: ComparisonPayload["comparison"],
): Node<ComparisonPayload> {
  return {
    osk: osk(nodeId, "Comparison", publicKey, "active"),
    payload: { comparison: payload },
  };
}

function referenceNode(
  nodeId: string,
  publicKey: string,
  payload: ReferencePayload["reference"],
): Node<ReferencePayload> {
  return {
    osk: osk(nodeId, "Reference", publicKey, "active"),
    payload: { reference: payload },
  };
}

function improvementNode(
  nodeId: string,
  publicKey: string,
  payload: ImprovementPayload["improvement"],
): Node<ImprovementPayload> {
  return {
    osk: osk(nodeId, "Improvement", publicKey, "active"),
    payload: { improvement: payload },
  };
}

function blueprintNode(
  nodeId: string,
  publicKey: string,
  payload: BlueprintPayload["blueprint"],
): Node<BlueprintPayload> {
  return {
    osk: osk(nodeId, "Blueprint", publicKey, "active"),
    payload: { blueprint: payload },
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
          environment_hash: ENV_A,
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

const CTX_VERIFIER = {
  model: "claude-sonnet-4",
  context_window_size: 200_000,
  context_window_used: 82_000,
  tool_count: 12,
  reasoning_chain_length: 18,
};

const CTX_REVIEWER = {
  model: "claude-opus-4",
  context_window_size: 200_000,
  context_window_used: 145_000,
  tool_count: 9,
  reasoning_chain_length: 26,
};

const CTX_PEER = {
  model: "gpt-5",
  context_window_size: 400_000,
  context_window_used: 210_000,
  tool_count: 15,
  reasoning_chain_length: 22,
};

const MEAS_STREAMING = [
  {
    name: "peak_memory",
    value: 48,
    unit: "MB",
    description: "Peak resident memory during a 150MB upload",
  },
  {
    name: "throughput",
    value: 182_000,
    unit: "rows/s",
    description: "CSV rows parsed per second",
  },
];

const MEAS_PAGINATION = [
  {
    name: "p99_latency",
    value: 38,
    unit: "ms",
    description: "99th percentile response latency",
  },
  {
    name: "memory_delta",
    value: 4.2,
    unit: "MB",
    description: "Heap growth across 10,000 pages",
  },
];

const MEAS_POOL = [
  {
    name: "peak_heap",
    value: 22,
    unit: "MB",
    description: "Peak heap across the soak run",
  },
  {
    name: "leak_rate",
    value: 0,
    unit: "KB/s",
    description: "Steady-state leak after warmup",
  },
];

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
const peerPath = `${args.dataDir}/peer-key.json`;

const author = await loadOrCreateKey(authorPath);
const verifier = await loadOrCreateKey(verifierPath);
const reviewer = await loadOrCreateKey(reviewerPath);
const peer = await loadOrCreateKey(peerPath);

console.log(`seeding into ${url} using keys under ${args.dataDir}`);

const recipeCsv = recipeNode(ID(1), author.publicKeyHex, {
  title: "Stream CSV parsing in batches",
  summary:
    "Parse large CSV uploads one row at a time so memory stays flat regardless of file size.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const reader = file.readable.getReader();\nlet buffer = '';\nwhile (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n  buffer += new TextDecoder().decode(value);\n  const rows = buffer.split('\\n');\n  buffer = rows.pop() ?? '';\n  for (const row of rows) parse(row);\n}",
  },
  explanation:
    "Read the upload as a stream and parse one row at a time, so memory stays bounded regardless of file size.",
  prerequisites: [
    {
      description: "The web server must expose the request body as a stream.",
    },
    {
      description: "For quoted CSV fields, pair this with a real tokenizer.",
    },
  ],
  steps: [
    {
      title: "Open a reader on the body stream",
      body:
        "Use a ReadableStream reader so chunks arrive incrementally instead of buffering the whole file.",
      code: "const reader = file.readable.getReader();",
    },
    {
      title: "Split each chunk into complete rows",
      body:
        "Keep a trailing partial row in a buffer between chunks, then parse the complete rows.",
      code:
        "const rows = buffer.split('\\n');\nbuffer = rows.pop() ?? '';\nfor (const row of rows) parse(row);",
    },
    {
      title: "Verify memory stays bounded",
      body:
        "Run the handler against a 500MB fixture and watch resident memory during the upload.",
    },
  ],
  verification: "A 500MB CSV upload parses with resident memory below 64MB.",
  caveats: [
    {
      condition: "quoted fields contain newlines",
      warning:
        "the split approach needs a real CSV tokenizer for quoted fields.",
    },
  ],
  tags: ["streaming", "csv", "memory"],
  references: [{
    title: "WHATWG Streams Standard",
    url: "https://streams.spec.whatwg.org/",
  }, {
    title: "MDN: ReadableStream",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream",
  }],
});

const recipeMem = recipeNode(ID(2), author.publicKeyHex, {
  title: "Bound worker memory pools",
  summary:
    "Keep a fixed-size eviction pool per worker so retained objects cannot grow without bound.",
  code: {
    language: "python",
    framework: "flask",
    body:
      "from collections import OrderedDict\n\npool = OrderedDict()\nMAX = 1024\nfor item in items:\n    pool[item.id] = item\n    if len(pool) > MAX:\n        pool.popitem(last=False)",
  },
  explanation:
    "Keep a fixed-size FIFO eviction pool per worker so retained objects cannot grow without bound.",
  prerequisites: [
    {
      description: "Each worker keeps its own pool; no shared state.",
    },
  ],
  steps: [
    {
      title: "Insert with a size cap",
      body:
        "Every insert evicts the oldest entry once the pool exceeds the cap.",
      code: "if len(pool) > MAX: pool.popitem(last=False)",
    },
    {
      title: "Track pool size as a metric",
      body:
        "Export the current pool size so growth shows up in monitoring before it matters.",
    },
  ],
  verification:
    "Sustained load keeps the pool metric pinned at the cap of 1024.",
  caveats: [
    {
      condition: "the working set exceeds the cap",
      warning: "raise the cap deliberately; eviction silently drops old items.",
    },
  ],
  tags: ["memory", "workers", "fifo"],
  references: [{
    title: "Python: collections — container datatypes",
    url: "https://docs.python.org/3/library/collections.html",
  }],
});

const recipeConfig = recipeNode(ID(3), author.publicKeyHex, {
  title: "Validate config against safe defaults",
  summary:
    "Merge parsed configuration over built-in defaults and type-check before use, so missing files cannot yield nulls.",
  code: {
    language: "typescript",
    framework: "express",
    body:
      "const cfg = { ...DEFAULTS, ...(parsed ?? {}) };\nif (typeof cfg.timeout !== 'number') throw new Error('invalid timeout');",
  },
  explanation:
    "Merge parsed configuration over built-in defaults and validate types before use, so a missing file cannot yield nulls.",
  prerequisites: [
    {
      description: "A DEFAULTS object exists with every option typed.",
    },
  ],
  steps: [
    {
      title: "Start from defaults",
      body:
        "Spread DEFAULTS first so every option has a value even when the file is empty.",
      code: "const cfg = { ...DEFAULTS, ...(parsed ?? {}) };",
    },
    {
      title: "Type-check the merge",
      body:
        "Reject non-numeric timeouts and other malformed values with a clear error.",
      code:
        "if (typeof cfg.timeout !== 'number') throw new Error('invalid timeout');",
    },
  ],
  verification:
    "Starting the server with a missing config file boots with defaults and never throws a null error.",
  caveats: [
    {
      condition: "a config key has no default",
      warning: "add it to DEFAULTS or validation fails at runtime.",
    },
  ],
  tags: ["config", "validation", "defaults"],
  references: [{
    title: "12-Factor Config",
    url: "https://12factor.net/config",
  }],
});

const recipeTz = recipeNode(ID(4), author.publicKeyHex, {
  title: "Timezone-safe scheduler",
  summary:
    "Compute schedule times in UTC and convert only at display time, preventing DST drift.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const at = new Date(cron);\nif (at.getTimezoneOffset() !== offset) { adjust(at); }",
  },
  explanation:
    "Compute schedule times in UTC and convert only at display time, preventing DST drift.",
  prerequisites: [
    {
      description: "Cron strings are parsed with an explicit timezone.",
    },
  ],
  steps: [
    {
      title: "Store schedule times in UTC",
      body:
        "Persist instants as UTC strings and convert to local time only when rendering.",
      code: "const at = new Date(cron);",
    },
    {
      title: "Recompute offsets at run time",
      body:
        "Compare the stored offset against the current one and adjust before firing.",
      code: "if (at.getTimezoneOffset() !== offset) { adjust(at); }",
    },
  ],
  verification:
    "A job scheduled across a DST boundary fires at the same UTC instant before and after the change.",
  caveats: [
    {
      condition: "users in multiple timezones share one schedule",
      warning:
        "decide whether the instant or the wall-clock time is the source of truth.",
    },
  ],
  tags: ["time", "timezones", "cron"],
  references: [{
    title: "IANA Time Zone Database",
    url: "https://www.iana.org/time-zones",
  }],
});

const recipeRetriesV1 = recipeNode(
  ID(5),
  author.publicKeyHex,
  {
    title: "Fixed-interval retries",
    summary:
      "Retry failed HTTP calls on a fixed timer, which staggers load poorly under outages.",
    code: {
      language: "typescript",
      framework: "express",
      body:
        "for (let attempt = 1; ; attempt++) {\n  const res = await fetch(url, opts);\n  if (res.status < 500 && res.status !== 429) return res;\n  if (attempt >= MAX_ATTEMPTS) throw new Error('retries exhausted');\n  await sleep(FIXED_MS);\n}",
    },
    explanation:
      "Retry at a fixed interval, which is simple but can pile all retries onto the same instant.",
    prerequisites: [
      {
        description: "The HTTP client reports response status codes.",
      },
    ],
    steps: [
      {
        title: "Retry on retryable statuses",
        body:
          "Treat 5xx and 429 as retryable, then wait a fixed delay between attempts.",
      },
      {
        title: "Cap the attempt count",
        body:
          "Fail loudly after a maximum so the caller can surface an outage.",
      },
    ],
    verification:
      "A brief upstream outage recovers, but a fleet of clients all retry in lockstep.",
    caveats: [
      {
        condition: "many clients fail at once",
        warning: "fixed intervals synchronize retries into a thundering herd.",
      },
    ],
    tags: ["http", "retries", "backoff"],
    references: [{
      title: "RFC 9110: Retry-After",
      url: "https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3",
    }],
  },
  "deprecated",
);

const rRetriesV1 = await ingest("recipes", recipeRetriesV1);

const recipeRetriesV2 = recipeNode(
  ID(5),
  author.publicKeyHex,
  {
    title: "Exponential backoff with jitter",
    summary:
      "Double the delay on each retry and add random jitter, so a fleet of clients never retries in lockstep.",
    code: {
      language: "typescript",
      framework: "express",
      body:
        "for (let attempt = 1; ; attempt++) {\n  const res = await fetch(url, opts);\n  if (res.status < 500 && res.status !== 429) return res;\n  if (attempt > MAX_ATTEMPTS) throw new Error('retries exhausted');\n  const base = BASE_MS * 2 ** (attempt - 1);\n  const jitter = Math.floor(Math.random() * base * 0.2);\n  await sleep(Math.min(base + jitter, MAX_BACKOFF_MS));\n}",
    },
    explanation:
      "Exponential growth spaces out attempts and jitter breaks synchronization across clients.",
    prerequisites: [
      {
        description: "A predictable failure mode that needs a bounded wait.",
        node: { "/": rRetriesV1 },
      },
    ],
    steps: [
      {
        title: "Grow the delay geometrically",
        body:
          "Double the base delay after each failed attempt, clamped to a maximum.",
      },
      {
        title: "Add jitter to each wait",
        body:
          "Randomize the delay within a fraction so simultaneous clients diverge.",
      },
      {
        title: "Respect Retry-After when present",
        body:
          "Prefer the server's Retry-After header over your own backoff schedule.",
      },
    ],
    verification:
      "A 60-second upstream outage clears in under 10 seconds of wall time with at most 6 attempts.",
    caveats: [
      {
        condition: "the upstream returns 429 with Retry-After",
        warning: "honor the header; it may exceed your computed backoff.",
      },
    ],
    tags: ["http", "retries", "backoff", "jitter"],
    references: [{
      title: "AWS: Exponential Backoff and Jitter",
      url:
        "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
    }, {
      title: "RFC 9110: 429 Too Many Requests",
      url: "https://www.rfc-editor.org/rfc/rfc9110#section-15.5.32",
    }],
  },
  "active",
  { supersedes_cid: { "/": rRetriesV1 } },
);

const recipeQueue = recipeNode(ID(6), author.publicKeyHex, {
  title: "Bounded async queue with backpressure",
  summary:
    "Cap the number of in-flight items and block producers when the queue is full, so workers never starve memory.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const queue = new AsyncQueue(CAPACITY);\nfor await (const item of source) {\n  await queue.push(item); // blocks when full -> backpressure\n}\nawait queue.close();\nfor await (const item of queue.reader()) {\n  await worker(item);\n}",
  },
  explanation:
    "A bounded queue plus an await on push gives the producer backpressure, keeping memory and concurrency predictable.",
  prerequisites: [
    {
      description: "Workers must not hold shared mutable state.",
    },
    {
      description:
        "Bound worker memory pools first so each worker's retained set stays small.",
    },
  ],
  steps: [
    {
      title: "Create a queue with a capacity cap",
      body:
        "Bound the number of pending items so the queue cannot grow without limit.",
    },
    {
      title: "Await push to apply backpressure",
      body:
        "When the queue is full, the producer awaits instead of buffering more input.",
      code: "await queue.push(item);",
    },
    {
      title: "Drain in order on the consumer side",
      body: "Read items in FIFO order and process them one worker at a time.",
    },
  ],
  verification:
    "A producer that outruns workers never exceeds the queue cap; the workers catch up steadily.",
  caveats: [
    {
      condition: "a single slow worker stalls the queue",
      warning:
        "backpressure pauses the producer, which may be the desired behavior.",
    },
  ],
  tags: ["queue", "backpressure", "workers", "concurrency"],
  references: [{
    title: "WHATWG Streams Standard",
    url: "https://streams.spec.whatwg.org/",
  }],
});

const recipeBinary = recipeNode(ID(7), author.publicKeyHex, {
  title: "Binary-safe buffer handling",
  summary:
    "Process upload bytes as Uint8Array instead of decoding to text, so binary payloads survive intact.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const bytes = new Uint8Array(await response.arrayBuffer());\nconst header = bytes.slice(0, 4);\nif (header[0] !== 0x89) throw new Error('not a valid header');",
  },
  explanation:
    "Text decoders replace invalid sequences with U+FFFD. Operating on bytes preserves the payload exactly.",
  prerequisites: [
    {
      description: "The server must accept binary request bodies.",
    },
  ],
  steps: [
    {
      title: "Read the raw bytes",
      body:
        "Use arrayBuffer or a byte stream instead of decoding the body to a string.",
      code: "const bytes = new Uint8Array(await response.arrayBuffer());",
    },
    {
      title: "Inspect the magic header",
      body:
        "Validate binary formats by their magic bytes rather than textual content.",
    },
  ],
  verification:
    "A round-trip of a 10MB binary upload returns byte-identical content.",
  caveats: [
    {
      condition: "the format mixes text and binary",
      warning: "decode only the fields that are genuinely textual.",
    },
  ],
  tags: ["binary", "buffer", "encoding"],
  references: [{
    title: "MDN: Uint8Array",
    url:
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array",
  }, {
    title: "MDN: TextDecoder",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder",
  }],
});

const rCsv = await ingest("recipes", recipeCsv);
const rMem = await ingest("recipes", recipeMem);
const rConfig = await ingest("recipes", recipeConfig);
const rTz = await ingest("recipes", recipeTz);
const rRetriesV2 = await ingest("recipes", recipeRetriesV2);
const rQueue = await ingest("recipes", recipeQueue);
const rBinary = await ingest("recipes", recipeBinary);

const problemCrash = problemNode(
  ID(8),
  author.publicKeyHex,
  {
    title: "Web server crashes on large CSV upload",
    severity: "high",
    summary:
      "Uploads above 100MB kill the process because the server buffers the entire file in memory before parsing.",
    impact:
      "Users lose in-flight work, the process restarts with an empty cache, and support tickets cluster around large import jobs.",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "the process exits abruptly during upload",
        observable: "exit code 137 on files above 100MB",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Generate a 150MB fixture",
        body: "Create a CSV with several million rows and a realistic header.",
      },
      {
        title: "Upload it through the web form",
        body:
          "Watch resident memory climb to the container limit, then observe the process exit with code 137.",
      },
    ],
    diagnosis: [
      {
        title: "Confirm the buffering",
        body:
          "Start the server with --max-old-space-size=64 and upload the same file; the crash moves earlier, proving memory is the constraint.",
      },
    ],
    root_cause: {
      mechanism: "the whole file is buffered in memory before parsing",
      causal_chain: ["buffering", "memory", "oom-killer", "crash"],
    },
    environment: {
      runtime: { type: "deno", versions: ["2.x"] },
      framework: { name: "deno", version: "2.x" },
      agent_context: {
        model: "gpt-4o",
        context_window_size: 128000,
        context_window_used: 42000,
        tool_count: 4,
        reasoning_chain_length: 3,
      },
    },
    solutions: [{ node: { "/": rCsv } }],
    tags: ["streaming", "memory", "csv"],
    references: [{
      title: "MDN: ReadableStream",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream",
    }],
  },
);

const problemLeakV1 = problemNode(
  ID(9),
  author.publicKeyHex,
  {
    title: "Memory usage grows unbounded under sustained load",
    severity: "critical",
    summary:
      "Resident memory climbs about 20MB per hour until the process is recycled, making long-running workers unreliable.",
    impact:
      "Workers are force-restarted on a timer, in-flight batches fail, and the heap grows fast enough to page out.",
    symptoms: [
      {
        type: "performance_degradation",
        description: "resident memory climbs steadily",
        observable: "rss grows ~20MB per hour",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Run sustained load",
        body: "Feed the worker one batch per minute for six hours.",
      },
      {
        title: "Sample rss hourly",
        body:
          "Record the resident set each hour; the slope is steady and positive.",
      },
    ],
    diagnosis: [
      {
        title: "Take a heap snapshot",
        body:
          "Compare two snapshots an hour apart and diff the retained object counts by class.",
      },
    ],
    root_cause: {
      mechanism: "workers retain every processed item",
      causal_chain: ["retention", "heap", "growth"],
    },
    environment: {
      runtime: { type: "python", versions: ["3.12"] },
      framework: { name: "flask", version: "3.x" },
    },
  },
);

const pLeakV1 = await ingest("problems", problemLeakV1);

const problemLeakV2 = problemNode(
  ID(9),
  author.publicKeyHex,
  {
    title: "Memory usage grows unbounded under sustained load",
    severity: "critical",
    summary:
      "Resident memory climbs about 20MB per hour until the process is recycled, making long-running workers unreliable.",
    impact:
      "Workers are force-restarted on a timer, in-flight batches fail, and the heap grows fast enough to page out.",
    symptoms: [
      {
        type: "performance_degradation",
        description: "resident memory climbs steadily",
        observable: "rss grows ~20MB per hour",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Run sustained load",
        body: "Feed the worker one batch per minute for six hours.",
      },
      {
        title: "Sample rss hourly",
        body:
          "Record the resident set each hour; the slope is steady and positive.",
      },
    ],
    diagnosis: [
      {
        title: "Take a heap snapshot",
        body:
          "Compare two snapshots an hour apart and diff the retained object counts by class.",
      },
    ],
    root_cause: {
      mechanism: "workers retain every processed item",
      causal_chain: ["retention", "heap", "growth"],
    },
    environment: {
      runtime: { type: "python", versions: ["3.12"] },
      framework: { name: "flask", version: "3.x" },
    },
    solutions: [{ node: { "/": rMem } }],
  },
  "active",
  { supersedes_cid: { "/": pLeakV1 } },
);

const problemNull = problemNode(
  ID(10),
  author.publicKeyHex,
  {
    title: "Null pointer on empty config file",
    severity: "medium",
    summary:
      "A missing or empty config file makes the server dereference null on startup and crash before serving traffic.",
    impact:
      "Deploys fail on fresh machines where the config file has not been created yet.",
    symptoms: [
      {
        type: "error_message",
        description: "server throws on startup",
        observable: "TypeError: Cannot read properties of null",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Start with no config file",
        body: "Remove config.json and boot the server.",
      },
      {
        title: "Observe the throw",
        body:
          "The startup log shows the null TypeError and the process exits nonzero.",
      },
    ],
    diagnosis: [
      {
        title: "Trace the config read",
        body: "Set a breakpoint where parsed is read and confirm it is null.",
      },
    ],
    root_cause: {
      mechanism: "no defaults exist for missing sections",
      causal_chain: ["parsing", "null", "throw"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "express", version: "5.x" },
    },
    solutions: [{ node: { "/": rConfig } }],
    tags: ["config", "startup", "null"],
    references: [{
      title: "ECMAScript: null",
      url: "https://tc39.es/ecma262/#sec-null-value",
    }],
  },
  "draft",
);

const problemLegacy = problemNode(
  ID(11),
  author.publicKeyHex,
  {
    title: "Legacy endpoint returns wrong status codes",
    severity: "medium",
    summary:
      "Removed resources answer 404 instead of 410, so clients keep polling a resource that is gone for good.",
    impact:
      "Client code can never distinguish a missing resource from a retired one, delaying cleanup of dead references.",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "404s instead of 410 on removed resources",
        observable: "curl returns 404",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Fetch a retired resource",
        body: "curl the URL of a resource deleted before the migration.",
      },
      {
        title: "Check the status",
        body: "The server answers 404 with no Gone header.",
      },
    ],
    diagnosis: [
      {
        title: "Inspect the route table",
        body: "Confirm the legacy handler maps the path to a generic fallback.",
      },
    ],
    root_cause: {
      mechanism: "the legacy route handler was never updated",
      causal_chain: ["legacy route", "mapping", "wrong code"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "express", version: "5.x" },
    },
    tags: ["http", "legacy"],
    references: [{
      title: "RFC 9110: 410 Gone",
      url: "https://www.rfc-editor.org/rfc/rfc9110#section-15.4.11",
    }],
  },
  "deprecated",
);

const problemTz = problemNode(
  ID(12),
  author.publicKeyHex,
  {
    title: "Scheduler drifts across timezones",
    severity: "low",
    summary:
      "Jobs fire an hour late after a DST change because schedule times are stored in local wall-clock time.",
    impact:
      "Scheduled reports arrive late once per year, and users in other timezones see inconsistent run times.",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "jobs fire one hour late after DST change",
        observable: "cron misses the scheduled minute",
        frequency: "intermittent",
      },
    ],
    reproduction: [
      {
        title: "Cross a DST boundary",
        body: "Leave the scheduler running through a fall-back transition.",
      },
      {
        title: "Watch the next run",
        body: "The job fires one hour after the configured minute.",
      },
    ],
    diagnosis: [
      {
        title: "Log the resolved instant",
        body:
          "Print the UTC instant the scheduler computes; it shifts by the offset change.",
      },
    ],
    root_cause: {
      mechanism: "schedule times are stored in local time",
      causal_chain: ["local time", "dst", "drift"],
    },
    environment: {
      runtime: { type: "deno", versions: ["2.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rTz } }],
    tags: ["time", "timezones", "cron"],
    references: [{
      title: "The TZ database",
      url: "https://en.wikipedia.org/wiki/Tz_database",
    }],
  },
);

const problemRetries = problemNode(
  ID(13),
  author.publicKeyHex,
  {
    title: "Retries hammer the upstream API on 429",
    severity: "high",
    summary:
      "A fleet of clients retries fixed-interval, so a rate-limited upstream collapses under a synchronized retry storm.",
    impact:
      "The upstream API throttles the account, batches fail in waves, and the incident spreads to unrelated tenants.",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "all clients retry at the same instant",
        observable:
          "upstream logs show periodic 429 spikes every fixed interval",
        frequency: "race_condition",
      },
    ],
    reproduction: [
      {
        title: "Simulate a rate-limited upstream",
        body: "Route the service at a stub that returns 429 for 30 seconds.",
      },
      {
        title: "Start several clients at once",
        body:
          "Launch five clients against the stub and observe them all retry on the same tick.",
      },
    ],
    diagnosis: [
      {
        title: "Correlate timestamps",
        body:
          "Overlay client retry logs with upstream 429 counts; the spikes line up exactly.",
      },
    ],
    root_cause: {
      mechanism: "fixed-interval retries synchronize across clients",
      causal_chain: ["retries", "lockstep", "thundering herd", "429"],
    },
    environment: {
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "express", version: "5.x" },
    },
    solutions: [{ node: { "/": rRetriesV2 } }],
    tags: ["http", "retries", "backoff", "429"],
    references: [{
      title: "RFC 9110: Retry-After",
      url: "https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3",
    }],
  },
);

const problemDeadlock = problemNode(
  ID(14),
  author.publicKeyHex,
  {
    title: "Worker pool deadlocks when queue fills",
    severity: "critical",
    summary:
      "When the task queue reaches capacity, producers wait forever and workers wait for producers, stalling the pool.",
    impact:
      "Jobs time out silently, the pool shows full CPU at zero progress, and operators must recycle the process.",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "pool stalls with no progress",
        observable: "pending count is frozen at the queue cap for minutes",
        frequency: "intermittent",
      },
    ],
    reproduction: [
      {
        title: "Flood the pool",
        body: "Enqueue more tasks than the pool can drain before the timeout.",
      },
      {
        title: "Wait past the stall",
        body:
          "The pending counter stays pinned at capacity and no task completes.",
      },
    ],
    diagnosis: [
      {
        title: "Dump the task graph",
        body:
          "A task dump shows producers blocked on a full queue while workers wait on producers.",
      },
    ],
    root_cause: {
      mechanism:
        "an unbounded producer waits on a full queue with no backpressure",
      causal_chain: ["queue", "capacity", "backpressure", "deadlock"],
    },
    environment: {
      runtime: { type: "deno", versions: ["2.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rQueue } }],
    tags: ["queue", "deadlock", "concurrency"],
    references: [{
      title: "WHATWG Streams Standard",
      url: "https://streams.spec.whatwg.org/",
    }],
  },
);

const problemBinary = problemNode(
  ID(15),
  author.publicKeyHex,
  {
    title: "Binary payload corrupted by text decoding",
    severity: "high",
    summary:
      "Uploaded binary files pass through a text decoder, which rewrites invalid sequences and corrupts the payload.",
    impact:
      "Stored files fail integrity checks, users receive corrupted downloads, and support cannot reproduce byte diffs.",
    symptoms: [
      {
        type: "error_message",
        description: "downloaded files fail checksum",
        observable: "sha256 of the round-tripped file differs from the upload",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Upload a binary fixture",
        body: "Send a 10MB file with random bytes through the ingestion path.",
      },
      {
        title: "Download and hash it",
        body: "Compare the sha256 of the downloaded file to the original.",
      },
    ],
    diagnosis: [
      {
        title: "Intercept the decode",
        body:
          "Log the payload at the text-decode step; invalid sequences have become U+FFFD.",
      },
    ],
    root_cause: {
      mechanism: "the pipeline decodes bytes to a string before writing them",
      causal_chain: ["decode", "utf8", "replacement", "corruption"],
    },
    environment: {
      runtime: { type: "deno", versions: ["2.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [{ node: { "/": rBinary } }],
    tags: ["binary", "encoding", "integrity"],
    references: [{
      title: "MDN: TextDecoder",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/TextDecoder",
    }],
  },
  "disputed",
);

const pCrash = await ingest("problems", problemCrash);
const pLeakV2 = await ingest("problems", problemLeakV2);
const pNull = await ingest("problems", problemNull);
await ingest("problems", problemLegacy);
const pTz = await ingest("problems", problemTz);
const pRetries = await ingest("problems", problemRetries);
const pDeadlock = await ingest("problems", problemDeadlock);
const pBinary = await ingest("problems", problemBinary);

const recipeJsonStream = recipeNode(ID(35), author.publicKeyHex, {
  title: "Stream JSON responses in chunks",
  summary:
    "Serialize large result sets incrementally so the worker never buffers the whole response.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const encoder = new TextEncoder();\nconst chunks = new ReadableStream({\n  start(controller) {\n    controller.enqueue(encoder.encode('{\"items\":['));\n    let first = true;\n    for (const item of items) {\n      const prefix = first ? '' : ',';\n      controller.enqueue(encoder.encode(prefix + JSON.stringify(item)));\n      first = false;\n    }\n    controller.enqueue(encoder.encode(']}'));\n    controller.close();\n  },\n});\nreturn new Response(chunks, { headers: { 'content-type': 'application/json' } });",
  },
  explanation:
    "Emit the response body as a stream and serialize each item as it is produced, so resident memory tracks the current item, not the full result set.",
  prerequisites: [
    {
      description: "The client can consume a streaming response body.",
    },
    {
      description:
        "The query still materializes the full row set; see caveats.",
    },
  ],
  steps: [
    {
      title: "Open a ReadableStream over the rows",
      body:
        "Feed the encoder one chunk per item, separated by commas, and flush as you go instead of building one big string.",
      code:
        "controller.enqueue(encoder.encode((first ? '' : ',') + JSON.stringify(item)));",
    },
    {
      title: "Close the array and return the stream",
      body:
        "Finish the payload with the closing bracket and hand the readable side to the Response.",
    },
  ],
  verification:
    "A 50MB JSON response keeps the worker RSS flat while the client streams the body.",
  caveats: [
    {
      condition: "the stream ends mid-array",
      warning:
        "an aborted response leaves a partial JSON body; let clients retry and keep the envelope frames well-formed.",
    },
  ],
  tags: ["json", "streaming", "memory", "http"],
  references: [{
    title: "MDN: ReadableStream",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream",
  }],
});

const recipeJsonPage = recipeNode(ID(36), author.publicKeyHex, {
  title: "Paginate large responses server-side",
  summary:
    "Return fixed-size pages with a next cursor so each response payload stays bounded.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const page = items.slice(offset, offset + PAGE_SIZE);\nconst next = offset + PAGE_SIZE < items.length\n  ? `/items?offset=${offset + PAGE_SIZE}`\n  : null;\nreturn Response.json({ data: page, next });",
  },
  explanation:
    "Bound every response to a fixed page size and hand the client a cursor, so no single response ever holds the full result set.",
  prerequisites: [
    {
      description: "Clients accept paged data and follow the next cursor.",
    },
    {
      description:
        "The example slices an in-memory array, so it only bounds the payload; see caveats for flat memory.",
    },
  ],
  steps: [
    {
      title: "Slice the result set to a page",
      body: "Take the current window of rows and serialize just that window.",
      code: "const page = items.slice(offset, offset + PAGE_SIZE);",
    },
    {
      title: "Emit a next cursor",
      body:
        "Return the next offset only when more rows remain, and null on the final page.",
    },
  ],
  verification:
    "Any requested page serializes as a bounded payload; peak memory still tracks the materialized result set.",
  caveats: [
    {
      condition: "rows change between requests",
      warning:
        "offset paging can skip or duplicate rows; prefer keyset pagination on a stable column.",
    },
    {
      condition: "the result set is already fully materialized",
      warning:
        "slicing a loaded array does not reduce peak memory; page at the storage layer (keyset or LIMIT OFFSET) so only one window is held at a time.",
    },
  ],
  tags: ["json", "pagination", "memory", "http"],
  references: [{
    title: "MDN: Response.json()",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Response/json",
  }],
});

const rJsonStream = await ingest("recipes", recipeJsonStream);
const rJsonPage = await ingest("recipes", recipeJsonPage);

const pJson = await ingest(
  "problems",
  problemNode(ID(37), author.publicKeyHex, {
    title: "Worker heap exhaustion on large JSON responses",
    severity: "critical",
    summary:
      "A JSON endpoint serializes the entire result set into one buffer, so a large collection exhausts the worker heap and the process dies.",
    impact:
      "The endpoint returns 500s for every client while the worker restarts, and the incident repeats as long as result sets stay large.",
    symptoms: [
      {
        type: "runtime_behavior",
        description: "worker process dies mid-response",
        observable: "RSS climbs to the heap limit right before the crash",
        frequency: "intermittent",
      },
      {
        type: "error_message",
        description: "out-of-memory error in the runtime log",
        observable: "process exits with an OOM status under load",
        frequency: "always",
      },
    ],
    reproduction: [
      {
        title: "Request the large collection endpoint",
        body: "Call the endpoint that returns every row without pagination.",
      },
      {
        title: "Watch RSS during the serialization",
        body:
          "Resident memory grows with the row count; at the heap limit the worker is killed.",
      },
    ],
    diagnosis: [
      {
        title: "Correlate crash time with response size",
        body:
          "The crash only happens when the serialized payload exceeds the heap limit.",
      },
    ],
    root_cause: {
      mechanism:
        "the handler builds one full JSON string from the entire result set before sending any bytes",
      causal_chain: ["json", "serialization", "unbounded buffer", "oom"],
    },
    environment: {
      runtime: { type: "deno", versions: ["2.x"] },
      framework: { name: "deno", version: "2.x" },
    },
    solutions: [
      {
        node: { "/": rJsonStream },
        applies_to: "clients can consume a streaming response body",
      },
      {
        node: { "/": rJsonPage },
        applies_to: "clients accept paged responses with a next cursor",
      },
    ],
    tags: ["json", "memory", "oom", "streaming", "pagination"],
    references: [{
      title: "MDN: ReadableStream",
      url: "https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream",
    }],
  }),
);

const vCsv = verificationNode(ID(24), verifier.publicKeyHex, pCrash, rCsv, {
  timestamp: V_CSV,
  execution: {
    playground: "sandbox-den",
    environment_hash: ENV_A,
    test_suite: {
      total: 2,
      passed: 2,
      failed: 0,
      measurements: MEAS_STREAMING,
      cases: [
        {
          name: "small",
          expected: "ok",
          actual: "ok",
          result: "pass",
          input_cid: { "/": rCsv },
        },
        {
          name: "large",
          expected: "ok",
          actual: "ok",
          result: "pass",
          input_cid: { "/": rCsv },
        },
      ],
    },
  },
  agent_context: CTX_VERIFIER,
});
const vConfig = verificationNode(
  ID(25),
  verifier.publicKeyHex,
  pNull,
  rConfig,
  {
    timestamp: V_CONFIG,
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_A,
      test_suite: {
        total: 2,
        passed: 1,
        failed: 1,
        cases: [
          { name: "present", expected: "ok", actual: "ok", result: "pass" },
          { name: "missing", expected: "ok", actual: "throw", result: "fail" },
        ],
      },
    },
    agent_context: CTX_VERIFIER,
  },
);
const vMem = verificationNode(ID(26), verifier.publicKeyHex, pLeakV2, rMem, {
  timestamp: V_MEM,
  execution: {
    playground: "sandbox-den",
    environment_hash: ENV_A,
    test_suite: {
      total: 2,
      passed: 2,
      failed: 0,
      measurements: MEAS_POOL,
      cases: [
        { name: "small", expected: "ok", actual: "ok", result: "pass" },
        { name: "large", expected: "ok", actual: "ok", result: "pass" },
      ],
    },
  },
  agent_context: CTX_VERIFIER,
});
const vMemReview = verificationNode(
  ID(27),
  reviewer.publicKeyHex,
  pLeakV2,
  rMem,
  {
    timestamp: V_MEM_REVIEW,
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_B,
      test_suite: {
        total: 2,
        passed: 2,
        failed: 0,
        measurements: MEAS_POOL,
        cases: [
          { name: "small", expected: "ok", actual: "ok", result: "pass" },
          { name: "large", expected: "ok", actual: "ok", result: "pass" },
        ],
      },
    },
    agent_context: CTX_REVIEWER,
  },
);
const vTz = verificationNode(ID(28), verifier.publicKeyHex, pTz, rTz, {
  timestamp: STALE_VERIFIED_AT,
  valid_until: STALE_VALID_UNTIL,
  agent_context: CTX_VERIFIER,
});
const vRetries = verificationNode(
  ID(29),
  verifier.publicKeyHex,
  pRetries,
  rRetriesV2,
  {
    timestamp: V_RETRIES,
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_A,
      test_suite: {
        total: 3,
        passed: 3,
        failed: 0,
        cases: [
          { name: "no-error", expected: "200", actual: "200", result: "pass" },
          {
            name: "429-then-200",
            expected: "200",
            actual: "200",
            result: "pass",
          },
          {
            name: "exhausted",
            expected: "throw",
            actual: "throw",
            result: "pass",
          },
        ],
      },
    },
  },
);
const vRetries2 = verificationNode(
  ID(30),
  reviewer.publicKeyHex,
  pRetries,
  rRetriesV2,
  {
    timestamp: V_RETRIES2,
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_B,
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
  },
);
const vQueue = verificationNode(ID(31), peer.publicKeyHex, pDeadlock, rQueue, {
  timestamp: V_QUEUE,
  execution: {
    playground: "sandbox-den",
    environment_hash: ENV_C,
    test_suite: {
      total: 3,
      passed: 3,
      failed: 0,
      cases: [
        { name: "below-cap", expected: "ok", actual: "ok", result: "pass" },
        { name: "at-cap", expected: "block", actual: "block", result: "pass" },
        {
          name: "drain",
          expected: "fifo",
          actual: "fifo",
          result: "pass",
        },
      ],
    },
  },
});
const vBinary = verificationNode(ID(32), peer.publicKeyHex, pBinary, rBinary, {
  timestamp: V_BINARY,
  execution: {
    playground: "sandbox-den",
    environment_hash: ENV_C,
    test_suite: {
      total: 2,
      passed: 1,
      failed: 1,
      cases: [
        {
          name: "valid-header",
          expected: "ok",
          actual: "ok",
          result: "pass",
        },
        {
          name: "utf8-corrupted",
          expected: "ok",
          actual: "corrupted",
          result: "fail",
        },
      ],
    },
  },
});
const vMem3 = verificationNode(ID(33), peer.publicKeyHex, pLeakV2, rMem, {
  timestamp: V_MEM3,
  execution: {
    playground: "sandbox-den",
    environment_hash: ENV_C,
    test_suite: {
      total: 2,
      passed: 2,
      failed: 0,
      measurements: MEAS_POOL,
      cases: [
        { name: "small", expected: "ok", actual: "ok", result: "pass" },
        { name: "large", expected: "ok", actual: "ok", result: "pass" },
      ],
    },
  },
  agent_context: CTX_PEER,
});
const vCsvPeer = verificationNode(ID(34), peer.publicKeyHex, pCrash, rCsv, {
  timestamp: V_CSV_PEER,
  execution: {
    playground: "sandbox-den",
    environment_hash: ENV_C,
    test_suite: {
      total: 2,
      passed: 2,
      failed: 0,
      measurements: MEAS_STREAMING,
      cases: [
        { name: "small", expected: "ok", actual: "ok", result: "pass" },
        { name: "large", expected: "ok", actual: "ok", result: "pass" },
      ],
    },
  },
  agent_context: CTX_PEER,
});

const vCsvCid = await computeCid(signNode(vCsv, verifier.secretKeyHex));
const vTzCid = await computeCid(signNode(vTz, verifier.secretKeyHex));
const vMemCid = await computeCid(signNode(vMem, verifier.secretKeyHex));
const vMem3Cid = await computeCid(signNode(vMem3, peer.secretKeyHex));

await ingestVerification(vCsv, verifier.secretKeyHex);
await ingestVerification(vConfig, verifier.secretKeyHex);
await ingestVerification(vMem, verifier.secretKeyHex);
await ingestVerification(vMemReview, reviewer.secretKeyHex);
await ingestVerification(vTz, verifier.secretKeyHex);
await ingestVerification(vRetries, verifier.secretKeyHex);
await ingestVerification(vRetries2, reviewer.secretKeyHex);
await ingestVerification(vQueue, peer.secretKeyHex);
await ingestVerification(vBinary, peer.secretKeyHex);
await ingestVerification(vMem3, peer.secretKeyHex);
await ingestVerification(vCsvPeer, peer.secretKeyHex);

const vJsonA = verificationNode(
  ID(38),
  verifier.publicKeyHex,
  pJson,
  rJsonStream,
  {
    timestamp: V_JSON_A,
    valid_until: "2026-12-01T00:00:00Z",
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_A,
      test_suite: {
        total: 2,
        passed: 2,
        failed: 0,
        measurements: MEAS_STREAMING,
        cases: [
          {
            name: "small",
            expected: "ok",
            actual: "ok",
            result: "pass",
            input_cid: { "/": rJsonStream },
          },
          {
            name: "large",
            expected: "ok",
            actual: "ok",
            result: "pass",
            input_cid: { "/": rJsonStream },
          },
        ],
      },
    },
    agent_context: CTX_VERIFIER,
  },
);
const vJsonB = verificationNode(
  ID(39),
  verifier.publicKeyHex,
  pJson,
  rJsonPage,
  {
    timestamp: V_JSON_B,
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_A,
      test_suite: {
        total: 2,
        passed: 2,
        failed: 0,
        measurements: MEAS_PAGINATION,
        cases: [
          { name: "small", expected: "ok", actual: "ok", result: "pass" },
          { name: "large", expected: "ok", actual: "ok", result: "pass" },
        ],
      },
    },
    agent_context: CTX_VERIFIER,
  },
);
const vJsonB2 = verificationNode(
  ID(40),
  reviewer.publicKeyHex,
  pJson,
  rJsonPage,
  {
    timestamp: V_JSON_B2,
    execution: {
      playground: "sandbox-den",
      environment_hash: ENV_B,
      test_suite: {
        total: 2,
        passed: 2,
        failed: 0,
        measurements: MEAS_PAGINATION,
        cases: [
          { name: "small", expected: "ok", actual: "ok", result: "pass" },
          { name: "large", expected: "ok", actual: "ok", result: "pass" },
        ],
      },
    },
    agent_context: CTX_REVIEWER,
  },
);
await ingestVerification(vJsonA, verifier.secretKeyHex);
await ingestVerification(vJsonB, verifier.secretKeyHex);
await ingestVerification(vJsonB2, reviewer.secretKeyHex);
const vJsonACid = await computeCid(signNode(vJsonA, verifier.secretKeyHex));
const vJsonBCid = await computeCid(signNode(vJsonB, verifier.secretKeyHex));

const guideStreaming = guideNode(ID(16), author.publicKeyHex, {
  title: "Streaming data through a memory-constrained service",
  summary:
    "A practical walkthrough of processing large inputs row by row instead of buffering them whole, so memory stays flat for any file size.",
  epistemic_status: "verified",
  sections: [
    {
      heading: "Why whole-file buffering fails",
      claim: "Buffering a 1GB upload requires roughly twice its size in RAM.",
      body: {
        explanation:
          "When a handler reads the entire request body before parsing, the runtime holds several copies of the data at once: the raw bytes arrive in chunks, then converting to a string allocates a second buffer, and splitting that string into rows allocates a third set of strings. V8 grows the heap to fit all of them, so a 150MB fixture routinely spikes resident memory past 450MB. On a worker with a small heap limit this ends in the out-of-memory crash described in the upload problem.\n\nThe fix is not to read less data. The fix is to never materialize the whole input in memory at one time.",
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `const text = await req.text();\nconst rows = text.split('\\n');\nfor (const row of rows) parse(row);`,
        },
        example:
          "Uploading a 150MB CSV with this pattern spiked RSS to 468MB and the worker was killed. The same upload handled row-by-row stayed under 64MB.",
      },
      depth: "beginner",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rCsv },
        playground_receipt: { "/": vCsvCid },
        result: "confirmed",
      },
    },
    {
      heading: "Row-based streaming bounds memory",
      claim:
        "A row-at-a-time read loop keeps resident memory flat for any input size.",
      body: {
        explanation:
          "Read the request body as a stream and parse one row at a time. Each chunk arrives incrementally, complete rows are parsed and then released, and only the current chunk plus one partial row are ever alive at once. Resident memory therefore depends on the row size, not the file size.\n\nThis is the core of the streaming recipe: the reader pulls chunks, the buffer accumulates a partial row between chunks, and the parser consumes complete rows as they appear.",
        steps: [
          {
            title: "Open a reader on the body stream",
            body:
              "Use a ReadableStream reader so chunks arrive incrementally instead of buffering the whole file.",
            code: "const reader = file.readable.getReader();",
          },
          {
            title: "Split each chunk into complete rows",
            body:
              "Keep a trailing partial row in a buffer between chunks, then parse the complete rows.",
            code:
              "const rows = buffer.split('\\n');\nbuffer = rows.pop() ?? '';\nfor (const row of rows) parse(row);",
          },
          {
            title: "Verify memory stays bounded",
            body:
              "Run the handler against a 500MB fixture and watch resident memory during the upload.",
          },
        ],
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `let buffer = '';\nwhile (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n  buffer += new TextDecoder().decode(value);\n  const rows = buffer.split('\\n');\n  buffer = rows.pop() ?? '';\n  for (const row of rows) parse(row);\n}`,
        },
        example:
          "A 500MB upload peaked at 61MB RSS. Doubling the file to 1GB changed the peak by less than 2MB.",
      },
      depth: "beginner",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rCsv },
        playground_receipt: { "/": vCsvCid },
        result: "confirmed",
      },
    },
    {
      heading: "Handling chunk boundaries without losing rows",
      claim:
        "Keeping a trailing partial row in a buffer prevents data loss at chunk edges.",
      body: {
        explanation:
          "Network chunks do not respect row boundaries. A single chunk can end in the middle of a row, and the next chunk starts with the rest of it. If you split each chunk in isolation you either drop that partial row or parse it as a truncated record.\n\nThe buffer keeps the incomplete tail between chunks: pop the last segment off the split result and carry it forward, then prepend it to the next chunk. Rows are only parsed once the splitter has a complete line.",
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `const rows = buffer.split('\\n');\nbuffer = rows.pop() ?? '';\nfor (const row of rows) parse(row);`,
        },
        example:
          "Chunk 1 ends mid-record as 'alice,1,Enginee'. The tail 'Enginee' stays in the buffer. Chunk 2 starts 'r,42' and the combined row parses as 'alice,1,Engineer,42'.",
      },
      depth: "intermediate",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rCsv },
        playground_receipt: { "/": vCsvCid },
        result: "confirmed",
      },
    },
    {
      heading: "Matching the recipe to the failure mode",
      claim:
        "The streaming recipe resolves the crash described in the upload problem.",
      body: {
        explanation:
          "The upload problem records a web server that crashes on a large CSV upload, with the failure reproducible under a 150MB fixture. The streaming recipe is the demonstrated fix: it removes the all-at-once buffering that exhausted the worker heap.\n\nThe corpus links the two nodes through the problem's solutions relationship and through the verification receipt. When you open the recipe you can see its evidence: the receipt the server replayed, the environment it ran in, and the confidence score the independent sources produce.",
        steps: [
          {
            title: "Reproduce the crash",
            body:
              "Generate the fixture from the problem's reproduction steps and confirm the worker dies.",
          },
          {
            title: "Apply the streaming loop",
            body:
              "Replace the buffered read with the row-at-a-time loop from the recipe.",
          },
          {
            title: "Re-run the same fixture",
            body:
              "The handler completes and memory stays bounded, matching the recipe's verification.",
          },
        ],
        example:
          "Before the fix: crash at 468MB. After the fix: 500MB upload completes at 61MB peak, and the receipt records the pass.",
      },
      depth: "intermediate",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rCsv },
        playground_receipt: { "/": vCsvCid },
        result: "confirmed",
      },
    },
  ],
  prerequisites: [
    {
      node: { "/": pCrash },
      required_depth: "beginner",
    },
    {
      node: { "/": rCsv },
      required_depth: "beginner",
    },
  ],
  caveats: [
    {
      condition: "quoted CSV fields contain embedded newlines",
      warning:
        "swap the naive splitter for a real tokenizer; split('\\n') cannot see inside quotes.",
    },
  ],
  tags: ["streaming", "memory", "csv"],
  references: [{
    title: "WHATWG Streams Standard",
    url: "https://streams.spec.whatwg.org/",
  }, {
    title: "MDN: ReadableStream",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream",
  }],
});

const guideConfidence = guideNode(ID(17), author.publicKeyHex, {
  title: "Building confidence through verifiable receipts",
  summary:
    "How the corpus turns solution claims into measurable confidence using independent verification receipts, and how to read that confidence honestly.",
  epistemic_status: "heuristic",
  sections: [
    {
      heading: "How receipts raise confidence",
      claim:
        "An independent passing receipt raises a recipe's confidence score by one step.",
      body: {
        explanation:
          "Confidence comes from the number of independent passing receipts a recipe collects, not from how loudly anyone vouches for it. Each distinct verifier key that the server replayed counts as one source, and each additional source closes half of the remaining gap to a perfect score: 1 - 0.5^n.\n\nThe steps matter as much as the score. One source lands at 0.5, a second at 0.75, a third at 0.875. Notice that the third receipt is worth less than the second: confidence grows quickly and then asymptotes, so a handful of independent sources is usually enough.",
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `function confidence(sources: number): number {\n  return 1 - 0.5 ** sources;\n}\n\nconfidence(1); // 0.5\nconfidence(2); // 0.75\nconfidence(3); // 0.875`,
        },
        example:
          "The worker memory recipe carries three receipts from three different keys, so its score is 0.875, not 0.5 or 0.75.",
      },
      depth: "intermediate",
      verification: {
        type: "source_attestation",
        attested_source: "https://corpus.example/spec/v0.3.0#confidence",
        result: "confirmed",
      },
    },
    {
      heading: "Sources must be independent",
      claim:
        "Only receipts the server replayed count, and each distinct key counts once.",
      body: {
        explanation:
          "Independence is what makes the score meaningful. A single operator re-verifying the same solution twenty times proves the recipe once, not twenty times, so the server counts one key once. Receipts the server never replayed do not count at all: a claimed pass with no replay evidence is just an assertion.\n\nTrusted keys are the one exception to the usual sybil defenses. An operator can seed a small set of trusted verifier keys that weight fully from the start, while every other key must earn weight through age, authored work, and cross-verification.",
        example:
          "Ten receipts signed by the same key still show distinct_keys: 1 and confidence 0.5. Three receipts from three keys show confidence 0.875.",
      },
      depth: "intermediate",
      verification: {
        type: "source_attestation",
        attested_source: "https://corpus.example/spec/v0.3.0#independence",
        result: "confirmed",
      },
    },
    {
      heading: "Reading provenance on a recipe",
      claim:
        "A recipe's meta.provenance exposes the receipts, keys, and trusted verifiers behind its score.",
      body: {
        explanation:
          "The score is a summary; provenance is the audit trail. A recipe response carries meta.provenance with the receipt count, how many were replayed, how many distinct keys produced them, whether a trusted verifier is among them, and how old the oldest verifier key is.\n\nWhen the numbers disagree, trust the provenance. If replayed_count is lower than receipt_count, some receipts were claims without replay evidence. If distinct_keys is one, the score cannot move past 0.5 regardless of how many receipts exist.",
        steps: [
          {
            title: "Open the recipe",
            body: "GET /nodes/{cid} for the recipe and find meta.provenance.",
          },
          {
            title: "Compare receipt and key counts",
            body:
              "replayed_count should equal distinct_keys; any gap means unplayed claims.",
          },
          {
            title: "Check the trust signal",
            body:
              "has_trusted_verifier and the key weights tell you who supplied the evidence.",
          },
        ],
        example:
          "The memory recipe returns receipt_count: 3, replayed_count: 3, distinct_keys: 3, has_trusted_verifier: true. The queue recipe returns distinct_keys: 1 and scores 0.5.",
      },
      depth: "beginner",
      verification: {
        type: "source_attestation",
        attested_source: "https://corpus.example/spec/v0.3.0#provenance",
        result: "confirmed",
      },
    },
    {
      heading: "When confidence is zero",
      claim:
        "A latest failed receipt keeps a recipe out of the active status even with earlier passes.",
      body: {
        explanation:
          "Confidence measures support; effective status reflects the latest evidence. A recipe whose most recent receipt failed does not keep the status it had before, because the fresh signal disagrees with the old passes. A disputed latest result is the strongest reason to re-inspect a recipe before depending on it.\n\nThis is deliberate: the effective status is the operational answer, the confidence score is the long-run average of support, and you should never substitute one for the other.",
        example:
          "The config-merge recipe has a passing history but its latest receipt failed, so its effective status is not active and its score reflects the failure rather than the earlier passes.",
      },
      depth: "advanced",
      verification: {
        type: "source_attestation",
        attested_source: "https://corpus.example/spec/v0.3.0#effective-status",
        result: "unconfirmed",
      },
    },
  ],
  prerequisites: [
    {
      node: { "/": pLeakV2 },
      required_depth: "beginner",
    },
    {
      node: { "/": rMem },
      required_depth: "beginner",
    },
  ],
  caveats: [
    {
      condition: "receipts are operator-vouched (trusted-stub)",
      warning:
        "treat them as evidence of the claim, not proof of production behavior.",
    },
    {
      condition: "the attestation source changes",
      warning:
        "re-check the claim against the current spec before relying on it.",
    },
  ],
  tags: ["confidence", "verification", "provenance"],
  references: [{
    title: "Corpus spec: trust model",
    url: "https://corpus.example/spec/v0.3.0#trust",
  }],
});

const guideTime = guideNode(ID(18), author.publicKeyHex, {
  title: "Handling time across timezones",
  summary:
    "How to store instants in UTC, convert only at the display edge, and keep scheduled jobs honest across DST changes.",
  epistemic_status: "verified",
  sections: [
    {
      heading: "UTC is the source of truth",
      claim: "Storing instants in UTC removes DST from the storage layer.",
      body: {
        explanation:
          "A wall-clock time like '2026-03-29 02:30' is ambiguous: on a DST change day that hour either does not exist or happens twice. An instant is not ambiguous, because it names a fixed point on the timeline. Store instants as UTC ISO strings with a trailing Z and all of the ambiguity disappears from your database and your comparisons.\n\nOnce instants live in UTC, ordering, arithmetic, and expiry logic are plain timestamp math. No code path ever reinterprets 'what hour is it here' when comparing two records.",
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `const at = new Date(cron);\nconst stored = at.toISOString(); // always ends in Z\n\n// comparisons are now trivially correct\nif (stored < deadline.toISOString()) { ship(); }`,
        },
        example:
          "Storing '2026-11-01T06:30:00.000Z' stays the same instant whether the machine's clock is in New York or Paris.",
      },
      depth: "beginner",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rTz },
        playground_receipt: { "/": vTzCid },
        result: "confirmed",
      },
    },
    {
      heading: "Convert only at display time",
      claim:
        "A scheduler that renders local time at the last step never drifts across DST boundaries.",
      body: {
        explanation:
          "Every timezone has two different values at any moment: the instant, which is fixed, and the local representation, which depends on where the reader sits. If you convert early and then operate on the converted value, DST moves your numbers. Convert once, at the edge, when you are about to show a human a time or fire a user-facing reminder.\n\nIntl.DateTimeFormat handles the zone conversion, including the offsets in effect on that particular date, so you never hand-roll an offset table.",
        steps: [
          {
            title: "Keep the instant in UTC",
            body: "Persist and compare ISO-8601 UTC strings only.",
          },
          {
            title: "Format with an explicit zone",
            body:
              "Use Intl.DateTimeFormat with the target IANA timezone at render time.",
            code:
              "new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' }).format(at);",
          },
        ],
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `const fmt = new Intl.DateTimeFormat('en-US', {\n  timeZone: 'America/New_York',\n  dateStyle: 'full', timeStyle: 'short',\n});\nconst local = fmt.format(new Date(stored));`,
        },
        example:
          "The same instant renders as 11:30 AM on one machine and 05:30 PM on another, with no storage change.",
      },
      depth: "intermediate",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rTz },
        playground_receipt: { "/": vTzCid },
        result: "confirmed",
      },
    },
    {
      heading: "Recompute offsets at run time",
      claim:
        "Comparing the stored offset against the current one and adjusting prevents a job firing an hour early or late.",
      body: {
        explanation:
          "Schedulers that cache a fixed offset go stale when a DST change lands. The timezone-safe recipe recomputes the current offset at run time, compares it with the value the job was scheduled against, and adjusts before firing. The comparison uses getTimezoneOffset, which reflects the rules in effect for the machine's zone on the actual date.",
        code: {
          language: "typescript",
          framework: "deno",
          body:
            `const at = new Date(cron);\nconst offset = new Date().getTimezoneOffset();\nif (at.getTimezoneOffset() !== offset) { adjust(at); }`,
        },
        example:
          "A 02:30 job scheduled in Europe/Paris recomputes its offset on the spring-forward day and fires at the correct UTC instant instead of an hour off.",
      },
      depth: "intermediate",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rTz },
        playground_receipt: { "/": vTzCid },
        result: "confirmed",
      },
    },
    {
      heading: "Verifying across a DST boundary",
      claim:
        "A job scheduled across a DST boundary fires at the same UTC instant before and after the change.",
      body: {
        explanation:
          "The proof of a timezone-safe scheduler is that the instant it fires does not move when the clocks change. Set up a job that lands within the DST window, capture the UTC instant it fires, move the system clock across the boundary, and capture it again. If the instants match, the storage and conversion layers did their job and the scheduler is safe to keep.\n\nThis is exactly the verification the timezone recipe carries: schedule once, cross the boundary, observe the same UTC instant on both sides.",
        steps: [
          {
            title: "Schedule inside the DST window",
            body:
              "Pick a local time that falls on the change day, such as 02:30 on a spring-forward date.",
          },
          {
            title: "Record the UTC firing instant",
            body: "Log the instant the job actually fires, in UTC.",
          },
          {
            title: "Cross the boundary and repeat",
            body:
              "Move the clock past the change, run the same schedule, and compare instants.",
          },
        ],
        example:
          "Before the boundary the job fires at 06:30Z; after it fires at 06:30Z again. The scheduler did not drift.",
      },
      depth: "intermediate",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rTz },
        playground_receipt: { "/": vTzCid },
        result: "confirmed",
      },
    },
  ],
  prerequisites: [
    {
      node: { "/": pTz },
      required_depth: "beginner",
    },
    {
      node: { "/": rTz },
      required_depth: "beginner",
    },
  ],
  caveats: [
    {
      condition: "users in multiple timezones share one schedule",
      warning:
        "decide whether the instant or the wall-clock time is the source of truth.",
    },
  ],
  tags: ["time", "timezones", "cron"],
  references: [{
    title: "IANA Time Zone Database",
    url: "https://www.iana.org/time-zones",
  }],
});

const guideRetries = guideNode(ID(19), author.publicKeyHex, {
  title: "Building reliable retry logic",
  summary:
    "How to retry failed HTTP calls without turning a small outage into a fleet-wide retry storm: exponential backoff, jitter, Retry-After, and idempotency.",
  epistemic_status: "heuristic",
  sections: [
    {
      heading: "Exponential backoff beats fixed intervals",
      claim:
        "Doubling the delay on each attempt spreads retries and clears an outage in fewer total attempts.",
      body: {
        explanation:
          "A fixed interval retries on a metronome: every failed client retries at the same moment, over and over, until the outage clears. Exponential backoff doubles the delay after each attempt, so early attempts retry quickly while the load on the failing service drops off dramatically over time. A 60-second outage that would take many synchronized fixed-interval attempts clears in a handful of exponentially spaced ones.\n\nClamp the delay so a long outage does not produce a multi-minute wait: cap each attempt at a configured maximum backoff.",
        code: {
          language: "typescript",
          framework: "express",
          body:
            `const res = await fetch(url, opts);\nif (res.status < 500 && res.status !== 429) return res;\nif (attempt > MAX_ATTEMPTS) throw new Error('retries exhausted');\nconst delay = Math.min(BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);\nawait sleep(delay);`,
        },
        example:
          "BASE_MS = 100ms gives waits of 100ms, 200ms, 400ms, 800ms, then a clamp. A 60-second outage clears in under 10 seconds of wall time with at most 6 attempts.",
      },
      depth: "intermediate",
      verification: {
        type: "source_attestation",
        attested_source:
          "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
        result: "confirmed",
      },
    },
    {
      heading: "Jitter breaks synchronized retry waves",
      claim:
        "Adding random jitter prevents a fleet from retrying at the same instant and re-triggering the outage.",
      body: {
        explanation:
          "Even exponential backoff is synchronized: a fleet of clients that fail together computes the same delays and retries in lockstep, and each retry wave can be big enough to keep the outage alive. Jitter randomizes each wait inside a small window, so clients diverge after the first attempt.\n\nThe recipe randomizes within a fraction of the base delay. The divergence compounds across attempts, which is what flattens the retry waves.",
        code: {
          language: "typescript",
          framework: "express",
          body:
            `const base = BASE_MS * 2 ** (attempt - 1);\nconst jitter = Math.floor(Math.random() * base * 0.2);\nawait sleep(Math.min(base + jitter, MAX_BACKOFF_MS));`,
        },
        example:
          "100 clients fail at 10:00:00. With jitter their second attempts land between 10:00:01 and 10:00:02 instead of all at 10:00:02.",
      },
      depth: "intermediate",
      verification: {
        type: "source_attestation",
        attested_source:
          "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
        result: "confirmed",
      },
    },
    {
      heading: "Honor Retry-After",
      claim:
        "Servers signal how long to wait via the Retry-After header; respecting it beats a guessed schedule.",
      body: {
        explanation:
          "The server knows its own recovery curve; your client does not. A 429 or 503 response can carry a Retry-After header naming either a duration in seconds or an HTTP date. When it is present, sleep for that long and skip your own backoff for that attempt.\n\nThe header is authoritative for that attempt. It may exceed your computed delay, and overriding it with a shorter local guess is exactly the kind of optimism that keeps outages alive.",
        code: {
          language: "typescript",
          framework: "express",
          body:
            `if (res.status === 429 || res.status === 503) {\n  const after = res.headers.get('retry-after');\n  if (after) {\n    await sleep(parseRetryAfter(after));\n    continue;\n  }\n}`,
        },
        example:
          "A 429 with 'Retry-After: 30' tells the client to wait 30 seconds, no matter what its backoff schedule computed.",
      },
      depth: "beginner",
      verification: {
        type: "source_attestation",
        attested_source:
          "https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3",
        result: "confirmed",
      },
    },
    {
      heading: "Make retries safe to run twice",
      claim:
        "Only retry idempotent requests, or guard the handler with an idempotency key.",
      body: {
        explanation:
          "A retry re-sends the request. If the first attempt actually succeeded but the response was lost, a non-idempotent retry runs the operation twice: two charges, two emails, two rows. Retry safely by restricting retries to methods the HTTP spec marks idempotent, and by making the handler idempotent with a key the caller sends on every attempt.\n\nThe client generates one idempotency key per logical operation and repeats it on retries, so the server can recognize and deduplicate the duplicate.",
        code: {
          language: "typescript",
          framework: "express",
          body:
            `const res = await fetch(url, {\n  method: 'POST',\n  headers: { 'Idempotency-Key': key },\n  body,\n});`,
        },
        example:
          "A checkout retries a POST with the same Idempotency-Key. The payment service completes once and returns the stored result on the duplicate.",
      },
      depth: "advanced",
      verification: {
        type: "source_attestation",
        attested_source: "https://www.rfc-editor.org/rfc/rfc9110#section-9.2.2",
        result: "confirmed",
      },
    },
  ],
  prerequisites: [
    {
      node: { "/": pRetries },
      required_depth: "beginner",
    },
    {
      node: { "/": rRetriesV2 },
      required_depth: "beginner",
    },
  ],
  caveats: [
    {
      condition: "the upstream returns 429 with Retry-After",
      warning: "honor the header and skip your own backoff for that attempt.",
    },
    {
      condition: "retries make calls non-idempotent",
      warning:
        "only retry idempotent requests, or guard the handler with an idempotency key.",
    },
  ],
  tags: ["http", "retries", "backoff"],
  references: [{
    title: "AWS: Exponential Backoff and Jitter",
    url:
      "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
  }, {
    title: "RFC 9110: Retry-After",
    url: "https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3",
  }],
});

const guideLeaks = guideNode(ID(22), author.publicKeyHex, {
  title: "Diagnosing memory leaks in long-running services",
  summary:
    "A deeper guide to finding retention bugs with memory sampling, differential heap snapshots, bounded pools, and verification receipts.",
  epistemic_status: "heuristic",
  sections: [
    {
      heading: "Measure before you guess",
      claim:
        "Sampling process RSS across a load run shows whether memory actually grows before you hunt for a cause.",
      body: {
        explanation:
          "Leak hunts fail when they start from a hunch. The first tool is measurement: run a realistic load pattern and sample process RSS at a fixed interval. A flat series of samples means the growth you saw in the moment was garbage not yet collected; a steady upward slope is the leak.\n\nTake the samples programmatically so the numbers are honest. Reading the resident set of the current process gives the number, and collecting it every few seconds for the duration of a load run produces the curve that tells you whether there is anything to diagnose.",
        code: {
          language: "python",
          framework: "flask",
          body:
            "import time\n\ndef rss_kb():\n    with open('/proc/self/status') as f:\n        for line in f:\n            if line.startswith('VmRSS:'):\n                return int(line.split()[1])\n\nwhile True:\n    log(f'rss_kb={rss_kb()}')\n    time.sleep(5)",
        },
        example:
          "A worker that 'leaks' under a 1-hour load shows a flat 90MB line once you sample every 5s; a real retention bug climbs steadily to 400MB+.",
      },
      depth: "beginner",
      verification: {
        type: "source_attestation",
        attested_source: "https://docs.python.org/3/library/resource.html",
        result: "confirmed",
      },
    },
    {
      heading: "Differential heap snapshots localize retention",
      claim:
        "Comparing two heap snapshots an hour apart shows which object classes retained the most memory.",
      body: {
        explanation:
          "RSS growth proves the leak; it does not say where. A heap snapshot records every object and the retaining path that keeps it alive. Take one snapshot at the start of a load run and a second an hour later, then diff the two. The classes with the largest added retained size are your suspects, and the retaining path in the diff names the container that refuses to let go.\n\nThe trick is the timing: the start snapshot must be after warm-up and the end snapshot must follow a forced GC, or the diff is polluted by ordinary garbage.",
        steps: [
          {
            title: "Capture a warm baseline",
            body:
              "Run the service until memory stabilizes, force a GC, then take snapshot one.",
          },
          {
            title: "Run the load pattern",
            body: "Exercise the suspect path for an hour while sampling RSS.",
          },
          {
            title: "Diff against the baseline",
            body:
              "Force a GC, take snapshot two, and inspect the largest retained-size deltas.",
          },
        ],
        example:
          "The diff shows a dict of per-request objects holding 210MB more after the run, and the retaining path points at a per-request cache that never evicts.",
      },
      depth: "advanced",
      verification: {
        type: "source_attestation",
        attested_source: "https://docs.python.org/3/library/tracemalloc.html",
        result: "unconfirmed",
      },
    },
    {
      heading: "Bounded pools cap worker growth",
      claim:
        "A fixed-size eviction pool keeps per-worker retained objects bounded under sustained load.",
      body: {
        explanation:
          "Once the diff names a container, the fix is usually a cap. A per-worker pool that inserts without evicting grows with every request; give it a fixed size and evict the oldest entry on insert past the cap. The pool then behaves like a FIFO eviction pool: the oldest entries drop when the cap is hit, dead weight is released, and retained memory is bounded by the cap instead of by traffic.\n\nKeep the pool per worker and export its size as a metric, so the cap shows up in monitoring as a flat line rather than something you discover after the fact.",
        code: {
          language: "python",
          framework: "flask",
          body:
            "from collections import OrderedDict\n\npool = OrderedDict()\nMAX = 1024\npool[item.id] = item\nif len(pool) > MAX:\n    pool.popitem(last=False)\nmetric.pool_size = len(pool)",
        },
        example:
          "Sustained load keeps the pool metric pinned at 1024 instead of climbing one entry per request.",
      },
      depth: "intermediate",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rMem },
        playground_receipt: { "/": vMemCid },
        result: "confirmed",
      },
    },
    {
      heading: "Independent receipts confirm the fix",
      claim:
        "Three independent receipts for the pool recipe support a confidence score of 0.875.",
      body: {
        explanation:
          "A fix is only as good as its evidence. The bounded-pool recipe carries three verification receipts from three different keys, all replayed by the server, so its confidence score is 1 - 0.5^3 = 0.875 and its provenance shows has_trusted_verifier: true.\n\nThat is the pattern to copy: reproduce, fix, then prove the fix with a replayed verification rather than a screenshot of a graph.",
        example:
          "Open the recipe and read meta.provenance: receipt_count 3, replayed_count 3, distinct_keys 3.",
      },
      depth: "beginner",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rMem },
        playground_receipt: { "/": vMem3Cid },
        result: "confirmed",
      },
    },
  ],
  prerequisites: [
    {
      node: { "/": pLeakV2 },
      required_depth: "beginner",
    },
    {
      node: { "/": rMem },
      required_depth: "beginner",
    },
  ],
  caveats: [
    {
      condition: "snapshots only cover Python-managed memory",
      warning: "native extensions may still grow; sample process rss as well.",
    },
    {
      condition: "receipts are operator-vouched (trusted-stub)",
      warning: "they verify the recipe, not your production traffic shape.",
    },
  ],
  tags: ["memory", "leaks", "heap", "diagnosis"],
  references: [{
    title: "Python: resource module",
    url: "https://docs.python.org/3/library/resource.html",
  }, {
    title: "Python: tracemalloc module",
    url: "https://docs.python.org/3/library/tracemalloc.html",
  }],
});

await ingest("guides", guideStreaming);
await ingest("guides", guideConfidence);
await ingest("guides", guideTime);
await ingest("guides", guideRetries);
await ingest("guides", guideLeaks);

const comparisonJson = comparisonNode(ID(41), author.publicKeyHex, {
  title: "Streaming vs pagination for large JSON responses",
  decision_context:
    "The corpus records a worker that dies on a large JSON response because the handler serializes the entire result set into one buffer. Both verified fixes — a streaming body and server-side pagination — resolve the crash; this comparison records the trade-off between them on the evidence the corpus collected.",
  dimensions: [{
    name: "large-response suite",
    options: [
      {
        name: "streaming",
        value: 2,
        benchmark_receipt: { "/": vJsonACid },
      },
      {
        name: "pagination",
        value: 2,
        benchmark_receipt: { "/": vJsonBCid },
      },
    ],
  }, {
    name: "peak memory at a 50MB response",
    options: [
      {
        name: "streaming",
        value: "flat — the body serializes as the client streams",
        benchmark_receipt: { "/": vJsonACid },
      },
      {
        name: "pagination",
        value: "not reduced — tracks the materialized result set",
        benchmark_receipt: { "/": vJsonBCid },
      },
    ],
  }, {
    name: "response payload bound",
    options: [
      {
        name: "streaming",
        value: "no — the full result set streams in one body",
        benchmark_receipt: { "/": vJsonACid },
      },
      {
        name: "pagination",
        value: "yes — fixed page size per request",
        benchmark_receipt: { "/": vJsonBCid },
      },
    ],
  }, {
    name: "client compatibility",
    options: [
      {
        name: "streaming",
        value: "must consume a streaming response body",
        benchmark_receipt: { "/": vJsonACid },
      },
      {
        name: "pagination",
        value: "standard paged responses with a next cursor",
        benchmark_receipt: { "/": vJsonBCid },
      },
    ],
  }],
  recommendations: [{
    condition: "clients can stream and peak memory is the binding constraint",
    choice: "streaming",
    reason:
      "The streaming recipe keeps RSS flat on the 50MB response and passed its suite; an aborted stream leaves a partial body, so clients must retry.",
  }, {
    condition: "clients need standard paged responses",
    choice: "pagination",
    reason:
      "Pagination bounds each payload to a page, but memory still tracks the materialized result set and offset paging can skip rows when the data changes.",
  }],
  tags: ["streaming", "pagination", "memory", "json"],
});
await ingest("comparisons", comparisonJson);

const referenceJson = referenceNode(ID(42), author.publicKeyHex, {
  title: "Deno web platform: streaming and JSON responses",
  topic: "deno",
  source: {
    type: "official_docs",
    url: "https://docs.deno.com/api/web/",
    synced_at: "2026-08-05T00:00:00Z",
    snapshot_cid: { "/": rCsv },
  },
  entries: [
    {
      name: "ReadableStream",
      kind: "type",
      signature: "ReadableStream<R>",
      description:
        "A byte stream with backpressure. The source enqueues chunks and signals completion; the consumer reads them incrementally.",
      version: ">=1.0.0",
      source_pointer: "https://docs.deno.com/api/web/~/ReadableStream",
    },
    {
      name: "Response",
      kind: "behavior",
      signature: "new Response(body?: BodyInit, init?: ResponseInit)",
      description:
        "Passing a ReadableStream as the body streams the response; the worker flushes chunks instead of buffering the full payload.",
      version: ">=1.0.0",
      source_pointer: "https://docs.deno.com/api/web/~/Response",
    },
    {
      name: "Response.json",
      kind: "function",
      signature: "Response.json(data: unknown, init?: ResponseInit): Response",
      description:
        "Serializes a single value as a JSON response with the application/json content type.",
      version: ">=1.0.0",
      source_pointer: "https://docs.deno.com/api/web/~/Response.json",
    },
  ],
  consistency: {
    method: "agent_verification",
    last_checked: "2026-08-05T00:00:00Z",
    result: "confirmed",
  },
  tags: ["deno", "streaming", "web-api"],
});
await ingest("references", referenceJson);

const improvementJson = improvementNode(
  ID(43),
  author.publicKeyHex,
  {
    title: "Adopt server-side pagination for the large JSON ingest endpoint",
    current_state: {
      description:
        "The JSON ingest handler serializes the full result set into one response buffer. The worker dies on a large response.",
      metrics: { verified_suite_checks: 0, large_response_survives: 0 },
    },
    target_state: {
      description:
        "Every request returns a fixed-size page with a next cursor. The verified suite passes.",
      expected_metrics: {
        verified_suite_checks: 2,
        large_response_survives: 2,
      },
    },
    rationale:
      "Pagination bounds each response payload, so no single response holds the full result set; clients already follow a next cursor.",
    implementation: {
      approach: "incremental",
      phases: [
        {
          phase: 1,
          title: "Add a page and next cursor to the handler",
          effort: "M",
          recipe_links: [{ node: { "/": rJsonPage }, relation: "uses" }],
        },
        {
          phase: 2,
          title: "Migrate existing callers to the paged endpoint",
          effort: "S",
          recipe_links: [
            { node: { "/": rJsonPage }, relation: "requires" },
            { node: { "/": rJsonStream }, relation: "replaces" },
          ],
        },
      ],
    },
    trade_offs: [
      {
        aspect: "response payload bound",
        downside: "Peak memory still tracks the materialized result set.",
        mitigation:
          "Page at the storage layer (keyset or LIMIT OFFSET) so only one window is held at a time.",
      },
    ],
    validation: {
      success_criteria:
        "Every requested page returns a bounded payload and the large-response suite passes 2/2.",
      verification_plan:
        "Re-run the large-response suite and inspect the per-page payload size.",
      benchmark_receipts: [{ "/": vJsonBCid }],
    },
    tags: ["pagination", "ingest", "performance"],
  },
);
await ingest("improvements", improvementJson);

const blueprintJson = blueprintNode(
  ID(44),
  author.publicKeyHex,
  {
    title: "Unify upload ingestion behind one streaming pipeline",
    current_landscape: {
      fragments: [
        {
          technology: "deno CSV ingest",
          purpose: "Parses CSV uploads one row at a time so memory stays flat.",
          limitations: [
            "Peak memory still follows the 150MB upload.",
            "No shared paging contract with the other ingest paths.",
          ],
        },
        {
          technology: "deno JSON ingest",
          purpose: "Serializes the result set as JSON for the client.",
          limitations: [
            "Buffers the full response body when not streaming.",
            "Worker dies on large responses without streaming or pagination.",
          ],
        },
        {
          technology: "deno binary ingest",
          purpose: "Handles binary uploads and validates them by magic bytes.",
          limitations: [
            "No verified streaming serialization yet.",
            "Uses arrayBuffer instead of a byte stream.",
          ],
        },
      ],
      systemic_friction:
        "Three parallel ingest paths each materialize in different ways; memory grows with the result set unless every path is streamed or paged independently.",
    },
    proposed_architecture: {
      core_principle:
        "One ingest boundary that streams at the edge and pages at the storage layer.",
      layers: [
        {
          layer: 1,
          name: "ingest boundary",
          technology: "deno",
          responsibility:
            "Accept streaming bodies and bounded pages for every format.",
        },
        {
          layer: 2,
          name: "serialization",
          technology: "deno",
          responsibility:
            "Stream CSV, JSON, and binary chunks instead of buffering one big payload.",
        },
        {
          layer: 3,
          name: "storage window",
          technology: "deno",
          responsibility:
            "Page at the storage layer so only one window is held at a time.",
        },
      ],
    },
    rationale: [
      "Streaming keeps resident memory flat on large payloads.",
      "Paging bounds every response payload.",
      "Both fixes are already verified independently in this corpus.",
    ],
    feasibility: {
      blockers: [
        {
          issue: "The binary path has no verified streaming serialization yet.",
          type: "implementation",
          severity: "medium",
        },
        {
          issue:
            "Clients must learn to follow a cursor or consume a streaming body.",
          type: "social",
          severity: "medium",
        },
        {
          issue:
            "Pagination adds a per-request overhead that may increase compute costs at scale.",
          type: "economic",
          severity: "low",
        },
      ],
      enablers: [
        "Streaming JSON responses keep RSS flat on a 50MB response.",
        "Server-side pagination bounds the JSON payload.",
      ],
    },
    adoption_trajectory: {
      phase_1: "Adopt pagination for the JSON ingest endpoint.",
      phase_2: "Stream the CSV and binary serializers.",
      phase_3:
        "Unify behind one ingest boundary with a shared paging contract.",
    },
    related_nodes: [
      { node: { "/": rJsonPage }, relation: "enables" },
      { node: { "/": rJsonStream }, relation: "enables" },
      { node: { "/": pJson }, relation: "solves" },
    ],
    epistemic_status: "feasible",
    confidence: "medium",
    tags: ["architecture", "streaming", "pagination", "ingestion"],
  },
);
await ingest("blueprints", blueprintJson);

console.log(
  "seed complete: 10 recipes, 10 problems, 5 guides, 1 reference, 1 comparison, 1 improvement, 1 blueprint, 14 verifications",
);
