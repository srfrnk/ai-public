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
import subprocess
import sys
import urllib.request
import urllib.error
import urllib.parse
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
            "summary": "Concise summary of the conversation covering main topics, decisions, and action items (in the conversation language).",
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
            "summary": "Concise summary of the tutorial/dialogue covering main topics and takeaways (in the conversation language).",
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
   - Context: Include a date ONLY if explicitly spoken/stated in the transcript. NEVER invent, guess, or hallucinate a date (if no date is mentioned in the dialogue, do not include any date in the title). List known participants where appropriate.
   - Format: Clean title suitable for a filename (alphanumerics, spaces, hyphens, no invalid filename characters).
3. Summary: Provide a concise, clear summary of the conversation in the same language as the transcript (matching the predominant spoken language), capturing the agenda, key topics discussed, conclusions, and action items.
   - Grammar & Capitalization: MUST use correct grammar and sentence capitalization (always capitalize the first letter of each sentence, e.g. "The speaker...", "The presenter...").
   - CRITICAL REQUIREMENT: Do NOT use raw speaker notation or IDs (such as 'Speaker_0', 'speaker_0', 'speaker_1', etc.) anywhere in the summary. Always refer to participants by their identified real names from Task 1 (or 'The speaker' / 'the speaker' / 'the presenter' if the name is unknown).

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

        # Structure can be {"suggested_title": "...", "summary": "...", "speakers": {...}}
        suggested_title = parsed.get("suggested_title")
        summary = parsed.get("summary")
        speakers_dict = parsed.get("speakers", parsed)

        # Build normalized name replacements to clean summary
        name_replacements = {}
        if isinstance(speakers_dict, dict):
            for spk_id, info in speakers_dict.items():
                if isinstance(info, dict):
                    name = info.get("name")
                else:
                    name = str(info)
                cleaned_name = name.strip() if (name and name.strip()) else "Unknown"
                name_replacements[spk_id.lower()] = cleaned_name

        if summary:
            summary = replace_speaker_tags_in_text(summary, name_replacements)

        return {
            "suggested_title": suggested_title,
            "summary": summary,
            "speakers": speakers_dict,
        }
    finally:
        unload_ollama_models(model, host=host)


def capitalize_sentences(text: str) -> str:
    """Capitalizes the first letter of each sentence in text."""
    if not text:
        return text
    # Capitalize start of text/paragraphs and after sentence-ending punctuation (.!?)
    return re.sub(r'(^|[.!?]\s+|\n+)([a-z])', lambda m: m.group(1) + m.group(2).upper(), text)


def replace_speaker_tags_in_text(text: str, name_replacements: Dict[str, str]) -> str:
    """
    Replaces any raw speaker IDs like 'Speaker_0', 'speaker_0', 'Speaker 0', or '[speaker_0]'
    in summary text with the actual mapped speaker names (or 'the presenter' / 'the speaker' if Unknown).
    Ensures appropriate sentence capitalization (e.g. 'The speaker' at the start of sentences).
    """
    if not text:
        return text

    for spk_tag, name in name_replacements.items():
        m = re.match(r"^speaker_(\d+)$", spk_tag, re.IGNORECASE)
        if not m:
            continue
        num = m.group(1)

        is_unknown = not name or name.strip() == "Unknown"
        base_replacement = "the speaker" if is_unknown else name.strip()

        # If it's a generic descriptor like "the speaker", match casing based on context or pattern
        if is_unknown:
            def _sub(match_obj: re.Match) -> str:
                matched_str = match_obj.group(0)
                # Check preceding text to see if we're at start of sentence
                start_idx = match_obj.start()
                preceding = text[:start_idx].rstrip()
                if not preceding or preceding[-1] in ".!?\n":
                    return "The speaker"
                # If matched pattern had uppercase initial, keep "The speaker"
                first_letter = re.search(r'[a-zA-Z]', matched_str)
                if first_letter and first_letter.group(0).isupper():
                    return "The speaker"
                return "the speaker"

            patterns = [
                rf"\[\s*speaker[_\s]+{num}\s*\]",
                rf"\bSpeaker[_\s]+{num}\b",
                rf"\bspeaker[_\s]+{num}\b",
            ]
            for p in patterns:
                text = re.sub(p, _sub, text)
        else:
            patterns = [
                rf"\[\s*speaker[_\s]+{num}\s*\]",
                rf"\bSpeaker[_\s]+{num}\b",
                rf"\bspeaker[_\s]+{num}\b",
            ]
            for p in patterns:
                text = re.sub(p, base_replacement, text)

    # Ensure sentences starting with lowercase letters are capitalized
    text = capitalize_sentences(text)
    return text


def sanitize_filename(title: str, max_length: int = 200) -> str:
    """
    Sanitizes a suggested title into a safe, valid filename across platforms.
    Preserves Unicode (accents, non-Latin scripts, etc.), replaces invalid filename characters,
    strips quotes/markdown, and collapses whitespace.
    """
    if not title:
        return ""

    # Strip wrapping quotes and markdown formatting
    s = title.strip().strip('"\'`')
    s = re.sub(r'[*_`]', '', s)

    # Replace characters that are invalid in filenames
    s = re.sub(r'[\\/]', '-', s)
    s = re.sub(r':\s*', ' - ', s)
    s = re.sub(r'[?*"<>|]', '', s)

    # Collapse multiple whitespace and hyphens
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'-{2,}', '-', s)
    s = s.strip(' .-')

    # Remove trailing .txt if model included it
    if s.lower().endswith(".txt"):
        s = s[:-4].strip()

    # Truncate if too long (preserving word boundaries if possible)
    if len(s) > max_length:
        s = s[:max_length].rsplit(' ', 1)[0].strip()

    return s


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


def parse_timestamp_seconds(ts_str: str) -> Optional[float]:
    """Parses a timestamp string like '132.2s', '02:15', or '01:02:15' into float seconds."""
    s = ts_str.strip().rstrip("s")
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
        elif len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        else:
            return float(s)
    except ValueError:
        return None


def detect_transcript_include_hours(lines: List[str]) -> bool:
    """Returns True if any timestamp in the lines exceeds 1 hour (3600s)."""
    ts_pattern = re.compile(
        r"^(?:<span[^>]*>)?\[(\d+(?::\d+){0,2}(?:\.\d+)?)\s*s?\s*(?:→|->|–|-)\s*(\d+(?::\d+){0,2}(?:\.\d+)?)\s*s?\]"
    )
    max_sec = 0.0
    for line in lines:
        m = ts_pattern.match(line.strip())
        if m:
            sec = parse_timestamp_seconds(m.group(2))
            if sec and sec > max_sec:
                max_sec = sec
    return max_sec >= 3600.0


def convert_timestamp_format(line: str, include_hours: bool = False) -> str:
    """Converts any timestamp prefix like [132.2s → 134.8s] into [MM:SS → MM:SS] (or [HH:MM:SS → HH:MM:SS])."""
    pattern = re.compile(r"^\[(\d+(?::\d+){0,2}(?:\.\d+)?)\s*s?\s*(?:→|->|–|-)\s*(\d+(?::\d+){0,2}(?:\.\d+)?)\s*s?\]")
    match = pattern.match(line.strip())
    if match:
        start_sec = parse_timestamp_seconds(match.group(1))
        end_sec = parse_timestamp_seconds(match.group(2))
        if start_sec is not None and end_sec is not None:
            ts_str = f"[{format_timestamp(start_sec, include_hours=include_hours)} → {format_timestamp(end_sec, include_hours=include_hours)}]"
            return ts_str + line.strip()[match.end():]
    return line


def colorize_markdown_line(line: str, include_hours: bool = False) -> str:
    """
    Styles timestamp in cyan and speaker name in bright blue for Markdown output.
    Uses MM:SS if under 1 hour, or HH:MM:SS if 1 hour or longer.
    Example:
      [02:12 → 02:15] [G'ris] Text
      -> <span style="color: #00bcd4;">[02:12 → 02:15]</span> <span style="color: #1e90ff; font-weight: bold;">[G'ris]</span> Text
    """
    line = convert_timestamp_format(line, include_hours=include_hours)

    # Match timestamp (MM:SS or HH:MM:SS) and speaker:
    ts_spk_pattern = re.compile(
        r"^(?:<span[^>]*>)?(\[\d{2,}(?::\d{2}){1,2}\s*(?:→|->|–|-)\s*\d{2,}(?::\d{2}){1,2}\])(?:</span>)?\s*(?:<span[^>]*>)?(\[[^\]]+\])(?:</span>)?\s*(.*)$"
    )
    m = ts_spk_pattern.match(line)
    if m:
        ts, spk, text = m.groups()
        return f'<span style="color: #00bcd4;">{ts}</span> <span style="color: #1e90ff; font-weight: bold;">{spk}</span> {text}'.rstrip()

    # Match speaker only: e.g. [G'ris] text
    spk_only_pattern = re.compile(
        r"^(?:<span[^>]*>)?(\[[^\]]+\])(?:</span>)?\s*(.*)$"
    )
    m2 = spk_only_pattern.match(line)
    if m2:
        spk, text = m2.groups()
        if not spk.startswith("[x]") and not spk.startswith("[ ]"):
            return f'<span style="color: #1e90ff; font-weight: bold;">{spk}</span> {text}'.rstrip()

    return line


def get_git_repo_info(file_path: str) -> Optional[Dict[str, str]]:
    """
    Checks if file_path is inside a git repository.
    Returns dict with 'repo_root', 'rel_path', 'github_base_url', 'branch' if inside a git repo,
    or None if not a git repository.
    """
    abs_path = os.path.abspath(file_path)
    file_dir = abs_path if os.path.isdir(abs_path) else os.path.dirname(abs_path)

    while file_dir and not os.path.exists(file_dir):
        file_dir = os.path.dirname(file_dir)

    if not file_dir:
        return None

    try:
        res = subprocess.run(
            ["git", "-C", file_dir, "rev-parse", "--show-toplevel"],
            capture_output=True,
            text=True,
            check=True,
        )
        repo_root = res.stdout.strip()
        if not repo_root:
            return None

        rel_path = os.path.relpath(abs_path, repo_root)

        remote_url = ""
        res_remote = subprocess.run(
            ["git", "-C", file_dir, "config", "--get", "remote.origin.url"],
            capture_output=True,
            text=True,
        )
        if res_remote.returncode == 0:
            remote_url = res_remote.stdout.strip()

        branch = "main"
        res_branch = subprocess.run(
            ["git", "-C", file_dir, "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True,
            text=True,
        )
        if res_branch.returncode == 0 and res_branch.stdout.strip() not in ("", "HEAD"):
            branch = res_branch.stdout.strip()

        github_base_url = None
        if remote_url:
            m = re.search(r"github\.com[:/]([^/]+/[^/.]+?)(?:\.git)?$", remote_url)
            if m:
                github_base_url = f"https://github.com/{m.group(1)}"

        return {
            "repo_root": repo_root,
            "rel_path": rel_path,
            "branch": branch,
            "github_base_url": github_base_url,
        }
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def format_source_file_markdown(source_file: str) -> str:
    """
    Formats the original filename line for the markdown header:
    - If in a git repo with GitHub remote: **Original File:** [rel_path](https://github.com/owner/repo/blob/branch/rel_path)
    - If in a git repo without GitHub: **Original File:** `rel_path`
    - If not in a git repo: **Original File:** `full_path`
    """
    abs_path = os.path.abspath(source_file)
    info = get_git_repo_info(abs_path)

    if info:
        rel_path = info["rel_path"]
        base_url = info.get("github_base_url")
        branch = info.get("branch", "main")
        if base_url:
            encoded_rel_path = urllib.parse.quote(rel_path.replace("\\", "/"), safe="/")
            github_url = f"{base_url}/blob/{branch}/{encoded_rel_path}"
            return f"**Original File:** [{rel_path}]({github_url})\n"
        else:
            return f"**Original File:** `{rel_path}`\n"
    else:
        return f"**Original File:** `{abs_path}`\n"


def format_markdown_transcript(
    title: str,
    summary: Optional[str],
    transcript_lines: List[str],
    source_file: Optional[str] = None,
) -> str:
    """
    Formats title, summary, and transcript into a structured Markdown document.
    Structure:
      # {title}
      **Original File:** `{source_file}`
      ## Summary
      {summary}
      ## Transcript
      {transcript_lines}
    """
    include_hours = detect_transcript_include_hours(transcript_lines)
    # Clean and filter lines
    clean_lines = []
    in_existing_header_or_summary = False
    for line in transcript_lines:
        s = line.strip()
        if not s:
            continue
        # If input lines already contain markdown sections, skip headers and existing summary
        if s.startswith("# "):
            continue
        if s.lower().startswith("**original file:**") or s.lower().startswith("**source:**") or s.lower().startswith("*source:"):
            continue
        if s.lower() in ("## summary", "## תקציר"):
            in_existing_header_or_summary = True
            continue
        if s.lower() in ("## transcript", "## תמליל"):
            in_existing_header_or_summary = False
            continue
        if in_existing_header_or_summary:
            continue

        colored_line = colorize_markdown_line(s, include_hours=include_hours)
        clean_lines.append(colored_line)

    clean_title = title.strip().strip('"\'`') if title else "Transcript"
    if clean_title.startswith("#"):
        clean_title = clean_title.lstrip("#").strip()

    md_parts = [f"# {clean_title}\n"]

    if source_file:
        md_parts.append(format_source_file_markdown(source_file))

    if summary and summary.strip():
        md_parts.append(f"## Summary\n\n{summary.strip()}\n")
    else:
        md_parts.append("## Summary\n\n*(No summary available)*\n")

    md_parts.append("## Transcript\n")
    md_parts.append("\n".join(clean_lines))
    md_parts.append("")

    return "\n".join(md_parts)


def apply_speaker_mapping(
    transcript_path: str,
    mapping: Dict[str, Any],
    output_path: Optional[str] = None,
    suggested_title: Optional[str] = None,
    summary: Optional[str] = None,
    source_file: Optional[str] = None,
    delete_source_txt: bool = False,
) -> Dict[str, str]:
    """
    Replaces speaker IDs with mapped names or 'Unknown' in the transcript file.
    Only replaces speaker tags in the structural prefix position (e.g. `[00:01:12 → 00:03:24] [speaker_0]`),
    ensuring spoken dialogue text containing '[speaker_0]' is never accidentally modified.

    Saves the final output as a Markdown (.md) file containing:
      # Title/Caption
      **Original File:** `filename`
      ## Summary
      ## Transcript
    """
    # Extract speakers dictionary, suggested_title, and summary if full result dict was passed
    if isinstance(mapping, dict):
        speakers_dict = mapping.get("speakers", mapping)
        if suggested_title is None:
            suggested_title = mapping.get("suggested_title")
        if summary is None:
            summary = mapping.get("summary")
        if source_file is None:
            source_file = mapping.get("source_file")
    else:
        speakers_dict = mapping

    if output_path is None:
        output_path = transcript_path

    # If source_file not provided, attempt to detect media file next to transcript
    if source_file is None:
        stem = os.path.splitext(transcript_path)[0]
        for ext in [".mp4", ".m4a", ".mp3", ".wav", ".mkv", ".flac", ".ogg", ".opus", ".aac", ".webm", ".avi", ".mov"]:
            candidate = stem + ext
            if os.path.exists(candidate):
                source_file = candidate
                break

    # Build normalized replacement mapping
    name_replacements = {}
    if isinstance(speakers_dict, dict):
        for spk_id, info in speakers_dict.items():
            if isinstance(info, dict):
                name = info.get("name")
            else:
                name = str(info)
            cleaned_name = name.strip() if (name and name.strip()) else "Unknown"
            name_replacements[spk_id.lower()] = cleaned_name

    # Regex matching speaker tag only in prefix position:
    # Group 1: optional timestamp prefix (e.g. `[00:01:12 → 00:03:24] `)
    # Group 2: speaker tag without brackets (e.g. `speaker_0`)
    # Followed by a trailing space before dialogue text
    prefix_speaker_pattern = re.compile(r'^(\[[^\]]+\]\s*)?\[(speaker_\d+)\](\s*)', re.IGNORECASE)

    with open(transcript_path, "r", encoding="utf-8") as f:
        lines = f.readlines()

    include_hours = detect_transcript_include_hours(lines)

    updated_lines = []
    for line in lines:
        line = convert_timestamp_format(line, include_hours=include_hours)
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

    if summary:
        summary = replace_speaker_tags_in_text(summary, name_replacements)

    saved_paths = {}
    title_text = suggested_title or os.path.splitext(os.path.basename(transcript_path))[0]
    md_content = format_markdown_transcript(title_text, summary, updated_lines, source_file=source_file)

    # Save to primary output path (unless it is a temporary txt file scheduled for deletion)
    if output_path.endswith(".md"):
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(md_content)
        saved_paths["primary"] = output_path
        print(f"📄 Named transcript saved to: {output_path}")
    elif not delete_source_txt:
        with open(output_path, "w", encoding="utf-8") as f:
            f.writelines(updated_lines)
        saved_paths["primary"] = output_path
        print(f"📄 Named transcript saved to: {output_path}")

    # Save final markdown output file using the suggested title (or file stem)
    clean_title = sanitize_filename(title_text)
    if clean_title:
        target_dir = os.path.dirname(os.path.abspath(output_path))
        md_path = os.path.join(target_dir, f"{clean_title}.md")
        if os.path.abspath(md_path) != os.path.abspath(output_path) or not output_path.endswith(".md"):
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(md_content)
            saved_paths["markdown"] = md_path
            print(f"📝 Final Markdown transcript saved to: {md_path}")

    # Delete temporary transcript txt file if requested and final markdown was created
    if delete_source_txt:
        md_saved = saved_paths.get("markdown") or (output_path if output_path.endswith(".md") else None)
        if md_saved and os.path.exists(md_saved):
            if os.path.exists(transcript_path) and transcript_path.endswith(".txt"):
                if os.path.abspath(transcript_path) != os.path.abspath(md_saved):
                    try:
                        os.remove(transcript_path)
                        print(f"🗑️  Removed temporary transcript file: {transcript_path}")
                        if saved_paths.get("primary") == transcript_path:
                            del saved_paths["primary"]
                    except OSError as err:
                        print(f"⚠️  Could not remove temporary transcript file {transcript_path}: {err}")

    return saved_paths


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
        "--source-file",
        default=None,
        help="Name or path of the original audio/video file to display in markdown output.",
    )
    parser.add_argument(
        "--delete-txt",
        action="store_true",
        help="Delete the temporary transcript (.txt) file after successfully saving the Markdown file.",
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
    summary = result.get("summary") if isinstance(result, dict) else None
    speakers_map = result.get("speakers", result) if isinstance(result, dict) else result

    print("\n╔══════════════════════════════════════════════════════════════╗")
    print("║               Inferred Speaker Mapping                       ║")
    print("╚══════════════════════════════════════════════════════════════╝\n")

    if suggested_title:
        print(f"  🏷  Suggested Title: \033[1;36m{suggested_title}\033[0m\n")

    if summary:
        print(f"  📝 Summary:\n    {summary}\n")

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
    if suggested_title or summary:
        json_out = {"suggested_title": suggested_title, "summary": summary, "speakers": json_out}
    print(f"Result JSON: {json.dumps(json_out, ensure_ascii=False)}")

    if not args.no_apply:
        apply_speaker_mapping(
            args.transcript,
            speakers_map,
            output_path=args.output,
            suggested_title=suggested_title,
            summary=summary,
            source_file=args.source_file,
            delete_source_txt=args.delete_txt,
        )


if __name__ == "__main__":
    main()
