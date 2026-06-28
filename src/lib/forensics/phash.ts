/**
 * Perceptual hash (pHash) — Prompt 8.
 *
 * Server-only. Turns an image buffer into a compact 64-bit fingerprint that is
 * stable across JPEG re-encoding, mild rescaling, and brightness shifts — so the
 * same spoilage photo re-used across write-offs produces a near-identical hash
 * and is caught by Hamming-distance dedup in `run.ts`.
 *
 * Pipeline: sharp → grayscale → resize 32×32 → 2D DCT-II → take the top-left 8×8
 * coefficients → threshold the 63 AC terms against their median → 64-bit hash
 * packed into 16 hex chars. The DC term is dropped (it carries only average
 * brightness, no perceptual structure).
 *
 * The DCT is computed by hand (no native deps) and only the 8×8 block we need is
 * materialised, so the whole thing is a few thousand float ops per photo. The
 * 64-bit hash is held as two 32-bit halves (no BigInt — the project targets
 * ES2017).
 */

import sharp from "sharp";

// ── Tuning ────────────────────────────────────────────────────────────────────

const PHASH_RESIZE = 32; // pre-DCT side length
const PHASH_BLOCK = 8; // DCT block side → 8×8 = 64 coefficients
const PHASH_BITS = PHASH_BLOCK * PHASH_BLOCK; // 64-bit hash
const PHASH_HEX_LEN = PHASH_BITS / 4; // 16 hex chars
const PHASH_LO_BITS = PHASH_BITS / 2; // 32 bits per half

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute a 64-bit perceptual hash for `bytes`. Returns a 16-char lowercase hex
 * string. Throws on any sharp/decode failure — the caller degrades gracefully.
 */
export async function computePHash(bytes: Buffer): Promise<string> {
  const { data } = await sharp(bytes)
    .grayscale()
    .resize(PHASH_RESIZE, PHASH_RESIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Build the 32×32 single-channel matrix. raw grayscale → one byte per pixel.
  const n = PHASH_RESIZE;
  const matrix: number[][] = Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) => data[y * n + x]),
  );

  const block = dct2DTopLeft(matrix, n, PHASH_BLOCK);

  // Flatten row-major; drop the DC term (index 0); median-threshold the rest.
  const flat = block.flat();
  const ac = flat.slice(1);
  const median = medianOf(ac);

  // Pack 64 bits MSB-first into two unsigned 32-bit halves. The DC slot (i=0)
  // is left at 0 — it carries no perceptual info, so a constant bit there would
  // only waste dynamic range.
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < PHASH_BITS; i++) {
    if (flat[i] <= median) continue;
    if (i < PHASH_LO_BITS) {
      hi = (hi | (1 << (PHASH_LO_BITS - 1 - i))) >>> 0;
    } else {
      lo = (lo | (1 << (PHASH_BITS - 1 - i))) >>> 0;
    }
  }
  return (
    (hi >>> 0).toString(16).padStart(PHASH_HEX_LEN / 2, "0") +
    (lo >>> 0).toString(16).padStart(PHASH_HEX_LEN / 2, "0")
  );
}

/**
 * Hamming distance between two hex hashes (number of differing bits).
 * Returns `Number.MAX_SAFE_INTEGER` for mismatched/invalid lengths so callers
 * can treat it as "never a match" without special-casing.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== PHASH_HEX_LEN || b.length !== PHASH_HEX_LEN) {
    return Number.MAX_SAFE_INTEGER;
  }
  const x = hexToHalves(a);
  const y = hexToHalves(b);
  return popcount32((x.hi ^ y.hi) >>> 0) + popcount32((x.lo ^ y.lo) >>> 0);
}

// ── Bit helpers (32-bit, BigInt-free) ─────────────────────────────────────────

function hexToHalves(h: string): { hi: number; lo: number } {
  const half = PHASH_HEX_LEN / 2;
  return {
    hi: parseInt(h.slice(0, half), 16) >>> 0,
    lo: parseInt(h.slice(half), 16) >>> 0,
  };
}

/** Population count of an unsigned 32-bit integer. */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

// ── DCT-II ────────────────────────────────────────────────────────────────────

/**
 * Separable 2D DCT-II, computing only the top-left `k×k` coefficients of an
 * `n×n` matrix. F[u][v] = α(u)·α(v) · Σ_x Σ_y f[y][x]·cos((2y+1)uπ/2n)·cos((2x+1)vπ/2n).
 */
function dct2DTopLeft(matrix: number[][], n: number, k: number): number[][] {
  // Precompute the cosine basis once: cosTable[p][q] = cos((2q+1)·p·π / 2n).
  const cosTable: Float64Array[] = [];
  for (let p = 0; p < k; p++) {
    const row = new Float64Array(n);
    for (let q = 0; q < n; q++) {
      row[q] = Math.cos(((2 * q + 1) * p * Math.PI) / (2 * n));
    }
    cosTable.push(row);
  }
  const alpha = (p: number) => (p === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n));

  // Pass 1 — transform over rows (y) for every column x.
  const g: number[][] = Array.from({ length: k }, () => new Array<number>(n).fill(0));
  for (let u = 0; u < k; u++) {
    const au = alpha(u);
    const cosU = cosTable[u];
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let y = 0; y < n; y++) s += matrix[y][x] * cosU[y];
      g[u][x] = au * s;
    }
  }

  // Pass 2 — transform over columns (x) for the k×k output.
  const F: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let u = 0; u < k; u++) {
    const gU = g[u];
    for (let v = 0; v < k; v++) {
      const av = alpha(v);
      const cosV = cosTable[v];
      let s = 0;
      for (let x = 0; x < n; x++) s += gU[x] * cosV[x];
      F[u][v] = av * s;
    }
  }
  return F;
}

/** Median of a numeric array (does not mutate the input). */
function medianOf(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
