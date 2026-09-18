#!/usr/bin/env python3
"""Drive gnhf --mock in tmux and capture folded/unfolded TUI frames."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

EVIDENCE = Path("/home/jason/.no-mistakes/evidence/01M2V8MP0QZD9XPSSRPEBN4WSB")
CLI = Path(
    "/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2V8MP0QZD9XPSSRPEBN4WSB/dist/cli.mjs"
)
SESSION = "gnhf-unfold-live"
WORKDIR = str(CLI.parent.parent)


def run(args: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        check=True,
        text=True,
        capture_output=True,
        **kwargs,
    )


def tmux(*args: str) -> str:
    result = run(["tmux", *args])
    return result.stdout


def kill_session() -> None:
    subprocess.run(
        ["tmux", "kill-session", "-t", SESSION],
        check=False,
        capture_output=True,
        text=True,
    )


def start_session(cols: int, rows: int) -> None:
    kill_session()
    run(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            SESSION,
            "-x",
            str(cols),
            "-y",
            str(rows),
            "-c",
            WORKDIR,
        ]
    )
    # Keep the pane size pinned even if the outer tty is smaller/absent.
    tmux("set-option", "-t", SESSION, "window-size", "manual")
    tmux("resize-window", "-t", SESSION, "-x", str(cols), "-y", str(rows))
    tmux(
        "send-keys",
        "-t",
        SESSION,
        f"node {CLI} --mock --meteor-frequency 0",
        "Enter",
    )


def wait_for(needle: str, timeout: float = 5.0) -> str:
    deadline = time.time() + timeout
    last = ""
    while time.time() < deadline:
        last = capture_plain()
        if needle in last:
            return last
        time.sleep(0.1)
    raise TimeoutError(f"did not see {needle!r} in:\n{last}")


def capture_plain() -> str:
    return tmux("capture-pane", "-t", SESSION, "-p", "-J")


def capture_ansi() -> str:
    return tmux("capture-pane", "-t", SESSION, "-p", "-e", "-J")


def pane_size() -> tuple[int, int]:
    raw = tmux(
        "display-message",
        "-t",
        SESSION,
        "-p",
        "#{pane_width}x#{pane_height}",
    ).strip()
    width, height = raw.split("x")
    return int(width), int(height)


def save_capture(name: str) -> dict[str, object]:
    plain = capture_plain()
    ansi = capture_ansi()
    width, height = pane_size()
    lines = plain.splitlines()
    (EVIDENCE / f"{name}.txt").write_text(plain)
    (EVIDENCE / f"{name}.ansi").write_text(ansi)
    meta = {
        "name": name,
        "pane": f"{width}x{height}",
        "captured_lines": len(lines),
        "has_expand_hint": "ctrl+o to expand" in plain,
        "has_fold_hint": "ctrl+o or esc to fold" in plain,
        "has_graceful_stop_hint": "graceful stop requested" in plain,
        "has_ellipsis": "…" in plain or "..." in plain,
        "has_gnhf_logo": "┏━╸┏━┓" in plain,
        "has_prompt": "minimize app startup latency" in plain,
        "has_stats": any(token in plain for token in ("in ", "out ", "elapsed")),
        "footer_visible": (
            "ctrl+o to expand" in plain
            or "ctrl+o or esc to fold" in plain
            or "graceful stop requested" in plain
            or "ctrl+c to exit" in plain
        ),
    }
    (EVIDENCE / f"{name}.json").write_text(json.dumps(meta, indent=2) + "\n")
    return meta


def send_key(key: str) -> None:
    tmux("send-keys", "-t", SESSION, key)


def main() -> int:
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    results: dict[str, object] = {"cli": str(CLI)}

    # Scenario A: 40x80 default fold, unfold, escape fold, toggle fold
    start_session(80, 40)
    try:
        wait_for("ctrl+o to expand")
        time.sleep(0.4)
        folded = save_capture("live-40x80-folded")
        send_key("C-o")
        wait_for("ctrl+o or esc to fold")
        time.sleep(0.3)
        unfolded = save_capture("live-40x80-unfolded")
        send_key("Escape")
        wait_for("ctrl+o to expand")
        time.sleep(0.3)
        folded_esc = save_capture("live-40x80-folded-esc")
        send_key("C-o")
        wait_for("ctrl+o or esc to fold")
        time.sleep(0.2)
        send_key("C-o")
        wait_for("ctrl+o to expand")
        time.sleep(0.3)
        folded_toggle = save_capture("live-40x80-folded-toggle")
        send_key("C-o")
        wait_for("ctrl+o or esc to fold")
        time.sleep(0.2)
        send_key("C-c")
        wait_for("graceful stop requested")
        time.sleep(0.3)
        graceful = save_capture("live-40x80-unfolded-ctrl-c")
        results["large"] = {
            "folded": folded,
            "unfolded": unfolded,
            "folded_esc": folded_esc,
            "folded_toggle": folded_toggle,
            "graceful": graceful,
        }
    finally:
        kill_session()

    # Scenario B: adversarial 24-row overflow / footer clamp
    start_session(80, 24)
    try:
        wait_for("ctrl+o to expand")
        time.sleep(0.4)
        folded24 = save_capture("live-24x80-folded")
        send_key("C-o")
        wait_for("ctrl+o or esc to fold")
        time.sleep(0.4)
        unfolded24 = save_capture("live-24x80-unfolded")
        results["tight"] = {"folded": folded24, "unfolded": unfolded24}
    finally:
        kill_session()

    (EVIDENCE / "live-drive-summary.json").write_text(
        json.dumps(results, indent=2) + "\n"
    )
    print(json.dumps(results, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
