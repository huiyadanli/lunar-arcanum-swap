#!/usr/bin/env python3
"""裁切米游社 Box 导入模板，并用已知样图验证设计参数。

只用于开发期素材准备，不是网页识别实现；依赖 Pillow，不增加 npm 依赖。
首次运行：python scripts/prepare-miyoushe-import.py --two-template <用户提供的2字PNG>
重新生成：python scripts/prepare-miyoushe-import.py
样图验证：python scripts/prepare-miyoushe-import.py --verify
"""

import argparse
from io import BytesIO
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "recognition" / "miyoushe-v1"
FIXTURES = ROOT / "docs" / "fixtures"
REFERENCE_SIZE = (1080, 7616)
WORK_WIDTH = 540
EXPECTED = [0, 0, 0, 1, 1, 2, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1]

# 所有矩形均为原图坐标 [x, y, width, height]，不使用右下角坐标。
CROPS = {
    "missing-back": {"rect": [94, 510, 220, 180], "size": [110, 90]},
    "layout-header": {"rect": [44, 280, 132, 44], "size": [66, 22]},
    "layout-footer": {"rect": [42, 7410, 160, 180], "size": [80, 90]},
    "badge-ring": {"rect": [949, 1277, 70, 70], "size": [35, 35]},
}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def rect_crop(image, rect):
    x, y, width, height = rect
    return image.crop((x, y, x + width, y + height))


def rounded(value):
    # 与 JavaScript Math.round 对非负坐标的行为一致。
    return math.floor(value + 0.5)


def pixels(image):
    # Pillow 新版本更名了像素展开接口，兼容现有开发环境。
    getter = getattr(image, "get_flattened_data", None)
    return tuple(getter() if getter else image.getdata())


def prepare(source, two_source):
    with Image.open(source) as opened:
        image = opened.convert("RGB")
    if image.size != REFERENCE_SIZE:
        raise ValueError(f"素材标定要求 {REFERENCE_SIZE} 原图，实际为 {image.size}")
    if not two_source.is_file():
        raise ValueError("缺少用户提供的 2 字模板，请指定 --two-template <PNG路径>")
    with Image.open(two_source) as opened:
        numeral = opened.convert("RGB")
    if numeral.size != (38, 46):
        raise ValueError(f"2 字模板应为 38×46，实际为 {numeral.size}")
    OUT.mkdir(parents=True, exist_ok=True)
    numeral.save(OUT / "count-two.png", optimize=True)
    for name, entry in CROPS.items():
        patch = rect_crop(image, entry["rect"]).resize(entry["size"], Image.Resampling.BILINEAR)
        if name == "badge-ring":
            # 只比较外圈，排除内部数字；透明像素不是黑色背景。
            mask = Image.new("L", (70, 70))
            mask.putdata([
                255 if 28 <= math.hypot(x - 34.5, y - 34.5) <= 33.5 else 0
                for y in range(70) for x in range(70)
            ])
            patch = patch.convert("RGBA")
            patch.putalpha(mask.resize(entry["size"], Image.Resampling.BOX))
        patch.save(OUT / f"{name}.png", optimize=True)

    manifest = {
        "profile": "miyoushe-box-v1",
        "coordinateConvention": "reference pixels; rect = [x, y, width, height]; round = Math.round",
        "reference": {"width": 1080, "height": 7616},
        "workingWidth": WORK_WIDTH,
        "aspectRatioRelativeTolerance": 0.01,
        "grid": {
            "columns": 3, "rows": 8, "cardCount": 22,
            "firstSlot": [46, 362], "columnStep": 337, "rowStep": 879,
            "slotFrameRect": [0, 0, 312, 780],
            "missingRectInSlot": [48, 148, 220, 180],
            "twoRectInSlot": [246, 45, 38, 46],
            "badgeRectInSlot": [229, 36, 70, 70],
            "searchRadiusAtWorkingWidth": 3,
        },
        "layout": {
            "searchRadiusAtWorkingWidth": 4,
            "headerRect": CROPS["layout-header"]["rect"],
            "footerRect": CROPS["layout-footer"]["rect"],
        },
        "thresholds": {
            "missing": {"yesNccMin": 0.92, "yesMaeMax": 0.06, "noNccMax": 0.70, "noMaeMin": 0.10},
            "two": {"yesNccMin": 0.92, "yesMaeMax": 0.10},
            "badge": {"presentMaeMax": 0.09, "absentMaeMin": 0.14, "alphaMin": 128},
            "layout": {"nccMin": 0.90, "maeMax": 0.08},
        },
        "thresholdStatus": "single-fixture calibration; browser and additional real exports still required",
        "templates": {
            **{name: {"file": f"{name}.png", "sourceRect": entry["rect"], "size": entry["size"]} for name, entry in CROPS.items()},
            "count-two": {
                "file": "count-two.png", "size": [38, 46], "matchSize": [19, 23],
                "source": "user-provided exact crop, pixels preserved",
                "referenceRect": [966, 1286, 38, 46],
            },
        },
    }
    write_json(OUT / "layout.json", manifest)
    write_json(FIXTURES / "miyoushe-box-v1.expected.json", {
        "source": "docs/assets/mine.jpeg", "profile": manifest["profile"],
        "counts": EXPECTED, "ownedTypes": 12, "totalCards": 13,
        "missingIds": [i + 1 for i, count in enumerate(EXPECTED) if count == 0],
        "twoIds": [6],
    })
    preview_templates()
    return image, manifest


def preview_templates():
    preview = Image.new("RGB", (980, 410), "#171c31")
    draw = ImageDraw.Draw(preview)
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 18) if font_path.exists() else ImageFont.load_default()
    draw.text((24, 18), "Miyoushe Box import / lossless templates", fill="#eff2ff", font=font)
    entries = [
        ("missing-back", "110 x 90", 24, 80, 2),
        ("count-two", "38 x 46 / user crop", 286, 80, 3),
        ("badge-ring", "35 x 35 / alpha mask", 510, 80, 3),
        ("layout-footer", "80 x 90", 754, 80, 2),
        ("layout-header", "66 x 22 / fixed text only", 24, 308, 2),
    ]
    for name, dimensions, x, y, scale in entries:
        with Image.open(OUT / f"{name}.png") as opened:
            patch = opened.convert("RGBA")
        patch = patch.resize((patch.width * scale, patch.height * scale), Image.Resampling.NEAREST)
        preview.paste(patch, (x, y), patch)
        draw.text((x, y + patch.height + 8), name, fill="#eff2ff", font=font)
        draw.text((x, y + patch.height + 32), dimensions, fill="#b1bad4", font=font)
    preview.save(ROOT / "docs" / "miyoushe-box-import-templates.png", optimize=True)


def mae(first, second):
    return sum(ImageStat.Stat(ImageChops.difference(first, second)).mean) / (3 * 255)


def match(image, template, x, y, radius):
    """小范围 ZNCC；常量区域定义为 0 分，避免零方差被误判为匹配。"""
    values = pixels(template.convert("L"))
    mean = sum(values) / len(values)
    centered = tuple(value - mean for value in values)
    norm = math.sqrt(sum(value * value for value in centered))
    if norm < 1e-6:
        raise ValueError("模板方差过小")
    best = {"ncc": -2, "mae": 1, "offset": [0, 0]}
    gray = image.convert("L")
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            rect = [x + dx, y + dy, template.width, template.height]
            if min(rect[:2]) < 0 or rect[0] + rect[2] > image.width or rect[1] + rect[3] > image.height:
                continue
            patch_values = pixels(rect_crop(gray, rect))
            variance = sum(value * value for value in patch_values) - sum(patch_values) ** 2 / len(patch_values)
            score = sum(a * b for a, b in zip(patch_values, centered)) / (math.sqrt(variance) * norm) if variance > 1e-6 else 0
            if score > best["ncc"]:
                best = {"ncc": score, "mae": mae(rect_crop(image, rect), template), "offset": [dx, dy]}
    return best


def ring_match(image, template, x, y, radius, alpha_min):
    # 与设计一致：只比较 alpha >= 128 的像素，内部数字不参与。
    indexes = [i for i, alpha in enumerate(pixels(template.getchannel("A"))) if alpha >= alpha_min]
    template_pixels = pixels(template.convert("RGB"))
    best = 1
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            patch = pixels(rect_crop(image, [x + dx, y + dy, template.width, template.height]))
            error = sum(abs(patch[i][c] - template_pixels[i][c]) for i in indexes for c in range(3)) / (len(indexes) * 3 * 255)
            best = min(best, error)
    return best


def verify_image(image, manifest):
    aspect_valid = abs((image.height / image.width) / (7616 / 1080) - 1) <= manifest["aspectRatioRelativeTolerance"]
    image = image.resize((WORK_WIDTH, rounded(image.height * WORK_WIDTH / image.width)), Image.Resampling.BILINEAR)
    templates = {}
    for name in manifest["templates"]:
        with Image.open(OUT / f"{name}.png") as opened:
            templates[name] = opened.copy()
    templates["count-two"] = templates["count-two"].resize((19, 23), Image.Resampling.BILINEAR)
    thresholds = manifest["thresholds"]
    anchors = {}
    for name, rect in [("layout-header", CROPS["layout-header"]["rect"]), ("layout-footer", CROPS["layout-footer"]["rect"])]:
        anchors[name] = match(image, templates[name], rounded(rect[0] / 2), rounded(rect[1] / 2), 4)
    offsets = [result["offset"] for result in anchors.values()]
    offsets_agree = all(abs(offsets[0][axis] - offsets[1][axis]) <= 2 for axis in (0, 1))
    delta = [rounded(sum(offset[axis] for offset in offsets) / len(offsets)) for axis in (0, 1)]
    layout_valid = aspect_valid and offsets_agree and all(result["ncc"] >= thresholds["layout"]["nccMin"] and result["mae"] <= thresholds["layout"]["maeMax"] for result in anchors.values())
    if not layout_valid:
        return {"layoutValid": False, "anchors": anchors, "counts": [None] * 22, "cards": []}
    cards = []
    for card_id in range(1, 23):
        column, row = (card_id - 1) % 3, (card_id - 1) // 3
        # 与 layout.json 中 firstSlot + 步长 + 局部矩形对应。
        missing = match(image, templates["missing-back"], rounded((94 + 337 * column) / 2) + delta[0], rounded((510 + 879 * row) / 2) + delta[1], 3)
        two = match(image, templates["count-two"], rounded((292 + 337 * column) / 2) + delta[0], rounded((407 + 879 * row) / 2) + delta[1], 3)
        ring = ring_match(image, templates["badge-ring"], rounded((275 + 337 * column) / 2) + delta[0], rounded((398 + 879 * row) / 2) + delta[1], 3, thresholds["badge"]["alphaMin"])
        is_missing = missing["ncc"] >= thresholds["missing"]["yesNccMin"] and missing["mae"] <= thresholds["missing"]["yesMaeMax"]
        is_owned = missing["ncc"] <= thresholds["missing"]["noNccMax"] and missing["mae"] >= thresholds["missing"]["noMaeMin"]
        is_two = two["ncc"] >= thresholds["two"]["yesNccMin"] and two["mae"] <= thresholds["two"]["yesMaeMax"]
        count = None
        if layout_valid:
            if is_missing and ring >= thresholds["badge"]["absentMaeMin"] and not is_two:
                count = 0
            elif is_owned and is_two and ring <= thresholds["badge"]["presentMaeMax"]:
                count = 2
            elif is_owned and not is_two and ring >= thresholds["badge"]["absentMaeMin"]:
                count = 1
        cards.append({"id": card_id, "count": count, "missing": missing, "two": two, "ringMae": ring})
    return {"layoutValid": layout_valid, "anchors": anchors, "counts": [card["count"] for card in cards], "cards": cards}


def verify(image, manifest):
    smaller = image.resize((720, rounded(image.height * 720 / image.width)), Image.Resampling.BILINEAR)
    buffer = BytesIO()
    smaller.save(buffer, format="JPEG", quality=70)
    buffer.seek(0)
    with Image.open(buffer) as opened:
        compressed = opened.convert("RGB")
    results = {}
    # 抹去角标内部的数字，保留外圈，模拟“有数量角标但无法辨认2”。
    unreadable = image.copy()
    ImageDraw.Draw(unreadable).ellipse((966, 1294, 1002, 1330), fill="#2c315d")
    unknown_expected = EXPECTED.copy()
    unknown_expected[5] = None
    for name, variant, expected in [
        ("original", image, EXPECTED),
        ("resize-720-jpeg-70", compressed, EXPECTED),
        ("unreadable-badge-synthetic", unreadable, unknown_expected),
        ("blank-invalid-layout", Image.new("RGB", REFERENCE_SIZE, "#2c315d"), [None] * 22),
    ]:
        result = verify_image(variant, manifest)
        result["matchesExpected"] = result["counts"] == expected
        results[name] = {key: value for key, value in result.items() if key != "cards"}
        if result["cards"]:
            missing_cards = [card for card in result["cards"] if EXPECTED[card["id"] - 1] == 0]
            owned_cards = [card for card in result["cards"] if EXPECTED[card["id"] - 1] > 0]
            results[name]["scoreRanges"] = {
                "missingNccMin": min(card["missing"]["ncc"] for card in missing_cards),
                "missingMaeMax": max(card["missing"]["mae"] for card in missing_cards),
                "ownedNccMax": max(card["missing"]["ncc"] for card in owned_cards),
                "ownedMaeMin": min(card["missing"]["mae"] for card in owned_cards),
                "card6TwoNcc": result["cards"][5]["two"]["ncc"],
                "card6TwoMae": result["cards"][5]["two"]["mae"],
                "card6RingMae": result["cards"][5]["ringMae"],
                "noBadgeRingMaeMin": min(card["ringMae"] for card in result["cards"] if card["id"] != 6),
            }
        print(f"{name}: expected={result['matchesExpected']}, counts={result['counts']}")
    write_json(FIXTURES / "miyoushe-box-v1.validation.json", {
        "scope": "offline Pillow design validation; not a browser implementation or multi-user accuracy estimate",
        "variants": results,
    })
    if not all(result["matchesExpected"] for result in results.values()):
        raise ValueError("样图识别结果与人工核对值不一致，请检查模板和阈值")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "docs" / "assets" / "mine.jpeg")
    parser.add_argument("--two-template", type=Path, default=OUT / "count-two.png")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    image, manifest = prepare(args.source, args.two_template)
    if args.verify:
        verify(image, manifest)
    total = sum(path.stat().st_size for path in OUT.glob("*.png"))
    print(f"5 templates: {total} bytes; manifest: {OUT / 'layout.json'}")


if __name__ == "__main__":
    main()
