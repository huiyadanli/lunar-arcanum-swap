#!/usr/bin/env python3
"""Convert the source card PNGs (docs/assets/cards, ~700KB each) into the
WebP sizes the site uses (design doc 12.3).

Usage:  python3 scripts/build-assets.py
Output: assets/cards/<id>-<slug>-<width>.webp  (widths 160 / 360 / 684)

Pure Python + Pillow so asset regeneration runs independently of Vite;
the Vite build consumes the generated WebP files directly.
"""
from pathlib import Path
import re
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "assets" / "cards"
OUT = ROOT / "assets" / "cards"
WIDTHS = (160, 360, 684)
QUALITY = 80

ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI",
         "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
         "XXI", "XXII"]
NAME_RE = re.compile(r"^Lunar_Arcanum_([IVX]+)_(.+)\.png$")


def slugify(name: str) -> str:
    return name.lower().replace("_", "-")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    files = sorted(SRC.glob("Lunar_Arcanum_*.png"))
    if len(files) != 22:
        print(f"expected 22 card PNGs in {SRC}, found {len(files)}", file=sys.stderr)
        return 1
    total = 0
    for f in files:
        m = NAME_RE.match(f.name)
        if not m:
            print(f"skip unexpected file {f.name}", file=sys.stderr)
            continue
        card_id = ROMAN.index(m.group(1)) + 1
        slug = slugify(m.group(2))
        src = Image.open(f).convert("RGBA")
        for w in WIDTHS:
            h = round(src.height * w / src.width)
            img = src if w == src.width else src.resize((w, h), Image.LANCZOS)
            dest = OUT / f"{card_id:02d}-{slug}-{w}.webp"
            img.save(dest, "WEBP", quality=QUALITY, method=6)
            total += dest.stat().st_size
    print(f"wrote {len(files) * len(WIDTHS)} files to {OUT.relative_to(ROOT)}, "
          f"{total / 1024:.0f} KB total")
    return 0


if __name__ == "__main__":
    sys.exit(main())
