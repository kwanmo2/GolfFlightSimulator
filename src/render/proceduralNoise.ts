/**
 * Deterministic hashing and noise shared by the procedural scene builders, so
 * the course, its colouring and its props come out identical on every load.
 */

export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

export const clamp01 = (value: number): number => clamp(value, 0, 1);

export const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Pseudo-random value in [0, 1) from a single seed. */
export const hash = (seed: number): number => {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
};

/** Pseudo-random value in [0, 1) from a 2D lattice point. */
export const hash2 = (x: number, z: number): number => {
  const value = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return value - Math.floor(value);
};

/** Smooth value noise in [0, 1] from bilinear blending of hash2 on an integer lattice. */
export const valueNoise = (x: number, z: number): number => {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const top = hash2(x0, z0) + (hash2(x0 + 1, z0) - hash2(x0, z0)) * sx;
  const bottom = hash2(x0, z0 + 1) + (hash2(x0 + 1, z0 + 1) - hash2(x0, z0 + 1)) * sx;
  return top + (bottom - top) * sz;
};

/**
 * Seeded sequence of pseudo-random values in [0, 1) (mulberry32). Use it where
 * many draws are needed in order, such as growing a tree, so each seed always
 * gives the same result.
 */
export const mulberry32 = (seed: number): (() => number) => {
  let state = Math.floor(seed * 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
