# main.py
import os
import asyncio
import json
from typing import List, Optional
from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import stripe

from agent_core import analyze_text_integrity  # Import the core logic

load_dotenv()

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")

PRICE_IDS = {
    "quick": os.getenv("STRIPE_PRICE_QUICK"),
    "standard": os.getenv("STRIPE_PRICE_STANDARD"),
    "pro": os.getenv("STRIPE_PRICE_PRO"),
    "promax": os.getenv("STRIPE_PRICE_PROMAX"),
}


class FileAttachment(BaseModel):
    name: str
    type: str
    data: str  # base64-encoded content, no data: prefix


class AnalysisRequest(BaseModel):
    text: str
    metadata: dict
    files: Optional[List[FileAttachment]] = None


class CheckoutRequest(BaseModel):
    tier: str
    origin: str


class PaidAnalysisRequest(BaseModel):
    session_id: str
    text: str
    tier: str
    files: Optional[List[FileAttachment]] = None


app = FastAPI()


@app.on_event("startup")
async def start_cap_listener():
    """Runs the CAP provider listener in the background, inside the same
    process as the web server, so a single free hosting instance handles
    both the human-facing API and the CROO agent-commerce lifecycle."""
    required = ["CROO_API_URL", "CROO_WS_URL", "CROO_SDK_KEY"]
    if not all(os.getenv(k) for k in required):
        print("CAP listener not started: missing CROO_* env vars.")
        return
    try:
        from croo_provider import run_cap_listener
        asyncio.create_task(run_cap_listener())
    except Exception as e:
        print(f"CAP listener failed to start: {e}")


@app.get("/")
def root():
    return RedirectResponse(url="/docs")

_allowed = os.getenv("ALLOWED_ORIGINS", "*")
allow_origins = ["*"] if _allowed.strip() == "*" else [
    o.strip() for o in _allowed.split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _files_as_dicts(files):
    return [f.dict() for f in files] if files else None


# Free demo: direct answers are always fully free; reports get one real,
# complete point per category (not a vague teaser) plus an upsell nudge
@app.post("/analyze")
def analyze_data(request: AnalysisRequest):
    result = analyze_text_integrity(
        request.text, depth="free", files=_files_as_dicts(request.files)
    )

    if result.get("mode") == "answer":
        return result  # simple questions are answered in full, always free

    if result.get("verdict") in ("Insufficient data", "Analysis unavailable"):
        return result

    result["free_sample"] = True
    result["upsell"] = (
        "This is one real point per section, free. Paid tiers unlock more: "
        "Quick (3 each), Standard (5 each), Pro (8 each), or Pro Max (12 each, full depth)."
    )
    return result


# Fetch the real prices from Stripe for each tier
@app.get("/prices")
def get_prices():
    prices = {}
    for tier, price_id in PRICE_IDS.items():
        if not price_id:
            prices[tier] = {"error": "Price ID not set in .env"}
            continue
        try:
            price = stripe.Price.retrieve(price_id)
            prices[tier] = {
                "amount": price.unit_amount / 100,
                "currency": price.currency.upper(),
            }
        except Exception as e:
            prices[tier] = {"error": str(e)}
    return prices


# Create a Stripe checkout session for the selected tier
@app.post("/create-checkout-session")
def create_checkout_session(req: CheckoutRequest):
    price_id = PRICE_IDS.get(req.tier)
    if not price_id:
        return {"error": "Unknown tier, or its Price ID is not set in .env"}
    try:
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{"price": price_id, "quantity": 1}],
            success_url=f"{req.origin}?paid=1&session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{req.origin}?canceled=1",
        )
        return {"url": session.url}
    except Exception as e:
        return {"error": str(e)}


# Verify payment status
@app.get("/verify-payment")
def verify_payment(session_id: str):
    try:
        session = stripe.checkout.Session.retrieve(session_id)
        return {"paid": session.payment_status == "paid"}
    except Exception as e:
        return {"paid": False, "error": str(e)}


# Run the paid analysis - only after payment is confirmed
@app.post("/analyze-paid")
def analyze_paid(req: PaidAnalysisRequest):
    try:
        session = stripe.checkout.Session.retrieve(req.session_id)
        if session.payment_status != "paid":
            return {"error": "Payment for this session is not confirmed"}
    except Exception:
        return {"error": "Invalid payment session"}

    return analyze_text_integrity(
        req.text, depth=req.tier, files=_files_as_dicts(req.files)
    )


@app.get("/api/verifications")
def get_verifications():
    """Serves the log of real, completed CAP orders for the live proof
    dashboard. Returns an empty list until at least one order has been
    delivered - no fabricated data."""
    log_path = os.path.join(os.path.dirname(__file__), "verifications_log.json")
    if not os.path.exists(log_path):
        return []
    with open(log_path, "r", encoding="utf-8") as f:
        return json.load(f)


@app.get("/health")
def health():
    return {"ok": True}