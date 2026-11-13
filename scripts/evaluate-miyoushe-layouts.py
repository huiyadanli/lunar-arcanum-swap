#!/usr/bin/env python3
"""对比两张米游社导出图的布局，并验证颜色统计替代牌背纹理匹配。

开发期验证，只有 Pillow 依赖，不接入网页，也不重写 v1 素材。
运行：python scripts/evaluate-miyoushe-layouts.py
"""

from io import BytesIO
import importlib.util
import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent.parent
WORK_SIZE = (540, 3808)
EXPECTED_SECOND = [0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0]
STRIPS = [[8, 130, 4, 160], [144, 130, 4, 160]]


def load_preparer():
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("miyoushe_prepare", ROOT / "scripts" / "prepare-miyoushe-import.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def frame_color(image, card_id, preparer):
    column, row = (card_id - 1) % 3, (card_id - 1) // 3
    x = preparer.rounded((46 + 337 * column) / 2)
    y = preparer.rounded((362 + 879 * row) / 2)
    strips = []
    for dx, dy, width, height in STRIPS:
        values = preparer.pixels(image.crop((x + dx, y + dy, x + dx + width, y + dy + height)))
        blue = sum(b - r > 35 and g - r > 15 and b > 120 for r, g, b in values) / len(values)
        neutral = sum(max(rgb) - min(rgb) < 35 and sum(rgb) / 3 > 115 for rgb in values) / len(values)
        state = "missing" if blue >= 0.65 and neutral <= 0.20 else "owned" if neutral >= 0.65 and blue <= 0.20 else "review"
        strips.append({"blueFraction": blue, "silverFraction": neutral, "state": state})
    state = strips[0]["state"] if strips[0]["state"] == strips[1]["state"] else "review"
    return {"id": card_id, "state": state, "strips": strips}


def evaluate(image, expected, manifest, preparer):
    # 高宽分别归一化，消除跨设备导出时微小的非等比例差异。
    working = image.resize(WORK_SIZE, Image.Resampling.BILINEAR)
    original_aspect_valid = abs((image.height / image.width) / (7616 / 1080) - 1) <= 0.01
    template_result = preparer.verify_image(working, manifest)
    layout_valid = original_aspect_valid and template_result["layoutValid"]
    colors = [frame_color(working, card_id, preparer) for card_id in range(1, 23)]
    counts = []
    for card_id, color in enumerate(colors, start=1):
        count = None
        if layout_valid:
            # 布局与角标继续复用已有的小模板，只替换牌背判断。
            match = template_result["cards"][card_id - 1]
            ring = match["ringMae"]
            is_two = match["two"]["ncc"] >= 0.92 and match["two"]["mae"] <= 0.10
            if color["state"] == "missing" and ring >= 0.14 and not is_two:
                count = 0
            elif color["state"] == "owned" and ring <= 0.09 and is_two:
                count = 2
            elif color["state"] == "owned" and ring >= 0.14 and not is_two:
                count = 1
        counts.append(count)
    missing_strips = [strip for color in colors if expected[color["id"] - 1] == 0 for strip in color["strips"]]
    owned_strips = [strip for color in colors if expected[color["id"] - 1] > 0 for strip in color["strips"]]
    return {
        "sourceSize": list(image.size), "layoutValid": layout_valid,
        "templateAfterXYNormalizationCounts": template_result["counts"],
        "colorCounts": counts, "matchesExpected": counts == expected,
        "ownedTypes": sum(count > 0 for count in counts if count is not None),
        "totalCards": sum(count for count in counts if count is not None),
        "colorSeparation": {
            "missingBlueFractionMinPerStrip": min(strip["blueFraction"] for strip in missing_strips),
            "missingSilverFractionMaxPerStrip": max(strip["silverFraction"] for strip in missing_strips),
            "ownedBlueFractionMaxPerStrip": max(strip["blueFraction"] for strip in owned_strips),
            "ownedSilverFractionMinPerStrip": min(strip["silverFraction"] for strip in owned_strips),
        },
        "anchorsAfterXYNormalization": template_result["anchors"],
    }


def preview(images, preparer):
    # 只展示牌框局部，排除玩家昵称、UID 和二维码。
    panel = Image.new("RGB", (1100, 390), "#171c31")
    draw = ImageDraw.Draw(panel)
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 18) if font_path.exists() else ImageFont.load_default()
    examples = [("mine.jpeg", 1, "missing / blue frame"), ("mine.jpeg", 4, "owned / silver frame"),
                ("2.jpg", 1, "missing / blue frame"), ("2.jpg", 3, "owned / silver frame")]
    for index, (name, card_id, label) in enumerate(examples):
        image = images[name].resize(WORK_SIZE, Image.Resampling.BILINEAR)
        col, row = (card_id - 1) % 3, (card_id - 1) // 3
        x, y = preparer.rounded((46 + col * 337) / 2), preparer.rounded((362 + row * 879) / 2)
        left = 20 + index * 270
        draw.text((left, 15), f"{name} / card {card_id}", font=font, fill="#eff2ff")
        patch = image.crop((x, y + 120, x + 156, y + 290))
        marker = ImageDraw.Draw(patch)
        for dx, dy, width, height in STRIPS:
            marker.rectangle((dx - 1, dy - 121, dx + width, dy - 120 + height), outline="#ffda66", width=1)
        panel.paste(patch, (left + 20, 58))
        draw.text((left, 247), label, font=font, fill="#eff2ff")
        stats = frame_color(image, card_id, preparer)
        for side, strip in enumerate(stats["strips"]):
            draw.text((left, 282 + side * 30), f"{'left' if side == 0 else 'right'} blue {strip['blueFraction']:.0%} / silver {strip['silverFraction']:.0%}", font=font, fill="#b1bad4")
    draw.text((20, 352), "Yellow outlines: sampled frame strips; card artwork is excluded.", font=font, fill="#b1bad4")
    panel.save(ROOT / "docs" / "miyoushe-frame-colors.png", optimize=True)


def main():
    preparer = load_preparer()
    manifest = json.loads((ROOT / "assets" / "recognition" / "miyoushe-v1" / "layout.json").read_text(encoding="utf-8"))
    images = {}
    for name in ("mine.jpeg", "2.jpg"):
        with Image.open(ROOT / "docs" / "assets" / name) as opened:
            images[name] = opened.convert("RGB")
    report = {
        "scope": "two real exports and synthetic variants; offline Pillow validation, not browser validation",
        "normalization": {"width": 540, "height": 3808, "mode": "independent axes, aspect checked before resizing"},
        "frameStripsInWorkingSlot": STRIPS,
        "variants": {},
    }
    # 先保留旧方案为何失败的证据，不修改原方案的素材或阈值。
    legacy = preparer.verify_image(images["2.jpg"], manifest)
    report["legacySecondImage"] = {key: legacy[key] for key in ("layoutValid", "anchors", "counts")}
    cases = [("mine-original", images["mine.jpeg"], preparer.EXPECTED), ("second-original", images["2.jpg"], EXPECTED_SECOND)]
    for name, source, expected in list(cases):
        small = source.resize((540, preparer.rounded(source.height * 540 / source.width)), Image.Resampling.BILINEAR)
        buffer = BytesIO()
        small.save(buffer, "JPEG", quality=60)
        buffer.seek(0)
        with Image.open(buffer) as opened:
            cases.append((f"{name}-540-jpeg60", opened.convert("RGB"), expected))
    # 非等比例合成变体保留“2”，用于检查数量模板能否随布局归一化工作。
    cases.append(("mine-resize-to-second-size-synthetic", images["mine.jpeg"].resize(images["2.jpg"].size, Image.Resampling.BILINEAR), preparer.EXPECTED))
    for name, source, expected in cases:
        result = evaluate(source, expected, manifest, preparer)
        report["variants"][name] = result
        print(f"{name}: expected={result['matchesExpected']}; counts={result['colorCounts']}")
    preparer.write_json(ROOT / "docs" / "fixtures" / "miyoushe-box-multidevice.validation.json", report)
    preparer.write_json(ROOT / "docs" / "fixtures" / "miyoushe-box-second.expected.json", {
        "source": "docs/assets/2.jpg", "counts": EXPECTED_SECOND,
        "ownedTypes": 14, "totalCards": 14, "missingIds": [1, 2, 8, 11, 13, 14, 21, 22], "twoIds": [],
    })
    preview(images, preparer)
    if not all(result["matchesExpected"] for result in report["variants"].values()):
        raise ValueError("跨设备验证有未通过的用例，请检查结果")


if __name__ == "__main__":
    main()
