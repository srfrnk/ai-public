#!/usr/bin/env python3
"""
map_speakers.py — Infers and maps speaker names from a diarized transcript using a local LLM.

Connects to a local LLM runner (Ollama by default) or standard OpenAI-compatible API endpoints.
Reads the diarized transcript, analyzes conversational cues, introductions, and turn-taking,
and outputs a JSON mapping of speaker IDs to real names with supporting quotes.

Usage:
    python map_speakers.py transcript.txt
    python map_speakers.py transcript.txt --model qwen3-coder:30b
    python map_speakers.py transcript.txt --apply   # Writes a new file with names substituted
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from typing import Dict, Any, Optional, List


DEFAULT_OLLAMA_URL = "http://localhost:11434"
DEFAULT_MODEL = "qwen3:30b"


def unload_ollama_models(model: Optional[str] = None, host: str = DEFAULT_OLLAMA_URL) -> None:
    """Explicitly unloads Ollama models from GPU memory to free VRAM for Whisper/Nemotron."""
    # 1. Query /api/ps to find all models currently resident in VRAM
    loaded_models = []
    if model:
        loaded_models.append(model)
    try:
        ps_url = f"{host.rstrip('/')}/api/ps"
        req = urllib.request.Request(ps_url)
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for m in data.get("models", []):
                name = m.get("name") or m.get("model")
                if name and name not in loaded_models:
                    loaded_models.append(name)
    except Exception:
        pass

    # 2. Issue keep_alive: 0 unload requests
    for m in loaded_models:
        try:
            url = f"{host.rstrip('/')}/api/generate"
            payload = {"model": m, "keep_alive": 0}
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                pass
        except Exception:
            pass

    # 3. CLI fallback if available
    try:
        import subprocess
        for m in loaded_models:
            subprocess.run(["ollama", "stop", m], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    except Exception:
        pass


def query_ollama(prompt: str, model: str, host: str = DEFAULT_OLLAMA_URL) -> str:
    """Sends a generate request to local Ollama API."""
    url = f"{host.rstrip('/')}/api/generate"
    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "format": "json",
        "think": False,
        "keep_alive": "5m",
        "options": {
            "temperature": 0.1,
        }
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            body = resp.read().decode("utf-8")
            result = json.loads(body)
            # Support Qwen 3 thinking mode models if response is empty
            text = result.get("response", "").strip()
            if not text and result.get("thinking"):
                text = result.get("thinking", "").strip()
            return text
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Failed to connect to local Ollama at {host} ({e}). "
            "Please make sure Ollama is running (`ollama serve` or system service)."
        )


def build_analysis_prompt(transcript_sample: str, speaker_set: List[str]) -> str:
    if speaker_set:
        speakers_formatted = ", ".join(speaker_set)
        example_schema = {
            "suggested_title": "Short descriptive filename title (3 to 10 words, e.g. '2026-07-12 Kickoff Meeting with Dan and Maya')",
            "speakers": {
                spk: {
                    "name": "Real Name or 'Unknown'",
                    "confidence": "high / medium / low",
                    "evidence": "Quote or reason from the transcript text"
                }
                for spk in speaker_set
            }
        }
        task1_inst = f"1. Identify Speakers: Determine the real name of each speaker ({speakers_formatted}) based on introductions, greetings, and how participants address each other. If a speaker's name cannot be determined, set 'name': 'Unknown'. You MUST include an entry in 'speakers' for EVERY speaker in {speakers_formatted}."
    else:
        example_schema = {
            "suggested_title": "Short descriptive filename title (3 to 10 words, e.g. 'Software Tutorial for Protein Expression Categorization GUI')",
            "speakers": {}
        }
        task1_inst = "1. Speakers: None to identify."

    schema_str = json.dumps(example_schema, indent=2, ensure_ascii=False)

    return f"""You are an assistant analyzing a conversation transcript.

Tasks:
{task1_inst}
2. Suggest File Title: Suggest a concise file title/name based on the conversation:
   - Length: Exactly 3 to 10 words.
   - Content: MUST convey the main agenda/topic of the conversation.
   - Context: Include the date (YYYY-MM-DD or spoken date) if mentioned or known, and list known participants/attendants where appropriate.
   - Format: Clean title suitable for a filename (alphanumerics, spaces, hyphens, no invalid filename characters).

Transcript:
---
{transcript_sample}
---

Return ONLY a valid JSON object matching this exact structure:
{schema_str}
"""


def extract_speakers_from_transcript(lines: List[str]) -> List[str]:
    """Finds all unique speaker tags formatted as `[speaker_X]` in prefix position."""
    # Matches optional timestamp bracket at start of line, then `[speaker_X]`
    pattern = re.compile(r'^(?:\[[^\]]+\]\s*)?\[(speaker_\d+)\]', re.IGNORECASE)
    speakers = set()
    for line in lines:
        match = pattern.match(line.strip())
        if match:
            speakers.add(match.group(1).lower())
    return sorted(list(speakers))


def map_transcript(
    transcript_path: str,
    model: str = DEFAULT_MODEL,
    host: str = DEFAULT_OLLAMA_URL,
    max_lines: int = 250,
) -> Dict[str, Any]:
    # Reads ONLY the input transcript file - no other files are accessed
    with open(transcript_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    speakers = extract_speakers_from_transcript(lines)
    if not speakers:
        print(f"ℹ️  No raw [speaker_X] tags found in {transcript_path} (proceeding with file title suggestion).")

    # Sample beginning and ending lines (where intros, conclusions, Q&A, and contact references happen)
    if len(lines) <= max_lines:
        sample_lines = lines
    else:
        half = max_lines // 2
        sample_lines = lines[:half] + ["\n... [middle dialogue omitted] ...\n\n"] + lines[-half:]
    sample_text = "".join(sample_lines)

    prompt = build_analysis_prompt(sample_text, speakers)
    print(f"🧠 Querying local LLM ({model}) via Ollama...")
    try:
        raw_response = query_ollama(prompt, model=model, host=host)
        try:
            parsed = json.loads(raw_response)
        except json.JSONDecodeError:
            match = re.search(r'\{.*\}', raw_response, re.DOTALL)
            if match:
                parsed = json.loads(match.group(0))
            else:
                raise RuntimeError(f"Could not parse JSON response from LLM:\n{raw_response}")

        # Structure can be {"suggested_title": "...", "speakers": {...}}
        suggested_title = parsed.get("suggested_title")
        speakers_dict = parsed.get("speakers", parsed)

        if suggested_title:
            print(f"\n💡 Suggested File Title: \033[1;36m{suggested_title}\033[0m\n")

        return {
            "suggested_title": suggested_title,
            "speakers": speakers_dict,
        }
    finally:
        unload_ollama_models(model, host=host)


def apply_speaker_mapping(transcript_path: str, mapping: Dict[str, Any], output_path: Optional[str] = None):
    """
    Replaces speaker IDs with mapped names or 'Unknown' in the transcript file.
    Only replaces speaker tags in the structural prefix position (e.g. `[1.2s → 3.4s] [speaker_0]`),
    ensuring spoken dialogue text containing '[speaker_0]' is never accidentally modified.
    """
    if output_path is None:
        output_path = transcript_path

    # Extract speakers dictionary if full result dict was passed
    speakers_dict = mapping.get("speakers", mapping) if isinstance(mapping, dict) else mapping

    # Build normalized replacement mapping
    name_replacements = {}
    for spk_id, info in speakers_dict.items():
        if isinstance(info, dict):
            name = info.get("name")
        else:
            name = str(info)
        cleaned_name = name.strip() if (name and name.strip()) else "Unknown"
        name_replacements[spk_id.lower()] = cleaned_name

    # Regex matching speaker tag only in prefix position:
    # Group 1: optional timestamp prefix (e.g. `[1.2s → 3.4s] `)
    # Group 2: speaker tag without brackets (e.g. `speaker_0`)
    # Followed by a trailing space before dialogue text
    prefix_speaker_pattern = re.compile(r'^(\[[^\]]+\]\s*)?\[(speaker_\d+)\](\s*)', re.IGNORECASE)

    with open(transcript_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    updated_lines = []
    for line in lines:
        match = prefix_speaker_pattern.match(line)
        if match:
            ts_prefix = match.group(1) or ""
            spk_tag = match.group(2).lower()
            trailing_sp = match.group(3) or ""
            dialogue_text = line[match.end():]

            # Resolve name: mapped name or fallback to 'Unknown'
            new_speaker = name_replacements.get(spk_tag, "Unknown")
            updated_line = f"{ts_prefix}[{new_speaker}]{trailing_sp}{dialogue_text}"
            updated_lines.append(updated_line)
        else:
            updated_lines.append(line)

    with open(output_path, "w", encoding="utf-8") as f:
        f.writelines(updated_lines)

    print(f"📄 Named transcript saved to: {output_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Infer speaker names from a diarized transcript using a local LLM (Ollama).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("transcript", help="Path to diarized transcript (.txt).")
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help="Ollama model to use (e.g. qwen3-coder:30b).",
    )
    parser.add_argument(
        "--host",
        default=DEFAULT_OLLAMA_URL,
        help="Ollama API base URL.",
    )
    parser.add_argument(
        "--no-apply",
        action="store_true",
        help="Do not modify the transcript file with inferred speaker names (dry run).",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Custom output file path. Defaults to overwriting the input transcript in-place.",
    )
    parser.add_argument(
        "--max-lines",
        type=int,
        default=250,
        help="Maximum lines from transcript start to send for analysis.",
    )
    args = parser.parse_args()

    if not os.path.exists(args.transcript):
        print(f"❌ File not found: {args.transcript}", file=sys.stderr)
        sys.exit(1)

    print(f"\n📄 Analyzing transcript: {args.transcript}")
    result = map_transcript(
        args.transcript,
        model=args.model,
        host=args.host,
        max_lines=args.max_lines,
    )

    suggested_title = result.get("suggested_title") if isinstance(result, dict) else None
    speakers_map = result.get("speakers", result) if isinstance(result, dict) else result

    print("\n╔══════════════════════════════════════════════════════════════╗")
    print("║               Inferred Speaker Mapping                       ║")
    print("╚══════════════════════════════════════════════════════════════╝\n")

    if suggested_title:
        print(f"  🏷  Suggested Title: \033[1;36m{suggested_title}\033[0m\n")

    for spk_id, details in speakers_map.items():
        if isinstance(details, dict):
            name = details.get("name", "Unknown")
            conf = details.get("confidence", "N/A")
            evidence = details.get("evidence", "None")
            print(f"  • {spk_id} ➔  \033[1m{name}\033[0m (confidence: {conf})")
            print(f"    Evidence: \"{evidence}\"\n")
        else:
            print(f"  • {spk_id} ➔  \033[1m{details}\033[0m")

    # Output pure JSON mapping to stdout/stderr or file
    json_out = {
        spk: (details.get("name") if isinstance(details, dict) else details)
        for spk, details in speakers_map.items()
    }
    if suggested_title:
        json_out = {"suggested_title": suggested_title, "speakers": json_out}
    print(f"Result JSON: {json.dumps(json_out, ensure_ascii=False)}")

    if not args.no_apply:
        apply_speaker_mapping(args.transcript, speakers_map, output_path=args.output)


if __name__ == "__main__":
    main()
