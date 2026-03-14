#!/usr/bin/env python3
"""
Parse Foundry broadcast output and write contract addresses to .env files.

Reads: contracts/broadcast/Deploy.s.sol/31337/run-latest.json
Writes:
  - frontend/.env.local  (VITE_NFT_ADDRESS, VITE_GATE_ADDRESS, VITE_CHAIN_ID)
  - backend/.env          (NFT_ADDRESS, GATE_ADDRESS, ANVIL_RPC)
"""

import json
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(SCRIPT_DIR)
BROADCAST_PATH = os.path.join(
    ROOT, "contracts", "broadcast", "Deploy.s.sol", "31337", "run-latest.json"
)


def main():
    if not os.path.exists(BROADCAST_PATH):
        print(f"Broadcast file not found: {BROADCAST_PATH}")
        print("Run `forge script script/Deploy.s.sol --broadcast` first.")
        sys.exit(1)

    with open(BROADCAST_PATH) as f:
        data = json.load(f)

    # Extract CREATE transactions in order
    creates = []
    for tx in data.get("transactions", []):
        if tx.get("transactionType") == "CREATE":
            creates.append({
                "name": tx.get("contractName", ""),
                "address": tx.get("contractAddress", ""),
            })

    if len(creates) < 2:
        print(f"Expected at least 2 CREATE transactions, found {len(creates)}")
        for c in creates:
            print(f"  {c['name']}: {c['address']}")
        sys.exit(1)

    # Deploy.s.sol deploys TruchetNFT first, then TruchetGate
    nft_address = ""
    gate_address = ""
    for c in creates:
        if c["name"] == "TruchetNFT":
            nft_address = c["address"]
        elif c["name"] == "TruchetGate":
            gate_address = c["address"]

    if not nft_address or not gate_address:
        # Fallback: assume order (NFT first, Gate second)
        nft_address = nft_address or creates[0]["address"]
        gate_address = gate_address or creates[1]["address"]

    print(f"TruchetNFT:  {nft_address}")
    print(f"TruchetGate: {gate_address}")

    # Write frontend/.env.local
    frontend_env = os.path.join(ROOT, "frontend", ".env.local")
    with open(frontend_env, "w") as f:
        f.write(f"VITE_NFT_ADDRESS={nft_address}\n")
        f.write(f"VITE_GATE_ADDRESS={gate_address}\n")
        f.write("VITE_CHAIN_ID=31337\n")
        f.write("VITE_RPC_URL=http://127.0.0.1:8545\n")
        f.write("VITE_USDC_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48\n")
        f.write("VITE_BLOCK_EXPLORER=http://127.0.0.1:8545\n")
        f.write("VITE_TILE_CDN=http://localhost:8100\n")
    print(f"Wrote {frontend_env}")

    # Write backend/.env
    backend_env = os.path.join(ROOT, "backend", ".env")
    with open(backend_env, "w") as f:
        f.write(f"NFT_ADDRESS={nft_address}\n")
        f.write(f"GATE_ADDRESS={gate_address}\n")
        f.write("ANVIL_RPC=http://127.0.0.1:8545\n")
    print(f"Wrote {backend_env}")


if __name__ == "__main__":
    main()
