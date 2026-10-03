const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const worldName = run => ({ "ice-maze": "Ice Maze", slotski: "Slotski" }[run.world] || "Main World");
const count = value => (value || 0).toLocaleString();
const text = (element, value) => { if (element.textContent !== String(value)) element.textContent = value; };

export function providerName(provider) {
  return ({ codex: "Codex", "claude-code": "Claude Code", "grok-build": "Grok Build", antigravity: "Google Antigravity" })[provider] || provider;
}

export function runCompany(run) {
  const model = String(run.model || "").toLowerCase();
  if (model.startsWith("claude")) return "Anthropic (Claude)";
  if (model.startsWith("gemini")) return "Google";
  if (model.startsWith("grok")) return "xAI";
  if (/^(gpt-|o\d)/.test(model)) return "OpenAI";
  return ({ codex: "OpenAI", "claude-code": "Anthropic (Claude)", "grok-build": "xAI", antigravity: "Google" })[run.provider || "codex"] || run.provider;
}

export function selectRuns(runs, { company = "", model = "", sort = "newest" } = {}) {
  return runs.filter(run => (!company || runCompany(run) === company) && (!model || run.model === model)).sort((a, b) => {
    const companyOrder = sort === "company" ? runCompany(a).localeCompare(runCompany(b)) : 0;
    const modelOrder = ["company", "model"].includes(sort) ? String(a.model || "").localeCompare(String(b.model || ""), undefined, { numeric: true }) : 0;
    return companyOrder || modelOrder || String(b.created_at || "").localeCompare(String(a.created_at || "")) || String(a.id).localeCompare(String(b.id));
  });
}

function duration(run) {
  if (!run.created_at) return "";
  const end = run.completed_at || run.stopped_at || (!run.runner_active && (run.paused_at || run.updated_at)) || Date.now();
  const seconds = Math.max(0, Math.floor((new Date(end) - new Date(run.created_at)) / 1000));
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function runCardValues(run) {
  const numbered = ["ice-maze", "slotski"].includes(run.world);
  return {
    href: `./run.html?id=${encodeURIComponent(run.id)}`,
    condition: `${run.observation_mode === "vision" ? "Vision · " : ""}${run.tools_enabled ? "Python on" : "Python off"}`,
    status: String(run.status || "unknown").replaceAll("-", " "),
    context: `${worldName(run)} · ${run.effort} reasoning`,
    timestamp: `${run.created_at ? dates.format(new Date(run.created_at)) : "—"} · ${duration(run)}`,
    meta: `${worldName(run)} · ${providerName(run.provider || "codex")} · ${run.effort} reasoning${run.world === "slotski" ? ` · ${run.sequence_enabled === false ? "Single moves" : "Batched moves"} · ${run.service_tier === "fast" ? "Fast" : "Standard speed"}` : ""} · ${run.created_at ? dates.format(new Date(run.created_at)) : "—"} · ${duration(run)}`,
    progress: run.action_limit ? Math.min(100, (run.action_count || 0) / run.action_limit * 100) : run.status === "completed" ? 100 : 0,
    metrics: [
      ["Actions", `${count(run.action_count)}${run.action_limit ? `/${count(run.action_limit)}` : ""}`],
      [numbered ? "Levels solved" : "Gems", numbered ? `${run.levels_solved || 0}/${run.levels_total || (run.world === "slotski" ? 1 : 30)}` : count(run.gems_collected)],
      [numbered ? "Level" : "Rooms", numbered ? count(run.level_number) : count(run.rooms_visited || 1)],
      ["Cells", count(run.unique_cells || 1)]
    ]
  };
}

export function runPage(runs, requestedPage = 0, size = 24) {
  const totalPages = Math.max(1, Math.ceil(runs.length / size));
  const page = Math.max(0, Math.min(totalPages - 1, Math.floor(requestedPage) || 0));
  return { page, totalPages, total: runs.length, runs: runs.slice(page * size, (page + 1) * size) };
}

function createCard() {
  const card = document.createElement("article");
  card.innerHTML = `<a class="record-card-link"><div class="record-top"><strong class="record-model"></strong><span class="record-status"></span></div><div class="record-context"><span class="condition"></span><span class="record-meta"></span></div><span class="run-progress"><i></i></span><div class="record-metrics">${"<span><small></small><b></b></span>".repeat(4)}</div></a><div class="record-footer"><span class="record-date"></span><button type="button" class="record-delete danger" aria-label="Delete run"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg></button></div>`;
  return card;
}

function updateCard(card, run, values) {
  card.className = `record-card${run.tools_enabled ? " tools" : ""}`;
  card.querySelectorAll("a").forEach(link => { if (link.getAttribute("href") !== values.href) link.setAttribute("href", values.href); });
  text(card.querySelector(".condition"), values.condition);
  const status = card.querySelector(".record-status");
  status.className = `record-status ${run.status}`;
  text(status, values.status);
  text(card.querySelector(".record-model"), run.model);
  text(card.querySelector(".record-meta"), values.context);
  card.querySelector(".record-context").title = values.meta;
  text(card.querySelector(".record-date"), values.timestamp);
  const progress = card.querySelector(".run-progress");
  progress.hidden = !run.action_limit;
  progress.querySelector("i").style.width = `${values.progress}%`;
  card.querySelectorAll(".record-metrics > span").forEach((metric, index) => {
    text(metric.querySelector("small"), values.metrics[index][0]);
    text(metric.querySelector("b"), values.metrics[index][1]);
  });
  const remove = card.querySelector(".record-delete");
  remove.dataset.deleteRun = run.id;
  remove.setAttribute("aria-label", `Delete ${run.model} run`);
  remove.disabled = Boolean(run.runner_active);
  remove.title = run.runner_active ? "Stop or pause this run before deleting it." : "Permanently delete this run.";
}

export class RunListView {
  constructor(container) {
    this.container = container;
    this.cards = new Map();
    this.page = 0;
  }

  update(runs, requestedPage = this.page) {
    const result = runPage(runs, requestedPage);
    this.page = result.page;
    const wanted = new Set(result.runs.map(run => run.id));
    for (const [id, entry] of this.cards) if (!wanted.has(id)) {
      entry.card.remove();
      this.cards.delete(id);
    }
    if (!runs.length) {
      if (!this.container.querySelector(".records-empty")) {
        const empty = document.createElement("div");
        empty.className = "records-empty";
        empty.innerHTML = "<strong>No runs yet</strong><p>Choose your settings above to start your first evaluation.</p>";
        this.container.replaceChildren(empty);
      }
      return result;
    }
    this.container.querySelectorAll(".records-empty, .empty-copy").forEach(node => node.remove());
    result.runs.forEach((run, index) => {
      let entry = this.cards.get(run.id);
      if (!entry) { entry = { card: createCard() }; this.cards.set(run.id, entry); }
      const values = runCardValues(run);
      const signature = JSON.stringify([run, values]);
      if (entry.signature !== signature) {
        updateCard(entry.card, run, values);
        entry.signature = signature;
      }
      // Keep existing nodes attached, preserving keyboard focus and scroll.
      if (this.container.children[index] !== entry.card) {
        this.container.insertBefore(entry.card, this.container.children[index] || null);
      }
    });
    return result;
  }
}
