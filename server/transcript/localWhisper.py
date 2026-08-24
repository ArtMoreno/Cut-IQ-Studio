"""Run one local faster-whisper transcription and write segment timings as JSON.

This helper deliberately emits only segment timings.  ClipSift's transcript
reader currently seeks at segment granularity, and emitting guessed word-level
offsets would misrepresent what the local model produced.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from faster_whisper import WhisperModel


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    if len(sys.argv) != 5:
        fail("Expected audio path, local model path, output path, and optional language.")

    audio_path = Path(sys.argv[1])
    model_path = Path(sys.argv[2])
    output_path = Path(sys.argv[3])
    language_hint = sys.argv[4].strip() or None

    if not audio_path.is_file():
        fail("The downloaded audio file is missing.")
    if not model_path.is_dir():
        fail("The configured local Whisper model is missing.")

    # The model is supplied as an explicit local directory; no model name is
    # accepted here, so this path does not trigger a model download.
    model = WhisperModel(str(model_path), device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(audio_path),
        language=language_hint,
        beam_size=5,
        word_timestamps=False,
        vad_filter=False,
        condition_on_previous_text=False,
    )

    output_segments: list[dict[str, object]] = []
    for segment in segments:
        text = " ".join(segment.text.split()).strip()
        start = float(segment.start)
        end = float(segment.end)
        # Do not synthesize or repair timing.  A malformed segment is excluded
        # rather than being assigned a guessed duration.
        if text and start >= 0 and end > start:
            output_segments.append({"text": text, "start": start, "end": end})

    payload = {
        "language": getattr(info, "language", None) or language_hint or "und",
        "segments": output_segments,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
