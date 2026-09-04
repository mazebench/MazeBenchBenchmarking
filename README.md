# MazeBench benchmarking — renderer, engine, play, and editor v1

A deliberately small localhost site that renders the complete MazeBench main world, plays rooms through the copied C++ engine, and includes a versioned 3D editor with engine-backed solvers.

## What is here

- `level-data/v1/main-world/` — the original 256 text levels and `world_map.json`, unchanged
- `level-data/v2/main-world/` — the active palette-compressed explicit 3D-object rooms
- `render/v1/world-renderer.mjs` — level text parsing and token definitions
- `render/v1/voxel-world-v2.mjs` — the lightweight v2 storage codec and object catalog
- `render/v1/voxel-scene-v2.mjs` — the v2 object-to-renderer adapter
- `render/v1/polycube-mesh.mjs` — connected voxel faces and boundary-only edges
- `render/v1/piece-definitions.mjs` — cube, plate, slope, button, puncher, and lift visual definitions
- `render/v1/special-piece-renderers.mjs` — non-asset special geometry and lift triangles
- `render/v1/asset-renderers.mjs` — authored GLB loading plus the exact gem-shaped fallback
- `render/v1/three-renderer.mjs` — the version 1 scene and input controller
- `render-ascii/v1/` — MazeBench's colored five-pitch ASCII observation renderer, dynamic Unicode identities, and seeded hidden-glyph contract
- `engine/v1/core/` — unchanged copied C++ engine source, headers, tests, and benchmarks from MazeBenchEngineUnitTest
- `engine/v1/voxel_physics.wasm` — the exact copied UnitTest release engine; physics and exact search live here
- `engine/v1/engine.mjs` — the small storage-v2/browser ABI boundary
- `play/v1/` — play mode v1, driven by the engine's resumable per-tick command trace
- `benchmarking/v1/` — shared game/MCP boundary and the frozen Codex runner
- `benchmarking/providers/` — Claude Code adapter and provider routing; `benchmarking/ui/` contains the current dashboard modules
- `editor/v1/` — editor v1 with face-mounted objects, 3D toolbox previews, Fast A*, and Exact Shortest gem solvers
- `scripts/migrate-v1-to-v2.mjs` — deterministic v1 text to v2 object migration
- `index.html` — the single page entry point

There is no framework, package manager, or build step in this repository. The vendored runtimes are the source repository's exact Three.js version (`0.184.0`) and the UnitTest repository's byte-identical 395 KB engine-v1 WebAssembly build. The C++ engine is not rewritten in JavaScript.

## Run it

The browser must load the level files over HTTP:

```sh
node server.mjs
```

Then open <http://localhost:8080>.

The small local server also provides the editor's narrowly scoped save endpoint and serves WebAssembly with its required MIME type. The active editor writes only the 256 JSON rooms listed in the v2 manifest, validates their object data, and keeps every room exactly 16×16. The v1 text save route remains available only for compatibility.

Open `/world-solver/v1/` for Exact BFS, DFS Meta, Super A*, Row A*, and the
native batched Random World Agent. Exact BFS finishes each room before opening the
next one. DFS Meta keeps the same exact room BFS but suspends it as soon as an
undiscovered-room entrance appears, explores that room first, and later resumes
the saved parent frontier. Super A* uses weighted `g + 3h` ordering toward the
nearest remaining gem or undiscovered boundary and fairly time-slices every
active room search in a global portfolio. All three reset newly reached rooms
and use their first entrance. Row A* is gem- and exit-agnostic: it targets every
open immutable floor, wall, Ice, and Ice-slope surface on each reached vertical
row, while dynamically adding encountered floating-floor positions. A room
finishes when its reached-row targets are covered or its frontier is exhausted.
Row A* validates an edge by executing the outward command into the connected
neighbor and deduplicates the resulting room-entry state against entry and
boundary states the room already covered. A new alternate entry reopens an
orange room as yellow; a duplicate entry is ignored. Search-mode rooms are
yellow while open and turn
orange once searched or exhausted; the live red position is never drawn in a
closed orange room.

Open `/benchmarking/v1/` to select Codex or Claude Code and run locally authenticated models against the
same engine and H×I start. Every condition receives `maze_observe`,
`maze_action`, and `maze_sequence`; tools-on runs additionally receive
`python_exec` in a preflighted persistent workspace. `maze_observe` is the only
agent-facing reader for current state and the run's allowlisted read-only
records. Authoritative results are stored under
`~/records/mazebench-benchmark/` and are never exposed to Python.
Every Codex launch disables agent capabilities from the Codex feature inventory,
keeps remote compaction v2 enabled for long conversations, and uses a frozen,
hashed per-run model catalog that forces direct MCP tool calls and disables
model-metadata overrides for shell, patching, delegation, and tool search. Both
Node/JavaScript hosts and their in-process fallback are disabled. The launcher
refuses untested Codex CLI versions and records the exact executable hash.
The launcher displays the installed CLI version, checks OpenAI's stable-release
endpoint, and distinguishes an available update from a benchmark-tested build.
Run `codex update` to update the CLI, then restart this server; an untested
release remains blocked until the capability checks pass and the version pin
is deliberately updated.

Claude Code uses the existing `claude auth login` session. Version 2.1.258 is
admitted after real-CLI capability checks. Select an explicit model version and
Python on/off, or launch a matched pair. The runner removes all built-in tools,
ignores personal/project settings and CLAUDE.md, disables skills and memory,
and loads only the MazeBench MCP with `dontAsk` permissions and an exact tool
allowlist. Python is provided through the same OS-isolated MCP executor as
Codex, never Claude's Bash tool. Provider source files and the CLI executable
are frozen in each Claude run's manifest and checked before every MCP request.
Unknown tools or model fallback invalidate the run. The installed version and
authentication status are shown in the launcher; untested versions fail closed.
See [Claude's CLI reference](https://code.claude.com/docs/en/cli-reference) for
the supported restriction flags and [model configuration](https://code.claude.com/docs/en/model-config)
for versioned model IDs and account availability. Run the offline provider check
with `node scripts/check-claude-capabilities-v1.mjs` before admitting another build.

Python runs saved `.py` files in a persistent workspace using a mandatory macOS
Seatbelt profile installed before agent code starts. Private files, network,
IPC, subprocess creation, and exec remain denied even if Python's audit hook
is replaced or native functions are called. Host-side script writes and file
inventories reject links. Tools-off runs have no code executor or writable agent
directory; interviews expose no tools. Codex's generic MCP resource helpers
remain present in benchmark turns, but this server publishes no resources and
rejects every resource URI.

All new runs freeze their model, reasoning effort, condition, prompt, executable,
runtime, engine, and world assets. Authenticated checkpoints protect state and
score across continuations. Unexpected tools or integrity changes invalidate a
run. Earlier runs remain readable and available for interviews, but cannot
resume under the current boundary. Failed records show the service error and
offer a new run with the same settings. Known compaction transport failures can
resume the existing conversation after integrity validation; the affected
September 4 build has a narrowly scoped, audited operator repair. See [the integrity policy](benchmarking/v1/SECURITY.md)
for the threat model and upgrade checks.
The benchmark landing page is the launcher and agent-record library; each
record opens a dedicated live model report with the engine's colored ASCII
frame, heatmap, novelty trace, activity, and workspace inventory. A run can be
inspected with a context-token timeline, compaction trigger and checkpoint
markers, and cumulative input/output/cached-token totals. Its USD estimate uses
published Standard API rates (dated in the UI), cache discounts, cache-write
rates, and each request's context tier, including reported compaction usage;
it is an API-equivalent estimate, not a ChatGPT subscription bill. Claude totals
include cache reads and writes once; its cost is reported by Claude Code for
completed turns, with the active turn pending. Claude context usage and
compaction events are charted, but no trigger line is invented when the CLI
does not report its compaction threshold. Replay starts at 30 ms per frame.
A run can be paused or stopped and resumed from its existing provider session
while the game remains nonterminal. Codex record pages can also create any number of
isolated interview branches at the current move, accept free-form questions,
and end chats without changing the benchmark thread or authoritative results.
They report command speed, state visits, rooms, and collectible gems on the full
256×256 grid. Random Agent paints visits on that same grid, reports live speed,
rooms, gems, and death undos, and teleports every 10,000 moves to escape
softlocks. Their accelerator is owned by
`world-solver/v1/` and rebuilds against the byte-identical imported engine
without changing `engine/v1`.

Open play mode at <http://localhost:8080/play/v1/> or the editor at <http://localhost:8080/editor/v1/>. In play mode, `M` swaps between the same live engine state in 3D and ASCII. ASCII uses `A`/`D` for its four cardinal headings and `W`/`S` for MazeBench's five views from top-down through side-on.

The editor's Fast A* mode runs through the project-owned native wrapper and can
favor box/mechanism-changing commands with a configurable physics interaction
bias (`0` disables it). Exact Shortest forces that bias and the heuristic to
zero. Both modes display live global board states/sec and attempted engine
command simulations/sec;
Fast A* routes are deliberately marked unproven, while Exact Shortest reports a
proof only when it solves before physical WebAssembly memory is exhausted.

## Level storage versions

Storage versions are independent from renderer versions. Renderer v1 loads storage v2 by default.

- V1 is the exact legacy text representation. It stays under `level-data/v1/` for compatibility and migration checks.
- V2 stores each object at an explicit integer `x`, `y`, and `z` coordinate. Palette entries carry `blockId` plus optional orientation, state, variant, group, mechanism, and instance metadata. That permits stacks, multiple objects in one cell, and objects mounted to top, bottom, or side faces.

Regenerate v2 from the preserved v1 source with:

```sh
node scripts/migrate-v1-to-v2.mjs
```

## Source

The level data, authored GLB assets, parser/color conventions, and connected-component mesh/edge behavior used by renderer v1 come from [`mazebench/MazeBenchEngine`](https://github.com/mazebench/MazeBenchEngine), branch `several-fixes`, commit `bac6efc9aef6cbf0812c4a57dccb1ad67a15c9ea`. The v2 compact object format, occupancy rules, face-normal placement behavior, unchanged C++ engine, and exact solver come from the local `MazeBenchEngineUnitTest` repository. The exact imported engine commit and hashes live in `engine/v1/upstream.json`; use `node scripts/sync-engine-v1.mjs` for future updates. Its React application and dashboard are intentionally excluded.

Only the 256 files referenced by the main world's 16×16 `world_map.json` are included. The source repository's `old/` and `other/` level fixtures are intentionally excluded.

## Add another renderer

Put alternate implementations in sibling version directories such as `render/v2/` or `render-ascii/v2/`. Both renderer families keep v1 self-contained and expose a version constant.
