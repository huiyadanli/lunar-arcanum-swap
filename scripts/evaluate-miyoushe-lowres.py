#!/usr/bin/env python3
"""验证第三张低分辨率导出图，以及不依赖页首小字的布局校验。

运行：python scripts/evaluate-miyoushe-lowres.py
开发期验证，只依赖 Pillow，不修改网页或现有模板。
"""

from io import BytesIO
import json
from pathlib import Path
import runpy

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parent.parent
WORK_SIZE = (540, 3808)


def inspect(image, evaluator, preparer, manifest):
    working = image.resize(WORK_SIZE, Image.Resampling.BILINEAR)
    colors = [evaluator["frame_color"](working, card_id, preparer) for card_id in range(1, 23)]
    footer_rect = manifest["layout"]["footerRect"]
    with Image.open(ROOT / "assets" / "recognition" / "miyoushe-v1" / "layout-footer.png") as opened:
        footer = preparer.match(working, opened.convert("RGB"), preparer.rounded(footer_rect[0] / 2), preparer.rounded(footer_rect[1] / 2), 4)
    aspect_valid = abs((image.height / image.width) / (7616 / 1080) - 1) <= 0.01
    footer_valid = footer["ncc"] >= 0.90 and footer["mae"] <= 0.08
    # 暂采用严格策略：全部22张牌均须有左右一致的蓝色或银灰色框。
    # 这不是仅去掉页首门槛；另用全部牌框确认图片确实包含完整的目标网格。
    frames_valid = all(color["state"] != "review" for color in colors)
    layout_valid = aspect_valid and footer_valid and frames_valid
    counts = [None] * 22
    quantities = []
    if layout_valid:
        with Image.open(ROOT / "assets" / "recognition" / "miyoushe-v1" / "count-two.png") as opened:
            two_template = opened.convert("RGB").resize((19, 23), Image.Resampling.BILINEAR)
        with Image.open(ROOT / "assets" / "recognition" / "miyoushe-v1" / "badge-ring.png") as opened:
            ring_template = opened.copy()
        for index, color in enumerate(colors):
            column, row = index % 3, index // 3
            two = preparer.match(working, two_template, preparer.rounded((292 + 337 * column) / 2), preparer.rounded((407 + 879 * row) / 2), 3)
            ring = preparer.ring_match(working, ring_template, preparer.rounded((275 + 337 * column) / 2), preparer.rounded((398 + 879 * row) / 2), 3, 128)
            is_two = two["ncc"] >= 0.92 and two["mae"] <= 0.10
            if color["state"] == "missing" and ring >= 0.14 and not is_two:
                counts[index] = 0
            elif color["state"] == "owned" and ring <= 0.09 and is_two:
                counts[index] = 2
            elif color["state"] == "owned" and ring >= 0.14 and not is_two:
                counts[index] = 1
            quantities.append({"id": index + 1, "twoNcc": two["ncc"], "twoMae": two["mae"], "ringMae": ring})
    return {
        "sourceSize": list(image.size), "layoutValid": layout_valid,
        "aspectValid": aspect_valid, "footer": footer, "footerValid": footer_valid,
        "all22FramesValid": frames_valid, "recognizedFrameCount": sum(color["state"] != "review" for color in colors),
        "counts": counts, "frames": colors, "quantities": quantities,
    }


def main():
    evaluator = runpy.run_path(str(ROOT / "scripts" / "evaluate-miyoushe-layouts.py"))
    preparer = evaluator["load_preparer"]()
    manifest = json.loads((ROOT / "assets" / "recognition" / "miyoushe-v1" / "layout.json").read_text(encoding="utf-8"))
    images = {}
    for name in ("mine.jpeg", "2.jpg", "3.png"):
        with Image.open(ROOT / "docs" / "assets" / name) as opened:
            images[name] = opened.convert("RGB")
    expected = preparer.EXPECTED
    legacy = evaluator["evaluate"](images["3.png"], expected, manifest, preparer)
    report = {
        "scope": "three real files; offline Pillow validation only; third file shares first file's card quantities",
        "previousThirdImageResult": legacy,
        "layoutRule": "original aspect within 1%; footer NCC>=0.90 and MAE<=0.08; all 22 frames have matching left/right color classes",
        "variants": {},
    }
    cases = [
        ("mine-original", images["mine.jpeg"], expected),
        ("second-original", images["2.jpg"], evaluator["EXPECTED_SECOND"]),
        ("third-original", images["3.png"], expected),
    ]
    # 在原生476px宽度重压缩，验证小字模糊不会阻止完整牌框和角标识别。
    buffer = BytesIO()
    images["3.png"].save(buffer, "JPEG", quality=60)
    buffer.seek(0)
    with Image.open(buffer) as opened:
        cases.append(("third-native-size-jpeg60", opened.convert("RGB"), expected))
    # 反例保留真实页尾标识，但没有任何卡框，不能被识别为全部已获得。
    footer_only = Image.new("RGB", WORK_SIZE, "#171c31")
    original_working = images["mine.jpeg"].resize(WORK_SIZE, Image.Resampling.BILINEAR)
    footer_only.paste(original_working.crop((21, 3705, 101, 3795)), (21, 3705))
    cases.append(("footer-only-invalid-synthetic", footer_only, [None] * 22))
    # 无法辨认数字时仍须待确认，不能因放宽布局检查而把未知角标填为1。
    unreadable = original_working.copy()
    ImageDraw.Draw(unreadable).ellipse((483, 647, 501, 665), fill="#2c315d")
    unknown_expected = expected.copy()
    unknown_expected[5] = None
    cases.append(("unreadable-badge-synthetic", unreadable, unknown_expected))
    for name, image, answer in cases:
        result = inspect(image, evaluator, preparer, manifest)
        result["matchesExpected"] = result["counts"] == answer
        # 保留第三张图的逐牌分数，其他用例只保存摘要。
        if name != "third-original":
            result.pop("frames")
            result.pop("quantities")
        report["variants"][name] = result
        print(f"{name}: expected={result['matchesExpected']}; counts={result['counts']}")
    preparer.write_json(ROOT / "docs" / "fixtures" / "miyoushe-box-lowres.validation.json", report)
    preparer.write_json(ROOT / "docs" / "fixtures" / "miyoushe-box-third.expected.json", {
        "source": "docs/assets/3.png", "sourceSize": [476, 3349], "counts": expected,
        "ownedTypes": 12, "totalCards": 13, "twoIds": [6],
        "missingIds": [1, 2, 3, 7, 8, 12, 14, 16, 18, 19],
    })
    if not all(result["matchesExpected"] for result in report["variants"].values()):
        raise ValueError("低分辨率验证有未通过的用例，请检查报告")


if __name__ == "__main__":
    main()
