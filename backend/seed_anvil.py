"""
Seed ~20 initial tiles on Anvil by calling seedTiles() (batch) via `cast send`.

Uses the Anvil deployer key (account 0):
  Private key: 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
  Address:     0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

The backend event watcher picks up each mint and generates SVGs automatically.
"""

from __future__ import annotations

import os
import subprocess
import sys

from .seed import generate_cluster

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAST_BIN = os.path.join(ROOT, "contracts", "bin", "cast")
DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
RPC_URL = os.environ.get("ANVIL_RPC", "http://127.0.0.1:8545")


def seed_tiles_batch(nft_address: str, to: str,
                     tiles: list[tuple[int, int, int, int, int, bool, int]]) -> bool:
    """Call seedTiles(address,uint16[],uint16[],uint8[],uint8[],uint8[],bool[],uint128[]) via cast."""
    sig = "seedTiles(address,uint16[],uint16[],uint8[],uint8[],uint8[],bool[],uint128[])"

    qs = "[" + ",".join(str(t[0]) for t in tiles) + "]"
    rs = "[" + ",".join(str(t[1]) for t in tiles) + "]"
    kas = "[" + ",".join(str(t[2]) for t in tiles) + "]"
    kbs = "[" + ",".join(str(t[3]) for t in tiles) + "]"
    kcs = "[" + ",".join(str(t[4]) for t in tiles) + "]"
    pols = "[" + ",".join(str(t[5]).lower() for t in tiles) + "]"
    idxs = "[" + ",".join(str(t[6]) for t in tiles) + "]"

    cmd = [
        CAST_BIN, "send",
        nft_address,
        sig,
        to, qs, rs, kas, kbs, kcs, pols, idxs,
        "--rpc-url", RPC_URL,
        "--private-key", DEPLOYER_KEY,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  FAILED: {result.stderr.strip()}")
        return False
    return True


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

    n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    print(f"Generating {n}-tile cluster and seeding on Anvil...")
    print(f"NFT address: {nft_address}")

    grid, polarity = generate_cluster(n_tiles=n, max_attempts=500)
    print(f"Generated {len(grid)} valid tiles")

    # Build ordered tile list (BFS order preserved by sorted — origin first)
    tiles: list[tuple[int, int, int, int, int, bool, int]] = []
    for (q, r), tile in sorted(grid.items()):
        pol = polarity[(q, r)]
        ka, kb, kc = tile["ka"], tile["kb"], tile["kc"]
        idx = tile["catalanIndex"]
        print(f"  ({q}, {r}) ka={ka} kb={kb} kc={kc} idx={idx} pol={int(pol)}")
        tiles.append((q, r, ka, kb, kc, pol, idx))

    print(f"\nSending batch seedTiles() for {len(tiles)} tiles...")
    if seed_tiles_batch(nft_address, DEPLOYER_ADDR, tiles):
        print(f"Seeded {len(tiles)} tiles on Anvil")
    else:
        print("Batch seed failed")
        sys.exit(1)


if __name__ == "__main__":
    main()
