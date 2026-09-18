#!/usr/bin/env python3
"""Second-pass live TUI drive: raw bytes, adversarial tmux resizes, HTML+PNG."""

from __future__ import annotations

import html
import json
import os
import subprocess
import time
from pathlib import Path

EVIDENCE = Path("/home/jason/.no-mistakes/evidence/01M2TRWC48EZBBDH7RX74S165J")
WORKTREE = Path("/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2TRWC48EZBBDH7RX74S165J")
CLI = WORKTREE / "dist" / "cli.mjs"
NODE = "/home/jason/.local/share/mise/installs/node/26.8.1/bin/node"
SOCK = str(EVIDENCE / "tmux2.sock")
SESSION = "gnhf-resize2"
PROMPT = "minimize app startup latency"


def tmux(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["PATH"] = f"{os.path.dirname(NODE)}:" + env.get("PATH", "")
    env["TERM"] = "xterm-256color"
    proc = subprocess.run(
        ["tmux", "-S", SOCK, *args],
        env=env,
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"tmux {args} failed: {proc.stderr}")
    return proc


def visible_status(text: str) -> dict[str, bool]:
    lowered = text.lower()
    return {
        "prompt": PROMPT in lowered,
        "brand": "g n h f" in lowered,
        "agent": "c o d e x" in lowered,
        "commits": "commit" in lowered,
        "hint": "ctrl+c" in lowered,
        "banner": "┏" in text,
    }


def leftover_markers(text: str, expected_cols: int) -> list[str]:
    """Lines that still look like a previous wider frame (very long content)."""
    issues = []
    for i, line in enumerate(text.splitlines(), 1):
        # tmux capture is the current pane width; leftover inside the pane
        # shows up as duplicated banners or mixed small+large layout.
        if line.count("g n h f") > 1:
            issues.append(f"line {i}: duplicated brand")
        if line.count("┏━") > 1:
            issues.append(f"line {i}: duplicated banner")
    return issues


def ansi_to_html(ansi: str, title: str, cols: int, rows: int) -> str:
    # Convert a captured pane (already 2D, SGR only) into HTML.
    out_rows = []
    for raw_line in ansi.splitlines() or [""]:
        parts = ['<div class="row">']
        i = 0
        bold = False
        dim = False
        while i < len(raw_line):
            if raw_line.startswith("\x1b[", i):
                end = raw_line.find("m", i)
                if end == -1:
                    parts.append(html.escape(raw_line[i]))
                    i += 1
                    continue
                params = raw_line[i + 2 : end]
                codes = [int(p) if p else 0 for p in params.split(";")] if params else [0]
                for code in codes:
                    if code == 0:
                        bold = False
                        dim = False
                    elif code == 1:
                        bold = True
                    elif code == 2:
                        dim = True
                i = end + 1
                continue
            ch = raw_line[i]
            cls = " ".join(x for x in ("bold" if bold else "", "dim" if dim else "") if x)
            esc = html.escape(ch)
            if cls:
                parts.append(f'<span class="{cls}">{esc}</span>')
            else:
                parts.append(esc)
            i += 1
        parts.append("</div>")
        out_rows.append("".join(parts))
    body = "\n".join(out_rows)
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>{html.escape(title)}</title>
<style>
  html, body {{ background:#0e1117; color:#c9d1d9; margin:0; padding:20px; }}
  h1 {{ font:600 15px/1.4 ui-sans-serif,system-ui,sans-serif; color:#8b949e; margin:0 0 6px; }}
  .meta {{ font:12px/1.4 ui-sans-serif,system-ui,sans-serif; color:#6e7681; margin:0 0 14px; }}
  .term {{
    font: 13px/16px "Liberation Mono","Noto Sans Mono",ui-monospace,monospace;
    white-space: pre;
    background:#0b0d12;
    border:1px solid #30363d;
    border-radius:8px;
    padding:10px 12px;
    width:max-content;
    box-shadow:0 8px 24px rgba(0,0,0,.35);
  }}
  .row {{ height:16px; }}
  .bold {{ color:#f0f6fc; font-weight:700; }}
  .dim {{ color:#6e7681; }}
</style>
</head><body>
<h1>{html.escape(title)}</h1>
<p class="meta">{cols}×{rows} cells · live <code>gnhf --mock</code> in tmux</p>
<div class="term">{body}</div>
</body></html>
"""


def screenshot(html_path: Path, png_path: Path, width: int, height: int) -> None:
    subprocess.run(
        [
            "/usr/bin/chromium",
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            f"--window-size={width},{height}",
            f"--screenshot={png_path}",
            html_path.as_uri(),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def capture(name: str) -> tuple[str, str]:
    ansi = tmux("capture-pane", "-t", SESSION, "-e", "-p").stdout
    plain = tmux("capture-pane", "-t", SESSION, "-p").stdout
    (EVIDENCE / f"{name}.ansi").write_text(ansi, encoding="utf-8")
    (EVIDENCE / f"{name}.txt").write_text(plain if plain.endswith("\n") else plain + "\n", encoding="utf-8")
    return ansi, plain


def pane_size() -> tuple[int, int]:
    out = tmux("display-message", "-t", SESSION, "-p", "#{pane_width}x#{pane_height}").stdout.strip()
    w, h = out.split("x")
    return int(w), int(h)


def main() -> None:
    raw_log = EVIDENCE / "tmux-raw-bytes.log"
    if raw_log.exists():
        raw_log.unlink()
    tmux("kill-server", check=False)

    cmd = f"{NODE} {CLI} --mock --meteor-frequency 0"
    tmux(
        "new-session",
        "-d",
        "-s",
        SESSION,
        "-x",
        "120",
        "-y",
        "40",
        "-c",
        str(WORKTREE),
        cmd,
    )
    tmux("pipe-pane", "-t", SESSION, "-o", f"cat >> {raw_log}")
    time.sleep(1.0)

    report: dict = {"steps": []}

    def step(label: str, cols: int, rows: int, resize: bool) -> dict:
        if resize:
            before = raw_log.stat().st_size if raw_log.exists() else 0
            tmux("resize-window", "-t", SESSION, "-x", str(cols), "-y", str(rows))
            time.sleep(0.8)
            after = raw_log.stat().st_size if raw_log.exists() else 0
            added = raw_log.read_bytes()[before:] if raw_log.exists() else b""
        else:
            added = b""
            if raw_log.exists():
                added = raw_log.read_bytes()
            time.sleep(0.2)
        ansi, plain = capture(label)
        w, h = pane_size()
        html_path = EVIDENCE / f"{label}.html"
        html_path.write_text(ansi_to_html(ansi, label, w, h), encoding="utf-8")
        png_path = EVIDENCE / f"{label}.png"
        # Generous window so the terminal card is fully visible.
        screenshot(html_path, png_path, max(900, w * 9 + 80), max(500, h * 18 + 140))
        info = {
            "label": label,
            "requested": f"{cols}x{rows}",
            "pane": f"{w}x{h}",
            "status": visible_status(plain),
            "leftover_markers": leftover_markers(plain, cols),
            "erase_2J": added.count(b"\x1b[2J"),
            "added_bytes": len(added),
            "lines": len(plain.splitlines()),
            "has_prompt": PROMPT in plain,
        }
        report["steps"].append(info)
        return info

    step("live-initial-120x40", 120, 40, resize=False)
    step("live-shrink-80x24", 80, 24, resize=True)
    step("live-restore-120x40", 120, 40, resize=True)
    step("live-narrow-60x40", 60, 40, resize=True)
    step("live-narrow-restore-120x40", 120, 40, resize=True)
    step("live-tiny-40x12", 40, 12, resize=True)
    step("live-tiny-restore-120x40", 120, 40, resize=True)

    tmux("kill-session", "-t", SESSION, check=False)
    tmux("kill-server", check=False)
    try:
        os.remove(SOCK)
    except OSError:
        pass

    full_raw = raw_log.read_bytes() if raw_log.exists() else b""
    report["raw_total_bytes"] = len(full_raw)
    report["raw_erase_2J_total"] = full_raw.count(b"\x1b[2J")
    report["raw_cursor_home_total"] = full_raw.count(b"\x1b[H")
    (EVIDENCE / "live-resize-report2.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
