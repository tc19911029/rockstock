#!/usr/bin/env python3
"""
keyframe-ocr.py — 關鍵幀去重 + macOS Vision OCR + WebP 壓縮（lib/youtube/keyframes.ts 的子程序）

子命令：
  analyze <frames_dir> <scenes_json>
      讀 scenes_json（[{file, ts, score}] 依 ts 升序），逐幀：
        1. Pillow dHash（8x8 → 64bit）；與「已輸出」幀 hamming ≤ 6 → 略過（NDJSON 記 dropped）
        2. 倖存幀跑 VNRecognizeTextRequest（zh-Hant + en，accurate，關 languageCorrection 免改壞代號）
      stdout 每幀一行 NDJSON：
        {"file":"000012.jpg","ts":754.2,"dhash":"a3f0...","ocr_text":"...","ocr_confidence":0.91,"block_count":14}
        {"file":"000013.jpg","ts":760.1,"dropped":"dup_of:000012.jpg"}
      import Vision 失敗 → exit 3（route 端記 ocr_unavailable）

  export-webp <jobs_json>
      讀 [{"src":"...","dst":"..."}]，每張downscale到寬 ≤1280、WebP q80 寫到 dst。
      stdout 每張一行 NDJSON：{"dst":"...","bytes":12345}

設計：一支 python 程序處理整支影片（避免 300 幀 spawn 300 次）；先去重再 OCR 省 Vision 時間。
"""

import json
import os
import sys

try:
    from PIL import Image
except ImportError:
    print("Pillow 未安裝: python3 -m pip install --user Pillow", file=sys.stderr)
    sys.exit(3)


# ── dHash ────────────────────────────────────────────────────────────────────

def dhash(img: "Image.Image", size: int = 8) -> int:
    """差值雜湊：灰階縮 (size+1)x(size) 後比相鄰像素亮度 → 64bit 整數。"""
    g = img.convert("L").resize((size + 1, size), Image.LANCZOS)
    px = list(g.getdata())
    bits = 0
    for row in range(size):
        for col in range(size):
            left = px[row * (size + 1) + col]
            right = px[row * (size + 1) + col + 1]
            bits = (bits << 1) | (1 if left > right else 0)
    return bits


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


# ── Vision OCR ───────────────────────────────────────────────────────────────

def make_ocr():
    """回傳 ocr(path) -> (text, avg_confidence, block_count)；Vision import 失敗 → exit 3。"""
    try:
        import Vision
        import Quartz
        from Foundation import NSURL
    except ImportError as e:
        print(f"pyobjc Vision 未安裝: {e}", file=sys.stderr)
        sys.exit(3)

    def ocr(path: str):
        url = NSURL.fileURLWithPath_(path)
        src = Quartz.CGImageSourceCreateWithURL(url, None)
        if src is None:
            return "", 0.0, 0
        cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
        if cg is None:
            return "", 0.0, 0
        req = Vision.VNRecognizeTextRequest.alloc().init()
        req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
        req.setRecognitionLanguages_(["zh-Hant", "en-US"])
        # 語言修正會把代號/價位「修」成別的字 → 關閉
        req.setUsesLanguageCorrection_(False)
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
        ok, err = handler.performRequests_error_([req], None)
        if not ok:
            return "", 0.0, 0
        lines = []
        confs = []
        for obs in req.results() or []:
            cands = obs.topCandidates_(1)
            if cands and cands.count() > 0:
                c = cands.objectAtIndex_(0)
                lines.append(str(c.string()))
                confs.append(float(c.confidence()))
        text = "\n".join(lines)
        avg = sum(confs) / len(confs) if confs else 0.0
        return text, round(avg, 3), len(lines)

    return ocr


# ── 子命令 ───────────────────────────────────────────────────────────────────

def cmd_analyze(frames_dir: str, scenes_json: str) -> int:
    with open(scenes_json, "r", encoding="utf-8") as f:
        scenes = json.load(f)

    ocr = make_ocr()
    kept_hashes: list = []   # [(dhash_int, file)]
    HAMMING_MAX = 6

    for s in scenes:
        fp = os.path.join(frames_dir, s["file"])
        if not os.path.isfile(fp):
            print(json.dumps({"file": s["file"], "ts": s["ts"], "dropped": "missing"}, ensure_ascii=False))
            continue
        try:
            with Image.open(fp) as img:
                h = dhash(img)
        except Exception as e:
            print(json.dumps({"file": s["file"], "ts": s["ts"], "dropped": f"unreadable:{e}"}, ensure_ascii=False))
            continue

        dup_of = None
        for prev_h, prev_f in kept_hashes:
            if hamming(h, prev_h) <= HAMMING_MAX:
                dup_of = prev_f
                break
        if dup_of:
            print(json.dumps({"file": s["file"], "ts": s["ts"], "dropped": f"dup_of:{dup_of}"}, ensure_ascii=False))
            continue

        text, conf, blocks = ocr(fp)
        kept_hashes.append((h, s["file"]))
        print(json.dumps({
            "file": s["file"], "ts": s["ts"], "dhash": format(h, "016x"),
            "ocr_text": text, "ocr_confidence": conf, "block_count": blocks,
        }, ensure_ascii=False))
        sys.stdout.flush()
    return 0


def cmd_export_webp(jobs_json: str) -> int:
    with open(jobs_json, "r", encoding="utf-8") as f:
        jobs = json.load(f)
    MAX_W = 1280
    for j in jobs:
        try:
            with Image.open(j["src"]) as img:
                if img.width > MAX_W:
                    nh = round(img.height * MAX_W / img.width)
                    img = img.resize((MAX_W, nh), Image.LANCZOS)
                os.makedirs(os.path.dirname(j["dst"]), exist_ok=True)
                img.save(j["dst"], "WEBP", quality=80, method=4)
            print(json.dumps({"dst": j["dst"], "bytes": os.path.getsize(j["dst"])}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"dst": j["dst"], "error": str(e)}, ensure_ascii=False))
        sys.stdout.flush()
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "analyze" and len(sys.argv) == 4:
        return cmd_analyze(sys.argv[2], sys.argv[3])
    if cmd == "export-webp" and len(sys.argv) == 3:
        return cmd_export_webp(sys.argv[2])
    print(f"未知子命令: {sys.argv[1:]}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
