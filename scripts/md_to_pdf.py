#!/usr/bin/env python3
"""把 markdown 轉成中文友善 + 紅漲綠跌配色的 HTML，給 Chrome --print-to-pdf 用。

用法: python3 scripts/md_to_pdf.py <input.md> <output.html>
"""
import re
import sys
import markdown

src = sys.argv[1]
out_html = sys.argv[2]

with open(src, encoding="utf-8") as f:
    text = f.read()

body = markdown.markdown(
    text, extensions=["tables", "extra", "sane_lists"]
)

# 紅漲綠跌：表格內 +x% 標紅、-x% 標綠（台股慣例）
def color_cell(m):
    inner = m.group(2)
    cls = ""
    mm = re.fullmatch(r"([+\-])([\d.,]+)%", inner.strip())
    if mm:
        cls = "up" if mm.group(1) == "+" else "down"
    if cls:
        return f'<td{m.group(1)}><span class="{cls}">{inner}</span></td>'
    return m.group(0)

body = re.sub(r"<td([^>]*)>([^<]+)</td>", color_cell, body)

# ✅ / ⚠️ 上色
body = body.replace("✅", '<span class="ok">✅</span>')

html = f"""<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<style>
@page {{ size: A4 landscape; margin: 12mm 10mm; }}
* {{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }}
body {{
  font-family: "PingFang TC", "Heiti TC", "Noto Sans CJK TC", sans-serif;
  color: #1a1a1a; font-size: 12px; line-height: 1.5; margin: 0;
}}
h1 {{ font-size: 22px; margin: 0 0 6px; border-bottom: 3px solid #c0392b; padding-bottom: 6px; }}
h2 {{ font-size: 16px; margin: 18px 0 8px; color: #b03a2e; border-left: 5px solid #c0392b; padding-left: 8px; }}
h3 {{ font-size: 13px; margin: 12px 0 4px; color: #555; }}
blockquote {{ color: #666; border-left: 3px solid #ddd; margin: 4px 0; padding: 2px 10px; font-size: 11px; }}
ul {{ margin: 4px 0; padding-left: 20px; }}
li {{ margin: 2px 0; }}
table {{ border-collapse: collapse; width: 100%; margin: 6px 0 14px; font-size: 10.5px; }}
th, td {{ border: 1px solid #d5d5d5; padding: 3px 6px; text-align: left; }}
th {{ background: #2c3e50; color: #fff; font-weight: 600; }}
tr:nth-child(even) td {{ background: #f6f7f9; }}
td .up {{ color: #c0392b; font-weight: 600; }}    /* 紅 = 漲 */
td .down {{ color: #138d4e; font-weight: 600; }}   /* 綠 = 跌 */
.ok {{ color: #138d4e; }}
hr {{ border: none; border-top: 1px solid #ccc; margin: 16px 0; }}
em {{ color: #888; }}
</style>
</head>
<body>
{body}
</body>
</html>
"""

with open(out_html, "w", encoding="utf-8") as f:
    f.write(html)
print(f"HTML 寫出: {out_html}")
