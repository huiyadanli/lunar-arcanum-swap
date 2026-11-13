#!/usr/bin/env python3
"""自适应牌框定位的开发期验证：不使用固定坐标、图像比例或布局模板。

依赖 Pillow；网页实现可用 Canvas + TypedArray 完成同样的像素操作。
python scripts/evaluate-miyoushe-flexible.py
"""

from io import BytesIO
import json
import math
from pathlib import Path
from statistics import median
import time

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets" / "recognition" / "miyoushe-flexible"
ANGLES = [(math.cos(i * math.tau / 24), math.sin(i * math.tau / 24)) for i in range(24)]


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def components(mask):
    """扫描每行连续的前景段，用并查集连接相邻行；8邻域连通。"""
    width, height = mask.size
    data = mask.tobytes()
    parents = [0]
    runs = []
    previous = []

    def find(label):
        while parents[label] != label:
            parents[label] = parents[parents[label]]
            label = parents[label]
        return label

    for y in range(height):
        row = data[y * width:(y + 1) * width]
        current = []
        offset = 0
        previous_index = 0
        while offset < width:
            left = row.find(b"\xff", offset)
            if left < 0:
                break
            end = row.find(b"\x00", left)
            right = width - 1 if end < 0 else end - 1
            while previous_index < len(previous) and previous[previous_index][1] < left - 1:
                previous_index += 1
            overlap = []
            scan = previous_index
            while scan < len(previous) and previous[scan][0] <= right + 1:
                overlap.append(find(previous[scan][2]))
                scan += 1
            if overlap:
                label = min(overlap)
                for old in overlap:
                    parents[find(old)] = label
            else:
                label = len(parents)
                parents.append(label)
            current.append((left, right, label))
            runs.append((y, left, right, label))
            offset = right + 1
        previous = current
    boxes = {}
    for y, left, right, label in runs:
        label = find(label)
        if label not in boxes:
            boxes[label] = [left, y, right, y, 0]
        box = boxes[label]
        box[0] = min(box[0], left)
        box[1] = min(box[1], y)
        box[2] = max(box[2], right)
        box[3] = max(box[3], y)
        box[4] += right - left + 1
    return [[x, y, right - x + 1, bottom - y + 1, area] for x, y, right, bottom, area in boxes.values()]


def pixel_features(image):
    data = image.tobytes()
    size = image.width * image.height
    blue, silver, union, gray, neutral = (bytearray(size) for _ in range(5))
    for index in range(size):
        r, g, b = data[index * 3:index * 3 + 3]
        difference = max(r, g, b) - min(r, g, b)
        luminance = (r + g + b) // 3
        blue[index] = int(b - r > 30 and g - r > 10 and b > 110)
        silver[index] = int(difference < 45 and luminance > 115)
        union[index] = 255 if blue[index] or silver[index] else 0
        gray[index] = luminance
        neutral[index] = int(difference < 75)
    mask = Image.frombytes("L", image.size, bytes(union))
    # 3×3闭运算连接细小断口；这里的3px属于工作图处理参数，不是输入尺寸限制。
    mask = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    return blue, silver, gray, neutral, mask


def detect_frames(mask):
    raw = [box for box in components(mask) if box[2] >= 16 and box[3] >= 40 and 1.6 < box[3] / box[2] < 4.4 and box[4] / (box[2] * box[3]) > 0.06]
    if not raw:
        return []
    # 选择尺寸一致的主体群，过滤卡面内部、文字、二维码等细碎区域。
    groups = [[box for box in raw if seed[3] * 0.72 <= box[3] <= seed[3] * 1.28] for seed in raw]
    group = max(groups, key=lambda boxes: (len(boxes), sum(box[2] * box[3] for box in boxes)))
    selected = []
    for box in sorted(group, key=lambda box: box[2] * box[3], reverse=True):
        x, y, width, height, _ = box
        contained = False
        for old in selected:
            ox, oy, ow, oh, _ = old
            overlap = max(0, min(x + width, ox + ow) - max(x, ox)) * max(0, min(y + height, oy + oh) - max(y, oy))
            if overlap / (width * height) > 0.80:
                contained = True
                break
        if not contained:
            selected.append(box)
    return selected


def cluster(values, tolerance):
    groups = []
    for value in sorted(values):
        if groups and abs(value - sum(groups[-1]) / len(groups[-1])) <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return [sum(group) / len(group) for group in groups]


def assign_grid(frames):
    if len(frames) < 4:
        return {}, {"identityReliable": False, "reason": "not-enough-grid-evidence"}
    columns = cluster([x + width / 2 for x, y, width, height, area in frames], median(box[2] for box in frames) * 0.45)
    rows = cluster([y + height / 2 for x, y, width, height, area in frames], median(box[3] for box in frames) * 0.42)
    # 22是业务上的牌种数，不是要求22个框全部检测成功。局部漏框可留空。
    identity_reliable = len(rows) == math.ceil(22 / len(columns))
    assigned = {}
    for box in frames:
        x, y, width, height, area = box
        column = min(range(len(columns)), key=lambda i: abs(columns[i] - x - width / 2))
        row = min(range(len(rows)), key=lambda i: abs(rows[i] - y - height / 2))
        card_id = row * len(columns) + column + 1
        if card_id <= 22 and card_id not in assigned:
            assigned[card_id] = box
    return assigned, {"identityReliable": identity_reliable, "columns": len(columns), "rows": len(rows), "detectedFrames": len(frames)}


def frame_state(box, image_width, blue, silver):
    x, y, width, height, _ = box
    sides = []
    for start, stop in ((0.01, 0.14), (0.86, 0.99)):
        blue_columns, silver_columns = [], []
        top, bottom = y + int(height * 0.25), y + int(height * 0.75)
        for xx in range(x + int(width * start), x + int(width * stop)):
            indexes = range(top * image_width + xx, bottom * image_width + xx, image_width)
            blue_columns.append(sum(blue[i] for i in indexes) / (bottom - top))
            silver_columns.append(sum(silver[i] for i in indexes) / (bottom - top))
        sides.append({"blue": sum(sorted(blue_columns)[-3:]) / min(3, len(blue_columns)), "silver": sum(sorted(silver_columns)[-3:]) / min(3, len(silver_columns))})
    state = "owned" if min(side["silver"] for side in sides) >= 0.60 else "missing" if min(side["blue"] for side in sides) >= 0.60 and max(side["silver"] for side in sides) <= 0.30 else "review"
    return state, sides


def white_mask(image, level=205):
    data = image.tobytes()
    values = bytearray(image.width * image.height)
    for index in range(len(values)):
        r, g, b = data[index * 3:index * 3 + 3]
        values[index] = 255 if min(r, g, b) > level and max(r, g, b) - min(r, g, b) < 50 else 0
    return Image.frombytes("L", image.size, bytes(values))


def normalize_digit(mask):
    bounds = mask.getbbox()
    if not bounds:
        return bytes(384)
    normalized = mask.crop(bounds).resize((16, 24), Image.Resampling.NEAREST)
    return bytes(int(value > 127) for value in normalized.tobytes())


def prepare_digit():
    with Image.open(ROOT / "assets" / "recognition" / "miyoushe-v1" / "count-two.png") as opened:
        target = normalize_digit(white_mask(opened.convert("RGB")))
    rows = [format(sum(target[y * 16 + x] << (15 - x) for x in range(16)), "04x") for y in range(24)]
    write_json(ASSETS / "digit-two.json", {"width": 16, "height": 24, "encoding": "16-bit hex rows, left pixel is high bit", "rows": rows, "source": "user-provided count-two.png; white foreground only"})
    return target


def circle_score(box, size, gray, neutral):
    x, y, width, height, _ = box
    image_width, image_height = size
    best = 0
    for cy in range(y, y + int(height * 0.12), 3):
        for cx in range(x + int(width * 0.76), x + int(width * 0.98), 3):
            for radius in range(round(width * 0.085), round(width * 0.15) + 1, 2):
                hits = 0
                for cosine, sine in ANGLES:
                    ix, iy = round(cx + radius * 0.78 * cosine), round(cy + radius * 0.78 * sine)
                    ox, oy = round(cx + radius * 1.20 * cosine), round(cy + radius * 1.20 * sine)
                    if not (0 <= ix < image_width and 0 <= ox < image_width and 0 <= iy < image_height and 0 <= oy < image_height):
                        continue
                    base = (gray[iy * image_width + ix] + gray[oy * image_width + ox]) / 2
                    for delta in (-0.7, 0, 0.7):
                        xx, yy = round(cx + (radius + delta) * cosine), round(cy + (radius + delta) * sine)
                        if 0 <= xx < image_width and 0 <= yy < image_height:
                            index = yy * image_width + xx
                            if neutral[index] and gray[index] > 90 and gray[index] - base > 18:
                                hits += 1
                                break
                best = max(best, hits / len(ANGLES))
                if best >= 0.90:
                    return best
    return best


def quantity(image, box, target, gray, neutral):
    x, y, width, height, _ = box
    left, top = max(0, x + int(width * 0.67)), max(0, y - int(height * 0.025))
    right, bottom = min(image.width, x + int(width * 1.10)), min(image.height, y + int(height * 0.15))
    region = image.crop((left, top, right, bottom))
    dice = 0
    # 多个亮度切分和1px对齐吸收缩放、JPEG导致的笔画变细或断裂。
    # 模板仍只有一个数字2；没有增加按设备、分辨率分组的模板。
    for level in (170, 190, 205, 220):
        mask = white_mask(region, level)
        connected = mask.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
        for dx, dy, dw, dh, area in components(connected):
            if height * 0.025 < dh < height * 0.10 and 0.35 < dw / dh < 1.15 and area > 8:
                digit = normalize_digit(mask.crop((dx, dy, dx + dw, dy + dh)))
                for shift_y in (-1, 0, 1):
                    for shift_x in (-1, 0, 1):
                        shifted = bytes(digit[(yy - shift_y) * 16 + xx - shift_x] if 0 <= yy - shift_y < 24 and 0 <= xx - shift_x < 16 else 0 for yy in range(24) for xx in range(16))
                        denominator = sum(target) + sum(shifted)
                        score = 2 * sum(a and b for a, b in zip(target, shifted)) / denominator if denominator else 0
                        dice = max(dice, score)
    ring = circle_score(box, image.size, gray, neutral)
    count = 2 if ring >= 0.65 and dice >= 0.78 else 1 if ring < 0.50 and dice < 0.65 else None
    return count, {"ringSupport": ring, "twoDice": dice}


def recognize(source, target, details=False):
    started = time.perf_counter()
    # 只控制计算量；不校验输入的宽高比，也不强制拉伸高度。
    working = source.resize((540, round(source.height * 540 / source.width)), Image.Resampling.BILINEAR)
    blue, silver, gray, neutral, mask = pixel_features(working)
    frames = detect_frames(mask)
    assigned, grid = assign_grid(frames)
    counts = [None] * 22
    cards = []
    if grid["identityReliable"]:
        for card_id, box in sorted(assigned.items()):
            state, sides = frame_state(box, working.width, blue, silver)
            numeric = {}
            count = 0 if state == "missing" else None
            if state == "owned":
                count, numeric = quantity(working, box, target, gray, neutral)
            counts[card_id - 1] = count
            cards.append({"id": card_id, "box": box[:4], "state": state, "count": count, "sides": sides, **numeric})
    result = {"sourceSize": list(source.size), "workingSize": list(working.size), "grid": grid, "counts": counts, "reviewIds": [i + 1 for i, count in enumerate(counts) if count is None], "elapsedSeconds": round(time.perf_counter() - started, 3)}
    if details:
        result["cards"] = cards
    return result


def jpeg(image, quality):
    buffer = BytesIO()
    image.save(buffer, "JPEG", quality=quality)
    buffer.seek(0)
    with Image.open(buffer) as opened:
        return opened.convert("RGB")


def variants(name, source):
    yield f"{name}:original", source
    for width in (320, 480, 720, 1280, 1920):
        yield f"{name}:width-{width}", source.resize((width, round(source.height * width / source.width)), Image.Resampling.BILINEAR)
    yield f"{name}:jpeg-50", jpeg(source, 50)
    yield f"{name}:no-header-footer", source.crop((0, round(source.height * 0.04), source.width, round(source.height * 0.96)))
    padding = max(1, round(source.width * 0.10))
    padded = Image.new("RGB", (source.width + padding * 2, source.height + padding * 3), "#171c31")
    padded.paste(source, (padding, padding * 2))
    yield f"{name}:padded", padded
    gap = max(1, round(source.width * 0.07))
    cut = round(source.height * 0.50)
    spaced = Image.new("RGB", (source.width, source.height + gap), "#171c31")
    spaced.paste(source.crop((0, 0, source.width, cut)), (0, 0))
    spaced.paste(source.crop((0, cut, source.width, source.height)), (0, cut + gap))
    yield f"{name}:row-gap", spaced


def preview(images, originals):
    panel = Image.new("RGB", (1110, 640), "#171c31")
    draw = ImageDraw.Draw(panel)
    font_path = Path("C:/Windows/Fonts/msyh.ttc")
    font = ImageFont.truetype(str(font_path), 17) if font_path.exists() else ImageFont.load_default()
    for column, (name, source) in enumerate(images.items()):
        result = originals[f"{name}:original"]
        working = source.resize(tuple(result["workingSize"]), Image.Resampling.BILINEAR)
        boxes = [card for card in result["cards"] if card["id"] <= 6]
        top = min(card["box"][1] for card in boxes) - 4
        bottom = max(card["box"][1] + card["box"][3] for card in boxes) + 4
        crop = working.crop((0, top, working.width, bottom))
        marker = ImageDraw.Draw(crop)
        for card in boxes:
            x, y, width, height = card["box"]
            color = "#61d9ff" if card["count"] == 0 else "#82edaa"
            marker.rectangle((x, y - top, x + width, y - top + height), outline=color, width=3)
            marker.text((x + 5, y - top + 20), f"#{card['id']} = {card['count']}", fill="#ffffff", font=font, stroke_width=2, stroke_fill="#171c31")
        crop.thumbnail((350, 535), Image.Resampling.LANCZOS)
        left = column * 370 + 10
        panel.paste(crop, (left, 62))
        draw.text((left, 18), f"{name} / {source.width} x {source.height}", fill="#eff2ff", font=font)
    draw.text((18, 610), "Detected card frames; no header, footer, card-back or badge-ring image templates.", fill="#b1bad4", font=font)
    panel.save(ROOT / "docs" / "miyoushe-flexible-detection.png", optimize=True)


def main():
    target = prepare_digit()
    sources = {}
    answers = {}
    for name, fixture in (("mine.jpeg", "miyoushe-box-v1.expected.json"), ("2.jpg", "miyoushe-box-second.expected.json"), ("3.png", "miyoushe-box-third.expected.json")):
        with Image.open(ROOT / "docs" / "assets" / name) as opened:
            sources[name] = opened.convert("RGB")
        answers[name] = json.loads((ROOT / "docs" / "fixtures" / fixture).read_text(encoding="utf-8"))["counts"]
    report = {"scope": "offline Pillow proof of concept; no fixed source dimensions, aspect ratio, layout templates or all-22-frame rejection; browser not yet implemented", "variants": {}}
    originals = {}
    for name, source in sources.items():
        for key, image in variants(name, source):
            original = key.endswith(":original")
            result = recognize(image, target, details=original)
            result["matchesExpected"] = result["counts"] == answers[name]
            report["variants"][key] = result
            if original:
                originals[key] = result
            print(f"{key}: pass={result['matchesExpected']} frames={result['grid'].get('detectedFrames', 0)} review={result['reviewIds']}", flush=True)
    # 空白图没有网格；不把“牌背未匹配”解释成全部已获得。
    blank = recognize(Image.new("RGB", (720, 1280), "#171c31"), target)
    blank["matchesExpected"] = blank["counts"] == [None] * 22
    report["variants"]["blank-invalid"] = blank
    # 只抹去一张牌，保留其他行列：其余牌仍可预览，不要求22个框齐全。
    partial = sources["mine.jpeg"].copy()
    box = originals["mine.jpeg:original"]["cards"][4]["box"]
    scale = partial.width / 540
    x, y, width, height = box
    ImageDraw.Draw(partial).rectangle((int((x - 3) * scale), int((y - 3) * scale), int((x + width + 3) * scale), int((y + height + 3) * scale)), fill="#171c31")
    result = recognize(partial, target)
    expected = answers["mine.jpeg"].copy()
    expected[4] = None
    result["matchesExpected"] = result["counts"] == expected
    report["variants"]["one-frame-removed"] = result
    print(f"one-frame-removed: pass={result['matchesExpected']} review={result['reviewIds']}", flush=True)
    # 覆盖没有任何蓝色牌背以及全是蓝色牌背的情况，不靠某一种牌定位。
    base = sources["mine.jpeg"].resize(tuple(originals["mine.jpeg:original"]["workingSize"]), Image.Resampling.BILINEAR)
    for key, sample_id, answer in (("all-owned-synthetic", 4, [1] * 22), ("all-missing-synthetic", 1, [0] * 22)):
        synthetic = base.copy()
        sx, sy, sw, sh = next(card["box"] for card in originals["mine.jpeg:original"]["cards"] if card["id"] == sample_id)
        sample = base.crop((sx, sy, sx + sw, sy + sh))
        for card in originals["mine.jpeg:original"]["cards"]:
            x, y, width, height = card["box"]
            synthetic.paste(sample.resize((width, height), Image.Resampling.BILINEAR), (x, y))
        result = recognize(synthetic, target)
        result["matchesExpected"] = result["counts"] == answer
        report["variants"][key] = result
        print(f"{key}: pass={result['matchesExpected']} review={result['reviewIds']}", flush=True)
    # 其他数字仍应留作人工确认，不能只依据圆圈存在就填2。
    for glyph in ("3", "8"):
        synthetic = base.copy()
        x, y, width, height = next(card["box"] for card in originals["mine.jpeg:original"]["cards"] if card["id"] == 6)
        cx, cy = round(x + width * 0.87), round(y + height * 0.055)
        painter = ImageDraw.Draw(synthetic)
        painter.ellipse((cx - 12, cy - 12, cx + 12, cy + 12), fill="#2c315d")
        painter.text((cx, cy - 1), glyph, font=ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 20), fill="white", anchor="mm")
        result = recognize(synthetic, target)
        answer = answers["mine.jpeg"].copy()
        answer[5] = None
        result["matchesExpected"] = result["counts"] == answer
        report["variants"][f"unknown-digit-{glyph}-synthetic"] = result
        print(f"unknown-digit-{glyph}-synthetic: pass={result['matchesExpected']} review={result['reviewIds']}", flush=True)
    write_json(ROOT / "docs" / "fixtures" / "miyoushe-box-flexible.validation.json", report)
    preview(sources, originals)
    total = len(report["variants"])
    passed = sum(result["matchesExpected"] for result in report["variants"].values())
    print(f"{passed}/{total} cases passed; digit asset {(ASSETS / 'digit-two.json').stat().st_size} bytes", flush=True)
    if passed != total:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
