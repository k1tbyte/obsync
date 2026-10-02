"""Frames of a demo webp from docs/demos, into artifacts/demos/hero-src.

sheet NAME [COUNT]: a contact sheet with frame numbers. save NAME INDEX: one frame as NAME.png.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageSequence

ROOT = Path(__file__).parents[2]
OUT = ROOT / "artifacts/demos/hero-src"


def frames(name):
    image = Image.open(ROOT / f"docs/demos/{name}.webp")
    return [frame.convert("RGB") for frame in ImageSequence.Iterator(image)]


def sheet(name, count=16):
    count = int(count)
    all_frames = frames(name)
    step = max(1, len(all_frames) // count)
    picked = list(range(0, len(all_frames), step))[:count]
    width = 480
    height = int(all_frames[0].height * width / all_frames[0].width)
    cols = 4
    rows = (len(picked) + cols - 1) // cols
    out = Image.new("RGB", (cols * width, rows * height))
    draw = ImageDraw.Draw(out)
    for slot, index in enumerate(picked):
        x, y = (slot % cols) * width, (slot // cols) * height
        out.paste(all_frames[index].resize((width, height)), (x, y))
        draw.rectangle((x, y, x + 46, y + 14), fill="black")
        draw.text((x + 3, y + 1), str(index), fill="yellow")
    OUT.mkdir(parents=True, exist_ok=True)
    out.save(OUT / f"sheet-{name}.png")


def save(name, index):
    OUT.mkdir(parents=True, exist_ok=True)
    frames(name)[int(index)].save(OUT / f"{name}.png")


if __name__ == "__main__":
    command, *args = sys.argv[1:]
    {"sheet": sheet, "save": save}[command](*args)
