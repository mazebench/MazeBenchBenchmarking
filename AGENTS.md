# MazeBenchBenchmarking Agent Instructions

## Repository roles

- This repository is the active MazeBenchBenchmarking implementation.
- The sibling `../MazeBenchEngineUnitTest` repository is the single source of
  truth for the C++ engine and its compiled WebAssembly binary.
- Do not hand-edit files under `engine/v1/core/` or
  `engine/v1/voxel_physics.wasm`. Update them through the sync command.
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

## ASCII overlap and face-fixture contract

The ASCII renderer resolves ordinary objects by exact `(x, y, z)` occupancy.
When multiple ordinary objects occupy one voxel, render only the deterministic
highest-priority object. A full occupant such as the player, a clone, a crate,
or a weightless body hides a button, gem, or other face fixture at that voxel.
Do not use source-array order as a visibility rule.

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

Gate and puncher face-fixture behavior is intentionally pending. Do not extend
this contract to them until the user says their engine behavior is implemented.

## Scope and Git safety

When asked to "sync the engine," the expected scope is the local rebuild,
verification, vendored update, provenance update, and tests described above.
Do not commit, push, or modify UnitTesting application/UI files unless the user
explicitly requests those actions.
