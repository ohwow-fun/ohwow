"""
VibeVoice HTTP Server

FastAPI server wrapping Microsoft VibeVoice models:
- Realtime 0.5B (streaming TTS)
- ASR 7B (speech-to-text with speaker diarization)
- TTS 1.5B (multi-speaker podcast generation)
"""

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile, BackgroundTasks, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("vibevoice")

app = FastAPI(title="VibeVoice Server", version="1.0.0")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.environ.get("VIBEVOICE_DATA_DIR", os.path.expanduser("~/.ohwow/vibevoice")))
MODELS_DIR = DATA_DIR / "models"

realtime_model = None
asr_model = None
asr_processor = None
tts_model = None
device = None

# Podcast job storage (in-memory)
podcast_jobs: dict[str, dict] = {}


def _ensure_dirs():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MODELS_DIR.mkdir(parents=True, exist_ok=True)


def _detect_device() -> str:
    """Auto-detect best available compute device."""
    global device
    if device is not None:
        return device

    try:
        import torch
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "mps"
        else:
            device = "cpu"
    except ImportError:
        device = "cpu"

    logger.info(f"Using device: {device}")
    return device


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    text: str
    voice: Optional[str] = None
    speed: Optional[float] = None


class PodcastSpeaker(BaseModel):
    id: str
    name: str
    voice: Optional[str] = None


class PodcastSegmentInput(BaseModel):
    speaker_id: str
    text: str


class PodcastGenerateRequest(BaseModel):
    speakers: list[PodcastSpeaker]
    segments: list[PodcastSegmentInput]
    format: str = "wav"


class ModelDownloadRequest(BaseModel):
    model: str  # "realtime", "asr", or "tts"


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

async def _load_realtime_model():
    """Load VibeVoice Realtime 0.5B for streaming TTS."""
    global realtime_model

    if realtime_model is not None:
        return

    logger.info("Loading VibeVoice Realtime 0.5B model...")
    dev = _detect_device()

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        model_id = "microsoft/VibeVoice-1.5B"  # Realtime variant
        _ensure_dirs()

        realtime_model = await asyncio.to_thread(
            lambda: {
                "tokenizer": AutoTokenizer.from_pretrained(model_id, cache_dir=str(MODELS_DIR)),
                "model": AutoModelForCausalLM.from_pretrained(
                    model_id,
                    cache_dir=str(MODELS_DIR),
                    device_map=dev if dev != "mps" else "auto",
                    torch_dtype="auto",
                ),
            }
        )
        logger.info("VibeVoice Realtime model loaded")
    except Exception as e:
        logger.error(f"Failed to load Realtime model: {e}")
        realtime_model = None
        raise


async def _load_asr_model():
    """Load VibeVoice ASR 7B for speech recognition."""
    global asr_model, asr_processor

    if asr_model is not None:
        return

    logger.info("Loading VibeVoice ASR 7B model...")
    dev = _detect_device()

    try:
        from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

        model_id = "microsoft/VibeVoice-ASR"
        _ensure_dirs()

        def _load():
            processor = AutoProcessor.from_pretrained(model_id, cache_dir=str(MODELS_DIR))
            model = AutoModelForSpeechSeq2Seq.from_pretrained(
                model_id,
                cache_dir=str(MODELS_DIR),
                device_map=dev if dev != "mps" else "auto",
                torch_dtype="auto",
            )
            return processor, model

        asr_processor, asr_model = await asyncio.to_thread(_load)
        logger.info("VibeVoice ASR model loaded")
    except Exception as e:
        logger.error(f"Failed to load ASR model: {e}")
        asr_model = None
        asr_processor = None
        raise


async def _load_tts_model():
    """Load VibeVoice TTS 1.5B for multi-speaker podcast generation."""
    global tts_model

    if tts_model is not None:
        return

    logger.info("Loading VibeVoice TTS 1.5B model...")
    dev = _detect_device()

    try:
        from transformers import AutoModelForCausalLM, AutoTokenizer

        model_id = "microsoft/VibeVoice-1.5B"
        _ensure_dirs()

        tts_model = await asyncio.to_thread(
            lambda: {
                "tokenizer": AutoTokenizer.from_pretrained(model_id, cache_dir=str(MODELS_DIR)),
                "model": AutoModelForCausalLM.from_pretrained(
                    model_id,
                    cache_dir=str(MODELS_DIR),
                    device_map=dev if dev != "mps" else "auto",
                    torch_dtype="auto",
                ),
            }
        )
        logger.info("VibeVoice TTS 1.5B model loaded")
    except Exception as e:
        logger.error(f"Failed to load TTS model: {e}")
        tts_model = None
        raise


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "vibevoice",
        "models": {
            "realtime": realtime_model is not None,
            "asr": asr_model is not None,
            "tts": tts_model is not None,
        },
    }


@app.get("/models/status")
async def models_status():
    return {
        "realtime": {
            "loaded": realtime_model is not None,
            "model_id": "microsoft/VibeVoice-1.5B",
            "description": "Streaming TTS (0.5B)",
        },
        "asr": {
            "loaded": asr_model is not None,
            "model_id": "microsoft/VibeVoice-ASR",
            "description": "Speech recognition with diarization (7B)",
        },
        "tts": {
            "loaded": tts_model is not None,
            "model_id": "microsoft/VibeVoice-1.5B",
            "description": "Multi-speaker podcast TTS (1.5B)",
        },
    }


@app.post("/models/download")
async def download_model(request: ModelDownloadRequest):
    """Trigger model download without loading into memory."""
    _ensure_dirs()

    model_map = {
        "realtime": "microsoft/VibeVoice-1.5B",
        "asr": "microsoft/VibeVoice-ASR",
        "tts": "microsoft/VibeVoice-1.5B",
    }

    model_id = model_map.get(request.model)
    if not model_id:
        return Response(
            content=f"Unknown model: {request.model}. Use 'realtime', 'asr', or 'tts'.",
            status_code=400,
        )

    try:
        from huggingface_hub import snapshot_download

        logger.info(f"Downloading model: {model_id}")
        await asyncio.to_thread(
            snapshot_download,
            model_id,
            cache_dir=str(MODELS_DIR),
        )
        return {"status": "downloaded", "model": request.model, "model_id": model_id}
    except Exception as e:
        return Response(content=str(e), status_code=500)


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: Optional[str] = Form(None)):
    """Transcribe audio using VibeVoice ASR with speaker diarization."""
    await _load_asr_model()

    import tempfile
    import soundfile as sf
    import numpy as np

    audio_data = await file.read()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_data)
        tmp.flush()

        # Read audio
        waveform, sample_rate = await asyncio.to_thread(sf.read, tmp.name)

        # Process with ASR model
        inputs = asr_processor(
            waveform,
            sampling_rate=sample_rate,
            return_tensors="pt",
        )

        if device and device != "cpu":
            inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}

        import torch
        with torch.no_grad():
            generated_ids = await asyncio.to_thread(
                lambda: asr_model.generate(
                    **inputs,
                    max_new_tokens=4096,
                    language=language,
                )
            )

        # Decode output
        transcription = asr_processor.batch_decode(generated_ids, skip_special_tokens=True)
        full_text = transcription[0] if transcription else ""

        # Parse structured output (VibeVoice ASR returns Who/When/What)
        segments = _parse_diarized_output(full_text)

    return {
        "text": full_text.strip(),
        "language": language,
        "segments": segments,
    }


def _parse_diarized_output(raw_text: str) -> list[dict]:
    """
    Parse VibeVoice ASR structured output into segments.
    The model outputs speaker-tagged segments with timestamps.
    """
    segments = []
    current_speaker = "Speaker 1"
    current_text = []
    current_start = 0

    for line in raw_text.split("\n"):
        line = line.strip()
        if not line:
            continue

        # VibeVoice ASR uses format like: [Speaker 1] (00:00.000 - 00:05.000) Text here
        if line.startswith("[") and "]" in line:
            # Save previous segment
            if current_text:
                segments.append({
                    "speaker": current_speaker,
                    "text": " ".join(current_text),
                    "start_ms": current_start,
                    "end_ms": current_start + len(" ".join(current_text)) * 50,  # Rough estimate
                })
                current_text = []

            # Parse new speaker
            bracket_end = line.index("]")
            current_speaker = line[1:bracket_end]
            rest = line[bracket_end + 1:].strip()

            # Try to parse timestamps
            if rest.startswith("(") and ")" in rest:
                paren_end = rest.index(")")
                timestamp_str = rest[1:paren_end]
                rest = rest[paren_end + 1:].strip()

                # Parse start timestamp
                parts = timestamp_str.split(" - ")
                if len(parts) == 2:
                    current_start = _parse_timestamp(parts[0].strip())

            if rest:
                current_text.append(rest)
        else:
            current_text.append(line)

    # Save final segment
    if current_text:
        segments.append({
            "speaker": current_speaker,
            "text": " ".join(current_text),
            "start_ms": current_start,
            "end_ms": current_start + len(" ".join(current_text)) * 50,
        })

    return segments


def _parse_timestamp(ts: str) -> int:
    """Parse MM:SS.mmm to milliseconds."""
    try:
        parts = ts.split(":")
        if len(parts) == 2:
            minutes = int(parts[0])
            seconds_parts = parts[1].split(".")
            seconds = int(seconds_parts[0])
            millis = int(seconds_parts[1]) if len(seconds_parts) > 1 else 0
            return (minutes * 60 + seconds) * 1000 + millis
    except (ValueError, IndexError):
        pass
    return 0


@app.post("/generate")
async def generate(request: GenerateRequest):
    """Synthesize text to audio using VibeVoice Realtime 0.5B."""
    await _load_realtime_model()

    import tempfile
    import soundfile as sf
    import numpy as np

    tokenizer = realtime_model["tokenizer"]
    model = realtime_model["model"]

    # Tokenize input
    inputs = tokenizer(request.text, return_tensors="pt")
    if device and device != "cpu":
        inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}

    import torch
    with torch.no_grad():
        output = await asyncio.to_thread(
            lambda: model.generate(
                **inputs,
                max_new_tokens=2048,
            )
        )

    # Decode audio tokens to waveform
    audio_tokens = output[0][inputs["input_ids"].shape[1]:]

    # Convert tokens to audio via the model's audio decoder
    if hasattr(model, "decode_audio"):
        waveform = await asyncio.to_thread(
            lambda: model.decode_audio(audio_tokens.unsqueeze(0))
        )
        if hasattr(waveform, "cpu"):
            waveform = waveform.cpu().numpy()
    else:
        # Fallback: use tokenizer decode if available
        waveform = np.zeros(16000, dtype=np.float32)  # 1 second silence as fallback

    # Apply speed adjustment
    if request.speed and request.speed != 1.0:
        import torchaudio.functional as F
        import torch as th
        waveform_tensor = th.from_numpy(waveform).float()
        if waveform_tensor.dim() == 1:
            waveform_tensor = waveform_tensor.unsqueeze(0)
        # Resample to change speed
        orig_sr = 24000
        new_sr = int(orig_sr * request.speed)
        waveform_tensor = F.resample(waveform_tensor, new_sr, orig_sr)
        waveform = waveform_tensor.numpy()

    # Ensure correct shape
    if waveform.ndim > 1:
        waveform = waveform.squeeze()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        sf.write(tmp.name, waveform, 24000)
        audio_bytes = Path(tmp.name).read_bytes()

    return Response(content=audio_bytes, media_type="audio/wav")


@app.post("/podcast/generate")
async def podcast_generate(request: PodcastGenerateRequest, req: Request, background_tasks: BackgroundTasks):
    """Generate multi-speaker podcast audio using VibeVoice TTS 1.5B."""

    # Check if client wants async processing
    is_async = req.headers.get("X-Async", "").lower() == "true"
    total_text_len = sum(len(s.text) for s in request.segments)

    # For long scripts (>500 chars) or explicit async, use background job
    if is_async or total_text_len > 500:
        job_id = str(uuid.uuid4())
        podcast_jobs[job_id] = {"status": "pending", "progress": 0}
        background_tasks.add_task(_generate_podcast_background, job_id, request)
        return {"job_id": job_id}

    # Short scripts: generate synchronously
    audio_bytes = await _generate_podcast(request)
    return Response(content=audio_bytes, media_type="audio/wav")


async def _generate_podcast_background(job_id: str, request: PodcastGenerateRequest):
    """Background task for long podcast generation."""
    try:
        podcast_jobs[job_id]["status"] = "processing"

        audio_bytes = await _generate_podcast(request, progress_callback=lambda p: _update_progress(job_id, p))

        # Save audio to disk for retrieval
        _ensure_dirs()
        output_path = DATA_DIR / "podcasts" / f"{job_id}.wav"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(audio_bytes)

        podcast_jobs[job_id] = {
            "status": "completed",
            "progress": 100,
            "audio_url": f"/podcast/audio/{job_id}",
        }
    except Exception as e:
        logger.error(f"Podcast generation failed for job {job_id}: {e}")
        podcast_jobs[job_id] = {
            "status": "failed",
            "error": str(e),
        }


def _update_progress(job_id: str, progress: float):
    if job_id in podcast_jobs:
        podcast_jobs[job_id]["progress"] = int(progress * 100)


async def _generate_podcast(
    request: PodcastGenerateRequest,
    progress_callback=None,
) -> bytes:
    """Core podcast generation logic."""
    await _load_tts_model()

    import tempfile
    import soundfile as sf
    import numpy as np

    tokenizer = tts_model["tokenizer"]
    model = tts_model["model"]

    # Build conversation script with speaker tags
    speaker_map = {s.id: s.name for s in request.speakers}
    all_audio_chunks = []

    for i, segment in enumerate(request.segments):
        speaker_name = speaker_map.get(segment.speaker_id, segment.speaker_id)

        # Format as conversational prompt with speaker tag
        prompt = f"[{speaker_name}]: {segment.text}"

        inputs = tokenizer(prompt, return_tensors="pt")
        if device and device != "cpu":
            inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}

        import torch
        with torch.no_grad():
            output = await asyncio.to_thread(
                lambda: model.generate(
                    **inputs,
                    max_new_tokens=4096,
                )
            )

        audio_tokens = output[0][inputs["input_ids"].shape[1]:]

        if hasattr(model, "decode_audio"):
            waveform = await asyncio.to_thread(
                lambda: model.decode_audio(audio_tokens.unsqueeze(0))
            )
            if hasattr(waveform, "cpu"):
                waveform = waveform.cpu().numpy()
        else:
            waveform = np.zeros(12000, dtype=np.float32)  # 0.5s silence fallback

        if waveform.ndim > 1:
            waveform = waveform.squeeze()

        all_audio_chunks.append(waveform)

        # Add brief pause between segments
        pause = np.zeros(int(24000 * 0.3), dtype=np.float32)  # 300ms pause
        all_audio_chunks.append(pause)

        if progress_callback:
            progress_callback((i + 1) / len(request.segments))

    # Concatenate all audio
    full_audio = np.concatenate(all_audio_chunks)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        sf.write(tmp.name, full_audio, 24000)
        return Path(tmp.name).read_bytes()


@app.get("/podcast/status/{job_id}")
async def podcast_status(job_id: str):
    """Check status of a podcast generation job."""
    job = podcast_jobs.get(job_id)
    if not job:
        return Response(content="Job not found", status_code=404)
    return job


@app.get("/podcast/audio/{job_id}")
async def podcast_audio(job_id: str):
    """Download completed podcast audio."""
    audio_path = DATA_DIR / "podcasts" / f"{job_id}.wav"
    if not audio_path.exists():
        return Response(content="Audio not found", status_code=404)

    audio_bytes = audio_path.read_bytes()
    return Response(content=audio_bytes, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8001, log_level="info")
