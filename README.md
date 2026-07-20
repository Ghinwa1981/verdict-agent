# Verdict

**Verdict** analyzes any claim, question, or decision and returns a grounded answer: either a direct sourced answer to a factual question, or a full report with a confidence score, evidence, risks, and next steps - backed by live web search. 

Verdict is a **paid, callable CAP agent** on the CROO Agent Store, now powered by an optimized multi-agent pipeline.

---

## 🌐 Live Agent (CROO Store)

- **Agent Store Listing:** `Verdict` (search "Verdict" on the CROO Agent Store)
- **Service:** **Decision Analysis** - 5 USDC, 30-minute SLA, text in / text out

---

## ✨ What It Does

- **Open-Ended Input:** Ask a factual question, evaluate a claim, or attach a PDF/text/image file for the agent to analyze.
- **Dynamic 3-Agent Pipeline:** Instead of a simple single-prompt pass, Verdict coordinates three specialized agents:
  - **ResearchAgent:** Gathers real-time web results and extracts readable text from attachments. It dynamically scales search queries (3 results for Quick mode, 8 results for Full mode) to optimize API costs and speed.
  - **FactCheckAgent (Devil's Advocate):** Active during deep analysis. It cross-examines research context against your claim to expose logical fallacies, source unreliability, contradictions, and compliance/financial risks.
  - **VerdictAgent:** Synthesizes raw research and the critical scrutiny report to deliver an unbiased master verdict.
- **Two Response Modes (Decided Automatically):**
  - **Answer Mode:** A direct, sourced answer for simple factual questions (always free).
  - **Report Mode:** A structured verdict containing a confidence score, evidence, risks, and next steps (tiered pricing/SLA).
- **File Understanding:** PDFs and text files are parsed and read into the analysis; images are handled by a vision-capable model (`VISION_MODEL`).

---

## 🛠 Core Architecture Flow
code
Code
[ User Query / File Upload ]
                           │
                           ▼
                  ┌─────────────────┐
                  │  ResearchAgent  │  ◄── Dynamically scales search depth
                  └────────┬────────┘      based on requested tier (3-8 results)
                           │
                           ▼
                 (Gathered Context)
                           │
        ┌──────────────────┴──────────────────┐
        ▼ (Quick Mode)                        ▼ (Full Mode)
┌──────────────┐                     ┌────────────────┐
│ VerdictAgent │                     │ FactCheckAgent │ ◄── Acts as "Devil's Advocate"
└──────┬───────┘                     └────────┬───────┘     to find contradictions
       │                                      │
       │                               (Scrutiny Report)
       │                                      │
       │                                      ▼
       │                             ┌────────────────┐
       │                             │  VerdictAgent  │ ◄── Synthesizes raw research
       │                             └────────┬───────┘     + critical scrutiny report
       ▼                                      ▼
[ Fast Verdict JSON ]                [ Deep Verdict JSON ]
code
Code
---

## 🔗 CAP Integration (Hackathon Requirement)

Verdict is wired into the CROO Agent Protocol via the official `croo-sdk` (Python) as a **provider agent**:

- **Unified Async Process:** In production, `main.py` launches the WebSocket listener (`croo_provider.py`'s `run_cap_listener`) inside the FastAPI startup event as an `asyncio.create_task`. This allows a single hosting instance to handle both the human-facing web APIs and the blockchain agent-commerce lifecycle.
- **Negotiation Event:** On `EventType.NEGOTIATION_CREATED`, it calls `accept_negotiation(...)` to automatically accept and create an on-chain order.
- **Settlement Event:** On `EventType.ORDER_PAID` (funds locked in CAP's escrow), it pulls the requester's query from the order, runs it through the **same multi-agent analysis engine** (`agent_core.analyze_text_integrity`), and calls `deliver_order(...)` with the structured result. CAP then verifies delivery and settles the order on-chain automatically.

**SDK Methods Used:** `AgentClient.connect_websocket`, `stream.on`, `accept_negotiation`, `get_order`, `deliver_order`. 

---

## 📂 Directory Layout
verdict-agent/
├── render.yaml Render blueprint for single-click deployment
├── frontend/ React + Vite dashboard (human-facing web interface)
└── backend/
├── main.py FastAPI app: web dashboard's API, Stripe checkout, & CROO WebSockets
├── agent_core.py Consolidated core multi-agent engine (Research, FactCheck, Verdict, Orchestrator)
├── croo_provider.py CAP provider: WebSocket listener for on-chain requests
└── requirements.txt Python dependencies
code
Code
Both `main.py` (human users, card payments via Stripe) and `croo_provider.py` (agents/humans via CAP, USDC on-chain) call the exact same unified `agent_core.analyze_text_integrity` engine. One core engine, two ways to settle payment.

**Backend Stack:** FastAPI, Groq (LLM inference), DuckDuckGo Search (`ddgs`), pypdf (PDF text extraction), croo-sdk (CAP integration), Stripe (card payments).

**Frontend Stack:** React, Vite, jsPDF (client-side PDF export).

---

## 💻 Running It Locally

### 1. Web Dashboard + API (Backend)
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env
# Fill in .env: Groq API key, Stripe Keys, and CROO keys
uvicorn main:app --reload
Note: Booting the FastAPI server will automatically spawn the CAP provider listener in the background.
2. Web Dashboard (Frontend)
code
Bash
cd frontend
npm install
npm run dev
☁️ One-Click Deployment to Render
This project is fully optimized for Render using the unified render.yaml file. It spins up both your Backend (Web API + Background CROO WebSocket Listener) and your Static Frontend inside Render's free tier.
Commit and push your code to your GitHub Repository (Make sure .env is ignored!).
Sign in to your Render Dashboard.
Click New + and select Blueprint.
Link your repository. Render will automatically parse render.yaml and configure your services.
Provide your Environment Variables (Groq, Stripe, and CROO keys) in Render's dashboard.
📝 Integration Notes
No paid AI API key is required for the analysis engine itself (Groq free tier).
CAP wallet setup (MetaMask on Base) and agent/service registration were completed through the CROO Dashboard (agent.croo.network), following the SDK's documented setup model.
Stripe payments in main.py are a separate, optional path for human users arriving through the web dashboard directly; they do not touch CAP.
📄 License
MIT - see LICENSE.