#!/usr/bin/env python3
from __future__ import annotations

import html
from pathlib import Path

EVIDENCE = Path("/home/jason/.no-mistakes/evidence/01M2V8MP0QZD9XPSSRPEBN4WSB")

FRAMES = [
    ("live-40x80-folded.txt", "Default folded TUI (80x40)", "gnhf --mock"),
    ("live-40x80-unfolded.txt", "Ctrl+O unfolded TUI (80x40)", "gnhf --mock"),
    ("live-40x80-folded-esc.txt", "Escape folds the log again (80x40)", "gnhf --mock"),
    (
        "live-40x80-unfolded-ctrl-c.txt",
        "Ctrl+C still requests graceful stop while unfolded",
        "gnhf --mock",
    ),
    ("live-24x80-folded.txt", "Folded TUI on a 24-row terminal", "gnhf --mock"),
    ("live-24x80-unfolded.txt", "Unfolded TUI on a 24-row terminal", "gnhf --mock"),
    (
        "live-24x80-long-folded.txt",
        "Folded 30-line lastMessage on 24 rows",
        "Renderer TUI",
    ),
    (
        "live-24x80-long-unfolded.txt",
        "Unfolded 30-line lastMessage stays 24 rows",
        "Renderer TUI",
    ),
]

PAGE_CSS = """
:root { color-scheme: dark; }
body {
  margin: 0;
  background: #0b0d12;
  color: #d7dde8;
  font-family: "Liberation Sans", "Noto Sans", sans-serif;
}
main { max-width: 980px; margin: 0 auto; padding: 28px 20px 48px; }
h1 { font-size: 22px; margin: 0 0 8px; }
.sub { color: #8b95a8; margin: 0 0 28px; }
section { margin: 0 0 36px; }
h2 { font-size: 16px; margin: 0 0 6px; }
.meta { color: #8b95a8; font-size: 13px; margin: 0 0 12px; }
.term {
  background: #11141c;
  border: 1px solid #2a3140;
  border-radius: 10px;
  padding: 14px 12px;
  overflow: auto;
}
pre {
  margin: 0;
  font: 13px/1.35 "Liberation Mono", "Noto Sans Mono", monospace;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0;
  white-space: pre;
  color: #e8eef7;
}
"""


def frame_html(path: Path) -> str:
    text = path.read_text().rstrip("\n")
    return f'<div class="term"><pre>{html.escape(text)}</pre></div>'


def write_page(name: str, title: str, source: str, path: Path) -> None:
    body = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{html.escape(title)}</title>
  <style>{PAGE_CSS}</style>
</head>
<body>
  <main>
    <h1>{html.escape(title)}</h1>
    <p class="meta">{html.escape(source)}</p>
    {frame_html(path)}
  </main>
</body>
</html>
"""
    (EVIDENCE / name).write_text(body)


def main() -> None:
    sections = []
    for filename, title, source in FRAMES:
        path = EVIDENCE / filename
        write_page(filename.replace(".txt", ".html"), title, source, path)
        sections.append(
            f"<section><h2>{html.escape(title)}</h2>"
            f'<p class="meta">{html.escape(source)} · {html.escape(filename)}</p>'
            f"{frame_html(path)}</section>"
        )
    gallery = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>gnhf TUI live log unfold</title>
  <style>{PAGE_CSS}</style>
</head>
<body>
  <main>
    <h1>gnhf TUI live log unfold</h1>
    <p class="sub">Live frames from the running product: default three-line fold, Ctrl+O unfold, Escape fold, Ctrl+C still stops, and a 24-row clamp when lastMessage is long enough to overflow.</p>
    {"".join(sections)}
  </main>
</body>
</html>
"""
    (EVIDENCE / "tui-unfold-gallery.html").write_text(gallery)


if __name__ == "__main__":
    main()
