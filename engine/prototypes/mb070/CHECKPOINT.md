# MB-070 checkpoint — 2026-10-29 before 03:15 UTC

Branch: `prototype/mb-070-rust-physics`.
This section records the initial implementation checkpoint before publication.
Baseline: `f38f4d38b86d23fb9013ce6409d02e88915a4dc2`.

Only `engine/prototypes/mb070/` is added. It contains Cargo manifest/lock,
Rust core and native driver, C++ reference driver, four text fixtures,
check script, JS parity/measurement harness, scope documentation and a measured
baseline JSON. `target/` and `results/` are ignored local build/evidence folders.
At the initial checkpoint, no commit, push, PR, merge, deployment, board edit,
or external message had been made.
No production C++/JS source or existing test was changed. Repository build outputs
and its automatic version-registry changes were restored to the baseline.

## Executed verification

- `npm ci`: succeeded using the repository lockfile.
- `sh scripts/test-physics.sh`: all 142 native physics/search tests passed;
  all 256,000 indexed Orange Wall support comparisons passed; seven compiler warnings.
- `sh engine/prototypes/mb070/check.sh` (with `WASM_RUSTC` and `WASM_CARGO`
  selecting the installed stable Rust 1.82 toolchain):
  passed native unit test, native and WASM release builds, and four shared
  fixtures/44 frames across C++ native/WASM and Rust native/WASM. Reversed-storage
  WASM fixtures and 200 deterministic generated scenes/6,400 commands passed.
- `cargo fmt --check --manifest-path engine/prototypes/mb070/Cargo.toml`: passed.
- `npm test`: native tests and full build (lab, unit-tests site, physics and
  solver accelerators) completed; JS phase failed in the sandbox, including
  loopback-listener EPERM errors.
- `npm run test:js`, rerun with local listeners enabled: 2,115 tests;
  2,070 passed, 17 failed, 28 skipped. This is not a green full-suite result.
- `node --test engine/tests/*.test.mjs apps/web/tests/*.test.mjs`:
  1,188 passed, zero failed, 13 skipped (1,201 total), including rotation coverage.
- `npm run test:parity`: three passed, zero failed.
- `npm run test:physics:sanitize`: built successfully, but execution had not
  completed after more than five minutes. Terminated at the time checkpoint.
  No sanitizer pass is claimed; no diagnostic had been emitted before stopping.
- `/usr/bin/time -l` on both native fixture drivers: captured peak RSS and
  footprint; results are in `baseline-2026-10-29.json`. Initial sandbox resource
  counter access failed; rerun with permission succeeded.

The official WASM standard-library component was installed for the existing Rust
stable 1.82 toolchain. The first WASM build selected Homebrew rustc 1.98 through
PATH and failed to find core; selecting the matching compiler explicitly fixed it.
No credentials or access settings were changed.

## Remaining blockers and limitations

The 17 full-JS failures include invalid Node worker execArgv flags; missing
`~/.mazebench`; repository security policy refusing installed Codex CLI 0.153.4;
missing Claude Code; and unrelated expected-label/security assertions (e.g.
`Coding off` versus `(tools off)`, model ID versus display name). These guards
were not bypassed, installations/authentication were not changed, and failures
were not silently repaired. Full rerun output remains locally in
`results/mb070-js-unrestricted.log`.

Sanitizer execution is incomplete, intentionally stopped for the deadline.
Native benchmark measurements include process startup/text I/O. WASM timing
includes JS and trace handling; the prototype/full-engine scope and different
Rust toolchains prevent treating these numbers as an optimization result.
The supported domain has only one-tick commands; general multi-tick/cycle parity
is still unimplemented. See README.md for all rejected features.

## Baseline comparison follow-up — 2026-10-29

An isolated baseline worktree at pinned commit
`f38f4d38b86d23fb9013ce6409d02e88915a4dc2` reproduced the failures without the
Rust prototype. Sequential `npm run test:js` runs on baseline and prototype each
reported **2,070 passed, 17 failed, 28 skipped** (2,115 total, zero cancelled).
All **17 test locations, names, and error/assertion signatures matched**:
**new 0, disappeared 0, changed 0**. The saved original prototype log also
matched all 17. The targeted baseline run had 32 passed and 17 failed.

Both checkouts used Node **v26.8.1**, npm **11.19.0**, the same desktop toolchain,
copied dependencies with an identical lockfile, and the same permission to run
local test listeners. Both `npm run build` commands succeeded. Before the full
comparison, generated tracked runtime/version files were restored so both runs
used identical committed runtime assets. No toolchain, authentication, or
security-policy changes were made to address failures.

Caveats: checkout paths and independently generated lab build IDs/assets differed;
only the unit-test site files were byte-identical. The targeted baseline run and
the original saved prototype run used rebuilt runtime assets, while the two fresh
full runs used committed assets. Timing and stack checkout prefixes were excluded
from signature comparison. This establishes reproduction in this environment,
not individual root causes or Rust correctness: the existing JS suite does not
import the opt-in Rust prototype. Sanitizer validation remains incomplete.
Native, Rust, and sanitizer tests were **not rerun during the comparison**.

A sanitized, durable summary of all 17 matched failures, comparison conditions,
and limits is saved in [BASELINE_COMPARISON.md](BASELINE_COMPARISON.md).
Raw logs and machine-specific paths remain local and are excluded from publication.

## Pre-publication validation — 2026-10-29

The prototype check script and `cargo fmt --check` were rerun before publication.
Native unit/rejection checks, native/WASM release builds, all four shared
fixtures (44 frames on four backends), reversed-storage parity, and 200 generated
WASM differential scenes passed. No new failure was observed in these focused
checks. The full JS suite was not rerun for publication; its 17 matched baseline
failures are documented above. Sanitizer validation is still incomplete.

Publication includes only prototype source, fixtures, scripts, documentation,
and the measured baseline summary. Raw logs, private host paths, binaries and
build caches are excluded. No new physics scenario was implemented in this step.

## Next steps (require a new work window)

1. Complete the sanitizer run and triage full-suite environment failures without
   weakening repository security policy or changing credentials.
2. Standardize Rust native/WASM toolchains and add repeated in-process native
   timing plus comparable kernel-only WASM measurements.
3. Extend one explicitly selected multi-tick scenario and its shared fixtures;
   preserve C++ behavior unless an individual difference receives human approval.
4. Keep any broader port, search, merge, deployment, or backlog change out of scope.
