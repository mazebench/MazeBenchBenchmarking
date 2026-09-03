import { instantiateMazeBenchEngineV1 } from "../../engine/v1/engine.mjs";
import { loadMainWorldV2 } from "../../render/v1/voxel-world-v2.mjs";
import { runRandomAgentV1 } from "./random-agent.mjs";

self.addEventListener("message", async (event) => {
  if (event.data?.type !== "start") return;
  try {
    self.postMessage({ type: "loading" });
    const [engine, world] = await Promise.all([
      fetch(new URL("./random-agent.wasm", import.meta.url))
        .then((response) => {
          if (!response.ok) throw new Error("Could not load the random-agent accelerator.");
          return instantiateMazeBenchEngineV1(response);
        }),
      loadMainWorldV2()
    ]);
    await runRandomAgentV1(engine, world, {
      onProgress: (message) => self.postMessage(message)
    });
  } catch (error) {
    self.postMessage({ type: "error", error: error?.message || "Random agent failed." });
  }
});
