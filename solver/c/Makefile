all: truchet truchet.opt

truchet: truchet.c tile_solver.c
	$(CC) -O2 -fopenmp -o $@ $< -lm

truchet.opt: truchet.c tile_solver.c
	$(CC) -O3 -flto -march=native -mtune=native -ffast-math -fopenmp -DNDEBUG -o $@ $< -lm

# ---------------------------------------------------------------------------
# WebAssembly build (wasm32, single-threaded, no OpenMP)
#
# Uses the official Zig toolchain from ziglang.org as the C cross-compiler,
# pinned by version and SHA-256 and unpacked locally under zig/ (nothing is
# installed system-wide; Zig's caches are kept under zig/cache too).
# The hash below is for the x86_64-linux tarball; for another host set
# ZIG_HOST and ZIG_SHA256 from https://ziglang.org/download/index.json
# ---------------------------------------------------------------------------

ZIG_VERSION := 0.17.1
ZIG_HOST    := x86_64-linux
ZIG_SHA256  := 3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a
ZIG_NAME    := zig-$(ZIG_HOST)-$(ZIG_VERSION)
ZIG_URL     := https://ziglang.org/download/$(ZIG_VERSION)/$(ZIG_NAME).tar.xz
ZIG         := zig/$(ZIG_NAME)/zig
ZIG_ENV     := ZIG_GLOBAL_CACHE_DIR=$(CURDIR)/zig/cache ZIG_LOCAL_CACHE_DIR=$(CURDIR)/zig/cache

# Download, verify against the pinned hash, then extract
zig/.installed-$(ZIG_NAME):
	@mkdir -p zig
	curl -fsSL -o zig/$(ZIG_NAME).tar.xz $(ZIG_URL)
	echo "$(ZIG_SHA256)  zig/$(ZIG_NAME).tar.xz" | sha256sum -c -
	tar -xJf zig/$(ZIG_NAME).tar.xz -C zig
	@rm zig/$(ZIG_NAME).tar.xz
	@touch $@

$(ZIG): zig/.installed-$(ZIG_NAME)

wasm: truchet.wasm truchet_svg.wasm

# WASI command module: same CLI as the native binary. The solver keeps a
# few MB of working state on the stack, hence the explicit stack size.
truchet.wasm: truchet.c tile_solver.c $(ZIG)
	$(ZIG_ENV) $(ZIG) cc -target wasm32-wasi -O2 -DNDEBUG \
		-Wl,-z,stack-size=16777216 -o $@ $< -lm

# Library module for production: one exported function, truchet_svg(), that
# returns the tile's SVG (see truchet_wasm.c). No main, no imports, stripped.
truchet_svg.wasm: truchet_wasm.c truchet.c tile_solver.c $(ZIG)
	$(ZIG_ENV) $(ZIG) cc -target wasm32-wasi -mexec-model=reactor -O2 -DNDEBUG -s \
		-Wl,-z,stack-size=1048576 -o $@ $< -lm

clean:
	rm -f truchet truchet.opt truchet.wasm truchet_svg.wasm

.PHONY: all wasm clean
