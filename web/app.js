const API_ACCEPT = { Accept: "application/vnd.api+json" };
const COLLECTIONS = [
  { id: "all", label: "All" },
  { id: "problems", label: "Problems" },
  { id: "recipes", label: "Recipes" },
  { id: "verifications", label: "Verifications" },
];

const STATUSES = [
  "",
  "draft",
  "active",
  "open",
  "resolved",
  "disputed",
  "stale",
  "deprecated",
];
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
  sort: "-created_at",
  limit: 25,
  offset: 0,
  next: null,
  prev: null,
  total: 0,
};

const view = document.getElementById("view");
const pagination = document.getElementById("pagination");

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
  open: "ok",
  resolved: "ok",
  active: "ok",
  draft: "warn",
  disputed: "bad",
  deprecated: "bad",
  stale: "warn",
};

function statusBadge(status) {
  const cls = STATUS_CLASS[status] ?? "muted";
  return `<span class="badge ${cls}">${esc(status)}</span>`;
}

function confidencePct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function titleOf(resource) {
  const payload = resource?.attributes?.payload ?? {};
  if (payload.problem) return payload.problem.title;
  if (payload.recipe) return payload.recipe.title;
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
  params.set("sort", state.sort);
  params.set("page[limit]", String(state.limit));
  params.set("page[offset]", String(state.offset));
  return params.toString();
}

async function renderBrowse() {
  try {
    const body = await api(`/nodes?${queryString()}`);
    state.next = body.links?.next ?? null;
    state.prev = body.links?.prev ?? null;
    state.total = body.meta?.total ?? 0;

    const rows = (body.data ?? []).map((resource) => {
      const meta = resource.meta ?? {};
      return `
        <div class="node-row">
          <div class="row-main">
            <div class="row-title">
              <a href="#/nodes/${esc(resource.id)}">${
        esc(titleOf(resource))
      }</a>
            </div>
            <div class="row-sub">${esc(typeLabel(resource))} · ${
        esc(shortCid(resource.id))
      }</div>
          </div>
          <div class="row-meta">
            ${statusBadge(meta.effective_status)}<br />
            ${esc(confidencePct(meta.confidence_score))} · ${
        esc(fmtDate(meta.created_at))
      }
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

    const typeSection = renderPayload(resource);

    const metaRows = `
      <dt>CID</dt><dd>${esc(resource.id)}</dd>
      <dt>Node ID</dt><dd>${esc(osk.node_id ?? "—")}</dd>
      <dt>Type</dt><dd>${esc(typeLabel(resource))}</dd>
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

    view.innerHTML = `
      <a class="back" href="#/">← Browse</a>
      <div class="panel">
        <h2>${esc(titleOf(resource))}</h2>
        ${typeSection}
      </div>
      <div class="panel"><h2>Metadata</h2><dl class="rows">${metaRows}</dl></div>
      ${relationshipBlocks}
      ${includedBlock}`;
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
  if (payload.verification) return renderVerification(payload.verification);
  return "";
}

function renderProblem(problem) {
  const symptoms = (problem.symptoms ?? []).map((s) => `
    <div class="panel" style="margin-bottom:8px">
      <strong>${esc(s.type)}</strong> — ${esc(s.description)}<br />
      <span style="color:var(--muted);font-size:13px">Observable: ${
    esc(s.observable)
  } · Frequency: ${esc(s.frequency)}</span>
    </div>`).join("");

  const environment = problem.environment ?? {};
  const runtime = environment.runtime ?? {};
  const framework = environment.framework ?? {};
  const agent = environment.agent_context ?? {};

  return `
    <p>
      <span class="badge ${
    SEVERITIES.includes(problem.severity)
      ? STATUS_CLASS[problem.severity] ?? "muted"
      : "muted"
  }">${esc(problem.severity)}</span>
    </p>
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
    <h2>Symptoms</h2>${symptoms || '<p style="color:var(--muted)">None.</p>'}
    <h2>Environment</h2>
    <pre class="codeblock">${
    esc(JSON.stringify(problem.environment ?? {}, null, 2))
  }</pre>`;
}

function renderRecipe(recipe) {
  const code = recipe.code ?? {};
  const caveats = (recipe.caveats ?? []).map((c) => `
    <li><strong>${esc(c.condition)}</strong>: ${esc(c.warning)}</li>`).join("");

  return `
    <p>
      ${
    code.framework
      ? `<span class="badge muted">${esc(code.framework)}</span>`
      : ""
  }
      <span class="badge muted">${esc(code.language ?? "unknown")}</span>
    </p>
    <dl class="rows">
      <dt>Explanation</dt><dd>${esc(recipe.explanation ?? "—")}</dd>
    </dl>
    <h2>Code</h2>
    <pre class="codeblock">${esc(code.body ?? "")}</pre>
    ${caveats ? `<h2>Caveats</h2><ul>${caveats}</ul>` : ""}`;
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
    <h2>Test suite</h2>
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

window.addEventListener("hashchange", render);
render();
