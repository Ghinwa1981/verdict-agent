# agent_core.py
import os
import io
import json
import base64
import requests
from dotenv import load_dotenv
from ddgs import DDGS
from pypdf import PdfReader

load_dotenv()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

TEXT_MODEL = "openai/gpt-oss-120b"
VISION_MODEL = "qwen/qwen3.6-27b"

# How many evidence / risk / next-step points to return per tier
DEPTH_COUNTS = {"free": 1, "quick": 3, "standard": 5, "pro": 8, "promax": 12}


def _web_search(query, max_results=5):
    """Free live web search via DuckDuckGo - no API key needed."""
    try:
        with DDGS() as ddgs:
            results = list(ddgs.text(query, max_results=max_results))
        print(f"DEBUG - web search returned {len(results)} result(s) for: {query}")
        return results
    except Exception as e:
        print(f"DEBUG - web search failed: {e}")
        return []


def _extract_file_text(files):
    """Pulls readable text out of PDF and plain-text files. Returns
    (extracted_text, image_files) - image_files are handled separately
    by the vision model."""
    extracted = ""
    image_files = []

    for f in files or []:
        name = f.get("name", "file")
        ftype = f.get("type", "")
        data = f.get("data", "")

        if ftype == "application/pdf":
            try:
                raw = base64.b64decode(data)
                reader = PdfReader(io.BytesIO(raw))
                text = "\n".join(page.extract_text() or "" for page in reader.pages)
                extracted += f"\n\n--- Content of {name} ---\n{text[:8000]}"
            except Exception as e:
                extracted += f"\n\n--- Could not read {name}: {e} ---"
        elif ftype.startswith("text/"):
            try:
                raw = base64.b64decode(data).decode("utf-8", errors="ignore")
                extracted += f"\n\n--- Content of {name} ---\n{raw[:8000]}"
            except Exception as e:
                extracted += f"\n\n--- Could not read {name}: {e} ---"
        elif ftype.startswith("image/"):
            image_files.append(f)
        else:
            extracted += f"\n\n--- {name}: unsupported file type ({ftype}), skipped ---"

    return extracted, image_files


def _call_groq(model, system_prompt, user_content):
    response = requests.post(
        GROQ_URL,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {GROQ_API_KEY}",
        },
        json={
            "model": model,
            "max_tokens": 1200,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
        },
        timeout=60,
    )
    return response.json()


def analyze_text_integrity(text: str, depth: str = "quick", files=None):
    """
    Runs a free live web search, extracts text from any attached PDF/text
    files, and sends everything to Groq for analysis. Images are analyzed
    separately with a vision-capable model. Decides whether this is a simple
    factual question (answered directly) or a decision/claim that needs a
    full, evidence-based report.
    """
    if len(text.strip()) < 3 and not files:
        return {"mode": "report", "verdict": "Insufficient data", "confidence": 0}

    count = DEPTH_COUNTS.get(depth, 1)

    search_results = _web_search(text)
    search_context = ""
    sources = []
    for r in search_results:
        title = r.get("title", "")
        href = r.get("href", "")
        body = r.get("body", "")
        search_context += f"- {title}: {body} ({href})\n"
        if href:
            sources.append({"title": title or href, "url": href})

    file_text, image_files = _extract_file_text(files)

    system_prompt = (
        "You are Verdict, a neutral analysis assistant. You are given live web "
        "search results, and possibly text extracted from attached files, "
        "alongside the user's message. First decide which of these two modes "
        "fits the message:\n\n"
        'MODE A - "answer": the user asked a simple, open factual question that '
        "just needs a direct answer.\n\n"
        'MODE B - "report": the user is asking you to evaluate a claim, decision, '
        "investment, legal question, or anything needing a structured verdict.\n\n"
        "Respond with ONLY valid JSON, no extra text, no code fences.\n\n"
        'For MODE A: {"mode": "answer", "answer": a clear, complete answer in '
        "2-5 sentences, grounded in the search results and any file content "
        "when relevant}.\n\n"
        'For MODE B: {"mode": "report", "verdict": a short phrase (2-4 words), '
        'for example "Likely misleading", "Reasonable case", "High risk", or '
        '"Needs more data", "confidence": an integer from 0 to 100, '
        '"explanation": two sentences explaining the reasoning, '
        f'"evidence": an array of {count} short string(s) supporting the verdict, '
        f'"risks": an array of {count} short string(s), concerns or red flags, '
        f'"next_steps": an array of {count} short string(s), concrete actions the '
        "user could take}.\n\n"
        "Ground your answer in the search results and any file content provided. "
        "Do not invent facts, statistics, or sources you cannot support. Write in "
        "clear English."
    )

    user_text = (
        f"Web search results:\n{search_context or '(no results found)'}\n\n"
        f"User message: {text}{file_text}"
    )

    try:
        if image_files:
            # Vision-capable model: images go in a multimodal content array
            content_blocks = [{"type": "text", "text": user_text}]
            for f in image_files:
                content_blocks.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{f.get('type')};base64,{f.get('data')}"},
                })
            data = _call_groq(VISION_MODEL, system_prompt, content_blocks)
        else:
            data = _call_groq(TEXT_MODEL, system_prompt, user_text)

        if "error" in data:
            return {
                "mode": "report",
                "verdict": "Analysis unavailable",
                "confidence": 0,
                "explanation": f"Groq API error: {data['error'].get('message', data['error'])}",
            }

        raw_text = data["choices"][0]["message"]["content"]
        clean = raw_text.replace("```json", "").replace("```", "").strip()

        if not clean:
            print("DEBUG - empty response from Groq:", json.dumps(data)[:2000])
            return {
                "mode": "report",
                "verdict": "Analysis unavailable",
                "confidence": 0,
                "explanation": "The AI returned an empty response. Check the backend terminal.",
            }

        result = json.loads(clean)
        if sources:
            result["sources"] = sources[:8]
        return result
    except Exception as e:
        return {
            "mode": "report",
            "verdict": "Analysis unavailable",
            "confidence": 0,
            "explanation": f"Could not complete the AI analysis: {str(e)}",
        }
