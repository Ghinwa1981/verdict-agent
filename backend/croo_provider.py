# croo_provider.py
#
# Runs Verdict as a live CAP provider agent. Listens for orders on the
# CROO network, and for every paid order, runs the SAME analysis engine
# used by the web app (agent_core.analyze_text_integrity), then delivers
# the result on-chain via CAP settlement.
#
# Run this alongside the FastAPI backend (separate process):
#   python croo_provider.py

import asyncio
import json
import os
import time

from dotenv import load_dotenv
from croo import (
    AgentClient,
    Config,
    EventType,
    DeliverableType,
    DeliverOrderRequest,
)

from agent_core import analyze_text_integrity

load_dotenv()

LOG_PATH = os.path.join(os.path.dirname(__file__), "verifications_log.json")

client = AgentClient(
    Config(
        base_url=os.environ["CROO_API_URL"],
        ws_url=os.environ["CROO_WS_URL"],
    ),
    os.environ["CROO_SDK_KEY"],
)


def _extract_query(order) -> str:
    """Pulls the requester's question/claim out of the order's requirements
    field. Requirements are submitted as a JSON string by the requester,
    e.g. '{"task": "is this investment legit?"}'."""
    raw = getattr(order, "requirements", None) or "{}"
    try:
        data = json.loads(raw)
        return data.get("task") or data.get("query") or raw
    except (json.JSONDecodeError, TypeError):
        return str(raw)


def _append_to_log(record: dict):
    """Appends one completed order to a local JSON log file, which the
    /api/verifications endpoint (see main.py) and the live proof dashboard
    both read from. Real records only - nothing fabricated."""
    try:
        records = []
        if os.path.exists(LOG_PATH):
            with open(LOG_PATH, "r", encoding="utf-8") as f:
                records = json.load(f)
        records.insert(0, record)
        records = records[:200]  # keep the log from growing unbounded
        with open(LOG_PATH, "w", encoding="utf-8") as f:
            json.dump(records, f, indent=2)
    except Exception as e:
        print(f"Could not write to verifications log: {e}")


async def run_cap_listener():
    """Connects to CROO and listens for orders indefinitely. Can be run
    standalone (python croo_provider.py) or imported and launched as a
    background task inside another asyncio app (see main.py)."""
    stream = await client.connect_websocket()
    print("Verdict CAP provider is online, listening for orders...")

    def on_negotiation(e):
        async def _handle():
            result = await client.accept_negotiation(e.negotiation_id)
            print(f"Negotiation accepted -> order {result.order.order_id}")

        asyncio.create_task(_handle())

    stream.on(EventType.NEGOTIATION_CREATED, on_negotiation)

    def on_paid(e):
        async def _handle():
            print(f"Order {e.order_id} paid - running Verdict analysis...")
            order = await client.get_order(e.order_id)
            query = _extract_query(order)

            result = analyze_text_integrity(query, depth="quick")

            await client.deliver_order(
                e.order_id,
                DeliverOrderRequest(
                    deliverable_type=DeliverableType.TEXT,
                    deliverable_text=json.dumps(result),
                ),
            )
            print(f"Order {e.order_id} delivered.")

            _append_to_log({
                "order_id": e.order_id,
                "query": query[:160],
                "mode": result.get("mode"),
                "verdict": result.get("verdict"),
                "confidence": result.get("confidence"),
                "answer_snippet": (result.get("answer") or "")[:200] or None,
                "status": "delivered",
                "delivered_at": int(time.time()),
            })

        asyncio.create_task(_handle())

    stream.on(EventType.ORDER_PAID, on_paid)

    stop = asyncio.Event()
    await stop.wait()


if __name__ == "__main__":
    asyncio.run(run_cap_listener())
