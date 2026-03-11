#!/usr/bin/env python3
"""
Dev tile server. Serves tile data from backend/tiles/.

Routes:
  GET /tile/{q}/{r}      → JSON {ka, kb, kc, catalanIndex} or 404
  GET /tile/{q}/{r}/svg   → SVG file or 404
  GET /grid               → full grid.json (all placed tiles)

With --nft-address: polls Anvil for TilePlaced events and generates tiles on the fly.
Without --nft-address: static mode (backwards compatible).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import threading
import time
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Any

from .solver import solve_tile

TILES_DIR = os.path.join(os.path.dirname(__file__), "tiles")
PORT = 8100

# Thread-safe grid access
grid_lock = threading.Lock()

# Type alias for tile data dicts
TileData = dict[str, Any]
Grid = dict[tuple[int, int], TileData]


class Handler(BaseHTTPRequestHandler):
    grid: Grid = {}

    def do_GET(self) -> None:
        self.send_header_cors = True

        if self.path == "/grid":
            return self.serve_grid()

        m = re.match(r"^/tile/(\d+)/(\d+)(/svg)?$", self.path)
        if m:
            q, r, svg = int(m.group(1)), int(m.group(2)), m.group(3)
            if svg:
                return self.serve_svg(q, r)
            else:
                return self.serve_tile(q, r)

        self.send_error(404)

    def serve_grid(self) -> None:
        with grid_lock:
            grid_list: list[TileData] = []
            for (q, r), tile in sorted(Handler.grid.items()):
                grid_list.append({"q": q, "r": r, **tile})
        self.respond(200, "application/json", json.dumps(grid_list).encode())

    def serve_tile(self, q: int, r: int) -> None:
        with grid_lock:
            tile = Handler.grid.get((q, r))
        if tile is None:
            self.send_error(404)
            return
        self.respond(200, "application/json", json.dumps(tile).encode())

    def serve_svg(self, q: int, r: int) -> None:
        path = os.path.join(TILES_DIR, f"{q}-{r}.svg")
        if not os.path.exists(path):
            self.send_error(404)
            return
        with open(path) as f:
            data = f.read()
        self.respond(200, "image/svg+xml", data.encode())

    def respond(self, code: int, content_type: str, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        if getattr(self, "send_header_cors", False):
            pass  # already handled in respond()
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        print(f"  {args[0]}")


# ── Static grid loading (backwards compatible) ──

def load_grid() -> Grid:
    path = os.path.join(TILES_DIR, "grid.json")
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        tiles: list[TileData] = json.load(f)
    grid: Grid = {}
    for t in tiles:
        grid[(t["q"], t["r"])] = {
            "ka": t["ka"], "kb": t["kb"], "kc": t["kc"],
            "catalanIndex": t["catalanIndex"],
            "polarity": t.get("polarity", 0),
        }
    return grid


# ── Event polling (Anvil / any EVM RPC) ──

# keccak256("TilePlaced(uint16,uint16,address,uint8,uint8,uint8,bool,uint128)")
TILE_PLACED_TOPIC = "0x10d7d4049b99a0a5fb0160573ed3f0073f5ab1267ada5309484465543c43781d"


def decode_tile_placed(log: dict[str, Any]) -> TileData | None:
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


def save_grid(grid: Grid) -> None:
    """Write grid.json to disk."""
    os.makedirs(TILES_DIR, exist_ok=True)
    grid_list: list[TileData] = []
    for (q, r), tile in sorted(grid.items()):
        grid_list.append({"q": q, "r": r, **tile})
    with open(os.path.join(TILES_DIR, "grid.json"), "w") as f:
        json.dump(grid_list, f, indent=2)


def poll_events(nft_address: str, rpc_url: str, solver_bin: str,
                topic0: str, poll_interval: float = 2.0) -> None:
    """Background thread: poll eth_getLogs for TilePlaced events."""
    from_block = "0x0"
    print(f"[poller] Watching {nft_address} for TilePlaced events on {rpc_url}")

    while True:
        try:
            resp = rpc_call(rpc_url, "eth_getLogs", [{
                "address": nft_address,
                "topics": [topic0],
                "fromBlock": from_block,
                "toBlock": "latest",
            }])
            logs: list[dict[str, Any]] = resp.get("result", [])

            for log in logs:
                tile = decode_tile_placed(log)
                if tile is None:
                    continue

                q, r = tile["q"], tile["r"]
                with grid_lock:
                    if (q, r) in Handler.grid:
                        continue  # already processed

                ka, kb, kc = tile["ka"], tile["kb"], tile["kc"]
                idx = tile["catalanIndex"]
                pol = tile["polarity"]

                print(f"[poller] TilePlaced ({q}, {r}) family=({ka},{kb},{kc}) idx={idx} pol={pol}")

                try:
                    svg, metadata = solve_tile(q, r, ka, kb, kc, idx, pol, solver_bin)
                except Exception as e:
                    print(f"[poller] Solver error for ({q},{r}): {e}")
                    continue

                os.makedirs(TILES_DIR, exist_ok=True)
                svg_path = os.path.join(TILES_DIR, f"{q}-{r}.svg")
                with open(svg_path, "w") as f:
                    f.write(svg)
                json_path = os.path.join(TILES_DIR, f"{q}-{r}.json")
                with open(json_path, "w") as f:
                    json.dump(metadata, f, indent=2)

                with grid_lock:
                    Handler.grid[(q, r)] = {
                        "ka": ka, "kb": kb, "kc": kc,
                        "catalanIndex": idx, "polarity": pol,
                    }
                    save_grid(Handler.grid)

            # Advance from_block past what we've seen
            if logs:
                last_block = max(int(log["blockNumber"], 16) for log in logs)
                from_block = hex(last_block + 1)

        except Exception as e:
            print(f"[poller] Error: {e}")

        time.sleep(poll_interval)


def main() -> None:
    parser = argparse.ArgumentParser(description="Truchet tile dev server")
    parser.add_argument("--nft-address", default=os.environ.get("NFT_ADDRESS", ""),
                        help="TruchetNFT contract address (enables event polling)")
    parser.add_argument("--rpc-url", default=os.environ.get("ANVIL_RPC", "http://127.0.0.1:8545"),
                        help="Ethereum JSON-RPC URL")
    parser.add_argument("--solver-bin", default="",
                        help="Path to solver binary")
    parser.add_argument("--port", type=int, default=PORT, help="HTTP port")
    args = parser.parse_args()

    # Load existing grid
    grid = load_grid()
    Handler.grid = grid
    print(f"Loaded {len(grid)} existing tiles")

    # Start event polling if NFT address is provided
    if args.nft_address:
        solver_bin = args.solver_bin or os.path.join(
            os.path.dirname(__file__), "..", "solver", "c", "truchet"
        )

        t = threading.Thread(
            target=poll_events,
            args=(args.nft_address, args.rpc_url, solver_bin, TILE_PLACED_TOPIC),
            daemon=True,
        )
        t.start()
    else:
        print("No --nft-address provided, running in static mode")

    print(f"Serving on http://localhost:{args.port}")
    HTTPServer(("", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
