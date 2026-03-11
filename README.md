# Truchet.Space

Generative Collaborative Math & Art Exploration

## Overview

Truchet.space is a collaborative generative art project built on a hexagonal grid. Participants place Truchet tiles — hexagons filled with non-crossing Bézier curves — onto a shared infinite grid. Each placed tile is minted as an NFT. The curves within each tile are solved off-chain to avoid collisions, and the resulting artwork emerges from the collective decisions of all participants.

## How It Works

### Hexagonal Grid

The world is an infinite hexagonal grid (even-q offset layout). Each hex cell can hold one tile. Tiles can only be placed adjacent to an existing tile — they must share at least one face with an already-placed hex.

The grid is seeded with initial tiles placed by the project owner. From there, participants expand the grid outward by placing tiles in the available frontier cells.

### Tile Families

A tile's **family** is defined by its edge point (EP) configuration: the number of connection points on each edge. Hexagons have 6 edges with a repeating pattern `[ka, kb, kc, ka, kb, kc]`, so a family is fully described by the triple `(ka, kb, kc)`.

When placing a tile, edges shared with existing neighbors are **constrained** — the EP count must match the neighbor's facing edge. The remaining free edges are chosen by the user. The mirroring rule (`[ka, kb, kc, ka, kb, kc]`) means that constraining one edge also constrains its opposite edge. This can make some cells unplaceable if neighbor constraints conflict with the mirroring symmetry.

### Catalan Index

Within each family, tiles are distinguished by their **Catalan index** — an integer that identifies a specific non-crossing perfect matching of the edge points. The number of valid matchings for a family with `n` total EPs is `Catalan(n/2)`.

- Each Catalan index can only be used **once per family** — no duplicates
- The user supplies their desired Catalan index when minting
- The index must be valid (less than `Catalan(total_eps/2)`)

### Placing a Tile (Minting)

1. User picks an empty hex cell adjacent to at least one existing tile
2. Contract determines which edges are constrained by neighbors
3. User specifies EP counts for the free edges (must satisfy the mirroring rule)
4. User specifies a Catalan index (must be unique within the resulting family)
5. Contract validates all constraints and mints the NFT

### Curve Solving (Off-chain)

After a tile is minted, the solver runs off-chain to find non-overlapping Bézier curves for the tile's matching. The solver output — cubic Bézier control points for each arc — becomes the NFT's metadata. This is the visual content of the tile.

See `solver/bitmap-collision-solver.md` for solver internals and `solver/TILE_RECOVERY.md` for the tile data format.

## Project Structure

```
├── contracts/           Forge/Solidity project
│   ├── src/
│   │   ├── TruchetNFT.sol   ERC-721 + hex grid registry
│   │   └── TruchetGate.sol  Payment gate (ETH + USDC)
│   ├── test/            Solidity tests (47 tests)
│   ├── script/          Deployment scripts
│   └── Makefile         Build, test, deploy (local Foundry install)
│
├── frontend/            TypeScript + Canvas browser UI (Vite)
│   └── src/
│       ├── main.ts      Canvas rendering, camera, interaction
│       ├── grid.ts      Tile index + lazy SVG loading (LRU cache)
│       ├── hex.ts       Even-q hex grid math
│       ├── wallet.ts    EIP-1193/EIP-6963 wallet integration
│       ├── contracts.ts ABI encoding + placeTile transaction
│       ├── abi.ts       Minimal ABI encode/decode (no dependencies)
│       ├── menu.ts      Wallet dialog + multi-provider selector
│       └── config.ts    Environment configuration
│
├── backend/             Python tile server + generation
│   ├── server.py        HTTP server (/grid, /tile endpoints) + event polling
│   ├── solver.py        Shared solve function (dev + prod)
│   ├── seed.py          Generate tile clusters (offline)
│   ├── seed_anvil.py    Seed tiles on Anvil via cast
│   └── solve_tile.py    Single-tile solver CLI
│
├── solver/              Tile curve solver
│   ├── c/               C port (OpenMP, no dependencies)
│   ├── python/          Reference implementation
│   ├── bitmap-collision-solver.md
│   └── TILE_RECOVERY.md
│
├── scripts/
│   ├── dev.sh           Full local dev stack orchestration
│   └── extract-addresses.py  Parse Foundry broadcast → .env files
│
└── README.md
```

## Contracts

The NFT contract (`TruchetNFT.sol`) is the authoritative registry for the hex grid. It enforces:

- **Adjacency**: tiles must neighbor at least one existing tile
- **EP constraints**: shared edges must have matching EP counts
- **Mirroring**: hex edge pattern `[ka, kb, kc, ka, kb, kc]` is preserved
- **Uniqueness**: no two tiles in the same family share a Catalan index
- **Polarity**: derived from neighbors, prevents dead cells via lookahead
- **Ownership**: each tile is an ERC-721 token owned by its placer

The `TruchetGate.sol` contract handles payments (ETH or USDC via ERC-3009) and calls `placeTile` on the NFT contract.

On every tile placement, a `TilePlaced` event is emitted with all solver-relevant data (q, r, ka, kb, kc, polarity, catalanIndex) — no follow-up `getTile` call needed.

### Building

```sh
cd contracts
make test      # downloads Foundry locally, runs tests
make build     # compile only
```

No global Foundry install required. The Makefile downloads a pinned version into `contracts/bin/`.

## Local Development

A single script brings up the full local stack:

```sh
bash scripts/dev.sh
```

This:

1. Builds the C solver
2. Downloads Foundry and builds contracts
3. Starts Anvil (local Ethereum node on `:8545`)
4. Deploys TruchetNFT + TruchetGate
5. Extracts contract addresses to `.env` files
6. Starts the backend server (`:8100`) with event polling
7. Seeds ~20 tiles on Anvil (backend picks up events and generates SVGs)
8. Starts the Vite frontend (`:5173`)

The backend polls Anvil for `TilePlaced` events every 2 seconds, runs the solver, and writes SVGs to disk. The frontend fetches the grid and tile SVGs from the backend.

### Architecture

```
Frontend (Vite :5173)
  │  eth_sendTransaction → placeTileETH()
  ▼
Anvil (:8545)
  │  TilePlaced event
  ▼
Backend (server.py :8100)
  │  polls eth_getLogs every 2s
  ├─ decode TilePlaced event
  ├─ solver.solve_tile() → SVG + metadata
  ├─ write to tiles/ directory
  └─ update in-memory grid
  ▼
Frontend fetches /grid, /tile/{q}/{r}/svg
```

### Prerequisites

- Python 3.10+
- Node.js + pnpm
- C compiler (gcc/clang) with OpenMP
- `curl` (for Foundry download)

### Individual Components

```sh
# Frontend only
cd frontend && pnpm install && pnpm dev

# Backend only (static mode, no Anvil)
python3 -m backend.server

# Backend with event polling
python3 -m backend.server --nft-address 0x... --rpc-url http://127.0.0.1:8545

# Generate a 200-tile cluster offline
python3 -m backend.seed 200

# Solver
cd solver/c && make
./truchet shape=hex eps=3,2,1 idx=25 w=1 h=1 svg=output.svg
```
