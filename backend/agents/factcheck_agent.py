# agents/factcheck_agent.py

from .base import TEXT_MODEL, call_groq


class FactCheckAgent:
    """Plays devil's advocate. Critically analyzes research vs. user claims

    to find contradictions, red flags, or verification gaps.
    """

    name = "factcheck"

    def cross_examine(self, text: str, research: dict) -> str:
        system_prompt = (
            "You are an elite, highly skeptical Fact-Checking & Cross-Examination Agent. "
            "Your role is to act as 'devil's advocate' against the user's claim or query. "
            "Analyze the provided research context and files critically. Focus on finding:\n"
            "1. Any contradictions between the user's claim and the web search results/files.\n"
            "2. Logical fallacies, bias, or lack of concrete evidence in the user's input.\n"
            "3. Source credibility issues (e.g., rumors vs. official documentation).\n"
            "4. Hidden risks, compliance issues, or financial/legal red flags.\n\n"
            "Provide a highly objective, critical, and structured breakdown in clear English. "
            "Be direct, sharp, and do not hold back on warning signs."
        )

        user_text = (
            f"User's Claim/Query: {text}\n\n"
            f"Gathered Research Context:\n{research.get('search_context') or '(No search context)'}\n\n"
            f"Extracted File Context:\n{research.get('file_text') or '(No file content)'}\n"
        )

        try:
            data = call_groq(TEXT_MODEL, system_prompt, user_text)
            if "error" in data:
                return f"Factcheck analysis skipped due to API error: {data['error']}"
            return data["choices"][0]["message"]["content"]
        except Exception as e:
            return f"Factcheck analysis failed: {str(e)}"