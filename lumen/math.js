export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const mul = (a, s) => a.map((v) => v * s);
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const normalize = (a) => mul(a, 1 / (Math.hypot(...a) || 1));
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const linear = (x) =>
  x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
export function octDecode(x, y) {
  let z = 1 - Math.abs(x) - Math.abs(y);
  if (z < 0) {
    const old = x;
    x = (1 - Math.abs(y)) * Math.sign(x || 1);
    y = (1 - Math.abs(old)) * Math.sign(y || 1);
  }
  return normalize([x, y, z]);
}
export function octEncode(n) {
  const s = Math.abs(n[0]) + Math.abs(n[1]) + Math.abs(n[2]);
  let x = n[0] / s,
    y = n[1] / s;
  if (n[2] < 0) {
    const old = x;
    x = (1 - Math.abs(y)) * Math.sign(x || 1);
    y = (1 - Math.abs(old)) * Math.sign(y || 1);
  }
  return [(x + 1) * 0.5, (y + 1) * 0.5];
}
export function fibonacci(count) {
  return Array.from({ length: count }, (_, i) => {
    const z = 1 - (2 * (i + 0.5)) / count,
      r = Math.sqrt(1 - z * z),
      a = i * 2.399963229728653;
    return [r * Math.cos(a), r * Math.sin(a), z];
  });
}
