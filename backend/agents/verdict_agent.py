# agents/verdict_agent.py

import json

from .base import TEXT_MODEL, VISION_MODEL, call_groq
from .research_agent import ResearchAgent


class VerdictAgent:
    """Produces a sourced answer or structured verdict from gathered research."""

    name = "verdict"

    def analyze(self, text: str, research: dict, depth: str = "quick") -> dict:
        """Standard analysis for quick mode."""
        count = ResearchAgent.depth_count(depth)
        system_prompt = self._build_system_prompt(count)
        user_text = self._build_user_prompt(text, research)
        return self._execute_analysis(system_prompt, user_text, research)

    def analyze_full(self, text: str, research: dict, scrutiny_report: str) -> dict:
        """Deep analysis integrating the third agent's factcheck/scrutiny report."""
        count = ResearchAgent.depth_count("full")
        system_prompt = self._build_system_prompt_full(count)
        user_text = self._build_user_prompt_full(text, research, scrutiny_report)
        return self._execute_analysis(system_prompt, user_text, research)

    def _execute_analysis(self, system_prompt: str, user_text: str, research: dict) -> dict:
        image_files = research.get("image_files") or []
        try:
            if image_files:
                content_blocks = [{"type": "text", "text": user_text}]
                for f in image_files:
                    content_blocks.append({
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{f.get('type')};base64,{f.get('data')}"
                        },
                    })
                data = call_groq(VISION_MODEL, system_prompt, content_blocks)
            else:
                data = call_groq(TEXT_MODEL, system_prompt, user_text)

            if "error" in data:
                return self._error_result(
                    f"Groq API error: {data['error'].get('message', data['error'])}"
                )

            raw_text = data["choices"][0]["message"]["content"]
            clean = raw_text.replace("```json", "").replace("```", "").strip()

            if not clean:
                print("[VerdictAgent] empty response:", json.dumps(data)[:2000])
                return self._error_result(
                    "The AI returned an empty response."
                )

            result = json.loads(clean)
            sources = research.get("sources") or []
            if sources:
                result["sources"] = sources[:8]
            return result
        except Exception as e:
            return self._error_result(f"Could not complete the AI analysis: {str(e)}")

    def _build_system_prompt(self, count: int) -> str:
        return (
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

    def _build_system_prompt_full(self, count: int) -> str:
        """Specialized prompt for synthesizing research + critical analysis report."""
        return (
            "You are Verdict, an elite, unbiased analytical system. You are given live search results, "
            "extracted file text, and a highly critical 'Fact-Checking/Devil's Advocate' report.\n\n"
            "Your task is to weigh all evidence objectively, resolve any discrepancies highlighted in "
            "the Fact-Checking report, and synthesize a master structured verdict.\n\n"
            "Respond with ONLY valid JSON, no extra text, no markdown code fences.\n\n"
            'Expected JSON format:\n'
            '{"mode": "report", '
            '"verdict": a short, precise verdict phrase (2-4 words, e.g., "Verified Claim", "High Failure Risk", "Unsubstantiated Case"), '
            '"confidence": an integer from 0 to 100 representing the strength of evidence, '
            '"explanation": a concise, deep explanation (3-4 sentences max) resolving the core issue, '
            f'"evidence": an array of {count} key facts supporting this verdict, '
            f'"risks": an array of {count} critical risks, concerns, or contradictions found, '
            f'"next_steps": an array of {count} practical, highly strategic next steps for the user.\n\n'
            "Strictly write in clear English. Do not invent facts. Ensure your verdict is fully grounded."
        )

    def _build_user_prompt(self, text: str, research: dict) -> str:
        search_context = research.get("search_context") or "(no results found)"
        file_text = research.get("file_text") or ""
        return (
            f"Web search results:\n{search_context}\n\n"
            f"User message: {text}{file_text}"
        )

    def _build_user_prompt_full(self, text: str, research: dict, scrutiny_report: str) -> str:
        search_context = research.get("search_context") or "(no results found)"
        file_text = research.get("file_text") or ""
        return (
            f"Web search results:\n{search_context}\n\n"
            f"Fact-Checking Critical Report (Devil's Advocate):\n{scrutiny_report}\n\n"
            f"User message: {text}{file_text}"
        )

    @staticmethod
    def _error_result(message: str) -> dict:
        return {
            "mode": "report",
            "verdict": "Analysis unavailable",
            "confidence": 0,
            "explanation": message,
        }