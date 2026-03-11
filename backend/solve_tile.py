#!/usr/bin/env python3
"""
Solve a single Truchet tile and produce NFT metadata JSON + SVG.

Usage:
    python -m backend.solve_tile --q 5 --r 12 --ka 3 --kb 2 --kc 1 --idx 25 --out-dir out/

Outputs:
    out/5-12.json   — ERC-721 metadata
    out/5-12.svg    — tile SVG
"""

from __future__ import annotations

import argparse
import json
import os

from .solver import solve_tile


def main() -> None:
    parser = argparse.ArgumentParser(description="Solve a Truchet tile and build NFT metadata")
    parser.add_argument("--q", type=int, required=True, help="Grid column")
    parser.add_argument("--r", type=int, required=True, help="Grid row")
    parser.add_argument("--ka", type=int, required=True)
    parser.add_argument("--kb", type=int, required=True)
    parser.add_argument("--kc", type=int, required=True)
    parser.add_argument("--idx", type=int, required=True, help="Catalan index")
    parser.add_argument("--polarity", type=int, default=1, help="Polarity (0 or 1)")
    parser.add_argument("--out-dir", default="out", help="Output directory")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    svg, metadata = solve_tile(args.q, args.r, args.ka, args.kb, args.kc,
                               args.idx, args.polarity)

    stem = f"{args.q}-{args.r}"
    svg_path = os.path.join(args.out_dir, f"{stem}.svg")
    json_path = os.path.join(args.out_dir, f"{stem}.json")

    with open(svg_path, "w") as f:
        f.write(svg)
    with open(json_path, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"  SVG: {svg_path}")
    print(f" JSON: {json_path}")


if __name__ == "__main__":
    main()
