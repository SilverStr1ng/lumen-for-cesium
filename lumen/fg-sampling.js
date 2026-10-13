// Cranley-Patterson randomization of both Hammersley dimensions. uint hashing
// avoids float-time precision loss; no runtime blue-noise asset is required.
export const fgHash = (x) => {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
};
export function fgSquare(
  i,
  n,
  pixel = [0, 0],
  epoch = 0,
  seed = 0,
  fixed = false,
) {
  let bits = i >>> 0;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  const v = bits * 2.3283064365386963e-10,
    fract = (x) => x - Math.floor(x);
  if (fixed) return [(i + 0.5) / n, fract(v + seed * 0.61803398875)];
  const key = fgHash(
    Math.imul(pixel[0], 0x9e3779b9) ^
      Math.imul(pixel[1], 0x85ebca6b) ^
      (seed >>> 0),
  );
  const shift0 = (fgHash(key ^ (epoch >>> 0) ^ 0xa511e9b3) >>> 8) / 16777216;
  const shift1 =
    (fgHash(key ^ fgHash((epoch >>> 0) ^ 0x63d83595) ^ 0x68bc21eb) >>> 8) /
    16777216;
  return [fract((i + 0.5) / n + shift0), fract(v + shift1)];
}
