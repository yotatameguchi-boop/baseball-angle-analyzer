// 3次元ベクトル演算と角度計算のユーティリティ

export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) });
export const addv = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: (a.z ?? 0) + (b.z ?? 0) });
export const scale = (a, k) => ({ x: a.x * k, y: a.y * k, z: (a.z ?? 0) * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y + (a.z ?? 0) * (b.z ?? 0);
export const cross = (a, b) => ({
  x: a.y * (b.z ?? 0) - (a.z ?? 0) * b.y,
  y: (a.z ?? 0) * b.x - a.x * (b.z ?? 0),
  z: a.x * b.y - a.y * b.x,
});
export const len = (a) => Math.hypot(a.x, a.y, a.z ?? 0);
export const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: ((a.z ?? 0) + (b.z ?? 0)) / 2 });

export function normalize(a) {
  const l = len(a);
  return l < 1e-9 ? { x: 0, y: 0, z: 0 } : { x: a.x / l, y: a.y / l, z: (a.z ?? 0) / l };
}

const RAD = 180 / Math.PI;

/** 2ベクトルのなす角（0〜180度） */
export function angleBetween(u, v) {
  const l = len(u) * len(v);
  if (l < 1e-9) return null;
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v) / l))) * RAD;
}

/** 点bを頂点とする ∠abc（0〜180度）。180度が完全伸展。 */
export function angleAt(a, b, c) {
  return angleBetween(sub(a, b), sub(c, b));
}

/**
 * 平面内での符号付き角度。
 * u を基準軸 ref からどれだけ回したかを、法線 nrm まわりで -180〜180度で返す。
 */
export function signedAngle(u, ref, nrm) {
  const s = dot(cross(ref, u), nrm);
  const c = dot(ref, u);
  if (Math.abs(s) < 1e-9 && Math.abs(c) < 1e-9) return null;
  return Math.atan2(s, c) * RAD;
}

/** vから n 方向の成分を取り除く（平面へ射影） */
export function projectOntoPlane(v, n) {
  const nn = normalize(n);
  return sub(v, scale(nn, dot(v, nn)));
}
