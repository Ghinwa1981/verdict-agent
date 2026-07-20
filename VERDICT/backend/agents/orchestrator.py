
# agents/orchestrator.py

from .research_agent import ResearchAgent
from .verdict_agent import VerdictAgent
from .factcheck_agent import FactCheckAgent  # Added third agent


class AnalysisOrchestrator:
    """Coordinates research gathering, fact-checking, and verdict analysis."""

    def __init__(self):
        self.research_agent = ResearchAgent()
        self.factcheck_agent = FactCheckAgent()  # Third agent for auditing and cross-checking
        self.verdict_agent = VerdictAgent()

    def run(self, text: str, depth: str = "quick", files=None) -> dict:
        # Initial input data validation
        if len(text.strip()) < 3 and not files:
            return {"mode": "report", "verdict": "Insufficient data", "confidence": 0}

        # 1. Research stage: pass depth to optimize API consumption and response speed
        research = self.research_agent.gather(text, depth=depth, files=files)

        # 2. Determine processing path based on required depth
        if depth == "full":
            # In full depth: invoke the third agent to cross-examine and audit research results
            scrutiny_report = self.factcheck_agent.cross_examine(text, research)
            
            # VerdictAgent issues final judgment based on both research and scrutiny report
            return self.verdict_agent.analyze_full(text, research, scrutiny_report)
        else:
            # In quick mode: issue verdict directly based on initial research to save time and cost
            return self.verdict_agent.analyze(text, research, depth="quick")
