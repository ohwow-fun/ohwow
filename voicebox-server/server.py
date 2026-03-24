"""
Voicebox HTTP Server

FastAPI server wrapping Whisper (STT) and TTS for the @ohwow/workspace runtime.
Manages voice profiles and provides transcription + synthesis endpoints.
"""

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("voicebox")

app = FastAPI(title="Voicebox Server", version="1.0.0")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

DATA_DIR = Path(os.environ.get("VOICEBOX_DATA_DIR", os.path.expanduser("~/.ohwow/voicebox")))
PROFILES_FILE = DATA_DIR / "profiles.json"

whisper_model = None
tts_model = None
models_loaded = False


def _ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _load_profiles() -> list[dict]:
    if PROFILES_FILE.exists():
        return json.loads(PROFILES_FILE.read_text())
    return []


def _save_profiles(profiles: list[dict]):
    _ensure_data_dir()
    PROFILES_FILE.write_text(json.dumps(profiles, indent=2))


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    text: str
    profile_id: str = "default"
    language: str = "en"


class ModelLoadRequest(BaseModel):
    whisper_model: str = "base"
    tts_model: str = "tts_models/en/ljspeech/tacotron2-DDC"


class ProfileCreate(BaseModel):
    name: str
    language: str = "en"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
async def health():
    return {
        "status": "ok",
        "service": "voicebox",
        "model_loaded": models_loaded,
    }


@app.post("/models/load")
async def load_models(request: ModelLoadRequest = ModelLoadRequest()):
    """Preload Whisper and TTS models into memory."""
    global whisper_model, tts_model, models_loaded

    if models_loaded:
        return {"status": "already_loaded"}

    try:
        # Load Whisper
        logger.info(f"Loading Whisper model: {request.whisper_model}")
        import whisper
        whisper_model = await asyncio.to_thread(whisper.load_model, request.whisper_model)
        logger.info("Whisper model loaded")

        # Load TTS
        try:
            logger.info(f"Loading TTS model: {request.tts_model}")
            from TTS.api import TTS as CoquiTTS
            tts_model = await asyncio.to_thread(CoquiTTS, request.tts_model)
            logger.info("TTS model loaded")
        except Exception as e:
            logger.warning(f"TTS model load failed (synthesis will be unavailable): {e}")

        models_loaded = True
        return {"status": "loaded"}
    except Exception as e:
        logger.error(f"Model load failed: {e}")
        return {"status": "error", "error": str(e)}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...), language: Optional[str] = Form(None)):
    """Transcribe audio to text using Whisper."""
    global whisper_model

    if whisper_model is None:
        # Auto-load on first use
        import whisper
        whisper_model = await asyncio.to_thread(whisper.load_model, "base")

    import tempfile
    audio_data = await file.read()

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_data)
        tmp.flush()

        options = {}
        if language:
            options["language"] = language

        result = await asyncio.to_thread(
            whisper_model.transcribe, tmp.name, **options
        )

    return {
        "text": result["text"].strip(),
        "language": result.get("language", language),
    }


@app.post("/generate")
async def generate(request: GenerateRequest):
    """Synthesize text to audio using TTS."""
    global tts_model

    if tts_model is None:
        try:
            from TTS.api import TTS as CoquiTTS
            tts_model = await asyncio.to_thread(CoquiTTS, "tts_models/en/ljspeech/tacotron2-DDC")
        except Exception as e:
            return Response(content=str(e), status_code=503, media_type="text/plain")

    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        # Check if profile has a speaker wav for voice cloning
        speaker_wav = None
        if request.profile_id != "default":
            profiles = _load_profiles()
            profile = next((p for p in profiles if p["id"] == request.profile_id), None)
            if profile and profile.get("samples"):
                speaker_wav = profile["samples"][0]  # Use first sample

        if speaker_wav and hasattr(tts_model, "tts_with_vc"):
            await asyncio.to_thread(
                tts_model.tts_to_file,
                text=request.text,
                file_path=tmp.name,
                speaker_wav=speaker_wav,
            )
        else:
            await asyncio.to_thread(
                tts_model.tts_to_file,
                text=request.text,
                file_path=tmp.name,
            )

        audio_bytes = Path(tmp.name).read_bytes()

    return Response(content=audio_bytes, media_type="audio/wav")


@app.get("/profiles")
async def list_profiles():
    """List all voice profiles."""
    profiles = _load_profiles()
    return {"profiles": profiles}


@app.post("/profiles")
async def create_profile(request: ProfileCreate):
    """Create a new voice profile."""
    profiles = _load_profiles()
    profile = {
        "id": str(uuid.uuid4()),
        "name": request.name,
        "language": request.language,
        "samples": [],
    }
    profiles.append(profile)
    _save_profiles(profiles)
    return profile


@app.post("/profiles/{profile_id}/samples")
async def upload_sample(
    profile_id: str,
    file: UploadFile = File(...),
    transcript: str = Form(""),
):
    """Upload a voice sample for a profile."""
    profiles = _load_profiles()
    profile = next((p for p in profiles if p["id"] == profile_id), None)
    if not profile:
        return Response(content="Profile not found", status_code=404)

    # Save sample to disk
    _ensure_data_dir()
    samples_dir = DATA_DIR / "samples" / profile_id
    samples_dir.mkdir(parents=True, exist_ok=True)

    sample_id = str(uuid.uuid4())
    sample_path = samples_dir / f"{sample_id}.wav"

    audio_data = await file.read()
    sample_path.write_bytes(audio_data)

    profile["samples"].append(str(sample_path))
    _save_profiles(profiles)

    return {"id": sample_id, "path": str(sample_path), "transcript": transcript}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
