import type { NodeStore } from "../storage/node_store.ts";
import type { IndexedNode } from "../storage/types.ts";
import type { ProblemPayload, RecipePayload } from "../core/types.ts";
import { isProblem } from "../nodetypes/problem.ts";
import { isRecipe } from "../nodetypes/recipe.ts";
import { linkedCidsOf } from "./relationships.ts";
import { errorDocument } from "./jsonapi.ts";
import { jsonResponse, parseBody } from "./http.ts";

export const AGENT_JSON = "application/json";
export const AGENT_QUERY_MAX_LENGTH = 500;
export const AGENT_LIMIT_DEFAULT = 5;
export const AGENT_LIMIT_MAX = 20;
export const AGENT_SOLUTIONS_CAP = 10;

export interface AgentQueryInput {
  query: string;
  language?: string;
  framework?: string;
  limit: number;
}

type ValidationResult =
  | { ok: true; value: AgentQueryInput }
  | { ok: false; issues: string[] };

export function validateAgentQueryInput(body: unknown): ValidationResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, issues: ["body must be a JSON object."] };
  }
  const record = body as Record<string, unknown>;
  const issues: string[] = [];

  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (query === "") {
    issues.push("query is required and must be a non-empty string.");
  } else if (query.length > AGENT_QUERY_MAX_LENGTH) {
    issues.push(
      `query must not exceed ${AGENT_QUERY_MAX_LENGTH} characters.`,
    );
  }

  let language: string | undefined;
  if (record.language !== undefined) {
    if (typeof record.language === "string" && record.language.trim() !== "") {
      language = record.language.trim();
    } else {
      issues.push("language must be a non-empty string.");
    }
  }

  let framework: string | undefined;
  if (record.framework !== undefined) {
    if (
      typeof record.framework === "string" && record.framework.trim() !== ""
    ) {
      framework = record.framework.trim();
    } else {
      issues.push("framework must be a non-empty string.");
    }
  }

  let limit = AGENT_LIMIT_DEFAULT;
  if (record.limit !== undefined) {
    if (
      typeof record.limit === "number" &&
      Number.isInteger(record.limit) &&
      record.limit >= 1 &&
      record.limit <= AGENT_LIMIT_MAX
    ) {
      limit = record.limit;
    } else {
      issues.push(
        `limit must be an integer between 1 and ${AGENT_LIMIT_MAX}.`,
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: { query, language, framework, limit } };
}

function compareNodes(a: IndexedNode, b: IndexedNode): number {
  const aActive = a.effective_status === "active" ? 0 : 1;
  const bActive = b.effective_status === "active" ? 0 : 1;
  if (aActive !== bActive) {
    return aActive - bActive;
  }
  if (a.confidence_score !== b.confidence_score) {
    return b.confidence_score - a.confidence_score;
  }
  return a.last_verified.localeCompare(b.last_verified);
}

interface SolutionView {
  node: IndexedNode;
  recipe: RecipePayload["recipe"];
  applies_to: string | null;
}

async function loadSolutions(
  store: NodeStore,
  problemIndexed: IndexedNode,
  problem: ProblemPayload["problem"],
  input: AgentQueryInput,
): Promise<SolutionView[]> {
  const appliesByCid = new Map<string, string | null>();
  for (const solution of problem.solutions ?? []) {
    appliesByCid.set(solution.node["/"], solution.applies_to ?? null);
  }
  const out: SolutionView[] = [];
  for (const cid of linkedCidsOf(problemIndexed.node, "solutions")) {
    const target = await store.getNode(cid);
    if (!target || !isRecipe(target.node)) {
      continue;
    }
    const recipe = target.node.payload.recipe;
    if (
      input.language &&
      recipe.code.language.toLowerCase() !== input.language.toLowerCase()
    ) {
      continue;
    }
    if (
      input.framework &&
      (recipe.code.framework ?? "").toLowerCase() !==
        input.framework.toLowerCase()
    ) {
      continue;
    }
    out.push({
      node: target,
      recipe,
      applies_to: appliesByCid.get(cid) ?? null,
    });
  }
  return out;
}

function serializeSolution(view: SolutionView, baseUrl: string): unknown {
  const recipe = view.recipe;
  return {
    cid: view.node.cid,
    node_id: view.node.node_id,
    title: recipe.title,
    summary: recipe.summary,
    language: recipe.code.language,
    framework: recipe.code.framework ?? null,
    confidence: view.node.confidence_score,
    status: view.node.effective_status,
    last_verified: view.node.last_verified,
    applies_to: view.applies_to,
    explanation: recipe.explanation,
    steps: recipe.steps ?? [],
    code: recipe.code,
    caveats: recipe.caveats ?? [],
    links: {
      self: `${baseUrl}/nodes/${view.node.cid}`,
      receipts: `${baseUrl}/nodes/${view.node.cid}/verifications`,
    },
  };
}

function serializeProblem(
  problemIndexed: IndexedNode,
  problem: ProblemPayload["problem"],
  baseUrl: string,
): unknown {
  return {
    cid: problemIndexed.cid,
    node_id: problemIndexed.node_id,
    title: problem.title,
    severity: problem.severity,
    summary: problem.summary,
    impact: problem.impact,
    symptoms: problem.symptoms,
    root_cause: problem.root_cause,
    environment: problem.environment,
    links: { self: `${baseUrl}/nodes/${problemIndexed.cid}` },
  };
}

export async function runAgentQuery(
  store: NodeStore,
  input: AgentQueryInput,
  baseUrl: string,
): Promise<{ meta: Record<string, unknown>; data: unknown[] }> {
  const filter: Record<string, unknown> = {
    node_type: "Problem",
    effective_status: "active",
  };
  if (input.framework) {
    filter.framework_name = input.framework;
  }

  const result = await store.search({
    filter,
    search: input.query,
    sort: "-created_at",
    limit: input.limit,
    offset: 0,
  });

  const data: unknown[] = [];
  let considered = 0;
  let best: { problem_cid: string; solution_cid: string } | null = null;
  let bestNode: IndexedNode | null = null;

  for (const problemIndexed of result.data) {
    if (!isProblem(problemIndexed.node)) {
      continue;
    }
    const problem = problemIndexed.node.payload.problem;
    const views = await loadSolutions(store, problemIndexed, problem, input);
    const ranked = [...views]
      .sort((a, b) => compareNodes(a.node, b.node))
      .slice(0, AGENT_SOLUTIONS_CAP);
    considered += ranked.length;
    for (const view of ranked) {
      if (bestNode === null || compareNodes(view.node, bestNode) < 0) {
        bestNode = view.node;
        best = { problem_cid: problemIndexed.cid, solution_cid: view.node.cid };
      }
    }
    data.push({
      problem: serializeProblem(problemIndexed, problem, baseUrl),
      solutions: ranked.map((view) => serializeSolution(view, baseUrl)),
    });
  }

  const meta: Record<string, unknown> = {
    query: input.query,
    matched_problems: data.length,
    total_solutions_considered: considered,
  };
  if (input.language) {
    meta.language = input.language;
  }
  if (input.framework) {
    meta.framework = input.framework;
  }
  meta.best = best;
  return { meta, data };
}

export async function agentQueryHandler(
  request: Request,
  baseUrl: string,
  store: NodeStore,
  bodyLimit: number,
): Promise<Response> {
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes(AGENT_JSON)) {
    return jsonResponse(
      errorDocument([{
        status: "415",
        title: "unsupported media type",
        detail: `Content-Type must be ${AGENT_JSON}.`,
      }]),
      415,
      AGENT_JSON,
    );
  }
  const parsed = await parseBody(request, bodyLimit);
  if (parsed.tooLarge) {
    return jsonResponse(
      errorDocument([{
        status: "413",
        title: "payload too large",
        detail: `Request body exceeds the ${bodyLimit}-byte limit.`,
      }]),
      413,
      AGENT_JSON,
    );
  }
  if (!parsed.ok) {
    return jsonResponse(
      errorDocument([{
        status: "400",
        title: "invalid JSON",
        detail: "The request body must be a valid JSON document.",
      }]),
      400,
      AGENT_JSON,
    );
  }
  const validated = validateAgentQueryInput(parsed.body);
  if (!validated.ok) {
    return jsonResponse(
      errorDocument([{
        status: "422",
        title: "validation failed",
        detail: validated.issues.join(" "),
      }]),
      422,
      AGENT_JSON,
    );
  }
  const { meta, data } = await runAgentQuery(store, validated.value, baseUrl);
  return jsonResponse(
    { jsonapi: { version: "1.0" }, meta, data },
    200,
    AGENT_JSON,
  );
}
