/**
 * 2D→3D 姿勢リフティング（MotionBERT）。
 *
 * MediaPipe の world landmarks は1フレームごとの推定で、奥行き(z)の揺れが大きい。
 * 回旋角や水平内外転角はこの z に直接依存するため、ブレがそのまま角度に出る。
 * ここでは記録済みの2D系列をまとめて 3D に持ち上げ、時間方向の整合性を使って
 * 奥行きを安定させる。
 *
 * 実測（投球動画27フレーム・1920x1080）:
 *   骨長のばらつき  14.25% → 10.73%
 *   骨盤回旋のガタつき 1.38° → 0.48°
 *   肩回旋のガタつき   4.27° → 1.50°
 *
 * モデル: MotionBERT (Walter0807/MotionBERT, Apache-2.0) の ONNX 変換を int8 量子化。
 * 重みは Human3.6M で学習されており、同データセットは学術研究用途に限定される。
 * このため既定ではオフにしてあり、利用者が明示的に有効化したときだけ読み込む。
 */
import { LM } from './metrics.js';

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
export const WINDOW = 27;          // モデルが受け取るフレーム数
export const MODEL_BYTES = 43121049;

/* Human3.6M 17関節の並び（MotionBERT の入出力） */
export const H36M = {
  HIP: 0, RHIP: 1, RKNEE: 2, RANKLE: 3, LHIP: 4, LKNEE: 5, LANKLE: 6,
  SPINE: 7, THORAX: 8, NECK: 9, HEAD: 10,
  LSHOULDER: 11, LELBOW: 12, LWRIST: 13, RSHOULDER: 14, RELBOW: 15, RWRIST: 16,
};

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v ?? 1, b.v ?? 1) });

/**
 * MediaPipe の33点（正規化座標）を Human3.6M の17点に変換する。
 * H36M にしか無い spine / thorax / head は中点から合成する。
 * @returns Float32Array 相当の [[x, y, conf], ...] 17点。x,y はピクセル座標。
 */
export function toH36m(lm, width, height) {
  const P = (i) => ({ x: lm[i].x * width, y: lm[i].y * height, v: lm[i].v ?? lm[i].visibility ?? 1 });
  const lhip = P(LM.L_HIP), rhip = P(LM.R_HIP);
  const lsh = P(LM.L_SHOULDER), rsh = P(LM.R_SHOULDER);
  const hip = mid(lhip, rhip);
  const thorax = mid(lsh, rsh);
  const head = mid(P(LM.L_EAR), P(LM.R_EAR));
  const spine = mid(hip, thorax);
  const j = [hip, rhip, P(LM.R_KNEE), P(LM.R_ANKLE), lhip, P(LM.L_KNEE), P(LM.L_ANKLE),
             spine, thorax, P(LM.NOSE), head,
             lsh, P(LM.L_ELBOW), P(LM.L_WRIST), rsh, P(LM.R_ELBOW), P(LM.R_WRIST)];
  return j.map((p) => [p.x, p.y, p.v]);
}

/**
 * MotionBERT の infer_wild と同じ正規化。
 * 人物のバウンディングボックス（系列全体）で [-1,1] に収める。
 * 画面サイズではなく人物の大きさで正規化するのが肝で、ここを間違えると出力が壊れる。
 */
export function cropScale(seq) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const frame of seq) {
    for (const [x, y, c] of frame) {
      if (!(c > 0)) continue;
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
  }
  const scale = Math.max(xmax - xmin, ymax - ymin);
  if (!(scale > 0)) return null;
  const xs = (xmin + xmax - scale) / 2;
  const ys = (ymin + ymax - scale) / 2;
  const clamp = (v) => Math.min(1, Math.max(-1, v));
  return seq.map((frame) => frame.map(([x, y, c]) => [
    clamp(((x - xs) / scale - 0.5) * 2),
    clamp(((y - ys) / scale - 0.5) * 2),
    clamp(c),
  ]));
}

/* ------------------------------------------------------------------ */

let ortPromise = null;
function loadOrt() {
  if (!ortPromise) ortPromise = import(/* webpackIgnore: true */ ORT_URL);
  return ortPromise;
}

export class Lifter {
  constructor() { this.session = null; this.ort = null; }

  get ready() { return !!this.session; }

  /** @param onProgress (loaded, total) => void */
  async init(modelUrl, loadBytes) {
    if (this.session) return;
    const ort = await loadOrt();
    this.ort = ort;
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
    const buf = await loadBytes(modelUrl);
    // WebGPU が使えない環境では wasm に落とす
    const providers = ('gpu' in navigator) ? ['webgpu', 'wasm'] : ['wasm'];
    this.session = await ort.InferenceSession.create(buf, {
      executionProviders: providers,
      graphOptimizationLevel: 'all',
    });
  }

  dispose() { this.session = null; }

  /**
   * 2D系列を3Dに持ち上げる。
   * 27フレーム窓を半分ずつ重ねて推論し、重なりは線形に混ぜて繋ぎ目を消す。
   * @param frames [{lm:[{x,y,v}], ...}]  正規化座標のランドマーク
   * @returns [T][17][3] 腰を原点とした3D座標（スケールは正規化済み・角度計算用）
   */
  async lift(frames, width, height, onProgress) {
    if (!this.session) throw new Error('リフティングモデルが未初期化です');
    const T = frames.length;
    if (T < 4) return null;

    const kp = frames.map((f) => toH36m(f.lm, width, height));
    const acc = Array.from({ length: T }, () => Array.from({ length: 17 }, () => [0, 0, 0]));
    const wsum = new Array(T).fill(0);

    const step = Math.max(1, Math.floor(WINDOW / 2));
    const starts = [];
    for (let s = 0; s + WINDOW <= T; s += step) starts.push(s);
    if (!starts.length || starts[starts.length - 1] + WINDOW < T) starts.push(Math.max(0, T - WINDOW));

    for (let n = 0; n < starts.length; n++) {
      const s = starts[n];
      // 末尾が足りない場合は最終フレームを繰り返して窓を埋める
      const win = [];
      for (let i = 0; i < WINDOW; i++) win.push(kp[Math.min(T - 1, s + i)]);
      const norm = cropScale(win);
      if (!norm) continue;

      const data = new Float32Array(WINDOW * 17 * 3);
      let p = 0;
      for (const frame of norm) for (const v of frame) { data[p++] = v[0]; data[p++] = v[1]; data[p++] = v[2]; }
      const tensor = new this.ort.Tensor('float32', data, [1, WINDOW, 17, 3]);
      const out = await this.session.run({ input: tensor });
      const o = out[this.session.outputNames[0]].data;

      for (let i = 0; i < WINDOW; i++) {
        const t = s + i;
        if (t >= T) break;
        // 窓の端ほど重みを下げて、繋ぎ目の段差を消す
        const w = Math.min(i + 1, WINDOW - i, step) / step;
        const base = i * 17 * 3;
        const rootX = o[base + 0], rootY = o[base + 1], rootZ = o[base + 2];
        for (let j = 0; j < 17; j++) {
          const b = base + j * 3;
          acc[t][j][0] += (o[b] - rootX) * w;
          acc[t][j][1] += (o[b + 1] - rootY) * w;
          acc[t][j][2] += (o[b + 2] - rootZ) * w;
        }
        wsum[t] += w;
      }
      onProgress?.(n + 1, starts.length);
    }

    for (let t = 0; t < T; t++) {
      const w = wsum[t] || 1;
      for (let j = 0; j < 17; j++) { acc[t][j][0] /= w; acc[t][j][1] /= w; acc[t][j][2] /= w; }
    }
    return acc;
  }
}

/**
 * 持ち上げた H36M 17点を、角度計算が使う MediaPipe 33点の配置に書き戻す。
 * H36M に無い点（耳・つま先・手指など）は MediaPipe の値をそのまま残す。
 */
export function applyToWorld(world, h36m) {
  const out = world.map((p) => ({ ...p }));
  const set = (idx, j) => {
    out[idx] = { x: h36m[j][0], y: h36m[j][1], z: h36m[j][2], visibility: world[idx]?.visibility ?? 1 };
  };
  set(LM.R_HIP, H36M.RHIP);       set(LM.L_HIP, H36M.LHIP);
  set(LM.R_KNEE, H36M.RKNEE);     set(LM.L_KNEE, H36M.LKNEE);
  set(LM.R_ANKLE, H36M.RANKLE);   set(LM.L_ANKLE, H36M.LANKLE);
  set(LM.R_SHOULDER, H36M.RSHOULDER); set(LM.L_SHOULDER, H36M.LSHOULDER);
  set(LM.R_ELBOW, H36M.RELBOW);   set(LM.L_ELBOW, H36M.LELBOW);
  set(LM.R_WRIST, H36M.RWRIST);   set(LM.L_WRIST, H36M.LWRIST);
  set(LM.NOSE, H36M.NECK);
  return out;
}
