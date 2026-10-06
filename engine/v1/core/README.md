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

Each returned frame is one discrete tick. Horizontal continuation and gravity
advance by one cell on their respective axes; slope moves may combine axes.
The authored timeline length, every intermediate frame, and the exact global
cycle interval are part of the contract, not just the final arrangement.

The `floor` role is intentionally distinct from ordinary solid support: a
player may deliberately walk off a floor edge, but cannot deliberately walk
off other support. Ice momentum may carry it beyond any support.

Entering an Ice ramp sideways from level terrain requires existing sliding
momentum. The entry tick stays at the same elevation; the next tick turns
downhill and follows the ramp. A deliberate step remains blocked from the
side, even when the player is standing on Ice. This exception does not bypass
solid occupants or change the ramp's low-edge entry restriction.

Uphill momentum may push a stationary weightless-box chain at a ramp's crest,
including boxes on non-Ice support. A blocked chain still reflects downhill;
flat-Ice momentum alone does not gain this push. Feasibility uses the same
whole-polycube elevation calculation as the transaction and fixed workspace
bitsets, without recursive searches or per-tick allocations. A level external
foot prevents a long or tall polycube from descending through its support;
unsupported overhangs do not count as extra feet.

Ramp momentum can also push one Floating Floor at a crest or downhill exit.
The floor must keep destination support, except for the existing Row-0 hole
fill. An unsupported high push reflects at the crest instead of stalling there.
This uses the same contact closure and one ordinary-body weight budget as
deliberate pushes; it does not enable ordinary crates or flat-Ice impacts.

Carried riders retain their carrier relationship throughout a simultaneous
tick; promotion into the moving set does not give them independent momentum.
If the carrier stops on non-Ice support, its rider stops too. A player vacating
another cell beneath that rider is not a stationary foothold. These rules do
not depend on whether an unrelated ramp exists elsewhere in the room. Carrier
impulse scratch is reset when a workspace starts or rebuilds a command.

A loose passenger blocked by terrain stays behind without cancelling the
carrier's push; passengers above it stay with that stopped support too. If the
carrier completely vacates its support, the blocked passenger starts descending
on the next tick, not during the push. A blocked rigid mounted fixture still
anchors its carrier. Unrelated ramps do not change these collision rules.

A player standing on a separate body may push a wrapping polycube when the
push chain also moves that supporting body. The complete push must validate
before anything moves; a stationary support still forbids stepping off its
ledge, and an obstruction anywhere in the chain blocks the push.

Floating Floors prevent a same-level player or clone from raising a gate
occupied by that floor, just like crates and weightless boxes. Pushing the
floor into or through the lowered plate adds no mechanism tick. Once the
player leaves the unoccupied plate, normal delayed gate activation resumes.

After every physics change, run the repository-level test suite. A change is
not complete until all native, WebAssembly, rotation, and web regression tests
pass.

Run `npm run test:physics:sanitize` for native address/undefined-behavior
checks as well. It stops on the first diagnostic, including invalid array
accesses that may not affect observable expectations in an optimized build.

## Internal module map

The `.inc` files remain one optimized translation unit. Splitting their source
does not add virtual dispatch, heap allocations, or a separate physics engine.

| Module | Responsibility |
| --- | --- |
| `workspace.inc`, `objects.inc` | Workspace-owned scratch storage, spatial indexes, rigid body membership |
| `motion_support.inc` | Carrying, independent support, interlocking support graphs |
| `gravity_motion.inc`, `gravity_queries.inc` | One-cell falling and order-independent quiescence checks |
| `translations.inc` | Rigid translations and rider movement |
| `slope_geometry.inc`, `slope_proposals.inc`, `slope_motion.inc` | Contact geometry, whole-body proposals, simultaneous slope motion |
| `lifts.inc`, `gates.inc`, `punchers.inc`, `orange_mechanisms.inc` | Mechanism-specific transitions |
| `command_state.inc`, `passive_commands.inc` | Command state and prepared quiescent evaluation |
| `tick.inc`, `simulate.inc`, `cycle*.inc` | Tick orchestration, stationary-state API, complete-world cycle detection |

`movement.inc` is an include-only grouping of the motion modules, not a second
implementation. `tests/invariants.test.mjs` permutes voxel storage across every
active authored case. `tests/audit-regressions.test.mjs` specifies additional
slope and pedestal expectations independently of the engine. See
[the audit report](../ENGINE_AUDIT.md) for the bugs these checks uncovered and
[the test catalogue](../docs/TEST_CATALOG.md) for stable case IDs and old names.

`npm run benchmark:physics` builds the native benchmark with release LTO and
the host CPU instruction set. Its `flat_single_push_ice_lane` workload restores
the two dynamic voxels in a prepared eight-voxel scene, calls the public
`simulate_turn` API, and consumes the result. A second
`prepared_passive_floor_step` workload measures the generalized player-only
evaluator used by exact search. Neither is an empty engine-only loop.

`node engine/benchmarks/puncher_search_benchmark.mjs [saved-wasm-path]`
measures a puncher-assisted gem route and a fixed-budget search in the authored
DxL room. It reports median command throughput and full-physics transitions;
DxL's capped workload is not a claim that the room was solved. Pass a saved
pre-change WASM to compare identical search work.

Prepared search can evaluate ordinary walks in rooms with punchers, ramps,
and Floating Floors without advancing unrelated mechanisms. Contact with a
puncher, travel on a ramp, remote ramp-body motion, carrying, and ambiguous
dynamic collisions retain the full tick kernel. Every declined fast path
leaves the scene untouched. Prepared cycle hashes skip immutable terrain, but
hash matches still replay and compare the complete state before rollback.
