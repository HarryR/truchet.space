"""
Shared tile solver — pure function, no I/O destination baked in.

Used by:
  - backend/server.py (local dev: write to disk)
  - future Modal handler (prod: upload to R2)
"""

from __future__ import annotations

import os
import subprocess
from typing import Any

DEFAULT_SOLVER_BIN = os.path.join(os.path.dirname(__file__), "..", "solver", "c", "truchet")

Metadata = dict[str, Any]


def solve_tile(q: int, r: int, ka: int, kb: int, kc: int,
               idx: int, polarity: int,
               solver_bin: str = DEFAULT_SOLVER_BIN) -> tuple[str, Metadata]:
    """Run solver, return (svg_string, metadata_dict).

    The caller decides what to do with the results (write to disk, upload to R2, etc.).
    """
    cmd = [
        solver_bin,
        "shape=hex",
        f"eps={ka},{kb},{kc}",
        f"idx={idx}",
        f"polarity={polarity}",
        "w=1", "h=1",
        "svg=-",
        "-q",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"Solver failed for ({q},{r}) family=({ka},{kb},{kc}) idx={idx}: "
            f"{result.stderr.strip()}"
        )

    svg = result.stdout
    total_eps = 2 * (ka + kb + kc)
    metadata: Metadata = {
        "name": f"Truchet Tile ({q}, {r})",
        "description": (
            f"A hexagonal Truchet tile at grid position ({q}, {r}) "
            f"with family ({ka}, {kb}, {kc}) and Catalan index {idx}."
        ),
        "image": f"https://tiles.truchet.space/{q}-{r}.svg",
        "external_url": f"https://truchet.space/#tile={q},{r}",
        "attributes": [
            {"trait_type": "Column (q)", "display_type": "number", "value": q},
            {"trait_type": "Row (r)", "display_type": "number", "value": r},
            {"trait_type": "Family", "value": f"{ka}-{kb}-{kc}"},
            {"trait_type": "Catalan Index", "value": str(idx)},
            {"trait_type": "Edge Points", "display_type": "number", "value": total_eps},
            {"trait_type": "Polarity", "value": "+" if polarity else "-"},
        ],
    }

    return svg, metadata
