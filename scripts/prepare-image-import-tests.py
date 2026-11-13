#!/usr/bin/env python3
"""把本地样图和变体解码为RGBA，供实际JavaScript识别核心回归。

只负责生成输入和人工答案，不运行识别算法。依赖开发期Pillow。
"""
import argparse
from io import BytesIO
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent


def variants(name, source):
    yield f"{name}:original", source
    for width in (320, 480, 720, 1280, 1920):
        yield f"{name}:width-{width}", source.resize((width, round(source.height * width / source.width)), Image.Resampling.BILINEAR)
    buffer = BytesIO()
    source.save(buffer, "JPEG", quality=50)
    buffer.seek(0)
    with Image.open(buffer) as opened:
        yield f"{name}:jpeg-50", opened.convert("RGB")
    yield f"{name}:no-header-footer", source.crop((0, round(source.height * 0.04), source.width, round(source.height * 0.96)))
    padding = round(source.width * 0.10)
    padded = Image.new("RGB", (source.width + padding * 2, source.height + padding * 3), "#171c31")
    padded.paste(source, (padding, padding * 2))
    yield f"{name}:padded", padded
    gap = round(source.width * 0.07)
    cut = round(source.height * 0.5)
    spaced = Image.new("RGB", (source.width, source.height + gap), "#171c31")
    spaced.paste(source.crop((0, 0, source.width, cut)), (0, 0))
    spaced.paste(source.crop((0, cut, source.width, source.height)), (0, cut + gap))
    yield f"{name}:row-gap", spaced


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = []

    def save(label, image, expected):
        working = image.resize((540, round(image.height * 540 / image.width)), Image.Resampling.BILINEAR).convert("RGBA")
        filename = f"{len(manifest):02d}.rgba"
        (args.out / filename).write_bytes(working.tobytes())
        manifest.append({"name": label, "file": filename, "width": working.width, "height": working.height, "expected": expected})

    first_answer = None
    for name, fixture in (("mine.jpeg", "miyoushe-box-v1.expected.json"), ("2.jpg", "miyoushe-box-second.expected.json"), ("3.png", "miyoushe-box-third.expected.json")):
        answer = json.loads((ROOT / "docs" / "fixtures" / fixture).read_text(encoding="utf-8"))["counts"]
        with Image.open(ROOT / "docs" / "assets" / name) as opened:
            source = opened.convert("RGB")
        if first_answer is None:
            first_answer = answer
            original = source.resize((540, round(source.height * 540 / source.width)), Image.Resampling.BILINEAR)
        for label, image in variants(name, source):
            save(label, image, answer)

    # 这些坐标来自人工已核对的历史检测记录，仅用于制造遮挡和数字变体。
    # 不向JavaScript核心提供牌框位置，核心必须重新从像素识别。
    record = json.loads((ROOT / "docs" / "fixtures" / "miyoushe-box-flexible.validation.json").read_text(encoding="utf-8"))
    cards = record["variants"]["mine.jpeg:original"]["cards"]
    blank = Image.new("RGB", (720, 1280), "#171c31")
    save("blank-invalid", blank, [None] * 22)
    partial = original.copy()
    x, y, width, height = next(card["box"] for card in cards if card["id"] == 5)
    ImageDraw.Draw(partial).rectangle((x - 3, y - 3, x + width + 3, y + height + 3), fill="#171c31")
    answer = first_answer.copy()
    answer[4] = None
    save("one-frame-removed", partial, answer)

    for label, sample_id, answer in (("all-owned", 4, [1] * 22), ("all-missing", 1, [0] * 22)):
        synthetic = original.copy()
        x, y, width, height = next(card["box"] for card in cards if card["id"] == sample_id)
        sample = original.crop((x, y, x + width, y + height))
        for card in cards:
            x, y, width, height = card["box"]
            synthetic.paste(sample.resize((width, height), Image.Resampling.BILINEAR), (x, y))
        save(label, synthetic, answer)

    for glyph in ("3", "8"):
        synthetic = original.copy()
        x, y, width, height = next(card["box"] for card in cards if card["id"] == 6)
        cx, cy = round(x + width * 0.87), round(y + height * 0.055)
        draw = ImageDraw.Draw(synthetic)
        draw.ellipse((cx - 12, cy - 12, cx + 12, cy + 12), fill="#2c315d")
        draw.text((cx, cy - 1), glyph, font=ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 20), fill="white", anchor="mm")
        answer = first_answer.copy()
        answer[5] = None
        save(f"unknown-digit-{glyph}", synthetic, answer)

    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"prepared {len(manifest)} pixel fixtures")


if __name__ == "__main__":
    main()
