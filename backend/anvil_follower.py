"""
Anvil event follower — polls for TilePlaced events and POSTs them
to a webhook endpoint in Alchemy Custom Webhook format.

This lets you develop and test the webhook handler locally against
Anvil without needing a real Alchemy subscription.

Usage:
    python -mbackend.anvil_follower [--webhook-url URL] [--rpc-url URL]

Defaults:
    --webhook-url  http://localhost:8200/webhook
    --rpc-url      http://127.0.0.1:8545
"""
from __future__ import annotations

import argparse
import json
import os
import random
import time
import urllib.request
from typing import Any
from uuid import uuid4

# Reuse the existing RPC helper and topic constant
from .server import rpc_call, TILE_PLACED_TOPIC


def wrap_alchemy(logs: list[dict[str, Any]]) -> dict[str, Any]:
    """Wrap raw eth_getLogs entries in Alchemy Custom Webhook envelope.

    The handler should only rely on event.data.block.logs[].topics
    and event.data.block.logs[].data — everything else is best-effort
    for local simulation.
    """
    return {
        "webhookId": "wh_local_anvil",
        "id": f"whevt_{uuid4().hex[:16]}",
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "type": "GRAPHQL",
        "event": {
            "data": {
                "block": {
                    "logs": [
                        {
                            "topics": log["topics"],
                            "data": log["data"],
                            "index": int(log.get("logIndex", "0x0"), 16),
                            "account": {
                                "address": log.get("address", ""),
                            },
                            "transaction": {
                                "hash": log.get("transactionHash", ""),
                            },
                        }
                        for log in logs
                    ],
                },
            },
            "sequenceNumber": str(int(time.time() * 1000)),
        },
    }


def post_webhook(url: str, payload: dict[str, Any]) -> int:
    """POST JSON to the webhook endpoint. Returns HTTP status code."""
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        return e.code


def main() -> None:
    parser = argparse.ArgumentParser(description="Anvil → webhook follower")
    parser.add_argument("--webhook-url",
                        default=os.environ.get("WEBHOOK_URL",
                                               "http://localhost:8200/webhook"))
    parser.add_argument("--rpc-url",
                        default=os.environ.get("ANVIL_RPC",
                                               "http://127.0.0.1:8545"))
    parser.add_argument("--nft-address",
                        default=os.environ.get("NFT_ADDRESS", ""))
    parser.add_argument("--poll-interval", type=float, default=2.0)
    parser.add_argument("--batch", action="store_true",
                        help="Send all logs in one webhook call per poll "
                             "(default: one call per log)")
    args = parser.parse_args()

    nft_address = args.nft_address
    if not nft_address:
        env_path = os.path.join(os.path.dirname(__file__), ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.startswith("NFT_ADDRESS="):
                        nft_address = line.strip().split("=", 1)[1]
                        break
    if not nft_address:
        print("NFT_ADDRESS not set. Run extract-addresses.py or pass --nft-address.")
        raise SystemExit(1)

    from_block = "0x0"
    total_sent = 0
    print(f"[follower] Watching {nft_address} on {args.rpc_url}")
    print(f"[follower] Posting to {args.webhook_url}")

    while True:
        try:
            resp = rpc_call(args.rpc_url, "eth_getLogs", [{
                "address": nft_address,
                "topics": [TILE_PLACED_TOPIC],
                "fromBlock": from_block,
                "toBlock": "latest",
            }])
            logs: list[dict[str, Any]] = resp.get("result", [])

            if logs:
                if args.batch:
                    delay = random.uniform(1.0, 3.0)
                    time.sleep(delay)
                    payload = wrap_alchemy(logs)
                    n = len(logs)
                    status = post_webhook(args.webhook_url, payload)
                    total_sent += n
                    print(f"[follower] Sent {n} logs → {status} "
                          f"(delay={delay:.1f}s, total: {total_sent})")
                else:
                    for log in logs:
                        delay = random.uniform(1.0, 3.0)
                        time.sleep(delay)
                        payload = wrap_alchemy([log])
                        status = post_webhook(args.webhook_url, payload)
                        total_sent += 1
                        q = int(log["topics"][1], 16)
                        r = int(log["topics"][2], 16)
                        print(f"[follower] ({q},{r}) → {status} "
                              f"(delay={delay:.1f}s, total: {total_sent})")

                last_block = max(int(log["blockNumber"], 16) for log in logs)
                from_block = hex(last_block + 1)

        except Exception as e:
            print(f"[follower] Error: {e}")

        time.sleep(args.poll_interval)


if __name__ == "__main__":
    main()
