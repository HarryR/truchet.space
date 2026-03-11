/*
 * tile_solver.c — Bitmap collision solver for Truchet tile Bezier curves.
 *
 * Single-file C implementation with OpenMP parallelism.
 * Compile: gcc -O2 -fopenmp -lm tile_solver.c -o tile_solver
 *
 * Given edge points on a polygon perimeter and a non-crossing perfect matching,
 * finds non-overlapping cubic Bezier curves connecting each matched pair.
 * Curves are parameterized by two scalars (d0, d1) controlling control point
 * displacement along inward edge normals.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <omp.h>

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

static int g_verbose = 0;

#define MAX_ARCS        64
#define MAX_EPS         (MAX_ARCS * 2)
#define MAX_LEVELS      26
#define MAX_VARIANTS    (MAX_LEVELS * MAX_LEVELS)
#define MAX_POLY_SIDES  8
#define REL_STROKE      0.03
#define SYM_SCALE       2000
#define MAX_SOLUTIONS   3000
#define MAX_NODES       500000

/* ---------------------------------------------------------------------------
 * Vec2
 * ------------------------------------------------------------------------ */

typedef struct { double x, y; } Vec2;

static inline double vec2_dist(Vec2 a, Vec2 b) {
    return hypot(b.x - a.x, b.y - a.y);
}

static inline Vec2 vec2_lerp(Vec2 a, Vec2 b, double t) {
    return (Vec2){ a.x + t * (b.x - a.x), a.y + t * (b.y - a.y) };
}

/* ---------------------------------------------------------------------------
 * Solver input / output
 * ------------------------------------------------------------------------ */

typedef struct {
    int n_eps;
    const Vec2 *positions;     /* [n_eps] */
    const int  *edge_indices;  /* [n_eps] */
    int n_edges;
    const Vec2 *edge_normals;  /* [n_edges] */
    int n_corners;
    const Vec2 *corners;       /* [n_corners] */
    int n_arcs;
    const int  *matching;      /* [2*n_arcs]: pairs (a0,b0, a1,b1, ...) */
} SolverInput;

typedef struct {
    int n_arcs;
    double d0[MAX_ARCS];
    double d1[MAX_ARCS];
    int d0_idx[MAX_ARCS];
    int d1_idx[MAX_ARCS];
    bool ok;
} SolverResult;

/* ---------------------------------------------------------------------------
 * Per-arc geometry
 * ------------------------------------------------------------------------ */

typedef struct {
    Vec2 p0, p3;
    int ea, eb;
    double d_ideal;
    double d0_max, d1_max;
    int n_levels_0, n_levels_1;
    double levels_0[MAX_LEVELS];
    double levels_1[MAX_LEVELS];
} ArcGeom;

/* ---------------------------------------------------------------------------
 * Solver working memory
 * ------------------------------------------------------------------------ */

typedef struct {
    int n_arcs;
    int max_variants;
    int pack_len;
    int bmp_res;

    int n_variants[MAX_ARCS];
    double variant_d0[MAX_ARCS * MAX_VARIANTS];
    double variant_d1[MAX_ARCS * MAX_VARIANTS];
    int32_t pixel_counts[MAX_ARCS * MAX_VARIANTS];

    /* Heap-allocated */
    uint64_t *all_packed;    /* [n_arcs * max_variants * pack_len] */
    bool     *compat;        /* [n_arcs * n_arcs * max_variants * max_variants] */
    bool      compat_valid;

    bool     viable[MAX_ARCS * MAX_VARIANTS];
    int32_t  viable_lists[MAX_ARCS * MAX_VARIANTS];
    int32_t  n_viable[MAX_ARCS];
    int32_t  order[MAX_ARCS];
} SolverState;

/* Indexing helpers */
#define PACKED_IDX(s, arc, var, word) \
    ((arc) * (s)->max_variants * (s)->pack_len + (var) * (s)->pack_len + (word))

#define COMPAT_IDX(s, i, j, vi, vj) \
    ((i) * (s)->n_arcs * (s)->max_variants * (s)->max_variants + \
     (j) * (s)->max_variants * (s)->max_variants + \
     (vi) * (s)->max_variants + (vj))

#define PIXEL_IDX(arc, var) ((arc) * MAX_VARIANTS + (var))

/* ---------------------------------------------------------------------------
 * max_d_for_polygon — ray-polygon intersection
 * ------------------------------------------------------------------------ */

static double max_d_for_polygon(Vec2 pos, Vec2 normal,
                                const Vec2 *corners, int n_corners)
{
    double d_max = 1e30;
    double nx = normal.x, ny = normal.y;

    for (int i = 0; i < n_corners; i++) {
        Vec2 c0 = corners[i];
        Vec2 c1 = corners[(i + 1) % n_corners];
        double ex = c1.x - c0.x;
        double ey = c1.y - c0.y;
        double det = ex * ny - ey * nx;
        if (fabs(det) < 1e-12) continue;

        double dpx = c0.x - pos.x;
        double dpy = c0.y - pos.y;
        double d_val = (ex * dpy - ey * dpx) / det;
        double t_val = (nx * dpy - ny * dpx) / det;

        if (d_val > 1e-4 && t_val >= -1e-9 && t_val <= 1.0 + 1e-9) {
            if (d_val < d_max) d_max = d_val;
        }
    }
    return d_max < 1e29 ? d_max : 1.0;
}

/* ---------------------------------------------------------------------------
 * compute_ideal_d — circular arc approximation
 * ------------------------------------------------------------------------ */

static double compute_ideal_d(Vec2 p0, Vec2 p3, int ea, int eb,
                               const Vec2 *normals)
{
    double n0x = normals[ea].x, n0y = normals[ea].y;
    double n3x = normals[eb].x, n3y = normals[eb].y;
    double dx = p3.x - p0.x, dy = p3.y - p0.y;

    double det = -n0y * n3x + n3y * n0x;
    if (fabs(det) < 1e-10) {
        double chord = hypot(dx, dy);
        if (ea == eb) return (4.0 / 3.0) * (chord / 2.0);
        return chord / 3.0;
    }

    double s_val = (dx * n3x + n3y * dy) / det;
    double r = fabs(s_val);
    if (r < 1e-10) return 0.3;

    double cx = p0.x + s_val * (-n0y);
    double cy = p0.y + s_val * n0x;

    double v0x = (p0.x - cx) / r, v0y = (p0.y - cy) / r;
    double v3x = (p3.x - cx) / r, v3y = (p3.y - cy) / r;
    double cos_theta = v0x * v3x + v0y * v3y;
    if (cos_theta < -1.0) cos_theta = -1.0;
    if (cos_theta > 1.0) cos_theta = 1.0;
    double theta = acos(cos_theta);

    if (theta < 1e-10) return 0.3;
    return (4.0 / 3.0) * r * tan(theta / 4.0);
}

/* ---------------------------------------------------------------------------
 * d_levels — quantization
 * ------------------------------------------------------------------------ */

static int compute_d_levels(double d_ideal, int n_levels,
                            double d_min, double d_max,
                            double *out)
{
    int count = 0;

    /* Generate uniform levels */
    for (int i = 0; i < n_levels; i++) {
        double t = (n_levels > 1) ? (double)i / (n_levels - 1) : 0.0;
        double val = round((d_min + t * (d_max - d_min)) * 1e6) / 1e6;
        /* Insert if not duplicate */
        bool dup = false;
        for (int j = 0; j < count; j++) {
            if (fabs(out[j] - val) < 1e-8) { dup = true; break; }
        }
        if (!dup) out[count++] = val;
    }

    /* Include d_ideal (capped) */
    double ideal_capped = round(fmin(d_ideal, d_max) * 1e6) / 1e6;
    bool dup = false;
    for (int j = 0; j < count; j++) {
        if (fabs(out[j] - ideal_capped) < 1e-8) { dup = true; break; }
    }
    if (!dup) out[count++] = ideal_capped;

    /* Sort */
    for (int i = 0; i < count - 1; i++)
        for (int j = i + 1; j < count; j++)
            if (out[j] < out[i]) { double tmp = out[i]; out[i] = out[j]; out[j] = tmp; }

    return count;
}

/* ---------------------------------------------------------------------------
 * auto_tune
 * ------------------------------------------------------------------------ */

static double compute_min_gap(const Vec2 *positions, const int *edges, int n_eps)
{
    double min_gap = 1.0;
    for (int i = 0; i < n_eps; i++) {
        for (int j = i + 1; j < n_eps; j++) {
            if (edges[i] != edges[j]) continue;
            double d = vec2_dist(positions[i], positions[j]);
            if (d > 1e-9 && d < min_gap) min_gap = d;
        }
    }
    return min_gap;
}

static void auto_tune(int n_arcs, double min_gap,
                      int *out_levels, int *out_res, int *out_stroke)
{
    int n_levels = 12 - n_arcs;
    if (n_levels < 4) n_levels = 4;

    int res_from_stroke = (int)ceil(2.0 / REL_STROKE);
    double gap_margin = min_gap - 2 * REL_STROKE;
    int res_from_gap = (gap_margin > 0.01) ? (int)ceil(2.0 / gap_margin) : 200;
    int bmp_res = res_from_stroke > res_from_gap ? res_from_stroke : res_from_gap;

    int stroke = (int)round(REL_STROKE * bmp_res);
    if (stroke < 2) stroke = 2;

    *out_levels = n_levels;
    *out_res = bmp_res;
    *out_stroke = stroke;
}

/* ---------------------------------------------------------------------------
 * Rasterize bezier directly into packed uint64 bitmap
 * ------------------------------------------------------------------------ */

static int rasterize_bezier_packed(Vec2 p0, Vec2 p1, Vec2 p2, Vec2 p3,
                                   int res, int stroke_half, int pack_len,
                                   uint64_t *out)
{
    memset(out, 0, pack_len * sizeof(uint64_t));
    int n_samples = res * 4;
    double scale = (double)(res - 1);
    int total_bits = res * res;

    for (int si = 0; si < n_samples; si++) {
        double t = (double)si / (n_samples - 1);
        double u = 1.0 - t;

        double x = u*u*u*p0.x + 3.0*u*u*t*p1.x + 3.0*u*t*t*p2.x + t*t*t*p3.x;
        double y = u*u*u*p0.y + 3.0*u*u*t*p1.y + 3.0*u*t*t*p2.y + t*t*t*p3.y;

        int px = (int)(x * scale + 0.5);
        int py = (int)(y * scale + 0.5);

        for (int dy = -stroke_half; dy <= stroke_half; dy++) {
            int ny = py + dy;
            if (ny < 0 || ny >= res) continue;
            for (int dx = -stroke_half; dx <= stroke_half; dx++) {
                int nx = px + dx;
                if (nx < 0 || nx >= res) continue;
                int idx = ny * res + nx;
                if (idx >= 0 && idx < total_bits) {
                    out[idx >> 6] |= 1ULL << (63 - (idx & 63));
                }
            }
        }
    }

    /* Popcount */
    int count = 0;
    for (int w = 0; w < pack_len; w++) {
        count += __builtin_popcountll(out[w]);
    }
    return count;
}

/* ---------------------------------------------------------------------------
 * State allocation / free
 * ------------------------------------------------------------------------ */

static bool solver_state_init(SolverState *s, int n_arcs, int max_variants,
                              int bmp_res)
{
    memset(s, 0, sizeof(*s));
    s->n_arcs = n_arcs;
    s->max_variants = max_variants;
    s->bmp_res = bmp_res;

    int total_bits = bmp_res * bmp_res;
    s->pack_len = (total_bits + 63) / 64;

    /* all_packed */
    size_t packed_size = (size_t)n_arcs * max_variants * s->pack_len * sizeof(uint64_t);
    s->all_packed = (uint64_t *)calloc(1, packed_size);
    if (!s->all_packed) return false;

    /* compat table — skip if too large (>512MB) */
    size_t compat_size = (size_t)n_arcs * n_arcs * max_variants * max_variants;
    if (compat_size <= 512ULL * 1024 * 1024) {
        s->compat = (bool *)calloc(1, compat_size);
        s->compat_valid = (s->compat != NULL);
    } else {
        s->compat = NULL;
        s->compat_valid = false;
    }

    return true;
}

static void solver_state_free(SolverState *s)
{
    free(s->all_packed);
    free(s->compat);
    memset(s, 0, sizeof(*s));
}

/* ---------------------------------------------------------------------------
 * Build all arc variants
 * ------------------------------------------------------------------------ */

static bool build_all_variants(const ArcGeom *arcs, int n_arcs,
                               int bmp_res, int stroke_width,
                               const Vec2 *normals,
                               SolverState *s)
{
    int stroke_half = stroke_width / 2;

    #pragma omp parallel for schedule(dynamic)
    for (int ai = 0; ai < n_arcs; ai++) {
        const ArcGeom *a = &arcs[ai];
        int count = 0;

        for (int i0 = 0; i0 < a->n_levels_0; i0++) {
            double d0 = a->levels_0[i0];
            for (int i1 = 0; i1 < a->n_levels_1; i1++) {
                double d1 = a->levels_1[i1];
                if (count >= MAX_VARIANTS) break;

                /* Build bezier */
                Vec2 p1 = { a->p0.x + d0 * normals[a->ea].x,
                            a->p0.y + d0 * normals[a->ea].y };
                Vec2 p2 = { a->p3.x + d1 * normals[a->eb].x,
                            a->p3.y + d1 * normals[a->eb].y };

                /* Rasterize directly into packed slot */
                uint64_t *slot = &s->all_packed[PACKED_IDX(s, ai, count, 0)];
                int pixels = rasterize_bezier_packed(a->p0, p1, p2, a->p3,
                                                     bmp_res, stroke_half,
                                                     s->pack_len, slot);

                /* Score with symmetry penalty */
                double dd = d0 - d1;
                int penalty = (int)(SYM_SCALE * dd * dd);
                s->pixel_counts[PIXEL_IDX(ai, count)] = pixels - penalty;
                s->variant_d0[PIXEL_IDX(ai, count)] = d0;
                s->variant_d1[PIXEL_IDX(ai, count)] = d1;
                count++;
            }
            if (count >= MAX_VARIANTS) break;
        }

        s->n_variants[ai] = count;
    }

    /* Check all arcs have variants */
    for (int ai = 0; ai < n_arcs; ai++) {
        if (s->n_variants[ai] == 0) return false;
    }
    return true;
}

/* ---------------------------------------------------------------------------
 * Build pairwise compatibility (OpenMP parallel)
 * ------------------------------------------------------------------------ */

static void build_compat(SolverState *s)
{
    if (!s->compat_valid) return;

    int n = s->n_arcs;
    int mv = s->max_variants;
    int pl = s->pack_len;

    /* Initialize all to compatible */
    size_t total = (size_t)n * n * mv * mv;
    memset(s->compat, 1, total);

    /* Build pair list for parallel iteration */
    int n_pairs = n * (n - 1) / 2;
    int pair_i[MAX_ARCS * MAX_ARCS], pair_j[MAX_ARCS * MAX_ARCS];
    {
        int pi = 0;
        for (int a = 0; a < n; a++)
            for (int b = a + 1; b < n; b++) {
                pair_i[pi] = a;
                pair_j[pi] = b;
                pi++;
            }
    }

    #pragma omp parallel for schedule(dynamic)
    for (int idx = 0; idx < n_pairs; idx++) {
        int i = pair_i[idx];
        int j = pair_j[idx];

        for (int vi = 0; vi < s->n_variants[i]; vi++) {
            for (int vj = 0; vj < s->n_variants[j]; vj++) {
                bool overlaps = false;
                for (int w = 0; w < pl; w++) {
                    if (s->all_packed[PACKED_IDX(s, i, vi, w)] &
                        s->all_packed[PACKED_IDX(s, j, vj, w)]) {
                        overlaps = true;
                        break;
                    }
                }
                if (overlaps) {
                    s->compat[COMPAT_IDX(s, i, j, vi, vj)] = false;
                    s->compat[COMPAT_IDX(s, j, i, vj, vi)] = false;
                }
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * AC-3 arc consistency elimination
 * ------------------------------------------------------------------------ */

static void ac3_eliminate(SolverState *s)
{
    int n = s->n_arcs;
    int mv = s->max_variants;

    /* Init all as viable */
    for (int i = 0; i < n; i++)
        for (int vi = 0; vi < s->n_variants[i]; vi++)
            s->viable[i * mv + vi] = true;

    if (!s->compat_valid) return;

    bool changed = true;
    while (changed) {
        changed = false;
        for (int i = 0; i < n; i++) {
            for (int vi = 0; vi < s->n_variants[i]; vi++) {
                if (!s->viable[i * mv + vi]) continue;
                for (int j = 0; j < n; j++) {
                    if (i == j) continue;
                    bool has_compat = false;
                    for (int vj = 0; vj < s->n_variants[j]; vj++) {
                        if (s->viable[j * mv + vj] &&
                            s->compat[COMPAT_IDX(s, i, j, vi, vj)]) {
                            has_compat = true;
                            break;
                        }
                    }
                    if (!has_compat) {
                        s->viable[i * mv + vi] = false;
                        changed = true;
                        break;
                    }
                }
            }
        }
    }
}

/* ---------------------------------------------------------------------------
 * Build viable lists sorted by score, compute search order
 * ------------------------------------------------------------------------ */

static void build_viable_lists(SolverState *s)
{
    int n = s->n_arcs;
    int mv = s->max_variants;

    for (int i = 0; i < n; i++) {
        int count = 0;
        for (int vi = 0; vi < s->n_variants[i]; vi++) {
            if (s->viable[i * mv + vi]) {
                s->viable_lists[i * mv + count] = vi;
                count++;
            }
        }
        s->n_viable[i] = count;

        /* Sort by descending pixel_counts (insertion sort, small arrays) */
        int32_t *list = &s->viable_lists[i * mv];
        for (int a = 1; a < count; a++) {
            int32_t key = list[a];
            int32_t key_score = s->pixel_counts[PIXEL_IDX(i, key)];
            int b = a - 1;
            while (b >= 0 && s->pixel_counts[PIXEL_IDX(i, list[b])] < key_score) {
                list[b + 1] = list[b];
                b--;
            }
            list[b + 1] = key;
        }
    }

    /* Search order: most constrained first */
    for (int i = 0; i < n; i++) s->order[i] = i;
    for (int a = 0; a < n - 1; a++)
        for (int b = a + 1; b < n; b++)
            if (s->n_viable[s->order[b]] < s->n_viable[s->order[a]]) {
                int32_t tmp = s->order[a];
                s->order[a] = s->order[b];
                s->order[b] = tmp;
            }
}

/* ---------------------------------------------------------------------------
 * Backtracking search (single subtree)
 * ------------------------------------------------------------------------ */

static void search_subtree(const SolverState *s,
                           const uint64_t *init_composite,
                           const int32_t *init_chosen,
                           int start_depth,
                           int max_solutions, int max_nodes,
                           int32_t *best_chosen,
                           int64_t *best_ink,
                           int64_t *n_found)
{
    int n = s->n_arcs;
    int pl = s->pack_len;
    int mv = s->max_variants;

    int32_t chosen[MAX_ARCS];
    memcpy(chosen, init_chosen, n * sizeof(int32_t));
    memset(best_chosen, -1, n * sizeof(int32_t));

    /* composites[depth][pack_len] — heap to avoid large stack in threads */
    uint64_t *composites = (uint64_t *)malloc((n + 1) * pl * sizeof(uint64_t));
    if (!composites) { *best_ink = -1; *n_found = 0; return; }
    memcpy(&composites[start_depth * pl], init_composite, pl * sizeof(uint64_t));

    int32_t pos[MAX_ARCS];
    memset(pos, 0, sizeof(pos));

    *best_ink = -1;
    *n_found = 0;
    int64_t nodes = 0;
    int depth = start_depth;

    while (depth >= start_depth) {
        if (*n_found >= max_solutions) break;
        nodes++;
        if (max_nodes > 0 && nodes >= max_nodes) break;

        if (depth == n) {
            (*n_found)++;
            int64_t ink = 0;
            for (int i = 0; i < n; i++)
                ink += s->pixel_counts[PIXEL_IDX(i, chosen[i])];
            if (ink > *best_ink) {
                *best_ink = ink;
                memcpy(best_chosen, chosen, n * sizeof(int32_t));
            }
            depth--;
            if (depth >= start_depth) {
                chosen[s->order[depth]] = -1;
                pos[depth]++;
            }
            continue;
        }

        int ai = s->order[depth];
        bool found_next = false;

        while (pos[depth] < s->n_viable[ai]) {
            int vi = s->viable_lists[ai * mv + pos[depth]];

            /* Check overlap against composite */
            bool overlaps = false;
            const uint64_t *var_packed = &s->all_packed[PACKED_IDX(s, ai, vi, 0)];
            const uint64_t *comp = &composites[depth * pl];
            for (int w = 0; w < pl; w++) {
                if (var_packed[w] & comp[w]) {
                    overlaps = true;
                    break;
                }
            }

            if (!overlaps) {
                chosen[ai] = vi;
                uint64_t *next_comp = &composites[(depth + 1) * pl];
                for (int w = 0; w < pl; w++)
                    next_comp[w] = comp[w] | var_packed[w];
                depth++;
                pos[depth] = 0;
                found_next = true;
                break;
            }
            pos[depth]++;
        }

        if (!found_next) {
            chosen[ai] = -1;
            depth--;
            if (depth >= start_depth)
                pos[depth]++;
        }
    }

    free(composites);
}

/* ---------------------------------------------------------------------------
 * Parallel search (split first arc across threads)
 * ------------------------------------------------------------------------ */

static bool parallel_search(SolverState *s, int32_t *out_chosen)
{
    int n = s->n_arcs;
    int pl = s->pack_len;
    int mv = s->max_variants;

    int first_arc = s->order[0];
    int n_first = s->n_viable[first_arc];

    if (n_first == 0) return false;

    /* Per-thread results */
    int32_t *thread_best = (int32_t *)calloc(n_first * n, sizeof(int32_t));
    int64_t *thread_ink  = (int64_t *)malloc(n_first * sizeof(int64_t));
    int64_t *thread_count = (int64_t *)calloc(n_first, sizeof(int64_t));
    if (!thread_best || !thread_ink || !thread_count) {
        free(thread_best); free(thread_ink); free(thread_count);
        return false;
    }

    for (int i = 0; i < n_first; i++) thread_ink[i] = -1;

    #pragma omp parallel for schedule(dynamic)
    for (int fi = 0; fi < n_first; fi++) {
        int vi = s->viable_lists[first_arc * mv + fi];

        int32_t init_chosen[MAX_ARCS];
        memset(init_chosen, -1, n * sizeof(int32_t));
        init_chosen[first_arc] = vi;

        uint64_t *init_composite = (uint64_t *)malloc(pl * sizeof(uint64_t));
        if (!init_composite) continue;
        memcpy(init_composite, &s->all_packed[PACKED_IDX(s, first_arc, vi, 0)],
               pl * sizeof(uint64_t));

        search_subtree(s, init_composite, init_chosen, 1,
                       MAX_SOLUTIONS, MAX_NODES,
                       &thread_best[fi * n],
                       &thread_ink[fi],
                       &thread_count[fi]);

        free(init_composite);
    }

    /* Combine: pick best ink */
    int64_t best_ink = -1;
    int64_t total_found = 0;
    int best_fi = -1;

    for (int fi = 0; fi < n_first; fi++) {
        total_found += thread_count[fi];
        if (thread_ink[fi] > best_ink) {
            best_ink = thread_ink[fi];
            best_fi = fi;
        }
    }

    bool ok = (best_fi >= 0 && best_ink >= 0);
    if (ok) {
        memcpy(out_chosen, &thread_best[best_fi * n], n * sizeof(int32_t));
        /* Verify all chosen are valid */
        for (int i = 0; i < n; i++) {
            if (out_chosen[i] < 0) { ok = false; break; }
        }
    }

    if (g_verbose)
        fprintf(stderr, "  search: %lld configs, best ink=%lld\n",
                (long long)total_found, (long long)best_ink);

    free(thread_best);
    free(thread_ink);
    free(thread_count);
    return ok;
}

/* ---------------------------------------------------------------------------
 * Top-level solver
 * ------------------------------------------------------------------------ */

bool solve_tile(const SolverInput *input, SolverResult *result)
{
    result->n_arcs = input->n_arcs;
    result->ok = false;

    if (input->n_arcs == 0) {
        result->ok = true;
        return true;
    }
    if (input->n_arcs > MAX_ARCS) {
        fprintf(stderr, "Too many arcs: %d > %d\n", input->n_arcs, MAX_ARCS);
        return false;
    }

    int n_arcs = input->n_arcs;

    /* Compute per-arc geometry */
    ArcGeom arcs[MAX_ARCS];
    for (int ai = 0; ai < n_arcs; ai++) {
        int a = input->matching[2 * ai];
        int b = input->matching[2 * ai + 1];
        ArcGeom *g = &arcs[ai];
        g->p0 = input->positions[a];
        g->p3 = input->positions[b];
        g->ea = input->edge_indices[a];
        g->eb = input->edge_indices[b];
        g->d_ideal = compute_ideal_d(g->p0, g->p3, g->ea, g->eb,
                                      input->edge_normals);

        double chord = vec2_dist(g->p0, g->p3);
        double d_chord_max = (2.0 / 3.0) * chord;

        g->d0_max = max_d_for_polygon(g->p0, input->edge_normals[g->ea],
                                       input->corners, input->n_corners);
        if (g->d0_max > d_chord_max) g->d0_max = d_chord_max;

        g->d1_max = max_d_for_polygon(g->p3, input->edge_normals[g->eb],
                                       input->corners, input->n_corners);
        if (g->d1_max > d_chord_max) g->d1_max = d_chord_max;
    }

    /* Auto-tune */
    double min_gap = compute_min_gap(input->positions, input->edge_indices,
                                     input->n_eps);
    int n_levels, bmp_res, stroke_width;
    auto_tune(n_arcs, min_gap, &n_levels, &bmp_res, &stroke_width);

    if (g_verbose)
        fprintf(stderr, "  auto-tune: %d arcs, min_gap=%.3f, levels=%d, "
                "res=%d, stroke=%dpx (%.1f%%)\n",
                n_arcs, min_gap, n_levels, bmp_res, stroke_width,
                (double)stroke_width / bmp_res * 100.0);

    /* Retry loop: reduce stroke on failure */
    for (int attempt = 0; attempt < stroke_width; attempt++) {
        int sw = stroke_width - attempt;
        if (sw < 1) break;

        /* Compute d levels for this attempt */
        int max_v = 0;
        for (int ai = 0; ai < n_arcs; ai++) {
            ArcGeom *g = &arcs[ai];
            g->n_levels_0 = compute_d_levels(g->d_ideal, n_levels, 0.05,
                                              g->d0_max, g->levels_0);
            g->n_levels_1 = compute_d_levels(g->d_ideal, n_levels, 0.05,
                                              g->d1_max, g->levels_1);
            int nv = g->n_levels_0 * g->n_levels_1;
            if (nv > max_v) max_v = nv;
        }
        if (max_v > MAX_VARIANTS) max_v = MAX_VARIANTS;

        /* Allocate state */
        SolverState state;
        if (!solver_state_init(&state, n_arcs, max_v, bmp_res)) {
            if (g_verbose) fprintf(stderr, "  allocation failed\n");
            continue;
        }

        if (g_verbose)
            fprintf(stderr, "  attempt %d: stroke=%dpx, max_variants=%d\n",
                    attempt, sw, max_v);

        /* Build variants */
        if (!build_all_variants(arcs, n_arcs, bmp_res, sw,
                                input->edge_normals, &state)) {
            if (g_verbose)
                fprintf(stderr, "  no valid variants, reducing stroke...\n");
            solver_state_free(&state);
            continue;
        }

        /* Compat + AC-3 */
        build_compat(&state);
        ac3_eliminate(&state);
        build_viable_lists(&state);

        /* Check viability */
        bool any_empty = false;
        for (int i = 0; i < n_arcs; i++) {
            if (state.n_viable[i] == 0) {
                if (g_verbose)
                    fprintf(stderr, "  WARNING: arc %d has no viable variants "
                            "after AC-3\n", i);
                any_empty = true;
            }
        }

        if (any_empty) {
            solver_state_free(&state);
            continue;
        }

        /* Search */
        int32_t chosen[MAX_ARCS];
        if (parallel_search(&state, chosen)) {
            /* Extract results */
            for (int ai = 0; ai < n_arcs; ai++) {
                int vi = chosen[ai];
                result->d0[ai] = state.variant_d0[PIXEL_IDX(ai, vi)];
                result->d1[ai] = state.variant_d1[PIXEL_IDX(ai, vi)];
                const ArcGeom *a = &arcs[ai];
                result->d0_idx[ai] = vi / a->n_levels_1;
                result->d1_idx[ai] = vi % a->n_levels_1;
            }
            result->ok = true;
            solver_state_free(&state);
            return true;
        }

        if (g_verbose)
            fprintf(stderr, "  no solution, reducing stroke...\n");
        solver_state_free(&state);
    }

    return false;
}

/* ---------------------------------------------------------------------------
 * CLI main — reads geometry from stdin, writes d0/d1 to stdout
 *
 * Input format (text):
 *   n_eps n_edges n_corners n_arcs
 *   positions: x0 y0 x1 y1 ...      (n_eps * 2 doubles)
 *   edge_indices: e0 e1 ...          (n_eps ints)
 *   edge_normals: nx0 ny0 nx1 ny1 .. (n_edges * 2 doubles)
 *   corners: cx0 cy0 cx1 cy1 ...     (n_corners * 2 doubles)
 *   matching: a0 b0 a1 b1 ...        (n_arcs * 2 ints)
 *
 * Output format (text):
 *   d0_0 d1_0
 *   d0_1 d1_1
 *   ...
 * ------------------------------------------------------------------------ */

#ifndef TILE_SOLVER_NO_MAIN

int main(int argc, char **argv)
{
    int n_eps, n_edges, n_corners, n_arcs;
    if (scanf("%d %d %d %d", &n_eps, &n_edges, &n_corners, &n_arcs) != 4) {
        fprintf(stderr, "Expected: n_eps n_edges n_corners n_arcs\n");
        return 1;
    }

    Vec2 *positions = (Vec2 *)malloc(n_eps * sizeof(Vec2));
    int  *edge_indices = (int *)malloc(n_eps * sizeof(int));
    Vec2 *normals = (Vec2 *)malloc(n_edges * sizeof(Vec2));
    Vec2 *corners = (Vec2 *)malloc(n_corners * sizeof(Vec2));
    int  *matching = (int *)malloc(2 * n_arcs * sizeof(int));

    for (int i = 0; i < n_eps; i++)
        scanf("%lf %lf", &positions[i].x, &positions[i].y);
    for (int i = 0; i < n_eps; i++)
        scanf("%d", &edge_indices[i]);
    for (int i = 0; i < n_edges; i++)
        scanf("%lf %lf", &normals[i].x, &normals[i].y);
    for (int i = 0; i < n_corners; i++)
        scanf("%lf %lf", &corners[i].x, &corners[i].y);
    for (int i = 0; i < 2 * n_arcs; i++)
        scanf("%d", &matching[i]);

    SolverInput input = {
        .n_eps = n_eps,
        .positions = positions,
        .edge_indices = edge_indices,
        .n_edges = n_edges,
        .edge_normals = normals,
        .n_corners = n_corners,
        .corners = corners,
        .n_arcs = n_arcs,
        .matching = matching,
    };

    SolverResult result;
    solve_tile(&input, &result);

    if (result.ok) {
        for (int i = 0; i < n_arcs; i++) {
            printf("%.6f %.6f\n", result.d0[i], result.d1[i]);
        }
    } else {
        fprintf(stderr, "FAILED: no solution found\n");
        free(positions); free(edge_indices); free(normals);
        free(corners); free(matching);
        return 1;
    }

    free(positions); free(edge_indices); free(normals);
    free(corners); free(matching);
    return 0;
}

#endif /* TILE_SOLVER_NO_MAIN */
