"""The 1200x800 screenshots of the community.obsidian.md listing: a demo frame on the hero background.

Frame indexes belong to one recording; after a re-record pick new ones with `frames.py sheet NAME`.
"""

import os
import subprocess
from pathlib import Path
from urllib.parse import urlencode

from PIL import Image

ROOT = Path(__file__).parents[2]
OUT = ROOT / "artifacts/listing"
TEMPLATE = Path(__file__).with_name("listing.html")
CHROME = os.environ.get("CHROME", "C:/Program Files/Google/Chrome/Application/chrome.exe")

# (file, demo, frame, title, subtitle)
SHOTS = [
    ("1-source-control", "changes", 24, "Source control for your vault", "Local and remote changes in one panel, with a diff for every file."),
    ("2-merge", "merge", 99, "Merge conflicts in three panes", "Edits that do not overlap merge on their own. Resolve the rest side by side."),
    ("3-history", "history", 114, "Every version of a note", "Compare saved versions, pin the ones that matter, restore any of them."),
    ("4-timeline", "timeline", 90, "Put the whole vault back", "A timeline of every push, with a restore to any point in it."),
    ("5-live", "live", 112, "Edit together in real time", "Two devices work on the same note live, through your own relay."),
]


def render(name, demo, index, title, sub):
    image = Image.open(ROOT / f"docs/demos/{demo}.webp")
    image.seek(index)
    frame = OUT / "src" / f"{demo}.png"
    frame.parent.mkdir(parents=True, exist_ok=True)
    image.convert("RGB").save(frame)
    query = urlencode({"img": frame.as_uri(), "title": title, "sub": sub})
    subprocess.run(
        [
            CHROME,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--window-size=1200,800",
            "--force-device-scale-factor=1",
            f"--screenshot={OUT / f'{name}.png'}",
            f"{TEMPLATE.as_uri()}?{query}",
        ],
        check=True,
        capture_output=True,
    )


for shot in SHOTS:
    render(*shot)
