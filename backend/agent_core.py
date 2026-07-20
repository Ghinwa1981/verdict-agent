# agent_core.py — public entry point; delegates to the multi-agent orchestrator.
from agents.orchestrator import AnalysisOrchestrator

_orchestrator = AnalysisOrchestrator()


def analyze_text_integrity(text: str, depth: str = "quick", files=None):
    """Runs research + verdict agents via the orchestrator."""
    return _orchestrator.run(text, depth=depth, files=files)
