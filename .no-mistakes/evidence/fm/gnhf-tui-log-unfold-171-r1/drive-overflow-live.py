#!/usr/bin/env python3
"""Drive Renderer with a 30-line lastMessage in a 24-row tmux pane."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

EVIDENCE = Path("/home/jason/.no-mistakes/evidence/01M2V8MP0QZD9XPSSRPEBN4WSB")
WORKDIR = "/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2V8MP0QZD9XPSSRPEBN4WSB"
TSX = f"{WORKDIR}/node_modules/.pnpm/node_modules/.bin/tsx"
HARNESS = str(EVIDENCE / "drive-overflow-harness.mjs")
SESSION = "gnhf-overflow-live"


def run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, check=True, text=True, capture_output=True)


def tmux(*args: str) -> str:
    return run(["tmux", *args]).stdout


def kill_session() -> None:
    subprocess.run(
        ["tmux", "kill-session", "-t", SESSION],
        check=False,
        capture_output=True,
        text=True,
    )


def capture_plain() -> str:
    return tmux("capture-pane", "-t", SESSION, "-p")


def capture_ansi() -> str:
    return tmux("capture-pane", "-t", SESSION, "-p", "-e")


def wait_for(needle: str, timeout: float = 6.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture_plain()
        if needle in last:
            return last
        time.sleep(0.1)
    raise TimeoutError(f"did not see {needle!r} in:\n{last}")


def save(name: str, plain: str) -> dict[str, object]:
    ansi = capture_ansi()
    (EVIDENCE / f"{name}.txt").write_text(plain)
    (EVIDENCE / f"{name}.ansi").write_text(ansi)
    lines = plain.splitlines()
    meta = {
        "name": name,
        "captured_lines": len(lines),
        "has_expand_hint": "ctrl+o to expand" in plain,
        "has_fold_hint": "ctrl+o or esc to fold" in plain,
        "has_line_1": "Message line 1" in plain,
        "has_line_4": "Message line 4" in plain,
        "has_line_20": "Message line 20" in plain,
        "has_line_30": "Message line 30" in plain,
        "has_ellipsis": "…" in plain,
        "has_stats": "00:00:00" in plain or "total" in plain,
        "footer_line": next(
            (i + 1 for i, line in enumerate(lines) if "ctrl+" in line or "graceful" in line),
            None,
        ),
    }
    (EVIDENCE / f"{name}.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def main() -> int:
    kill_session()
    run(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            SESSION,
            "-x",
            "80",
            "-y",
            "24",
            "-c",
            WORKDIR,
        ]
    )
    try:
        tmux("set-option", "-t", SESSION, "window-size", "manual")
        tmux("resize-window", "-t", SESSION, "-x", "80", "-y", "24")
        tmux("send-keys", "-t", SESSION, f"{TSX} {HARNESS}", "Enter")
        folded = wait_for("ctrl+o to expand")
        time.sleep(0.3)
        folded_meta = save("live-24x80-long-folded", capture_plain())
        tmux("send-keys", "-t", SESSION, "C-o")
        unfolded = wait_for("ctrl+o or esc to fold")
        time.sleep(0.3)
        unfolded_plain = capture_plain()
        unfolded_meta = save("live-24x80-long-unfolded", unfolded_plain)
        summary = {"folded": folded_meta, "unfolded": unfolded_meta}
        (EVIDENCE / "live-overflow-summary.json").write_text(
            json.dumps(summary, indent=2) + "\n"
        )
        print(json.dumps(summary, indent=2))
        if unfolded_meta["captured_lines"] != 24:
            raise SystemExit(f"unfolded frame was {unfolded_meta['captured_lines']} rows")
        if not unfolded_meta["has_fold_hint"]:
            raise SystemExit("unfolded frame missing fold hint")
        if unfolded_meta["has_line_30"]:
            raise SystemExit("unfolded frame leaked Message line 30")
        if not unfolded_meta["has_line_1"]:
            raise SystemExit("unfolded frame missing Message line 1")
        return 0
    finally:
        kill_session()


if __name__ == "__main__":
    raise SystemExit(main())
