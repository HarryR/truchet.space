# Truchet.Space

## Build & Test

- Package manager: **pnpm** (not npm)
- Frontend: `cd frontend && pnpm install && pnpm build`
- Solidity toolchain (forge) is at `contracts/bin/forge`
- There's a `Makefile` in `contracts/` for common tasks
- Run tests: `cd contracts && ./bin/forge test`
- C solver: `cd solver/c && make` (builds `truchet` and `truchet.opt`)

## Tile Geometry & Polarity

Truchet tiles on a hex grid. Each tile has a family (ka, kb, kc) giving the
number of arc endpoints (EPs) on each of the three edge-pair axes (edges 0&3,
1&4, 2&5). The total EPs = 2*(ka+kb+kc); arcs pair these endpoints via a
non-crossing matching (Catalan index).

**Arcs are boundaries, not colored.** They partition the hexagon into regions
(slices). Adjacent regions within a tile always have opposite colors — like a
topographic map alternating by nesting depth. **Polarity** sets which color the
outermost region gets; flipping polarity swaps all region colors.

**Cross-tile constraint:** on a shared edge, each segment between consecutive
endpoints belongs to a region on each tile. Those two regions must have the
**same** color. This is what determines the required polarity relationship
between adjacent tiles.
