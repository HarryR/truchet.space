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
import os
import re
from http.server import HTTPServer, BaseHTTPRequestHandler

TILES_DIR = os.path.join(os.path.dirname(__file__), "tiles")
PORT = 8100

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
