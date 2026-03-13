#!/usr/bin/env python3
"""
Static tile file server. Serves SVG and JSON files from backend/tiles/.

Routes:
  GET /{q}/{r}.svg  → tiles/{q}/{r}.svg or 404
  GET /{q}/{r}.json → tiles/{q}/{r}.json or 404

In dev, the frontend's TILE_CDN points here.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any

TILES_DIR = os.path.join(os.path.dirname(__file__), "tiles")
PORT = 8100

# ── Shared utilities (imported by anvil_follower.py) ──

# keccak256("TilePlaced(uint16,uint16,address,uint8,uint8,uint8,bool,uint128)")
TILE_PLACED_TOPIC = "0x10d7d4049b99a0a5fb0160573ed3f0073f5ab1267ada5309484465543c43781d"


def decode_tile_placed(log: dict[str, Any]) -> dict[str, Any] | None:
    """Decode a TilePlaced event log entry.

    Topics: [topic0, q (uint16 padded), r (uint16 padded), owner (address padded)]
    Data: abi-encoded (uint8 ka, uint8 kb, uint8 kc, bool polarity, uint128 catalanIndex)
    """
    topics: list[str] = log.get("topics", [])
    if len(topics) < 4:
        return None

    q = int(topics[1], 16)
    r = int(topics[2], 16)
    owner = "0x" + topics[3][-40:]

    data: str = log.get("data", "0x")
    if data.startswith("0x"):
        data = data[2:]
    if len(data) < 5 * 64:
        return None

    # 5 ABI-encoded 32-byte words: ka, kb, kc, polarity, catalanIndex
    ka = int(data[0:64], 16)
    kb = int(data[64:128], 16)
    kc = int(data[128:192], 16)
    polarity = int(data[192:256], 16)
    catalan_index = int(data[256:320], 16)

    return {
        "q": q, "r": r, "owner": owner,
        "ka": ka, "kb": kb, "kc": kc,
        "polarity": polarity, "catalanIndex": catalan_index,
    }


def rpc_call(rpc_url: str, method: str, params: list[Any]) -> dict[str, Any]:
    """Make a JSON-RPC call via urllib (stdlib, no deps)."""
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode()
    req = urllib.request.Request(
        rpc_url,
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read())  # type: ignore[no-any-return]


# ── Static file server ──

CONTENT_TYPES = {
    ".svg": "image/svg+xml",
    ".json": "application/json",
}


class Handler(BaseHTTPRequestHandler):

    def do_GET(self) -> None:
        m = re.match(r"^/(\d+)/(\d+)\.(svg|json)$", self.path)
        if not m:
            self.send_error(404)
            return

        q, r, ext = m.group(1), m.group(2), m.group(3)
        file_path = os.path.join(TILES_DIR, q, f"{r}.{ext}")
        if not os.path.exists(file_path):
            self.send_error(404)
            return

        with open(file_path, "rb") as f:
            data = f.read()

        content_type = CONTENT_TYPES.get(f".{ext}", "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        print(f"  {args[0]}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Truchet static tile server")
    parser.add_argument("--port", type=int, default=PORT, help="HTTP port")
    args = parser.parse_args()

    print(f"Serving tiles from {TILES_DIR}")
    print(f"Serving on http://localhost:{args.port}")
    HTTPServer(("", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
