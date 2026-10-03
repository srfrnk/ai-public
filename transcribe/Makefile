# =============================================================================
# Transcription & Diarization Toolkit (Whisper + Nemotron-3 + Ollama LLM)
#
# Targets:
#   make setup            — Create Python 3.12 venv in /tmp/transcribe_env & install deps
#   make run FILE=...     — Diarize, transcribe & map speaker names for a single file
#   make run DIR=...      — Diarize, transcribe & map speaker names for a directory
#   make clean            — Remove the Python virtual environment
#   make help             — Show this help
#
# Overridable variables (pass on the command line):
#   FILE       = path to a single audio/video file
#   DIR        = path to directory containing media files (alternative to FILE)
#   MODEL      = large-v3 (default, best multilingual quality; requires >= 8GB VRAM)
#   LANGUAGE   = he (default, or 'auto', 'en', etc.)
#   DEVICE     = auto (cuda GPU default, cpu fallback)
#   LLM_MODEL  = qwen3:30b (default local LLM model for speaker mapping)
#   EXTRA      = any extra flags (e.g. --duration 60, --print-transcript)
#
# Examples:
#   make run FILE="my_meeting.mp4"
#   make run DIR="10 Zoom"
# =============================================================================

TRANSCRIBE_DIR := $(shell pwd)
VENV_DIR       := /tmp/transcribe_env
PYTHON         := $(VENV_DIR)/bin/python
SCRIPT         := $(TRANSCRIBE_DIR)/transcribe.py

# Default options
FILE         :=
DIR          :=
MODEL        := large-v3
ASR_ENGINE   := faster-whisper
DEVICE       := auto
LANGUAGE     := he
LLM_MODEL    := qwen3:30b
EXTRA        :=

TARGET_PATH  := $(if $(DIR),$(DIR),$(FILE))

.PHONY: setup run check-target clean help

help:
	@echo ""
	@echo "  ╔══════════════════════════════════════════════════════════════╗"
	@echo "  ║         Audio/Video Transcription & Diarization Toolkit      ║"
	@echo "  ╚══════════════════════════════════════════════════════════════╝"
	@echo ""
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## /  /'
	@echo ""
	@echo "  Overridable variables:"
	@echo "    FILE       = $(FILE) (path to a single audio/video file or transcript)"
	@echo "    DIR        = $(DIR) (path to a folder with media files)"
	@echo "    MODEL      = $(MODEL) (Whisper ASR model)"
	@echo "    LLM_MODEL  = $(LLM_MODEL) (Local Ollama model for map-speakers)"
	@echo "    LANGUAGE   = $(LANGUAGE)"
	@echo "    DEVICE     = $(DEVICE)"
	@echo "    EXTRA      = $(EXTRA) (e.g. --duration 60, --apply)"
	@echo ""

## setup: Install system deps, create Python 3.12 venv, and install all dependencies
setup:
	@echo "════════════════════════════════════════════════════════"
	@echo " Step 1/4: Checking / installing FFmpeg & uv"
	@echo "════════════════════════════════════════════════════════"
	which ffmpeg > /dev/null || (sudo apt-get update -qq && sudo apt-get install -y ffmpeg)
	which uv > /dev/null || (curl -LsSf https://astral.sh/uv/install.sh | sh)
	@echo ""
	@echo "════════════════════════════════════════════════════════"
	@echo " Step 2/4: Checking / setting up Ollama & $(LLM_MODEL)"
	@echo "════════════════════════════════════════════════════════"
	@which ollama > /dev/null || (curl -fsSL https://ollama.com/install.sh | sh)
	@systemctl is-active --quiet ollama || (sudo systemctl start ollama 2>/dev/null || nohup ollama serve > /dev/null 2>&1 & sleep 3)
	@ollama list | grep -q "^$(LLM_MODEL)" || ollama pull $(LLM_MODEL)
	@echo ""
	@echo "════════════════════════════════════════════════════════"
	@echo " Step 3/4: Virtual Environment (/tmp/transcribe_env via Python 3.12)"
	@echo "════════════════════════════════════════════════════════"
	rm -rf $(VENV_DIR)
	uv venv --python 3.12 $(VENV_DIR)
	@echo ""
	@echo "════════════════════════════════════════════════════════"
	@echo " Step 4/4: Installing PyTorch CUDA, Transformers, faster-whisper"
	@echo "════════════════════════════════════════════════════════"
	uv pip install --python $(PYTHON) torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu124
	uv pip install --python $(PYTHON) "transformers>=5.18.0" faster-whisper openai-whisper soundfile librosa huggingface_hub "av==18.1.0"
	@echo ""
	@echo "✅ Setup complete. Run: make run FILE=\"my_video.mp4\" or make run DIR=\"my_folder\""

## run: Diarize, transcribe with Whisper & map speakers with local LLM (pass FILE=<path> or DIR=<path>)
run: check-target
	"$(PYTHON)" "$(SCRIPT)" "$(TARGET_PATH)" \
	  --model      $(MODEL) \
	  --asr-engine $(ASR_ENGINE) \
	  --device     $(DEVICE) \
	  --language   $(LANGUAGE) \
	  --llm-model  "$(LLM_MODEL)" \
	  $(EXTRA)

check-target:
	@if [ -z "$(TARGET_PATH)" ]; then \
	  echo "❌ Error: Either FILE or DIR is required."; \
	  echo "   Examples:"; \
	  echo "     make run FILE=\"path/to/media.mp4\""; \
	  echo "     make run DIR=\"path/to/videos_folder\""; \
	  exit 1; \
	fi

## clean: Remove the Python virtual environment
clean:
	rm -rf $(VENV_DIR)
	@echo "Removed $(VENV_DIR)"
