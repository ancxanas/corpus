const API_ACCEPT = { Accept: "application/vnd.api+json" };
const COLLECTIONS = [
  { id: "all", label: "All" },
  { id: "problems", label: "Problems" },
  { id: "recipes", label: "Recipes" },
  { id: "guides", label: "Guides" },
];

const HERO = {
  all: {
    title: "A signed library of engineering knowledge",
    blurb:
      "Problems, solutions, and verified guides — every claim linked to a cid-addressable record.",
  },
  problems: {
    title: "Problems",
    blurb:
      "Observed failures with reproduction steps, root causes, and linked solutions.",
  },
  recipes: {
    title: "Recipes",
    blurb:
      "Reusable solutions with prerequisites, step-by-step instructions, and verification evidence.",
  },
  guides: {
    title: "Guides",
    blurb:
      "Curated walkthroughs that connect problems and solutions into coherent knowledge.",
  },
};

const STATUSES = ["", "active", "draft", "disputed", "stale", "deprecated"];
const SEVERITIES = ["", "critical", "high", "medium", "low"];
const SORTS = [
  { id: "-created_at", label: "Newest first" },
  { id: "created_at", label: "Oldest first" },
  { id: "-confidence_score", label: "Confidence" },
  { id: "-last_verified", label: "Last verified" },
];

const state = {
  collection: "all",
  status: "",
  severity: "",
  search: "",
  sort: "-created_at",
  limit: 25,
  offset: 0,
  next: null,
  prev: null,
  total: 0,
};

const view = document.getElementById("view");
const pagination = document.getElementById("pagination");
const searchInput = document.getElementById("search");
let searchTimer = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]);
}

function shortCid(cid) {
  return cid ? cid.slice(0, 12) : "";
}

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

const STATUS_CLASS = {
  active: "ok",
  draft: "warn",
  disputed: "bad",
  deprecated: "bad",
  stale: "warn",
};

const SEVERITY_CLASS = {
  critical: "bad",
  high: "warn",
  medium: "accent",
  low: "muted",
};

function statusBadge(status) {
  const cls = STATUS_CLASS[status] ?? "muted";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function severityBadge(severity) {
  const cls = SEVERITY_CLASS[severity] ?? "muted";
  return `<span class="badge ${cls}">${esc(severity)}</span>`;
}

function confidencePct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function titleOf(resource) {
  const payload = resource?.attributes?.payload ?? {};
  if (payload.problem) return payload.problem.title;
  if (payload.recipe) return payload.recipe.title;
  if (payload.guide) return payload.guide.title;
  if (payload.verification) {
    return `Verification of ${
      shortCid(payload.verification.target.solution_id["/"])
    }`;
  }
  return resource?.id ?? "Untitled";
}

function typeLabel(resource) {
  const nodeType = resource?.attributes?.osk?.node_type ?? resource?.type;
  return nodeType ? nodeType.toLowerCase() : "node";
}

function linkedCid(cid, label) {
  return `<a href="#/nodes/${esc(cid)}">${esc(label ?? shortCid(cid))}</a>`;
}

function cidLinkOrText(cid) {
  return cid ? linkedCid(cid) : "—";
}

function renderTags(tags) {
  if (!tags?.length) {
    return "";
  }
  return `<div class="tag-list">${
    tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")
  }</div>`;
}

function renderReferences(references) {
  if (!references?.length) {
    return "";
  }
  return `
    <h3>References</h3>
    <ul>
      ${
    references.map((r) =>
      `<li><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${
        esc(r.title)
      }</a></li>`
    ).join("")
  }
    </ul>`;
}

function renderSteps(steps) {
  if (!steps?.length) {
    return "";
  }
  return `<div>${
    steps.map((s, i) => `
      <div class="step">
        <div class="step-title">${i + 1}. ${esc(s.title)}</div>
        <p>${esc(s.body)}</p>
        ${s.code ? `<pre class="codeblock">${esc(s.code)}</pre>` : ""}
      </div>`).join("")
  }</div>`;
}

async function api(path) {
  const res = await fetch(path, { headers: API_ACCEPT });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.errors?.[0]?.detail ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body;
}

function queryString() {
  const params = new URLSearchParams();
  if (state.collection !== "all") {
    params.set("filter[node_type]", state.collection);
  }
  if (state.status) {
    params.set("filter[effective_status]", state.status);
  }
  if (state.severity && state.collection === "problems") {
    params.set("filter[severity]", state.severity);
  }
  if (state.search) {
    params.set("filter[title]", state.search);
  }
  params.set("sort", state.sort);
  params.set("page[limit]", String(state.limit));
  params.set("page[offset]", String(state.offset));
  return params.toString();
}

async function fetchCounts() {
  const [problems, recipes, guides] = await Promise.all([
    api("/nodes?filter[node_type]=problems&page[limit]=1"),
    api("/nodes?filter[node_type]=recipes&page[limit]=1"),
    api("/nodes?filter[node_type]=guides&page[limit]=1"),
  ]);
  return {
    problems: problems.meta?.total ?? 0,
    recipes: recipes.meta?.total ?? 0,
    guides: guides.meta?.total ?? 0,
  };
}

function heroBlock(counts) {
  const hero = HERO[state.collection] ?? HERO.all;
  let stats = "";
  if (state.collection === "all") {
    stats = `
      <div class="stat"><div class="stat-value">${counts.problems}</div><div class="stat-label">Problems</div></div>
      <div class="stat"><div class="stat-value">${counts.recipes}</div><div class="stat-label">Recipes</div></div>
      <div class="stat"><div class="stat-value">${counts.guides}</div><div class="stat-label">Guides</div></div>`;
  } else {
    stats = `
      <div class="stat"><div class="stat-value">${state.total}</div><div class="stat-label">${hero.title}</div></div>`;
  }
  return `
    <section class="hero">
      <h1>${esc(hero.title)}</h1>
      <p>${esc(hero.blurb)}</p>
      <div class="stats">${stats}</div>
    </section>`;
}

async function renderBrowse() {
  try {
    const counts = await fetchCounts();
    const body = await api(`/nodes?${queryString()}`);
    state.next = body.links?.next ?? null;
    state.prev = body.links?.prev ?? null;
    state.total = body.meta?.total ?? 0;

    const rows = (body.data ?? []).map((resource) => {
      const meta = resource.meta ?? {};
      const nodeType = typeLabel(resource);
      return `
        <div class="node-row">
          <div class="row-main">
            <div class="row-title">
              <a href="#/nodes/${esc(resource.id)}">${
        esc(titleOf(resource))
      }</a>
            </div>
            <div class="row-sub">${esc(nodeType)} ·
              <span class="cid">${esc(shortCid(resource.id))}</span></div>
          </div>
          <div class="row-meta">
            ${statusBadge(meta.effective_status)}<br />
            ${esc(confidencePct(meta.confidence_score))} ·
            ${esc(fmtDate(meta.created_at))}
          </div>
        </div>`;
    }).join("");

    const tool = `
      <div class="toolbar">
        <label>Status
          <select id="status">${
      STATUSES.map((s) =>
        `<option value="${s}" ${s === state.status ? "selected" : ""}>${
          s === "" ? "Any" : s
        }</option>`
      ).join("")
    }</select>
        </label>
        <label>Severity
          <select id="severity" ${
      state.collection === "problems" ? "" : "disabled"
    }>${
      SEVERITIES.map((s) =>
        `<option value="${s}" ${s === state.severity ? "selected" : ""}>${
          s === "" ? "Any" : s
        }</option>`
      ).join("")
    }</select>
        </label>
        <label>Sort
          <select id="sort">${
      SORTS.map((s) =>
        `<option value="${s.id}" ${
          s.id === state.sort ? "selected" : ""
        }>${s.label}</option>`
      ).join("")
    }</select>
        </label>
      </div>`;

    const tabs = `
      <div class="tabs">${
      COLLECTIONS.map((c) =>
        `<button data-collection="${c.id}" class="${
          c.id === state.collection ? "active" : ""
        }">${c.label}</button>`
      ).join("")
    }</div>`;

    view.innerHTML = `
      ${heroBlock(counts)}
      ${tabs}
      ${tool}
      <div class="node-list">${
      rows || '<div class="empty">No nodes found.</div>'
    }</div>`;

    for (const btn of view.querySelectorAll("[data-collection]")) {
      btn.addEventListener("click", () => {
        state.collection = btn.dataset.collection;
        state.offset = 0;
        state.severity = "";
        renderBrowse();
      });
    }
    view.querySelector("#status")?.addEventListener("change", (e) => {
      state.status = e.target.value;
      state.offset = 0;
      renderBrowse();
    });
    view.querySelector("#severity")?.addEventListener("change", (e) => {
      state.severity = e.target.value;
      state.offset = 0;
      renderBrowse();
    });
    view.querySelector("#sort")?.addEventListener("change", (e) => {
      state.sort = e.target.value;
      state.offset = 0;
      renderBrowse();
    });

    renderPagination();
  } catch (err) {
    view.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    pagination.hidden = true;
  }
}

function renderPagination() {
  pagination.hidden = false;
  const pageNum = Math.floor(state.offset / state.limit) + 1;
  pagination.innerHTML = `
    <button id="prev" ${state.prev ? "" : "disabled"}>← Previous</button>
    <span class="page-info">Page ${pageNum} · ${state.total} node${
    state.total === 1 ? "" : "s"
  }</span>
    <button id="next" ${state.next ? "" : "disabled"}>Next →</button>`;
  pagination.querySelector("#prev")?.addEventListener("click", () => {
    state.offset -= state.limit;
    renderBrowse();
  });
  pagination.querySelector("#next")?.addEventListener("click", () => {
    state.offset += state.limit;
    renderBrowse();
  });
}

function renderReceipts(receipts) {
  if (!receipts || receipts.length === 0) {
    return "";
  }
  const items = receipts.map((r) => {
    const suite = r.attributes?.test_suite ?? {};
    const failed = suite.failed ?? 0;
    return `
      <div class="node-row" style="margin-bottom:var(--space-2)">
        <div class="row-main">
          <div class="row-title">
            <a href="#/nodes/${esc(r.id)}">Receipt ${esc(shortCid(r.id))}</a>
          </div>
          <div class="row-sub">${esc(fmtDate(r.attributes?.timestamp))}</div>
        </div>
        <div class="row-meta">
          <span class="badge ${failed > 0 ? "bad" : "ok"}">${
      esc(suite.passed)
    } passed · ${esc(failed)} failed</span>
        </div>
      </div>`;
  }).join("");
  return `<div class="panel"><h2>Verifications</h2>${items}</div>`;
}

async function fetchReceipts(cid) {
  try {
    const body = await api(`/nodes/${encodeURIComponent(cid)}/verifications`);
    return body.data ?? [];
  } catch {
    return null;
  }
}

async function renderDetail(cid) {
  try {
    const body = await api(
      `/nodes/${encodeURIComponent(cid)}?include=relationships`,
    );
    const resource = body.data;
    const meta = resource.meta ?? {};
    const osk = resource.attributes?.osk ?? {};
    const lifecycle = osk.knowledge_lifecycle ?? {};
    const attribution = osk.attribution ?? {};
    const relationships = resource.relationships ?? {};
    const nodeType = resource.attributes?.osk?.node_type;

    const typeSection = renderPayload(resource);

    const metaRows = `
      <dt>CID</dt><dd class="cid">${esc(resource.id)}</dd>
      <dt>Node ID</dt><dd>${esc(osk.node_id ?? "—")}</dd>
      <dt>Status</dt><dd>${statusBadge(meta.effective_status)}</dd>
      <dt>Confidence</dt><dd>${esc(confidencePct(meta.confidence_score))}</dd>
      <dt>Version</dt><dd>${esc(meta.version ?? "—")}</dd>
      <dt>Created</dt><dd>${esc(fmtDate(meta.created_at))}</dd>
      <dt>Last verified</dt><dd>${esc(fmtDate(lifecycle.last_verified))}</dd>
      <dt>Author</dt><dd>${
      esc(attribution.public_key ? shortCid(attribution.public_key) : "—")
    }</dd>
      <dt>Supersedes</dt><dd>${cidLinkOrText(osk.supersedes_cid?.["/"])}</dd>`;

    const relationshipBlocks = Object.entries(relationships).map(
      ([name, rel]) => {
        const items = (rel.data ?? [])
          .map((r) =>
            `<div>${linkedCid(r.id, `${r.type} ${shortCid(r.id)}`)}</div>`
          )
          .join("");
        return `
        <div class="panel">
          <h2>${esc(name)}</h2>
          ${items || '<div class="empty" style="padding:12px">None.</div>'}
        </div>`;
      },
    ).join("");

    const includedBlock = (body.included ?? []).length
      ? `<div class="panel"><h2>Included</h2>${
        body.included.map((r) =>
          `<div>${linkedCid(r.id, `${r.type} ${titleOf(r)}`)}</div>`
        ).join("")
      }</div>`
      : "";

    const receiptsBlock = nodeType === "Recipe"
      ? renderReceipts(await fetchReceipts(resource.id))
      : "";

    view.innerHTML = `
      <a class="back" href="#/">← Browse</a>
      <div class="detail">
        <div class="detail-main">
          <div class="panel">
            <h2>${esc(titleOf(resource))}</h2>
            ${typeSection}
          </div>
          ${receiptsBlock}
        </div>
        <aside>
          <div class="panel"><h2>Metadata</h2><dl class="rows">${metaRows}</dl></div>
          ${relationshipBlocks}
          ${includedBlock}
        </aside>
      </div>`;
    pagination.hidden = true;
  } catch (err) {
    view.innerHTML = `<a class="back" href="#/">← Browse</a>
      <div class="error-box">${esc(err.message)}</div>`;
    pagination.hidden = true;
  }
}

function renderPayload(resource) {
  const payload = resource.attributes?.payload ?? {};
  if (payload.problem) return renderProblem(payload.problem);
  if (payload.recipe) return renderRecipe(payload.recipe);
  if (payload.guide) return renderGuide(payload.guide);
  if (payload.verification) return renderVerification(payload.verification);
  return "";
}

function renderProblem(problem) {
  const symptoms = (problem.symptoms ?? []).map((s) => `
    <div class="step">
      <div class="step-title">${esc(s.type)}</div>
      <p>${esc(s.description)}</p>
      <p>Observable: ${esc(s.observable)} · Frequency: ${esc(s.frequency)}</p>
    </div>`).join("");

  const runtime = problem.environment?.runtime ?? {};
  const framework = problem.environment?.framework ?? {};
  const agent = problem.environment?.agent_context ?? {};

  const summary = problem.summary ? `<p>${esc(problem.summary)}</p>` : "";
  const impact = problem.impact
    ? `<h3>Impact</h3><p>${esc(problem.impact)}</p>`
    : "";
  const reproduction = problem.reproduction
    ? `<h3>Reproduction</h3>${renderSteps(problem.reproduction)}`
    : "";
  const diagnosis = problem.diagnosis
    ? `<h3>Diagnosis</h3>${renderSteps(problem.diagnosis)}`
    : "";

  return `
    <div class="prose">
      ${summary}
      ${severityBadge(problem.severity)}
      ${impact}
      <dl class="rows">
        <dt>Root cause</dt><dd>${esc(problem.root_cause?.mechanism ?? "—")}</dd>
        <dt>Causal chain</dt><dd>${
    esc((problem.root_cause?.causal_chain ?? []).join(" → ") || "—")
  }</dd>
        <dt>Runtime</dt><dd>${esc(runtime.type ?? "—")} ${
    esc((runtime.versions ?? []).join(", "))
  }</dd>
        <dt>Framework</dt><dd>${esc(framework.name ?? "—")} ${
    esc(framework.version ?? "")
  }</dd>
        ${agent.model ? `<dt>Agent model</dt><dd>${esc(agent.model)}</dd>` : ""}
        ${
    agent.model
      ? `<dt>Context</dt><dd>${esc(agent.context_window_used)} / ${
        esc(agent.context_window_size)
      } tokens · ${esc(agent.tool_count)} tools</dd>`
      : ""
  }
      </dl>
      ${reproduction}
      ${diagnosis}
      <h3>Symptoms</h3>
      ${symptoms || '<p style="color:var(--text-muted)">None.</p>'}
      <h3>Environment</h3>
      <pre class="codeblock">${
    esc(JSON.stringify(problem.environment ?? {}, null, 2))
  }</pre>
      ${renderTags(problem.tags)}
      ${renderReferences(problem.references)}
    </div>`;
}

function renderRecipe(recipe) {
  const code = recipe.code ?? {};
  const caveats = (recipe.caveats ?? []).map((c) => `
    <li><strong>${esc(c.condition)}</strong>: ${esc(c.warning)}</li>`).join("");
  const prerequisites = (recipe.prerequisites ?? []).map((p) => `
    <li>${esc(p.description)}${
    p.node ? ` — ${linkedCid(p.node["/"])}` : ""
  }</li>`).join("");
  const summary = recipe.summary ? `<p>${esc(recipe.summary)}</p>` : "";

  return `
    <div class="prose">
      ${summary}
      <p>
        ${
    code.framework
      ? `<span class="badge muted">${esc(code.framework)}</span> `
      : ""
  }
        <span class="badge muted">${esc(code.language ?? "unknown")}</span>
      </p>
      <dl class="rows">
        <dt>Explanation</dt><dd>${esc(recipe.explanation ?? "—")}</dd>
      </dl>
      ${prerequisites ? `<h3>Prerequisites</h3><ul>${prerequisites}</ul>` : ""}
      ${
    recipe.steps?.length ? `<h3>Steps</h3>${renderSteps(recipe.steps)}` : ""
  }
      <h3>Code</h3>
      <pre class="codeblock">${esc(code.body ?? "")}</pre>
      ${
    recipe.verification
      ? `<h3>Verification</h3><p>${esc(recipe.verification)}</p>`
      : ""
  }
      ${caveats ? `<h3>Caveats</h3><ul>${caveats}</ul>` : ""}
      ${renderTags(recipe.tags)}
      ${renderReferences(recipe.references)}
    </div>`;
}

function verificationBadge(verification) {
  const type = verification.type === "demonstration"
    ? "Demonstrated"
    : "Attested";
  const cls = verification.result === "confirmed" ? "ok" : "warn";
  return `<span class="badge ${cls}">${type} · ${
    esc(verification.result)
  }</span>`;
}

function depthBadge(depth) {
  const cls = depth === "beginner" ? "muted" : "accent";
  return `<span class="badge ${cls}">${esc(depth)}</span>`;
}

function renderGuide(guide) {
  const sections = (guide.sections ?? []).map((s) => `
    <div class="step">
      <div class="step-title">${esc(s.heading)} ${depthBadge(s.depth)}</div>
      <p>${esc(s.claim)}</p>
      <p>${verificationBadge(s.verification)}</p>
    </div>`).join("");
  const prerequisites = (guide.prerequisites ?? []).map((p) => `
    <li>${linkedCid(p.node["/"])}${
    p.required_depth ? ` (requires ${esc(p.required_depth)})` : ""
  }</li>`).join("");
  const caveats = (guide.caveats ?? []).map((c) => `
    <li><strong>${esc(c.condition)}</strong>: ${esc(c.warning)}</li>`).join("");
  const statusCls = guide.epistemic_status === "verified"
    ? "ok"
    : guide.epistemic_status === "heuristic"
    ? "warn"
    : "muted";
  const summary = guide.summary ? `<p>${esc(guide.summary)}</p>` : "";

  return `
    <div class="prose">
      ${summary}
      <p><span class="badge ${statusCls}">${
    esc(guide.epistemic_status)
  }</span></p>
      ${prerequisites ? `<h3>Prerequisites</h3><ul>${prerequisites}</ul>` : ""}
      <h3>Sections</h3>
      ${sections || '<p style="color:var(--text-muted)">None.</p>'}
      ${caveats ? `<h3>Caveats</h3><ul>${caveats}</ul>` : ""}
      ${renderTags(guide.tags)}
    </div>`;
}

function renderVerification(verification) {
  const target = verification.target ?? {};
  const execution = verification.execution ?? {};
  const suite = execution.test_suite ?? {};
  const cases = (suite.cases ?? []).map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td>${esc(c.result)}</td>
      <td>${esc(String(c.expected ?? ""))}</td>
      <td>${esc(String(c.actual ?? ""))}</td>
    </tr>`).join("");

  return `
    <dl class="rows">
      <dt>Problem</dt><dd>${cidLinkOrText(target.problem_id?.["/"])}</dd>
      <dt>Solution</dt><dd>${cidLinkOrText(target.solution_id?.["/"])}</dd>
      <dt>Playground</dt><dd>${esc(execution.playground ?? "—")}</dd>
      <dt>Environment hash</dt><dd>${
    esc(execution.environment_hash ?? "—")
  }</dd>
      <dt>Result</dt><dd><span class="badge ${
    (suite.failed ?? 0) > 0 ? "bad" : "ok"
  }">${esc(suite.passed)} passed · ${esc(suite.failed)} failed</span></dd>
      <dt>Timestamp</dt><dd>${esc(fmtDate(verification.timestamp))}</dd>
      <dt>Valid until</dt><dd>${esc(fmtDate(verification.valid_until))}</dd>
    </dl>
    <h3>Test suite</h3>
    <table class="cases">
      <thead><tr><th>Case</th><th>Result</th><th>Expected</th><th>Actual</th></tr></thead>
      <tbody>${cases}</tbody>
    </table>`;
}

function render() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/nodes/")) {
    renderDetail(hash.slice("#/nodes/".length));
  } else {
    renderBrowse();
  }
}

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = searchInput.value.trim();
    state.offset = 0;
    if (location.hash.startsWith("#/nodes/")) {
      location.hash = "#/";
    } else {
      renderBrowse();
    }
  }, 250);
});

addEventListener("hashchange", render);
render();
