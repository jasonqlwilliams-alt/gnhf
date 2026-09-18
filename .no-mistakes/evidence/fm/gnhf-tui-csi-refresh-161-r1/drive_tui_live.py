#!/usr/bin/env python3
"""Drive the built gnhf TUI live in a PTY for CSI sanitize + Ctrl+L + resize."""

from __future__ import annotations

import html
import json
import os
import pty
import select
import shutil
import signal
import struct
import subprocess
import sys
import termios
import time
import tty
from pathlib import Path

EVIDENCE = Path(__file__).resolve().parent
REPO = Path("/home/jason/.no-mistakes/worktrees/81d474556c1c/01M2TT68QE3QWWDEH6SK8Q3CZ1")
CLI = REPO / "dist" / "cli.mjs"
NODE = shutil.which("node") or "/home/jason/.local/share/mise/installs/node/22.23.2/bin/node"

CSI_MARK = "reading files"
CSI_TAIL = "stuck line"
CSI_PAYLOAD = ("\x1b[2J" * 50) + CSI_MARK + "\x1b[10;1H\x1b[A\r" + CSI_TAIL


class VirtualTerminal:
    def __init__(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.cursor_r = 0
        self.cursor_c = 0
        self.screen = [[" "] * cols for _ in range(rows)]
        self.title = ""
        self.erase_count = 0

    def resize(self, rows: int, cols: int) -> None:
        new = [[" "] * cols for _ in range(rows)]
        for r in range(min(self.rows, rows)):
            for c in range(min(self.cols, cols)):
                new[r][c] = self.screen[r][c]
        self.screen = new
        self.rows = rows
        self.cols = cols
        self.cursor_r = min(self.cursor_r, rows - 1)
        self.cursor_c = min(self.cursor_c, cols - 1)

    def snapshot(self) -> str:
        return "\n".join("".join(row).rstrip() for row in self.screen)

    def put(self, ch: str) -> None:
        if ch == "\n":
            self.cursor_r = min(self.rows - 1, self.cursor_r + 1)
            self.cursor_c = 0
            return
        if ch == "\r":
            self.cursor_c = 0
            return
        if ch == "\b":
            self.cursor_c = max(0, self.cursor_c - 1)
            return
        if ch == "\t":
            self.cursor_c = min(self.cols - 1, (self.cursor_c + 8) & ~7)
            return
        if ord(ch) < 32:
            return
        if 0 <= self.cursor_r < self.rows and 0 <= self.cursor_c < self.cols:
            self.screen[self.cursor_r][self.cursor_c] = ch
        self.cursor_c += 1
        if self.cursor_c >= self.cols:
            self.cursor_c = 0
            self.cursor_r = min(self.rows - 1, self.cursor_r + 1)

    def erase_display(self, mode: int) -> None:
        self.erase_count += 1
        if mode == 2 or mode == 3:
            self.screen = [[" "] * self.cols for _ in range(self.rows)]
            return
        # 0 = cursor to end
        if 0 <= self.cursor_r < self.rows:
            for c in range(self.cursor_c, self.cols):
                self.screen[self.cursor_r][c] = " "
            for r in range(self.cursor_r + 1, self.rows):
                self.screen[r] = [" "] * self.cols

    def feed(self, data: str) -> None:
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == "\x1b":
                i = self._consume_escape(data, i)
                continue
            self.put(ch)
            i += 1

    def _consume_escape(self, data: str, i: int) -> int:
        if i + 1 >= len(data):
            return i + 1
        kind = data[i + 1]
        if kind == "]":
            j = i + 2
            while j < len(data) and data[j] not in "\x07":
                if data[j] == "\x1b" and j + 1 < len(data) and data[j + 1] == "\\":
                    j += 2
                    return j
                j += 1
            if j < len(data) and data[j] == "\x07":
                payload = data[i + 2 : j]
                if payload.startswith("2;"):
                    self.title = payload[2:]
                return j + 1
            return j
        if kind == "[":
            j = i + 2
            while j < len(data) and not ("@" <= data[j] <= "~"):
                j += 1
            if j >= len(data):
                return len(data)
            final = data[j]
            params = data[i + 2 : j]
            self._csi(params, final)
            return j + 1
        # other ESC sequences: skip ESC + next byte
        return i + 2

    def _csi(self, params: str, final: str) -> None:
        if final in "hl" and params.startswith("?"):
            return
        if final == "t":
            return
        nums = []
        if params and params[0] != "?":
            for part in params.split(";"):
                if part.isdigit():
                    nums.append(int(part))
                elif part == "":
                    nums.append(0)
        if final == "H" or final == "f":
            row = (nums[0] if nums else 1) or 1
            col = (nums[1] if len(nums) > 1 else 1) or 1
            self.cursor_r = min(self.rows - 1, max(0, row - 1))
            self.cursor_c = min(self.cols - 1, max(0, col - 1))
            return
        if final == "J":
            self.erase_display(nums[0] if nums else 0)
            return
        if final == "K":
            if 0 <= self.cursor_r < self.rows:
                start = 0 if (nums and nums[0] == 1) else self.cursor_c
                end = self.cols if (not nums or nums[0] != 1) else self.cursor_c
                if nums and nums[0] == 2:
                    start, end = 0, self.cols
                for c in range(start, end):
                    self.screen[self.cursor_r][c] = " "
            return
        if final == "A":
            self.cursor_r = max(0, self.cursor_r - (nums[0] if nums else 1 or 1))
            return
        if final == "B":
            self.cursor_r = min(self.rows - 1, self.cursor_r + (nums[0] if nums else 1 or 1))
            return
        if final == "C":
            self.cursor_c = min(self.cols - 1, self.cursor_c + (nums[0] if nums else 1 or 1))
            return
        if final == "D":
            self.cursor_c = max(0, self.cursor_c - (nums[0] if nums else 1 or 1))
            return
        # SGR and others ignored


class PtySession:
    def __init__(self, argv: list[str], env: dict[str, str], rows: int, cols: int, cwd: str) -> None:
        self.rows = rows
        self.cols = cols
        self.vt = VirtualTerminal(rows, cols)
        self.raw = bytearray()
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            os.chdir(cwd)
            os.environ.clear()
            os.environ.update(env)
            os.execv(argv[0], argv)
        self._set_winsize(rows, cols)

    def _set_winsize(self, rows: int, cols: int) -> None:
        packed = struct.pack("HHHH", rows, cols, 0, 0)
        import fcntl

        fcntl.ioctl(self.master, termios.TIOCSWINSZ, packed)
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def resize(self, rows: int, cols: int) -> None:
        self.rows = rows
        self.cols = cols
        self.vt.resize(rows, cols)
        self._set_winsize(rows, cols)

    def write(self, data: bytes) -> None:
        os.write(self.master, data)

    def poll(self, timeout: float) -> bool:
        ready, _, _ = select.select([self.master], [], [], timeout)
        if not ready:
            return self.alive()
        try:
            chunk = os.read(self.master, 65536)
        except OSError:
            return False
        if not chunk:
            return False
        self.raw.extend(chunk)
        self.vt.feed(chunk.decode("utf-8", "replace"))
        return True

    def drain(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if not self.poll(min(0.05, max(0.0, remaining))):
                if not self.alive():
                    break

    def wait_until(self, pred, timeout: float, interval: float = 0.05) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if pred():
                return True
            self.poll(interval)
        return pred()

    def alive(self) -> bool:
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            if pid == 0:
                return True
            return False
        except ChildProcessError:
            return False

    def close(self, timeout: float = 3.0) -> int:
        if self.alive():
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + timeout
        status = 0
        while time.monotonic() < deadline:
            try:
                pid, st = os.waitpid(self.pid, os.WNOHANG)
                if pid != 0:
                    status = st
                    break
            except ChildProcessError:
                break
            self.poll(0.05)
        else:
            try:
                os.kill(self.pid, signal.SIGKILL)
                os.waitpid(self.pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass
        try:
            os.close(self.master)
        except OSError:
            pass
        return status


def decode_text(raw: bytes) -> str:
    return raw.decode("utf-8", "replace")


def has_full_erase(raw: str) -> bool:
    return "\x1b[2J\x1b[H" in raw


def count_full_erase(raw: str) -> int:
    return raw.count("\x1b[2J\x1b[H")


def visible(text: str, needle: str) -> bool:
    return needle in text


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def render_html(frames: list[tuple[str, str]], raw_notes: list[tuple[str, str]]) -> str:
    blocks = []
    for title, screen in frames:
        blocks.append(
            f"<section><h2>{html.escape(title)}</h2>"
            f'<pre class="term">{html.escape(screen)}</pre></section>'
        )
    notes = "".join(
        f"<h3>{html.escape(title)}</h3><pre class='raw'>{html.escape(body)}</pre>"
        for title, body in raw_notes
    )
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>gnhf TUI CSI / Ctrl+L live evidence</title>
<style>
  body {{ background:#0b1020; color:#d7e0f2; font-family: ui-sans-serif, system-ui, sans-serif; margin:24px; }}
  h1,h2,h3 {{ font-weight:600; }}
  .term {{ background:#070b14; color:#c8d4ea; padding:16px 18px; border-radius:10px;
           font: 14px/1.25 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
           white-space:pre; overflow:auto; border:1px solid #223049; min-height: 280px; }}
  .raw {{ background:#111827; color:#9ca3af; padding:12px; font:12px/1.4 ui-monospace,monospace;
          white-space:pre-wrap; word-break:break-all; max-height:220px; overflow:auto; }}
</style></head>
<body>
<h1>gnhf live TUI: CSI sanitize and Ctrl+L refresh</h1>
<p>Captured from the real <code>dist/cli.mjs</code> process in a PTY.</p>
{''.join(blocks)}
{notes}
</body></html>
"""


def make_temp_home(root: Path) -> Path:
    home = root / "home"
    gnhf = home / ".gnhf"
    gnhf.mkdir(parents=True)
    return home


def make_repo(root: Path) -> Path:
    repo = root / "repo"
    repo.mkdir()
    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
    }
    subprocess.check_call(["git", "init", "-b", "main"], cwd=repo, env=env)
    subprocess.check_call(["git", "config", "user.name", "gnhf live"], cwd=repo, env=env)
    subprocess.check_call(["git", "config", "user.email", "live@example.com"], cwd=repo, env=env)
    (repo / "README.md").write_text("# live fixture\n", encoding="utf-8")
    subprocess.check_call(["git", "add", "README.md"], cwd=repo, env=env)
    subprocess.check_call(["git", "commit", "-m", "init"], cwd=repo, env=env)
    return repo


def write_fake_claude(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const csi = "\\u001b[2J".repeat(50) + "reading files\\u001b[10;1H\\u001b[A\\rstuck line";
process.stdout.write(
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg-csi",
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text: csi }],
    },
  }) + "\\n",
);

const holdMs = Number(process.env.GNHF_LIVE_HOLD_MS || "3500");
await new Promise((resolve) => setTimeout(resolve, holdMs));

writeFileSync(join(process.cwd(), "csi-survived.txt"), "work was not lost\\n", "utf8");

process.stdout.write(
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    total_cost_usd: 0,
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    structured_output: {
      success: true,
      summary: "kept working after CSI lastMessage",
      key_changes_made: ["added csi-survived.txt"],
      key_learnings: [],
    },
  }) + "\\n",
);
process.exit(0);
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def base_env(home: Path, extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {
        "HOME": str(home),
        "USERPROFILE": str(home),
        "PATH": os.environ.get("PATH", ""),
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "GNHF_TELEMETRY": "0",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_SYSTEM": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "CI": "",
        "NO_COLOR": "",
    }
    if extra:
        env.update(extra)
    return env


def run_mock() -> dict:
    work = EVIDENCE / "scratch-mock"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    home = make_temp_home(work)
    session = PtySession(
        [NODE, str(CLI), "--mock", "--meteor-frequency", "0"],
        base_env(home),
        24,
        80,
        str(work),
    )
    try:
        ok_frame = session.wait_until(
            lambda: "g n h f" in session.vt.snapshot()
            and "minimize app startup latency" in session.vt.snapshot(),
            4.0,
        )
        before = session.vt.snapshot()
        raw_before = decode_text(bytes(session.raw))
        erase_before = count_full_erase(raw_before)
        session.write(b"\x0c")  # Ctrl+L
        session.drain(0.6)
        after_ctrl = session.vt.snapshot()
        raw_after_ctrl = decode_text(bytes(session.raw))
        ctrl_slice = raw_after_ctrl[len(raw_before) :]
        ctrl_erased = has_full_erase(ctrl_slice)
        still_running = "minimize app startup latency" in after_ctrl and "g n h f" in after_ctrl
        mark = len(session.raw)
        session.drain(0.35)
        tick_slice = decode_text(bytes(session.raw[mark:]))
        later_tick_erased = has_full_erase(tick_slice)

        session.resize(18, 60)
        resize_mark = len(session.raw)
        session.drain(0.55)
        raw_resize = decode_text(bytes(session.raw[resize_mark:]))
        after_resize = session.vt.snapshot()
        resize_erased = has_full_erase(raw_resize)
        resize_kept_prompt = "minimize app startup" in after_resize or "startup latency" in after_resize

        # Ctrl+C should still interrupt (not stolen by Ctrl+L handler)
        session.write(b"\x03")
        session.drain(0.4)
        session.write(b"\x03")
        session.drain(0.8)

        write_text(EVIDENCE / "mock-before-ctrl-l.txt", before + "\n")
        write_text(EVIDENCE / "mock-after-ctrl-l.txt", after_ctrl + "\n")
        write_text(EVIDENCE / "mock-after-resize.txt", after_resize + "\n")
        write_text(EVIDENCE / "mock-ctrl-l-bytes.txt", repr(ctrl_slice[:400]))
        write_text(EVIDENCE / "mock-resize-bytes.txt", repr(raw_resize[:400]))

        return {
            "first_frame": ok_frame,
            "ctrl_l_erase": ctrl_erased,
            "ctrl_l_kept_tui": still_running,
            "later_tick_no_erase": not later_tick_erased,
            "resize_erase": resize_erased,
            "resize_kept_prompt": resize_kept_prompt,
            "erase_before_ctrl_l": erase_before,
            "before": before,
            "after_ctrl": after_ctrl,
            "after_resize": after_resize,
            "ctrl_slice": ctrl_slice,
            "resize_slice": raw_resize,
        }
    finally:
        session.close()


def run_csi_commit() -> dict:
    work = EVIDENCE / "scratch-csi"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    home = make_temp_home(work)
    repo = make_repo(work)
    fake = work / "fake-claude.mjs"
    write_fake_claude(fake)
    (home / ".gnhf" / "config.yml").write_text(
        "agent: claude\n"
        "preventSleep: false\n"
        "agentPathOverride:\n"
        f"  claude: {fake}\n",
        encoding="utf-8",
    )

    session = PtySession(
        [
            NODE,
            str(CLI),
            "keep the run alive through CSI lastMessage",
            "--agent",
            "claude",
            "--current-branch",
            "--max-iterations",
            "1",
            "--prevent-sleep",
            "off",
            "--meteor-frequency",
            "0",
        ],
        base_env(home, {"GNHF_LIVE_HOLD_MS": "3500"}),
        24,
        80,
        str(repo),
    )
    try:
        saw_message = session.wait_until(
            lambda: CSI_MARK in session.vt.snapshot() and CSI_TAIL in session.vt.snapshot(),
            6.0,
        )
        screen_after_csi = session.vt.snapshot()
        raw_after_csi = decode_text(bytes(session.raw))
        leaked_erase_in_message = raw_after_csi.count("\x1b[2J") > count_full_erase(raw_after_csi)
        leaked_cup = "\x1b[10;1H" in raw_after_csi
        leaked_cuu = "\x1b[A" in raw_after_csi
        title_survived = "g n h f" in screen_after_csi
        prompt_survived = "keep the run alive" in screen_after_csi
        stats_survived = "i n" in screen_after_csi or "o u t" in screen_after_csi

        raw_before_l = decode_text(bytes(session.raw))
        session.write(b"\x0c")
        session.drain(0.5)
        screen_after_l = session.vt.snapshot()
        ctrl_slice = decode_text(bytes(session.raw))[len(raw_before_l) :]
        ctrl_erased = has_full_erase(ctrl_slice)
        still_shows_message = CSI_MARK in screen_after_l and CSI_TAIL in screen_after_l
        still_shows_chrome = "g n h f" in screen_after_l

        # Let the fake agent finish and the run commit, then stop if still up.
        finished = session.wait_until(lambda: not session.alive(), 12.0)
        if session.alive():
            session.write(b"\x03")
            session.drain(0.4)
            session.write(b"\x03")
            session.drain(1.0)

        log_text = decode_text(bytes(session.raw))
        write_text(EVIDENCE / "csi-after-message.txt", screen_after_csi + "\n")
        write_text(EVIDENCE / "csi-after-ctrl-l.txt", screen_after_l + "\n")
        write_text(EVIDENCE / "csi-raw-excerpt.txt", repr(raw_after_csi[:800]))

        survived = repo / "csi-survived.txt"
        commits = subprocess.check_output(
            ["git", "log", "--oneline"],
            cwd=repo,
            text=True,
        )
        committed = survived.is_file() and "gnhf 1:" in commits
        return {
            "saw_sanitized_message": saw_message,
            "title_survived": title_survived,
            "prompt_survived": prompt_survived,
            "stats_survived": stats_survived,
            "leaked_erase_in_message": leaked_erase_in_message,
            "leaked_cup": leaked_cup,
            "leaked_cuu": leaked_cuu,
            "ctrl_l_erase": ctrl_erased,
            "ctrl_l_kept_message": still_shows_message,
            "ctrl_l_kept_chrome": still_shows_chrome,
            "committed": committed,
            "commits": commits,
            "survived_file": survived.is_file(),
            "survived_text": survived.read_text(encoding="utf-8") if survived.is_file() else "",
            "finished": finished or (not session.alive()),
            "screen_after_csi": screen_after_csi,
            "screen_after_l": screen_after_l,
        }
    finally:
        session.close()


def screenshot(html_path: Path, png_path: Path) -> None:
    subprocess.check_call(
        [
            "chromium",
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--window-size=1100,1600",
            f"--screenshot={png_path}",
            html_path.as_uri(),
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> int:
    if not CLI.is_file():
        print("missing dist/cli.mjs", file=sys.stderr)
        return 2
    mock = run_mock()
    csi = run_csi_commit()

    frames = [
        ("--mock before Ctrl+L", mock["before"]),
        ("--mock after Ctrl+L (full erase-then-redraw)", mock["after_ctrl"]),
        ("--mock after shrink (resize erase kept)", mock["after_resize"]),
        ("live run: CSI lastMessage sanitized", csi["screen_after_csi"]),
        ("live run: Ctrl+L after CSI lastMessage", csi["screen_after_l"]),
    ]
    html_path = EVIDENCE / "tui-live.html"
    write_text(
        html_path,
        render_html(
            frames,
            [
                ("Ctrl+L byte slice", mock["ctrl_slice"][:500]),
                ("resize byte slice", mock["resize_slice"][:500]),
                ("git log after CSI run", csi["commits"]),
            ],
        ),
    )
    png_path = EVIDENCE / "tui-live.png"
    screenshot(html_path, png_path)

    result = {
        "mock": {
            k: v
            for k, v in mock.items()
            if k
            not in {"before", "after_ctrl", "after_resize", "ctrl_slice", "resize_slice"}
        },
        "csi": {
            k: v
            for k, v in csi.items()
            if k not in {"screen_after_csi", "screen_after_l"}
        },
    }
    write_text(EVIDENCE / "live-results.json", json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))

    mock_ok = all(
        [
            mock["first_frame"],
            mock["ctrl_l_erase"],
            mock["ctrl_l_kept_tui"],
            mock["later_tick_no_erase"],
            mock["resize_erase"],
            mock["resize_kept_prompt"],
        ]
    )
    csi_ok = all(
        [
            csi["saw_sanitized_message"],
            csi["title_survived"],
            csi["prompt_survived"],
            not csi["leaked_erase_in_message"],
            not csi["leaked_cup"],
            not csi["leaked_cuu"],
            csi["ctrl_l_erase"],
            csi["ctrl_l_kept_message"],
            csi["committed"],
        ]
    )
    return 0 if mock_ok and csi_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
