# Shared C++ physics engine

This directory is the platform-independent source of truth for game physics.

- `include/voxelbench`: public API shared by native and WebAssembly builds
- `src/physics.cpp`: small optimized translation-unit facade
- `src/physics/`: focused workspace, object, movement, tick, and simulation modules
- `src/wasm_api.cpp`: thin browser ABI only
- `tests`: native C++ and WebAssembly regression tests
- `benchmarks`: fixed-workload performance baselines

The future iOS/macOS application should link this library directly. The web app
uses the same core compiled to WebAssembly.

## Command and animation API

`step_tick(workspace, state, voxels, ...)` advances one observable command
tick and returns `kMore` until the world is stationary. The caller owns both
`PhysicsWorkspace` and `MotionState`; this keeps A* workers independent and
allows an in-progress command to be saved or transferred without relying on
process-global movement flags.

`simulate_command(workspace, state, voxels, ..., observer)` is the stationary
state API. It resets the supplied `MotionState`, repeatedly calls `step_tick`,
and optionally sends every post-tick frame to an observer. Search code should
expand only its final state, while games and editors can render or compare the
same returned trace. `simulate_turn` remains as a final-state compatibility
wrapper.

The WebAssembly ABI exposes the same lifecycle as `reset_command`,
`step_command_tick`, and `command_tick`. Its motion-state buffer is explicit so
future save-game and replay formats can persist a partially completed command.

Current authored tests define gravity settlement as part of a horizontal tick;
Ice continuation produces additional ticks. If future fixtures require each
vertical cell to be a separate visible tick, that cadence can be tightened in
`step_tick` without changing either public API.

The `floor` role is intentionally distinct from ordinary solid support: a
player may deliberately walk off a floor edge, but cannot deliberately walk
off other support. Ice momentum may carry it beyond any support.

After every physics change, run the repository-level test suite. A change is
not complete until all native, WebAssembly, rotation, and web regression tests
pass.

`npm run benchmark:physics` builds the native benchmark with release LTO and
the host CPU instruction set. Its `flat_single_push_ice_lane` workload restores
the two dynamic voxels in a prepared eight-voxel scene, calls the public
`simulate_turn` API, and consumes the result. A second
`prepared_passive_floor_step` workload measures the generalized player-only
evaluator used by exact search. Neither is an empty engine-only loop.
