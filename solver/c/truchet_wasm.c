/*
 * truchet_wasm.c — the hexagon tile solver as a single exported function.
 *
 * Built by `make wasm` into truchet_svg.wasm: a wasm32 module with no
 * imports (no WASI, no threads, no host callbacks). Usage from the host:
 *
 *   instance.exports._initialize();                     // once
 *   const r = instance.exports.truchet_svg(ka, kb, kc, polarity, idxLo, idxHi);
 *   // r == 0: no tile (invalid input, or the solver found no solution)
 *   // otherwise r points at { u32 svg_ptr; u32 svg_len; } in linear memory
 *
 * The Catalan index is 128 bits, passed as two u64 halves (BigInt in JS).
 * The SVG is byte-identical to `truchet shape=hex eps=ka,kb,kc idx=N
 * polarity=P w=1 h=1 svg=-`. The returned buffer belongs to the module and
 * stays valid until the next call; the function is otherwise stateless, so
 * the same inputs always produce the same bytes.
 */

#define TRUCHET_NO_MAIN
#define TRUCHET_NO_DIAG
#include "truchet.c"

typedef struct {
    const char *svg;   /* UTF-8, not NUL-terminated */
    uint32_t    len;   /* bytes */
} TruchetResult;

static TruchetResult g_result;
static char  *g_buf;
static size_t g_buf_len;

__attribute__((export_name("truchet_svg")))
const TruchetResult *truchet_svg(uint32_t ka, uint32_t kb, uint32_t kc,
                                 uint32_t polarity,
                                 uint64_t idx_lo, uint64_t idx_hi)
{
    free(g_buf);
    g_buf = NULL;
    g_buf_len = 0;

    if (ka > MAX_ARCS || kb > MAX_ARCS || kc > MAX_ARCS) return NULL;
    int n_arcs = (int)(ka + kb + kc);
    if (n_arcs < 1 || n_arcs > MAX_ARCS) return NULL;

    __uint128_t idx = ((__uint128_t)idx_hi << 64) | idx_lo;
    if (idx >= catalan(n_arcs)) return NULL;

    init_shapes();
    g_quiet = 1;

    TileDesc desc;
    hexagon_grid(1, 1, (int)ka, (int)kb, (int)kc, 80.0, &desc, 0, 0);
    desc.polarity = (polarity != 0);

    SolvedTile solved;
    if (!solve_one_tile(&desc, NULL, &solved, true, idx)) return NULL;

    /* Same metadata the CLI writes */
    int eps[3] = { (int)ka, (int)kb, (int)kc };
    int total_eps = 2 * n_arcs;
    int n_levels, res, stroke;
    auto_tune(n_arcs, 1.0, &n_levels, &res, &stroke);
    if (g_levels_min > n_levels) n_levels = g_levels_min;
    if (n_levels > MAX_LEVELS - 1) n_levels = MAX_LEVELS - 1;

    FILE *f = open_memstream(&g_buf, &g_buf_len);
    if (!f) return NULL;
    emit_svg(f, &desc, &solved, 1, 80.0, 4.0, "#2c3e50", "#ecf0f1",
             false, false, 1, 1, "hexagon", eps, 3, total_eps, n_levels, NULL);
    if (fclose(f) != 0 || !g_buf) return NULL;

    g_result.svg = g_buf;
    g_result.len = (uint32_t)g_buf_len;
    return &g_result;
}
