"""Prepare reproducible uv commands for execution by a policy-owned Forge.

This bridge never executes submitted Python on the host and never claims an
observation occurred. The Forge's tool observation remains the evidence source.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
from typing import Sequence


def _relative(value: str, label: str) -> str:
    path = PurePosixPath(value)
    if (not value or "\\" in value or ":" in value or path.is_absolute()
            or any(part in ("", ".", "..") for part in value.split("/"))
            or any(ord(character) < 32 for character in value)):
        raise ValueError(f"{label} must be a normalized relative Forge path")
    return str(path)


def _digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def plan_experiment(
    script: str,
    script_bytes: bytes,
    *,
    arguments: Sequence[str] = (),
    lock_bytes: bytes | None = None,
    timeout_ms: int = 30_000,
) -> dict:
    """Bind a Python script and optional uv script lock to an offline Forge call.

    Inline dependency declarations require ``uv lock --script experiment.py``
    before sealing and the corresponding ``experiment.py.lock`` in the Forge.
    Dependencies must already exist in the policy-owned sandbox's uv cache.
    """
    path = _relative(script, "script")
    if not path.endswith(".py"):
        raise ValueError("script must have a .py extension")
    if not isinstance(script_bytes, bytes) or len(script_bytes) > 1_048_576:
        raise ValueError("script_bytes must contain at most 1 MiB")
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 1 <= timeout_ms <= 300_000:
        raise ValueError("timeout_ms must be between 1 and 300000")
    if len(arguments) > 128 or any(not isinstance(arg, str) or len(arg) > 4096 or "\0" in arg for arg in arguments):
        raise ValueError("arguments must be at most 128 bounded strings")
    text = script_bytes.decode("utf-8", errors="strict")
    if "# /// script" in text and lock_bytes is None:
        raise ValueError("Inline script metadata requires a sealed uv script lock")
    files = [{"path": path, "digest": _digest(script_bytes), "size": len(script_bytes)}]
    uv_args = ["run", "--offline", "--no-project", "--no-managed-python", "--no-python-downloads"]
    if lock_bytes is not None:
        if not isinstance(lock_bytes, bytes) or not lock_bytes or len(lock_bytes) > 4_194_304:
            raise ValueError("lock_bytes must contain 1 byte to 4 MiB")
        files.append({"path": f"{path}.lock", "digest": _digest(lock_bytes), "size": len(lock_bytes)})
        uv_args.append("--locked")
    uv_args.extend([path, *arguments])
    return {
        "protocol": "jevyr.uv-experiment-plan/1",
        "tool": "forge.command",
        "args": {"command": "uv", "args": uv_args},
        "timeoutMs": timeout_ms,
        "materials": files,
        "requirements": {"network": "denied", "executor": "policy-owned-oci", "uvCache": "preprovisioned"},
        "evidenceAuthority": "none-until-forge-execution",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Prepare an offline uv experiment for a Jevyr Forge; this command does not execute Python.")
    parser.add_argument("script", type=Path)
    parser.add_argument("--forge-path", help="Relative path in the disposable Forge (defaults to script filename)")
    parser.add_argument("--lock", type=Path)
    parser.add_argument("--timeout-ms", type=int, default=30_000)
    parser.add_argument("--argument", action="append", default=[])
    args = parser.parse_args()
    try:
        value = plan_experiment(
            args.forge_path or args.script.name,
            args.script.read_bytes(),
            arguments=args.argument,
            lock_bytes=args.lock.read_bytes() if args.lock else None,
            timeout_ms=args.timeout_ms,
        )
    except (OSError, UnicodeError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
