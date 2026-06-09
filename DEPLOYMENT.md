# Deployment & Operations

## Prerequisites

- Foundry toolchain: `cd contracts && make` (downloads locally)
- pnpm: `npm install -g pnpm` (or via corepack)
- A funded deployer wallet (ETH for gas + contract deployment)
- RPC endpoints for target chain

## Contract Addresses

| Contract | Staging (Sepolia) | Production (Mainnet) |
|----------|-------------------|----------------------|
| TruchetNFT | TBD | TBD |
| TruchetGate | TBD | TBD |
| USDC | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |

## Staging (Sepolia)

### Deploy Contracts

```sh
cd contracts

# Set deployer private key
export DEPLOYER_KEY=0x...

# Sepolia USDC (Circle's official testnet USDC)
export USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238

# Optional: override default prices
export PRICE_ETH=0.001ether   # default: 0.005 ether
export PRICE_USDC=1000000     # default: 5000000 (5 USDC, 6 decimals)

bin/forge script script/Deploy.s.sol \
    --rpc-url https://rpc.sepolia.org \
    --broadcast \
    --private-key "$DEPLOYER_KEY"
```

Note the deployed addresses from the broadcast output and update the table above.

### Deploy Frontend (Staging)

Push to `main` branch — the GitHub Actions workflow deploys to `/staging/` on GitHub Pages using the `Staging` environment variables.

Environment variables to set in GitHub repo settings (Settings > Environments > Staging):

| Variable | Value |
|----------|-------|
| `VITE_CHAIN_ID` | `11155111` |
| `VITE_RPC_URL` | Sepolia RPC URL(s), comma-separated |
| `VITE_NFT_ADDRESS` | Deployed TruchetNFT address |
| `VITE_GATE_ADDRESS` | Deployed TruchetGate address |
| `VITE_USDC_ADDRESS` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| `VITE_BLOCK_EXPLORER` | `https://sepolia.etherscan.io` |
| `VITE_TILE_CDN` | Staging tile CDN URL |

## Production (Ethereum Mainnet)

### Deploy Contracts

```sh
cd contracts

export DEPLOYER_KEY=0x...

# Production prices
export PRICE_ETH=5000000000000000    # 0.005 ETH in wei
export PRICE_USDC=5000000            # 5 USDC (6 decimals)

bin/forge script script/Deploy.s.sol \
    --rpc-url https://eth.llamarpc.com \
    --broadcast \
    --private-key "$DEPLOYER_KEY" \
    --verify \
    --etherscan-api-key "$ETHERSCAN_API_KEY"
```

The `--verify` flag submits source code to Etherscan for verification automatically.

### Deploy Frontend (Production)

Push a version tag:

```sh
git tag v1.0.0
git push origin v1.0.0
```

The GitHub Actions workflow deploys to the root `/` of GitHub Pages using the `Production` environment variables.

Environment variables to set in GitHub repo settings (Settings > Environments > Production):

| Variable | Value |
|----------|-------|
| `VITE_CHAIN_ID` | `1` |
| `VITE_RPC_URL` | Mainnet RPC URL(s), comma-separated |
| `VITE_NFT_ADDRESS` | Deployed TruchetNFT address |
| `VITE_GATE_ADDRESS` | Deployed TruchetGate address |
| `VITE_USDC_ADDRESS` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| `VITE_BLOCK_EXPLORER` | `https://etherscan.io` |
| `VITE_TILE_CDN` | `https://tiles.truchet.space` |

## Operations

### Changing Prices

Prices are set atomically via `setPrices(uint256 priceETH_, uint256 priceUSDC_)` on the TruchetGate contract. Only the contract owner can call this.

```sh
# Example: set ETH price to 0.01 ETH, USDC price to 10 USDC
cast send <GATE_ADDRESS> \
    "setPrices(uint256,uint256)" \
    10000000000000000 10000000 \
    --private-key "$OWNER_KEY" \
    --rpc-url <RPC_URL>
```

Price reference (6 decimal USDC, 18 decimal ETH):
| ETH Price | Wei Value |
|-----------|-----------|
| 0.001 ETH | `1000000000000000` |
| 0.005 ETH | `5000000000000000` |
| 0.01 ETH  | `10000000000000000` |

| USDC Price | Raw Value |
|------------|-----------|
| 1 USDC | `1000000` |
| 5 USDC | `5000000` |
| 10 USDC | `10000000` |

The frontend polls prices from the contract, so changes take effect within ~12 seconds (one block).

### Withdrawing Funds

```sh
cast send <GATE_ADDRESS> "withdraw()" \
    --private-key "$OWNER_KEY" \
    --rpc-url <RPC_URL>
```

Sweeps all collected ETH and USDC to the owner address.

### Transferring Ownership

```sh
# Transfer TruchetGate ownership
cast send <GATE_ADDRESS> \
    "setOwner(address)" <NEW_OWNER> \
    --private-key "$OWNER_KEY" \
    --rpc-url <RPC_URL>

# Transfer TruchetNFT ownership (separate)
cast send <NFT_ADDRESS> \
    "setOwner(address)" <NEW_OWNER> \
    --private-key "$OWNER_KEY" \
    --rpc-url <RPC_URL>
```

### Seeding Tiles

Initial tiles are seeded during deployment via `Deploy.s.sol`. To seed additional tiles post-deployment, use the NFT contract's `seedTiles` function (owner-only). This bypasses adjacency checks and the gate.

## Local Development

```sh
./scripts/dev.sh
```

This starts Anvil, deploys contracts (including MockUSDC), seeds tiles, starts the backend services, and launches the frontend. All 10 default Anvil accounts are funded with 1M MockUSDC.
