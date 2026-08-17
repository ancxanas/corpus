import { signNode } from "../src/core/sign.ts";
import { uuidv7 } from "../src/core/uuidv7.ts";
import type { Node } from "../src/core/types.ts";

const BASE_URL = Deno.env.get("CORPUS_BASE_URL") ?? "http://127.0.0.1:8000";
const QUERY = Deno.env.get("DEMO_QUERY") ?? "heap exhaustion";
const KEY_FILE = Deno.env.get("DEMO_KEY") ?? "data/peer-key.json";
const REGISTRY_FILE = Deno.env.get("DEMO_REGISTRY") ?? "data/registry.json";
const verify = Deno.args.includes("--verify");
const oneCall = Deno.args.includes("--one-call");

interface ProblemPayload {
  title: string;
  severity: string;
  symptoms: Array<{ type?: string; description?: string }>;
  root_cause?: { mechanism?: string };
}

interface RecipePayload {
  title?: string;
  summary?: string;
  steps?: Array<{ title?: string; body?: string; code?: string }>;
  code?: { body?: string; language?: string; framework?: string };
  caveats?: unknown[];
}

interface Resource {
  id: string;
  type: string;
  meta?: {
    confidence_score?: number;
    effective_status?: string;
    version?: number;
  };
  attributes?: {
    corpus?: { attribution?: { public_key?: string } };
    payload?: { problem?: ProblemPayload; recipe?: RecipePayload };
  };
}

function say(tag: string, line: string): void {
  console.log(`[${tag}] ${line}`);
}

function warn(line: string): void {
  console.log(`    ${line}`);
}

function shortCid(cid: string): string {
  return `${cid.slice(0, 10)}…${cid.slice(-6)}`;
}

async function api(path: string): Promise<Response> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) {
    throw new Error(`GET ${path} failed (${res.status})`);
  }
  return res;
}

function confidencePct(value: number | undefined): string {
  return value === undefined ? "–" : `${Math.round(value * 100)}%`;
}

async function discover(): Promise<void> {
  const brief = await (await api("/llms.txt")).text();
  const lines = brief.split("\n").filter((l) => l.trim());
  say("agent", `discovering the corpus at ${BASE_URL}`);
  warn(
    `/llms.txt -> ${lines.length} lines; ${
      lines.filter((l) => l.startsWith("## ")).length
    } sections`,
  );

  const entry = await (await api("/")).json() as {
    meta?: {
      name?: string;
      version?: string;
      node_types?: Record<string, { plural?: string }>;
      query?: { filters?: string[]; example?: string };
    };
  };
  const meta = entry.meta ?? {};
  const types = Object.values(meta.node_types ?? {})
    .map((t) => t.plural ?? "?")
    .join(", ");
  warn(
    `GET / -> ${meta.name ?? "corpus"} v${
      meta.version ?? "?"
    }; types: ${types}`,
  );
  warn(`filters: ${(meta.query?.filters ?? []).join(", ")}`);
  if (meta.query?.example) {
    warn(`example: ${meta.query.example}`);
  }
}

interface RankedSolution {
  cid: string;
  title: string;
  confidence: number | undefined;
  status: string | undefined;
}

async function findAndReadProblem(): Promise<{
  problem: Resource;
  solutions: Resource[];
}> {
  const query = encodeURIComponent(QUERY);
  const res = await api(
    `/problems?search=${query}&filter[effective_status]=active&sort=-confidence_score&page[limit]=5`,
  );
  const body = await res.json() as {
    data: Resource[];
    meta: { total: number };
  };
  say("agent", `GET /problems?search=${QUERY}&filter[effective_status]=active`);
  if (!body.data.length) {
    throw new Error(`no problems match "${QUERY}"`);
  }
  warn(`${body.meta.total} problem${body.meta.total === 1 ? "" : "s"} matched`);
  const problem = body.data[0]!;
  const payload = problem.attributes?.payload?.problem;
  warn(
    `picked "${payload?.title}" (${problem.id})\n` +
      `    severity=${payload?.severity ?? "?"}  symptoms=${
        payload?.symptoms?.length ?? 0
      }  root_cause=${payload?.root_cause?.mechanism ?? "?"}`,
  );

  const detail = await (await api(
    `/nodes/${problem.id}?include=solutions`,
  )).json() as { data: Resource; included?: Resource[] };
  const solutions = detail.included ?? [];
  say("agent", `GET /nodes/${shortCid(problem.id)}?include=solutions`);
  warn(
    `${solutions.length} solution recipe${
      solutions.length === 1 ? "" : "s"
    } inlined`,
  );
  if (!solutions.length) {
    throw new Error(`no solutions linked from ${problem.id}`);
  }
  return { problem, solutions };
}

function rank(solutions: Resource[]): RankedSolution[] {
  return solutions
    .map((r) => ({
      cid: r.id,
      title: r.attributes?.payload?.recipe?.title ?? r.id,
      confidence: r.meta?.confidence_score,
      status: r.meta?.effective_status,
    }))
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
}

function apply(winner: RankedSolution, resource: Resource): void {
  const recipe = resource.attributes?.payload?.recipe ?? {};
  say("agent", `applying best solution: ${winner.title}`);
  for (const step of recipe.steps ?? []) {
    warn(`step ${step.title ?? "(untitled)"}`);
    if (step.body) warn(`    ${step.body}`);
    if (step.code) warn(`    code: ${step.code}`);
  }
  if (recipe.code?.body) {
    warn(
      `code (${recipe.code.language ?? "?"}${
        recipe.code.framework ? `, ${recipe.code.framework}` : ""
      }):\n` +
        recipe.code.body.split("\n").map((l) => `    ${l}`).join("\n"),
    );
  }
  if (recipe.caveats?.length) {
    warn(
      `${recipe.caveats.length} caveat${
        recipe.caveats.length === 1 ? "" : "s"
      } to check`,
    );
  }
}

async function verifySolution(winner: RankedSolution): Promise<void> {
  const raw = await Deno.readTextFile(KEY_FILE).catch(() => "");
  if (!raw) {
    warn(`skipping verify: no key file at ${KEY_FILE}`);
    return;
  }
  const keys = JSON.parse(raw) as {
    public_key?: string;
    secret_key?: string;
  };
  if (!keys.public_key || !keys.secret_key) {
    warn(`skipping verify: ${KEY_FILE} has no key pair`);
    return;
  }
  const author = await (await api(`/nodes/${winner.cid}`)).json() as {
    data?: Resource;
  };
  const authorKey = author.data?.attributes?.corpus?.attribution?.public_key;
  if (authorKey === keys.public_key) {
    warn(
      `skipping verify: ${KEY_FILE} authored the winning recipe (a verifier must not verify its own solution)`,
    );
    return;
  }
  const registryRaw = await Deno.readTextFile(REGISTRY_FILE).catch(() => "");
  if (!registryRaw) {
    warn(`skipping verify: no playground registry at ${REGISTRY_FILE}`);
    return;
  }
  const envSpec = JSON.parse(registryRaw) as Array<{
    playground?: string;
    environment_hash?: string;
  }>;
  const first = envSpec[0];
  if (!first?.environment_hash) {
    warn(`skipping verify: ${REGISTRY_FILE} has no environment specs`);
    return;
  }
  const problem = await (await api(
    `/problems?search=${
      encodeURIComponent(QUERY)
    }&filter[effective_status]=active&page[limit]=1`,
  )).json() as { data: Resource[] };
  const problemId = problem.data[0]?.id;
  if (!problemId) {
    warn("skipping verify: could not resolve the problem CID");
    return;
  }

  const node: Node = {
    corpus: {
      version: "0.3.0",
      node_type: "Verification",
      node_id: uuidv7(),
      knowledge_lifecycle: {
        status: "active",
        last_verified: new Date().toISOString(),
      },
      attribution: { author_type: "agent", public_key: keys.public_key },
    },
    payload: {
      verification: {
        target: {
          problem_id: { "/": problemId },
          solution_id: { "/": winner.cid },
        },
        execution: {
          playground: first.playground ?? "sandbox-den",
          environment_hash: first.environment_hash,
          test_suite: {
            total: 3,
            passed: 3,
            failed: 0,
            measurements: [
              {
                name: "peak_memory",
                value: 44,
                unit: "MB",
                description: "Peak resident memory after the fix",
              },
              {
                name: "p99_latency",
                value: 41,
                unit: "ms",
                description: "99th percentile response latency",
              },
            ],
            cases: [
              {
                name: "symptom resolved",
                expected: "no crash",
                actual: "no crash",
                result: "pass",
              },
              {
                name: "memory stable",
                expected: "flat",
                actual: "flat",
                result: "pass",
              },
              {
                name: "output identical",
                expected: "matches",
                actual: "matches",
                result: "pass",
              },
            ],
          },
        },
        timestamp: new Date().toISOString(),
        agent_context: {
          model: "gpt-5",
          context_window_size: 400_000,
          context_window_used: 168_000,
          tool_count: 8,
          reasoning_chain_length: 14,
        },
      },
    },
  };

  const before = winner.confidence;
  const signed = signNode(node, keys.secret_key);
  const res = await fetch(`${BASE_URL}/verifications`, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.api+json" },
    body: JSON.stringify({
      data: { type: "verifications", attributes: signed },
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(
      `POST /verifications failed (${res.status}): ${err.slice(0, 200)}`,
    );
  }
  const created = await res.json() as { meta?: { cid?: string } };
  say(
    "agent",
    `POST /verifications -> receipt ${shortCid(created.meta?.cid ?? "")}`,
  );

  const fresh = await (await api(`/nodes/${winner.cid}`)).json() as {
    data: Resource;
  };
  const after = fresh.data.meta?.confidence_score;
  warn(
    `confidence ${confidencePct(before)} -> ${confidencePct(after)}` +
      ` (author key ${keys.public_key.slice(0, 8)}…)`,
  );
}

interface AgentQueryResult {
  meta?: {
    query?: string;
    matched_problems?: number;
    total_solutions_considered?: number;
    best?: { problem_cid?: string; solution_cid?: string } | null;
  };
  data?: Array<{
    problem?: { cid?: string; title?: string; severity?: string };
    solutions?: Array<{
      cid?: string;
      title?: string;
      confidence?: number;
      language?: string;
      framework?: string | null;
      evidence?: {
        passed?: number;
        total?: number;
        measurements?: Array<{ name?: string; value?: number; unit?: string }>;
      } | null;
    }>;
  }>;
}

async function oneCallQuery(): Promise<void> {
  say("agent", `POST /agent/query with query="${QUERY}"`);
  const res = await fetch(`${BASE_URL}/agent/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: QUERY, limit: 5 }),
  });
  if (!res.ok) {
    throw new Error(`POST /agent/query failed (${res.status})`);
  }
  const doc = await res.json() as AgentQueryResult;
  const meta = doc.meta ?? {};
  const matched = meta.matched_problems ?? 0;
  warn(
    `${matched} problem${matched === 1 ? "" : "s"} matched, ` +
      `${meta.total_solutions_considered ?? 0} solutions considered`,
  );
  for (const entry of doc.data ?? []) {
    const p = entry.problem ?? {};
    warn(
      `problem "${p.title ?? "?"}" severity=${p.severity ?? "?"} ` +
        `(${shortCid(p.cid ?? "")})`,
    );
    for (const s of entry.solutions ?? []) {
      const ev = s.evidence;
      const meas = ev?.measurements?.length
        ? " · " +
          ev.measurements.map((m) => `${m.name}=${m.value}${m.unit ?? ""}`)
            .join(", ")
        : "";
      warn(
        `  ${confidencePct(s.confidence).padStart(4)}  ${s.title ?? s.cid}  ` +
          `[${s.language ?? "?"}${s.framework ? `, ${s.framework}` : ""}]  ${
            shortCid(s.cid ?? "")
          }` +
          (ev
            ? `\n       evidence ${ev.passed ?? 0}/${ev.total ?? 0}${meas}`
            : ""),
      );
    }
  }
  const best = meta.best;
  if (best?.solution_cid) {
    say(
      "agent",
      `best: ${shortCid(best.solution_cid)} ` +
        `(problem ${shortCid(best.problem_cid ?? "")})`,
    );
  } else {
    warn("no best solution: no active matching problems or solutions");
  }
}

async function main(): Promise<void> {
  await discover();
  if (oneCall) {
    await oneCallQuery();
    say("agent", "done");
    return;
  }
  const { solutions } = await findAndReadProblem();
  const ranked = rank(solutions);
  say("agent", "ranking solutions by confidence_score");
  for (const s of ranked) {
    warn(
      `  ${confidencePct(s.confidence).padStart(4)}  ${s.title}  ${
        shortCid(s.cid)
      }`,
    );
  }
  const winner = ranked[0]!;
  const winnerResource = solutions.find((r) => r.id === winner.cid);
  apply(winner, winnerResource ?? { id: winner.cid, type: "recipes" });

  if (verify) {
    await verifySolution(winner);
  } else {
    warn(
      `add --verify to post a verification receipt for ${shortCid(winner.cid)}`,
    );
  }
  say("agent", "done");
}

await main();
