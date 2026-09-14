# MazeBenchBenchmarking Agent Instructions

## Repository roles

- This repository is the active MazeBenchBenchmarking implementation.
- The sibling `../MazeBenchEngineUnitTest` repository is the single source of
  truth for the C++ engine and its compiled WebAssembly binary.
- Do not hand-edit files under `engine/v1/core/` or
  `engine/v1/voxel_physics.wasm`. Update them through the sync command.
- World Solver acceleration is project-owned code under
  `world-solver/v1/native/`. Never add its exports to UnitTesting or to the
  synced `engine/v1` snapshot. `scripts/build-random-agent-v1.sh` and
  `scripts/build-editor-solver-v1.sh` compile its wrappers against the currently
  synced engine source.
- `engine/v1/adapter.mjs`, the public engine wrapper, Play Mode, input handling,
  and renderers belong to this repository and are not copied from UnitTesting.

## When the user says the UnitTesting engine was updated

1. Confirm `../MazeBenchEngineUnitTest` is committed and clean. Record its HEAD.
2. From this repository, run:

   ```sh
   node scripts/sync-engine-v1.mjs
   ```

3. Review the resulting diff, especially when the upstream public headers,
   `wasm_api.cpp`, role encoding, command state, or tick behavior changed.
4. Run the independent drift check and the complete target suite:

   ```sh
   node scripts/sync-engine-v1.mjs --check
   node --test tests/*.test.mjs
   ```

5. Report the full upstream commit, WASM SHA-256, source/native test result,
   source JS/WASM test result, and target test result.

The default source is the sibling checkout. If it moves, pass
`--source /absolute/path/to/MazeBenchEngineUnitTest` or set
`MAZEBENCH_UNIT_TEST_REPO`.

The source must be committed and clean. Do not bypass that safeguard by copying
files manually. If rebuilding the WASM makes UnitTesting dirty, stop and ask for
the rebuilt artifact to be committed there. If the ABI version, voxel stride,
or required exports change, do not force the update into engine v1; stop and
plan a new versioned adapter with the user.

## What the sync owns

`scripts/sync-engine-v1.mjs` performs the complete transport:

- rebuilds UnitTesting's WASM;
- runs UnitTesting's native C++ and JS/WASM engine suites;
- copies every Git-tracked file under UnitTesting's `engine/` byte-for-byte into
  `engine/v1/core/`, including additions and removals;
- copies the built `apps/web/public/physics/voxel_physics.wasm`;
- checks ABI v4, voxel stride 5, and the exports required by the target adapter;
- writes `engine/v1/upstream.json` and `engine/v1/upstream.mjs` with exact
  repository, commit, tree, file, and WASM provenance;
- rebuilds `world-solver/v1/random-agent.wasm` and
  `world-solver/v1/editor-solver.wasm` from their project-owned wrappers after
  the byte-identical engine copy is complete;
- refuses to overwrite a locally modified vendored snapshot; and
- runs the target engine integration tests.

`engine/v1/upstream.json` is the authority for the currently imported snapshot.
Do not preserve commit IDs or hashes in prose as a second source of truth.

The copied tests under `engine/v1/core/tests/` retain paths from UnitTesting and
are not the place to execute the upstream JS/WASM suite. The sync command runs
that suite in its original repository, where its application/WASM paths exist.

## Engine parity is not Play Mode parity

A successful hash check proves that the vendored C++ source and WASM are exact.
It does not prove that the two applications feel or behave identically. When a
subtle Play Mode difference is reported, audit these separately:

- UnitTesting adapter: `../MazeBenchEngineUnitTest/apps/web/app/physicsEngine.ts`
- Benchmarking adapter: `engine/v1/adapter.mjs`
- Benchmarking tick playback: `play/v1/play-session.mjs`
- camera-relative versus world-relative input mapping
- per-tick animation timing versus applying only a final engine state
- renderer scene reconstruction/interpolation
- role and mechanism-bit encoding, particularly hidden orange buttons/walls
- legacy or custom roles that the C++ engine does not implement; unknown roles
  may be represented as static blockers rather than their visual mechanic

Do not describe the whole applications as one-to-one merely because the engine
hashes match. State precisely whether parity refers to C++ source, WASM, adapter
serialization, command/tick playback, input, or rendering.

## Play animation timing

Play Mode presents each C++ engine tick as one animation frame. Its default
delay is 20 ms per engine frame (50 FPS). The Play sidebar can set the
frame delay directly in milliseconds. A delay of 0 ms is Instant mode: it skips
intermediate tick frames and renders only the command's final engine state.
Camera motion is independent and continues to use `requestAnimationFrame` at
the browser's display cadence.

Play history records only commands that change the canonical engine state or
move the player to another room. A blocked or otherwise ineffective command
must not create an undo snapshot or increment the move counter.

## Connected-world Play transitions

World topology and reset-on-leave policy belong to Play Mode, not the vendored
C++ source. `play/v1/connected-world-session.mjs` begins every command with only
the current room. An outward command from an edge, or an intermediate engine
frame reaching an edge with Ice or punch momentum, adds only that neighboring
room and reruns the same command from its original state. Inspect contacts in
time order: a temporary boundary can reflect a slope slide back into the room
or cause a cycle before the command ends. Ignore the cycle's rollback frame as
movement. Skip already attached rooms; if the neighboring geometry prevents
entry, retain the original trace and continue checking later edge contacts.
Repeat this so one command may visit a straight or L-shaped chain of rooms
without loading unrelated rooms.

Rooms attached during a command start from immutable authored data with their
authored player removed; the incoming player is the only player carried across
the seam. At completion, retain only the room containing the player and discard
all rooms that were left. Re-entering a discarded room therefore restores its
original objects. Connected-world animation frames may name different rooms;
`PlaySessionV1` must switch its active room before publishing each such frame
and must preserve the room identity, state, and room-scoped reset state in each
undo snapshot. Undoing a transition switches back to the previous room and
restores its exact pre-command state; ordinary forward re-entry still starts
from immutable authored room data.

Orange buttons control only the orange walls in their own room, including every
intermediate tick of a crossing. Combining room geometry must never combine its
control circuits. Settling a destination after projection is insufficient: a
neighboring button must not lower its walls even for one animation frame.

The C++ engine accepts a rectangle, so an L-shaped temporary region represents
unvisited holes with synthetic solid boundary columns. These columns must never
be projected into room state or rendered. Do not eagerly combine a complete
row, column, or world: a room is attached only after the trace expresses intent
to cross its shared edge.

## Edge Finder and World Solver v1

The canonical engine exposes an exact reachability API through
`search_edges`, `search_edge_count`, and `search_edge_solution`. It enumerates
boundary-reachable states without requiring a gem and preserves distinct
dynamic board states even when the player coordinates coincide. Keep ordinary
gem solving on `search_solve`. Edge Finder is editor-local and independent of
the Random World Agent.

`world-solver/v1/` is deliberately a simple random walk across the complete
256×256 pixel world, rooted at authored room H×I. It chooses only Up, Right,
Down, and Left. It retains exactly one reusable pre-action snapshot and invokes
undo only when that action kills the player. Every 10,000 directional moves it
teleports to a randomly selected reached room, using that room's latest visited
player coordinate and fresh authored room state, so a softlock cannot trap the
run forever.

The page-owned `native/random-agent-wasm.cpp` includes the synced canonical
`wasm_api.cpp` in its own translation unit and adds batching/world coordination
there. The resulting `random-agent.wasm` is separate from
`engine/v1/voxel_physics.wasm`; the canonical binary and all copied engine
source must remain byte-identical to UnitTesting. Ordinary floor-to-floor room
crossings, visit pixels, reached-room bits, gem identity, death rollback, and
teleports stay in the native batch. Complex Ice/punch/mechanism seams may stop
the batch and use `ConnectedWorldSessionV1` as the exact fallback.

The editor's gem solver also uses this project-owned wrapper so it can expose a
chunked search without changing the imported engine. Fast A* uses weighted
goal-distance ordering and an adjustable physics-interaction bias. Bias 0 is
off; a positive value explores commands that move non-player bodies or change
mechanisms sooner, with at most three interaction credits per command. Because
that bias and the weighted heuristic affect ordering, its returned route is
explicitly not a shortest-route proof. Exact Shortest always forces both
weights to zero and retains uniform-cost shortest-command semantics. The editor
reports global board states/sec and attempted engine command simulations/sec
live for both modes.

The Random Agent UI displays the full 256×256 grid. Reached room backgrounds are green,
every visited `(x,y)` pixel (dropping z) is yellow, and the most recent 50
distinct player positions fade from yellow toward red with the current pixel
red. It reports live actions/sec, directional actions, reached rooms, unique
gems, death undos, softlock teleports, and the current room. There is no saved
route graph, invalidation tree, or playback UI in World Solver v1.

Exact BFS, DFS Meta, Super A*, and Row A* are the deterministic World Solver modes. They start at H×I and use the
canonical search engine's compact dynamic-entity representation with a
project-owned reachability loop. Exact BFS, DFS Meta, and Super A* collapse
ordinary player reachability into a local BFS for each global board
configuration. The UI paints reachable
player `(x,y)` pixels yellow on the full 256×256 world and boundary exits cyan.
An open or actively searched room uses the yellow map palette. The same room
changes atomically to orange when its search completes or its exact frontier is
exhausted, and its red current-position marker is removed. A closed orange room
must never receive another red marker unless a future search phase genuinely
reopens it and first changes its status back to yellow.
Throughput must report attempted engine commands per second separately from
local state visits per second.

Exact BFS finishes the current room before dequeuing another reached room. DFS
Meta instead stops the native room loop when a new boundary entrance is exposed,
copies only the compact room BFS frontier into page-owned storage, immediately
searches the new room, and rebuilds/resumes the exact parent frontier during
backtracking. It must not discard a partial room search, restart it from its
authored root, or modify the canonical engine to support this orchestration.

Super A* retains the local player BFS but orders global dynamic-board states by
weighted `f = g + 3h`, where `h` is Manhattan distance to the nearest remaining
gem or boundary leading to an undiscovered room. Its page-owned global
portfolio allocates bounded search slices across room-entry jobs, favoring
shallower jobs and rooms with remaining authored gems without letting one hard
room monopolize the worker. A new outlet adds its reset neighboring room to the
portfolio immediately; a collected gem reprioritizes continuation states in the
same exact room graph. Deduplicate room jobs by first entrance and board states
by the native compact-state hash. Super A* is a discovery-throughput heuristic,
not a shortest-route proof.

Row A* is deliberately gem- and exit-agnostic. For each vertical player row it
actually reaches, it uses the original project-owned weighted A* search to
cover every unvisited standable `(x,y)` surface derived from immutable
floor, solid wall, Ice, and Ice-slope geometry;
an immutable surface covered by another immutable block is not a target. Room
edges create neighboring-room work only when encountered incidentally. Gems are
still counted when incidental traversal collects them but never affect the
heuristic. Floating floors do not trigger a BFS fallback: every position they
occupy in an encountered dynamic board state extends the Row A* target
landscape. A room job finishes when all targets on its discovered rows have been
visited or when its exact command-state frontier is exhausted. Every boundary
candidate must run the outward command against the connected neighboring room
before it counts as an entrance. Deduplicate the resulting neighbor state, not
just its player coordinate or room name; boundary states already covered by
that room are duplicates. A distinct alternate entry reopens an orange room,
turns it yellow, and starts another room job; a duplicate leaves it closed. Do
not replace this search with the editor Fast A* wrapper or add editor
physics-bias controls to World Solver.

The connected-room test command and native Row A* share one physics workspace.
After every connected edge simulation, call the project-owned Row A* workspace
restore export before continuing its frontier. Otherwise the next search slice
uses the temporary multi-room terrain cache and can falsely report exhaustion;
G×F is the regression fixture for this failure.

Exact BFS, DFS Meta, and Super A* still use the first room entrance until their
orchestration is migrated to the same alternate-entry queue. Do not silently
describe those legacy modes as having Row A*'s re-entry closure.

## ASCII overlap and face-fixture contract

The ASCII renderer resolves ordinary objects by exact `(x, y, z)` occupancy.
When multiple ordinary objects occupy one voxel, render only the deterministic
highest-priority object. A full occupant such as the player, a clone, a crate,
or a weightless body hides a button, gem, or other face fixture at that voxel,
but a floor or Ice surface remains rendered beneath the occupant at pitched
camera angles. Do not use source-array order as a visibility rule.

Buttons, lowered lifts, and lowered gates are face fixtures rather than full cubes:

- an exposed Orange Button is light orange (`#ffb347`) and occupies a centered
  2x2 region of the 4x4 ASCII face;
- fixtures sharing a voxel remain independent when their orientations identify
  different faces; render each only when its mounted face is visible;
- a full occupant in the fixture's logical voxel hides every fixture there;
- a lowered lift renders on its mounted top or side face, while a raised lift
  remains a full cube; and
- a button can render over a lowered lift on the same face.

Lowered gates render as flat plates on their mounted faces, yield to occupants,
and allow a button on the same face to remain visible. Raised gates render as
full cubes. A top-down gate uses `y` when lowered and `Y` when raised; raised
side faces use `y`. This retains the existing hidden-name glyph mapping.

Objects marked `engineHidden`, hidden Orange Button states, and invisible
Orange Wall volumes never render. When an Orange Wall retracts completely under
a floor surface or into another solid, omit it so the covering surface is
exposed. Coincident visible Orange Wall records resolve deterministically.

Gate and puncher physics are implemented upstream. Gate ASCII rendering now
reflects lowered/raised states. Puncher ASCII face-fixture rules remain pending
at the user's request; do not extend this contract to punchers until requested.

## 3D room context

Play Mode's 3D view and the editor render the active room at full brightness
with the surrounding 3x3 neighborhood as dimmed spatial context. Neighbor rooms
use immutable authored data, do not participate in Play physics, and are not
paintable or selectable in the editor. The active room stays centered even at
the edge of the world. Play suppresses the neighboring rooms' authored player
objects so only the actual active player is shown. Do not render the entire
256-room world in these live views: it contains roughly 95,000 authored objects
and would be rebuilt during animation and editing. ASCII Mode remains room-local.
Mouse-wheel and trackpad scrolling must not zoom any 3D view; zoom remains
available through Q/E and the explicit map zoom buttons.

## Scope and Git safety

When asked to "sync the engine," the expected scope is the local rebuild,
verification, vendored update, provenance update, and tests described above.
Do not commit, push, or modify UnitTesting application/UI files unless the user
explicitly requests those actions.

## Benchmark checkpoint storage

New and migrated benchmark runs use authenticated incremental checkpoints.
`game-state.json`, `summary.json`, and `display.json` may be format markers.
Read them with `readCheckpointJson` from `benchmarking/v1/checkpoint-json.mjs`,
not raw `JSON.parse(readFile(...))`. The atomic signed checkpoint and its journal
are authoritative; keep complete journal generations with any copied run.

Before a bulk rollback or engine/level repair, follow
`benchmarking/storage/README.md`. Historical one-off repair scripts predate this
format and must be adapted before use on migrated runs. Do not overwrite marker
files or authorize unrelated asset changes while resealing a run. Preserve its
model, tool condition, prompt, conversation identity, and game history.

## Live authored-room updates

New MazeBench ASCII and vision runs use `next-entry-v1`. The editor's validated
PUT route publishes signed per-run room revisions under `world-updates/`.
Unvisited rooms use the latest published revision; previously visited rooms do
so on fresh physical entry or an explicit room command. The active board, reset
state, and undo snapshots retain their original authored version until then.
A room command always creates the room's authored starting board and player
position, including when targeting the current room. Never use a saved physical
entry position as the spawn. Reject rooms without an authored player rather than
inventing a fallback spawn. Reset restores the current visit's entry state, and
undo restores the exact previous board and entry state.

Room files edited outside the editor are not published automatically. Open and
save the room in the editor to publish it. Engine code, block definitions and
world topology remain frozen. Never bypass those checks or expose revision
files, signing keys, or the publishing interface to benchmark agents. Historical
ASCII/vision frames remain immutable. Room edits and the authored revisions used
by actions are audited; moving or removing an existing gem preserves its identity.

Existing runs require the exact-hash, paused operator migration in
`scripts/enable-live-world-updates.mjs`. Preserve all preexisting game state and
settings. Do not silently reseal unrelated prior engine or level drift.
