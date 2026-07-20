# agents/research_agent.py

import base64
import io

from ddgs import DDGS
from pypdf import PdfReader

from .base import DEPTH_COUNTS


class ResearchAgent:
    """Gathers live web results and extracts readable content from attachments."""

    name = "research"

    def gather(self, text: str, depth: str = "quick", files=None) -> dict:
        # تحديد عدد نتائج البحث ديناميكياً بناءً على العمق لتوفير التكلفة والوقت
        count = self.depth_count(depth)
        max_search_results = 3 if count <= 1 else 8

        search_results = self._web_search(text, max_results=max_search_results)
        search_context, sources = self._format_search_results(search_results)
        file_text, image_files = self._extract_file_text(files)

        return {
            "query": text,
            "search_results": search_results,
            "search_context": search_context,
            "sources": sources,
            "file_text": file_text,
            "image_files": image_files,
            "has_attachments": bool(files),
        }

    def _web_search(self, query: str, max_results: int = 5) -> list:
        try:
            with DDGS() as ddgs:
                results = list(ddgs.text(query, max_results=max_results))
            print(f"[ResearchAgent] {len(results)} result(s) for: {query[:80]}")
            return results
        except Exception as e:
            print(f"[ResearchAgent] web search failed: {e}")
            return []

    def _format_search_results(self, results: list) -> tuple[str, list]:
        search_context = ""
        sources = []
        for r in results:
            title = r.get("title", "")
            href = r.get("href", "")
            body = r.get("body", "")
            search_context += f"- {title}: {body} ({href})\n"
            if href:
                sources.append({"title": title or href, "url": href})
        return search_context, sources

    def _extract_file_text(self, files) -> tuple[str, list]:
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

    @staticmethod
    def depth_count(depth: str) -> int:
        return DEPTH_COUNTS.get(depth, 1)