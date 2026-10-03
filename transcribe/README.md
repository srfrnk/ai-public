# Audio/Video Transcription & Diarization Toolkit

Generic audio/video speaker diarization and transcription toolkit powered by NVIDIA's
[Nemotron-3-Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization) model paired with
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) for state-of-the-art multilingual ASR, and local LLM speaker mapping via Ollama.

A dedicated Python 3.12 virtual environment is placed in `/tmp/transcribe_env/`.

---

## Prerequisites

1. **System & Drivers**:
   - Ubuntu Linux with NVIDIA GPU and driver supporting CUDA 12+:
     - **≥ 24 GB VRAM**: Recommended for the default pipeline with 30B parameter LLM speaker mapping.
     - **≥ 12–16 GB VRAM**: Sufficient if choosing smaller LLMs (e.g., `LLM_MODEL=qwen2.5:7b` or `llama3.2:3b`).
     - **≥ 8 GB VRAM**: Sufficient for Diarization + Whisper ASR alone.
   - `ffmpeg`, `uv`, and `ollama` (all checked and installed automatically by `make setup` if missing).
2. **Hugging Face Token**:
   - A valid token with read access to `nvidia/Nemotron-3-Diarization` (either logged in via `huggingface-cli login` or exported in `HF_TOKEN`).

---

## Quick Start

```bash
# 1. Setup virtual environment, dependencies & Ollama model (one-time)
make setup

# 2. Diarize, transcribe & map speakers for a single audio/video file
make run FILE="path/to/meeting.mp4"

# 3. Batch process all media files recursively in a directory
make run DIR="path/to/recordings_folder"
```

---

## Makefile Targets & Workflows

### `make setup`
Fully prepares the system and environment:
- Checks and installs `ffmpeg` and Astral `uv` if missing.
- Checks and installs `ollama` if missing, ensures the service is active, and automatically pulls `$(LLM_MODEL)` (`qwen3:30b` by default).
- Creates `/tmp/transcribe_env` using Python 3.12.
- Installs PyTorch 2.6 with CUDA 12.4 support (`torch`, `torchvision`, `torchaudio`).
- Installs `transformers>=5.18.0` (required for Sortformer), `faster-whisper`, `openai-whisper`, `soundfile`, `librosa`, and pins `av==18.1.0` (required by `faster-whisper`).

### `make run FILE="..."` (Single File)
Runs the complete end-to-end pipeline on an audio or video file (`.mp4`, `.m4a`, `.wav`, `.mp3`, `.mkv`, etc.):
1. Extracts 16kHz mono audio via FFmpeg.
2. Runs `nvidia/Nemotron-3-Diarization` to compute speaker turns and boundaries.
3. Automatically frees diarizer GPU memory (`torch.cuda.empty_cache()`).
4. Runs `faster-whisper` (`large-v3` by default) constrained to diarized segments.
5. Generates the intermediate timestamped transcript.
6. Automatically invokes `map_speakers.py` to identify speakers, generate a concise summary, suggest a file title, replace speaker tags, save the final output as a structured Markdown file (`<Title>.md`) with `**Original File:** <filename>`, `# Title`, `## Summary`, and `## Transcript`, and clean up intermediate `.txt` transcripts.
7. Unloads the Ollama model from GPU memory to leave the GPU clean.

### `make run DIR="..."` (Batch Processing)
Recursively scans the given directory for all supported audio and video formats and executes the full pipeline on each file sequentially.

### `make clean`
Removes `/tmp/transcribe_env` cleanly.

---

## Console Output & Logging

- **Quiet by Default**: The pipeline logs progress, speaker mapping summaries, and file paths. Raw transcript lines are **not** printed to the terminal by default to keep logs clean.
- **Verbose Output**: To print the transcript lines to the console as they are generated, pass `EXTRA="--print-transcript"`:
  ```bash
  make run FILE="my_video.mp4" EXTRA="--print-transcript"
  ```

---

## Overridable Variables

You can override any variable directly on the command line:

| Variable | Default | Description / Options |
|---|---|---|
| `FILE` | _(empty)_ | Path to an audio/video file or transcript |
| `DIR` | _(empty)_ | Directory to recursively batch process |
| `MODEL` | `large-v3` | Whisper model: `tiny`, `base`, `small`, `medium`, `large-v2`, `large-v3`, `large-v3-turbo` |
| `LLM_MODEL` | `qwen3:30b` | Ollama model used for speaker mapping (e.g. `qwen3:30b`, `llama3.3:70b`) |
| `LANGUAGE` | `he` | Spoken language ISO code (`he`, `en`, `auto`) |
| `DEVICE` | `auto` | Execution device (`auto`, `cuda`, `cpu`) |
| `EXTRA` | _(empty)_ | Additional flags (e.g. `--print-transcript`, `--duration 60`, `--no-map-speakers`) |

