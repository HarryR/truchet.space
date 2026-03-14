"""
Shared on-chain utilities — RPC calls and event decoding.

No external dependencies (stdlib only).
"""
from __future__ import annotations

import json
import urllib.request
from typing import Any

# keccak256("TilePlaced(uint16,uint16,address,uint8,uint8,uint8,bool,uint128)")
TILE_PLACED_TOPIC = "0x10d7d4049b99a0a5fb0160573ed3f0073f5ab1267ada5309484465543c43781d"


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
