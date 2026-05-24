#!/usr/bin/env python3
"""
mlx-whisper transcription core (M-series GPU accelerated).

Usage:
  python3 scripts/_yt_transcribe.py <audio_path> <output_dir> [model]

  model: large-v3-turbo (default) | medium | large-v3

Writes <output_dir>/transcript.txt and <output_dir>/segments.json.
"""
import json
import sys
import time
from pathlib import Path

import mlx_whisper

MODEL_REPOS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
}

INITIAL_PROMPT = (
    "這是台灣財經節目逐字稿，內容包含台股、AI、半導體、伺服器、CPO、光通訊、低軌衛星、"
    "記憶體、ETF、外資、投信、籌碼、千張大戶、本益比、EPS、毛利率、財報、技術分析、"
    "均線、KD、MACD、乖離率、停損、停利、跌停、漲停、蠅頭小利、複利、妖股、上市櫃、"
    "法人、操盤、可轉債（CB）、轉投資、避險、波段、台積電、聯發科、鴻海、台達電、"
    "光寶科、群聯、旺宏、輝達、超微、英特爾、聯亞、聯鈞、上詮、華星光、波若威、"
    "眾達-KY、神達、廣達、緯創、英業達、技嘉、華碩、和碩、緯穎、川湖、勤誠、"
    "信驊、智邦、博通、亞馬遜、Google、Meta、ChatGPT、OpenAI、輝達。"
    "常見主持人/來賓姓名：趙慶翔、雷老闆、陳威良、阿格力、杜金龍、林漢偉、"
    "蕭又銘、王榮旭、孫慶龍、林成蔭、林勁、蘇順發、蘇威達、林家洋。"
)


def main():
    if len(sys.argv) < 3:
        print("Usage: _yt_transcribe.py <audio> <out_dir> [model]", file=sys.stderr)
        sys.exit(1)

    audio = sys.argv[1]
    out_dir = Path(sys.argv[2])
    model = sys.argv[3] if len(sys.argv) > 3 else "large-v3-turbo"
    repo = MODEL_REPOS.get(model)
    if not repo:
        print(f"Unknown model: {model}. Use one of {list(MODEL_REPOS)}", file=sys.stderr)
        sys.exit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    progress_log = out_dir / "progress.log"

    def log(msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        with progress_log.open("a") as f:
            f.write(line + "\n")

    log(f"model={model} repo={repo}")
    log(f"audio={audio}")
    log("loading + transcribing (first run downloads ~1.5GB)...")

    t0 = time.time()
    result = mlx_whisper.transcribe(
        audio,
        path_or_hf_repo=repo,
        language="zh",
        initial_prompt=INITIAL_PROMPT,
        word_timestamps=False,
        verbose=False,
        condition_on_previous_text=True,
        temperature=0.0,
    )
    elapsed = time.time() - t0
    log(f"done in {elapsed:.1f}s, {len(result['segments'])} segments")

    txt_path = out_dir / "transcript.txt"
    json_path = out_dir / "segments.json"

    with txt_path.open("w") as f:
        for seg in result["segments"]:
            f.write(f"[{seg['start']:7.2f}-{seg['end']:7.2f}] {seg['text']}\n")

    with json_path.open("w") as f:
        json.dump(
            {
                "model": model,
                "language": result.get("language", "zh"),
                "duration": result["segments"][-1]["end"] if result["segments"] else 0,
                "segments": [
                    {"start": s["start"], "end": s["end"], "text": s["text"]}
                    for s in result["segments"]
                ],
                "full_text": result["text"],
            },
            f,
            ensure_ascii=False,
            indent=2,
        )

    log(f"wrote {txt_path}, {json_path}")


if __name__ == "__main__":
    main()
