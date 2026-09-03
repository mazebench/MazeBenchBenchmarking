import os
import sys
import time

try:
    import resource

    cpu = int(sys.argv[1])
    memory = int(sys.argv[2]) * 1024 * 1024
    file_size = int(sys.argv[3]) * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    if hasattr(resource, "RLIMIT_AS"):
        resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_size, file_size))
except (ImportError, ValueError, OSError):
    pass

_workspace_root = os.path.realpath(os.getcwd())
_runtime_roots = tuple(
    os.path.realpath(entry)
    for entry in [sys.base_prefix, sys.exec_prefix, os.path.dirname(sys.executable), *sys.path]
    if entry
)
_safe_devices = {"/dev/null", "/dev/random", "/dev/urandom"}


def _inside(candidate, root):
    try:
        return os.path.commonpath([candidate, root]) == root
    except (OSError, ValueError):
        return False


def _allowed_path(value):
    if isinstance(value, int):
        return value in {0, 1, 2}
    try:
        candidate = os.path.realpath(os.fsdecode(value))
    except (TypeError, ValueError, OSError):
        return False
    return (
        candidate in _safe_devices
        or _inside(candidate, _workspace_root)
        or any(_inside(candidate, root) for root in _runtime_roots)
    )


def _deny_escape(event, args):
    if event.startswith("subprocess.") or event.startswith("ctypes.") or event in {
        "os.exec",
        "os.fork",
        "os.forkpty",
        "os.posix_spawn",
        "os.spawn",
        "os.system",
        "pty.spawn",
    }:
        raise PermissionError("python_exec cannot launch external processes")
    if event == "open" and args and not _allowed_path(args[0]):
        raise PermissionError("python_exec cannot access files outside /workspace")
    if event in {
        "os.chdir",
        "os.chmod",
        "os.chown",
        "os.listdir",
        "os.mkdir",
        "os.remove",
        "os.rename",
        "os.replace",
        "os.rmdir",
        "os.scandir",
        "os.symlink",
        "os.truncate",
        "os.unlink",
        "os.utime",
        "glob.glob",
        "glob.glob/2",
    } and args and not _allowed_path(args[0]):
        raise PermissionError("python_exec cannot access paths outside /workspace")
    if event in {"os.link", "os.rename", "os.replace", "os.symlink"} and len(args) > 1 and not _allowed_path(args[1]):
        raise PermissionError("python_exec cannot access paths outside /workspace")


sys.addaudithook(_deny_escape)
sys.path.insert(0, os.getcwd())
_script_path = os.path.realpath(sys.argv[4])
if not _inside(_script_path, _workspace_root) or not _script_path.endswith(".py"):
    raise PermissionError("python_exec can execute only .py files inside /workspace")
with open(_script_path, "r", encoding="utf-8") as _script:
    source = _script.read()
scope = {"__name__": "__main__", "__file__": _script_path}
started = time.process_time_ns()
try:
    exec(compile(source, _script_path, "exec"), scope, scope)
finally:
    elapsed = max(0, time.process_time_ns() - started)
    try:
        os.write(2, f"\x1eMAZEBENCH_CPU_TIME_NS={elapsed}\x1e".encode("ascii"))
    except OSError:
        pass
