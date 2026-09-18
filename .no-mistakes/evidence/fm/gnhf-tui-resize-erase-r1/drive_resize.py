#!/usr/bin/env python3
"""Drive gnhf --mock through live PTY resizes and record operator-visible screens."""

from __future__ import annotations

import fcntl
import json
import os
import select
import signal
import struct
import termios
import time
from dataclasses import dataclass, field
from pathlib import Path

EVIDENCE = Path("/home/jason/.no-mistakes/evidence/01M2TRWC48EZBBDH7RX74S165J")
WORKTREE = Path("/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2TRWC48EZBBDH7RX74S165J")
CLI = WORKTREE / "dist" / "cli.mjs"
NODE = "/home/jason/.local/share/mise/installs/node/26.8.1/bin/node"

LARGE = (40, 120)
SMALL = (24, 80)
NARROW = (40, 60)
TINY = (12, 40)

PROMPT_SNIPPET = "minimize app startup latency"
STATUS_MARKERS = ("g n h f", "c o d e x", "11 commits", "iteration")


@dataclass
class Cell:
    char: str = " "
    bold: bool = False
    dim: bool = False


@dataclass
class Screen:
    rows: int
    cols: int
    cells: list[list[Cell]] = field(default_factory=list)
    cursor_r: int = 0
    cursor_c: int = 0
    bold: bool = False
    dim: bool = False

    def __post_init__(self) -> None:
        self.cells = [[Cell() for _ in range(self.cols)] for _ in range(self.rows)]

    def resize_keep(self, rows: int, cols: int) -> None:
        """Grow the persistent buffer; never discard leftover cells."""
        if rows > self.rows:
            for _ in range(rows - self.rows):
                self.cells.append([Cell() for _ in range(self.cols)])
            self.rows = rows
        if cols > self.cols:
            for row in self.cells:
                row.extend(Cell() for _ in range(cols - self.cols))
            self.cols = cols

    def clear_all(self) -> None:
        for row in self.cells:
            for i in range(len(row)):
                row[i] = Cell()

    def clear_to_end(self) -> None:
        if self.cursor_r >= self.rows:
            return
        row = self.cells[self.cursor_r]
        for x in range(self.cursor_c, len(row)):
            row[x] = Cell()
        for y in range(self.cursor_r + 1, self.rows):
            for x in range(len(self.cells[y])):
                self.cells[y][x] = Cell()

    def put(self, ch: str) -> None:
        if self.cursor_r < self.rows and self.cursor_c < self.cols:
            self.cells[self.cursor_r][self.cursor_c] = Cell(
                char=ch, bold=self.bold, dim=self.dim
            )
        self.cursor_c += 1

    def text(self) -> str:
        return "\n".join("".join(c.char for c in row) for row in self.cells)

    def leftover_outside(self, rows: int, cols: int) -> list[tuple[int, int, str]]:
        found = []
        for r, row in enumerate(self.cells):
            for c, cell in enumerate(row):
                if r < rows and c < cols:
                    continue
                if cell.char not in (" ", ""):
                    found.append((r, c, cell.char))
        return found


def apply_ansi(screen: Screen, data: str) -> list[str]:
    events: list[str] = []
    i = 0
    n = len(data)
    while i < n:
        ch = data[i]
        if ch == "\x1b":
            if i + 1 < n and data[i + 1] == "]":
                bel = data.find("\x07", i)
                st = data.find("\x1b\\", i)
                end = n
                if bel != -1:
                    end = bel + 1
                if st != -1:
                    end = min(end, st + 2)
                i = end
                continue
            if i + 1 < n and data[i + 1] == "[":
                j = i + 2
                while j < n and data[j] not in "ABCDEFGHJKSTZfmhl@":
                    if data[j].isalpha():
                        break
                    j += 1
                if j >= n:
                    break
                params = data[i + 2 : j]
                cmd = data[j]
                i = j + 1
                if cmd in "Hf":
                    parts = params.split(";")
                    r = int(parts[0] or "1") if parts and parts[0] else 1
                    c = int(parts[1] or "1") if len(parts) > 1 and parts[1] else 1
                    screen.cursor_r = max(0, r - 1)
                    screen.cursor_c = max(0, c - 1)
                    events.append(f"CUP {r},{c}")
                elif cmd == "J":
                    mode = int(params) if params else 0
                    events.append(f"ED {mode}")
                    if mode == 2:
                        screen.clear_all()
                    else:
                        screen.clear_to_end()
                elif cmd == "K":
                    mode = int(params) if params else 0
                    if screen.cursor_r < screen.rows:
                        row = screen.cells[screen.cursor_r]
                        if mode == 2:
                            for x in range(len(row)):
                                row[x] = Cell()
                        else:
                            start = 0 if mode == 1 else screen.cursor_c
                            end = screen.cursor_c + 1 if mode == 1 else len(row)
                            for x in range(start, end):
                                row[x] = Cell()
                elif cmd == "m":
                    codes = [int(p) if p else 0 for p in params.split(";")] if params else [0]
                    for code in codes:
                        if code == 0:
                            screen.bold = False
                            screen.dim = False
                        elif code == 1:
                            screen.bold = True
                            screen.dim = False
                        elif code == 2:
                            screen.dim = True
                continue
            i += 1
            continue
        if ch == "\n":
            screen.cursor_r += 1
            screen.cursor_c = 0
            i += 1
            continue
        if ch == "\r":
            screen.cursor_c = 0
            i += 1
            continue
        if ord(ch) < 32:
            i += 1
            continue
        screen.put(ch)
        i += 1
    return events


def set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def drain(fd: int, timeout: float = 0.05) -> bytes:
    chunks = []
    end = time.time() + timeout
    while True:
        remaining = end - time.time()
        if remaining <= 0:
            break
        ready, _, _ = select.select([fd], [], [], remaining)
        if not ready:
            break
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def spawn_mock(rows: int, cols: int) -> tuple[int, int]:
    master, slave = os.openpty()
    set_winsize(master, rows, cols)
    set_winsize(slave, rows, cols)
    pid = os.fork()
    if pid == 0:
        os.setsid()
        os.close(master)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        os.chdir(WORKTREE)
        os.execv(NODE, [NODE, str(CLI), "--mock", "--meteor-frequency", "0"])
    os.close(slave)
    return pid, master


def stop_child(pid: int, master: int) -> None:
    try:
        os.write(master, b"\x03")
        time.sleep(0.15)
        os.write(master, b"\x03")
        time.sleep(0.15)
    except OSError:
        pass
    try:
        os.kill(pid, signal.SIGTERM)
    except OSError:
        pass
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    try:
        os.close(master)
    except OSError:
        pass


def wait_for_frame(master: int, screen: Screen, seconds: float = 1.0) -> str:
    deadline = time.time() + seconds
    collected = []
    while time.time() < deadline:
        raw = drain(master, 0.1)
        if raw:
            text = raw.decode("utf-8", "replace")
            collected.append(text)
            apply_ansi(screen, text)
            if PROMPT_SNIPPET in screen.text():
                extra = drain(master, 0.25)
                if extra:
                    more = extra.decode("utf-8", "replace")
                    collected.append(more)
                    apply_ansi(screen, more)
                break
    return "".join(collected)


def count_erase(output: str) -> int:
    return output.count("\x1b[2J")


def html_from_screen(screen: Screen, title: str) -> str:
    lines = []
    for row in screen.cells:
        parts = ['<div class="row">']
        for cell in row:
            cls = []
            if cell.bold:
                cls.append("bold")
            if cell.dim:
                cls.append("dim")
            ch = cell.char if cell.char else " "
            escaped = (
                ch.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
            )
            if cls:
                parts.append(f'<span class="{" ".join(cls)}">{escaped}</span>')
            else:
                parts.append(escaped)
        parts.append("</div>")
        lines.append("".join(parts))
    body = "\n".join(lines)
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>{title}</title>
<style>
  html, body {{ background: #111318; color: #d7dce8; margin: 0; padding: 16px; }}
  h1 {{ font: 14px/1.4 ui-sans-serif, system-ui, sans-serif; color: #9aa3b5; margin: 0 0 12px; }}
  .term {{
    font: 13px/15px "Liberation Mono", "Noto Sans Mono", ui-monospace, monospace;
    white-space: pre;
    background: #0b0d12;
    border: 1px solid #2a2f3a;
    padding: 8px;
    width: max-content;
  }}
  .row {{ height: 15px; }}
  .bold {{ color: #f4f7ff; font-weight: 700; }}
  .dim {{ color: #6d7484; }}
</style>
</head><body>
<h1>{title}</h1>
<div class="term">{body}</div>
</body></html>
"""


def write_text(path: Path, text: str) -> None:
    path.write_text(text.rstrip("\n") + "\n", encoding="utf-8")


def cells_plain(screen: Screen, rows: int | None = None, cols: int | None = None) -> str:
    rows = rows or screen.rows
    cols = cols or screen.cols
    out = []
    for r in range(min(rows, screen.rows)):
        out.append("".join(screen.cells[r][c].char for c in range(min(cols, screen.cols))))
    return "\n".join(out)


def visible_status(text: str) -> dict[str, bool]:
    lowered = text.lower()
    return {
        "prompt": PROMPT_SNIPPET in lowered,
        "brand": "g n h f" in lowered or "gnhf" in lowered,
        "agent": "c o d e x" in lowered or "codex" in lowered,
        "commits": "commit" in lowered,
    }


def run_pty_scenarios() -> dict:
    results = {}
    pid, master = spawn_mock(*LARGE)
    screen = Screen(*LARGE)
    try:
        first = wait_for_frame(master, screen, 2.0)
        initial_text = screen.text()
        initial_status = visible_status(initial_text)
        write_text(EVIDENCE / "pty-initial-120x40.txt", cells_plain(screen, *LARGE))
        (EVIDENCE / "pty-initial-120x40.html").write_text(
            html_from_screen(screen, "Live TUI at 120x40 before resize"), encoding="utf-8"
        )

        # Shrink fullscreen -> smaller
        set_winsize(master, *SMALL)
        shrink_out = ""
        shrink_deadline = time.time() + 1.2
        while time.time() < shrink_deadline:
            raw = drain(master, 0.1)
            if raw:
                chunk = raw.decode("utf-8", "replace")
                shrink_out += chunk
                apply_ansi(screen, chunk)
            if count_erase(shrink_out):
                extra = drain(master, 0.3)
                if extra:
                    more = extra.decode("utf-8", "replace")
                    shrink_out += more
                    apply_ansi(screen, more)
                break
        leftover_small = screen.leftover_outside(*SMALL)
        shrink_status = visible_status(cells_plain(screen, *SMALL))
        write_text(EVIDENCE / "pty-after-shrink-80x24.txt", cells_plain(screen, *SMALL))
        write_text(EVIDENCE / "pty-after-shrink-full-buffer.txt", screen.text())
        (EVIDENCE / "pty-after-shrink-80x24.html").write_text(
            html_from_screen(Screen.__new__(Screen), "unused")
            if False
            else html_from_screen(screen, "After shrink to 80x24 (persistent 120x40 buffer)"),
            encoding="utf-8",
        )

        results["shrink"] = {
            "erase_count": count_erase(shrink_out),
            "leftover_outside_small": leftover_small[:20],
            "leftover_count": len(leftover_small),
            "status": shrink_status,
            "output_len": len(shrink_out),
        }

        # Restore smaller -> fullscreen
        set_winsize(master, *LARGE)
        restore_out = ""
        restore_deadline = time.time() + 1.2
        while time.time() < restore_deadline:
            raw = drain(master, 0.1)
            if raw:
                chunk = raw.decode("utf-8", "replace")
                restore_out += chunk
                apply_ansi(screen, chunk)
            if count_erase(restore_out):
                extra = drain(master, 0.3)
                if extra:
                    more = extra.decode("utf-8", "replace")
                    restore_out += more
                    apply_ansi(screen, more)
                break
        leftover_hash = [pos for pos in leftover_small if False]
        restore_status = visible_status(cells_plain(screen, *LARGE))
        write_text(EVIDENCE / "pty-after-restore-120x40.txt", cells_plain(screen, *LARGE))
        (EVIDENCE / "pty-after-restore-120x40.html").write_text(
            html_from_screen(screen, "After restore to 120x40"), encoding="utf-8"
        )
        results["restore"] = {
            "erase_count": count_erase(restore_out),
            "status": restore_status,
            "output_len": len(restore_out),
            "screen_has_prompt": PROMPT_SNIPPET in screen.text(),
        }

        # Adversarial width-only shrink
        set_winsize(master, *NARROW)
        narrow_out = ""
        narrow_deadline = time.time() + 1.2
        while time.time() < narrow_deadline:
            raw = drain(master, 0.1)
            if raw:
                chunk = raw.decode("utf-8", "replace")
                narrow_out += chunk
                apply_ansi(screen, chunk)
            if count_erase(narrow_out):
                extra = drain(master, 0.3)
                if extra:
                    more = extra.decode("utf-8", "replace")
                    narrow_out += more
                    apply_ansi(screen, more)
                break
        leftover_narrow = screen.leftover_outside(*NARROW)
        write_text(EVIDENCE / "pty-after-narrow-60x40.txt", cells_plain(screen, *NARROW))
        write_text(EVIDENCE / "pty-after-narrow-full-buffer.txt", screen.text())
        results["narrow"] = {
            "erase_count": count_erase(narrow_out),
            "leftover_count": len(leftover_narrow),
            "leftover_sample": leftover_narrow[:20],
            "status": visible_status(cells_plain(screen, *NARROW)),
        }

        # Tiny then restore
        set_winsize(master, *TINY)
        tiny_out = ""
        tiny_deadline = time.time() + 1.2
        while time.time() < tiny_deadline:
            raw = drain(master, 0.1)
            if raw:
                chunk = raw.decode("utf-8", "replace")
                tiny_out += chunk
                apply_ansi(screen, chunk)
            if count_erase(tiny_out):
                extra = drain(master, 0.3)
                if extra:
                    more = extra.decode("utf-8", "replace")
                    tiny_out += more
                    apply_ansi(screen, more)
                break
        leftover_tiny = screen.leftover_outside(*TINY)
        write_text(EVIDENCE / "pty-after-tiny-40x12.txt", cells_plain(screen, *TINY))
        results["tiny"] = {
            "erase_count": count_erase(tiny_out),
            "leftover_count": len(leftover_tiny),
            "status": visible_status(cells_plain(screen, *TINY)),
        }

        set_winsize(master, *LARGE)
        tiny_restore = ""
        tiny_restore_deadline = time.time() + 1.2
        while time.time() < tiny_restore_deadline:
            raw = drain(master, 0.1)
            if raw:
                chunk = raw.decode("utf-8", "replace")
                tiny_restore += chunk
                apply_ansi(screen, chunk)
            if count_erase(tiny_restore):
                extra = drain(master, 0.3)
                if extra:
                    more = extra.decode("utf-8", "replace")
                    tiny_restore += more
                    apply_ansi(screen, more)
                break
        write_text(EVIDENCE / "pty-after-tiny-restore-120x40.txt", cells_plain(screen, *LARGE))
        (EVIDENCE / "pty-after-tiny-restore-120x40.html").write_text(
            html_from_screen(screen, "After tiny 40x12 then restore to 120x40"),
            encoding="utf-8",
        )
        results["tiny_restore"] = {
            "erase_count": count_erase(tiny_restore),
            "status": visible_status(cells_plain(screen, *LARGE)),
        }

        results["initial"] = {
            "erase_count": count_erase(first),
            "status": initial_status,
        }
        results["first_bytes_preview"] = first[:80].encode("unicode_escape").decode()
    finally:
        stop_child(pid, master)
    return results


def capture_tmux() -> dict:
    sock = str(EVIDENCE / "tmux.sock")
    session = "gnhf-resize"
    env = os.environ.copy()
    env["PATH"] = "/home/jason/.local/share/mise/installs/node/26.8.1/bin:" + env.get("PATH", "")
    env["TERM"] = "xterm-256color"

    def tmux(*args: str) -> subprocess_result:
        import subprocess

        proc = subprocess.run(
            ["tmux", "-S", sock, *args],
            env=env,
            capture_output=True,
            text=True,
        )
        return proc

    import subprocess

    def subprocess_result(proc):  # type: ignore
        return proc

    tmux("kill-server")
    cmd = f"{NODE} {CLI} --mock --meteor-frequency 0"
    started = tmux(
        "new-session",
        "-d",
        "-s",
        session,
        "-x",
        "120",
        "-y",
        "40",
        "-c",
        str(WORKTREE),
        cmd,
    )
    if started.returncode != 0:
        return {
            "ok": False,
            "error": started.stderr,
            "stdout": started.stdout,
        }

    time.sleep(1.0)
    tmux("capture-pane", "-t", session, "-e", "-p")
    initial = tmux("capture-pane", "-t", session, "-e", "-p")
    initial_plain = tmux("capture-pane", "-t", session, "-p")
    write_text(EVIDENCE / "tmux-initial-120x40.txt", initial_plain.stdout)
    write_text(EVIDENCE / "tmux-initial-120x40.ansi", initial.stdout)

    tmux("resize-window", "-t", session, "-x", "80", "-y", "24")
    time.sleep(0.7)
    shrink = tmux("capture-pane", "-t", session, "-e", "-p")
    shrink_plain = tmux("capture-pane", "-t", session, "-p")
    write_text(EVIDENCE / "tmux-after-shrink-80x24.txt", shrink_plain.stdout)
    write_text(EVIDENCE / "tmux-after-shrink-80x24.ansi", shrink.stdout)

    tmux("resize-window", "-t", session, "-x", "120", "-y", "40")
    time.sleep(0.7)
    restore = tmux("capture-pane", "-t", session, "-e", "-p")
    restore_plain = tmux("capture-pane", "-t", session, "-p")
    write_text(EVIDENCE / "tmux-after-restore-120x40.txt", restore_plain.stdout)
    write_text(EVIDENCE / "tmux-after-restore-120x40.ansi", restore.stdout)

    tmux("kill-session", "-t", session)
    tmux("kill-server")
    try:
        os.remove(sock)
    except OSError:
        pass

    return {
        "ok": True,
        "initial_status": visible_status(initial_plain.stdout),
        "shrink_status": visible_status(shrink_plain.stdout),
        "restore_status": visible_status(restore_plain.stdout),
        "initial_lines": len(initial_plain.stdout.splitlines()),
        "shrink_lines": len(shrink_plain.stdout.splitlines()),
        "restore_lines": len(restore_plain.stdout.splitlines()),
        "start_stderr": started.stderr,
    }


def main() -> None:
    pty_results = run_pty_scenarios()
    tmux_results = capture_tmux()
    report = {"pty": pty_results, "tmux": tmux_results}
    (EVIDENCE / "live-resize-report.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
