/*
 * truchet.c — Complete Truchet tile generator for regular tilings.
 *
 * Single-file C program that generates SVG Truchet patterns on
 * square, triangle, and hexagon grids.
 *
 * Compile: gcc -O2 -fopenmp -o truchet truchet.c -lm
 * Usage:   ./truchet [key=value...] [-v] [--curves] [--grid]
 *   w=COLS h=ROWS shape=square|triangle|hexagon seed=N
 *   ep=N (total EPs, random split)  eps=K,K[,K] (explicit per-edge)
 *
 * Includes tile_solver.c for the bitmap collision solver.
 */

#define TILE_SOLVER_NO_MAIN
#include "tile_solver.c"

#include <time.h>

/* ========================================================================= */
/* Shapes                                                                    */
/* ========================================================================= */

static int g_quiet = 0;

#define MAX_EDGES  MAX_POLY_SIDES
/* MAX_EPS and MAX_ARCS inherited from tile_solver.c */

typedef struct {
    int n_edges;
    Vec2 corners[MAX_EDGES];
    Vec2 normals[MAX_EDGES];
} Shape;

static Vec2 compute_inward_normal(Vec2 c0, Vec2 c1, Vec2 centroid)
{
    double dx = c1.x - c0.x, dy = c1.y - c0.y;
    double nx = -dy, ny = dx;
    double mag = hypot(nx, ny);
    if (mag < 1e-12) return (Vec2){0, 0};
    nx /= mag; ny /= mag;
    double mx = (c0.x + c1.x) / 2, my = (c0.y + c1.y) / 2;
    if (nx * (centroid.x - mx) + ny * (centroid.y - my) < 0) {
        nx = -nx; ny = -ny;
    }
    return (Vec2){nx, ny};
}

static void make_shape(Shape *s, int n, const Vec2 *corners)
{
    s->n_edges = n;
    double cx = 0, cy = 0;
    for (int i = 0; i < n; i++) {
        s->corners[i] = corners[i];
        cx += corners[i].x; cy += corners[i].y;
    }
    Vec2 centroid = {cx / n, cy / n};
    for (int i = 0; i < n; i++)
        s->normals[i] = compute_inward_normal(corners[i],
                                               corners[(i + 1) % n], centroid);
}

#define TRI_H  0.86602540378443864676  /* sqrt(3)/2 */
#define HEXH   0.86602540378443864676  /* sqrt(3)*0.5 */

static Shape SHAPE_SQUARE, SHAPE_TRI_UP, SHAPE_TRI_DOWN, SHAPE_HEXAGON;

static void init_shapes(void)
{
    Vec2 sq[] = {{0,0},{1,0},{1,1},{0,1}};
    make_shape(&SHAPE_SQUARE, 4, sq);

    Vec2 tu[] = {{0, TRI_H}, {1, TRI_H}, {0.5, 0}};
    make_shape(&SHAPE_TRI_UP, 3, tu);

    Vec2 td[] = {{1, 0}, {0, 0}, {0.5, TRI_H}};
    make_shape(&SHAPE_TRI_DOWN, 3, td);

    double hr = 0.5, hh = HEXH, hcx = 0.5, hcy = hh / 2;
    Vec2 hx[] = {
        {hcx + hr,       hcy},
        {hcx + hr / 2,   hcy + hh / 2},
        {hcx - hr / 2,   hcy + hh / 2},
        {hcx - hr,       hcy},
        {hcx - hr / 2,   hcy - hh / 2},
        {hcx + hr / 2,   hcy - hh / 2},
    };
    make_shape(&SHAPE_HEXAGON, 6, hx);
}

/* ========================================================================= */
/* EP placement                                                              */
/* ========================================================================= */

static int ep_positions(const Shape *s, const int *edge_eps,
                        Vec2 *out_pos, int *out_edge)
{
    int total = 0;
    for (int ei = 0; ei < s->n_edges; ei++) {
        int k = edge_eps[ei];
        Vec2 c0 = s->corners[ei];
        Vec2 c1 = s->corners[(ei + 1) % s->n_edges];
        for (int j = 0; j < k; j++) {
            double t = (double)(j + 1) / (k + 1);
            out_pos[total] = vec2_lerp(c0, c1, t);
            out_edge[total] = ei;
            total++;
        }
    }
    return total;
}

static int ep_to_full_index(int ep_idx, const int *edge_eps, int n_edges)
{
    int cumul = 0;
    for (int ei = 0; ei < n_edges; ei++) {
        int k = edge_eps[ei];
        if (ep_idx < cumul + k) {
            int pos = ep_idx - cumul;
            int fi = 0;
            for (int e = 0; e < ei; e++) fi += 1 + edge_eps[e];
            return fi + 1 + pos;
        }
        cumul += k;
    }
    return 0;
}

/* Build full perimeter: corners interleaved with EPs */
static int make_perimeter(const Shape *s, const int *edge_eps, Vec2 *out)
{
    int count = 0;
    for (int ei = 0; ei < s->n_edges; ei++) {
        out[count++] = s->corners[ei];
        int k = edge_eps[ei];
        Vec2 c0 = s->corners[ei];
        Vec2 c1 = s->corners[(ei + 1) % s->n_edges];
        for (int j = 0; j < k; j++) {
            double t = (double)(j + 1) / (k + 1);
            out[count++] = vec2_lerp(c0, c1, t);
        }
    }
    return count;
}

/* ========================================================================= */
/* Random number generator (xorshift64)                                      */
/* ========================================================================= */

typedef struct { uint64_t s; } Rng;

static uint64_t rng_next(Rng *r)
{
    uint64_t x = r->s;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    r->s = x;
    return x;
}

static double rng_double(Rng *r)
{
    return (rng_next(r) >> 11) * (1.0 / 9007199254740992.0);
}

static int rng_weighted(Rng *r, const __uint128_t *weights, int n)
{
    __uint128_t total = 0;
    for (int i = 0; i < n; i++) total += weights[i];
    double rv = rng_double(r) * (double)total;
    double cumul = 0;
    for (int i = 0; i < n; i++) {
        cumul += (double)weights[i];
        if (rv < cumul) return i;
    }
    return n - 1;
}

/* ========================================================================= */
/* Catalan numbers and non-crossing matching                                 */
/* ========================================================================= */

static __uint128_t catalan(int n)
{
    if (n <= 0) return 1;
    __uint128_t c = 1;
    for (int i = 0; i < n; i++)
        c = c * 2 * (2 * i + 1) / (i + 2);
    return c;
}

static void uint128_to_str(char *buf, __uint128_t v)
{
    if (v == 0) { buf[0] = '0'; buf[1] = '\0'; return; }
    char tmp[40];
    int i = 0;
    while (v > 0) { tmp[i++] = '0' + (int)(v % 10); v /= 10; }
    for (int j = 0; j < i; j++) buf[j] = tmp[i - 1 - j];
    buf[i] = '\0';
}

/* Recursive NCM sampling into pre-allocated output */
static int ncm_sample(const int *pts, int n, Rng *rng,
                       int (*out)[2], int out_idx)
{
    if (n == 0) return out_idx;
    int first = pts[0];

    /* Collect choices with weights */
    int n_choices = 0;
    int choice_k[MAX_EPS];
    __uint128_t choice_w[MAX_EPS];
    for (int k = 1; k < n; k += 2) {
        int n_inside = (k - 1) / 2;
        int n_outside = (n - k - 1) / 2;
        choice_k[n_choices] = k;
        choice_w[n_choices] = catalan(n_inside) * catalan(n_outside);
        n_choices++;
    }

    int ci = rng_weighted(rng, choice_w, n_choices);
    int chosen_k = choice_k[ci];

    out[out_idx][0] = first;
    out[out_idx][1] = pts[chosen_k];
    out_idx++;

    /* Inside: pts[1..chosen_k-1] */
    out_idx = ncm_sample(pts + 1, chosen_k - 1, rng, out, out_idx);
    /* Outside: pts[chosen_k+1..n-1] */
    out_idx = ncm_sample(pts + chosen_k + 1, n - chosen_k - 1, rng, out, out_idx);

    return out_idx;
}

static int random_ncm(int n_points, Rng *rng, int (*out)[2])
{
    int pts[MAX_EPS];
    for (int i = 0; i < n_points; i++) pts[i] = i;
    return ncm_sample(pts, n_points, rng, out, 0);
}

/* Unrank: given a Catalan index, reconstruct the non-crossing matching */
static int unrank_ncm_rec(const int *pts, int n, __uint128_t rank,
                           int (*out)[2], int out_idx)
{
    if (n == 0) return out_idx;
    int first = pts[0];

    for (int k = 1; k < n; k += 2) {
        int n_inside = (k - 1) / 2;
        int n_outside = (n - k - 1) / 2;
        __uint128_t w = catalan(n_inside) * catalan(n_outside);
        if (rank < w) {
            out[out_idx][0] = first;
            out[out_idx][1] = pts[k];
            out_idx++;

            /* Decompose rank into inside and outside sub-ranks */
            __uint128_t c_outside = catalan(n_outside);
            __uint128_t rank_inside = rank / c_outside;
            __uint128_t rank_outside = rank % c_outside;

            out_idx = unrank_ncm_rec(pts + 1, k - 1, rank_inside, out, out_idx);
            out_idx = unrank_ncm_rec(pts + k + 1, n - k - 1, rank_outside, out, out_idx);
            return out_idx;
        }
        rank -= w;
    }
    /* Should never reach here if rank < C(n/2) */
    return out_idx;
}

static int unrank_ncm(int n_points, __uint128_t rank, int (*out)[2])
{
    int pts[MAX_EPS];
    for (int i = 0; i < n_points; i++) pts[i] = i;
    return unrank_ncm_rec(pts, n_points, rank, out, 0);
}

static __uint128_t str_to_uint128(const char *s)
{
    __uint128_t v = 0;
    while (*s >= '0' && *s <= '9') {
        v = v * 10 + (*s - '0');
        s++;
    }
    return v;
}

/* ========================================================================= */
/* Nesting tree                                                              */
/* ========================================================================= */

static void nesting_tree(const int (*pairs)[2], int n_pairs, int n_points,
                         int *parent, int *depth)
{
    /* Normalize pairs to (min, max) */
    int lo[MAX_ARCS], hi[MAX_ARCS];
    for (int i = 0; i < n_pairs; i++) {
        int a = pairs[i][0], b = pairs[i][1];
        lo[i] = a < b ? a : b;
        hi[i] = a > b ? a : b;
    }

    for (int i = 0; i < n_pairs; i++) {
        int best = -1, best_size = n_points + 1;
        for (int j = 0; j < n_pairs; j++) {
            if (i == j) continue;
            if (lo[j] < lo[i] && hi[i] < hi[j] && (hi[j] - lo[j]) < best_size) {
                best_size = hi[j] - lo[j];
                best = j;
            }
        }
        parent[i] = best;
    }

    for (int i = 0; i < n_pairs; i++) {
        int d = 0, p = i;
        while (parent[p] != -1) { d++; p = parent[p]; }
        depth[i] = d;
    }
}

/* ========================================================================= */
/* Tile descriptor                                                           */
/* ========================================================================= */

typedef struct {
    int row, col;
    const Shape *shape;
    int edge_eps[MAX_EDGES];
    int n_edges;
    bool polarity;
    double world_x, world_y, scale;
} TileDesc;

/* ========================================================================= */
/* Grid builders                                                             */
/* ========================================================================= */

static int square_grid(int rows, int cols, int k1, int k2,
                       double scale, TileDesc *out,
                       int pos_col, int pos_row)
{
    int n = 0;
    int ee[] = {k1, k2, k1, k2};
    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            TileDesc *t = &out[n++];
            t->row = r; t->col = c;
            t->shape = &SHAPE_SQUARE;
            memcpy(t->edge_eps, ee, sizeof(ee));
            t->n_edges = 4;
            int gc = c + pos_col;
            int gr = r + pos_row;
            int flips = gc * (k1 % 2) + gr * (k2 % 2);
            t->polarity = (flips % 2) == 0;
            t->world_x = c * scale;
            t->world_y = r * scale;
            t->scale = scale;
        }
    }
    return n;
}

static int triangle_grid(int rows, int cols, int k0, int k1, int k2,
                         double scale, TileDesc *out,
                         int pos_col, int pos_row)
{
    int n = 0;
    int ee[] = {k0, k1, k2};
    double half_w = 0.5 * scale;
    int f0 = k0 % 2, f1 = k1 % 2, f2 = k2 % 2;

    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            int gc = c + pos_col;
            int gr = r + pos_row;
            int is_up = ((gr + gc) % 2 == 0);
            TileDesc *t = &out[n++];
            t->row = r; t->col = c;
            t->shape = is_up ? &SHAPE_TRI_UP : &SHAPE_TRI_DOWN;
            memcpy(t->edge_eps, ee, sizeof(ee));
            t->n_edges = 3;
            t->world_x = c * half_w;
            t->world_y = r * TRI_H * scale;
            t->scale = scale;

            int row_flip = ((gr + 1) / 2) * f0;
            int flip;
            if (gr % 2 == 0)
                flip = (row_flip + ((gc + 1) / 2) * f1 + (gc / 2) * f2) % 2;
            else
                flip = (row_flip + ((gc + 1) / 2) * f2 + (gc / 2) * f1) % 2;
            t->polarity = (flip == 0);
        }
    }
    return n;
}

static int hexagon_grid(int rows, int cols, int ka, int kb, int kc,
                        double scale, TileDesc *out,
                        int pos_col, int pos_row)
{
    int n = 0;
    int ee[] = {ka, kb, kc, ka, kb, kc};
    double col_spacing = 0.75 * scale;
    double row_spacing = HEXH * scale;
    int fab = (ka + kb) % 2;
    int fac = (ka + kc) % 2;
    int fbc = (kb + kc) % 2;

    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            TileDesc *t = &out[n++];
            t->row = r; t->col = c;
            t->shape = &SHAPE_HEXAGON;
            memcpy(t->edge_eps, ee, sizeof(ee));
            t->n_edges = 6;
            t->world_x = c * col_spacing;
            t->world_y = r * row_spacing + (c % 2 == 1 ? row_spacing / 2 : 0);
            t->scale = scale;

            int gc = c + pos_col;
            int gr = r + pos_row;
            int flip = (gr * fac + ((gc + 1) / 2) * fbc + (gc / 2) * fab) % 2;
            t->polarity = (flip == 0);
        }
    }
    return n;
}

/* ========================================================================= */
/* Tile solving                                                              */
/* ========================================================================= */

#define MAX_MATCHING_RETRIES 20

typedef struct {
    int matching[MAX_ARCS][2];
    int n_arcs;
    /* Bezier control points per arc */
    Vec2 p0[MAX_ARCS], p1[MAX_ARCS], p2[MAX_ARCS], p3[MAX_ARCS];
    int d0_idx[MAX_ARCS], d1_idx[MAX_ARCS];
    __uint128_t matching_rank;
} SolvedTile;

/* Rank a non-crossing matching: return its index in [0, C(n/2)) */
static __uint128_t rank_ncm_rec(const int *partner, int start, int n)
{
    if (n <= 0) return 0;

    int k = partner[start] - start;  /* relative position of partner */
    __uint128_t rank = 0;

    /* Sum weights for all odd positions before k */
    for (int j = 1; j < k; j += 2) {
        rank += catalan((j - 1) / 2) * catalan((n - j - 1) / 2);
    }

    /* Recurse on inside and outside subproblems */
    int n_inside = k - 1;
    int n_outside = n - k - 1;
    __uint128_t rank_inside = rank_ncm_rec(partner, start + 1, n_inside);
    __uint128_t rank_outside = rank_ncm_rec(partner, start + k + 1, n_outside);

    rank += rank_inside * catalan(n_outside / 2) + rank_outside;
    return rank;
}

static __uint128_t rank_ncm(const int (*pairs)[2], int n_arcs, int n_points)
{
    int partner[MAX_EPS];
    memset(partner, -1, sizeof(partner));
    for (int i = 0; i < n_arcs; i++) {
        int a = pairs[i][0], b = pairs[i][1];
        int lo = a < b ? a : b, hi = a > b ? a : b;
        partner[lo] = hi;
        partner[hi] = lo;
    }
    return rank_ncm_rec(partner, 0, n_points);
}

static bool solve_one_tile(const TileDesc *desc, Rng *rng, SolvedTile *out,
                           bool has_idx, __uint128_t fixed_idx)
{
    const Shape *s = desc->shape;
    int n_points = 0;
    for (int i = 0; i < desc->n_edges; i++) n_points += desc->edge_eps[i];
    if (n_points == 0) { out->n_arcs = 0; return true; }

    Vec2 positions[MAX_EPS];
    int edges[MAX_EPS];
    ep_positions(s, desc->edge_eps, positions, edges);

    int max_retries = has_idx ? 1 : MAX_MATCHING_RETRIES;
    for (int retry = 0; retry < max_retries; retry++) {
        int matching[MAX_ARCS][2];
        int n_arcs;
        if (has_idx)
            n_arcs = unrank_ncm(n_points, fixed_idx, matching);
        else
            n_arcs = random_ncm(n_points, rng, matching);

        /* Normalize to (min, max) for solver */
        int flat_matching[MAX_ARCS * 2];
        for (int i = 0; i < n_arcs; i++) {
            int a = matching[i][0], b = matching[i][1];
            flat_matching[2*i] = a < b ? a : b;
            flat_matching[2*i+1] = a > b ? a : b;
        }

        SolverInput input = {
            .n_eps = n_points,
            .positions = positions,
            .edge_indices = edges,
            .n_edges = s->n_edges,
            .edge_normals = s->normals,
            .n_corners = s->n_edges,
            .corners = s->corners,
            .n_arcs = n_arcs,
            .matching = flat_matching,
        };

        SolverResult result;
        if (solve_tile(&input, &result) && result.ok) {
            out->n_arcs = n_arcs;
            for (int i = 0; i < n_arcs; i++) {
                int a = flat_matching[2*i], b = flat_matching[2*i+1];
                out->matching[i][0] = a;
                out->matching[i][1] = b;

                int ea = edges[a], eb = edges[b];
                out->p0[i] = positions[a];
                out->p3[i] = positions[b];
                out->p1[i] = (Vec2){
                    positions[a].x + result.d0[i] * s->normals[ea].x,
                    positions[a].y + result.d0[i] * s->normals[ea].y
                };
                out->p2[i] = (Vec2){
                    positions[b].x + result.d1[i] * s->normals[eb].x,
                    positions[b].y + result.d1[i] * s->normals[eb].y
                };
                out->d0_idx[i] = result.d0_idx[i];
                out->d1_idx[i] = result.d1_idx[i];
            }
            out->matching_rank = rank_ncm(out->matching, n_arcs, n_points);
            return true;
        }
        if (g_verbose)
            fprintf(stderr, "  tile (%d,%d) retry %d: matching failed, re-rolling...\n",
                    desc->row, desc->col, retry + 1);
    }
    return false;
}

/* ========================================================================= */
/* SVG output                                                                */
/* ========================================================================= */

static void wp(FILE *f, double x, double y, double tx, double ty, double sc)
{
    fprintf(f, "%.4f,%.4f", tx + x * sc, ty + y * sc);
}

static void emit_region_path(FILE *f, int a, int b,
                             const int *edge_eps, int n_edges,
                             const Vec2 *full_perim,
                             const Vec2 *cp0, const Vec2 *cp1,
                             const Vec2 *cp2, const Vec2 *cp3,
                             double tx, double ty, double sc,
                             const char *fill)
{
    fprintf(f, "<path d=\"M ");
    wp(f, cp0->x, cp0->y, tx, ty, sc);
    fprintf(f, " C ");
    wp(f, cp1->x, cp1->y, tx, ty, sc);
    fprintf(f, " ");
    wp(f, cp2->x, cp2->y, tx, ty, sc);
    fprintf(f, " ");
    wp(f, cp3->x, cp3->y, tx, ty, sc);

    int fi_a = ep_to_full_index(a, edge_eps, n_edges);
    int fi_b = ep_to_full_index(b, edge_eps, n_edges);
    for (int fi = fi_b - 1; fi > fi_a; fi--) {
        fprintf(f, " L ");
        wp(f, full_perim[fi].x, full_perim[fi].y, tx, ty, sc);
    }
    fprintf(f, " Z\" fill=\"%s\" stroke=\"none\"/>\n", fill);
}

static void emit_json(FILE *f, const TileDesc *descs, const SolvedTile *solved,
                      int n_tiles, int rows, int cols, const char *shape_name,
                      const int *edge_eps_config, int n_edge_vals,
                      int total_eps, int n_levels);

static void emit_svg(FILE *f, const TileDesc *descs, const SolvedTile *solved,
                     int n_tiles, double tile_scale, double margin,
                     const char *color0, const char *color1,
                     bool show_curves, bool show_outlines,
                     int rows, int cols, const char *shape_name,
                     const int *edge_eps_config, int n_edge_vals,
                     int total_eps, int n_levels)
{
    /* Compute bounds */
    double min_x = 1e30, min_y = 1e30, max_x = -1e30, max_y = -1e30;
    for (int i = 0; i < n_tiles; i++) {
        const TileDesc *d = &descs[i];
        for (int j = 0; j < d->shape->n_edges; j++) {
            double wx = d->world_x + d->shape->corners[j].x * d->scale;
            double wy = d->world_y + d->shape->corners[j].y * d->scale;
            if (wx < min_x) min_x = wx;
            if (wy < min_y) min_y = wy;
            if (wx > max_x) max_x = wx;
            if (wy > max_y) max_y = wy;
        }
    }
    double vx = min_x - margin, vy = min_y - margin;
    double vw = max_x - min_x + 2 * margin;
    double vh = max_y - min_y + 2 * margin;

    const char *colors[2] = {color0, color1};

    fprintf(f, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    fprintf(f, "<svg xmlns=\"http://www.w3.org/2000/svg\" "
            "width=\"%.0f\" height=\"%.0f\" "
            "viewBox=\"%.1f %.1f %.1f %.1f\" "
            "shape-rendering=\"crispEdges\">\n", vw, vh, vx, vy, vw, vh);
    fprintf(f, "<rect x=\"%.1f\" y=\"%.1f\" width=\"%.1f\" height=\"%.1f\" "
            "fill=\"%s\"/>\n", vx, vy, vw, vh, color1);

    /* Embedded metadata for tile recovery */
    fprintf(f, "<metadata>\n");
    emit_json(f, descs, solved, n_tiles, rows, cols, shape_name,
              edge_eps_config, n_edge_vals, total_eps, n_levels);
    fprintf(f, "</metadata>\n");

    /* Background pass: merge same-color tile polygons */
    for (int ci = 0; ci < 2; ci++) {
        bool any = false;
        for (int i = 0; i < n_tiles; i++) {
            int base = descs[i].polarity ? 0 : 1;
            if (base == ci) { any = true; break; }
        }
        if (!any) continue;

        fprintf(f, "<path d=\"");
        for (int i = 0; i < n_tiles; i++) {
            int base = descs[i].polarity ? 0 : 1;
            if (base != ci) continue;
            const TileDesc *d = &descs[i];
            double sc = d->scale, tx = d->world_x, ty = d->world_y;
            const Vec2 *c = d->shape->corners;
            int ne = d->shape->n_edges;
            fprintf(f, "M %.4f,%.4f", tx + c[0].x * sc, ty + c[0].y * sc);
            for (int j = 1; j < ne; j++)
                fprintf(f, " L %.4f,%.4f", tx + c[j].x * sc, ty + c[j].y * sc);
            fprintf(f, " Z ");
        }
        fprintf(f, "\" fill=\"%s\" stroke=\"none\"/>\n", colors[ci]);
    }

    /* Curve regions */
    for (int i = 0; i < n_tiles; i++) {
        const TileDesc *d = &descs[i];
        const SolvedTile *st = &solved[i];
        if (st->n_arcs == 0) continue;

        int n_points = 0;
        for (int e = 0; e < d->n_edges; e++) n_points += d->edge_eps[e];

        Vec2 full_perim[MAX_EPS + MAX_EDGES];
        int perim_len = make_perimeter(d->shape, d->edge_eps, full_perim);
        (void)perim_len;

        int parent[MAX_ARCS], depth[MAX_ARCS];
        nesting_tree(st->matching, st->n_arcs, n_points, parent, depth);

        /* Sort by depth (shallowest first) */
        int order[MAX_ARCS];
        for (int j = 0; j < st->n_arcs; j++) order[j] = j;
        for (int a = 0; a < st->n_arcs - 1; a++)
            for (int b = a + 1; b < st->n_arcs; b++)
                if (depth[order[b]] < depth[order[a]]) {
                    int tmp = order[a]; order[a] = order[b]; order[b] = tmp;
                }

        int base = d->polarity ? 0 : 1;
        for (int oi = 0; oi < st->n_arcs; oi++) {
            int ci = order[oi];
            int a = st->matching[ci][0], b = st->matching[ci][1];
            int fill_idx = (base + depth[ci] + 1) % 2;
            emit_region_path(f, a, b, d->edge_eps, d->n_edges,
                             full_perim,
                             &st->p0[ci], &st->p1[ci],
                             &st->p2[ci], &st->p3[ci],
                             d->world_x, d->world_y, d->scale,
                             colors[fill_idx]);
        }

        if (show_curves) {
            double sw = 0.008 * d->scale;
            for (int ci = 0; ci < st->n_arcs; ci++) {
                fprintf(f, "<path d=\"M ");
                wp(f, st->p0[ci].x, st->p0[ci].y,
                   d->world_x, d->world_y, d->scale);
                fprintf(f, " C ");
                wp(f, st->p1[ci].x, st->p1[ci].y,
                   d->world_x, d->world_y, d->scale);
                fprintf(f, " ");
                wp(f, st->p2[ci].x, st->p2[ci].y,
                   d->world_x, d->world_y, d->scale);
                fprintf(f, " ");
                wp(f, st->p3[ci].x, st->p3[ci].y,
                   d->world_x, d->world_y, d->scale);
                fprintf(f, "\" fill=\"none\" stroke=\"#fff3\" "
                        "stroke-width=\"%.4f\"/>\n", sw);
            }
        }
    }

    if (show_outlines) {
        for (int i = 0; i < n_tiles; i++) {
            const TileDesc *d = &descs[i];
            fprintf(f, "<polygon points=\"");
            for (int j = 0; j < d->shape->n_edges; j++) {
                if (j > 0) fprintf(f, " ");
                fprintf(f, "%.4f,%.4f",
                        d->world_x + d->shape->corners[j].x * d->scale,
                        d->world_y + d->shape->corners[j].y * d->scale);
            }
            fprintf(f, "\" fill=\"none\" stroke=\"#0001\" "
                    "stroke-width=\"0.5\"/>\n");
        }
    }

    fprintf(f, "</svg>\n");
}

/* ========================================================================= */
/* JSON output                                                               */
/* ========================================================================= */

static void emit_json(FILE *f, const TileDesc *descs, const SolvedTile *solved,
                      int n_tiles, int rows, int cols, const char *shape_name,
                      const int *edge_eps_config, int n_edge_vals,
                      int total_eps, int n_levels)
{
    fprintf(f, "{\n  \"config\": {\n");
    fprintf(f, "    \"shape\": \"%s\",\n", shape_name);
    fprintf(f, "    \"w\": %d, \"h\": %d,\n", cols, rows);
    fprintf(f, "    \"eps\": [");
    for (int i = 0; i < n_edge_vals; i++) {
        if (i > 0) fprintf(f, ", ");
        fprintf(f, "%d", edge_eps_config[i]);
    }
    fprintf(f, "],\n");
    fprintf(f, "    \"total_eps\": %d,\n", total_eps);
    fprintf(f, "    \"n_levels\": %d\n", n_levels);
    fprintf(f, "  },\n  \"tiles\": [\n");

    for (int i = 0; i < n_tiles; i++) {
        const SolvedTile *st = &solved[i];
        char rank_str[40];
        uint128_to_str(rank_str, st->matching_rank);
        fprintf(f, "    [\"%s\"", rank_str);
        for (int j = 0; j < st->n_arcs; j++) {
            fprintf(f, ", [%d, %d]", st->d0_idx[j], st->d1_idx[j]);
        }
        fprintf(f, "]%s\n", i < n_tiles - 1 ? "," : "");
    }

    fprintf(f, "  ]\n}\n");
}

/* ========================================================================= */
/* Edge split generation                                                     */
/* ========================================================================= */

typedef struct {
    int vals[3];
} Split3;

/* Square: (k1, k2) where 2*(k1+k2) = total */
static int valid_splits_square(int total, Split3 *out)
{
    int half = total / 2, n = 0;
    for (int k1 = 0; k1 <= half; k1++) {
        out[n].vals[0] = k1;
        out[n].vals[1] = half - k1;
        out[n].vals[2] = 0;
        n++;
    }
    return n;
}

/* Triangle: (k0, k1, k2) where k0+k1+k2 = total */
static int valid_splits_triangle(int total, Split3 *out)
{
    int n = 0;
    for (int k0 = 0; k0 <= total; k0++)
        for (int k1 = 0; k1 <= total - k0; k1++) {
            out[n].vals[0] = k0;
            out[n].vals[1] = k1;
            out[n].vals[2] = total - k0 - k1;
            n++;
        }
    return n;
}

/* Hexagon: (ka, kb, kc) where 2*(ka+kb+kc) = total */
static int valid_splits_hexagon(int total, Split3 *out)
{
    int half = total / 2, n = 0;
    for (int ka = 0; ka <= half; ka++)
        for (int kb = 0; kb <= half - ka; kb++) {
            out[n].vals[0] = ka;
            out[n].vals[1] = kb;
            out[n].vals[2] = half - ka - kb;
            n++;
        }
    return n;
}

/* ========================================================================= */
/* Main                                                                      */
/* ========================================================================= */

static void print_usage(void) {
    fprintf(stderr,
        "Usage: truchet [options]\n"
        "\n"
        "  w=COLS      Grid columns (default: 6)\n"
        "  h=ROWS      Grid rows (default: 6)\n"
        "  shape=NAME  square (sq), triangle (tri), hexagon (hex) (default: square)\n"
        "  seed=N      RNG seed (default: time-based)\n"
        "  ep=N        Total EPs per tile, random split (default: 4)\n"
        "  eps=K,K,... Explicit per-edge EP counts\n"
        "              square: eps=K1,K2  triangle: eps=K0,K1,K2  hexagon: eps=Ka,Kb,Kc\n"
        "  idx=N       Catalan index for a specific matching (use with w=1 h=1)\n"
        "  pos=C,R     Grid position offset for polarity (default: 0,0)\n"
        "  polarity=N  Override polarity: 0 or 1 (for single-tile rendering)\n"
        "\n"
        "  svg[=FILE]  Write SVG (bare: stdout, =FILE: file, =-: stdout)\n"
        "  json[=FILE] Write JSON (bare: stdout, =FILE: file, =-: stdout)\n"
        "              Default (neither): SVG to auto-named file\n"
        "\n"
        "  q           Quiet (suppress progress output)\n"
        "  v           Verbose solver output\n"
        "  curves      Overlay bezier curve strokes\n"
        "  grid        Overlay tile outlines\n"
        "  help        Show this message\n"
        "\n"
        "Dashes are optional: -v, --verbose, v all work.\n"
    );
}

int main(int argc, char **argv)
{
    init_shapes();

    /* Parse arguments — key=value pairs and bare flags */
    bool show_curves = false, show_outlines = false;
    const char *val_w = NULL, *val_h = NULL, *val_shape = NULL;
    const char *val_seed = NULL, *val_ep = NULL, *val_eps = NULL;
    const char *val_svg = NULL, *val_json = NULL, *val_idx = NULL;
    const char *val_pos = NULL, *val_polarity = NULL;

    for (int i = 1; i < argc; i++) {
        const char *arg = argv[i];
        while (*arg == '-') arg++;  /* strip leading dashes */

        char *eq = strchr(arg, '=');
        if (!eq) {
            /* Bare flag */
            if (strcmp(arg, "v") == 0 || strcmp(arg, "verbose") == 0) {
                g_verbose = 1; continue;
            }
            if (strcmp(arg, "q") == 0 || strcmp(arg, "quiet") == 0) {
                g_quiet = 1; continue;
            }
            if (strcmp(arg, "curves") == 0) { show_curves = true; continue; }
            if (strcmp(arg, "grid") == 0) { show_outlines = true; continue; }
            if (strcmp(arg, "svg") == 0) { val_svg = "-"; continue; }
            if (strcmp(arg, "json") == 0) { val_json = "-"; continue; }
            if (strcmp(arg, "h") == 0 || strcmp(arg, "help") == 0) {
                print_usage(); return 0;
            }
            fprintf(stderr, "Unknown flag: %s\n", argv[i]);
            print_usage();
            return 1;
        }
        /* key=value — split at '=' */
        char buf[256];
        size_t len = (size_t)(eq - arg);
        if (len >= sizeof(buf)) len = sizeof(buf) - 1;
        memcpy(buf, arg, len);
        buf[len] = '\0';
        const char *key = buf;
        const char *val = eq + 1;  /* points into argv, stable */

        if (strcmp(key, "w") == 0)          val_w = val;
        else if (strcmp(key, "h") == 0)     val_h = val;
        else if (strcmp(key, "shape") == 0) val_shape = val;
        else if (strcmp(key, "seed") == 0)  val_seed = val;
        else if (strcmp(key, "ep") == 0)    val_ep = val;
        else if (strcmp(key, "eps") == 0)   val_eps = val;
        else if (strcmp(key, "svg") == 0)   val_svg = val;
        else if (strcmp(key, "json") == 0)  val_json = val;
        else if (strcmp(key, "idx") == 0)   val_idx = val;
        else if (strcmp(key, "pos") == 0)   val_pos = val;
        else if (strcmp(key, "polarity") == 0) val_polarity = val;
        else {
            fprintf(stderr, "Unknown key: %s\n", key);
            print_usage();
            return 1;
        }
    }

    /* Apply defaults */
    int rows = val_h ? atoi(val_h) : 6;
    int cols = val_w ? atoi(val_w) : 6;
    const char *shape_name = val_shape ? val_shape : "square";
    if (strcmp(shape_name, "sq") == 0) shape_name = "square";
    else if (strcmp(shape_name, "tri") == 0) shape_name = "triangle";
    else if (strcmp(shape_name, "hex") == 0) shape_name = "hexagon";
    uint64_t seed = val_seed ? (uint64_t)atoll(val_seed) : (uint64_t)time(NULL);

    if (val_ep && val_eps) {
        fprintf(stderr, "Cannot specify both ep= and eps=\n");
        return 1;
    }

    /* Determine edge config: explicit (eps=) or random split (ep=) */
    int explicit_edges = 0;  /* 1 if eps= was given */
    int k_vals[3] = {0};     /* per-edge counts (2 for square, 3 for tri/hex) */
    int total_eps = 0;
    int n_shape_edges = 0;   /* expected number of comma-separated values */

    if (strcmp(shape_name, "square") == 0)        n_shape_edges = 2;
    else if (strcmp(shape_name, "triangle") == 0)  n_shape_edges = 3;
    else if (strcmp(shape_name, "hexagon") == 0)   n_shape_edges = 3;
    else {
        fprintf(stderr, "Unknown shape: %s. Use square, triangle, or hexagon.\n",
                shape_name);
        return 1;
    }

    if (val_eps) {
        /* Parse comma-separated ints */
        char epsbuf[256];
        strncpy(epsbuf, val_eps, sizeof(epsbuf) - 1);
        epsbuf[sizeof(epsbuf) - 1] = '\0';
        int n_vals = 0;
        char *tok = strtok(epsbuf, ",");
        while (tok && n_vals < 3) {
            k_vals[n_vals++] = atoi(tok);
            tok = strtok(NULL, ",");
        }
        if (tok) n_vals++;  /* too many */
        if (n_vals != n_shape_edges) {
            fprintf(stderr, "eps= for %s needs %d values, got %d\n",
                    shape_name, n_shape_edges, n_vals);
            return 1;
        }
        total_eps = 0;
        for (int i = 0; i < n_vals; i++) total_eps += k_vals[i];
        if (strcmp(shape_name, "square") == 0)
            total_eps *= 2;  /* square: [k1,k2,k1,k2] */
        else if (strcmp(shape_name, "hexagon") == 0)
            total_eps *= 2;  /* hexagon: [ka,kb,kc,ka,kb,kc] */
        if (total_eps % 2 != 0) {
            fprintf(stderr, "eps= total %d is odd — must be even for 2-colorability.\n",
                    total_eps);
            return 1;
        }
        explicit_edges = 1;
    } else {
        total_eps = val_ep ? atoi(val_ep) : 4;
        if (total_eps % 2 != 0) {
            fprintf(stderr, "ep=%d is odd — must be even for 2-colorability.\n",
                    total_eps);
            return 1;
        }
    }

    if (total_eps > MAX_EPS) {
        fprintf(stderr, "total_eps=%d exceeds MAX_EPS=%d (MAX_ARCS=%d).\n"
                "Recompile with a larger MAX_ARCS.\n",
                total_eps, MAX_EPS, MAX_ARCS);
        return 1;
    }

    int pos_col = 0, pos_row = 0;
    if (val_pos) {
        char posbuf[64];
        strncpy(posbuf, val_pos, sizeof(posbuf) - 1);
        posbuf[sizeof(posbuf) - 1] = '\0';
        char *comma = strchr(posbuf, ',');
        if (!comma) {
            fprintf(stderr, "pos= needs two values: pos=C,R\n");
            return 1;
        }
        *comma = '\0';
        pos_col = atoi(posbuf);
        pos_row = atoi(comma + 1);
    }

    Rng rng = {seed ? seed : 1};

    /* Allocate tiles (max reasonable) */
    int max_tiles = rows * cols;
    TileDesc *descs = (TileDesc *)calloc(max_tiles, sizeof(TileDesc));
    SolvedTile *solved = (SolvedTile *)calloc(max_tiles, sizeof(SolvedTile));
    if (!descs || !solved) { fprintf(stderr, "alloc failed\n"); return 1; }

    int n_tiles = 0;
    char out_name[256];
    int edge_eps_config[3] = {0};
    int n_edge_vals = 0;

    if (strcmp(shape_name, "square") == 0) {
        int k1, k2;
        if (explicit_edges) {
            k1 = k_vals[0]; k2 = k_vals[1];
        } else {
            /* Random split */
            int max_splits = (total_eps + 1) * (total_eps + 1);
            Split3 *splits = (Split3 *)malloc(max_splits * sizeof(Split3));
            Split3 *interesting = (Split3 *)malloc(max_splits * sizeof(Split3));
            __uint128_t *weights = (__uint128_t *)malloc(max_splits * sizeof(__uint128_t));
            if (!splits || !interesting || !weights) {
                fprintf(stderr, "alloc failed\n"); return 1;
            }
            int n_splits = valid_splits_square(total_eps, splits);
            int ni = 0;
            for (int i = 0; i < n_splits; i++)
                if (splits[i].vals[0] > 0 && splits[i].vals[1] > 0)
                    interesting[ni++] = splits[i];
            if (ni == 0) { ni = n_splits; memcpy(interesting, splits, ni * sizeof(Split3)); }
            for (int i = 0; i < ni; i++) {
                int mn = interesting[i].vals[0] < interesting[i].vals[1]
                         ? interesting[i].vals[0] : interesting[i].vals[1];
                weights[i] = mn + 1;
            }
            int ci = rng_weighted(&rng, weights, ni);
            k1 = interesting[ci].vals[0]; k2 = interesting[ci].vals[1];
            free(splits); free(interesting); free(weights);
        }

        if (!g_quiet)
            fprintf(stderr, "Grid: %dx%d squares, %d EPs/tile, edge config [%d,%d,%d,%d]\n",
                    rows, cols, total_eps, k1, k2, k1, k2);
        if (g_verbose)
            fprintf(stderr, "  split: k1=%d (horiz), k2=%d (vert)\n", k1, k2);

        n_tiles = square_grid(rows, cols, k1, k2, 80.0, descs, pos_col, pos_row);
        snprintf(out_name, sizeof(out_name), "compose_square_%d_%d.svg", k1, k2);
        edge_eps_config[0] = k1; edge_eps_config[1] = k2; n_edge_vals = 2;

    } else if (strcmp(shape_name, "triangle") == 0) {
        int k0, k1, k2;
        if (explicit_edges) {
            k0 = k_vals[0]; k1 = k_vals[1]; k2 = k_vals[2];
        } else {
            int max_splits = (total_eps + 1) * (total_eps + 1);
            Split3 *splits = (Split3 *)malloc(max_splits * sizeof(Split3));
            Split3 *interesting = (Split3 *)malloc(max_splits * sizeof(Split3));
            __uint128_t *weights = (__uint128_t *)malloc(max_splits * sizeof(__uint128_t));
            if (!splits || !interesting || !weights) {
                fprintf(stderr, "alloc failed\n"); return 1;
            }
            int n_splits = valid_splits_triangle(total_eps, splits);
            int ni = 0;
            for (int i = 0; i < n_splits; i++) {
                int a = splits[i].vals[0], b = splits[i].vals[1], c = splits[i].vals[2];
                if (a > 0 && b > 0 && c > 0)
                    interesting[ni++] = splits[i];
            }
            if (ni == 0) {
                for (int i = 0; i < n_splits; i++) {
                    int a = splits[i].vals[0], b = splits[i].vals[1], c = splits[i].vals[2];
                    if (a + b + c > 0) interesting[ni++] = splits[i];
                }
            }
            if (ni == 0) { ni = n_splits; memcpy(interesting, splits, ni * sizeof(Split3)); }
            for (int i = 0; i < ni; i++) {
                int a = interesting[i].vals[0], b = interesting[i].vals[1], c = interesting[i].vals[2];
                int mn = a < b ? a : b; mn = mn < c ? mn : c;
                int64_t w = (mn + 1); w = w * w * w;
                weights[i] = w;
            }
            int ci = rng_weighted(&rng, weights, ni);
            k0 = interesting[ci].vals[0]; k1 = interesting[ci].vals[1]; k2 = interesting[ci].vals[2];
            free(splits); free(interesting); free(weights);
        }

        if (!g_quiet)
            fprintf(stderr, "Grid: %dx%d triangles, %d EPs/tile, edge config [%d,%d,%d]\n",
                    rows, cols, total_eps, k0, k1, k2);

        n_tiles = triangle_grid(rows, cols, k0, k1, k2, 80.0, descs, pos_col, pos_row);
        snprintf(out_name, sizeof(out_name), "compose_triangle_%d_%d_%d.svg", k0, k1, k2);
        edge_eps_config[0] = k0; edge_eps_config[1] = k1; edge_eps_config[2] = k2; n_edge_vals = 3;

    } else if (strcmp(shape_name, "hexagon") == 0) {
        int ka, kb, kc;
        if (explicit_edges) {
            ka = k_vals[0]; kb = k_vals[1]; kc = k_vals[2];
        } else {
            int max_splits = (total_eps + 1) * (total_eps + 1);
            Split3 *splits = (Split3 *)malloc(max_splits * sizeof(Split3));
            Split3 *interesting = (Split3 *)malloc(max_splits * sizeof(Split3));
            __uint128_t *weights = (__uint128_t *)malloc(max_splits * sizeof(__uint128_t));
            if (!splits || !interesting || !weights) {
                fprintf(stderr, "alloc failed\n"); return 1;
            }
            int n_splits = valid_splits_hexagon(total_eps, splits);
            int ni = 0;
            for (int i = 0; i < n_splits; i++) {
                int a = splits[i].vals[0], b = splits[i].vals[1], c = splits[i].vals[2];
                if (a > 0 && b > 0 && c > 0)
                    interesting[ni++] = splits[i];
            }
            if (ni == 0) {
                for (int i = 0; i < n_splits; i++) {
                    int a = splits[i].vals[0], b = splits[i].vals[1], c = splits[i].vals[2];
                    if (a + b + c > 0) interesting[ni++] = splits[i];
                }
            }
            if (ni == 0) { ni = n_splits; memcpy(interesting, splits, ni * sizeof(Split3)); }
            for (int i = 0; i < ni; i++) {
                int a = interesting[i].vals[0], b = interesting[i].vals[1], c = interesting[i].vals[2];
                int mn = a < b ? a : b; mn = mn < c ? mn : c;
                int64_t w = (mn + 1); w = w * w * w;
                weights[i] = w;
            }
            int ci = rng_weighted(&rng, weights, ni);
            ka = interesting[ci].vals[0]; kb = interesting[ci].vals[1]; kc = interesting[ci].vals[2];
            free(splits); free(interesting); free(weights);
        }

        if (!g_quiet)
            fprintf(stderr, "Grid: %dx%d hexagons, %d EPs/tile, edge config [%d,%d,%d,%d,%d,%d]\n",
                    rows, cols, total_eps, ka, kb, kc, ka, kb, kc);

        n_tiles = hexagon_grid(rows, cols, ka, kb, kc, 80.0, descs, pos_col, pos_row);
        snprintf(out_name, sizeof(out_name), "compose_hexagon_%d_%d_%d.svg", ka, kb, kc);
        edge_eps_config[0] = ka; edge_eps_config[1] = kb; edge_eps_config[2] = kc; n_edge_vals = 3;

    } else {
        fprintf(stderr, "Unknown shape: %s. Use square, triangle, or hexagon.\n",
                shape_name);
        return 1;
    }

    /* Override polarity if explicitly specified */
    if (val_polarity) {
        int p = atoi(val_polarity);
        for (int i = 0; i < n_tiles; i++)
            descs[i].polarity = (p != 0);
    }

    __uint128_t n_matchings = catalan(total_eps / 2);
    if (g_verbose) {
        char cat_str[40];
        uint128_to_str(cat_str, n_matchings);
        fprintf(stderr, "  C(%d) = %s matchings\n", total_eps / 2, cat_str);
    }

    bool has_idx = (val_idx != NULL);
    __uint128_t fixed_idx = 0;
    if (has_idx) {
        fixed_idx = str_to_uint128(val_idx);
        if (fixed_idx >= n_matchings) {
            char cat_str[40];
            uint128_to_str(cat_str, n_matchings);
            fprintf(stderr, "idx=%s out of range — must be < C(%d) = %s\n",
                    val_idx, total_eps / 2, cat_str);
            return 1;
        }
    }

    /* Solve all tiles */
    if (!g_quiet) fprintf(stderr, "Solving %d tiles...\n", n_tiles);
    struct timespec t0, t1, tnow;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    for (int i = 0; i < n_tiles; i++) {
        if (!solve_one_tile(&descs[i], &rng, &solved[i], has_idx, fixed_idx)) {
            fprintf(stderr, "\nFATAL: tile (%d,%d) failed after %d retries. "
                    "Cannot produce valid output.\n",
                    descs[i].row, descs[i].col, MAX_MATCHING_RETRIES);
            free(descs); free(solved);
            return 1;
        }

        if (!g_quiet) {
            clock_gettime(CLOCK_MONOTONIC, &tnow);
            double elapsed = (tnow.tv_sec - t0.tv_sec)
                           + (tnow.tv_nsec - t0.tv_nsec) * 1e-9;
            double per_tile = elapsed / (i + 1);
            double eta = per_tile * (n_tiles - i - 1);
            fprintf(stderr, "\r  tile %d/%d  %.2fs  ETA %.1fs  ", i + 1, n_tiles,
                    elapsed, eta);
        }
    }

    clock_gettime(CLOCK_MONOTONIC, &t1);
    double total_time = (t1.tv_sec - t0.tv_sec)
                      + (t1.tv_nsec - t0.tv_nsec) * 1e-9;
    if (!g_quiet)
        fprintf(stderr, "\r  solved %d tiles in %.2fs              \n", n_tiles,
                total_time);

    /* If neither svg= nor json= specified, default to SVG auto-named file */
    if (!val_svg && !val_json) val_svg = out_name;

    /* Compute n_levels for metadata (grid-level constant) */
    int out_n_levels, out_res, out_stroke;
    auto_tune(total_eps / 2, 1.0, &out_n_levels, &out_res, &out_stroke);

    if (val_svg) {
        FILE *fout = strcmp(val_svg, "-") == 0 ? stdout : fopen(val_svg, "w");
        if (!fout) { fprintf(stderr, "Cannot open %s\n", val_svg); return 1; }
        emit_svg(fout, descs, solved, n_tiles, 80.0, 4.0,
                 "#2c3e50", "#ecf0f1", show_curves, show_outlines,
                 rows, cols, shape_name, edge_eps_config, n_edge_vals,
                 total_eps, out_n_levels);
        if (fout != stdout) {
            fclose(fout);
            if (!g_quiet) fprintf(stderr, "  wrote %s\n", val_svg);
        }
    }
    if (val_json) {
        FILE *fout = strcmp(val_json, "-") == 0 ? stdout : fopen(val_json, "w");
        if (!fout) { fprintf(stderr, "Cannot open %s\n", val_json); return 1; }
        emit_json(fout, descs, solved, n_tiles, rows, cols, shape_name,
                  edge_eps_config, n_edge_vals, total_eps, out_n_levels);
        if (fout != stdout) {
            fclose(fout);
            if (!g_quiet) fprintf(stderr, "  wrote %s\n", val_json);
        }
    }

    if (g_verbose) {
        int n_pol_true = 0;
        for (int i = 0; i < n_tiles; i++)
            if (descs[i].polarity) n_pol_true++;

        fprintf(stderr, "\nStats:\n");
        fprintf(stderr, "  Grid: %d tiles (%d polarity+, %d polarity-)\n",
                n_tiles, n_pol_true, n_tiles - n_pol_true);
        char cat_str2[40], cat_str3[40];
        uint128_to_str(cat_str2, n_matchings);
        uint128_to_str(cat_str3, n_matchings * 2);
        fprintf(stderr, "  Possible matchings: C(%d) = %s\n",
                total_eps / 2, cat_str2);
        fprintf(stderr, "  Possible tile types: %s (%s matchings x 2 polarities)\n",
                cat_str3, cat_str2);
    }

    free(descs);
    free(solved);
    return 0;
}
