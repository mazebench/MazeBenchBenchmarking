import { loadMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";

export const EDITOR_SOLVER_PRESETS_V1 = Object.freeze({
  quick: Object.freeze({ id: "quick", label: "Quick", maximumNodes: 12_000, maximumEdges: 512 }),
  exact: Object.freeze({ id: "exact", label: "Exact", maximumNodes: 180_000, maximumEdges: 8_192 })
});

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class EditorSolversV1 {
  constructor() {
    this.worker = null;
    this.reject = null;
    this.requestId = 0;
  }

  solve(room, blocks, preset = EDITOR_SOLVER_PRESETS_V1.exact) {
    this.cancel();
    const id = ++this.requestId;
    this.worker = new Worker(new URL("../../engine/v1/solver-worker.mjs", import.meta.url), {
      type: "module",
      name: `mazebench-engine-v1-${preset.id}`
    });
    return new Promise((resolve, reject) => {
      this.reject = reject;
      this.worker.addEventListener("message", (event) => {
        if (event.data?.id !== id) return;
        const worker = this.worker;
        this.worker = null;
        this.reject = null;
        worker?.terminate();
        if (event.data.error) reject(new Error(event.data.error));
        else resolve({ ...event.data.result, preset });
      });
      this.worker.addEventListener("error", (event) => {
        const worker = this.worker;
        this.worker = null;
        this.reject = null;
        worker?.terminate();
        reject(new Error(event.message || "engine/v1 solver worker failed."));
      }, { once: true });
      this.worker.postMessage({
        id,
        room: {
          width: room.width,
          height: room.height,
          objects: room.objects.map((object) => ({ ...object }))
        },
        blocks,
        maximumNodes: preset.maximumNodes
      });
    });
  }

  findEdges(room, preset = EDITOR_SOLVER_PRESETS_V1.quick, options = {}) {
    this.cancel();
    const id = ++this.requestId;
    this.worker = new Worker(new URL("../../world-solver/v1/worker.mjs", import.meta.url), {
      type: "module",
      name: `mazebench-edge-finder-v1-${preset.id}`
    });
    return new Promise((resolve, reject) => {
      this.reject = reject;
      this.worker.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.type === "progress") {
          options.onProgress?.(message.message);
          return;
        }
        if (message.type !== "complete" && message.type !== "error") return;
        const worker = this.worker;
        this.worker = null;
        this.reject = null;
        worker?.terminate();
        if (message.type === "error") reject(new Error(message.error));
        else resolve({ results: message.results, preset });
      });
      this.worker.addEventListener("error", (event) => {
        const worker = this.worker;
        this.worker = null;
        this.reject = null;
        worker?.terminate();
        reject(new Error(event.message || "edge-finder worker failed."));
      }, { once: true });
      this.worker.postMessage({
        scope: "room",
        room: {
          fileName: room.fileName,
          width: room.width,
          height: room.height,
          objects: room.objects.map((object) => ({ ...object }))
        },
        maximumNodes: preset.maximumNodes,
        maximumEdges: preset.maximumEdges,
        includeSavedEntries: options.includeSavedEntries === true
      });
    });
  }

  cancel() {
    if (!this.worker) return false;
    this.worker.terminate();
    this.worker = null;
    const reject = this.reject;
    this.reject = null;
    reject?.(new DOMException("Solver cancelled.", "AbortError"));
    return true;
  }
}

export async function replayEngineSolutionV1(room, blocks, solution, onFrame, options = {}) {
  const engine = await loadMazeBenchEngineV1();
  let state = engine.createState(room);
  const delay = options.frameDelay || 90;
  const isCancelled = options.isCancelled || (() => false);
  for (const direction of solution) {
    if (isCancelled()) return null;
    const simulation = await engine.simulateCommand(state, direction, blocks);
    const frames = simulation.frames.length ? simulation.frames : [simulation.final];
    for (const frame of frames) {
      if (isCancelled()) return null;
      state = frame;
      onFrame(engine.roomFromState(state, room));
      await wait(delay);
    }
    state = simulation.final;
  }
  return state;
}

export function solverPathLabelV1(solution) {
  const arrows = { up: "↑", right: "→", down: "↓", left: "←" };
  return solution.map((direction) => arrows[direction] || direction).join(" ");
}
