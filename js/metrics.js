// 野球動作向けの関節角度の定義と計算
import { sub, dot, cross, scale, normalize, mid, angleAt, angleBetween, projectOntoPlane } from './geom.js';

// MediaPipe Pose の33ランドマーク
export const LM = {
  NOSE: 0,
  L_EAR: 7, R_EAR: 8,
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13, R_ELBOW: 14,
  L_WRIST: 15, R_WRIST: 16,
  L_HIP: 23, R_HIP: 24,
  L_KNEE: 25, R_KNEE: 26,
  L_ANKLE: 27, R_ANKLE: 28,
  L_HEEL: 29, R_HEEL: 30,
  L_TOE: 31, R_TOE: 32,
};

export const CONNECTIONS = [
  [11, 12], [11, 23], [12, 24], [23, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [0, 7], [0, 8],
];

const RAD = 180 / Math.PI;
const UP = { x: 0, y: -1, z: 0 }; // 画面上向き（MediaPipeはy軸が下向き正）

export function wrapDeg(d) {
  if (d == null) return null;
  let v = d;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

/**
 * 水平面（x-z平面）における身体の向き。
 * r = 左肩→右肩（または左腰→右腰）のベクトル。
 * 戻り値: 0°=カメラに正対 / +90°=画面右を向く / -90°=画面左 / ±180°=背中を向ける
 */
function facingAngle(r) {
  if (Math.hypot(r.x, r.z ?? 0) < 1e-6) return null;
  return Math.atan2(-(r.z ?? 0), -r.x) * RAD;
}

/** 骨格から身体座標系を作る */
function bodyFrame(p) {
  const shC = mid(p[LM.L_SHOULDER], p[LM.R_SHOULDER]);
  const hipC = mid(p[LM.L_HIP], p[LM.R_HIP]);
  const trunkUp = normalize(sub(shC, hipC));          // 骨盤中心→肩中心
  const shoulderLine = normalize(sub(p[LM.R_SHOULDER], p[LM.L_SHOULDER])); // 身体の右方向
  // 右手系 (bodyRight, bodyDown, bodyForward) より forward = right × down
  const fwd = normalize(cross(shoulderLine, scale(trunkUp, -1))); // 胸の向き
  return { shC, hipC, trunkUp, shoulderLine, fwd };
}

/** 肩の水平内外転角: +が前方(水平内転)、-が後方(水平外転) */
function horizontalArm(p, side, fr) {
  const sh = side === 'R' ? p[LM.R_SHOULDER] : p[LM.L_SHOULDER];
  const el = side === 'R' ? p[LM.R_ELBOW] : p[LM.L_ELBOW];
  const upper = projectOntoPlane(sub(el, sh), fr.trunkUp);
  const outward = side === 'R' ? fr.shoulderLine : scale(fr.shoulderLine, -1);
  if (Math.hypot(upper.x, upper.y, upper.z) < 1e-6) return null;
  return Math.atan2(dot(upper, fr.fwd), dot(upper, outward)) * RAD;
}

/** 肩の挙上（外転）角: 0°=下垂, 90°=真横水平, 180°=万歳 */
function armElevation(p, side, fr) {
  const sh = side === 'R' ? p[LM.R_SHOULDER] : p[LM.L_SHOULDER];
  const el = side === 'R' ? p[LM.R_ELBOW] : p[LM.L_ELBOW];
  return angleBetween(sub(el, sh), scale(fr.trunkUp, -1));
}

/**
 * 角度メトリクスの定義。
 *  dim: '3d' … 奥行きを使うため3D(ワールド座標)でのみ算出可能
 *       'both' … 2D(画面上)でも算出可能
 *  arc: 画面上に角度の弧を描くための [点a, 頂点b, 点c]
 */
export const METRICS = [
  // --- 上肢 ---
  { id: 'elbow_R', label: '右肘 角度', short: '右肘', group: '上肢', color: '#ff6b5e', dim: 'both',
    hint: '180°=完全伸展。リリース直前の肘の伸び具合。',
    arc: [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST],
    calc: (p) => angleAt(p[LM.R_SHOULDER], p[LM.R_ELBOW], p[LM.R_WRIST]) },
  { id: 'elbow_L', label: '左肘 角度', short: '左肘', group: '上肢', color: '#ff9f43', dim: 'both',
    hint: '180°=完全伸展。',
    arc: [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST],
    calc: (p) => angleAt(p[LM.L_SHOULDER], p[LM.L_ELBOW], p[LM.L_WRIST]) },
  { id: 'shoulder_elev_R', label: '右肩 挙上角', short: '右肩挙上', group: '上肢', color: '#ffd93d', dim: '3d',
    hint: '体幹軸に対する上腕の角度。0°=下垂 / 90°=真横 / 180°=万歳。',
    arc: [LM.R_HIP, LM.R_SHOULDER, LM.R_ELBOW],
    calc: (p, fr) => armElevation(p, 'R', fr) },
  { id: 'shoulder_elev_L', label: '左肩 挙上角', short: '左肩挙上', group: '上肢', color: '#f6e58d', dim: '3d',
    hint: '0°=下垂 / 90°=真横 / 180°=万歳。',
    arc: [LM.L_HIP, LM.L_SHOULDER, LM.L_ELBOW],
    calc: (p, fr) => armElevation(p, 'L', fr) },
  { id: 'shoulder_horiz_R', label: '右肩 水平内外転', short: '右肩水平', group: '上肢', color: '#7bed9f', dim: '3d',
    hint: '+が前方(水平内転) / -が後方(水平外転)。腕の引き込み量の指標。',
    calc: (p, fr) => horizontalArm(p, 'R', fr) },
  { id: 'shoulder_horiz_L', label: '左肩 水平内外転', short: '左肩水平', group: '上肢', color: '#badc58', dim: '3d',
    hint: '+が前方(水平内転) / -が後方(水平外転)。',
    calc: (p, fr) => horizontalArm(p, 'L', fr) },

  // --- 体幹 ---
  { id: 'trunk_tilt', label: '体幹 傾斜角', short: '体幹傾斜', group: '体幹', color: '#4fc3f7', dim: 'both',
    hint: '鉛直に対する体幹の総合的な傾き。0°=直立。',
    calc: (p, fr) => angleBetween(sub(fr.shC, fr.hipC), UP) },
  { id: 'trunk_lateral', label: '体幹 側屈角(画面)', short: '体幹側屈', group: '体幹', color: '#00d2d3', dim: 'both',
    hint: '画面内の左右の倒れ。+が画面右へ傾く。',
    calc: (p, fr) => { const v = sub(fr.shC, fr.hipC); return Math.atan2(v.x, -v.y) * RAD; } },
  { id: 'trunk_sagittal', label: '体幹 前後傾角(奥行)', short: '体幹前後傾', group: '体幹', color: '#54a0ff', dim: '3d',
    hint: '奥行き方向の倒れ。+がカメラ側へ前傾。',
    calc: (p, fr) => { const v = sub(fr.shC, fr.hipC); return Math.atan2(-(v.z ?? 0), -v.y) * RAD; } },
  { id: 'shoulder_rot', label: '肩ライン 回旋角', short: '肩回旋', group: '体幹', color: '#c56cf0', dim: '3d',
    hint: '水平面での肩の向き。0°=カメラに正対 / +90°=画面右向き。',
    calc: (p) => facingAngle(sub(p[LM.R_SHOULDER], p[LM.L_SHOULDER])) },
  { id: 'pelvis_rot', label: '骨盤ライン 回旋角', short: '骨盤回旋', group: '体幹', color: '#e056fd', dim: '3d',
    hint: '水平面での骨盤の向き。0°=カメラに正対。',
    calc: (p) => facingAngle(sub(p[LM.R_HIP], p[LM.L_HIP])) },
  { id: 'x_factor', label: '捻転差 (X-Factor)', short: '捻転差', group: '体幹', color: '#ff6b81', dim: '3d',
    hint: '肩回旋 − 骨盤回旋。上半身と下半身のねじれ差。',
    calc: (p) => wrapDeg(
      facingAngle(sub(p[LM.R_SHOULDER], p[LM.L_SHOULDER])) - facingAngle(sub(p[LM.R_HIP], p[LM.L_HIP]))) },
  { id: 'head_tilt', label: '頭部 傾き', short: '頭部', group: '体幹', color: '#a4b0be', dim: 'both',
    hint: '体幹軸に対する頭の傾き。0°=体幹と一直線。',
    calc: (p, fr) => angleBetween(sub(mid(p[LM.L_EAR], p[LM.R_EAR]), fr.shC), fr.trunkUp) },

  // --- 下肢 ---
  { id: 'hip_R', label: '右股関節 角度', short: '右股関節', group: '下肢', color: '#26de81', dim: 'both',
    hint: '肩-腰-膝のなす角。180°=伸展、小さいほど深く曲がる。',
    arc: [LM.R_SHOULDER, LM.R_HIP, LM.R_KNEE],
    calc: (p) => angleAt(p[LM.R_SHOULDER], p[LM.R_HIP], p[LM.R_KNEE]) },
  { id: 'hip_L', label: '左股関節 角度', short: '左股関節', group: '下肢', color: '#2bcbba', dim: 'both',
    hint: '180°=伸展。',
    arc: [LM.L_SHOULDER, LM.L_HIP, LM.L_KNEE],
    calc: (p) => angleAt(p[LM.L_SHOULDER], p[LM.L_HIP], p[LM.L_KNEE]) },
  { id: 'knee_R', label: '右膝 角度', short: '右膝', group: '下肢', color: '#45aaf2', dim: 'both',
    hint: '180°=完全伸展。踏込脚の膝の粘り／軸脚の沈み込み。',
    arc: [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE],
    calc: (p) => angleAt(p[LM.R_HIP], p[LM.R_KNEE], p[LM.R_ANKLE]) },
  { id: 'knee_L', label: '左膝 角度', short: '左膝', group: '下肢', color: '#4b7bec', dim: 'both',
    hint: '180°=完全伸展。',
    arc: [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE],
    calc: (p) => angleAt(p[LM.L_HIP], p[LM.L_KNEE], p[LM.L_ANKLE]) },
  { id: 'ankle_R', label: '右足首 角度', short: '右足首', group: '下肢', color: '#a55eea', dim: 'both',
    hint: '膝-足首-つま先のなす角。',
    arc: [LM.R_KNEE, LM.R_ANKLE, LM.R_TOE],
    calc: (p) => angleAt(p[LM.R_KNEE], p[LM.R_ANKLE], p[LM.R_TOE]) },
  { id: 'ankle_L', label: '左足首 角度', short: '左足首', group: '下肢', color: '#8854d0', dim: 'both',
    hint: '膝-足首-つま先のなす角。',
    arc: [LM.L_KNEE, LM.L_ANKLE, LM.L_TOE],
    calc: (p) => angleAt(p[LM.L_KNEE], p[LM.L_ANKLE], p[LM.L_TOE]) },
];

export const METRIC_BY_ID = Object.fromEntries(METRICS.map((m) => [m.id, m]));

/** 各メトリクスが依存する主要ランドマーク（信頼度の判定に使う） */
const DEPS = {
  elbow_R: [LM.R_SHOULDER, LM.R_ELBOW, LM.R_WRIST],
  elbow_L: [LM.L_SHOULDER, LM.L_ELBOW, LM.L_WRIST],
  shoulder_elev_R: [LM.R_SHOULDER, LM.R_ELBOW, LM.L_SHOULDER, LM.L_HIP, LM.R_HIP],
  shoulder_elev_L: [LM.L_SHOULDER, LM.L_ELBOW, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP],
  shoulder_horiz_R: [LM.R_SHOULDER, LM.R_ELBOW, LM.L_SHOULDER, LM.L_HIP, LM.R_HIP],
  shoulder_horiz_L: [LM.L_SHOULDER, LM.L_ELBOW, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP],
  trunk_tilt: [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP],
  trunk_lateral: [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP],
  trunk_sagittal: [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP],
  shoulder_rot: [LM.L_SHOULDER, LM.R_SHOULDER],
  pelvis_rot: [LM.L_HIP, LM.R_HIP],
  x_factor: [LM.L_SHOULDER, LM.R_SHOULDER, LM.L_HIP, LM.R_HIP],
  head_tilt: [LM.L_EAR, LM.R_EAR, LM.L_SHOULDER, LM.R_SHOULDER],
  hip_R: [LM.R_SHOULDER, LM.R_HIP, LM.R_KNEE],
  hip_L: [LM.L_SHOULDER, LM.L_HIP, LM.L_KNEE],
  knee_R: [LM.R_HIP, LM.R_KNEE, LM.R_ANKLE],
  knee_L: [LM.L_HIP, LM.L_KNEE, LM.L_ANKLE],
  ankle_R: [LM.R_KNEE, LM.R_ANKLE, LM.R_TOE],
  ankle_L: [LM.L_KNEE, LM.L_ANKLE, LM.L_TOE],
};

/**
 * 1フレーム分の全角度を計算する。
 * @param world MediaPipeのworldLandmarks（メートル・3D）
 * @param pixels 画面ピクセル座標に直したlandmarks（2D、z=0）
 * @param mode '3d' | '2d'  関節角度をどちらの座標で測るか
 */
export function computeAngles(world, pixels, mode) {
  const frW = bodyFrame(world);
  const frP = bodyFrame(pixels);
  const out = {};
  const conf = {};
  for (const m of METRICS) {
    const use2d = mode === '2d' && m.dim === 'both';
    const p = use2d ? pixels : world;
    const fr = use2d ? frP : frW;
    let v = null;
    try { v = m.calc(p, fr); } catch { v = null; }
    out[m.id] = Number.isFinite(v) ? v : null;
    const deps = DEPS[m.id] || [];
    let c = 1;
    for (const i of deps) c = Math.min(c, world[i]?.visibility ?? 1);
    conf[m.id] = c;
  }
  return { angles: out, conf };
}

/** 角度の連続性を保った指数移動平均（±180°をまたぐ量にも対応） */
export class AngleSmoother {
  constructor(alpha = 0.35) { this.alpha = alpha; this.state = {}; }
  reset() { this.state = {}; }
  apply(angles) {
    const a = this.alpha;
    if (a >= 1) return angles;
    const out = {};
    for (const [k, v] of Object.entries(angles)) {
      if (v == null) { out[k] = null; continue; }
      const prev = this.state[k];
      if (prev == null) { out[k] = v; }
      else {
        // 周期量は最短差分で補間する
        const wrapped = METRIC_BY_ID[k]?.id && Math.abs(v - prev) > 180 ? v + (v < prev ? 360 : -360) : v;
        out[k] = wrapDeg(prev + a * (wrapped - prev)) ?? v;
      }
      this.state[k] = out[k];
    }
    return out;
  }
}

/** プリセット（表示する角度のセット） */
export const PRESETS = {
  pitch_R: { label: 'ピッチング（右投げ）', ids: ['elbow_R', 'shoulder_elev_R', 'shoulder_horiz_R', 'knee_L', 'knee_R', 'hip_L', 'trunk_lateral', 'trunk_sagittal', 'shoulder_rot', 'pelvis_rot', 'x_factor'] },
  pitch_L: { label: 'ピッチング（左投げ）', ids: ['elbow_L', 'shoulder_elev_L', 'shoulder_horiz_L', 'knee_R', 'knee_L', 'hip_R', 'trunk_lateral', 'trunk_sagittal', 'shoulder_rot', 'pelvis_rot', 'x_factor'] },
  bat_R: { label: 'バッティング（右打ち）', ids: ['elbow_R', 'elbow_L', 'knee_R', 'knee_L', 'hip_R', 'hip_L', 'trunk_lateral', 'trunk_tilt', 'shoulder_rot', 'pelvis_rot', 'x_factor'] },
  bat_L: { label: 'バッティング（左打ち）', ids: ['elbow_L', 'elbow_R', 'knee_L', 'knee_R', 'hip_L', 'hip_R', 'trunk_lateral', 'trunk_tilt', 'shoulder_rot', 'pelvis_rot', 'x_factor'] },
  throw_field: { label: '送球・スローイング', ids: ['elbow_R', 'elbow_L', 'shoulder_elev_R', 'shoulder_horiz_R', 'trunk_lateral', 'shoulder_rot', 'pelvis_rot', 'x_factor'] },
  all: { label: 'すべて表示', ids: METRICS.map((m) => m.id) },
};
