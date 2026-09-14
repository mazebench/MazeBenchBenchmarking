# Incremental benchmark checkpoints

New MazeBench ASCII, vision, Ice Maze and Slotski launches use `incremental-v1`.
Legacy runs remain readable; changing a frozen existing run requires the
operator migration in `scripts/migrate-incremental-storage.mjs` and an exact
before/after source-hash plan.

A journal generation contains an immutable full baseline and a JSONL stream of
small, authenticated state/summary changes. Undo snapshots and action records
are saved once. Records form an HMAC chain. A signed `checkpoint.json` identifies
the committed byte prefix and carries the current compact summary and display.
The writer syncs new immutable frames and the journal before atomically
publishing the checkpoint. An interrupted, uncommitted suffix is ignored and
truncated by the next writer. Old committed bytes are never edited.

`game-state.json`, `summary.json`, and `display.json` are stable format markers,
not full JSON exports. Use `readCheckpointJson(directory, filename)` to read
these projections. Use runtime `open()`/`apply()` for mutations. Do not edit or
re-sign marker files using old one-off repair scripts. Historical operator
scripts need adaptation to the journal format before use on migrated runs.
Backups retain the complete original legacy checkpoint for recovery.

Each ordinary move validates the signed head and append boundary; immutable
baseline hashes are cached against file identity/size/timestamps. Reopening the
runtime authenticates and reconstructs the full committed history. A changed
log with an unchanged head is revalidated. Historical animation reads retain
per-frame/index authentication. This does not grant agents new capabilities.

The in-memory runtime owns one writer. A writer whose expected head differs
from the signed on-disk head fails and must reopen. Concurrent *agent* writers
are never supported; the supervisor remains responsible for one active agent
per run. The stale-writer check is an additional guard, not a distributed lock.

The save path preserves the engine's append/pop semantics. A non-advancing
operator save uses full deltas and is bounded by a 32 MB record limit; bulk
rewrites require a new baseline generation through an audited operator tool.
Frame rendering cost still depends on physics/animation complexity.

The run API accepts a `history_cursor`; subsequent responses include only new
actions, positions and novelty flags. Epoch changes or shortened histories
force a full response. Event-feed reads scan backwards with an 8 MB bound.
MCP observations list the most recent 100 moves and `move_history/index.json`,
which links pages of older records.

Verification lives in `tests/benchmark-journal*.test.mjs`, the normal benchmark
security/animation suites, and the real Codex/Claude offline transport tests.
No API inference is required to run those tests.

## Live editor updates

`next-entry-v1` gives main-world runs a signed private baseline and immutable
room revision snapshots under `world-updates/`. The editor publishes only valid
room payloads. Each game action pins the published world revision and the
before/after authored room revisions. Current rooms and stored undo/reset
states retain their original revision. Fresh physical entry and explicit room
commands pick up updates. A room command creates the authored starting board
and player position, including when targeting the current room; it never uses
a saved physical entry as the spawn.

The world manifest and executable assets still use the frozen runtime checks.
Editing source room JSON directly changes Play/editor data but does not publish
an approval to a run. Saving that room in the editor publishes it. The publisher
uses atomic heads and preserves old snapshots. An unsuccessful editor save may
leave a new authored source file with the run still safely using its last
approved revision; saving again retries publication. Runs never receive raw
room snapshots, update files, or additional capabilities through MCP.

Pause an existing run before the one-time exact-hash migration in
`scripts/enable-live-world-updates.mjs`. That migration leaves its checkpoint
byte-identical. Subsequent editor room saves require no run pause or restart.
