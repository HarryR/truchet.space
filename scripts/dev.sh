#!/usr/bin/env bash
set -euo pipefail
trap 'kill $(jobs -p) 2>/dev/null' EXIT

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Truchet.Space Local Dev Stack ==="

# 0. Clean stale tiles (we want only on-chain seeded tiles)
rm -rf backend/tiles/

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

# 4. Deploy contracts + seed tiles (random deployer to bust MetaMask eth_call cache)
echo "[4/8] Deploying contracts + seeding tiles..."
DEPLOYER_KEY=$(openssl rand -hex 32)
DEPLOYER_ADDR=$(contracts/bin/cast wallet address "0x$DEPLOYER_KEY")
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
contracts/bin/cast send "$DEPLOYER_ADDR" --value 10ether \
    --private-key "$ANVIL_KEY" --rpc-url http://127.0.0.1:8545 > /dev/null
echo "  Deployer: $DEPLOYER_ADDR"
(cd contracts && bin/forge script script/Deploy.s.sol \
    --rpc-url http://127.0.0.1:8545 --broadcast \
    --private-key "0x$DEPLOYER_KEY")

# 5. Extract addresses (writes backend/.env + frontend/.env.local)
echo "[5/8] Extracting contract addresses..."
python3 scripts/extract-addresses.py

# Load extracted addresses for follower args
# shellcheck disable=SC1091
source backend/.env
# shellcheck disable=SC1091
source frontend/.env.local

# Mint MockUSDC to Anvil's default test accounts
if [ -n "$VITE_USDC_ADDRESS" ]; then
    echo "  Minting MockUSDC to Anvil test accounts..."
    MINT_SIG="mint(address,uint256)"
    MINT_AMOUNT="1000000000000"  # 1M USDC (6 decimals)
    for i in 0 1 2 3 4 5 6 7 8 9; do
        ACCT=$(contracts/bin/cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index "$i")
        contracts/bin/cast send "$VITE_USDC_ADDRESS" "$MINT_SIG" "$ACCT" "$MINT_AMOUNT" \
            --private-key "0x$DEPLOYER_KEY" --rpc-url http://127.0.0.1:8545 > /dev/null
    done
    echo "  Minted 1M USDC to 10 Anvil accounts"
fi

# 6. Start webhook handler (processes TilePlaced → solver → tiles/)
echo "[6/8] Starting webhook handler..."
python3 -m backend.webhook_handler --port 8200 &
WEBHOOK_PID=$!
sleep 1

if ! kill -0 $WEBHOOK_PID 2>/dev/null; then
    echo "ERROR: Webhook handler failed to start"
    exit 1
fi
echo "  Webhook handler on :8200 (PID $WEBHOOK_PID)"

# 7. Start static tile server (serves tiles from disk)
echo "[7/8] Starting static tile server..."
python3 -m backend.server &
BACKEND_PID=$!
sleep 1

if ! kill -0 $BACKEND_PID 2>/dev/null; then
    echo "ERROR: Static tile server failed to start"
    exit 1
fi
echo "  Static tile server on :8100 (PID $BACKEND_PID)"

# 8. Switch to 12s blocks, start follower + frontend
echo "[8/8] Starting Anvil follower & frontend (Ctrl+C to stop all)..."
contracts/bin/cast rpc evm_setIntervalMining 12 --rpc-url http://127.0.0.1:8545 > /dev/null
echo "  Block time: 12s"
python3 -m backend.anvil_follower \
    --webhook-url http://localhost:8200/webhook \
    --rpc-url "$ANVIL_RPC" \
    --nft-address "$NFT_ADDRESS" &
FOLLOWER_PID=$!
echo "  Follower watching Anvil (PID $FOLLOWER_PID)"
echo ""
echo "  Frontend:  http://localhost:5173"
echo "  Tile CDN:  http://localhost:8100"
echo "  Webhook:   http://localhost:8200/webhook"
echo "  Anvil:     http://localhost:8545"
echo ""
# Toggle between dev (HMR, unminified) and preview (production build):
cd frontend
#pnpm dev
pnpm build && pnpm preview
