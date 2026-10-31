# Audio/Video Transcription & Diarization Toolkit

High-accuracy multilingual audio and video transcription toolkit powered by a joint pipeline combining NVIDIA's
[Nemotron-3.5-Transcribe-30B-A4B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B) Speech-Augmented Language Model,
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (large-v3), and local LLM reconciliation + speaker mapping via Ollama (`qwen3.8:27b-q4_K_M`).

---

## Architecture & How It Works

1. **Pass 1: Nemotron-3.5 Speech-Augmented LLM (GGUF / NeMo-Speech.cpp)**
   - Computes verbatim transcription and word-level speaker turn boundaries in a single high-speed pass (~17–20× real time).
   - Frees GPU memory before the next stage.
2. **Pass 2: faster-whisper (large-v3)**
   - Performs state-of-the-art multilingual acoustic transcription with word timestamps.
   - Frees GPU memory before the next stage.
3. **Pass 3: ASR-Aware LLM Reconciliation via Ollama (`qwen3.8:27b`)**
   - Synthesizes the two hypotheses using an acoustic-disambiguation and grammatical recovery prompt.
   - Automatically canonicalizes English/technical terminology into proper Latin script (`GPU`, `API`, `pipeline`, `database`, `upgrade`, etc.).
   - Maps fine-grained speaker attribution onto the reconciled speech turns.
4. **Pass 4: Speaker Identity Mapping & Markdown Generation**
   - Resolves speaker IDs to actual names from conversational context.
   - Generates a structured Markdown output with an executive summary and timestamped transcript.

A dedicated Python 3.12 virtual environment is maintained in `/tmp/transcribe_env/`.

---

## Prerequisites

1. **System & Drivers**:
   - Ubuntu Linux with NVIDIA GPU and CUDA 12+ driver support:
     - **≥ 24 GB VRAM**: (e.g. RTX 3090, RTX 4090, A5000) for running the full Nemotron-3.5 (15.5GB Q2_0_L) + Whisper large-v3 + 27B LLM reconciliation.
   - `ffmpeg`, `uv`, and `ollama` (all checked and installed automatically by `make setup` if missing).
2. **Hugging Face Token**:
   - A token with read access to NVIDIA repositories if utilizing HF transformers directly.

---

## Quick Start

```bash
# 1. Setup virtual environment, dependencies, Nemotron-3.5 runtime & Ollama model (one-time)
make setup

# 2. Diarize, transcribe, reconcile & map speakers for a single audio/video file
make run FILE="path/to/meeting.mp4"

# 3. Batch process all media files recursively in a directory
make run DIR="path/to/recordings_folder"
```

---

## Makefile Targets & Workflows

### `make setup`
Fully prepares the system and environment:
- Checks and installs `ffmpeg` and Astral `uv` if missing.
- Checks and installs `ollama` if missing, ensures the service is active, and pulls `$(LLM_MODEL)` (`qwen3.8:27b-q4_K_M` by default).
- Creates `/tmp/transcribe_env` using Python 3.12.
- Installs PyTorch CUDA, `transformers`, `faster-whisper`, `openai-whisper`, `soundfile`, and pins `av==18.1.0`.
- Downloads and verifies the `NeMo-Speech.cpp` CUDA runtime and the `NVIDIA-Nemotron-3.5-Transcribe-30B-A4B` GGUF models.

### `make run FILE="..."` (Single File)
Runs the complete end-to-end pipeline on an audio or video file (`.mp4`, `.m4a`, `.wav`, `.mp3`, `.mkv`, etc.):
1. Extracts 16kHz mono audio via FFmpeg.
2. Runs `Nemotron-3.5` on CUDA for verbatim transcription and speaker tracking.
3. Automatically frees GPU VRAM (`torch.cuda.empty_cache()`).
4. Runs `faster-whisper` (`large-v3` by default).
5. Automatically frees GPU VRAM.
6. Reconciles both transcriptions with the local LLM to reconstruct clean grammar, resolve acoustic confusions, and restore English technical terms.
7. Automatically invokes `map_speakers.py` to identify speakers, generate a concise summary, suggest a file title, replace speaker tags, save the final output as a structured Markdown file (`<Title>.md`), and clean up intermediate files.
8. Unloads the Ollama model from GPU memory to leave the GPU clean.

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

