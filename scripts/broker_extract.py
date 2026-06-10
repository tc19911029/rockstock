#!/usr/bin/env python3
"""
券商 PDF 文字抽取 + 亂碼偵測 + （亂碼時）render 成 PNG。

用法：python3 broker_extract.py <pdf_path> <img_out_dir>
輸出（stdout，單行 JSON）：
  {"mode":"text"|"vision","pages":N,"text":"...","images":["...png"],"chars":N}

乾淨 PDF → pypdf 抽文字（mode=text）。
CID 字型亂碼（如花旗）→ pymupdf render 前 8 頁 PNG（mode=vision，text 留診斷用前 500 字）。
"""
import sys, os, json, re

def extract_text_pypdf(path):
    import pypdf
    r = pypdf.PdfReader(path)
    parts = []
    for i, p in enumerate(r.pages):
        parts.append(f"\n----- PAGE {i+1} -----\n")
        try:
            parts.append(p.extract_text() or "")
        except Exception:
            parts.append("")
    return "".join(parts), len(r.pages)

def is_garbled(text):
    if not text or len(text.strip()) < 80:
        return True
    # CID / glyph-index 亂碼特徵
    if text.count("/i255") > 10 or text.count("(cid:") > 10:
        return True
    # 可讀字元比例（ASCII letters/digits + CJK）
    readable = sum(1 for c in text if c.isalnum() or '一' <= c <= '鿿' or c in ' .,%/-()$')
    ratio = readable / max(1, len(text))
    return ratio < 0.45

def render_vision(path, out_dir, max_pages=8):
    import fitz
    d = fitz.open(path)
    imgs = []
    n = min(len(d), max_pages)
    os.makedirs(out_dir, exist_ok=True)
    for i in range(n):
        pix = d[i].get_pixmap(matrix=fitz.Matrix(2, 2))
        out = os.path.join(out_dir, f"p{i+1:02d}.png")
        pix.save(out)
        imgs.append(out)
    return imgs, len(d)

def main():
    pdf_path = sys.argv[1]
    img_dir = sys.argv[2]
    try:
        text, pages = extract_text_pypdf(pdf_path)
    except Exception as e:
        text, pages = "", 0
    if is_garbled(text):
        try:
            imgs, pages = render_vision(pdf_path, img_dir)
            print(json.dumps({"mode": "vision", "pages": pages, "text": text[:500],
                              "images": imgs, "chars": len(text)}))
            return
        except Exception as e:
            print(json.dumps({"mode": "error", "pages": pages, "text": "",
                              "images": [], "chars": 0, "error": str(e)}))
            return
    print(json.dumps({"mode": "text", "pages": pages, "text": text,
                      "images": [], "chars": len(text)}))

if __name__ == "__main__":
    main()
