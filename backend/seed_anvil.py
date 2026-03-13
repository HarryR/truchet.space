"""
Seed the initial tiles on Anvil.

Computes the optimal seed grid via find_seed, then calls seedTiles() on-chain.

Uses the Anvil deployer key (account 0):
  Private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  Address:     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

The backend event watcher picks up each mint and generates SVGs automatically.
"""

from __future__ import annotations

import os
import subprocess
import sys

from .find_seed import find_seed

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAST_BIN = os.path.join(ROOT, "contracts", "bin", "cast")
DEPLOYER_KEY = os.environ.get("DEPLOYER_KEY", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
DEPLOYER_ADDR = os.environ.get("DEPLOYER_ADDR", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266")
RPC_URL = os.environ.get("ANVIL_RPC", "http://127.0.0.1:8545")

Q0, R0 = 0, 0
WIDTH, HEIGHT = 5, 5


def main() -> None:
    nft_address = os.environ.get("NFT_ADDRESS", "")
    if not nft_address:
        env_path = os.path.join(ROOT, "backend", ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    if line.startswith("NFT_ADDRESS="):
                        nft_address = line.strip().split("=", 1)[1]
                        break

    if not nft_address:
        print("NFT_ADDRESS not set. Run extract-addresses.py first.")
        sys.exit(1)

    print(f"Computing {WIDTH}×{HEIGHT} seed at ({Q0},{R0})...")
    grid = find_seed(Q0, R0, WIDTH, HEIGHT)
    n = len(grid.tiles)

    print(f"Seeding {WIDTH}×{HEIGHT} block — {n} tiles")
    print(f"NFT address: {nft_address}")

    for i, t in enumerate(grid.tiles):
        pol = "+" if t.polarity else "-"
        print(f"  ({t.q},{t.r}) ka={t.ka} kb={t.kb} kc={t.kc} idx={t.catalan_index} pol={pol}")

    sig = "seedTiles(address,uint16,uint16,uint8,uint8,uint8[],uint8[],uint8[],uint128[],uint256)"
    cmd = [
        CAST_BIN, "send",
        nft_address,
        sig,
        DEPLOYER_ADDR,
        str(grid.q0), str(grid.r0), str(grid.width), str(grid.height),
        "[" + ",".join(str(x) for x in grid.kas) + "]",
        "[" + ",".join(str(x) for x in grid.kbs) + "]",
        "[" + ",".join(str(x) for x in grid.kcs) + "]",
        "[" + ",".join(str(x) for x in grid.catalan_indexes) + "]",
        str(grid.polarities),
        "--rpc-url", RPC_URL,
        "--private-key", DEPLOYER_KEY,
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"FAILED: {result.stderr.strip()}")
        sys.exit(1)

    print(f"Seeded {n} tiles on Anvil")


if __name__ == "__main__":
    main()
