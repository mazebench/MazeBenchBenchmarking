# MB-070 baseline comparison — 2026-10-29

Pinned baseline: `f38f4d38b86d23fb9013ce6409d02e88915a4dc2`.

Both fresh full JS runs (`npm run test:js`, baseline then prototype) reported
**2,070 passed, 17 failed, 28 skipped**, 2,115 total and zero cancelled.
**All 17 test locations, names and error/assertion signatures matched:**
**new 0, disappeared 0, changed 0**. The original saved prototype log also
matched all 17. The targeted baseline run reported 32 passed and 17 failed.

## Conditions and limitations

The baseline was an isolated detached worktree at the pinned commit. Both
checkouts used Node v26.8.1, npm 11.19.0, the same desktop toolchain, copied
dependencies from the same lockfile, and local-listener permissions. Both
`npm run build` commands passed. Generated tracked runtime/version assets were
restored before the full runs, giving both the same committed runtime assets.
The pinned physics WASM SHA-256 was
`b5f9c9e05739e45128fe161898fd304a62cbc4788c01f2b537bbdf5c2f413861`.

Checkout paths and independently generated lab build IDs/assets differed.
Unit-test site files were byte-identical; lab builds were not. The targeted
baseline and original saved prototype runs used rebuilt runtime assets; the
fresh full comparison used committed assets. Timing and stack checkout prefixes
were excluded from signature matching. No guards or credentials were changed.

These failures reproduce without the Rust prototype in the observed environment.
This does not establish their individual root causes or prove Rust correctness:
the existing JS suite does not import the opt-in Rust prototype. Native, Rust,
and sanitizer tests were not rerun during this comparison. Sanitizer validation
remains incomplete, as recorded in [CHECKPOINT.md](CHECKPOINT.md).

## Matched failures

Each entry below had the same signature on baseline and prototype. This is a
sanitized summary, not a copy of raw logs or machine-specific paths.

- `tests/benchmark-api-routing.test.mjs:5:1` — the current Codex owner receives launches and controls without dropping mode or speed
  - Versioned benchmark runner is unavailable. Start npm run start:releases; no run was launched.
- `tests/benchmark-api-routing.test.mjs:26:1` — vision launches use only the image owner and fail closed when it is offline
  - The input did not match the regular expression /Vision runner is unavailable/. Input: 'Versioned benchmark runner is unavailable. Start npm run start:releases; no run was launched.'
- `tests/benchmark-api-routing.test.mjs:57:1` — browser routes reads and controls to the owning companion across recovery upgrades
  - Expected values to be strictly equal: + actual - expected + 'Coding off' - '(tools off)'
- `tests/benchmark-capability-server.test.mjs:60:1` — HTTP launch, overview, library and controls use built-in recovery with a real signed checkpoint
  - Node Worker rejected inherited execArgv flags (ERR_WORKER_INVALID_EXEC_ARGV).
- `tests/benchmark-catalog-launch.test.mjs:27:1` — new catalog runtimes sign the chosen model/speed and expose only their intended MCP tools
  - ENOENT: the required user-local MazeBench installation directory was absent.
- `tests/benchmark-compaction-repair.test.mjs:45:1` — audited compaction repair preserves state, scores, prompt and conversation
  - Codex codex-cli 0.153.4 has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.
- `tests/benchmark-compaction-repair.test.mjs:67:1` — compaction repair refuses tampered state, configuration and unrelated failures
  - Codex codex-cli 0.153.4 has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.
- `tests/benchmark-prime-direct-v2.test.mjs:88:1` — signed Python-off condition has matching preview, label, and no Python or files in real MCP
  - Expected values to be strictly equal: + actual - expected + 'Coding off' - '(tools off)'
- `tests/benchmark-prime-direct.test.mjs:43:1` — signed Python-off condition has matching preview, label, and no Python or files in real MCP
  - Expected values to be strictly equal: + actual - expected + 'Coding off' - '(tools off)'
- `tests/benchmark-run-dashboard.test.mjs:96:1` — background analysis preserves every visit and novelty value, updates after commits, and coalesces requests
  - Node Worker rejected inherited execArgv flags (ERR_WORKER_INVALID_EXEC_ARGV).
- `tests/benchmark-security.test.mjs:214:1` — version checker distinguishes current, outdated, unsupported and offline results
  - Expected values to be strictly equal: false !== true
- `tests/benchmark-transport.test.mjs:90:1` — audited migration preserves game, score, prompt, log and session for each world/provider
  - Codex codex-cli 0.153.4 has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.
- `tests/benchmark-transport.test.mjs:107:1` — migration refuses actual violations, forged notices, altered state and unrelated edits
  - Codex codex-cli 0.153.4 has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.
- `tests/heatmap-import.test.mjs:11:1` — import preserves exact world coordinates, counts, model identity and source tool condition
  - Expected values to be strictly equal: + actual - expected + 'claude-haiku-4-5-20251001' - 'Haiku 4.5'
- `tests/vision-mode.test.mjs:25:1` — vision serves native image content and image history, with no ASCII or private board data in either Python condition
  - Codex codex-cli 0.153.4 has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.
- `tests/vision-wire.test.mjs:17:1` — real Codex forwards vision MCP images to the model with the restricted tool catalog
  - Codex codex-cli 0.153.4 has not been security-tested for MazeBench. Refusing to launch until its tool boundary is revalidated.
- `tests/vision-wire.test.mjs:57:1` — real Claude Code receives the vision PNG and validates the restricted tool catalog
  - Claude Code is not installed. Install it and run claude auth login.

Raw comparison JSON and logs remain in local ignored/workspace evidence only.
No source fixes, expected-value changes, or security-policy exceptions were made.
