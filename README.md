# MazeBenchBenchmarking

A local site for exploring MazeBench, playing puzzles, editing rooms, and running AI benchmarks.

With **Node.js** installed, open a terminal in this repository and start the site:

```sh
node server.mjs
```

Open **[http://localhost:8080](http://localhost:8080)** in your browser. No dependency install or build step is required.

Keep the terminal open while using the site. Press **Ctrl+C** to stop the server.

The default site startup also starts the vision runner on port 8082. If the
main server is already running, `npm run start:vision` adds it without
interrupting existing runs. Vision launches require that service and fail with
an error if it is offline; they never fall back to ASCII. Image rendering uses
Playwright and Chrome as described in [the vision setup](benchmarking/vision/README.md).

Main-world run cards share a **3D / ASCII** replay switch, independent of what the
agent received. The **Agent** label shows the original observation mode. 3D uses
the Replays renderer and tween curves for smooth playback and seeking. A read-only
companion on port 8085 authenticates saved vision frames; for text runs it replays
commands in memory with the pinned engine and checks every saved state hash. It
never changes run records or agent observations. Long text histories can take a
few seconds to prepare the first time. Verified moves arrive in batches, so you
can play before the whole history finishes loading. The scrubber shows played
moves in purple, buffered moves in gray, and unloaded moves on the dark track.
Playback waits at the buffer edge and continues when more moves arrive; seeking
ahead waits for that part of the history. A loading bar and percentage show real
move progress. Subsequent updates compile and transfer only new moves.
The companion starts with the main site, or use `npm run start:playback` to add it
to an already-running site.

New moves load automatically without replacing the player or interrupting playback.
**Live** starts enabled for active runs and follows incoming moves. Scrubbing back
or playing history turns following off while the timeline keeps updating; click
**Live** to return to the latest move. Switching **3D / ASCII** preserves your place.
In 3D, the **ⓘ** menu contains **Agent camera**, checked by default to follow the
recorded yaw/pitch; uncheck it to orbit, pan, and zoom freely. **Show neighboring
rooms** is a separate checkbox, off by default.

The download menu exports either **3D** or **ASCII** as a **GIF** or **Video**.
Each export captures the whole run recorded so far at the selected playback
speed, using the current camera and neighboring-room options. ASCII retains its
fixed letter size and original font. Exports have progress and cancellation and
use a separate renderer, leaving the viewer and active runners alone. Videos
use MP4 when the browser supports it, otherwise WebM, and record in real time;
keep the tab open during creation. GIFs loop with a short final hold and reduce
their frame rate for very long histories to keep encoding bounded.

Once the server is running, you can go directly to:

- Benchmarks: Run eval with Codex / Claude Code / Grok / Antigravity / [Meta Muse Code](benchmarking/muse/README.md) / [Kimi Code](benchmarking/kimi/README.md) / [Prime Agent](benchmarking/prime/README.md)
- Play: Explore the world for yourself
- Room editor: Edit and save levels in MazeBench


All harnesses offer **Any language** for their supported ASCII worlds. Start Docker
first; the pinned toolchain is installed with `npm run setup:code-sandbox`. Prime
keeps its native Python transport and adds the same isolated `code_exec` tool.
The Analysis tab shows live input, cached input, output and estimated API cost.
These are API-equivalent token estimates, not subscription charges.

The site also starts a localhost capability service on port 8083. To add the
updated reporting and new coding modes while the main server owns active runs,
run `npm run start:capabilities`; refresh the browser without restarting the main
server. Existing runs keep their original runtime and owner. Do not stop the
capability service while it owns an active Any language run.

---

This repository also contains the canonical C++ engine, visual physics test
editor, and every authored/native/WASM test imported from MazeBenchEngineUnitTest.
All future engine and rendering development happens here.

For the test lab and development tools:

```sh
npm ci
npm run dev:lab       # http://localhost:3001
npm run build         # lab, canonical engine, and solver accelerators
npm test              # native engine + lab/WASM + site integration tests
npm run test:parity   # shared renderer identity and live engine equivalence
```

The main site still runs with `node server.mjs` on port 8080. Physics source
lives in `engine/src` and `engine/include`; authored test data is in
`project-data`; the test editor is in `apps/web`. See [the test-lab guide](docs/test-lab.md)
and [the consolidation notes](docs/consolidation.md).

Both live browser applications use the same built WASM and rendering geometry
module. Scene/coordinate adapters and camera controls remain specific to their
interfaces. Signed historical benchmark runtimes remain frozen under their
versioned paths; moving repositories does not upgrade or reseal recorded runs.

---

## What the Model Sees

In "ASCII" Mode the tiles are represented by text. Each tile type has a unique character symbol picked by a random seed. When the camera is in a top down position tiles take up 4x4 characters. Since each room is 16x16 tiles, rooms will not take up more than 64x64 characters. Agents do not see previews of neighboring rooms, and must understand that crossing the edge of the room will transport the character into another room.

After each move agents are always told the current board state. If a move generated a long action sequence (like sliding over ice, up ramps, or off a cliff) agents can examine the full action sequence. Agents also have access to the entire action history and can refer to any previous board state.

<img width="352" height="435" alt="orange-box-level-demo" src="https://github.com/user-attachments/assets/6a298e2e-e3ff-4f51-9639-f39a97eab7ed" />



For a shorter development loop, `npm run test:quick` runs the lab, engine/WASM,
and site unit checks against the current built engine. `npm run test:integration`
runs the slower vision/browser integrations. `npm test` still rebuilds and runs
every native, WASM, app, and integration check.
