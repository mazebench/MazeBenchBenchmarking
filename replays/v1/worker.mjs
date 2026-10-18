import { loadMazeBenchEngineV1 } from "../../engine/current/engine.mjs";
import { parseReplay, resolveRoom } from "./import.mjs";
import { compileReplay } from "./movie.mjs";

self.onmessage = async ({ data: { world, text, start, name } }) => {
  try {
    const engine = await loadMazeBenchEngineV1();
    let imported = parseReplay(text, { start, name });
    if (imported.saved) {
      const { SolutionsModel, worldFingerprint } = await import("../../solutions/v1/model.mjs");
      const { compileFullSolution } = await import("../../solutions/v1/full-solution.mjs");
      const model = new SolutionsModel(engine, world, await worldFingerprint(world), resolveRoom(world, imported.start).fileName);
      const progress = (done, total) => self.postMessage({ type: "progress", done, total, phase: "Reading saved routes" });
      const result = await model.importJSON(JSON.stringify(imported.saved), progress, { allowWorldChange: true, allowEngineChange: true });
      const full = await compileFullSolution(model, { onProgress: value => progress(value.done, value.total) });
      imported = parseReplay(JSON.stringify(full), { name });
      if (result.warnings.length) imported.notice = `${result.warnings.length} saved routes could not be reproduced. Playing the verified solution.`;
    }
    const movie = await compileReplay(engine, world, imported, { onProgress: (done, total) => self.postMessage({ type: "progress", done, total, phase: "Preparing replay" }) });
    self.postMessage({ type: "ready", movie }, movie.layouts.map(layout => layout.buffer));
  } catch (error) { self.postMessage({ type: "error", message: error.message || "Could not prepare this replay." }); }
};
