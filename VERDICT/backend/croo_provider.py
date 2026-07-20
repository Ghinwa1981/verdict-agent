# croo_provider.py
#
# Runs Verdict as a live CAP provider agent. Listens for orders on the
# CROO network, and for every paid order, runs the SAME analysis engine
# used by the web app (agent_core.analyze_text_integrity), then delivers
# the result on-chain via CAP settlement.
#
# Run this alongside the FastAPI backend (separate process):
#    python croo_provider.py

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

# Ensure required environment variables exist
if not os.getenv("CROO_API_URL") or not os.getenv("CROO_SDK_KEY"):
    raise ValueError("Missing CROO environment variables in .env file.")

client = AgentClient(
    Config(
        base_url=os.environ["CROO_API_URL"],
        ws_url=os.environ["CROO_WS_URL"],
    ),
    os.environ["CROO_SDK_KEY"],
)


def _extract_query_and_depth(order) -> tuple:
    """Pulls the requester's question/claim and analysis depth out of the
    order's requirements field. Defaults to 'quick' depth if not specified."""
    raw = getattr(order, "requirements", None) or "{}"
    try:
        data = json.loads(raw)
        query = data.get("task") or data.get("query") or raw
        depth = data.get("depth") or "quick"  # Extract depth dynamically
        return str(query), str(depth)
    except (json.JSONDecodeError, TypeError):
        return str(raw), "quick"


def _append_to_log(record: dict):
    """Appends one completed or failed order to a local JSON log file."""
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
    """Connects to CROO and listens for orders indefinitely."""
    stream = await client.connect_websocket()
    print("Verdict CAP provider is online, listening for orders...")

    def on_negotiation(e):
        async def _handle():
            try:
                result = await client.accept_negotiation(e.negotiation_id)
                print(f"Negotiation accepted -> order {result.order.order_id}")
            except Exception as ex:
                print(f"Failed to accept negotiation {e.negotiation_id}: {ex}")

        asyncio.create_task(_handle())

    stream.on(EventType.NEGOTIATION_CREATED, on_negotiation)

    def on_paid(e):
        async def _handle():
            print(f"Order {e.order_id} paid - running Verdict analysis...")
            query = "Unknown"
            depth = "quick"
            try:
                order = await client.get_order(e.order_id)
                query, depth = _extract_query_and_depth(order)

                # Run synchronous analysis in a separate thread to prevent blocking the WebSocket
                result = await asyncio.to_thread(analyze_text_integrity, query, depth)

                await client.deliver_order(
                    e.order_id,
                    DeliverOrderRequest(
                        deliverable_type=DeliverableType.TEXT,
                        deliverable_text=json.dumps(result),
                    ),
                )
                print(f"Order {e.order_id} delivered successfully.")

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

            except Exception as ex:
                print(f"Error processing order {e.order_id}: {ex}")
                # Deliver an error report on-chain so the order does not hang indefinitely without a response
                try:
                    error_payload = {
                        "status": "error",
                        "error_message": "Analysis failed due to internal engine error.",
                        "details": str(ex)
                    }
                    await client.deliver_order(
                        e.order_id,
                        DeliverOrderRequest(
                            deliverable_type=DeliverableType.TEXT,
                            deliverable_text=json.dumps(error_payload),
                        ),
                    )
                except Exception as delivery_ex:
                    print(f"Critically failed to deliver error payload to chain: {delivery_ex}")

                _append_to_log({
                    "order_id": e.order_id,
                    "query": query[:160],
                    "status": "failed",
                    "error": str(ex),
                    "delivered_at": int(time.time()),
                })

        asyncio.create_task(_handle())

    stream.on(EventType.ORDER_PAID, on_paid)

    stop = asyncio.Event()
    await stop.wait()


if __name__ == "__main__":
    asyncio.run(run_cap_listener())