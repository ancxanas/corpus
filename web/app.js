const API_ACCEPT = { Accept: "application/vnd.api+json" };

const COLLECTIONS = [
  { id: "all", label: "All" },
  { id: "problems", label: "Problems" },
  { id: "recipes", label: "Recipes" },
  { id: "guides", label: "Guides" },
  { id: "references", label: "References" },
  { id: "comparisons", label: "Comparisons" },
  { id: "improvements", label: "Improvements" },
  { id: "blueprints", label: "Blueprints" },
];
const HERO = {
  all: {
    title: "Signed engineering notes",
    blurb: "What broke, how to fix it, and the receipts that back the fix.",
  },
  problems: {
    title: "Problems",
    blurb:
      "Failures with symptoms, reproduction steps, root causes, and linked fixes.",
  },
  recipes: {
    title: "Recipes",
    blurb:
      "Fixes with prerequisites, steps, caveats, and verification receipts.",
  },
  guides: {
    title: "Guides",
    blurb:
      "Walkthroughs that connect a failure to its fix and the reasoning between them.",
  },
  references: {
    title: "References",
    blurb: "Factual API and behavior documentation backed by source pointers.",
  },
  comparisons: {
    title: "Comparisons",
    blurb:
      "Trade-off analyses between verified options, with receipts backing the numbers.",
  },
  improvements: {
    title: "Improvements",
    blurb:
      "Phased migration plans with before and after metrics and linked recipes.",
  },
  blueprints: {
    title: "Blueprints",
    blurb:
      "Architectural visions with feasibility analysis and adoption trajectories.",
  },
};

const STATUSES = ["", "active", "draft", "disputed", "stale", "deprecated"];
const SEVERITIES = ["", "critical", "high", "medium", "low"];
const SORTS = [
  { id: "-created_at", label: "Newest" },
  { id: "created_at", label: "Oldest" },
  { id: "-confidence_score", label: "Confidence" },
  { id: "-last_verified", label: "Last verified" },
];

const TYPE_ICON = {
  problems: "alert",
  recipes: "beaker",
  guides: "book",
  verifications: "shield",
  references: "bookmark",
  comparisons: "scale",
  improvements: "trending-up",
  blueprints: "layers",
};

const state = {
  collection: "all",
  status: "",
  severity: "",
  search: "",
  sort: "-created_at",
  limit: 10,
  offset: 0,
  next: null,
  prev: null,
  total: 0,
  counts: {
    problems: null,
    recipes: null,
    guides: null,
    verifications: null,
    references: null,
    comparisons: null,
    improvements: null,
    blueprints: null,
  },
};

const view = document.getElementById("view");
const pagination = document.getElementById("pagination");
const searchInput = document.getElementById("search");
let searchTimer = null;
let renderToken = 0;

/* ---------- helpers ---------- */

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
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function fmtDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function confidencePct(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function confidenceClass(value) {
  if (value == null) return "";
  if (value >= 0.7) return "ok";
  if (value >= 0.4) return "warn";
  return "bad";
}

function typeOf(resource) {
  return resource?.attributes?.osk?.node_type ?? resource?.type ?? "node";
}

function typeId(resource) {
  return typeOf(resource).toLowerCase();
}

function titleOf(resource) {
  const metaTitle = resource?.meta?.title;
  if (metaTitle) return metaTitle;
  const payload = resource?.attributes?.payload ?? {};
  if (payload.problem) return payload.problem.title;
  if (payload.recipe) return payload.recipe.title;
  if (payload.guide) return payload.guide.title;
  if (payload.comparison) return payload.comparison.title;
  if (payload.reference) return payload.reference.title;
  if (payload.improvement) return payload.improvement.title;
  if (payload.blueprint) return payload.blueprint.title;
  if (payload.verification) {
    return `Verification of ${
      shortCid(payload.verification.target?.solution_id?.["/"])
    }`;
  }
  return resource?.id ?? "Untitled";
}

function snippetOf(resource) {
  const payload = resource?.attributes?.payload ?? {};
  if (payload.problem) return payload.problem.summary ?? "";
  if (payload.recipe) return payload.recipe.summary ?? "";
  if (payload.guide) return payload.guide.summary ?? "";
  if (payload.verification) {
    const exec = payload.verification.execution;
    const suite = exec?.test_suite;
    return suite ? `${suite.passed}/${suite.total} passed` : "";
  }
  if (payload.reference) {
    return payload.reference.entries?.[0]?.description ?? "";
  }
  if (payload.comparison) return payload.comparison.decision_context ?? "";
  if (payload.improvement) return payload.improvement.rationale ?? "";
  if (payload.blueprint) {
    return payload.blueprint.proposed_architecture?.core_principle ?? "";
  }
  return "";
}

function tagsOf(resource) {
  const payload = resource?.attributes?.payload ?? {};
  return payload.problem?.tags ?? payload.recipe?.tags ?? payload.guide?.tags ??
    [];
}

function nodeLink(cid, label) {
  return `<a href="#/nodes/${esc(cid)}">${esc(label ?? shortCid(cid))}</a>`;
}

function cidLinkOrText(cid) {
  return cid ? nodeLink(cid) : "—";
}

function receiptCidText(cid) {
  if (!cid) return "—";
  return `<span class="mono" style="font-size:12px">${
    esc(shortCid(cid))
  }… <button class="copy-btn" data-copy-cid="${
    esc(
      cid,
    )
  }" title="Copy receipt CID">${icon("copy")}</button></span>`;
}

function titleForIncluded(includedById, cid) {
  const r = includedById.get(cid);
  return r ? titleOf(r) : shortCid(cid);
}

function collectPayloadCids(payload) {
  const cids = new Set();
  const imp = payload.improvement;
  if (imp) {
    for (const phase of (imp.implementation?.phases ?? [])) {
      for (const rl of (phase.recipe_links ?? [])) {
        if (rl.node?.["/"]) cids.add(rl.node["/"]);
      }
    }
  }
  const bp = payload.blueprint;
  if (bp) {
    for (const rn of (bp.related_nodes ?? [])) {
      if (rn.node?.["/"]) cids.add(rn.node["/"]);
    }
  }
  return [...cids];
}

async function resolvePayloadRefs(payload, includedById) {
  const cids = collectPayloadCids(payload);
  const missing = cids.filter((cid) => !includedById.has(cid));
  if (missing.length === 0) return;
  const results = await Promise.all(
    missing.map(async (cid) => {
      try {
        const body = await api(`/nodes/${encodeURIComponent(cid)}`);
        return body.data ?? null;
      } catch {
        return null;
      }
    }),
  );
  for (let i = 0; i < missing.length; i++) {
    if (results[i]) includedById.set(missing[i], results[i]);
  }
}

/* ---------- icons ---------- */

const ICONS = {
  alert:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  beaker:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h6"/><path d="M10 3v6L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 9V3"/><path d="M7 15h10"/></svg>`,
  book:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
  shield:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`,
  scale:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>`,
  back:
    `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  copy:
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  external:
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
  warning:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  empty:
    `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  error:
    `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  info:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  clock:
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 16 14"/></svg>`,
  bookmark:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
  "trending-up":
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
  layers:
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
};

function icon(name) {
  return ICONS[name] ?? "";
}

/* ---------- api ---------- */

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
  if (state.severity) {
    params.set("filter[severity]", state.severity);
  }
  if (state.search) {
    params.set("search", state.search);
  }
  params.set("sort", state.sort);
  params.set("page[limit]", String(state.limit));
  params.set("page[offset]", String(state.offset));
  return params.toString();
}

async function fetchCounts() {
  const [
    problems,
    recipes,
    guides,
    references,
    comparisons,
    improvements,
    blueprints,
    verifications,
  ] = await Promise.all([
    api("/nodes?filter[node_type]=problems&page[limit]=1"),
    api("/nodes?filter[node_type]=recipes&page[limit]=1"),
    api("/nodes?filter[node_type]=guides&page[limit]=1"),
    api("/nodes?filter[node_type]=references&page[limit]=1"),
    api("/nodes?filter[node_type]=comparisons&page[limit]=1"),
    api("/nodes?filter[node_type]=improvements&page[limit]=1"),
    api("/nodes?filter[node_type]=blueprints&page[limit]=1"),
    api("/verifications?limit=1"),
  ]);
  state.counts = {
    problems: problems.meta?.total ?? 0,
    recipes: recipes.meta?.total ?? 0,
    guides: guides.meta?.total ?? 0,
    references: references.meta?.total ?? 0,
    comparisons: comparisons.meta?.total ?? 0,
    improvements: improvements.meta?.total ?? 0,
    blueprints: blueprints.meta?.total ?? 0,
  };
  state.receiptCount = verifications.meta?.total ?? 0;
}

/* ---------- render helpers ---------- */

function pill(status) {
  const cls = STATUSES.includes(status) ? status : "neutral";
  return `<span class="pill ${cls}"><span class="dot"></span>${
    esc(status)
  }</span>`;
}

function renderTags(tags) {
  if (!tags?.length) return "";
  return `<div class="row-tags">${
    tags.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join("")
  }</div>`;
}

function renderSteps(steps) {
  if (!steps?.length) return "";
  return `<div>${
    steps.map((s, i) => `
      <div class="step">
        <span class="step-num">${i + 1}</span>
        <div class="step-body">
          <div class="step-title">${esc(s.title)}</div>
          <p>${esc(s.body)}</p>
          ${s.code ? renderStepCode(s.code, `step-${i + 1}`) : ""}
        </div>
      </div>`).join("")
  }</div>`;
}

function renderStepCode(code, id) {
  if (typeof code === "string") {
    return `<pre class="codeblock" id="code-${esc(id)}">${esc(code)}</pre>`;
  }
  return renderCode(code, id);
}

function renderCode(code, id) {
  const lang = code?.language ?? "text";
  const framework = code?.framework;
  return `
    <div class="codeblock-wrap">
      <div class="codeblock-head">
        <span class="lang">${esc(framework ? `${framework} · ` : "")}${
    esc(lang)
  }</span>
        <button class="copy-btn" data-copy="${esc(id)}">
          ${icon("copy")} Copy
        </button>
      </div>
      <pre class="codeblock" id="code-${esc(id)}">${esc(code?.body ?? "")}</pre>
    </div>`;
}

function renderReferences(references) {
  if (!references?.length) return "";
  return `
    <h2>References</h2>
    <ul>
      ${
    references.map((r) =>
      `<li><a href="${esc(r.url)}" target="_blank" rel="noreferrer">${
        esc(r.title)
      } ${icon("external")}</a></li>`
    ).join("")
  }
    </ul>`;
}

function renderCalloutList(items, type, heading) {
  if (!items?.length) return "";
  return `
    <h2>${esc(heading)}</h2>
    ${
    items.map((c) => `
      <div class="callout ${type}">
        ${icon(type === "warning" ? "warning" : "info")}
        <p><strong>${esc(c.condition)}</strong> — ${esc(c.warning)}</p>
      </div>`).join("")
  }`;
}

/* ---------- browse ---------- */

function countValue(id) {
  const v = state.counts[id];
  return v === null || v === undefined ? "–" : v;
}

function tabsHtml() {
  const countFor = (id) =>
    id === "all"
      ? (Object.keys(state.counts).some((k) => countValue(k) === "–")
        ? "–"
        : Object.keys(state.counts).reduce((sum, k) => sum + countValue(k), 0))
      : countValue(id);
  return `
    <nav class="tabs" aria-label="Knowledge types">
      ${
    COLLECTIONS.map((c) => `
        <button data-collection="${c.id}" class="${
      c.id === state.collection ? "active" : ""
    }">
          ${esc(c.label)}
          <span class="count">${countFor(c.id)}</span>
        </button>`).join("")
  }
    </nav>`;
}

function toolbarHtml() {
  return `
    <div class="toolbar">
      <select id="status" aria-label="Filter by status">
        ${
    STATUSES.map((s) =>
      `<option value="${s}" ${s === state.status ? "selected" : ""}>${
        s === "" ? "Any status" : s
      }</option>`
    ).join("")
  }
      </select>
      <select id="severity" aria-label="Filter by severity">
        ${
    SEVERITIES.map((s) =>
      `<option value="${s}" ${s === state.severity ? "selected" : ""}>${
        s === "" ? "Any severity" : s
      }</option>`
    ).join("")
  }
      </select>
      <select id="sort" aria-label="Sort">
        ${
    SORTS.map((s) =>
      `<option value="${s.id}" ${s.id === state.sort ? "selected" : ""}>${
        esc(s.label)
      }</option>`
    ).join("")
  }
      </select>
    </div>`;
}

function rowHtml(resource) {
  const meta = resource.meta ?? {};
  const t = typeId(resource);
  return `
    <article class="row">
      <div class="row-icon type-${esc(t)}">${icon(TYPE_ICON[t] ?? "info")}</div>
      <div class="row-body">
        <div class="row-title"><a href="#/nodes/${esc(resource.id)}">${
    esc(titleOf(resource))
  }</a></div>
        ${
    snippetOf(resource)
      ? `<div class="row-snippet">${esc(snippetOf(resource))}</div>`
      : ""
  }
        ${renderTags(tagsOf(resource))}
      </div>
      <div class="row-side">
        ${pill(meta.effective_status ?? "draft")}
        <span class="confidence ${confidenceClass(meta.confidence_score)}">${
    esc(confidencePct(meta.confidence_score))
  }</span>
        <span class="date">${esc(fmtDate(meta.created_at))}</span>
      </div>
    </article>`;
}

function skeletonRows() {
  return Array.from({ length: 6 }, (_, i) => `
    <div class="skeleton-row" aria-hidden="true">
      <div class="skeleton" style="width:32px;height:32px;border-radius:6px"></div>
      <div style="flex:1">
        <div class="skeleton" style="width:${
    Math.min(70, 55 + i * 4)
  }%;height:14px"></div>
        <div class="skeleton" style="width:45%;height:12px;margin-top:8px"></div>
      </div>
      <div class="skeleton" style="width:60px;height:18px;border-radius:999px"></div>
    </div>`).join("");
}

function renderPagination() {
  if (state.total <= state.limit) {
    pagination.innerHTML = "";
    pagination.hidden = true;
    return;
  }
  pagination.hidden = false;
  const pageNum = Math.min(
    Math.floor(state.offset / state.limit) + 1,
    Math.max(1, Math.ceil(state.total / state.limit)),
  );
  const pageCount = Math.max(1, Math.ceil(state.total / state.limit));
  const lastOffset = Math.max(0, Math.ceil(state.total / state.limit) - 1) *
    state.limit;
  pagination.innerHTML = `
    <button class="btn" id="prev" ${
    state.prev ? "" : "disabled"
  }>← Previous</button>
    <span class="page-info">Page <b>${pageNum}</b> of <b>${pageCount}</b> · ${state.total} node${
    state.total === 1 ? "" : "s"
  }</span>
    <button class="btn" id="next" ${
    state.next ? "" : "disabled"
  }>Next →</button>`;
  pagination.querySelector("#prev")?.addEventListener("click", () => {
    if (!state.prev) return;
    state.offset = Math.max(0, state.offset - state.limit);
    renderBrowse();
  });
  pagination.querySelector("#next")?.addEventListener("click", () => {
    if (!state.next) return;
    state.offset = Math.min(lastOffset, state.offset + state.limit);
    renderBrowse();
  });
}

function hasActiveFilters() {
  return Boolean(state.status || state.severity || state.search);
}

function emptyBox() {
  const isSearch = Boolean(state.search);
  return `
    <div class="state-box">
      ${icon("empty")}
      <h3>${isSearch ? "No matches" : "Nothing here yet"}</h3>
      <p>${
    isSearch
      ? `No knowledge matches “${esc(state.search)}”. Try a different search.`
      : `No ${
        state.collection === "all" ? "nodes" : state.collection
      } match these filters.`
  }</p>
      ${
    hasActiveFilters()
      ? `<button class="btn" id="clear-filters">Clear filters</button>`
      : ""
  }
    </div>`;
}

async function renderBrowse() {
  const token = ++renderToken;
  pagination.hidden = true;
  view.innerHTML = `
    ${heroBlock()}
    ${tabsHtml()}
    ${toolbarHtml()}
    <div class="node-list">${skeletonRows()}</div>`;
  bindBrowseControls();

  try {
    await fetchCounts();
    if (token !== renderToken) return;
    const chipsEl = view.querySelector(".stat-chips");
    if (chipsEl) {
      chipsEl.outerHTML = chipsHtml();
    }
    const body = await api(`/nodes?${queryString()}`);
    if (token !== renderToken) return;
    state.next = body.links?.next ?? null;
    state.prev = body.links?.prev ?? null;
    state.total = body.meta?.total ?? 0;

    const rows = (body.data ?? []).map(rowHtml).join("");
    const tabsEl = view.querySelector(".tabs");
    if (tabsEl) {
      tabsEl.outerHTML = tabsHtml();
      bindTabButtons();
    }
    const listEl = view.querySelector(".node-list");
    if (listEl) {
      listEl.innerHTML = rows || emptyBox();
      view.querySelector("#clear-filters")?.addEventListener("click", () => {
        state.status = "";
        state.severity = "";
        state.search = "";
        searchInput.value = "";
        renderBrowse();
      });
    }
    renderPagination();
  } catch (err) {
    if (token !== renderToken) return;
    pagination.innerHTML = "";
    pagination.hidden = true;
    const listEl = view.querySelector(".node-list");
    if (listEl) {
      listEl.innerHTML = `
        <div class="state-box">
          ${icon("error")}
          <h3>Could not load</h3>
          <p>${esc(err.message)}</p>
          <button class="btn" id="retry">Retry</button>
        </div>`;
      view.querySelector("#retry")?.addEventListener("click", renderBrowse);
    }
  }
}

function bindTabButtons() {
  for (const btn of view.querySelectorAll("[data-collection]")) {
    btn.addEventListener("click", () => {
      state.collection = btn.dataset.collection;
      state.offset = 0;
      state.severity = "";
      renderBrowse();
    });
  }
}

function bindBrowseControls() {
  bindTabButtons();
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
  view.querySelector("#clear-filters")?.addEventListener("click", () => {
    state.status = "";
    state.severity = "";
    state.search = "";
    searchInput.value = "";
    renderBrowse();
  });
}

function chipsHtml() {
  const chips = COLLECTIONS.filter((c) => c.id !== "all").map((c) => `
      <div class="stat-chip">
        <span class="value">${countValue(c.id)}</span>
        <span class="label">${esc(c.label)}</span>
      </div>`).join("");
  const receiptChip = state.receiptCount
    ? `<div class="stat-chip">
        <span class="value">${state.receiptCount}</span>
        <span class="label">Receipts</span>
      </div>`
    : "";
  return `<div class="stat-chips">${chips}${receiptChip}</div>`;
}

function heroBlock() {
  const hero = HERO[state.collection] ?? HERO.all;
  return `
    <section class="page-head">
      <div>
        <h1>${esc(hero.title)}</h1>
        <p class="blurb">${esc(hero.blurb)}</p>
      </div>
      ${chipsHtml()}
    </section>`;
}

/* ---------- detail ---------- */

async function fetchReceipts(cid) {
  try {
    const body = await api(`/nodes/${encodeURIComponent(cid)}/verifications`);
    return body.data ?? [];
  } catch {
    return [];
  }
}

async function fetchVersions(nodeId) {
  if (!nodeId) return [];
  try {
    const body = await api(
      `/nodes/by-node-id/${encodeURIComponent(nodeId)}/versions`,
    );
    return body.data ?? [];
  } catch {
    return [];
  }
}

async function fetchSolvedProblems(cid) {
  try {
    const body = await api(`/nodes/${encodeURIComponent(cid)}/problems`);
    return body.data ?? [];
  } catch {
    return [];
  }
}

function renderSolvedProblemsPanel(problems) {
  if (!problems.length) return "";
  const items = problems.map((p) => {
    const problem = p.attributes?.payload?.problem ?? {};
    return `
      <div class="rel-group">
        <div class="rel-name">Problem</div>
        <ul>
          <li class="rel-solution">
            ${nodeLink(p.id, problem.title ?? shortCid(p.id))}
            <div class="rel-solution-sub">${
      p.meta?.effective_status ? pill(p.meta.effective_status) : ""
    }${
      problem.severity
        ? `<span class="pill neutral"><span class="dot"></span>${
          esc(problem.severity)
        }</span>`
        : ""
    }</div>
          </li>
        </ul>
      </div>`;
  }).join("");
  return `
    <div class="side-panel">
      <h3>Solved problems</h3>
      ${items}
    </div>`;
}

function metadataPanel(resource, lifecycle, attribution, versions, currentCid) {
  const meta = resource.meta ?? {};
  const osk = resource.attributes?.osk ?? {};
  const confidence = meta.confidence_score;
  const sup = osk.supersedes_cid?.["/"];

  const versionLinks = versions.length
    ? `<div class="versions">${
      versions.map((v, i) => `
        <div class="version-item ${v.id === currentCid ? "current" : ""}">
          <span class="vnum">v${i + 1}</span>
          ${
        v.id === currentCid
          ? `<span>${esc(titleOf(v))} · current</span>`
          : nodeLink(v.id, `${esc(titleOf(v))}`)
      }
        </div>`).join("")
    }</div>`
    : `<p style="color:var(--text-muted);font-size:13px;margin:0">Single version.</p>`;

  return `
    <div class="side-panel">
      <h3>Metadata</h3>
      <div class="meta-row"><span class="k">Status</span><span class="v">${
    pill(meta.effective_status ?? "draft")
  }</span></div>
      <div class="meta-row"><span class="k">Confidence</span><span class="v">${
    esc(confidencePct(confidence))
  }</span></div>
      <div class="confbar"><i class="${
    confidenceClass(confidence)
  }" style="width:${Math.round((confidence ?? 0) * 100)}%"></i></div>
      <div class="meta-row" style="margin-top:8px"><span class="k">Version</span><span class="v">${
    esc(meta.version ?? "—")
  }</span></div>
      <div class="meta-row"><span class="k">Created</span><span class="v">${
    esc(fmtDateTime(meta.created_at))
  }</span></div>
      <div class="meta-row"><span class="k">Last verified</span><span class="v">${
    esc(fmtDateTime(lifecycle.last_verified))
  }</span></div>
      <div class="meta-row"><span class="k">Author</span><span class="v">${
    esc(shortCid(attribution.public_key))
  }</span></div>
      ${
    sup
      ? `<div class="meta-row"><span class="k">Supersedes</span><span class="v">${
        cidLinkOrText(sup)
      }</span></div>`
      : ""
  }
      <div class="meta-row"><span class="k">CID</span><span class="v mono">${
    esc(shortCid(resource.id))
  }…</span></div>
    </div>
    <div class="side-panel">
      <h3>Versions</h3>
      ${versionLinks}
    </div>`;
}

function relationshipsPanel(resource, includedById = new Map()) {
  const relationships = resource.relationships ?? {};
  const groups = Object.entries(relationships).filter(([, rel]) =>
    (rel.data ?? []).length > 0
  );
  if (groups.length === 0) return "";
  return `
    <div class="side-panel">
      <h3>Relationships</h3>
      ${
    groups.map(([name, rel]) => `
        <div class="rel-group">
          <div class="rel-name">${esc(name)}</div>
          <ul>
            ${
      (rel.data ?? []).map((r) => {
        const inc = includedById.get(r.id);
        if (inc && inc.type === "verifications") {
          const suite = inc.attributes?.test_suite ?? {};
          const failed = suite.failed ?? 0;
          const total = suite.total ?? 0;
          const pct = total > 0
            ? Math.round(((suite.passed ?? 0) / total) * 100)
            : 0;
          return `
              <li class="rel-receipt">
                <span>${receiptCidText(r.id)}</span>
                <span class="pct ${failed > 0 ? "bad" : "ok"}">${
            esc(pct)
          }%</span>
                <span class="mono" style="font-size:11px;color:var(--text-muted)">${
            esc(suite.passed)
          }/${esc(total)}</span>
              </li>`;
        }
        if (inc && inc.attributes?.payload?.recipe) {
          const title = inc.attributes.payload.recipe.title;
          const c = inc.meta?.confidence_score;
          return `
              <li class="rel-solution">
                ${nodeLink(r.id, title)}
                <div class="rel-solution-sub">${
            inc.meta?.effective_status ? pill(inc.meta.effective_status) : ""
          }${
            c == null
              ? ""
              : `<span class="confidence ${confidenceClass(c)}">${
                esc(confidencePct(c))
              }</span>`
          }</div>${
            r.meta?.applies_to
              ? `<div class="rel-applies">when ${esc(r.meta.applies_to)}</div>`
              : ""
          }
              </li>`;
        }
        return `<li>${
          nodeLink(r.id, `${esc(r.type)} ${esc(shortCid(r.id))}`)
        }</li>`;
      }).join("")
    }
          </ul>
        </div>`).join("")
  }
    </div>`;
}

function copyPanel(resource) {
  return `
    <div class="side-panel">
      <h3>Identifier</h3>
      <div class="mono" style="font-size:12px;word-break:break-all;color:var(--text-secondary)">${
    esc(resource.id)
  }</div>
      <div style="margin-top:10px">
        <button class="btn" data-copy-cid="${
    esc(resource.id)
  }" style="width:100%;justify-content:center">
          ${icon("copy")} Copy CID
        </button>
      </div>
    </div>`;
}

function trustLabel(replayedBy) {
  if (replayedBy === "sandbox") return "executed in sandbox";
  if (replayedBy === "trusted-stub") return "operator-vouched, not executed";
  if (replayedBy === "stub") return "replay stub, not executed";
  return replayedBy;
}

function renderReceiptsPanel(receipts) {
  if (!receipts.length) return "";
  const items = receipts.map((r) => {
    const suite = r.attributes?.test_suite ?? {};
    const failed = suite.failed ?? 0;
    const total = suite.total ?? 0;
    const pct = total > 0 ? Math.round(((suite.passed ?? 0) / total) * 100) : 0;
    const context = r.attributes?.agent_context;
    const replay = r.attributes?.replayed_by;
    const measurements = Array.isArray(suite.measurements)
      ? suite.measurements
      : [];
    const extra = [
      replay
        ? `<div class="receipt-extra"><span class="trust-badge">${
          esc(
            trustLabel(replay),
          )
        }</span></div>`
        : "",
      measurements.length > 0
        ? `<div class="receipt-extra">${
          measurements.map((m) => `
            <span class="measure-chip" title="${esc(m.description ?? m.name)}">
              <b>${esc(m.name)}</b> ${m.value}${
            m.unit ? ` ${esc(m.unit)}` : ""
          }</span>`).join("")
        }</div>`
        : "",
      context
        ? `<div class="receipt-extra mono">verified by ${
          esc(context.model)
        } · ` +
          `context ${esc(context.context_window_used)}/${
            esc(context.context_window_size)
          } · ` +
          `${esc(context.tool_count)} tools · chain ${
            esc(context.reasoning_chain_length)
          }</div>`
        : "",
    ].join("");
    return `
      <div class="receipt">
        <div class="receipt-main">
          <div class="receipt-title">${receiptCidText(r.id)}</div>
          <div class="receipt-sub">${
      esc(fmtDateTime(r.attributes?.timestamp))
    }</div>
        </div>
        <div class="receipt-score">
          <div class="pct ${failed > 0 ? "bad" : "ok"}">${esc(pct)}%</div>
          <div class="mono" style="font-size:11px;color:var(--text-muted)">${
      esc(suite.passed)
    }/${esc(total)}</div>
        </div>
        ${extra}
      </div>`;
  }).join("");
  return `
    <section class="article">
      <div class="article-head">
        <div class="kicker">${icon("shield")} Verification receipts</div>
        <h1 style="font-size:18px">Evidence</h1>
        <p class="lead">${receipts.length} verification${
    receipts.length === 1 ? "" : "s"
  } recorded against this recipe.</p>
      </div>
      ${items}
    </section>`;
}

async function renderDetail(cid) {
  const token = ++renderToken;
  pagination.innerHTML = "";
  pagination.hidden = true;
  view.innerHTML = `
    <a class="back" href="#/">${icon("back")} Browse</a>
    <div class="state-box"><div class="skeleton" style="width:70%;height:16px"></div></div>`;

  try {
    const body = await api(
      `/nodes/${encodeURIComponent(cid)}?include=solutions,benchmarks`,
    );
    if (token !== renderToken) return;
    const resource = body.data;
    const osk = resource.attributes?.osk ?? {};
    const lifecycle = osk.knowledge_lifecycle ?? {};
    const attribution = osk.attribution ?? {};
    const payload = resource.attributes?.payload ?? {};
    const meta = resource.meta ?? {};
    const t = typeId(resource);
    const includedById = new Map(
      (body.included ?? []).map((r) => [r.id, r]),
    );

    await resolvePayloadRefs(payload, includedById);
    if (token !== renderToken) return;

    const [receipts, versions, solvedProblems] = await Promise.all([
      payload.recipe ? fetchReceipts(resource.id) : Promise.resolve([]),
      fetchVersions(osk.node_id),
      payload.recipe ? fetchSolvedProblems(resource.id) : Promise.resolve([]),
    ]);
    if (token !== renderToken) return;

    const bodyHtml = payload.problem
      ? renderProblem(payload.problem)
      : payload.recipe
      ? renderRecipe(payload.recipe)
      : payload.guide
      ? renderGuide(payload.guide)
      : payload.verification
      ? renderVerification(payload.verification)
      : payload.reference
      ? renderReference(payload.reference)
      : payload.comparison
      ? renderComparison(payload.comparison)
      : payload.improvement
      ? renderImprovement(payload.improvement, includedById)
      : payload.blueprint
      ? renderBlueprint(payload.blueprint, includedById)
      : `<p style="color:var(--text-muted)">No readable body.</p>`;

    const articleMeta = `
      <span class="item">${icon("clock")}${esc(fmtDate(meta.created_at))}</span>
      <span class="item">${
      esc(confidencePct(meta.confidence_score))
    } confidence</span>
      <span class="item mono">${esc(t)} · v${esc(meta.version ?? "1")}</span>
      <span class="item">${pill(meta.effective_status ?? "draft")}</span>`;

    view.innerHTML = `
      <a class="back" href="#/">${icon("back")} Browse</a>
      <div class="detail">
        <div class="detail-main">
          <article class="article">
            <header class="article-head">
              <div class="kicker">${icon(TYPE_ICON[t] ?? "info")} ${
      esc(t)
    }</div>
              <h1>${esc(titleOf(resource))}</h1>
              ${
      snippetOf(resource)
        ? `<p class="lead">${esc(snippetOf(resource))}</p>`
        : ""
    }
              <div class="article-meta">${articleMeta}</div>
            </header>
            <div class="article-body">
              ${bodyHtml}
            </div>
          </article>
          ${renderReceiptsPanel(receipts)}
        </div>
        <aside class="sidebar">
          ${
      metadataPanel(resource, lifecycle, attribution, versions, resource.id)
    }
          ${relationshipsPanel(resource, includedById)}
          ${renderSolvedProblemsPanel(solvedProblems)}
          ${copyPanel(resource)}
        </aside>
      </div>`;

    bindCopyButtons();
  } catch (err) {
    if (token !== renderToken) return;
    view.innerHTML = `
      <a class="back" href="#/">${icon("back")} Browse</a>
      <div class="error-box">
        ${icon("error")}
        <div><p style="font-weight:600">Could not load this node</p><p>${
      esc(err.message)
    }</p></div>
      </div>`;
  }
}

function bindCopyButtons() {
  for (const btn of view.querySelectorAll("[data-copy-cid]")) {
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copyCid);
        const prev = btn.innerHTML;
        btn.innerHTML = `${icon("copy")} Copied`;
        setTimeout(() => (btn.innerHTML = prev), 1200);
      } catch {
        /* clipboard unavailable */
      }
    });
  }
  for (const btn of view.querySelectorAll("[data-copy]")) {
    btn.addEventListener("click", async () => {
      const pre = view.querySelector(`#code-${esc(btn.dataset.copy)}`);
      if (!pre) return;
      const code = pre.textContent;
      try {
        await navigator.clipboard.writeText(code);
        const prev = btn.innerHTML;
        btn.innerHTML = `${icon("copy")} Copied`;
        setTimeout(() => (btn.innerHTML = prev), 1200);
      } catch {
        /* clipboard unavailable */
      }
    });
  }
}

/* ---------- payload renderers ---------- */

function renderProblem(problem) {
  const runtime = problem.environment?.runtime ?? {};
  const framework = problem.environment?.framework ?? {};
  const agent = problem.environment?.agent_context ?? {};

  const parts = [];
  if (problem.summary) parts.push(`<p>${esc(problem.summary)}</p>`);
  if (problem.impact) {
    parts.push(`<h2>Impact</h2><p>${esc(problem.impact)}</p>`);
  }

  if (problem.symptoms?.length) {
    parts.push(`<h2>Symptoms</h2>`);
    for (const s of problem.symptoms) {
      parts.push(`
        <div class="step">
          <span class="step-num">!</span>
          <div class="step-body">
            <div class="step-title">${esc(s.type)}</div>
            <p>${esc(s.description)}</p>
            <p style="font-size:13px">Observable: ${
        esc(s.observable)
      } · Frequency: ${esc(s.frequency)}</p>
          </div>
        </div>`);
    }
  }

  if (problem.root_cause) {
    parts.push(`
      <h2>Root cause</h2>
      <dl class="rows">
        <dt>Mechanism</dt><dd>${esc(problem.root_cause.mechanism ?? "—")}</dd>
        <dt>Causal chain</dt><dd>${
      esc((problem.root_cause.causal_chain ?? []).join(" → ") || "—")
    }</dd>
      </dl>`);
  }

  if (problem.reproduction?.length) {
    parts.push(`<h2>Reproduction</h2>${renderSteps(problem.reproduction)}`);
  }
  if (problem.diagnosis?.length) {
    parts.push(`<h2>Diagnosis</h2>${renderSteps(problem.diagnosis)}`);
  }

  parts.push(`
    <h2>Environment</h2>
    <dl class="rows">
      <dt>Runtime</dt><dd>${esc(runtime.type ?? "—")} ${
    esc((runtime.versions ?? []).join(", "))
  }</dd>
      <dt>Framework</dt><dd>${esc(framework.name ?? "—")} ${
    esc(framework.version ?? "")
  }</dd>
      ${agent.model ? `<dt>Agent model</dt><dd>${esc(agent.model)}</dd>` : ""}
      ${
    agent.model
      ? `<dt>Agent context</dt><dd>${esc(agent.context_window_used)} / ${
        esc(agent.context_window_size)
      } tokens · ${esc(agent.tool_count)} tools</dd>`
      : ""
  }
      <dt>Severity</dt><dd>${esc(problem.severity ?? "—")}</dd>
    </dl>`);

  parts.push(renderReferences(problem.references));

  if (problem.tags?.length) {
    parts.push(
      `<h2>Tags</h2><div class="row-tags">${
        problem.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")
      }</div>`,
    );
  }

  return parts.join("");
}

function renderRecipe(recipe) {
  const code = recipe.code ?? {};
  const parts = [];

  if (recipe.explanation) {
    parts.push(`<p>${esc(recipe.explanation)}</p>`);
  }

  if (recipe.prerequisites?.length) {
    parts.push(
      `<h2>Prerequisites</h2><ul>${
        recipe.prerequisites.map((p) =>
          `<li>${esc(p.description)}${
            p.node ? ` — ${nodeLink(p.node["/"])}` : ""
          }</li>`
        ).join("")
      }</ul>`,
    );
  }

  if (recipe.steps?.length) {
    parts.push(`<h2>Steps</h2>${renderSteps(recipe.steps)}`);
  }

  if (code.body) {
    parts.push(`
      <h2>Code</h2>
      ${renderCode(code, "recipe-main")}`);
  }

  if (recipe.verification) {
    parts.push(`<h2>Verification</h2><p>${esc(recipe.verification)}</p>`);
  }

  parts.push(renderCalloutList(recipe.caveats, "warning", "Caveats"));
  parts.push(renderReferences(recipe.references));

  if (recipe.tags?.length) {
    parts.push(
      `<h2>Tags</h2><div class="row-tags">${
        recipe.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")
      }</div>`,
    );
  }

  return parts.join("");
}

function epistemicPill(status) {
  const cls = status === "verified"
    ? "verified"
    : status === "heuristic"
    ? "heuristic"
    : "neutral";
  return `<span class="pill ${cls}"><span class="dot"></span>${
    esc(status ?? "unverified")
  }</span>`;
}

function renderGuide(guide) {
  const sections = guide.sections ?? [];
  const parts = [];

  if (guide.summary) parts.push(`<p>${esc(guide.summary)}</p>`);

  parts.push(`<p>${epistemicPill(guide.epistemic_status)}</p>`);

  if (sections.length >= 3) {
    parts.push(`
      <div class="toc">
        <h4>In this guide</h4>
        <ol>
          ${
      sections.map((s, i) =>
        `<li><a href="#guide-sec-${i + 1}">${esc(s.heading)}</a></li>`
      ).join("")
    }
        </ol>
      </div>`);
  }

  if (guide.prerequisites?.length) {
    parts.push(`<h2>Prerequisites</h2><ul>${
      guide.prerequisites.map((p) => `
        <li>${nodeLink(p.node["/"])}${
        p.required_depth
          ? ` <span class="tag">requires ${esc(p.required_depth)}</span>`
          : ""
      }</li>`).join("")
    }</ul>`);
  }

  if (sections.length) {
    for (const [i, s] of sections.entries()) {
      const statusCls = s.verification?.result === "confirmed"
        ? "verified"
        : "heuristic";
      const type = s.verification?.type === "demonstration"
        ? "Demonstrated"
        : "Attested";
      const body = s.body ?? {};
      parts.push(`
        <h2 id="guide-sec-${i + 1}">${esc(s.heading)}${
        s.depth ? ` <span class="tag">${esc(s.depth)}</span>` : ""
      }</h2>
        <p>${esc(s.claim)}</p>
        <p><span class="pill ${statusCls}"><span class="dot"></span>${
        esc(type)
      } · ${esc(s.verification?.result ?? "unverified")}</span></p>`);
      if (body.explanation) {
        parts.push(
          body.explanation.split(/\n\n+/).map((p) => `<p>${esc(p)}</p>`).join(
            "",
          ),
        );
      }
      if (body.steps?.length) parts.push(renderSteps(body.steps));
      if (body.code) {
        parts.push(
          `<h3>Implementation</h3>${
            renderCode(body.code, `guide-sec-${i + 1}`)
          }`,
        );
      }
      if (body.example) {
        parts.push(
          `<div class="callout example"><strong>Example</strong><p>${
            esc(body.example)
          }</p></div>`,
        );
      }
    }
  }

  parts.push(renderCalloutList(guide.caveats, "warning", "Caveats"));
  parts.push(renderReferences(guide.references));

  if (guide.tags?.length) {
    parts.push(
      `<h2>Tags</h2><div class="row-tags">${
        guide.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")
      }</div>`,
    );
  }

  return parts.join("");
}

function renderVerification(verification) {
  const target = verification.target ?? {};
  const execution = verification.execution ?? {};
  const suite = execution.test_suite ?? {};
  const cases = suite.cases ?? [];
  const measurements = suite.measurements ?? [];
  const context = verification.agent_context;

  const contextRows = context
    ? `
    <dt>Verified by</dt><dd>${esc(context.model)}</dd>
    <dt>Context use</dt><dd class="mono">${esc(context.context_window_used)}/${
      esc(context.context_window_size)
    }</dd>
    <dt>Tools / reasoning</dt><dd class="mono">${
      esc(context.tool_count)
    } tools · chain ${esc(context.reasoning_chain_length)}</dd>`
    : "";

  const measurementSection = measurements.length > 0
    ? `
    <h2>Measurements</h2>
    <div class="receipt-extra">${
      measurements.map((m) => `
      <span class="measure-chip" title="${esc(m.description ?? m.name)}">
        <b>${esc(m.name)}</b> ${m.value}${m.unit ? ` ${esc(m.unit)}` : ""}
      </span>`).join("")
    }</div>`
    : "";

  return `
    <dl class="rows">
      <dt>Problem</dt><dd>${cidLinkOrText(target.problem_id?.["/"])}</dd>
      <dt>Solution</dt><dd>${cidLinkOrText(target.solution_id?.["/"])}</dd>
      <dt>Playground</dt><dd>${esc(execution.playground ?? "—")}</dd>
      <dt>Environment hash</dt><dd class="mono">${
    esc(execution.environment_hash ?? "—")
  }</dd>
      <dt>Result</dt><dd><span class="pill ${
    (suite.failed ?? 0) > 0 ? "disputed" : "active"
  }"><span class="dot"></span>${esc(suite.passed)} passed · ${
    esc(suite.failed)
  } failed</span></dd>
      ${
    verification.replayed_by
      ? `<dt>Replay</dt><dd><span class="trust-badge">${
        esc(
          trustLabel(verification.replayed_by),
        )
      }</span></dd>`
      : ""
  }
      <dt>Timestamp</dt><dd>${esc(fmtDateTime(verification.timestamp))}</dd>
      <dt>Valid until</dt><dd>${
    esc(fmtDateTime(verification.valid_until))
  }</dd>${contextRows}
    </dl>
    ${measurementSection}
    <h2>Test suite</h2>
    <table class="cases">
      <thead><tr><th>Case</th><th>Result</th><th>Expected</th><th>Actual</th><th>Input</th></tr></thead>
      <tbody>
        ${
    cases.map((c) => `
          <tr>
            <td>${esc(c.name)}</td>
            <td class="${c.result === "pass" ? "pass" : "fail"}">${
      esc(c.result)
    }</td>
            <td class="mono">${esc(String(c.expected ?? ""))}</td>
            <td class="mono">${esc(String(c.actual ?? ""))}</td>
            <td>${c.input_cid ? cidLinkOrText(c.input_cid["/"]) : "—"}</td>
          </tr>`).join("")
  }
      </tbody>
    </table>`;
}

function renderComparison(comparison) {
  const dimensions = comparison.dimensions ?? [];
  const recommendations = comparison.recommendations ?? [];
  return `
    <dl class="rows">
      <dt>Decision context</dt><dd>${
    esc(comparison.decision_context ?? "—")
  }</dd>
    </dl>
    ${
    dimensions.map((d) => `
      <h2>${esc(d.name)}</h2>
      <table class="cases">
        <thead><tr><th>Option</th><th>Value</th><th>Benchmark</th></tr></thead>
        <tbody>
          ${
      (d.options ?? []).map((o) => `
            <tr>
              <td>${esc(o.name)}</td>
              <td class="mono">${esc(String(o.value))}</td>
              <td>${
        o.benchmark_receipt?.["/"]
          ? receiptCidText(o.benchmark_receipt["/"])
          : "—"
      }</td>
            </tr>`).join("")
    }
        </tbody>
      </table>`).join("")
  }
    <h2>Recommendations</h2>
    ${
    recommendations.map((r) => `
      <div class="recommendation">
        <strong>${esc(r.choice)}</strong> — ${esc(r.condition)}
        <div class="recommendation-reason">${esc(r.reason)}</div>
      </div>`).join("")
  }
  `;
}

function renderReference(reference) {
  const entries = reference.entries ?? [];
  const source = reference.source ?? {};
  const consistency = reference.consistency ?? {};
  return `
    <dl class="rows">
      <dt>Topic</dt><dd>${esc(reference.topic ?? "—")}</dd>
      <dt>Source</dt><dd>${
    source.url
      ? `<a href="${esc(source.url)}" target="_blank" rel="noreferrer">${
        esc(source.type ?? "docs")
      } ${icon("external")}</a>`
      : esc(source.type ?? "—")
  }</dd>
      <dt>Source type</dt><dd>${esc(source.type ?? "—")}</dd>
      ${
    source.synced_at
      ? `<dt>Last synced</dt><dd>${esc(fmtDateTime(source.synced_at))}</dd>`
      : ""
  }
      ${
    source.snapshot_cid
      ? `<dt>Snapshot</dt><dd>${receiptCidText(source.snapshot_cid["/"])}</dd>`
      : ""
  }
      <dt>Consistency</dt><dd>${esc(consistency.result ?? "—")}</dd>
      <dt>Method</dt><dd>${esc(consistency.method ?? "—")}</dd>
      ${
    consistency.last_checked
      ? `<dt>Last checked</dt><dd>${
        esc(fmtDateTime(consistency.last_checked))
      }</dd>`
      : ""
  }
    </dl>
    <h2>Entries</h2>
    ${
    entries.map((e) => `
      <div class="recipe-step">
        <div class="step-title">${
      esc(e.name)
    } <span class="mono" style="color:var(--text-muted);font-size:0.8em">${
      esc(e.kind ?? "")
    }</span></div>
        ${e.signature ? `<pre class="codeblock">${esc(e.signature)}</pre>` : ""}
        <p>${esc(e.description ?? "")}</p>
        <div style="font-size:0.85em;color:var(--text-muted)">
          version ${esc(e.version ?? "—")} · ${esc(e.source_pointer ?? "")}
        </div>
      </div>`).join("")
  }`;
}

function renderImprovement(improvement, includedById) {
  const current = improvement.current_state ?? {};
  const target = improvement.target_state ?? {};
  const impl = improvement.implementation ?? {};
  const validation = improvement.validation ?? {};
  return `
    <dl class="rows">
      <dt>Rationale</dt><dd>${esc(improvement.rationale ?? "—")}</dd>
      <dt>Approach</dt><dd>${esc(impl.approach ?? "—")}</dd>
    </dl>
    <h2>Current state</h2>
    <p>${esc(current.description ?? "—")}</p>
    ${
    current.metrics && Object.keys(current.metrics).length
      ? `<table class="cases"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>${
        Object.entries(current.metrics).map(([k, v]) =>
          `<tr><td>${esc(k)}</td><td class="mono">${esc(String(v))}</td></tr>`
        ).join("")
      }</tbody></table>`
      : ""
  }
    <h2>Target state</h2>
    <p>${esc(target.description ?? "—")}</p>
    ${
    target.expected_metrics && Object.keys(target.expected_metrics).length
      ? `<table class="cases"><thead><tr><th>Metric</th><th>Expected</th></tr></thead><tbody>${
        Object.entries(target.expected_metrics).map(([k, v]) =>
          `<tr><td>${esc(k)}</td><td class="mono">${esc(String(v))}</td></tr>`
        ).join("")
      }</tbody></table>`
      : ""
  }
    ${
    (impl.phases ?? []).length
      ? `<h2>Phases</h2>${
        impl.phases.map((p) => `
          <div class="recipe-step">
            <span class="step-num">${esc(String(p.phase ?? ""))}</span>
            <div class="step-body">
              <div class="step-title">${
          esc(p.title ?? "")
        } <span style="color:var(--text-muted);font-size:0.85em">· effort ${
          esc(p.effort ?? "—")
        }</span></div>
              ${
          (p.recipe_links ?? []).length
            ? `<ul style="margin-top:4px">${
              p.recipe_links.map((rl) =>
                `<li class="rel-applies">${esc(rl.relation ?? "")} ${
                  nodeLink(
                    rl.node["/"],
                    titleForIncluded(includedById, rl.node["/"]),
                  )
                }</li>`
              ).join("")
            }</ul>`
            : ""
        }
            </div>
          </div>`).join("")
      }`
      : ""
  }
    ${
    (improvement.trade_offs ?? []).length
      ? `<h2>Trade-offs</h2>${
        improvement.trade_offs.map((t) => `
          <div class="callout warning">
            ${icon("warning")}
            <p><strong>${esc(t.aspect)}</strong> — ${esc(t.downside)}</p>
            <p style="margin-top:4px;font-size:0.9em;color:var(--text-muted)">Mitigation: ${
          esc(t.mitigation)
        }</p>
          </div>`).join("")
      }`
      : ""
  }
    ${
    (validation.benchmark_receipts ?? []).length
      ? `<h2>Benchmarks</h2><ul>${
        validation.benchmark_receipts.map((r) =>
          `<li class="rel-receipt">${receiptCidText(r["/"])}</li>`
        ).join("")
      }</ul>`
      : ""
  }
    ${
    validation.success_criteria
      ? `<dl class="rows"><dt>Success criteria</dt><dd>${
        esc(validation.success_criteria)
      }</dd>${
        validation.verification_plan
          ? `<dt>Verification plan</dt><dd>${
            esc(validation.verification_plan)
          }</dd>`
          : ""
      }</dl>`
      : ""
  }`;
}

function renderBlueprint(blueprint, includedById) {
  const landscape = blueprint.current_landscape ?? {};
  const arch = blueprint.proposed_architecture ?? {};
  const feasibility = blueprint.feasibility ?? {};
  const trajectory = blueprint.adoption_trajectory ?? {};
  return `
    <dl class="rows">
      <dt>Rationale</dt><dd>${
    (blueprint.rationale ?? []).map((r) => esc(r)).join("; ") || "—"
  }</dd>
      <dt>Epistemic status</dt><dd>${
    esc(blueprint.epistemic_status ?? "—")
  }</dd>
      <dt>Confidence</dt><dd>${esc(blueprint.confidence ?? "—")}</dd>
    </dl>
    <h2>Current landscape</h2>
    <p style="font-style:italic;color:var(--text-muted)">${
    esc(landscape.systemic_friction ?? "")
  }</p>
    ${
    (landscape.fragments ?? []).length
      ? `<table class="cases"><thead><tr><th>Technology</th><th>Purpose</th><th>Limitations</th></tr></thead><tbody>${
        landscape.fragments.map((f) => `
          <tr>
            <td>${esc(f.technology ?? "")}</td>
            <td>${esc(f.purpose ?? "")}</td>
            <td>${(f.limitations ?? []).map((l) => esc(l)).join("; ")}</td>
          </tr>`).join("")
      }</tbody></table>`
      : ""
  }
    <h2>Proposed architecture</h2>
    <p style="font-weight:600">${esc(arch.core_principle ?? "")}</p>
    ${
    (arch.layers ?? []).length
      ? `<table class="cases"><thead><tr><th>#</th><th>Name</th><th>Technology</th><th>Responsibility</th></tr></thead><tbody>${
        arch.layers.map((l) => `
          <tr>
            <td class="mono">${esc(String(l.layer ?? ""))}</td>
            <td>${esc(l.name ?? "")}</td>
            <td>${esc(l.technology ?? "")}</td>
            <td>${esc(l.responsibility ?? "")}</td>
          </tr>`).join("")
      }</tbody></table>`
      : ""
  }
    <h2>Feasibility</h2>
    ${
    (feasibility.blockers ?? []).length
      ? feasibility.blockers.map((b) => `
        <div class="callout warning">
          ${icon("warning")}
          <p><strong>${esc(b.issue)}</strong> <span class="pill ${
        esc(b.severity)
      }">${esc(b.severity)}</span> <span style="color:var(--text-muted)">${
        esc(b.type)
      }</span></p>
        </div>`).join("")
      : "<p>No known blockers.</p>"
  }
    ${
    (feasibility.enablers ?? []).length
      ? `<ul>${
        feasibility.enablers.map((e) => `<li>${esc(e)}</li>`).join("")
      }</ul>`
      : ""
  }
    <h2>Adoption trajectory</h2>
    <dl class="rows">
      <dt>Phase 1</dt><dd>${esc(trajectory.phase_1 ?? "—")}</dd>
      <dt>Phase 2</dt><dd>${esc(trajectory.phase_2 ?? "—")}</dd>
      <dt>Phase 3</dt><dd>${esc(trajectory.phase_3 ?? "—")}</dd>
    </dl>
    ${
    (blueprint.related_nodes ?? []).length
      ? `<h2>Related nodes</h2><ul>${
        blueprint.related_nodes.map((rn) =>
          `<li class="rel-applies">${esc(rn.relation ?? "")} ${
            nodeLink(rn.node["/"], titleForIncluded(includedById, rn.node["/"]))
          }</li>`
        ).join("")
      }</ul>`
      : ""
  }`;
}

/* ---------- routing ---------- */

function render() {
  const hash = location.hash || "#/";
  if (hash.startsWith("#/nodes/")) {
    renderDetail(hash.slice("#/nodes/".length));
  } else {
    renderBrowse();
  }
}

/* ---------- search ---------- */

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

addEventListener("keydown", (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (e.key === "/") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

addEventListener("keyup", (e) => {
  if (e.key === "Escape" && document.activeElement === searchInput) {
    searchInput.blur();
  }
});

addEventListener("hashchange", render);

document.addEventListener("click", (e) => {
  const a = e.target.closest?.('a[href^="#guide-sec-"]');
  if (!a) return;
  e.preventDefault();
  const el = document.getElementById(a.getAttribute("href").slice(1));
  el?.scrollIntoView({ behavior: "smooth", block: "start" });
});

render();
