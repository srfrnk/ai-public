#!/usr/bin/env python3
"""
transcribe.py — Audio/video speaker diarization and transcription using NVIDIA Nemotron-3-Diarization
and faster-whisper.

Diarization Engine: nvidia/Nemotron-3-Diarization (via Hugging Face transformers)
ASR Engine        : faster-whisper (default) | openai-whisper
Devices           : auto (GPU → CPU fallback) | cuda | cpu
Models            : tiny | base | small | medium | large-v2 | large-v3 (default) | large-v3-turbo

Output format:
    <input_dir>/<input_stem>.txt
    e.g. 2026-07-12_kickoff_audio.txt

See README.md for full documentation.
"""

import argparse
import os
import sys
import subprocess
import tempfile
from typing import List, Dict, Any, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
NEMOTRON_MODEL_ID = "nvidia/Nemotron-3-Diarization"
SUPPORTED_ASR_ENGINES = ["faster-whisper", "openai-whisper"]
SUPPORTED_MODELS = ["tiny", "base", "small", "medium", "large-v2", "large-v3", "large-v3-turbo"]
SUPPORTED_DEVICES = ["auto", "cuda", "cpu"]
SUPPORTED_FORMATS = ["txt", "md", "json", "rttm"]


# ---------------------------------------------------------------------------
# Device resolution
# ---------------------------------------------------------------------------
def resolve_device(requested: str) -> str:
    """Resolve 'auto' -> 'cuda' or 'cpu' based on runtime availability."""
    if requested != "auto":
        return requested
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            print(f"✅ GPU detected: {name} — using CUDA")
            return "cuda"
    except ImportError:
        pass
    print("⚠️  No GPU detected — falling back to CPU")
    return "cpu"


# ---------------------------------------------------------------------------
# Output path builder
# ---------------------------------------------------------------------------
def build_output_path(input_path: str, model: str, device: str, fmt: str, diarize_only: bool = False) -> str:
    stem = os.path.splitext(input_path)[0]
    ext = fmt if fmt in ["json", "rttm", "md"] else "txt"
    return f"{stem}.{ext}"


def format_timestamp(seconds: Optional[float], include_hours: bool = False) -> str:
    """Converts seconds into MM:SS notation, or HH:MM:SS if include_hours=True or hours > 0."""
    if seconds is None:
        return "00:00:00" if include_hours else "00:00"
    total_seconds = max(0, int(round(seconds)))
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    if include_hours or hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


# ---------------------------------------------------------------------------
# Hugging Face Auth
# ---------------------------------------------------------------------------
def get_hf_token() -> Optional[str]:
    token = os.environ.get("HF_TOKEN")
    if token:
        return token
    token_path = os.path.expanduser("~/.cache/huggingface/token")
    if os.path.exists(token_path):
        with open(token_path, "r") as f:
            token = f.read().strip()
        if token:
            return token
    return None


# ---------------------------------------------------------------------------
# Audio Conversion / Extraction
# ---------------------------------------------------------------------------
def extract_mono_16k_wav(input_path: str, max_duration: Optional[float] = None, start_time: Optional[float] = None) -> str:
    """
    Extract/convert any ffmpeg-compatible audio or video input to a 16kHz mono WAV file.
    Returns path to temporary wav file. Caller is responsible for cleanup.
    """
    temp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    temp_wav.close()

    cmd = ["ffmpeg", "-y"]
    if start_time is not None and start_time > 0:
        cmd.extend(["-ss", str(start_time)])
    cmd.extend(["-i", input_path])
    if max_duration is not None and max_duration > 0:
        cmd.extend(["-t", str(max_duration)])
    cmd.extend(["-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", temp_wav.name])

    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        if os.path.exists(temp_wav.name):
            os.remove(temp_wav.name)
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr.decode('utf-8', errors='replace')}")
    return temp_wav.name


# ---------------------------------------------------------------------------
# Nemotron Diarization Engine
# ---------------------------------------------------------------------------
def run_nemotron_diarization(wav_path: str, device: str) -> List[Dict[str, Any]]:
    """
    Runs nvidia/Nemotron-3-Diarization on 16kHz mono wav.
    Returns a sorted list of segments: [{'Speaker': 0, 'Start': 0.0, 'End': 4.12}, ...]
    """
    import torch
    from transformers import AutoProcessor, AutoModelForAudioFrameClassification
    from transformers.audio_utils import load_audio

    hf_token = get_hf_token()
    print(f"⏳ Loading Nemotron-3-Diarization model ({NEMOTRON_MODEL_ID}) on {device}…")

    processor = AutoProcessor.from_pretrained(NEMOTRON_MODEL_ID, token=hf_token)
    model = AutoModelForAudioFrameClassification.from_pretrained(
        NEMOTRON_MODEL_ID,
        token=hf_token,
        dtype=torch.float16 if device == "cuda" else torch.float32,
    )
    model = model.to(device)
    model.eval()

    sampling_rate = processor.feature_extractor.sampling_rate
    audio = load_audio(wav_path, sampling_rate=sampling_rate)

    print(f"   Audio duration: {len(audio) / sampling_rate:.2f}s")
    print("⏳ Computing speaker diarization logits…")

    inputs = processor(audio, sampling_rate=sampling_rate).to(device=model.device, dtype=model.dtype)

    with torch.inference_mode():
        logits = model(**inputs).logits  # Shape: (1, num_frames, 8)
        # extract_speaker_dict handles thresholding and segment extraction
        segments = processor.extract_speaker_dict(logits, inputs.attention_mask)[0]

    # Normalize segment format
    normalized_segments = []
    for s in segments:
        normalized_segments.append({
            "speaker": f"speaker_{s['Speaker']}",
            "speaker_id": int(s['Speaker']),
            "start": float(s["Start"]),
            "end": float(s["End"]),
        })

    # Free Nemotron model from GPU memory to make room for Whisper & LLM
    del model
    del processor
    import gc
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
        try:
            torch.cuda.ipc_collect()
        except Exception:
            pass

    normalized_segments.sort(key=lambda x: x["start"])
    print(f"   Extracted {len(normalized_segments)} speaker segments.")
    return normalized_segments


# ---------------------------------------------------------------------------
# Faster-Whisper ASR Engine
# ---------------------------------------------------------------------------
def run_asr(
    audio_path: str,
    model_name: str,
    device: str,
    language: str,
    beam_size: int,
    no_vad: bool,
    engine: str = "faster-whisper",
) -> List[Dict[str, Any]]:
    """Transcribes audio using faster-whisper or openai-whisper with word/segment timestamps."""
    if engine == "faster-whisper":
        from faster_whisper import WhisperModel

        compute_type = "float16" if device == "cuda" else "int8"
        print(f"⏳ Loading faster-whisper '{model_name}' on {device} ({compute_type})…")
        model = WhisperModel(model_name, device=device, compute_type=compute_type)

        lang = None if language == "auto" else language
        segments_gen, info = model.transcribe(
            audio_path,
            language=lang,
            beam_size=beam_size,
            vad_filter=not no_vad,
            vad_parameters={"min_silence_duration_ms": 500},
            word_timestamps=True,
        )
        print(f"   Detected language: {info.language} (confidence: {info.language_probability:.1%})")

        asr_segments = []
        for seg in segments_gen:
            words = []
            if seg.words:
                for w in seg.words:
                    words.append({"start": w.start, "end": w.end, "word": w.word.strip()})
            asr_segments.append({
                "start": seg.start,
                "end": seg.end,
                "text": seg.text.strip(),
                "words": words,
            })
        del model
        import gc
        gc.collect()
        if device == "cuda":
            import torch
            torch.cuda.empty_cache()
            try:
                torch.cuda.ipc_collect()
            except Exception:
                pass
        return asr_segments

    elif engine == "openai-whisper":
        import whisper

        print(f"⏳ Loading openai-whisper '{model_name}' on {device}…")
        model = whisper.load_model(model_name, device=device)
        lang = None if language == "auto" else language
        result = model.transcribe(audio_path, language=lang, beam_size=beam_size, word_timestamps=True)

        asr_segments = []
        for seg in result.get("segments", []):
            words = []
            for w in seg.get("words", []):
                words.append({"start": w["start"], "end": w["end"], "word": w["word"].strip()})
            asr_segments.append({
                "start": seg["start"],
                "end": seg["end"],
                "text": seg["text"].strip(),
                "words": words,
            })
        return asr_segments
    else:
        raise ValueError(f"Unsupported ASR engine: {engine}")


# ---------------------------------------------------------------------------
# Alignment: Nemotron Diarization + Whisper ASR
# ---------------------------------------------------------------------------
def get_speaker_for_interval(start: float, end: float, diar_segments: List[Dict[str, Any]]) -> str:
    """Find the speaker with maximum overlap in the given time window."""
    best_speaker = "UNKNOWN"
    max_overlap = 0.0
    for d in diar_segments:
        overlap = max(0.0, min(end, d["end"]) - max(start, d["start"]))
        if overlap > max_overlap:
            max_overlap = overlap
            best_speaker = d["speaker"]
    return best_speaker


def assign_speakers_to_transcript(
    diar_segments: List[Dict[str, Any]],
    asr_segments: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Assigns speaker identities to transcript words and regroups them into contiguous speaker turns.
    """

    # Collect all words across segments with their start/end
    all_words = []
    for asr_seg in asr_segments:
        if asr_seg.get("words"):
            for w in asr_seg["words"]:
                all_words.append(w)
        else:
            # Fallback if no word timestamps
            all_words.append({
                "start": asr_seg["start"],
                "end": asr_seg["end"],
                "word": asr_seg["text"],
            })

    if not all_words:
        return []

    # Assign speaker to each word
    attributed_words = []
    last_speaker = "UNKNOWN"
    for w in all_words:
        spk = get_speaker_for_interval(w["start"], w["end"], diar_segments)
        # If in brief silence between speaker intervals, inherit previous speaker
        if spk == "UNKNOWN" and last_speaker != "UNKNOWN":
            spk = last_speaker
        elif spk != "UNKNOWN":
            last_speaker = spk
        attributed_words.append({
            "start": w["start"],
            "end": w["end"],
            "word": w["word"],
            "speaker": spk,
        })

    # Group adjacent words with the same speaker into coherent turns
    turns = []
    curr_turn = None

    for w in attributed_words:
        if curr_turn is None:
            curr_turn = {
                "start": w["start"],
                "end": w["end"],
                "speaker": w["speaker"],
                "words": [w["word"]],
            }
        elif curr_turn["speaker"] == w["speaker"] and (w["start"] - curr_turn["end"] < 2.0):
            curr_turn["end"] = w["end"]
            curr_turn["words"].append(w["word"])
        else:
            turns.append({
                "start": curr_turn["start"],
                "end": curr_turn["end"],
                "speaker": curr_turn["speaker"],
                "text": " ".join(curr_turn["words"]),
            })
            curr_turn = {
                "start": w["start"],
                "end": w["end"],
                "speaker": w["speaker"],
                "words": [w["word"]],
            }

    if curr_turn:
        turns.append({
            "start": curr_turn["start"],
            "end": curr_turn["end"],
            "speaker": curr_turn["speaker"],
            "text": " ".join(curr_turn["words"]),
        })

    return turns



# ---------------------------------------------------------------------------
# CLI Argument Parser
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="NVIDIA Nemotron-3 Diarization & Whisper Transcription Toolkit.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("input", help="Path to audio or video file (any ffmpeg format).")
    p.add_argument("-o", "--output", default=None, help="Output file path.")
    p.add_argument("-e", "--asr-engine", choices=SUPPORTED_ASR_ENGINES, default="faster-whisper", help="ASR engine.")
    p.add_argument("-m", "--model", choices=SUPPORTED_MODELS, default="large-v3", help="Whisper ASR model size.")
    p.add_argument("-d", "--device", choices=SUPPORTED_DEVICES, default="auto", help="Compute device.")
    p.add_argument("-l", "--language", default="he", help="ASR language code (e.g. 'he', 'en', 'auto').")
    p.add_argument("--beam-size", type=int, default=5, help="Beam search width for Whisper.")
    p.add_argument("--format", choices=SUPPORTED_FORMATS, default="txt", help="Output format.")
    p.add_argument("--timestamps", action="store_true", default=True, help="Prefix segments with timestamps.")
    p.add_argument("--no-timestamps", action="store_false", dest="timestamps", help="Disable timestamps.")
    p.add_argument("--no-vad", action="store_true", help="Disable Voice Activity Detection filter.")
    p.add_argument("--diarize-only", action="store_true", help="Run Nemotron-3 diarization only (no ASR).")
    p.add_argument("--duration", type=float, default=None, help="Process only the first N seconds (for testing).")
    p.add_argument("--start-time", type=float, default=None, help="Start processing from timestamp N seconds.")
    p.add_argument("--llm-model", default="qwen3:30b", help="Local Ollama model used to map speaker IDs to names.")
    p.add_argument("--no-map-speakers", action="store_true", help="Disable automatic LLM speaker mapping.")
    p.add_argument("--print-transcript", action="store_true", default=False, help="Print full transcript lines to console output.")
    return p


SUPPORTED_EXTENSIONS = {
    ".mp4", ".m4a", ".mp3", ".wav", ".mkv", ".flac", ".ogg", ".opus", ".aac", ".webm", ".avi", ".mov"
}


def process_single_file(input_file: str, args, device: str, processor=None, model=None, asr_model=None):
    """Processes a single audio or video file with Nemotron diarization and Whisper ASR."""
    stem = os.path.splitext(input_file)[0]
    out_path = args.output if (args.output and not os.path.isdir(args.input)) else build_output_path(
        input_file,
        args.model,
        device,
        args.format,
        diarize_only=args.diarize_only,
    )

    print(f"\n========================================================")
    print(f"🎙  Processing : {input_file}")
    print(f"📄  Output     : {out_path}")
    print(f"========================================================")

    print("⏳ Preparing 16kHz mono audio for Nemotron…")
    wav_path = extract_mono_16k_wav(input_file, max_duration=args.duration, start_time=args.start_time)

    try:
        # Step 1: Nemotron Diarization
        diar_segments = run_nemotron_diarization(wav_path, device)

        if args.diarize_only:
            if args.format == "json":
                import json
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(diar_segments, f, indent=2, ensure_ascii=False)
            elif args.format == "rttm":
                with open(out_path, "w", encoding="utf-8") as f:
                    for d in diar_segments:
                        dur = d["end"] - d["start"]
                        f.write(f"SPEAKER session 1 {d['start']:.3f} {dur:.3f} <NA> <NA> {d['speaker']} <NA> <NA>\n")
            else:
                max_end = max((d["end"] for d in diar_segments), default=0.0)
                include_hours = max_end >= 3600.0
                with open(out_path, "w", encoding="utf-8") as f:
                    for d in diar_segments:
                        line = f"[{format_timestamp(d['start'], include_hours=include_hours)} → {format_timestamp(d['end'], include_hours=include_hours)}] [{d['speaker']}]"
                        if args.print_transcript:
                            print(f"   {line}")
                        f.write(line + "\n")
            print(f"✅ Diarization saved to: {out_path}")
            return

        # Step 2: Whisper ASR
        if device == "cuda":
            try:
                from map_speakers import unload_ollama_models
                unload_ollama_models(args.llm_model)
            except Exception:
                pass
            import torch
            torch.cuda.empty_cache()

        asr_segments = run_asr(
            wav_path,
            args.model,
            device,
            args.language,
            args.beam_size,
            args.no_vad,
            engine=args.asr_engine,
        )

        # Step 3: Align ASR with Nemotron speakers
        final_transcript = assign_speakers_to_transcript(diar_segments, asr_segments)

        # Step 4: Save results
        if args.format == "json":
            import json
            with open(out_path, "w", encoding="utf-8") as f:
                json.dump(final_transcript, f, indent=2, ensure_ascii=False)
        else:
            max_end = max((seg["end"] for seg in final_transcript), default=0.0)
            include_hours = max_end >= 3600.0
            with open(out_path, "w", encoding="utf-8") as f:
                for seg in final_transcript:
                    text = seg["text"].strip()
                    speaker = seg["speaker"]
                    ts_str = f"[{format_timestamp(seg['start'], include_hours=include_hours)} → {format_timestamp(seg['end'], include_hours=include_hours)}]" if args.timestamps else ""
                    spk_str = f"[{speaker}]"
                    prefix = f"{ts_str} {spk_str} ".lstrip()
                    line = f"{prefix}{text}".strip()
                    if args.print_transcript:
                        color_prefix = ""
                        if args.timestamps:
                            color_prefix += f"\033[36m{ts_str}\033[0m "
                        color_prefix += f"\033[1;94m{spk_str}\033[0m "
                        print(f"   {color_prefix}{text}".strip())
                    f.write(line + "\n")

        print(f"✅ Diarized transcript saved to: {out_path}")

        # Step 5: Automatically infer and map speakers using local LLM
        if not args.diarize_only and not args.no_map_speakers and args.format in ["txt", "md"]:
            # Aggressively release all GPU VRAM from Diarization and ASR before starting LLM inference
            import gc
            gc.collect()
            if device == "cuda":
                try:
                    import torch
                    torch.cuda.empty_cache()
                    torch.cuda.ipc_collect()
                except Exception:
                    pass

            try:
                from map_speakers import map_transcript, apply_speaker_mapping
                print(f"\n🧠 Inferring speaker names, summary, and file title with {args.llm_model}...")
                mapping_result = map_transcript(out_path, model=args.llm_model, source_file=input_file)
                if mapping_result:
                    suggested_title = mapping_result.get("suggested_title") if isinstance(mapping_result, dict) else None
                    summary = mapping_result.get("summary") if isinstance(mapping_result, dict) else None
                    speakers = mapping_result.get("speakers", mapping_result) if isinstance(mapping_result, dict) else mapping_result
                    apply_speaker_mapping(
                        out_path,
                        mapping_result,
                        suggested_title=suggested_title,
                        summary=summary,
                        source_file=input_file,
                        delete_source_txt=True,
                    )
            except Exception as e:
                import traceback
                print(f"⚠️  Speaker mapping skipped due to error: {e}")
                traceback.print_exc()

    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)


# ---------------------------------------------------------------------------
# Main Execution
# ---------------------------------------------------------------------------
def main():
    parser = build_parser()
    args = parser.parse_args()

    args.input = os.path.expanduser(args.input)
    if not os.path.exists(args.input):
        print(f"❌ Input path not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    device = resolve_device(args.device)

    # If using GPU, ensure local Ollama models aren't hogging VRAM before running
    if device == "cuda":
        try:
            from map_speakers import unload_ollama_models
            unload_ollama_models(args.llm_model)
        except Exception:
            pass
        import torch
        torch.cuda.empty_cache()

    # Collect files to process
    if os.path.isdir(args.input):
        files_to_process = []
        for root, _, files in os.walk(args.input):
            for file in sorted(files):
                ext = os.path.splitext(file)[1].lower()
                if ext in SUPPORTED_EXTENSIONS:
                    files_to_process.append(os.path.join(root, file))
        if not files_to_process:
            print(f"⚠️  No supported media files found in directory: {args.input}", file=sys.stderr)
            sys.exit(1)
        print(f"📁 Directory mode: Found {len(files_to_process)} media files in {args.input}")
    else:
        files_to_process = [args.input]

    print(f"🧠  Diarizer     : {NEMOTRON_MODEL_ID}")
    if not args.diarize_only:
        print(f"🗣  ASR Engine   : {args.asr_engine} ({args.model})  |  Language: {args.language}")
    print(f"⚙️   Device       : {device}\n")

    for fpath in files_to_process:
        process_single_file(fpath, args, device)

    print(f"\n🎉 All done! Processed {len(files_to_process)} file(s).")


if __name__ == "__main__":
    main()
