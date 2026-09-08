/**
 * 動作イベントの自動検出。
 *
 * 打撃はボールの軌道からインパクトを取れるが、投球ではボールがリリース前に
 * 手に隠れているため軌道からは取れない。そこで骨格の動きから
 * 「踏込足の接地」と「リリース」を推定する。
 */
import { LM } from './metrics.js';

/** 画面幅で正規化した速度の時系列（単位/秒）。lm は正規化座標。 */
export function landmarkSpeed(frames, idx) {
  const out = new Array(frames.length).fill(0);
  for (let i = 1; i < frames.length; i++) {
    const dt = (frames[i].t - frames[i - 1].t) / 1000;
    if (dt <= 0) continue;
    const a = frames[i - 1].lm[idx], b = frames[i].lm[idx];
    if (!a || !b) continue;
    out[i] = Math.hypot(b.x - a.x, b.y - a.y) / dt;
  }
  // 3点移動平均でノイズを落とす
  return out.map((v, i, arr) => (arr[i - 1] ?? v) * 0.25 + v * 0.5 + (arr[i + 1] ?? v) * 0.25);
}

/**
 * 角度の時系列から角速度(度/秒)を求める。周期量は最短差分で扱う。
 * 隣接フレームの差分をそのまま使うと、姿勢推定の揺れが増幅されて
 * 非現実的な大きさになるため、中心差分＋移動平均で平滑化する。
 */
export function angularVelocity(frames, metricId, wrap = false, half = 2) {
  const n = frames.length;
  const raw = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    if (hi === lo) continue;
    const dt = (frames[hi].t - frames[lo].t) / 1000;
    const a = frames[lo].angles[metricId], b = frames[hi].angles[metricId];
    if (dt <= 0 || a == null || b == null) continue;
    let d = b - a;
    if (wrap) { while (d > 180) d -= 360; while (d < -180) d += 360; }
    raw[i] = d / dt;
  }
  // 5点移動平均
  const out = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) {
      if (raw[j] == null) continue;
      sum += raw[j]; cnt++;
    }
    if (cnt) out[i] = sum / cnt;
  }
  return out;
}

/** frames のうち [t0,t1] に入る添字の範囲 */
export function windowIndices(frames, win) {
  if (!win) return [0, frames.length];
  let from = 0, to = frames.length;
  while (from < frames.length && frames[from].t < win[0]) from++;
  while (to > from && frames[to - 1].t > win[1]) to--;
  return [from, Math.max(to, from + 1)];
}

/** 絶対値が最大の点を返す */
export function peakAbs(series, frames, from = 0, to = Infinity) {
  let best = null;
  for (let i = Math.max(1, from); i < Math.min(series.length, to); i++) {
    const v = series[i];
    if (v == null) continue;
    if (!best || Math.abs(v) > Math.abs(best.value)) best = { index: i, value: v, t: frames[i].t };
  }
  return best;
}

/**
 * 踏込足の接地。
 * ステップ中に速く動いた踏込足首が、急に止まって止まり続けた最初の時点を採る。
 */
export function detectFootContact(frames, leadSide) {
  if (frames.length < 8) return null;
  const ankle = leadSide === 'L' ? LM.L_ANKLE : LM.R_ANKLE;
  const sp = landmarkSpeed(frames, ankle);

  let peak = { i: -1, v: 0 };
  for (let i = 0; i < sp.length; i++) if (sp[i] > peak.v) peak = { i, v: sp[i] };
  if (peak.i < 0 || peak.v <= 0) return null;

  const quiet = peak.v * 0.2;
  const holdMs = 120;
  for (let i = peak.i + 1; i < frames.length; i++) {
    if (sp[i] > quiet) continue;
    // 一定時間、静止し続けているか確認する
    let ok = true;
    for (let j = i; j < frames.length && frames[j].t - frames[i].t <= holdMs; j++) {
      if (sp[j] > quiet * 1.6) { ok = false; break; }
    }
    if (ok) return { index: i, t: frames[i].t, confidence: Math.min(1, peak.v / 0.6), method: '踏込足首の停止' };
  }
  return null;
}

/**
 * リリース。
 * 投球腕の手首の速度が最大になる時点を使う。ボール軌道が取れていれば、
 * 手から離れ始めた時刻で補正する。
 */
export function detectRelease(frames, throwSide, ballTrajectory, ballTimeOffset = 0, after = 0) {
  if (frames.length < 5) return null;
  const wrist = throwSide === 'R' ? LM.R_WRIST : LM.L_WRIST;
  const sp = landmarkSpeed(frames, wrist);

  let peak = { i: -1, v: 0 };
  for (let i = 0; i < sp.length; i++) {
    if (frames[i].t < after) continue;
    if (sp[i] > peak.v) peak = { i, v: sp[i] };
  }
  if (peak.i < 0) return null;
  const base = { index: peak.i, t: frames[peak.i].t, confidence: Math.min(1, peak.v / 1.5), method: '投球腕の手首速度が最大' };

  // ボールが手から離れた時刻が近くにあれば、そちらを採用する
  if (ballTrajectory && ballTrajectory.length > 2) {
    // リリースは手首速度の最大付近で起きる。ボール検出は誤りやすいので、
    // 最大速度より前や、大きく後の検出は採用しない。
    const rel = ballTrajectory
      .map((p) => ({ ...p, rel: p.t - ballTimeOffset }))
      .filter((p) => p.rel >= base.t - 60 && p.rel <= base.t + 200);
    if (rel.length) {
      const first = rel[0];
      let idx = 0, bd = Infinity;
      for (let i = 0; i < frames.length; i++) {
        const d = Math.abs(frames[i].t - first.rel);
        if (d < bd) { bd = d; idx = i; }
      }
      return { index: idx, t: frames[idx].t, confidence: 0.9, method: 'ボールが手から離れた時点' };
    }
  }
  return base;
}

/**
 * 運動連鎖（proximal-to-distal）の確認。
 * 骨盤 → 体幹 → 腕 の順に最大角速度が現れるのが望ましい順序とされる。
 */
export function kineticSequence(frames, throwSide, win) {
  const [from, to] = windowIndices(frames, win);
  const pelvis = peakAbs(angularVelocity(frames, 'pelvis_rot', true), frames, from, to);
  const trunk = peakAbs(angularVelocity(frames, 'shoulder_rot', true), frames, from, to);
  const elbowId = throwSide === 'R' ? 'elbow_R' : 'elbow_L';
  const arm = peakAbs(angularVelocity(frames, elbowId), frames, from, to);
  if (!pelvis || !trunk || !arm) return null;

  const order = [
    { key: 'pelvis', label: '骨盤の回旋', ...pelvis },
    { key: 'trunk', label: '体幹の回旋', ...trunk },
    { key: 'arm', label: '肘の伸展', ...arm },
  ];
  const correct = pelvis.t <= trunk.t && trunk.t <= arm.t;
  return { items: order, correct, actualOrder: [...order].sort((a, b) => a.t - b.t).map((x) => x.label) };
}

/** 捻転差の最大値とその時刻 */
export function maxSeparation(frames, win) {
  const [from, to] = windowIndices(frames, win);
  let best = null;
  for (let i = from; i < to; i++) {
    const v = frames[i].angles.x_factor;
    if (v == null) continue;
    if (!best || Math.abs(v) > Math.abs(best.value)) best = { index: i, t: frames[i].t, value: v };
  }
  return best;
}

/**
 * モードに応じてイベントを一括検出する。
 * @returns {{[eventKey:string]: {index,t,confidence,method}}}
 */
export function detectEvents(frames, { kind, lead, trail, ballTrajectory, ballTimeOffset, impactT }) {
  const events = {};
  if (!frames.length) return events;

  if (kind === 'bat') {
    if (impactT != null) {
      let idx = 0, bd = Infinity;
      for (let i = 0; i < frames.length; i++) {
        const d = Math.abs(frames[i].t - impactT);
        if (d < bd) { bd = d; idx = i; }
      }
      events.contact = { index: idx, t: frames[idx].t, confidence: 0.8, method: 'ボールの進行方向が反転した時点' };
    }
    const fc = detectFootContact(frames, lead);
    if (fc) events.foot_contact = fc;
  } else {
    const fc = detectFootContact(frames, lead);
    if (fc) events.foot_contact = fc;
    const rel = detectRelease(frames, trail, ballTrajectory, ballTimeOffset, fc ? fc.t : 0);
    if (rel) events.release = rel;
  }
  return events;
}

/** 解析の対象にする時間帯（イベント周辺）。無関係な場面を拾わないようにする。 */
export function analysisWindow(events, kind) {
  const fc = events.foot_contact?.t;
  const main = kind === 'bat' ? events.contact?.t : events.release?.t;
  if (main == null && fc == null) return null;
  const lo = (fc != null ? fc : main) - 800;
  const hi = (main != null ? main : fc) + 300;
  return [lo, Math.max(hi, lo + 400)];
}

export const EVENT_LABEL = {
  contact: 'インパクト',
  foot_contact: '踏込足の接地',
  release: 'リリース',
};

export const EVENT_COLOR = {
  contact: '#ff6b81',
  foot_contact: '#ffd93d',
  release: '#4fc3f7',
};
