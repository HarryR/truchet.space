#!/usr/bin/env bash
set -euo pipefail
trap 'kill $(jobs -p) 2>/dev/null' EXIT

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Truchet.Space Local Dev Stack ==="

# 0. Clean stale tiles (we want only on-chain seeded tiles)
rm -f backend/tiles/*.json backend/tiles/*.svg

# 1. Build solver
echo "[1/8] Building solver..."
(cd solver/c && make -q 2>/dev/null || make)

# 2. Ensure Foundry is downloaded
echo "[2/8] Ensuring Foundry toolchain..."
(cd contracts && make)

# 3. Start Anvil
echo "[3/8] Starting Anvil..."
contracts/bin/anvil --silent &
ANVIL_PID=$!
sleep 1

if ! kill -0 $ANVIL_PID 2>/dev/null; then
    echo "ERROR: Anvil failed to start"
    exit 1
fi
echo "  Anvil running on :8545 (PID $ANVIL_PID)"

# 4. Deploy contracts
echo "[4/8] Deploying contracts..."
(cd contracts && bin/forge script script/Deploy.s.sol \
    --rpc-url http://127.0.0.1:8545 --broadcast \
    --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)

# 5. Extract addresses
echo "[5/8] Extracting contract addresses..."
python3 scripts/extract-addresses.py

# 6. Start backend (event watcher will catch seed events)
echo "[6/8] Starting backend server..."
# shellcheck disable=SC1091
source backend/.env
python3 -m backend.server \
    --nft-address "$NFT_ADDRESS" \
    --rpc-url "$ANVIL_RPC" &
BACKEND_PID=$!
sleep 1

if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "ERROR: Backend server failed to start"
    exit 1
fi
echo "  Backend running on :8100 (PID $BACKEND_PID)"

# 7. Seed initial tiles
echo "[7/8] Seeding tiles on Anvil..."
python3 -m backend.seed_anvil

# 8. Start Vite frontend (foreground — Ctrl+C kills all)
echo "[8/8] Starting frontend (Ctrl+C to stop all)..."
echo ""
echo "  Frontend: http://localhost:5173"
echo "  Backend:  http://localhost:8100"
echo "  Anvil:    http://localhost:8545"
echo ""
cd frontend && pnpm dev
