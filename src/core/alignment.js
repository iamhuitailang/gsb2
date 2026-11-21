/**
 * Similarity-transform helpers shared by the browser app and the unit tests.
 *
 * An alignment maps pixels of image B into image A's coordinate space:
 *
 *   world = R(rotation) * scale * b + (tx, ty)
 *
 * where `world` and `b` are pixel coordinates measured from the top-left
 * corner.  Four degrees of freedom: translation, uniform scale, rotation.
 */

export const DEFAULT_ALIGNMENT = Object.freeze({
  tx: 0,
  ty: 0,
  scale: 1,
  rotation: 0,
});

const MIN_SCALE = 0.02;
const MAX_SCALE = 40;

export function clampScale(value) {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export function normalizeRotation(rotation) {
  if (!Number.isFinite(rotation)) return 0;
  const twoPi = Math.PI * 2;
  let r = rotation % twoPi;
  if (r > Math.PI) r -= twoPi;
  if (r < -Math.PI) r += twoPi;
  return r;
}

export function normalizeAlignment(input = {}) {
  return {
    tx: Number.isFinite(input.tx) ? input.tx : 0,
    ty: Number.isFinite(input.ty) ? input.ty : 0,
    scale: clampScale(input.scale),
    rotation: normalizeRotation(input.rotation),
  };
}

/** Centered, unscaled alignment for two differently sized images. */
export function centeredAlignment(widthA, heightA, widthB, heightB) {
  return {
    tx: (widthA - widthB) / 2,
    ty: (heightA - heightB) / 2,
    scale: 1,
    rotation: 0,
  };
}

/** Canvas-style affine matrix [a c e; b d f]. */
export function matrixFromAlignment(alignment = DEFAULT_ALIGNMENT) {
  const al = normalizeAlignment(alignment);
  const cos = Math.cos(al.rotation);
  const sin = Math.sin(al.rotation);
  const s = al.scale;
  return {
    a: s * cos,
    b: s * sin,
    c: -s * sin,
    d: s * cos,
    e: al.tx,
    f: al.ty,
  };
}

export function applyMatrix(matrix, x, y) {
  return {
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f,
  };
}

export function invertMatrix(matrix) {
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  return {
    a: matrix.d * inv,
    b: -matrix.b * inv,
    c: -matrix.c * inv,
    d: matrix.a * inv,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) * inv,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) * inv,
  };
}

export function mapPoint(alignment, x, y) {
  return applyMatrix(matrixFromAlignment(alignment), x, y);
}

export function transformIsUsable(alignment) {
  return Boolean(invertMatrix(matrixFromAlignment(alignment)));
}

/** Bounding box of image B after alignment, expressed in A coordinates. */
export function transformedBounds(alignment, widthB, heightB) {
  const corners = [
    mapPoint(alignment, 0, 0),
    mapPoint(alignment, widthB, 0),
    mapPoint(alignment, widthB, heightB),
    mapPoint(alignment, 0, heightB),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Union of image A and the aligned image B. */
export function comparisonBounds(widthA, heightA, alignment, widthB, heightB) {
  const b = transformedBounds(alignment, widthB, heightB);
  return {
    minX: Math.min(0, b.minX),
    minY: Math.min(0, b.minY),
    maxX: Math.max(widthA, b.maxX),
    maxY: Math.max(heightA, b.maxY),
  };
}

/**
 * Least-squares similarity fit b -> a for two or more point pairs.
 * Accepts pairs as { ax, ay, bx, by } or { a: {x, y}, b: {x, y} }.
 */
export function solveSimilarity(pairs) {
  const points = (pairs || [])
    .map((pair) => {
      const ax = pair.ax ?? pair.a?.x;
      const ay = pair.ay ?? pair.a?.y;
      const bx = pair.bx ?? pair.b?.x;
      const by = pair.by ?? pair.b?.y;
      if (![ax, ay, bx, by].every(Number.isFinite)) return null;
      return { ax, ay, bx, by };
    })
    .filter(Boolean);

  if (points.length < 2) {
    return {
      ok: false,
      error: '至少需要 2 对角点',
      count: points.length,
    };
  }

  const n = points.length;
  const meanA = points.reduce(
    (acc, p) => ({ x: acc.x + p.ax / n, y: acc.y + p.ay / n }),
    { x: 0, y: 0 },
  );
  const meanB = points.reduce(
    (acc, p) => ({ x: acc.x + p.bx / n, y: acc.y + p.by / n }),
    { x: 0, y: 0 },
  );

  let den = 0;
  let sc = 0;
  let ss = 0;
  for (const p of points) {
    const bx = p.bx - meanB.x;
    const by = p.by - meanB.y;
    const ax = p.ax - meanA.x;
    const ay = p.ay - meanA.y;
    den += bx * bx + by * by;
    sc += ax * bx + ay * by;
    ss += ay * bx - ax * by;
  }

  if (den < 1e-9) {
    return {
      ok: false,
      error: 'B 图上的角点过于接近，请分散选取',
      count: n,
    };
  }

  const scale = Math.hypot(sc, ss) / den;
  const rotation = Math.atan2(ss, sc);
  const tx = meanA.x - (sc * meanB.x - ss * meanB.y) / den;
  const ty = meanA.y - (ss * meanB.x + sc * meanB.y) / den;
  const alignment = normalizeAlignment({ tx, ty, scale, rotation });

  let sumSq = 0;
  let maxError = 0;
  const residuals = points.map((p) => {
    const mapped = mapPoint(alignment, p.bx, p.by);
    const error = Math.hypot(mapped.x - p.ax, mapped.y - p.ay);
    sumSq += error * error;
    maxError = Math.max(maxError, error);
    return error;
  });

  return {
    ok: true,
    alignment,
    count: n,
    rms: Math.sqrt(sumSq / n),
    maxError,
    residuals,
  };
}

/**
 * Change scale while keeping `pivot` (in B coordinates) fixed on screen.
 * This makes the numeric scale control feel natural: the image grows/shrinks
 * around its center instead of its top-left corner.
 */
export function scaleAroundPivot(alignment, scale, pivot) {
  const fixed = mapPoint(alignment, pivot.x, pivot.y);
  const next = normalizeAlignment({ ...alignment, scale });
  const cos = Math.cos(next.rotation);
  const sin = Math.sin(next.rotation);
  const px = next.scale * (cos * pivot.x - sin * pivot.y);
  const py = next.scale * (sin * pivot.x + cos * pivot.y);
  return normalizeAlignment({
    ...next,
    tx: fixed.x - px,
    ty: fixed.y - py,
  });
}

/** Rotate (radians) while keeping `pivot` (in B coordinates) fixed. */
export function rotateAroundPivot(alignment, rotation, pivot) {
  const fixed = mapPoint(alignment, pivot.x, pivot.y);
  const next = normalizeAlignment({ ...alignment, rotation });
  const cos = Math.cos(next.rotation);
  const sin = Math.sin(next.rotation);
  const px = next.scale * (cos * pivot.x - sin * pivot.y);
  const py = next.scale * (sin * pivot.x + cos * pivot.y);
  return normalizeAlignment({
    ...next,
    tx: fixed.x - px,
    ty: fixed.y - py,
  });
}

export function translationStep(alignment, dx, dy) {
  return normalizeAlignment({ ...alignment, tx: alignment.tx + dx, ty: alignment.ty + dy });
}

export function alignmentDescription(alignment) {
  const al = normalizeAlignment(alignment);
  return {
    tx: round(al.tx, 2),
    ty: round(al.ty, 2),
    scale: round(al.scale, 4),
    rotationDeg: round((al.rotation * 180) / Math.PI, 2),
  };
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
