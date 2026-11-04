/**
 * Flat-array N×N matrices for ecological networks.
 *
 * WGSL's matrix types stop at mat4x4, and ecosystem models (Silver Springs,
 * the Schlei Fjord, …; Li et al., 2010; Patterson, 2012) need N > 4, so
 * matrices are row-major flat arrays indexed with [row * N + col].
 *
 * WGSL can't pass runtime-sized arrays to functions, or return them, and
 * (without the unrestricted_pointer_parameters extension) can't pass
 * pointers to workgroup memory either. So the library works on a matrix and
 * vector staged in workgroup memory, which is also where a workgroup that
 * cooperates on one ecosystem wants them: invocation i computes row i of
 * dx/dt = C x, every invocation reading the shared x.
 */

/** Largest network a kernel handles: one invocation per compartment. */
export const MAX_N = 32;

export const MATRIX_WGSL = /* wgsl */ `
// ---- Flat-array matrix library: M[row * n + col], row-major ----

const MAX_N: u32 = ${MAX_N}u;

// The matrix and vector a workgroup works on, n <= MAX_N.
var<workgroup> wg_matrix: array<f32, ${MAX_N * MAX_N}>;
var<workgroup> wg_vector: array<f32, ${MAX_N}>;

fn flat_index(row: u32, col: u32, n: u32) -> u32 {
  return row * n + col;
}

// Row \`row\` of wg_matrix · wg_vector.
fn mat_vec_row(row: u32, n: u32) -> f32 {
  var sum = 0.0;
  for (var col = 0u; col < n; col++) {
    sum += wg_matrix[flat_index(row, col, n)] * wg_vector[col];
  }
  return sum;
}

// The whole product wg_matrix · wg_vector (n x 1), for a single invocation.
fn mat_vec_mult(n: u32) -> array<f32, ${MAX_N}> {
  var out: array<f32, ${MAX_N}>;
  for (var row = 0u; row < n; row++) {
    out[row] = mat_vec_row(row, n);
  }
  return out;
}
`;

export function flatIndex(row: number, col: number, n: number): number {
  return row * n + col;
}

/** matrix (n×n, row-major) · vector (n). */
export function matVecMult(matrix: ArrayLike<number>, vector: ArrayLike<number>, n: number): number[] {
  const out = Array.from({ length: n }, () => 0);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) out[row] += matrix[flatIndex(row, col, n)] * vector[col];
  }
  return out;
}

/** Solves M x = b by Gaussian elimination with partial pivoting. */
export function solve(matrix: ArrayLike<number>, b: ArrayLike<number>, n: number): number[] {
  const m = Array.from({ length: n }, (_, r) => [
    ...Array.from({ length: n }, (_, c) => matrix[flatIndex(r, c, n)]),
    b[r],
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-300) throw new RangeError('The matrix is singular');
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = Array.from({ length: n }, () => 0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];
    for (let c = r + 1; c < n; c++) sum -= m[r][c] * x[c];
    x[r] = sum / m[r][r];
  }
  return x;
}
