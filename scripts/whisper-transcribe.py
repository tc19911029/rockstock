#!/usr/bin/env python3
"""
Whisper transcribe wrapper (faster-whisper backend) for YouTube 無字幕來源。

Usage:
    python3 whisper-transcribe.py <audio_file> [model_name] [language]

預設：model=medium, language=zh

輸出：WEBVTT 格式到 stdout，符合 yt-dlp --convert-subs vtt 的格式，
       直接餵給 lib/youtube/transcript.ts:parseVtt() 解析。
"""

import sys
import os
from datetime import timedelta

def fmt_ts(seconds: float) -> str:
    """Convert seconds to HH:MM:SS.mmm VTT timestamp."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def main():
    if len(sys.argv) < 2:
        print("Usage: whisper-transcribe.py <audio> [model] [language]", file=sys.stderr)
        sys.exit(2)

    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "medium"
    language = sys.argv[3] if len(sys.argv) > 3 else "zh"

    if not os.path.isfile(audio_path):
        print(f"ERROR: audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(3)

    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        print(f"ERROR: faster-whisper not installed ({e}). Run: pip install --user faster-whisper", file=sys.stderr)
        sys.exit(4)

    # 模型自動下載到 ~/.cache/huggingface
    # device='auto' → Mac M-series 用 Metal/CPU 混合；compute_type='auto' → int8 加速
    print(f"[whisper] loading model={model_name} language={language}", file=sys.stderr)
    model = WhisperModel(model_name, device="auto", compute_type="auto")

    print(f"[whisper] transcribing {audio_path}", file=sys.stderr)
    segments, info = model.transcribe(
        audio_path,
        language=language,
        beam_size=5,
        vad_filter=True,           # 跳過長段靜音
        vad_parameters={"min_silence_duration_ms": 500},
    )

    print(f"[whisper] detected_language={info.language} duration={info.duration:.1f}s", file=sys.stderr)

    # 輸出 VTT
    sys.stdout.write("WEBVTT\n")
    sys.stdout.write(f"Kind: captions\n")
    sys.stdout.write(f"Language: {info.language}\n\n")

    seg_count = 0
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        start = fmt_ts(seg.start)
        end = fmt_ts(seg.end)
        sys.stdout.write(f"{start} --> {end}\n")
        sys.stdout.write(f"{text}\n\n")
        seg_count += 1

    print(f"[whisper] wrote {seg_count} cues", file=sys.stderr)


if __name__ == "__main__":
    main()
