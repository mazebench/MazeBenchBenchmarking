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
- `ice-maze/v1/` — World 2: the original 30 numbered Ice Maze puzzles, with independent 2D sliding rules
- `level-data/ice-maze/v1/` — answer-free boards in original order and source provenance
- `benchmarking/worlds/` — sequential-world routing, prompt, and attested MCP adapters
- `slotski/v1/` — World 3: one classic sliding-block puzzle, shared human/benchmark rules
- `level-data/slotski/v1/` — the starting board, with permanent block labels and no solution
- `benchmarking/slotski/` — Slotski prompt, world routing, and restricted provider/MCP adapters
- `play/v1/` — play mode v1, driven by the engine's resumable per-tick command trace
- `benchmarking/v1/` — shared game/MCP boundary and the frozen Codex runner
- `benchmarking/providers/` — Claude Code adapter and provider routing; `benchmarking/ui/` contains the current dashboard modules
- `benchmarking/grok/` — Grok Build 4.7 subscription adapter, isolated profile, MCP gate, and event boundary
- `editor/v1/` — editor v1 with face-mounted objects, 3D toolbox previews, Fast A*, and Exact Shortest gem solvers
- `scripts/migrate-v1-to-v2.mjs` — deterministic v1 text to v2 object migration
- `index.html` — the single page entry point

There is no framework, package manager, or build step in this repository. The vendored runtimes are the source repository's exact Three.js version (`0.184.0`) and the UnitTest repository's byte-identical 395 KB engine-v1 WebAssembly build. The C++ engine is not rewritten in JavaScript.

## Prime Intellect environment

The installable Main World ASCII environment is in
[`environments/mazebench/`](environments/mazebench/README.md). It uses the game
runtime and engine from this repository with Verifiers' standard Taskset/Toolset
API and stock Prime Agent harness. That package documents installation,
evaluation, tests, and publishing to `mazebench/mazebench` on the Environments Hub.
It includes tools-on (stock Prime Agent) and tools-off (stock MCP chat harness)
presets, with the existing 100-gem win condition preserved in both.

## Run the local site

The browser must load the level files over HTTP:

```sh
node server.mjs
```

Then open <http://localhost:8080>.

After a server interruption, a run whose saved status still says running or
continuing is displayed as **interrupted** when the server has no active runner.
Use **Resume** to continue its existing conversation and checkpoint. Recovery
checks for a surviving process and verifies the run's integrity before resuming.

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

Open `/benchmarking/v1/` to select Codex, Claude Code, or Grok Build and run locally authenticated models against the
selected world. Main World starts at H×I and targets 100 gems; Ice Maze starts at level 1 and targets all 30 levels in order; Slotski has one sliding-block puzzle. Every condition receives `maze_observe`,
`maze_action`, and `maze_sequence`; tools-on runs additionally receive
`python_exec` in a preflighted persistent workspace. `maze_observe` is the only
agent-facing reader for current state and the run's allowlisted read-only
records. Authoritative results are stored under
`~/records/mazebench-benchmark/` and are never exposed to Python.
Every Codex launch disables agent capabilities from the Codex feature inventory,
uses the current authenticated compaction transport for long conversations, and uses a frozen,
hashed per-run model catalog that forces direct MCP tool calls and disables
model-metadata overrides for shell, patching, delegation, and tool search. Both
Node/JavaScript hosts and their in-process fallback are disabled. The launcher
refuses untested Codex CLI versions and records the exact executable hash.
The launcher displays the installed CLI version, checks OpenAI's stable-release
endpoint, and distinguishes an available update from a benchmark-tested build.
Run `codex update` to update the CLI, then restart this server; an untested
release remains blocked until the capability checks pass and the version pin
is deliberately updated.

Claude Code uses the existing `claude auth login` session. Versions 2.1.258 and
2.1.280 are admitted after real-CLI capability checks; 2.1.280 adds the explicit
`claude-opus-5-5` route. Select an explicit model version and
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

Grok Build uses the existing `grok login` grok.com subscription session. Version
1.0.40 and `grok-4.7` are admitted for Main World ASCII runs, with low through
xhigh reasoning. Each run receives a private Grok home outside the benchmark
record, containing a copied OAuth state and a frozen configuration. Personal
instructions, plugins, skills, memories, project configuration, web search,
subagents, shell and filesystem tools are excluded. Grok's only model-visible
built-ins are its `search_tool` and `use_tool` MCP gateways; the harness checks
every discovery result and invocation against the one `mazebench` server and
its exact condition-specific tool list. Model fallback, extra servers/tools,
file-backed MCP calls, delegation, or server-side web use permanently invalidate
the run. Grok Build 1.0.40's native macOS sandbox currently fails to initialize
on this host because `/var/run/docker.sock` is a symlink, so the CLI profile is
off; this does not grant a model executor because the built-in catalog is
verified as gateway-only. Tools-on Python still runs under MazeBench's separate
mandatory Seatbelt sandbox and can write only its run workspace.

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
MazeBench novelty compares the current room and its board configuration, ignoring
gem objects, global gem collection progress, camera angle, and object-array order.
The same configuration before and after collecting a gem therefore counts once.
Novelty uses a separate fingerprint; the complete game-state hashes and signed
checkpoints still retain gems and score. Historical analytics require an audited
recalculation before an older MazeBench checkpoint can resume. The rolling trace
uses all recorded actions, so camera-only actions contribute no new state.
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

## Ice Maze — World 2

Open `/ice-maze/v1/` to play the 30 original puzzles recovered from
MazeBenchSite's `games/ice_maze/level_list.json`. The numbered selector supports
practice, undo/reset, arrow keys, WASD, swipe, and browser-local best-move progress.
The source repository, commit, and SHA-256 hashes are recorded in
`level-data/ice-maze/v1/provenance.json`.

All players move together in each chosen direction, sliding until a wall, the
board edge, or another player stops them. Goals are slippery; they must all be
covered at once after the players stop. Players already on goals still move.
This is a separate 2D rules engine; the canonical voxel engine is unchanged.

Select **Ice Maze · 30 levels** at `/benchmarking/v1/?world=ice-maze` for
Codex or Claude Code, with Python on or off. Benchmarks must start at level 1.
A completed puzzle allows only `next`; the run wins after level 30. Every
accepted action, including blocked movement, undo, reset and next, costs one
action. Sequences stop on puzzle completion or after next and cannot spill into
the next board. Undo/reset never refund benchmark actions. Benchmark progress is
independent of human practice progress.

Agents receive only the current board and their own recorded observations;
original solution paths and solver metadata are not imported. The existing
provider tool restrictions and OS-isolated Python executor are retained. Ice
Maze code, board data, provider selection, prompt, CLI binary, and run
configuration are frozen; the engine signs state and scores. The three maze
MCP tools expose no arbitrary file reads or level selection. Every accepted move
has a numbered read-only frame, including the initial move 0. The benchmark
report shows levels solved, current level, replay, usage and cost telemetry.
Interview forks are not implemented for Ice Maze.

Validate the source import (requires the sibling MazeBenchSite checkout):

```sh
node scripts/import-ice-maze.mjs --check
node --test tests/ice-maze.test.mjs
```

The importer replays the source solutions transiently to verify rules parity,
then writes board data only. The test suite independently solves all 30 boards
with simultaneous cell stepping and verifies sequence boundaries, scoring,
record access, tool catalogs, CLI restrictions, and tamper rejection.

## Slotski — World 3

Open `/slotski/v1/` for human play or select **Slotski · 1 level** at
`/benchmarking/v1/?world=slotski` for Codex or Claude Code, with Python on or off.
The launcher defaults to 1,000 actions for this puzzle; unlimited is also available.
No agent is started by opening the page.

The classic 4×5 board has ten permanently labelled rectangles, A–J. A is the
2×2 target. Move it to the bottom-center 2×2 area (top-left coordinate `(1, 3)`)
to win; the harness does not require an extra off-board action. Each move shifts
one chosen block one cell, with no pushing, overlap, or rotation. The input
parser supports A–Z and rejects labels absent from the board.

- `maze_action({action: "block A move up"})` or `{action: "AU"}`
- `maze_sequence({sequence: "AU BD CL"})` or `{sequence: "a up, b down c left"}`
- `maze_sequence({sequence: "AU3"})` or `{sequence: "a up 3 times"}`
- `maze_sequence({actions: ["AU3", "BD", "CL"]})`

Sequences are validated before any move and expand to at most 1,000 one-cell
actions. Blocked moves, undo, and reset all spend benchmark budget. Each step
has its own signed action entry and before/after ASCII animation records.
Novelty uses only labelled block positions. The move heatmap records the chosen
block's top-left cell; undo/reset record A's position. Human play counts changed
moves and lets undo reduce that display counter, like the other human worlds.

The agent prompt is `benchmarking/slotski/EVAL-PROMPT.md`. The adapters preserve
the existing CLI tool allowlists and Python isolation, pin the game rules,
starting layout and prompt, and authenticate saved states and scores. There are
no hint, solve, teleport, arbitrary-file or state-setting MCP tools. The
independent solvability search exists only in `tests/slotski.test.mjs`; no
solution is stored in the world assets or supplied to an agent. Existing worlds'
attested runtime files are unchanged. Restart the local server to load the new
world router, after pausing any active agent runs.

Run `node --test tests/slotski.test.mjs` for rules, parsing, launch/resume,
checkpoint integrity, and real MCP checks in both Python modes.
