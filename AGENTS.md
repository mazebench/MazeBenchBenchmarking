# MazeBenchBenchmarking Agent Instructions

## Repository roles

- This repository is the active MazeBenchBenchmarking implementation.
- The sibling `../MazeBenchEngineUnitTest` repository is the single source of
  truth for the C++ engine and its compiled WebAssembly binary.
- Do not hand-edit files under `engine/v1/core/` or
  `engine/v1/voxel_physics.wasm`. Update them through the sync command.
- World Solver acceleration is project-owned code under
  `world-solver/v1/native/`. Never add its exports to UnitTesting or to the
  synced `engine/v1` snapshot. `scripts/build-random-agent-v1.sh` compiles its
  wrapper against the currently synced engine source.
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
- rebuilds `world-solver/v1/random-agent.wasm` from the project-owned wrapper
  after the byte-identical engine copy is complete;
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
delay is 105 ms per engine frame (about 9.52 FPS). The Play sidebar can set the
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
the current room. If the authoritative engine trace stops at a room edge while
walking outward, retaining Ice momentum, or carrying punch momentum, it adds
only that neighboring room and reruns the same command from its original state.
Repeat this on later edge contacts so one command may visit a straight or
L-shaped chain of rooms without loading unrelated rooms.

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

The C++ engine accepts a rectangle, so an L-shaped temporary region represents
unvisited holes with synthetic solid boundary columns. These columns must never
be projected into room state or rendered. Do not eagerly combine a complete
row, column, or world: a room is attached only after the trace expresses intent
to cross its shared edge.

## Edge Finder and Random World Agent v1

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

The UI displays the full 256×256 grid. Reached room backgrounds are green,
every visited `(x,y)` pixel (dropping z) is yellow, and the most recent 50
distinct player positions fade from yellow toward red with the current pixel
red. It reports live actions/sec, directional actions, reached rooms, unique
gems, death undos, softlock teleports, and the current room. There is no saved
route graph, BFS database, invalidation tree, or playback UI in World Solver v1.

## ASCII overlap and face-fixture contract

The ASCII renderer resolves ordinary objects by exact `(x, y, z)` occupancy.
When multiple ordinary objects occupy one voxel, render only the deterministic
highest-priority object. A full occupant such as the player, a clone, a crate,
or a weightless body hides a button, gem, or other face fixture at that voxel,
but a floor or Ice surface remains rendered beneath the occupant at pitched
camera angles. Do not use source-array order as a visibility rule.

Buttons and lowered lifts are face fixtures rather than full cubes:

- an exposed Orange Button is light orange (`#ffb347`) and occupies a centered
  2x2 region of the 4x4 ASCII face;
- fixtures sharing a voxel remain independent when their orientations identify
  different faces; render each only when its mounted face is visible;
- a full occupant in the fixture's logical voxel hides every fixture there;
- a lowered lift renders on its mounted top or side face, while a raised lift
  remains a full cube; and
- a button can render over a lowered lift on the same face.

Objects marked `engineHidden`, hidden Orange Button states, and invisible
Orange Wall volumes never render. When an Orange Wall retracts completely under
a floor surface or into another solid, omit it so the covering surface is
exposed. Coincident visible Orange Wall records resolve deterministically.

Gate and puncher physics are now implemented upstream, including lowered/raised
gate states and unsprung/sprung puncher states. Their ASCII face-fixture rules
remain intentionally pending at the user's request; do not extend this contract
to them until the user resumes that renderer work.

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
