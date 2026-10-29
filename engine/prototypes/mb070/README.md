# MB-070: bounded Rust physics prototype

Baseline: `f38f4d38b86d23fb9013ce6409d02e88915a4dc2`.
This is an opt-in experiment. No production loader or existing test is replaced.

## Supported domain

One player; independent ordinary crates; walls; goals; a complete rectangular
floor at z=-1 with all other active objects at z=0; generic IDs must be -1.
At most 128 voxel records and dimensions 1..64. Four cardinal commands support
walking, wall/boundary blocking, a single-crate push, and goal collection.
The entire scene is validated before mutation. Multiple ordinary crates in a
push chain block atomically: the C++ reference supplies only one unit of push
force (`motion_support.inc:DeliberatePushMayRecruit`). No behavior fix is proposed.

Each command in this domain has one returned tick (including blocked commands).
The comparator checks status, tick number, and every x/y/z/role/ID field in every
returned frame, including the final frame. This proves only this one-tick domain;
it does **not** establish multi-tick, cycle, or general engine parity.

Unsupported scenes return -3 without mutation. Invalid directions return -1.
Unsupported: holes/gravity, Ice, slopes, stacks/carrying, polycubes, clones,
weightless bodies, mechanisms, punchers, room seams, cycles, and saved states.
Search is intentionally absent. The prototype is not v1-compatible or a drop-in
replacement for the production ABI. No approved behavioral deviations exist.

## Build and verification

Requires C++20 clang++, Node, Cargo/Rust, and the official
`wasm32-unknown-unknown` target. No Rust third-party crates are used.

```sh
sh engine/prototypes/mb070/check.sh
```

If native and WASM toolchains differ, set `WASM_CARGO` and `WASM_RUSTC` to the
corresponding compiler executables. This checkpoint used Homebrew Rust 1.98.0
for native and the already installed stable Rust 1.82.0 plus its official WASM
standard-library target. Compiler mismatch is a baseline limitation to remove.

The check refuses native reference source drift from the pinned baseline and
extracts the baseline's committed C++ WASM. It runs a native rejection test,
builds both Rust targets and the C++ reference driver, then executes four shared
text fixtures on all four backends. Reversed-storage cases and 200 generated
32-command scenes additionally compare the two WASM engines. Fixtures contain
width, height, count, command digits, then x/y/z/role-name/generic-ID records.

The WASM prototype exports memory, `voxel_buffer`, and
`step_tick(count,width,height,direction)`. Upload 20-byte records to the returned
pointer; capacity is 128 records. Calls are synchronous and single-instance.
The returned result is completion/error; successful commands each advance one
tick. No continuation serialization is exposed. Native uses the same Rust core.

Keep running the independent repository C++, sanitizer, JS/WASM, rotation, and
adapter suites. Prototype checks supplement them. See CHECKPOINT.md for actual
runs and blockers; a full green repository result has not been obtained.

## Measurement interpretation

`parity.mjs` writes `results/baseline.json`, including CPU, Node, fixture counts,
WASM sizes and allocated linear memory. Per-fixture WASM timings include upload,
reset, trace allocation/readback and JS calls: 100 warmups then 1,000 repetitions.
Native process timings include startup/text I/O and are single observations.
The checked-in baseline snapshot includes macOS native peak RSS measurements.
These measurements compare a tiny restricted Rust engine with a full C++ engine;
they are not speedup claims, kernel-only timings, or final performance thresholds.

Next: finish sanitizer validation, then select a bounded multi-tick Ice-lane
scenario with native/WASM tick parity fixtures. Normalize toolchains and add
native in-process repeated kernel measurements as part of that next phase.
The Ice-lane extension is proposed, not implemented; no search or full port is
part of this prototype. Any intentional departure from C++ needs individual
human approval. Keep unapproved reference behavior intact.
