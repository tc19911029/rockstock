#!/usr/bin/env python3
"""
Whisper transcribe wrapper for YouTube／陸股節目無字幕來源。

Apple Silicon 優先使用 MLX Whisper（GPU）；其他環境或 MLX 失敗時回退
faster-whisper（CPU）。兩種 backend 都輸出相同 WEBVTT。

Usage:
    python3 whisper-transcribe.py <audio_file> [model_name] [language]

預設：model=medium, language=zh

輸出：WEBVTT 格式到 stdout，符合 yt-dlp --convert-subs vtt 的格式，
       直接餵給 lib/youtube/transcript.ts:parseVtt() 解析。
"""

import sys
import os
import platform

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

    # mlx-whisper 內部以 `ffmpeg` 指令解碼；launchd／Next 的 PATH 不一定含使用者工具目錄。
    local_bin = os.path.join(os.path.expanduser("~"), ".local", "bin")
    if os.path.isfile(os.path.join(local_bin, "ffmpeg")):
        os.environ["PATH"] = f"{local_bin}:{os.environ.get('PATH', '')}"

    backend = os.environ.get("WHISPER_BACKEND", "auto")
    use_mlx = backend != "faster_whisper" and platform.machine() == "arm64"
    segments = None
    detected_language = language
    duration = 0.0

    if use_mlx:
        try:
            import mlx_whisper
            mlx_model = os.environ.get("MLX_WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")
            print(f"[whisper] backend=mlx model={mlx_model} language={language}", file=sys.stderr)
            result = mlx_whisper.transcribe(
                audio_path,
                path_or_hf_repo=mlx_model,
                language=language,
                verbose=False,
            )
            segments = result.get("segments", [])
            detected_language = result.get("language", language)
            duration = segments[-1].get("end", 0.0) if segments else 0.0
        except Exception as e:
            print(f"[whisper] MLX unavailable/failed, falling back to faster-whisper: {e}", file=sys.stderr)

    if segments is None:
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            print(f"ERROR: no Whisper backend available ({e})", file=sys.stderr)
            sys.exit(4)
        print(f"[whisper] backend=faster-whisper model={model_name} language={language}", file=sys.stderr)
        model = WhisperModel(model_name, device="auto", compute_type="auto")
        faster_segments, info = model.transcribe(
            audio_path,
            language=language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        segments = faster_segments
        detected_language = info.language
        duration = info.duration

    print(f"[whisper] detected_language={detected_language} duration={duration:.1f}s", file=sys.stderr)

    # 輸出 VTT
    sys.stdout.write("WEBVTT\n")
    sys.stdout.write(f"Kind: captions\n")
    sys.stdout.write(f"Language: {detected_language}\n\n")

    seg_count = 0
    for seg in segments:
        text = (seg.get("text", "") if isinstance(seg, dict) else seg.text).strip()
        if not text:
            continue
        start_seconds = seg.get("start", 0.0) if isinstance(seg, dict) else seg.start
        end_seconds = seg.get("end", start_seconds) if isinstance(seg, dict) else seg.end
        start = fmt_ts(start_seconds)
        end = fmt_ts(end_seconds)
        sys.stdout.write(f"{start} --> {end}\n")
        sys.stdout.write(f"{text}\n\n")
        seg_count += 1

    print(f"[whisper] wrote {seg_count} cues", file=sys.stderr)


if __name__ == "__main__":
    main()
