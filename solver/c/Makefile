all: truchet truchet.opt

truchet: truchet.c tile_solver.c
	$(CC) -O2 -fopenmp -o $@ $< -lm

truchet.opt: truchet.c tile_solver.c
	$(CC) -O3 -flto -march=native -mtune=native -ffast-math -fopenmp -DNDEBUG -o $@ $< -lm