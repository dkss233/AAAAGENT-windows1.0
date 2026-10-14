"""Native Windows Qwen3-TTS Base service with a server-owned voice reference.

Prepare with tools/prepare-qwen.ps1. This process loads only the pinned local
model, uses CUDA SDPA/eager without flash-attn, and never accepts audio paths,
URLs, prompts, weights, or credentials in synthesis requests.
"""

import argparse
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import io
import json
import logging
import os
from pathlib import Path
import platform
import threading
import time
from typing import Literal


MODEL_ID = "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
MODEL_REVISION = "5d83992436eae1d760afd27aff78a71d676296fc"
DEFAULT_TEXT = "你好，今天我们一起测试本地语音。"
VOICE_ID = "pet-reference"
DEFAULT_DATA = Path(__file__).resolve().parents[2] / ".local" / "local-models"
LOGGER = logging.getLogger("qwen-service")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=DEFAULT_DATA)
    parser.add_argument("--model-dir", type=Path)
    parser.add_argument("--reference", type=Path)
    parser.add_argument("--reference-text", default=DEFAULT_TEXT)
    parser.add_argument("--reference-kind", choices=("synthetic-smoke", "user-provided"), default="synthetic-smoke")
    parser.add_argument("--port", type=int, default=8093)
    parser.add_argument("--attention", choices=("sdpa", "eager"), default="sdpa")
    parser.add_argument("--device", choices=("cuda:0", "cpu"), default="cuda:0")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    args.data_dir = args.data_dir.resolve()
    args.model_dir = (args.model_dir or args.data_dir / "models" / "qwen3-tts-0.6b-base").resolve()
    args.reference = (args.reference or args.data_dir / "samples" / "kokoro-smoke.wav").resolve()
    if not 1024 <= args.port <= 65535:
        parser.error("Use a port between 1024 and 65535.")
    if not args.reference_text.strip():
        parser.error("The server reference transcript must not be empty.")
    return args


def configure_local_runtime(data_dir: Path) -> None:
    cache = data_dir / "cache" / "qwen"
    cache.mkdir(parents=True, exist_ok=True)
    # Set these before importing Hugging Face or Qwen. A local model missing a
    # resource fails offline rather than looking at a user's HF login/cache.
    os.environ["HF_HOME"] = str(cache / "huggingface")
    os.environ["HF_TOKEN_PATH"] = str(cache / "unused-token")
    os.environ["HF_TOKEN"] = ""
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["GRADIO_ANALYTICS_ENABLED"] = "False"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    os.environ["NUMBA_CACHE_DIR"] = str(cache / "numba")


def create_app(args: argparse.Namespace):
    configure_local_runtime(args.data_dir)
    import numpy as np
    import soundfile as sf
    import torch
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.exceptions import RequestValidationError
    from fastapi.responses import JSONResponse, Response
    from pydantic import BaseModel, ConfigDict, Field, StrictStr
    from qwen_tts import Qwen3TTSModel

    class SpeechRequest(BaseModel):
        model_config = ConfigDict(extra="forbid")
        model: StrictStr
        input: StrictStr = Field(min_length=1, max_length=300)
        voice: Literal["pet-reference"] = VOICE_ID
        response_format: Literal["wav"] = "wav"
        speed: float = Field(default=1.0, ge=1.0, le=1.0)
        stream: Literal[False] = False

    state: dict = {"ready": False}
    synthesis_lock = threading.Lock()

    @asynccontextmanager
    async def lifespan(app):
        started = time.perf_counter()
        marker_path = args.model_dir / ".aaaagent-installed.json"
        if not marker_path.is_file():
            raise RuntimeError("Run tools/prepare-qwen.ps1 before starting the Qwen service.")
        marker = json.loads(marker_path.read_text(encoding="utf-8-sig"))
        if marker.get("repository") != MODEL_ID or marker.get("revision") != MODEL_REVISION:
            raise RuntimeError("The Qwen installation manifest does not match the pinned model.")
        for item in marker.get("files", []):
            relative = Path(item["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise RuntimeError("Invalid path in Qwen installation manifest.")
            resource = args.model_dir / relative
            if not resource.is_file() or resource.stat().st_size != item["size"]:
                raise RuntimeError(f"Qwen model resource is incomplete: {relative}. Rerun the preparation script.")
        if not args.reference.is_file():
            raise RuntimeError("Configured reference WAV is missing. Generate the Kokoro smoke sample or pass --reference and --reference-text.")
        if args.device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError("CUDA is unavailable. Install the pinned cu128 environment or explicitly use --device cpu.")
        torch.set_num_threads(4)
        reference, reference_sr = sf.read(args.reference, dtype="float32", always_2d=True)
        reference = reference.mean(axis=1)
        seconds = len(reference) / reference_sr
        if not 3.0 <= seconds <= 30.0 or not np.isfinite(reference).all() or np.max(np.abs(reference)) < 1e-5:
            raise RuntimeError("Use a finite, audible 3–30 second reference WAV.")
        state["referenceSha256"] = hashlib.sha256(args.reference.read_bytes()).hexdigest()
        state["referenceSeconds"] = round(seconds, 3)
        LOGGER.info("Loading pinned Qwen Base model on %s with %s", args.device, args.attention)
        model = Qwen3TTSModel.from_pretrained(
            str(args.model_dir),
            device_map=args.device,
            dtype=torch.bfloat16 if args.device.startswith("cuda") else torch.float32,
            attn_implementation=args.attention,
            local_files_only=True,
            token=False,
        )
        model.model.eval()
        with torch.inference_mode():
            prompt = model.create_voice_clone_prompt(
                ref_audio=(reference, reference_sr),
                ref_text=args.reference_text,
                x_vector_only_mode=False,
            )
        state.update({
            "model": model,
            "prompt": prompt,
            "ready": True,
            "loadMs": round((time.perf_counter() - started) * 1000),
            "startedAt": datetime.now(timezone.utc).isoformat(),
        })
        LOGGER.info("Qwen ready; model and reference prompt loaded in %s ms", state["loadMs"])
        try:
            yield
        finally:
            state["ready"] = False
            state.pop("prompt", None)
            state.pop("model", None)
            if args.device.startswith("cuda"):
                torch.cuda.empty_cache()

    app = FastAPI(title="AAAAGENT local Qwen3-TTS", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        # Do not echo reference paths or arbitrary request bodies in errors.
        return JSONResponse(status_code=400, content={"error": {"message": "Use the loaded model, voice pet-reference, 1–300 characters, WAV, speed 1, and stream false. Extra fields are not accepted.", "type": "invalid_request_error"}})

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"error": {"message": str(exc.detail), "type": "invalid_request_error"}}, headers=exc.headers)

    @app.get("/health")
    def health():
        return {
            "status": "ok" if state["ready"] else "loading",
            "ready": state["ready"],
            "model": MODEL_ID,
            "revision": MODEL_REVISION,
            "device": args.device,
            "deviceName": torch.cuda.get_device_name(0) if args.device.startswith("cuda") else platform.processor(),
            "dtype": "bfloat16" if args.device.startswith("cuda") else "float32",
            "attention": args.attention,
            "voice": VOICE_ID,
            "referenceKind": args.reference_kind,
            "referenceSha256": state.get("referenceSha256"),
            "referenceSeconds": state.get("referenceSeconds"),
            "loadMs": state.get("loadMs"),
            "versions": {key: version(key) for key in ("qwen-tts", "torch", "torchaudio", "transformers", "accelerate", "fastapi", "uvicorn", "soundfile")},
            "python": platform.python_version(),
            "platform": platform.platform(),
            "cuda": torch.version.cuda,
            "busy": synthesis_lock.locked(),
        }

    @app.get("/v1/models")
    def models():
        return {"object": "list", "data": [{"id": MODEL_ID, "object": "model", "created": 0, "owned_by": "local"}]}

    @app.post("/v1/audio/speech")
    def speech(body: SpeechRequest):
        if body.model != MODEL_ID:
            raise HTTPException(400, f"This service loads {MODEL_ID}.")
        if not body.input.strip():
            raise HTTPException(400, "Input must contain speech text.")
        if not state["ready"]:
            raise HTTPException(503, "Qwen is not ready.")
        if not synthesis_lock.acquire(blocking=False):
            raise HTTPException(503, "Qwen is synthesizing another request. Retry after it finishes.", headers={"Retry-After": "1"})
        started = time.perf_counter()
        try:
            # FastAPI runs this synchronous handler in a worker. A client
            # disconnect never releases the GPU lock until generation finishes.
            with torch.inference_mode():
                torch.manual_seed(args.seed)
                wavs, sample_rate = state["model"].generate_voice_clone(
                    text=body.input.strip(),
                    language="Chinese",
                    voice_clone_prompt=state["prompt"],
                    non_streaming_mode=True,
                    max_new_tokens=1024,
                )
            wav = np.asarray(wavs[0], dtype=np.float32).reshape(-1)
            if not len(wav) or not np.isfinite(wav).all() or np.max(np.abs(wav)) < 1e-5:
                raise RuntimeError("Qwen returned invalid or silent audio.")
            output = io.BytesIO()
            sf.write(output, wav, sample_rate, format="WAV", subtype="PCM_16")
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            LOGGER.info("Generated %d characters, %.3f seconds of %d Hz WAV in %d ms", len(body.input), len(wav) / sample_rate, sample_rate, elapsed_ms)
            return Response(output.getvalue(), media_type="audio/wav", headers={
                "X-Audio-Sample-Rate": str(sample_rate),
                "X-Synthesis-Ms": str(elapsed_ms),
                "Cache-Control": "no-store",
            })
        except Exception:
            LOGGER.exception("Qwen synthesis failed")
            raise HTTPException(500, "Qwen synthesis failed. Inspect the local service log.") from None
        finally:
            synthesis_lock.release()

    return app


def main() -> None:
    args = parse_arguments()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    app = create_app(args)
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, limit_concurrency=8)


if __name__ == "__main__":
    main()
