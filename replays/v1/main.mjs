import { loadBrowserWorld, paintLoadProgress } from "../../ui/browser-world.mjs";
import { bindCameraHold } from "../../render/v1/camera-controls.mjs";
import { locateReplay } from "./movie.mjs";
import { ReplayView } from "./view.mjs";
import { installTruncateControls } from "../../ui/truncate-controls.mjs";
import { ReplayMarkers } from "./markers.mjs";
import { ImportEstimate } from "./progress.mjs";

const $ = id => document.getElementById(id);
const dialog = $("import-dialog");
let world, view, movie, worker, busy = false, generation = 0, playing = false, time = 0, lastFrame = 0, frameId = 0, noticeTimer;
const count = value => value.toLocaleString();
const roomLabel = id => world.rooms.find(room => room.fileName === id)?.position.join("×") || id;
const formatTime = (value, precise = false) => {
  const seconds = Math.max(0, value) / 1000, whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}${precise ? `.${String(Math.floor(Math.max(0, value) / 10) % 100).padStart(2, "0")}` : ""}`;
};
const markers = new ReplayMarkers({ seek, pause, roomLabel, formatTime });
const importEstimate = new ImportEstimate();
let estimateTimer;
const updateEstimate = () => { $("import-eta").textContent = importEstimate.label(performance.now()); };

function progress(done, total, phase) {
  importEstimate.update(done, total, phase, performance.now());
  updateEstimate();
  $("load-progress").max = total || 1;
  $("load-progress").value = done;
  $("load-progress").setAttribute("aria-label", phase);
  $("import-phase").textContent = `${phase}${total > 100 ? ` · ${count(done)} / ${count(total)}` : ""}`;
}
let worldError;
const worldPromise = loadBrowserWorld((done, total, phase) => { if (busy && !worker) progress(done, total, phase); })
  .then(result => (world = result)).catch(error => { worldError = error; });

function announce(text) {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").hidden = !text;
  if (text) noticeTimer = setTimeout(() => { $("notice").hidden = true; }, 9000);
}

function updateTransport(location) {
  const { clip, index, local } = location;
  $("seek").value = String(time);
  $("seek").style.setProperty("--played", `${100 * time / movie.duration}%`);
  $("seek").setAttribute("aria-valuetext", `${formatTime(time, true)} of ${formatTime(movie.duration, true)}, action ${index + 1} of ${movie.clips.length}`);
  $("timecode").textContent = `${formatTime(time, !playing)} / ${formatTime(movie.duration, movie.duration < 10000)}`;
  $("progress-summary").textContent = `${count(index + 1)} / ${count(movie.clips.length)} actions · ${movie.gems.filter(gem => gem.at <= time).length} gems`;
  $("room-name").textContent = roomLabel(local >= clip.settledAt ? clip.to : clip.room);
  $("action-label").textContent = clip.label;
  $("toggle-play").setAttribute("aria-label", playing ? "Pause" : time >= movie.duration ? "Replay" : "Play");
  $("play-icon").setAttribute("d", playing ? "M6 5h4v14H6zM14 5h4v14h-4z" : "m8 5 11 7-11 7z");
  $("previous").disabled = time === 0;
  $("next").disabled = time >= movie.duration;
}

function draw(nextTime) {
  if (!movie) return;
  const location = view.show(nextTime);
  time = location.time;
  updateTransport(location);
}

function tick(now) {
  frameId = 0;
  if (!playing) return;
  const next = time + Math.max(0, now - lastFrame) * Number($("speed").value);
  lastFrame = now;
  if (next >= movie.duration) playing = false;
  draw(next);
  if (playing) frameId = requestAnimationFrame(tick);
}

function pause() {
  playing = false;
  cancelAnimationFrame(frameId);
  frameId = 0;
  if (movie) updateTransport(locateReplay(movie, time));
}

function togglePlay() {
  if (!movie || busy || dialog.open) return;
  if (playing) { pause(); return; }
  if (time >= movie.duration) draw(0);
  playing = true;
  lastFrame = performance.now();
  updateTransport(locateReplay(movie, time));
  frameId = requestAnimationFrame(tick);
}

function seek(value) { pause(); draw(value); }
function step(direction) {
  if (!movie) return;
  const { index, clip } = locateReplay(movie, time);
  seek(direction < 0 ? time > clip.start ? clip.start : movie.clips[Math.max(0, index - 1)].start
    : movie.clips[index + 1]?.start ?? movie.duration);
}

function setBusy(value) {
  busy = value;
  clearInterval(estimateTimer);
  importEstimate.reset();
  if (value) { updateEstimate(); estimateTimer = setInterval(updateEstimate, 500); }
  for (const id of ["choose-file", "source", "start-room", "build-replay", "close-import"]) $(id).disabled = value;
  $("import-progress").hidden = !value;
}

function cancelImport() {
  generation++;
  worker?.terminate(); worker = null;
  setBusy(false);
  if (movie && view?.movie !== movie) view.setMovie(movie);
}

async function buildReplay(text, name = "Pasted sequence") {
  fileGeneration++;
  cancelImport(); pause();
  const job = generation;
  if (!dialog.open) dialog.showModal();
  $("import-error").hidden = true;
  if (!String(text).trim()) { $("import-error").textContent = "Choose a file or paste a move sequence first."; $("import-error").hidden = false; return; }
  setBusy(true);
  progress(0, 1, world ? "Preparing replay" : "Loading world");
  try {
    await worldPromise;
    if (job !== generation) return;
    if (!world) throw worldError || new Error("Could not load the world.");
    worker = new Worker(new URL("./worker.mjs", import.meta.url), { type: "module" });
    const imported = await new Promise((resolve, reject) => {
      worker.onerror = event => reject(new Error(event.message || "Could not prepare this replay."));
      worker.onmessage = ({ data }) => {
        if (job !== generation) return;
        if (data.type === "progress") progress(data.done, data.total, data.phase);
        else if (data.type === "error") reject(new Error(data.message));
        else if (data.type === "ready") resolve(data.movie);
      };
      worker.postMessage({ world, text, name, start: $("start-room").value });
    });
    worker.terminate(); worker = null;
    progress(0, 1, "Drawing world");
    $("stage").hidden = false;
    await paintLoadProgress();
    if (job !== generation) return;
    if (!view) {
      view = new ReplayView($("replay-canvas"), world, imported);
      installTruncateControls($("cutaway-controls"), view.renderer, { ghosts: true });
      new ResizeObserver(() => view.renderer.resize()).observe($("stage"));
      bindCameraHold($("zoom-in"), { getRenderer: () => view.renderer, key: "q", tap: () => view.renderer.zoomBy(.8) });
      bindCameraHold($("zoom-out"), { getRenderer: () => view.renderer, key: "e", tap: () => view.renderer.zoomBy(1.25) });
    } else view.setMovie(imported);
    while (Number(view.renderer.canvas.dataset.cachedRoomCount) < world.rooms.length && job === generation) {
      progress(Number(view.renderer.canvas.dataset.cachedRoomCount) || 0, world.rooms.length, "Drawing world");
      await paintLoadProgress();
    }
    if (job !== generation) return;
    view.renderer.render();
    progress(1, 1, "Ready");
    await paintLoadProgress();
    if (job !== generation) return;
    movie = imported;
    time = 0;
    $("movie-name").textContent = movie.name;
    $("movie-name").title = movie.name;
    $("seek").max = String(movie.duration);
    markers.setMovie(movie);
    for (const id of ["scene-info", "camera-tools", "transport", "open-import", "close-import"]) $(id).hidden = false;
    draw(0);
    setBusy(false);
    dialog.close();
    view.renderer.resize();
    announce(movie.notice);
    $("toggle-play").focus();
  } catch (error) {
    if (job !== generation) return;
    worker?.terminate(); worker = null;
    setBusy(false);
    $("import-error").textContent = error.message || "Could not open this replay.";
    $("import-error").hidden = false;
  }
}

let fileGeneration = 0;
async function openFile(file) {
  if (!file) return;
  const job = ++fileGeneration;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error("Choose a text or JSON replay smaller than 20 MB.");
    const text = await file.text();
    if (job === fileGeneration) await buildReplay(text, file.name.replace(/\.(txt|json)$/i, ""));
  } catch (error) {
    if (!dialog.open) dialog.showModal();
    $("import-error").textContent = error.message;
    $("import-error").hidden = false;
  }
}

$("choose-file").onclick = () => $("import-file").click();
$("import-file").onchange = event => { openFile(event.target.files[0]); event.target.value = ""; };
$("build-replay").onclick = () => buildReplay($("source").value);
$("cancel-import").onclick = cancelImport;
$("open-import").onclick = () => { pause(); $("import-error").hidden = true; dialog.showModal(); };
$("close-import").onclick = () => { if (movie) dialog.close(); };
dialog.addEventListener("cancel", event => { event.preventDefault(); if (busy) cancelImport(); else if (movie) dialog.close(); });
$("toggle-play").onclick = togglePlay;
$("previous").onclick = () => step(-1);
$("next").onclick = () => step(1);
$("seek").oninput = event => seek(Number(event.target.value));
$("seek").title = "Drag to seek. When focused, use the arrow keys for 1 ms steps.";
$("seek").onpointermove = event => {
  if (!movie) return;
  const rect = $("seek").getBoundingClientRect(), fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  const location = locateReplay(movie, fraction * movie.duration);
  $("seek-preview").textContent = `${formatTime(location.time, true)} · ${roomLabel(location.clip.room)}`;
  $("seek-preview").style.left = `${Math.max(70, Math.min(rect.width - 70, fraction * rect.width))}px`;
  $("seek-preview").hidden = false;
};
$("seek").onpointerleave = () => { $("seek-preview").hidden = true; };
$("center-camera").onclick = () => view?.center();
$("speed").onchange = () => { lastFrame = performance.now(); };
$("fullscreen").onclick = async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
  catch { announce("Fullscreen is unavailable in this browser."); }
};
document.addEventListener("fullscreenchange", () => {
  $("fullscreen").setAttribute("aria-label", document.fullscreenElement ? "Exit fullscreen" : "Fullscreen");
  view?.renderer.resize();
});
window.addEventListener("keydown", event => {
  if (!movie || dialog.open || event.metaKey || event.ctrlKey || event.altKey || event.target.isContentEditable || event.target.closest("input,textarea,select,summary")) return;
  const key = event.key.toLowerCase();
  if (![" ", "k", "j", "l", "arrowleft", "arrowright", ",", ".", "home", "end"].includes(key)) return;
  if (key === " " && event.target.closest("button") && event.target !== $("toggle-play")) return;
  event.preventDefault(); event.stopPropagation();
  if (key === " " || key === "k") { if (!event.repeat) togglePlay(); }
  else if (key === "," || key === ".") step(key === "," ? -1 : 1);
  else if (key === "home" || key === "end") seek(key === "home" ? 0 : movie.duration);
  else seek(time + (["j", "arrowleft"].includes(key) ? -1 : 1) * (event.shiftKey ? 100 : 5000));
}, { capture: true });
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
window.addEventListener("pagehide", () => { worker?.terminate(); clearInterval(estimateTimer); pause(); });
let dragDepth = 0;
document.addEventListener("dragenter", event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth++; $("drop-overlay").hidden = dialog.open; } });
document.addEventListener("dragover", event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } });
document.addEventListener("dragleave", event => { if (event.dataTransfer.types.includes("Files") && --dragDepth <= 0) $("drop-overlay").hidden = true; });
document.addEventListener("drop", event => { if (event.dataTransfer.files.length) { event.preventDefault(); dragDepth = 0; $("drop-overlay").hidden = true; openFile(event.dataTransfer.files[0]); } });
dialog.show();
