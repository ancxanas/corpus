import { generateKeyPair, signNode } from "../src/core/sign.ts";
import { computeCid } from "../src/core/cid.ts";
import { dirname } from "node:path";
import type {
  GuidePayload,
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
  }],
});

const recipeMem = recipeNode(ID(2), author.publicKeyHex, {
  title: "Bound worker memory pools",
  summary:
    "Keep a fixed-size eviction pool per worker so retained objects cannot grow without bound.",
  code: {
    language: "typescript",
    framework: "deno",
    body:
      "const pool = new Map();\nconst MAX = 1024;\nfor (const item of items) {\n  pool.set(item.id, item);\n  if (pool.size > MAX) pool.delete(pool.keys().next().value);\n}",
  },
  explanation:
    "Keep a fixed-size LRU pool per worker so retained objects cannot grow without bound.",
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
      code: "if (pool.size > MAX) pool.delete(pool.keys().next().value);",
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
  tags: ["memory", "workers", "lru"],
  references: [{
    title: "MDN: Map",
    url:
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map",
  }],
});

const recipeConfig = recipeNode(ID(3), author.publicKeyHex, {
  title: "Validate config against safe defaults",
  summary:
    "Merge parsed configuration over built-in defaults and type-check before use, so missing files cannot yield nulls.",
  code: {
    language: "typescript",
    framework: "deno",
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
      runtime: { type: "node", versions: ["22.x"] },
      framework: { name: "deno", version: "2.x" },
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
  ID(6),
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
      framework: { name: "deno", version: "2.x" },
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

const problemDeprecated = problemNode(
  ID(9),
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
      framework: { name: "deno", version: "2.x" },
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
  ID(10),
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
      runtime: { type: "node", versions: ["22.x"] },
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

const pCrash = await ingest("problems", problemCrash);
const pLeakV2 = await ingest("problems", problemLeakV2);
const pNull = await ingest("problems", problemNull);
await ingest("problems", problemDeprecated);
const pTz = await ingest("problems", problemTz);

const vCsv = verificationNode(ID(11), verifier.publicKeyHex, pCrash, rCsv);
const vMem = verificationNode(ID(12), verifier.publicKeyHex, pLeakV2, rMem);
const vMemReview = verificationNode(
  ID(13),
  reviewer.publicKeyHex,
  pLeakV2,
  rMem,
);
const vConfig = verificationNode(
  ID(14),
  verifier.publicKeyHex,
  pNull,
  rConfig,
  {
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
  },
);
const vTz = verificationNode(ID(15), verifier.publicKeyHex, pTz, rTz, {
  timestamp: STALE_VERIFIED_AT,
  valid_until: STALE_VALID_UNTIL,
});

const vCsvCid = await computeCid(signNode(vCsv, verifier.secretKeyHex));
const vTzCid = await computeCid(signNode(vTz, verifier.secretKeyHex));

await ingestVerification(vCsv, verifier.secretKeyHex);
await ingestVerification(vMem, verifier.secretKeyHex);
await ingestVerification(vMemReview, reviewer.secretKeyHex);
await ingestVerification(vConfig, verifier.secretKeyHex);
await ingestVerification(vTz, verifier.secretKeyHex);

const guideStreaming = guideNode(ID(16), author.publicKeyHex, {
  title: "Streaming data through a memory-constrained service",
  summary:
    "A practical walkthrough of processing large inputs row by row instead of buffering them whole.",
  epistemic_status: "verified",
  sections: [
    {
      heading: "Why whole-file buffering fails",
      claim: "Buffering a 1GB upload requires roughly twice its size in RAM.",
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
      depth: "beginner",
      verification: {
        type: "demonstration",
        demonstration_cid: { "/": rCsv },
        playground_receipt: { "/": vCsvCid },
        result: "confirmed",
      },
    },
    {
      heading: "Matching the solution to the failure",
      claim:
        "The streaming recipe resolves the crash described in the upload problem.",
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
      warning: "swap the naive splitter for a real tokenizer.",
    },
  ],
  tags: ["streaming", "memory", "csv"],
});

const guideConfidence = guideNode(ID(17), author.publicKeyHex, {
  title: "Building confidence through verifiable receipts",
  summary:
    "How the corpus turns solution claims into measurable confidence using independent verification receipts.",
  epistemic_status: "heuristic",
  sections: [
    {
      heading: "Receipts raise confidence",
      claim:
        "An independent passing receipt raises a recipe's confidence score by one step.",
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
        "Two receipts from the same author or the same environment count as one source.",
      depth: "intermediate",
      verification: {
        type: "source_attestation",
        attested_source: "https://corpus.example/spec/v0.3.0#independence",
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
      condition: "receipts come from a replay sandbox",
      warning:
        "treat them as evidence of the claim, not proof of production behavior.",
    },
    {
      condition: "the attestation source changes",
      warning:
        "re-check the claim against the current spec before relying on it.",
    },
  ],
  tags: ["confidence", "verification"],
});

const guideTime = guideNode(ID(18), author.publicKeyHex, {
  title: "Handling time across timezones",
  summary:
    "A short guide to storing instants in UTC and converting only at the display edge.",
  epistemic_status: "verified",
  sections: [
    {
      heading: "UTC is the source of truth",
      claim: "Storing instants in UTC removes DST from the storage layer.",
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
  tags: ["time", "timezones", "cron"],
});

await ingest("guides", guideStreaming);
await ingest("guides", guideConfidence);
await ingest("guides", guideTime);

console.log("seed complete");
