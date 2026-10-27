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

Gemini/Antigravity, Grok Build, Kimi Code, and Muse Code vision runs with Coding
off use the additional owner on port 8086, also started by the site. Use
`npm run start:vision-providers` to add it to an already-running site. The
launcher detects it automatically. Grok, Kimi, and Muse receive native MCP
images; Gemini's CLI uses a restricted viewer that can read only authenticated
observation PNGs. Shell, Python, arbitrary file reads, and writes stay disabled.
Run `npm ci` once for this integration's pinned Playwright dependency; it resolves
independently of isolated agent homes and requires the local Chrome installation.
Existing ASCII and Codex/Claude vision owners and signed runtimes are preserved.

Codex vision runs automatically recover from unfinished `list_mcp_resources`
and `list_mcp_resource_templates` calls that returned no result. The recovery
companion (port 8087, `npm run start:recovery`) verifies the pinned runtime and
checkpoint, backs up the session, removes only the unfinished final call, and
resumes the same conversation. Valid game moves, settings, and agent-event logs
remain unchanged. Active and newly launched runs are enrolled automatically;
historical failures and intentionally paused/stopped runs stay stopped. Pause
and Stop cancel pending retries. Repeated failures have retry limits, and any
completed/other forbidden tool call or changed checkpoint still needs review.

The same companion covers Gemini vision runs when Antigravity returns its
"This request was blocked by Gemini's filters" response. It uses the original
owner's normal Resume operation with the same conversation, prompt, model and
settings; it does not roll back moves, remove provider messages or change filters.
Retries wait 15 seconds, 1 minute, then 3 minutes, stopping after three retries
without new moves or eight per hour. The dashboard shows **Auto-resuming** while
waiting and **Needs attention** if retries are exhausted. Pause/Stop cancels the
retry, including across companion restarts. Attempts are recorded in
`~/.mazebench/gemini-vision-recovery/retry-audit.jsonl`. Other errors and integrity
violations still require review; a successful Resume does not guarantee the
provider will accept its next request.

Grok vision runs also use bounded recovery on port 8087. The controller checks
the recorded result for a matching-session HTTP execution error, then resumes
the preserved conversation with the same 15-second/1-minute/3-minute limits.
Grok 1.0.41 can advertise its three existing maze MCP catalog keys on reconnect;
an audited, per-run compatibility extension accepts those keys while retaining
the original gateway-only invocation checks. Adoption pins the added harness
sources in the run manifest and saves a backup under the run's `repairs/` folder.
Every original runtime hash, game checkpoint, model, effort and coding condition
is retained. The CLI's conversation forks are recorded in `grok_session_lineage`.
The recovery companion owns adopted Grok agents, so shutting it down pauses
those agents; it does not stop the other provider owners. Its retry audit is in
`~/.mazebench/grok-vision-recovery/retry-audit.jsonl`.

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

### Exact run version catalogue

`v1.1.N` identifies a recorded engine/play-adapter and world inventory from this
repository. Its append-only snapshot registry is `benchmarking/version-registry.mjs`.
`v1.0.N` groups legacy runs by their reconstructed engine/adapter inventory,
numbered by first run date: the first engine used is `v1.0.0`, the next distinct
engine is `v1.0.1`, and so on. Runs assigned the same engine share a number;
world-only changes remain in provenance. The public legacy release registry is
`benchmarking/legacy-version-registry.mjs`. The old registry's `1.0` entries are
research snapshot IDs, displayed as `snapshot-N`, not public release labels.
Model, effort, speed and harness versions remain separate dimensions.

To refresh the read-only inventory and register newly discovered snapshots:

```sh
node scripts/catalogue-run-versions.mjs \
  "$HOME/records/mazebench-benchmark" outputs/version-audit/catalogue.json \
  "$HOME/records/mazebench-vision" \
  --legacy-repo /path/to/MazeBenchEngine --register
```

Open `/outputs/version-audit/catalogue.html` on the local site for the searchable
version/run inventory. The JSON includes full fingerprints, linked repair archives,
observed world revisions and action boundaries. Unobserved room edits published
after a run stopped do not become that run's version. Older actions keep their
pre-repair engine identity. Pinned and archived manifests are distinguished from
world revisions observed by actions; a run can span several versions. Git snapshots
from all legacy branches during the saved-run era support the chronological
assignment. A catalogue is an inventory of the supplied roots, not a claim to
recover deleted or unsaved source bytes.

The HTML/JSON reports stay under ignored `outputs/`. The registry contains only
version identities and fingerprint aliases, not run records. This command never
modifies, reseals, pauses or resumes a run.

Older recordings are browsable at `/benchmarking/ui/archive.html`, linked as
**Older runs** in Benchmark navigation. The read-only report service on port 8085
serves paged original ASCII/JSON observations, preserved MP4s with byte-range
seeking, and imported heatmaps. It does not resimulate old records with today's
engine. `MAZEBENCH_LEGACY_RECORDS_ROOT` overrides the legacy run directory. Run
records, research caches, and generated reports remain Git-ignored.

Historical matching is reproducible with:

```sh
node scripts/match-legacy-run-versions.mjs \
  outputs/version-audit/catalogue.json /path/to/MazeBenchEngine
```

This extracts historical Git runtimes into ignored `.mazebench/`, compares
initial board hashes and recorded world gem totals, and checks every saved
`goto_level` state with hash format 3 (which excludes already-collected gems).
It never launches an agent. The output is `outputs/version-audit/legacy-matches.json`.
Then assign concrete legacy releases:

```sh
node scripts/assign-legacy-run-versions.mjs
```

The owner explicitly authorized Git history and run-date reconstruction. Select
the latest preceding state-compatible snapshot when possible; otherwise select
the latest preceding Git snapshot. A future commit is never used when an earlier
snapshot exists. Number distinct selected engine inventories in first-run order.
Each assignment retains the source commit, GitHub link, date, world fingerprint,
and method in `outputs/version-audit/legacy-assignments.json` and the ignored
import index. The original legacy run files and signed runs remain unchanged.
The command preserves a GitHub-ref history log and an import-index backup.
Rerun the catalogue command to refresh its HTML/JSON with the assignments.
Cards and heatmap comparisons show concrete release numbers; provenance identifies
historical reconstruction rather than claiming old runs had signed manifests.

`scripts/recover-archived-manifests.mjs <catalogue.json> <successor-plan.json>`
reverses a recorded migration plan against its verified successor backup. It
writes only to `.mazebench/recovered-manifests/`, and only when the reconstructed
bytes match an original manifest SHA-256 recorded in the run. Provenance receipts
retain the source/plan hashes. The catalogue automatically discovers these
recovered files; executing run manifests and checkpoints are never rewritten.
