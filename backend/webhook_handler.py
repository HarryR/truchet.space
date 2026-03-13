"""
Webhook handler for TilePlaced events in Alchemy Custom Webhook format.

Locally: receives POSTs from anvil_follower, runs solver, writes to disk.
Later:   wrap in Modal, write to R2 instead.

Usage:
    python -mbackend.webhook_handler [--port 8200] [--tiles-dir backend/tiles]
"""
from __future__ import annotations

import argparse
import json
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any

from .server import decode_tile_placed
from .solver import solve_tile


class WebhookServer(BaseHTTPRequestHandler):
    tiles_dir: str = ""
    processed: set[tuple[int, int]] = set()

    def do_POST(self) -> None:
        if self.path != "/webhook":
            self.send_error(404)
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            self._respond(400, {"error": "invalid JSON"})
            return

        results = process_webhook(payload, self.tiles_dir, self.processed)
        self._respond(200, {"processed": results})

    def _respond(self, code: int, data: dict[str, Any]) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # quiet


def extract_logs(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Pull raw log entries from Alchemy webhook envelope."""
    try:
        return payload["event"]["data"]["block"]["logs"]
    except (KeyError, TypeError):
        return []


def process_webhook(
    payload: dict[str, Any],
    tiles_dir: str,
    processed: set[tuple[int, int]],
) -> list[dict[str, Any]]:
    """Decode logs, run solver, save results. Returns list of outcomes."""
    logs = extract_logs(payload)
    results: list[dict[str, Any]] = []

    for raw_log in logs:
        # Normalize: Alchemy uses camelCase fields, eth_getLogs uses hex keys.
        # decode_tile_placed expects "topics" and "data" which both formats have.
        tile = decode_tile_placed(raw_log)
        if tile is None:
            results.append({"status": "skip", "reason": "decode_failed"})
            continue

        q, r = tile["q"], tile["r"]
        if (q, r) in processed:
            results.append({"status": "skip", "q": q, "r": r,
                            "reason": "already_processed"})
            continue

        ka, kb, kc = tile["ka"], tile["kb"], tile["kc"]
        idx = tile["catalanIndex"]
        pol = tile["polarity"]
        minter = tile.get("owner", "")

        try:
            svg, metadata = solve_tile(q, r, ka, kb, kc, idx, pol, minter=minter)
        except Exception as e:
            results.append({"status": "error", "q": q, "r": r,
                            "error": str(e)})
            continue

        # Write to disk (swap for R2 upload in Modal version)
        tile_dir = os.path.join(tiles_dir, str(q))
        os.makedirs(tile_dir, exist_ok=True)
        with open(os.path.join(tile_dir, f"{r}.svg"), "w") as f:
            f.write(svg)
        with open(os.path.join(tile_dir, f"{r}.json"), "w") as f:
            json.dump(metadata, f, indent=2)

        processed.add((q, r))
        print(f"[webhook] ({q},{r}) {ka}-{kb}-{kc} idx={idx} "
              f"pol={'+'if pol else '-'}")
        results.append({"status": "ok", "q": q, "r": r})

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description="Tile webhook handler")
    parser.add_argument("--port", type=int, default=8200)
    parser.add_argument("--tiles-dir",
                        default=os.path.join(os.path.dirname(__file__),
                                             "tiles"))
    args = parser.parse_args()

    WebhookServer.tiles_dir = args.tiles_dir
    print(f"[webhook] Listening on http://localhost:{args.port}/webhook")
    print(f"[webhook] Tiles dir: {args.tiles_dir}")
    HTTPServer(("", args.port), WebhookServer).serve_forever()


if __name__ == "__main__":
    main()
