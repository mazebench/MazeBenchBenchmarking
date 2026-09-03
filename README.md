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
- `benchmarking/v1/` — local Codex benchmark runner with a read-only records MCP interface, optional isolated Python workspace, and live evaluation charts
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

Open `/benchmarking/v1/` to run locally authenticated Codex models against the
same engine and H×I start. Every condition receives `maze_observe`,
`maze_action`, and `maze_sequence`; tools-on runs additionally receive
`python_exec` in a preflighted persistent workspace. `maze_observe` is the only
agent-facing reader for current state and the run's allowlisted read-only
records. Authoritative results are stored under
`~/records/mazebench-benchmark/` and are never exposed to Python.
Every launch starts from a deny-all Codex feature inventory and uses a frozen,
hashed per-run model catalog that forces direct MCP tool calls. Both
Node/JavaScript hosts and their in-process fallback are disabled, and the
launcher refuses untested Codex CLI versions. The only executable agent code is
a saved `.py` file run by `python_exec` inside `/workspace`; tools-off runs have
no code executor or writable agent directory. Runs created before this boundary
cannot be resumed.
The benchmark landing page is the launcher and agent-record library; each
record opens a dedicated live model report with the engine's colored ASCII
frame, heatmap, novelty trace, activity, and workspace inventory. A run can be
paused or stopped and then resumed from its existing Codex thread while the
game remains nonterminal. The record page can also create any number of
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
