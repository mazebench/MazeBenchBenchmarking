# Benchmark integrity

The evaluated model is untrusted. The localhost supervisor, MCP implementation,
Codex authentication client, macOS kernel, installed Python runtime, and the
human who controls this machine are trusted. These controls prevent the model
from obtaining hidden world/solver data or changing scores through the known
tool and filesystem escape paths; they are not protection against a malicious
host administrator or an OS vulnerability.

## Conditions

| Mode | Permitted activity |
| --- | --- |
| Tools off | Direct `maze_observe`, `maze_action`, `maze_sequence` calls |
| Python on | Same maze tools plus `python_exec` in the run's workspace |
| Resume / continuation | Same frozen model, condition, prompt, binary and runtime; checkpoint verified first |
| Interview / follow-up | A separate Codex fork with no model-visible tools |

Codex advertises its three generic MCP resource helpers whenever a server is
configured. MazeBench returns empty resource and template lists and rejects
all resource reads. `maze_observe` alone reads allowlisted observation records;
it cannot open raw engine state, world files, arbitrary paths, or solver code.
Other MCP servers, personal instructions, skills, memories, connectors, native
shell/patch/JavaScript tools, web, and delegation are disabled. The single-model
catalog also removes metadata that would otherwise override feature flags.

## Python boundary

The trusted bootstrap installs a deny-by-default Seatbelt profile before
reading or running the agent's saved script. Python may read its runtime/system
libraries and read/write its workspace. Process creation, exec, network, IPC,
and private file access are denied by the kernel, including through `ctypes`.
The Python audit hook is an additional usability guard, not the security boundary.
The startup preflight deliberately removes that hook and tests the OS boundary.
Other OS backends fail closed until separately implemented and tested.

The trusted writer rejects symlink directories, symlink files, hardlinks, and
special files, and atomically installs a fresh script inode. Previous Python
execution has exited before another script is written; child processes cannot
remain behind to race the writer. Inventory walks skip links and are bounded.
Python gets a sanitized environment and no inherited host file descriptors.
Execution has time/output limits. Wall time is measured by the parent process;
agent-authored CPU timing markers are not trusted (`cpu_time_ms` is unavailable).

## Provenance and scores

The per-run manifest hashes executable runtime files, the canonical engine
binary, and all world data. Its frozen configuration binds the model, effort,
condition, action budget, starting room and prompt. Codex's binary and model
catalog are also hashed. Checkpoints authenticate engine state and summary
with a run-specific HMAC key outside the Python workspace. MCP checks integrity
before tools; the supervisor checks before continuation and before accepting
completion. A detected violation stops the run and prevents resumption.

The localhost server rejects foreign Host/Origin headers and cross-site browser
requests. Operator edits to hashed runtime or world assets require a new run.
Historical records predating policy v4 are not relabeled as validated results.

## CLI upgrades and regression checks

The version indicator reads OpenAI's `https://releases.openai.com/codex/channels/latest`
endpoint, with a 15-minute cache and a manual refresh. A failed/offline lookup is
shown as unknown, never as up to date. Updating is an explicit operator action
using `codex update`; it does not automatically expand the tested-version list.

Before admitting another version in `codex-installation.mjs`, run:

```sh
node --test tests/*.test.mjs
node scripts/check-benchmark-capabilities-v1.mjs
node scripts/sync-engine-v1.mjs --check
```

The capability script uses the actual CLI and an unauthenticated loopback
Responses fixture to inspect the emitted model/tool catalog. It tests Astra and
Terra with Python on/off, initial and resumed turns, and interview forks and
follow-ups. It uses a temporary Codex home, never sends credentials or prompts
to an external service, and removes its fixtures afterward. Also perform a
bounded live model smoke test in separate validation records after an upgrade.

Security regressions cover audit-hook replacement, native filesystem/fork
calls, subprocess/re-exec, localhost access, symbolic and hard links, workspace
substitution, unknown tool events, state/score/configuration/manifest tampering,
and cross-origin requests. Keep these tests when changing the boundary.
# Compaction and audited recovery

Codex remote compaction v2 remains enabled in both benchmark conditions and in
interviews. This is a Responses transport feature, not an MCP tool or an agent
executor. Disabling it makes Codex 0.153.3 use the legacy `/responses/compact`
endpoint, which returned 404 for ChatGPT-authenticated benchmark runs.

The offline capability test forces compaction as well as ordinary turns and
checks that the tool catalog stays restricted before and after compaction.
Recoverable compaction failures can resume the same Codex conversation only
after the ordinary integrity checks pass.

For the affected September 4 build, the operator-only
`scripts/repair-benchmark-compaction-v1.mjs <run-id>` accepts exactly the reviewed
before/after hashes for the supervisor and Resume UI. It verifies all other
assets, the original prompt and configuration, Codex binary and catalog, and
the signed game checkpoint before making any change. It preserves the original
manifest and run metadata in `repairs/remote-compaction-v2/`, records the repair,
and leaves game state, score, history, prompt and Codex thread intact. This is
not a general bypass for runtime changes and is not available through MCP.
