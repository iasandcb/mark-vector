"""Speaker-diarized transcription of an audio file into a Markdown document.

OpenAI's gpt-4o-transcribe-diarize is the only diarizing model on the
Audio API - https://developers.openai.com/api/docs/guides/speech-to-text -
and it needs a real OPENAI_API_KEY: the ChatGPT-plan route (see
chatgpt_auth.py) explicitly doesn't cover the transcription endpoints.
"""

import asyncio
import shutil
import tempfile
from datetime import datetime
from pathlib import Path

from openai import AsyncOpenAI

from .config import settings

MODEL = "gpt-4o-transcribe-diarize"
# The API's per-file cap is 25 MB; leave headroom for multipart overhead.
MAX_UPLOAD_BYTES = 24 * 1024 * 1024
# What an oversized file is re-encoded to before upload: mono 16 kHz Opus
# at 24 kbps is ~10.8 MB/hour - plenty for speech, and keeps a multi-hour
# meeting in *one* request, which matters here: speaker labels are only
# consistent within a single request, so splitting a recording into
# chunks would turn one person into "A" in one half and "C" in the other.
_COMPRESS_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "webm"]

_LABELS = {
    "en": {"speakers": "{n} speakers", "title": "Transcript"},
    "ko": {"speakers": "화자 {n}명", "title": "전사"},
    "ja": {"speakers": "話者{n}人", "title": "文字起こし"},
}


def available() -> bool:
    return bool(settings.openai_api_key)


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


async def compress(src: Path) -> Path:
    """Re-encode `src` into a small speech-grade webm next to it."""
    if not ffmpeg_available():
        raise RuntimeError("파일이 25MB를 넘는데 서버에 ffmpeg가 없어 압축할 수 없습니다")
    dst = src.with_suffix(".compressed.webm")
    proc = await asyncio.create_subprocess_exec(
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(src), *_COMPRESS_ARGS, str(dst),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"오디오 변환 실패: {stderr.decode(errors='replace').strip()[:300]}")
    if dst.stat().st_size > MAX_UPLOAD_BYTES:
        raise RuntimeError("압축 후에도 25MB를 넘습니다 - 녹음을 나눠서 올려 주세요")
    return dst


async def transcribe(path: Path, filename: str, language: str | None = None) -> list[dict]:
    """Returns [{speaker, text, start, end}, ...] in time order."""
    if not available():
        raise RuntimeError("전사에는 OPENAI_API_KEY가 필요합니다 (ChatGPT 플랜으로는 전사 API를 쓸 수 없습니다)")
    client = AsyncOpenAI(api_key=settings.openai_api_key, timeout=1800, max_retries=1)
    kwargs = {}
    if language:
        kwargs["language"] = language
    with path.open("rb") as f:
        result = await client.audio.transcriptions.create(
            model=MODEL,
            file=(filename, f),
            response_format="diarized_json",
            chunking_strategy="auto",
            **kwargs,
        )
    segments = []
    for seg in getattr(result, "segments", None) or []:
        text = (seg.text or "").strip()
        if text:
            segments.append({"speaker": seg.speaker, "text": text, "start": seg.start, "end": seg.end})
    return segments


def _timestamp(seconds: float) -> str:
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def to_markdown(segments: list[dict], title: str, language: str = "en", recorded_at: datetime | None = None) -> str:
    """One paragraph per speaker turn - consecutive segments from the same
    speaker are merged, since the model splits on pauses, not on turns.
    Speaker labels stay exactly as returned ("A", "B", ...) so renaming one
    is a plain find-and-replace of "**A**" in the editor."""
    labels = _LABELS.get(language, _LABELS["en"])
    turns: list[dict] = []
    for seg in segments:
        if turns and turns[-1]["speaker"] == seg["speaker"]:
            turns[-1]["text"] += " " + seg["text"]
        else:
            turns.append(dict(seg))

    speakers = list(dict.fromkeys(t["speaker"] for t in turns))
    duration = segments[-1]["end"] if segments else 0
    when = (recorded_at or datetime.now()).strftime("%Y-%m-%d %H:%M")
    meta = " · ".join([when, _timestamp(duration), labels["speakers"].format(n=len(speakers)), MODEL])

    lines = [f"# {title or labels['title']}", "", f"> {meta}", ""]
    for turn in turns:
        lines += [f"**{turn['speaker']}** `{_timestamp(turn['start'])}` {turn['text']}", ""]
    return "\n".join(lines)


def spool_dir() -> Path:
    return Path(tempfile.mkdtemp(prefix="mv-transcribe-"))
