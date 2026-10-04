import { heatmapVisits } from "./heatmap.mjs";
import { runTabVisible } from "./run-tabs.mjs";
import { benchmarkFetch, visionUrl } from "./benchmark-api.mjs";
const numberedWorld = run => ["ice-maze", "slotski"].includes(run.world);
const worldName = run => ({ "ice-maze": "Ice Maze", slotski: "Slotski" }[run.world] || "Main World");
const providerName = provider => ({ codex: "Codex", "claude-code": "Claude Code", "grok-build": "Grok Build", antigravity: "Google Antigravity" })[provider || "codex"] || provider;
import { drawNovelty } from "../ui/novelty-chart.mjs";
import { renderIceLevelTimings } from "./ice-level-timings.mjs";

const ids = [
  "world-update-status", "connection-status", "load-error", "error-copy", "run-content", "model-hero", "run-failure", "run-failure-reason", "retry-new-run",
  "model-monogram", "run-kicker", "run-title", "run-subtitle", "run-id", "run-status",
  "pause-run", "resume-run", "stop-run", "delete-run", "pair-compare", "stat-actions", "stat-gems", "stat-rooms", "stat-cells",
  "stat-novelty", "stat-blocked", "stat-deaths", "stat-tokens", "board-room", "board-move",
  "board", "frame-first", "frame-previous", "frame-play", "frame-next", "frame-last",
  "frame-scrubber", "frame-position", "frame-source", "replay-speed", "heatmap", "heatmap-count", "novelty-value", "novelty-chart", "progress-value",
  "progress-chart", "feed-count", "feed", "workspace-title", "isolation-status",
  "workspace-files", "continuations", "final-message", "interview-state", "new-interview",
  "interview-count", "interview-list", "interview-active-title", "interview-snapshot",
  "end-interview", "interview-fork", "interview-messages", "interview-form", "interview-question",
  "interview-status", "interview-send"
];
const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const runId = new URLSearchParams(location.search).get("id");
let currentRun = null;
let currentFrame = 0;
let followingLatest = true;
let playbackTimeout = null;
let playbackActive = false;
let playbackGeneration = 0;
let frameRequest = 0;
const frameCache = new Map();
let currentInterview = null;
let currentInterviewLibrary = null;
let selectedInterviewId = null;
let creatingInterview = false;
let refreshPromise = null;
let pollTimer = null;
let analysisData = null, analysisKey = null, analysisBusy = false;
let activityData = null, activityAt = 0, activityBusy = false;
let interviewBusy = false, pairRuns = [], pairAt = 0;
let boardSignature = "", feedSignature = "", workspaceSignature = "", interviewSignature = "";
let tokenUsage = null;
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const standardNumbers = new Intl.NumberFormat(), compactNumbers = new Intl.NumberFormat(undefined, { notation: "compact" });

async function api(path, options = {}) {
  const response = await benchmarkFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}

function statusLabel(value) {
  return String(value || "unknown").replaceAll("-", " ");
}

function isFinished(run) {
  return ["completed", "failed", "stopped"].includes(run.status);
}

function compactDate(value) {
  if (!value) return "—";
  return dateFormatter.format(new Date(value));
}

function formatNumber(value) {
  return (value >= 100_000 ? compactNumbers : standardNumbers).format(Number(value) || 0);
}

function usageTotal(usage) {
  if (!usage) return 0;
  if (Number.isFinite(usage.total_tokens)) return usage.total_tokens;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  return (usage.input_tokens || usage.inputTokens || 0) + (usage.output_tokens || usage.outputTokens || 0);
}

function modelMonogram(model) {
  const meaningful = String(model || "M").split(/[-_.]/).filter(Boolean).filter((part) => !/^(gpt|codex|5|6)$/.test(part));
  return (meaningful.at(-1)?.[0] || "M").toUpperCase();
}

function setCanvasSize(canvas) {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(280, Math.floor(canvas.clientWidth || 600));
  const height = Math.max(160, Math.floor(canvas.clientHeight || 220));
  const targetWidth = Math.floor(width * ratio);
  const targetHeight = Math.floor(height * ratio);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function renderBoard(display) {
  const signature = JSON.stringify(display);
  if (boardSignature === signature) return;
  boardSignature = signature;
  const vision = display?.observation_mode === "vision";
  elements.board.classList.toggle("vision-board", vision);
  if (vision && display.image_record) {
    const source = visionUrl(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/record/${encodeURIComponent(display.image_record)}`);
    if (elements.board.querySelector("img")?.src === source) return;
    const img = document.createElement("img");
    img.src = source; img.className = "vision-board-image";
    img.alt = `3D agent observation · room ${display.room} · move ${display.observation_revision}`;
    elements.board.replaceChildren(img);
    elements.board.setAttribute("aria-label", img.alt);
    return;
  }
  elements.board.replaceChildren();
  const coloredRows = Array.isArray(display?.colored_level) ? display.colored_level : [];
  if (coloredRows.length) {
    for (const segments of coloredRows) {
      const row = document.createElement("div");
      row.className = "ascii-row";
      for (const segment of segments) {
        const span = document.createElement("span");
        span.textContent = String(segment.text || "");
        if (/^#[0-9a-f]{6}$/i.test(segment.color || "")) span.style.color = segment.color;
        row.append(span);
      }
      elements.board.append(row);
    }
  } else {
    const fallback = document.createElement("pre");
    fallback.textContent = display?.level || "Waiting for the first observation…";
    elements.board.append(fallback);
  }
  elements.board.setAttribute("aria-label", display?.level ? `Current ASCII maze board\n${display.level}` : "Current ASCII maze board");
  fitBoard();
}

function fitBoard() {
  if (!runTabVisible("overview") || elements.board.classList.contains("vision-board")) return;
  const rows = [...elements.board.querySelectorAll(".ascii-row")];
  if (!rows.length) return;
  const wrapper = elements.board.parentElement;
  const columns = Math.max(...rows.map(row => row.textContent.length));
  const size = Math.max(3, Math.min(12, (wrapper.clientWidth - 56) / Math.max(1, columns * .61), (wrapper.clientHeight - 48) / (rows.length * .86)));
  elements.board.style.fontSize = `${size}px`;
}

function syncTransport() {
  const maximum = currentRun?.action_count || 0;
  elements["frame-scrubber"].max = String(maximum);
  elements["frame-scrubber"].value = String(currentFrame);
  elements["frame-position"].textContent = `${currentFrame} / ${maximum}`;
  elements["frame-first"].disabled = currentFrame <= 0;
  elements["frame-previous"].disabled = currentFrame <= 0;
  elements["frame-next"].disabled = currentFrame >= maximum;
  elements["frame-last"].disabled = currentFrame >= maximum;
}

function stopPlayback() {
  playbackActive = false;
  playbackGeneration += 1;
  if (playbackTimeout) clearTimeout(playbackTimeout);
  playbackTimeout = null;
  elements["frame-play"].textContent = "▶ Play";
  elements["frame-play"].classList.remove("playing");
  elements["frame-play"].setAttribute("aria-pressed", "false");
}

function moveLabel(index) {
  if (index === 0) return "move 0 · initial state";
  const actions = currentRun?.actions || [];
  const indexed = actions[index - 1];
  const action = indexed?.index === index ? indexed : actions.find(entry => entry.index === index);
  return action?.action ? `move ${index} · ${action.action}` : `move ${index}`;
}

async function showFrame(index, { keepPlaying = false } = {}) {
  if (!currentRun) return;
  const maximum = currentRun.action_count || 0;
  const selected = Math.max(0, Math.min(maximum, Math.round(Number(index) || 0)));
  const request = ++frameRequest;
  currentFrame = selected;
  followingLatest = selected === maximum;
  syncTransport();

  if (selected === maximum && currentRun.display) {
    renderBoard(currentRun.display);
    elements["board-room"].textContent = `${numberedWorld(currentRun) ? "" : "Room "}${currentRun.display.room || currentRun.room || "—"}`;
    elements["board-move"].textContent = moveLabel(selected);
    elements["frame-source"].textContent = currentRun.observation_mode === "vision" ? "Live 3D agent observation" : "Latest observation";
  } else {
    elements["frame-source"].textContent = currentRun.observation_mode === "vision" ? `Loading image for move ${selected}…` : `Loading move ${selected}…`;
    let snapshot = frameCache.get(selected);
    if (!snapshot) snapshot = await api(
      `/api/benchmark/v1/runs/${encodeURIComponent(runId)}/display/${selected}`
    );
    if (request !== frameRequest) return;
    frameCache.set(selected, snapshot);
    if (frameCache.size > 80) frameCache.delete(frameCache.keys().next().value);
    renderBoard(snapshot);
    elements["board-room"].textContent = `${numberedWorld(currentRun) ? "" : "Room "}${snapshot.room}`;
    elements["board-move"].textContent = moveLabel(selected);
    elements["frame-source"].textContent = snapshot.observation_mode === "vision" ? "Recorded 3D observation" : "Recorded observation";
  }

  if (!keepPlaying) stopPlayback();
}

function waitForPlayback(delay, generation) {
  return new Promise((resolve) => {
    playbackTimeout = setTimeout(() => {
      playbackTimeout = null;
      resolve(playbackActive && playbackGeneration === generation);
    }, delay);
  });
}

async function startPlayback() {
  if (!currentRun) return;
  if (playbackActive) {
    stopPlayback();
    return;
  }
  playbackActive = true;
  const generation = ++playbackGeneration;
  elements["frame-play"].textContent = "❚❚ Pause";
  elements["frame-play"].classList.add("playing");
  elements["frame-play"].setAttribute("aria-pressed", "true");
  try {
    const maximum = currentRun.action_count || 0;
    if (currentFrame >= maximum) await showFrame(0, { keepPlaying: true });
    while (playbackActive && playbackGeneration === generation && currentFrame < maximum) {
      const shouldAdvance = await waitForPlayback(replayDelay(), generation);
      if (!shouldAdvance) return;
      await showFrame(currentFrame + 1, { keepPlaying: true });
    }
    if (playbackGeneration === generation) stopPlayback();
  } catch (error) {
    if (playbackGeneration === generation) {
      stopPlayback();
      elements["frame-source"].textContent = error.message;
    }
  }
}

function replayDelay() {
  const delay = Math.max(20, Math.min(5000, Math.round(Number(elements["replay-speed"].value) || 220)));
  elements["replay-speed"].value = String(delay);
  return delay;
}

function heatColor(fraction) {
  const stops = [
    [20, 26, 34],
    [255, 213, 87],
    [255, 126, 58],
    [222, 55, 92],
    [148, 72, 214]
  ];
  const scaled = Math.min(0.999, Math.max(0, fraction)) * (stops.length - 1);
  const index = Math.floor(scaled);
  const blend = scaled - index;
  const left = stops[index];
  const right = stops[Math.min(index + 1, stops.length - 1)];
  const channel = (position) => Math.round(left[position] + (right[position] - left[position]) * blend);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function drawHeatmap(positions, toolsEnabled, currentPosition) {
  const { context, width, height } = setCanvasSize(elements.heatmap);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#07090c";
  context.fillRect(0, 0, width, height);
  const valid = (positions || []).filter((position) => position && Number.isFinite(position.worldX) && Number.isFinite(position.worldY));
  const total = valid.reduce((sum, point) => sum + (point.count || 1), 0);
  elements["heatmap-count"].textContent = `${formatNumber(total)} visit${total === 1 ? "" : "s"}`;
  if (!valid.length) return;

  const counts = new Map();
  for (const position of valid) {
    const key = `${position.worldX},${position.worldY}`;
    counts.set(key, (counts.get(key) || 0) + (position.count || 1));
  }
  const points = [...counts].map(([key, count]) => {
    const [x, y] = key.split(",").map(Number);
    return { x, y, count };
  });
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const columns = Math.max(5, maxX - minX + 1);
  const rows = Math.max(5, maxY - minY + 1);
  const padding = 24;
  // Large explored regions must fit too, even when each tile is subpixel.
  const cell = Math.min((width - padding * 2) / columns, (height - padding * 2) / rows);
  const offsetX = (width - columns * cell) / 2;
  const offsetY = (height - rows * cell) / 2;
  const inset = Math.min(1, cell / 8);
  const tileSize = cell - inset * 2;
  const maximum = Math.max(...points.map((point) => point.count));

  context.strokeStyle = "#151a21";
  context.lineWidth = Math.min(1, cell / 8);
  for (let column = 0; column <= columns; column += 1) {
    const x = offsetX + column * cell;
    context.beginPath();
    context.moveTo(x, offsetY);
    context.lineTo(x, offsetY + rows * cell);
    context.stroke();
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = offsetY + row * cell;
    context.beginPath();
    context.moveTo(offsetX, y);
    context.lineTo(offsetX + columns * cell, y);
    context.stroke();
  }
  for (const point of points) {
    const intensity = Math.log2(point.count + 1) / Math.log2(maximum + 1);
    context.fillStyle = heatColor(intensity);
    context.fillRect(
      offsetX + (point.x - minX) * cell + inset,
      offsetY + (point.y - minY) * cell + inset,
      tileSize,
      tileSize
    );
  }
  const current = currentPosition || valid.at(-1);
  context.strokeStyle = toolsEnabled ? "#ffbd5b" : "#6cd7ff";
  context.lineWidth = 2;
  const markerSize = Math.max(4, tileSize);
  context.strokeRect(
    offsetX + (current.worldX - minX + 0.5) * cell - markerSize / 2,
    offsetY + (current.worldY - minY + 0.5) * cell - markerSize / 2,
    markerSize,
    markerSize
  );
}

function drawProgress(run) {
  const canvas = elements["progress-chart"];
  const { context, width, height } = setCanvasSize(canvas);
  context.clearRect(0, 0, width, height);
  const rows = [
    numberedWorld(run) ? { label: "Levels solved", value: run.levels_solved || 0, total: run.levels_total || (run.world === "slotski" ? 1 : 30) } : { label: "Gems collected", value: run.gems_collected || 0, total: run.gems_total || 100 },
    { label: "Actions", value: run.action_count || 0, total: run.action_limit || null }
  ];
  const left = 20, barWidth = width - 40;
  context.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  rows.forEach((row, index) => {
    const y = 35 + index * 88;
    context.fillStyle = "#98989f";
    context.textAlign = "left";
    context.fillText(row.label, left, y);
    context.fillStyle = "#f2f2f7";
    context.textAlign = "right";
    context.fillText(`${standardNumbers.format(row.value)}${row.total ? ` / ${standardNumbers.format(row.total)}` : " · No limit"}`, width - left, y);
    if (!row.total) return;
    const fraction = Math.max(0, Math.min(1, row.value / row.total));
    context.fillStyle = "#2c2c2e";
    context.beginPath(); context.roundRect(left, y + 17, barWidth, 6, 3); context.fill();
    if (fraction > 0) {
      context.fillStyle = "#0a84ff";
      context.beginPath(); context.roundRect(left, y + 17, barWidth * fraction, 6, 3); context.fill();
    }
  });
  canvas.setAttribute("aria-label", rows.map(row => `${row.label}: ${row.value}${row.total ? ` of ${row.total}` : ", no limit"}`).join(". "));
}

function feedText(entry) {
  if (entry.type === "tool") {
    const input = entry.arguments && Object.keys(entry.arguments).length ? ` ${JSON.stringify(entry.arguments)}` : "";
    return `${entry.tool || "tool"}${input}`;
  }
  return entry.text || "";
}

function renderFeed(run) {
  const signature = JSON.stringify(run.feed || []);
  if (signature === feedSignature) return;
  feedSignature = signature;
  elements.feed.replaceChildren();
  const entries = (run.feed || []).slice(-60);
  elements["feed-count"].textContent = `${entries.length} event${entries.length === 1 ? "" : "s"}`;
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "Waiting for model activity…";
    elements.feed.append(empty);
    return;
  }
  for (const entry of entries) {
    const item = document.createElement("article");
    item.className = `feed-entry${entry.type === "tool" ? " tool" : ""}`;
    const meta = document.createElement("div");
    const type = document.createElement("span");
    const time = document.createElement("time");
    type.textContent = entry.type === "agent_message" ? "model" : entry.type;
    time.textContent = entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    meta.append(type, time);
    const copy = document.createElement("p");
    copy.textContent = feedText(entry);
    item.append(meta, copy);
    elements.feed.append(item);
  }
}

function renderWorkspace(run) {
  const signature = JSON.stringify([run.workspace_files, run.tools_enabled, run.capability_boundary_verified, run.isolation]);
  if (signature === workspaceSignature) return;
  workspaceSignature = signature;
  elements["workspace-files"].replaceChildren();
  elements["workspace-title"].textContent = run.tools_enabled ? "Python workspace" : "Python unavailable";
  const isolation = run.isolation || {};
  elements["isolation-status"].textContent = !run.capability_boundary_verified
    ? "legacy · not validated"
    : run.tools_enabled
      ? isolation.verified ? "OS isolation · checked" : "isolation pending"
      : "maze tools · checked";
  const files = run.workspace_files || [];
  if (!run.tools_enabled || !files.length) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = run.tools_enabled ? "The model has not written any files." : "This condition has no writable workspace.";
    elements["workspace-files"].append(empty);
    return;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "file-row";
    const name = document.createElement("span");
    const size = document.createElement("span");
    name.textContent = file.path || file.name || "file";
    size.textContent = `${formatNumber(file.bytes ?? file.size ?? 0)} B`;
    row.append(name, size);
    elements["workspace-files"].append(row);
  }
}

function renderPair(run, allRuns) {
  elements["pair-compare"].replaceChildren();
  const peers = run.pair_id ? allRuns.filter((candidate) => candidate.pair_id === run.pair_id) : [];
  if (peers.length < 2) {
    elements["pair-compare"].hidden = true;
    return;
  }
  elements["pair-compare"].hidden = false;
  for (const peer of peers.sort((left, right) => Number(left.tools_enabled) - Number(right.tools_enabled))) {
    const link = document.createElement("a");
    link.className = `pair-card${peer.tools_enabled ? " tools" : ""}${peer.id === run.id ? " selected" : ""}`;
    link.href = `./run.html?id=${encodeURIComponent(peer.id)}`;
    const label = document.createElement("span");
    label.textContent = peer.tools_enabled ? "Python on" : "Python off";
    const result = document.createElement("strong");
    result.textContent = `${numberedWorld(peer) ? `${peer.levels_solved || 0} levels solved` : `${peer.gems_collected || 0} gems`} · ${peer.action_count || 0} actions`;
    link.append(label, result);
    elements["pair-compare"].append(link);
  }
}

function interviewMessage(message) {
  const article = document.createElement("article");
  article.className = `interview-message ${message.role === "assistant" ? "model" : "user"}`;
  const meta = document.createElement("div");
  const author = document.createElement("strong");
  const time = document.createElement("time");
  author.textContent = message.role === "assistant" ? currentRun?.model || "Model" : "You";
  time.textContent = message.at
    ? new Date(message.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";
  meta.append(author, time);
  const content = document.createElement("p");
  content.textContent = message.content || "";
  article.append(meta, content);
  return article;
}

function interviewStateLabel(status) {
  return ({
    ready: "Open",
    running: "Answering",
    queued: "Queued",
    forking: "Branching",
    failed: "Needs attention",
    ended: "Ended"
  })[status] || statusLabel(status);
}

function syncInterviewSendButton() {
  const status = currentInterview?.status;
  const blocked = ["running", "queued", "forking"].includes(status);
  const selectedOpen = Boolean(currentInterview?.available) && status !== "ended";
  const canBranch = Boolean(currentInterviewLibrary?.available) && (
    !currentInterview || status === "ended" || !currentInterview.fork_thread_id
  );
  const unanswered = status === "failed" && currentInterview?.messages?.at(-1)?.role === "user";
  const hasQuestion = Boolean(elements["interview-question"].value.trim());
  elements["interview-send"].disabled = creatingInterview || blocked || !hasQuestion || (!selectedOpen && !canBranch);
  elements["interview-send"].textContent = creatingInterview
    ? "Branching…"
    : status === "queued"
      ? "Queued"
      : unanswered
        ? "Retry question"
        : selectedOpen
          ? "Ask model"
          : canBranch
            ? "Branch & ask"
            : "Ask model";
}

function renderInterview(library, interview) {
  currentInterviewLibrary = library;
  currentInterview = interview;
  const signature = JSON.stringify([library, interview, creatingInterview, selectedInterviewId]);
  if (signature === interviewSignature) return;
  interviewSignature = signature;
  const messages = interview?.messages || [];
  const chats = library?.chats || [];
  elements["interview-count"].textContent = String(chats.length);
  elements["interview-list"].replaceChildren();
  if (!chats.length) {
    const empty = document.createElement("p");
    empty.className = "interview-list-empty";
    empty.textContent = library?.available
      ? "No branches yet. Create one at the benchmark’s current moment."
      : "The benchmark thread is still starting.";
    elements["interview-list"].append(empty);
  } else {
    for (const chat of chats) {
      const row = document.createElement("button");
      const top = document.createElement("span");
      const title = document.createElement("strong");
      const state = document.createElement("i");
      const snapshot = document.createElement("small");
      row.type = "button";
      row.dataset.chatId = chat.id;
      row.className = `interview-chat-row${chat.id === selectedInterviewId ? " selected" : ""}${chat.status === "ended" ? " ended" : ""}`;
      title.textContent = chat.title;
      state.textContent = interviewStateLabel(chat.status);
      snapshot.textContent = `move ${chat.branched_at_action} · ${chat.message_count} message${chat.message_count === 1 ? "" : "s"}`;
      top.append(title, state);
      row.append(top, snapshot);
      elements["interview-list"].append(row);
    }
  }

  elements["interview-messages"].replaceChildren();
  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "interview-empty";
    const title = document.createElement("strong");
    const copy = document.createElement("p");
    title.textContent = interview ? "Ask anything about this snapshot." : "No chat selected.";
    copy.textContent = interview
      ? "Type your own question below. This branch has no tools and cannot alter the benchmark."
      : "Create a new chat to branch from the latest benchmark moment.";
    empty.append(title, copy);
    elements["interview-messages"].append(empty);
  } else {
    for (const message of messages) elements["interview-messages"].append(interviewMessage(message));
  }
  const running = interview?.status === "running";
  const queued = interview?.status === "queued";
  const forking = interview?.status === "forking";
  const ended = interview?.status === "ended";
  const available = Boolean(interview?.available) && !ended;
  elements["interview-state"].textContent = forking
    ? "Branching now"
    : running
    ? "Model answering"
    : queued
      ? "Waiting for Codex"
    : ended
      ? "Chat ended"
      : interview?.fork_thread_id
        ? "Fork active"
        : library?.available ? "Ready to branch" : "Waiting for thread";
  elements["interview-state"].className = `fork-badge${running || forking ? " running" : ""}${queued ? " queued" : ""}${interview?.fork_thread_id && !ended ? " active" : ""}`;
  elements["new-interview"].disabled = creatingInterview || !library?.available;
  elements["new-interview"].textContent = creatingInterview ? "Branching…" : "＋ New chat";
  elements["interview-active-title"].textContent = interview?.title || "Select or create a chat";
  elements["interview-snapshot"].textContent = interview
    ? `Branched at move ${interview.branched_at_action} while the run was ${statusLabel(interview.run_status_at_branch)}.`
    : "A new chat branches from the latest benchmark moment.";
  elements["interview-fork"].textContent = interview?.fork_thread_id
    ? `fork ${interview.fork_thread_id.slice(-12)}`
    : "not created";
  elements["end-interview"].disabled = !interview || running || forking || ended;
  // Let the user draft freely; only sending waits for an open interview fork.
  elements["interview-question"].disabled = running || queued;
  const unanswered = interview?.status === "failed" && messages.at(-1)?.role === "user"
    ? messages.at(-1).content
    : "";
  if (unanswered && !elements["interview-question"].value) {
    elements["interview-question"].value = unanswered;
  }
  syncInterviewSendButton();
  elements["interview-status"].textContent = interview?.error
    ? interview.error
    : queued
      ? `${interview.notice || "Codex is temporarily unavailable. Your question will retry automatically."}${interview.next_retry_at ? ` Next attempt ${new Date(interview.next_retry_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}.` : ""}`
    : running
      ? "The forked model is answering…"
      : ended
        ? "This chat is read-only now. Start a new chat to branch from the benchmark’s latest moment."
      : available
        ? "Type any question. No tools or maze actions are available inside this fork."
        : library?.available
          ? "Create or select an open chat."
          : "The benchmark thread is still starting; branching will unlock automatically.";
  if (messages.length) elements["interview-messages"].scrollTop = elements["interview-messages"].scrollHeight;
}

function renderRun(run, allRuns, interviewLibrary, interview) {
  if (elements["world-update-status"]) {
    elements["world-update-status"].hidden = !run.world_updates;
    elements["world-update-status"].textContent = `Live room edits · apply on fresh entry · ${run.world_revision || 0} published edits received`;
  }

  elements["run-content"].hidden = false;
  elements["load-error"].hidden = true;
  const changedRun = currentRun?.id !== run.id;
  const changedHistory = changedRun ||
    currentRun?.history_cursor?.epoch !== run.history_cursor?.epoch ||
    currentRun?.history_epoch !== run.history_epoch ||
    (run.action_count || 0) < (currentRun?.action_count || 0);
  currentRun = run;
  if (changedHistory) {
    // Rollbacks reuse move numbers. Discard old frames and any pending response
    // before it can pair a discarded board with the new action history.
    stopPlayback();
    frameRequest += 1;
    frameCache.clear();
    followingLatest = true;
    analysisData = null; analysisKey = null;
  }
  document.body.classList.toggle("tools-on", Boolean(run.tools_enabled));
  document.body.classList.toggle("ice-world", numberedWorld(run));
  document.title = `${run.model} · MazeBench record`;
  elements["model-monogram"].textContent = modelMonogram(run.model);
  elements["run-kicker"].textContent = `${worldName(run)} · ${providerName(run.provider)}${run.observation_mode === "vision" ? " · Vision" : ""} · Python ${run.tools_enabled ? "on" : "off"}`;
  elements["run-title"].textContent = run.model;
  elements["run-subtitle"].textContent = `${run.effort} reasoning${run.world === "slotski" ? ` · ${run.sequence_enabled === false ? "Single moves" : "Batched moves"}` : ""} · ${run.service_tier === "fast" ? "Fast" : "Standard"} · ${compactDate(run.created_at)}`;
  elements["run-id"].textContent = run.id;
  elements["run-status"].textContent = statusLabel(run.status);
  elements["run-status"].className = `status-pill ${run.status}`;
  elements["run-failure"].hidden = run.status !== "failed";
  elements["run-failure-reason"].textContent = run.error || "The runner stopped before finishing. Inspect the activity record for details.";
  const terminalGame = ["won", "action-limit"].includes(run.game_status);
  const activeRun = Boolean(run.runner_active);
  const resumableBoundary = Boolean(run.capability_boundary_verified);
  elements["pause-run"].hidden = !activeRun || run.status === "pausing";
  elements["pause-run"].disabled = !activeRun;
  elements["resume-run"].hidden = terminalGame || !resumableBoundary ||
    (!["paused", "stopped", "interrupted"].includes(run.status) && !(run.world === "slotski" && run.status === "failed") && !run.compaction_recoverable);
  elements["resume-run"].disabled = false;
  elements["stop-run"].hidden = terminalGame || ["stopped", "failed", "completed"].includes(run.status);
  elements["stop-run"].disabled = false;
  elements["delete-run"].disabled = activeRun;
  elements["delete-run"].title = activeRun ? "Stop or pause this run before deleting it." : "Permanently delete this run record.";
  elements["stat-actions"].textContent = `${standardNumbers.format(run.action_count || 0)}${run.action_limit ? ` / ${standardNumbers.format(run.action_limit)}` : ""}`;
  elements["stat-gems"].previousElementSibling.textContent = numberedWorld(run) ? "Levels solved" : "Gems";
  elements["stat-rooms"].previousElementSibling.textContent = numberedWorld(run) ? "Current level" : "Rooms";
  elements["stat-gems"].textContent = numberedWorld(run) ? `${run.levels_solved || 0} / ${run.levels_total || (run.world === "slotski" ? 1 : 30)}` : `${run.gems_collected || 0} / ${run.gems_total || 100}`;
  elements["stat-rooms"].textContent = formatNumber(numberedWorld(run) ? run.level_number : run.rooms_visited || 1);
  elements["stat-cells"].textContent = formatNumber(run.unique_cells || 0);
  elements["stat-novelty"].textContent = `${Math.round((run.novelty_rate || 0) * 100)}%`;
  elements["stat-blocked"].textContent = formatNumber(run.blocked_actions || 0);
  elements["stat-deaths"].previousElementSibling.textContent = run.world === "slotski" ? "Target row" : run.world === "ice-maze" ? "Goals covered" : "Deaths";
  elements["stat-deaths"].textContent = run.world === "slotski" ? `${(run.target_row || 0) + 1} / ${(run.board_height || 5) - 1}` : run.world === "ice-maze" ? `${run.goals_covered || 0} / ${run.goals_total || 0}` : formatNumber(run.deaths || 0);
  elements["progress-chart"].setAttribute("aria-label", numberedWorld(run) ? "Levels solved and action progress" : "Gem and action progress");
  document.getElementById("board-legend").textContent = run.world === "slotski" ? "A target · letters are blocks · . empty · vv exit" : run.world === "ice-maze" ? "# wall · . ice · o goal · P player · @ covered goal" : "Move history playback";
  elements["stat-tokens"].textContent = tokenUsage ? formatNumber(usageTotal(tokenUsage)) : "—";
  elements["novelty-value"].textContent = `${Math.round((run.novelty_rate || 0) * 100)}% overall`;
  const progress = run.action_limit ? Math.min(100, (run.action_count || 0) / run.action_limit * 100) : 0;
  elements["progress-value"].textContent = run.game_status === "won" ? "objective complete" : run.action_limit ? `${Math.round(progress)}% of budget` : "unlimited run";
  elements.continuations.textContent = formatNumber(run.continuation_count || 0);
  elements["final-message"].textContent = activityData?.final_message || run.final_message || (isFinished(run) ? "The model did not leave a final message." : "No final model message yet.");
  if (followingLatest || changedRun) {
    currentFrame = run.action_count || 0;
    renderBoard(run.display);
    elements["board-room"].textContent = `${numberedWorld(run) ? "" : "Room "}${run.display?.room || run.room || "—"}`;
    elements["board-move"].textContent = moveLabel(run.display?.observation_revision ?? run.action_count ?? 0);
    elements["frame-source"].textContent = run.observation_mode === "vision" ? "Live 3D agent observation" : "Latest observation";
  }
  syncTransport();
  elements.heatmap.setAttribute("aria-label", run.world === "slotski" ? "Top-left positions of selected blocks after actions" : "Heatmap of positions visited");
  if (runTabVisible("overview")) drawProgress(run);
  renderPair(run, allRuns);
  renderInterview(interviewLibrary, interview);
  elements["connection-status"].textContent = run.runner_active ? "Live" : "Saved run";
  elements["connection-status"].classList.remove("error");
  document.body.dataset.runnerActive = String(run.runner_active);
}

function renderAnalysis() {
  if (!analysisData || !currentRun || !runTabVisible("analysis")) return;
  const heatmap = analysisData.heatmap || heatmapVisits(analysisData);
  elements["heatmap-count"].title = `Includes slide and punch paths for ${heatmap.trackedActions} moves. Older moves retain their recorded endpoints.`;
  drawHeatmap(heatmap.points || heatmap.positions, currentRun.tools_enabled, heatmap.current);
  drawNovelty(analysisData.novelty, currentRun.tools_enabled);
  renderIceLevelTimings({ ...currentRun, ...analysisData }, document);
}

async function refreshSection() {
  if (!currentRun || document.hidden) return;
  if (runTabVisible("overview")) { fitBoard(); drawProgress(currentRun); return; }
  if (runTabVisible("analysis")) {
    const key = `${currentRun.history_epoch}:${currentRun.action_count}:${currentRun.status}`;
    if (analysisKey === key) { renderAnalysis(); return; }
    if (analysisBusy) return;
    analysisBusy = true;
    const status = document.getElementById("analysis-status");
    status.hidden = false; status.textContent = analysisData ? "Updating charts…" : "Loading run analysis…";
    try {
      const value = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}?view=analysis`);
      if (value.history_epoch && currentRun.history_epoch && value.history_epoch !== currentRun.history_epoch) return;
      analysisData = value; analysisKey = key;
      renderAnalysis(); status.hidden = true;
    } catch (error) { status.textContent = `Analysis couldn’t load: ${error.message} Select Analysis to retry.`; }
    finally { analysisBusy = false; }
    return;
  }
  if (runTabVisible("activity")) {
    if (activityBusy) return;
    if (activityData && Date.now() - activityAt < (currentRun.runner_active ? 3000 : 30000)) {
      renderFeed(activityData); renderWorkspace({ ...currentRun, ...activityData }); return;
    }
    activityBusy = true;
    const status = document.getElementById("activity-status");
    status.hidden = false; status.textContent = "Loading recent activity…";
    try {
      activityData = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}?view=activity`); activityAt = Date.now();
      renderFeed(activityData); renderWorkspace({ ...currentRun, ...activityData });
      elements["final-message"].textContent = activityData.final_message || "No final model message.";
      status.hidden = true;
    } catch (error) { status.textContent = error.message; }
    finally { activityBusy = false; }
    return;
  }
  if (runTabVisible("interviews") && !interviewBusy) {
    interviewBusy = true;
    try {
      const library = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews`);
      if (!library.chats.some(chat => chat.id === selectedInterviewId)) selectedInterviewId = library.chats[0]?.id || null;
      const interview = selectedInterviewId ? await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(selectedInterviewId)}`) : null;
      renderInterview(library, interview);
    } catch (error) { elements["interview-status"].textContent = error.message; }
    finally { interviewBusy = false; }
  }
}

function showError(error) {
  elements["run-content"].hidden = true;
  elements["load-error"].hidden = false;
  elements["error-copy"].textContent = error.message;
  elements["connection-status"].textContent = "record unavailable";
  elements["connection-status"].classList.add("error");
}

function refresh() {
  if (!runId) return Promise.resolve();
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    try {
      const run = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}?view=overview`);
      renderRun(run, pairRuns, currentInterviewLibrary, currentInterview);
      void refreshSection();
      if (run.pair_id && Date.now() - pairAt > 30000) {
        pairAt = Date.now();
        api("/api/benchmark/v1/runs?view=library").then(library => { pairRuns = library.runs || []; renderPair(currentRun, pairRuns); }).catch(() => { pairAt = 0; });
      }
    } catch (error) {
      if (!currentRun) showError(error);
      else { elements["connection-status"].textContent = "Connection lost · retrying"; elements["connection-status"].classList.add("error"); }
    } finally {
      refreshPromise = null;
      scheduleRefresh();
    }
  })();
  return refreshPromise;
}

function scheduleRefresh() {
  clearTimeout(pollTimer);
  if (document.hidden) return;
  const liveInterview = currentInterviewLibrary?.chats?.some(chat => ["forking", "running", "queued"].includes(chat.status));
  pollTimer = setTimeout(refresh, currentRun?.runner_active || liveInterview || !currentRun ? 3000 : 30000);
}
document.addEventListener("run-tab-change", () => {
  if (!runTabVisible("overview")) stopPlayback();
  void refreshSection();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { clearTimeout(pollTimer); stopPlayback(); }
  else refresh();
});
document.addEventListener("run-tokens", event => { tokenUsage = event.detail; elements["stat-tokens"].textContent = formatNumber(usageTotal(tokenUsage)); });

async function refreshAfterMutation() {
  if (refreshPromise) await refreshPromise;
  return refresh();
}

elements["stop-run"].addEventListener("click", async () => {
  elements["stop-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
    await refreshAfterMutation();
  } catch (error) {
    elements["stop-run"].disabled = false;
    showError(error);
  }
});

elements["pause-run"].addEventListener("click", async () => {
  elements["pause-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/pause`, { method: "POST" });
    await refreshAfterMutation();
  } catch (error) {
    elements["pause-run"].disabled = false;
    elements["connection-status"].textContent = error.message;
    elements["connection-status"].classList.add("error");
  }
});

elements["resume-run"].addEventListener("click", async () => {
  elements["resume-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/resume`, { method: "POST" });
    await refreshAfterMutation();
  } catch (error) {
    elements["resume-run"].disabled = false;
    elements["connection-status"].textContent = error.message;
    elements["connection-status"].classList.add("error");
  }
});

elements["delete-run"].addEventListener("click", async () => {
  if (!currentRun || currentRun.runner_active) return;
  const confirmed = window.confirm(
    `Permanently delete ${currentRun.model} run ${currentRun.id}?\n\nThis removes its record, workspace, replay, and interview chats. This cannot be undone.`
  );
  if (!confirmed) return;
  elements["delete-run"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    window.location.assign("./");
  } catch (error) {
    elements["delete-run"].disabled = false;
    elements["connection-status"].textContent = error.message;
    elements["connection-status"].classList.add("error");
  }
});

function seekFrame(index) {
  stopPlayback();
  showFrame(index).catch((error) => {
    elements["frame-source"].textContent = error.message;
  });
}

elements["frame-first"].addEventListener("click", () => seekFrame(0));
elements["frame-previous"].addEventListener("click", () => seekFrame(currentFrame - 1));
elements["frame-play"].addEventListener("click", startPlayback);
elements["frame-next"].addEventListener("click", () => seekFrame(currentFrame + 1));
elements["frame-last"].addEventListener("click", () => seekFrame(currentRun?.action_count || 0));
elements["frame-scrubber"].addEventListener("input", (event) => seekFrame(event.currentTarget.value));
elements["replay-speed"].addEventListener("change", replayDelay);

elements["interview-list"].addEventListener("click", async (event) => {
  const row = event.target.closest("[data-chat-id]");
  if (!row) return;
  selectedInterviewId = row.dataset.chatId;
  try {
    const interview = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(selectedInterviewId)}`);
    renderInterview(currentInterviewLibrary, interview);
  } catch (error) {
    elements["interview-status"].textContent = error.message;
  }
});

elements["new-interview"].addEventListener("click", async () => {
  if (creatingInterview || !currentInterviewLibrary?.available) return;
  creatingInterview = true;
  renderInterview(currentInterviewLibrary, currentInterview);
  try {
    const interview = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews`, {
      method: "POST",
      body: "{}"
    });
    selectedInterviewId = interview.id;
    creatingInterview = false;
    await refreshAfterMutation();
    elements["interview-question"].focus();
  } catch (error) {
    creatingInterview = false;
    renderInterview(currentInterviewLibrary, currentInterview);
    elements["interview-status"].textContent = error.message;
  }
});

elements["end-interview"].addEventListener("click", async () => {
  if (!currentInterview || currentInterview.status === "running") return;
  elements["end-interview"].disabled = true;
  try {
    await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(currentInterview.id)}/end`, {
      method: "POST",
      body: "{}"
    });
    await refreshAfterMutation();
  } catch (error) {
    elements["end-interview"].disabled = false;
    elements["interview-status"].textContent = error.message;
  }
});

elements["interview-question"].addEventListener("input", syncInterviewSendButton);

elements["interview-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = elements["interview-question"].value.trim();
  if (!question || ["running", "queued", "forking"].includes(currentInterview?.status)) return;
  let interview = currentInterview;
  let optimistic = null;
  try {
    if (!interview?.available || interview.status === "ended") {
      if (!currentInterviewLibrary?.available || creatingInterview) return;
      creatingInterview = true;
      renderInterview(currentInterviewLibrary, currentInterview);
      interview = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews`, {
        method: "POST",
        body: "{}"
      });
      selectedInterviewId = interview.id;
      creatingInterview = false;
    }
    optimistic = {
      ...interview,
      status: "running",
      error: null,
      messages: [
        ...(interview.messages || []),
        { role: "user", content: question, at: new Date().toISOString() }
      ]
    };
    elements["interview-question"].value = "";
    renderInterview(currentInterviewLibrary, optimistic);
    const answer = await api(`/api/benchmark/v1/runs/${encodeURIComponent(runId)}/interviews/${encodeURIComponent(interview.id)}/messages`, {
      method: "POST",
      body: JSON.stringify({ question })
    });
    renderInterview(currentInterviewLibrary, answer);
    await refreshAfterMutation();
  } catch (error) {
    creatingInterview = false;
    renderInterview(currentInterviewLibrary, optimistic
      ? { ...optimistic, status: "failed", error: error.message }
      : currentInterview);
    elements["interview-status"].textContent = error.message;
    elements["interview-question"].value = question;
    syncInterviewSendButton();
  }
});

window.addEventListener("resize", () => {
  if (!currentRun) return;
  if (runTabVisible("overview")) { fitBoard(); drawProgress(currentRun); }
  else if (runTabVisible("analysis")) renderAnalysis();
});

if (!runId) {
  showError(new Error("No run id was supplied in this record URL."));
} else {
  await refresh();
}

elements["retry-new-run"].addEventListener("click", async () => {
  if (!currentRun) return;
  const button = elements["retry-new-run"];
  button.disabled = true;
  try {
    const run = await api("/api/benchmark/v1/runs", {
      method: "POST",
      body: JSON.stringify({
        provider: currentRun.provider || "codex", model: currentRun.model, effort: currentRun.effort, tools_enabled: currentRun.tools_enabled,
        observation_mode: currentRun.observation_mode || "ascii", service_tier: currentRun.service_tier,
        ...(currentRun.world === "slotski" ? { sequence_enabled: currentRun.sequence_enabled !== false } : {}),
        world: currentRun.world || "main-world", action_limit: currentRun.action_limit, start_room: currentRun.start_room
      })
    });
    location.href = `./run.html?id=${encodeURIComponent(run.id)}`;
  } catch (error) {
    elements["run-failure-reason"].textContent = error.message;
    button.disabled = false;
  }
});
