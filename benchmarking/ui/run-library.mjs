import { codingLabel, codingMode } from "../coding-mode.mjs";
import { formatRateLimit } from "../run-errors.mjs";
import { modelLabel } from "./model-label.mjs";
const dates = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const worldName = run => ({ "ice-maze": "Ice Maze", slotski: "Slotski" }[run.world] || "Main World");
const count = value => (value || 0).toLocaleString();
const text = (element, value) => { if (element.textContent !== String(value)) element.textContent = value; };
const companyLogos = new Map([
  ["OpenAI", "openai"], ["Anthropic (Claude)", "claude-color"], ["Google", "gemini-color"],
  ["Meta", "meta-color"], ["xAI", "grok"], ["DeepSeek", "deepseek-color"],
  ["Alibaba", "alibaba-color"], ["Mistral", "mistral-color"]
]);

export function providerName(provider) {
  return ({ codex: "Codex", "claude-code": "Claude Code", "grok-build": "Grok Build", antigravity: "Google Antigravity", "muse-code": "Meta Muse Code", "prime-agent": "Prime Agent" })[provider] || provider;
}

export function runCompany(run) {
  const model = String(run.model || "").toLowerCase();
  if (run.provider === "prime-agent" && model.includes("/")) {
    const vendor = model.split("/")[0];
    return ({openai: "OpenAI", anthropic: "Anthropic (Claude)", google: "Google", meta: "Meta", "meta-llama": "Meta", xai: "xAI", deepseek: "DeepSeek", alibaba: "Alibaba", mistral: "Mistral"})[vendor] || vendor;
  }
  if (model.startsWith("claude")) return "Anthropic (Claude)";
  if (model.startsWith("gemini")) return "Google";
  if (model.startsWith("muse-")) return "Meta";
  if (model.startsWith("grok")) return "xAI";
  if (/^(gpt-|o\d)/.test(model)) return "OpenAI";
  return ({ codex: "OpenAI", "claude-code": "Anthropic (Claude)", "grok-build": "xAI", antigravity: "Google", "muse-code": "Meta" })[run.provider || "codex"] || run.provider;
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
  const company = runCompany(run) || "Unknown provider";
  const logo = companyLogos.get(company);
  const rateLimited = Boolean(run.rate_limit && run.status === "failed");
  return {
    href: `./run.html?id=${encodeURIComponent(run.id)}`,
    company,
    logo: logo ? new URL(`./assets/model-logos/${logo}.svg`, import.meta.url).href : null,
    monochromeLogo: ["openai", "grok"].includes(logo),
    effort: run.effort || "default",
    tools: codingMode(run) === "any" ? "(any language)" : run.provider === "prime-agent" || run.tools_enabled ? "(tools on)" : "(tools off)",
    statusTone: rateLimited || ["queued", "preparing", "pausing"].includes(run.status) ? "yellow"
      : ["running", "continuing"].includes(run.status) ? "green"
      : ["failed", "interrupted"].includes(run.status) ? "red" : "gray",
    condition: `${run.observation_mode === "vision" ? "Vision · " : ""}${codingLabel(run)}`,
    status: run.rate_limit && run.status === "failed" ? "Rate limited" : String(run.status || "unknown").replaceAll("-", " "),
    rateLimit: run.status === "failed" ? formatRateLimit(run.rate_limit) : null,
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
  card.innerHTML = `<a class="record-card-link"><div class="record-top"><span class="record-logo" role="img"><img alt="" width="20" height="20" hidden><span class="record-logo-fallback" aria-hidden="true">?</span></span><strong class="record-model"></strong><span class="record-effort"></span><span class="condition"></span><span class="record-status" role="img"></span></div><div class="record-metrics">${"<span><small></small><b></b></span>".repeat(4)}</div></a><div class="record-footer"><span class="record-date"></span><button type="button" class="record-delete danger" aria-label="Delete run"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg></button></div>`;
  return card;
}

function updateCard(card, run, values) {
  card.className = `record-card${run.tools_enabled ? " tools" : ""}`;
  card.querySelectorAll("a").forEach(link => { if (link.getAttribute("href") !== values.href) link.setAttribute("href", values.href); });
  const logo = card.querySelector(".record-logo");
  logo.setAttribute("aria-label", values.company);
  logo.title = values.company;
  logo.classList.toggle("monochrome", values.monochromeLogo);
  const logoImage = logo.querySelector("img");
  if (values.logo && logoImage.getAttribute("src") !== values.logo) logoImage.src = values.logo;
  if (!values.logo) logoImage.removeAttribute("src");
  logoImage.hidden = !values.logo;
  logo.querySelector(".record-logo-fallback").hidden = Boolean(values.logo);
  text(card.querySelector(".condition"), values.tools);
  const effort = card.querySelector(".record-effort");
  text(effort, values.effort);
  effort.title = `Reasoning effort: ${values.effort}`;
  effort.setAttribute("aria-label", effort.title);
  const status = card.querySelector(".record-status");
  status.dataset.tone = values.statusTone;
  status.title = values.rateLimit ? `${values.status}: ${values.rateLimit}` : values.status;
  status.setAttribute("aria-label", status.title);
  const model = card.querySelector(".record-model");
  text(model, run.model || "Unknown model");
  model.title = `${run.model || "Unknown model"} · ${values.condition} · ${values.meta}`;
  text(card.querySelector(".record-date"), values.timestamp);
  card.querySelectorAll(".record-metrics > span").forEach((metric, index) => {
    text(metric.querySelector("small"), values.metrics[index][0]);
    text(metric.querySelector("b"), values.metrics[index][1]);
  });
  const remove = card.querySelector(".record-delete");
  remove.dataset.deleteRun = run.id;
  remove.setAttribute("aria-label", `Delete ${modelLabel(run.model)} run`);
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
