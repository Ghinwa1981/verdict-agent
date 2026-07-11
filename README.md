# Verdict

**Verdict** analyzes any claim, question, or decision and returns a grounded answer:
either a direct sourced answer to a factual question, or a full report with a
confidence score, evidence, risks, and next steps - backed by live web search.
Verdict is a **paid, callable CAP agent** on the CROO Agent Store.

## Live agent

- Agent Store listing: `Verdict` (search "Verdict" on the CROO Agent Store)
- Service: **Decision Analysis** - 5 USDC, 30-minute SLA, text in / text out

## What it does

- **Open-ended input** - ask a factual question, evaluate a claim, or attach a
  PDF/text file for the agent to read and factor into its analysis.
- **Two response modes**, decided automatically:
  - **Answer mode** - a direct, sourced answer for simple factual questions.
  - **Report mode** - a structured verdict (confidence score, evidence, risks,
    next steps) for decisions and claims that need real judgment.
- **Live web search** on every request (DuckDuckGo) - real, current sources.
- **File understanding** - PDFs and text files are parsed and read into the
  analysis; images are handled by a vision-capable model.

## CAP integration (this hackathon's requirement)

Verdict is wired into the CROO Agent Protocol via the official
`croo-sdk` (Python) as a **provider agent**:

- `backend/croo_provider.py` runs as a long-lived process that connects to
  CROO over WebSocket (`AgentClient.connect_websocket`).
- On `EventType.NEGOTIATION_CREATED`, it calls `accept_negotiation(...)` to
  create an on-chain order.
- On `EventType.ORDER_PAID` (funds locked in CAP's escrow), it pulls the
  requester's question from the order, runs it through the **same analysis
  engine** used by the web app (`agent_core.analyze_text_integrity`), and
  calls `deliver_order(...)` with the result. CAP then verifies delivery and
  settles the order on-chain automatically.

SDK methods used: `AgentClient.connect_websocket`, `stream.on`,
`accept_negotiation`, `get_order`, `deliver_order`. Agent registration,
service pricing/SLA, and SDK-Key issuance were done through the CROO
Dashboard (`agent.croo.network`), per the SDK's own setup model.

## Architecture

```
verdict-agent/
├── frontend/            React + Vite dashboard (human-facing product)
└── backend/
    ├── main.py           FastAPI app: web dashboard's API + Stripe payments
    ├── agent_core.py      Core analysis engine (web search + LLM + files)
    └── croo_provider.py   CAP provider: makes the agent callable/payable on-chain
```

Both `main.py` (human users, card payments via Stripe) and
`croo_provider.py` (agents/humans via CAP, USDC on-chain) call the same
`agent_core.analyze_text_integrity` - one engine, two ways to pay for it.

**Backend stack:** FastAPI, Groq (LLM inference), DuckDuckGo Search (`ddgs`),
pypdf (PDF text extraction), croo-sdk (CAP integration), Stripe (card payments).

**Frontend stack:** React, Vite, jsPDF (client-side PDF export).

## Running it

### Web dashboard + API
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
# fill in .env: a free Groq API key (console.groq.com)
uvicorn main:app --reload
```
```bash
cd frontend
npm install
npm run dev
```

### CAP provider (makes the agent live on CROO)
```bash
cd backend
# .env also needs: CROO_API_URL, CROO_WS_URL, CROO_SDK_KEY
python croo_provider.py
```
Leave this running - it's the process that listens for and fulfills orders
from the CROO Agent Store.

## Integration notes

- No paid AI API key is required for the analysis engine itself (Groq free tier).
- CAP wallet setup (MetaMask on Base) and agent/service registration were done
  through the CROO Dashboard, following the SDK's documented setup model.
- Stripe payments in `main.py` are a separate, optional path for human users
  arriving through the web dashboard directly; they do not touch CAP.

## License

MIT - see `LICENSE`.
