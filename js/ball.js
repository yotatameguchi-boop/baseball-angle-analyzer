/**
 * ボール検出・追跡。
 *
 * 単眼カメラで野球のボールを追うのは本質的に難しい（小さい・速い・モーションブラー）。
 * 精度を出すため3つを組み合わせる:
 *   1. MediaPipe ObjectDetector (COCO "sports ball") … 確度は高いが小さく速い球には反応しにくい
 *   2. フレーム間差分による動体ブロブ検出      … 小さく速い物体に強い。誤検出が多いのでスコアで絞る
 *   3. 等速度モデルによるトラッキング          … 時間的な一貫性で誤検出を排除し、欠測を補間する
 */

const RAD = 180 / Math.PI;

export class BallTracker {
  constructor(opts = {}) {
    this.workW = opts.workW ?? 320;         // 差分処理を行う縮小解像度の幅
    this.diffThreshold = opts.diffThreshold ?? 26;
    this.minDiameter = opts.minDiameter ?? 3;   // 縮小解像度でのボール直径(px)
    this.maxDiameter = opts.maxDiameter ?? 34;
    this.detectorEvery = opts.detectorEvery ?? 3; // 物体検出を走らせる間隔(フレーム)
    this.enabled = true;

    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prevGray = null;
    this.frameIndex = 0;

    this.detector = null;
    this.track = null;          // 現在追跡中のボール
    this.trajectory = [];       // {t, x, y, src, score} 動画ピクセル座標
    this.lastCandidates = [];
  }

  async initDetector(fileset, modelBuffer, delegate = 'GPU') {
    const { loadVision } = await import('./config.js');
    const { ObjectDetector } = await loadVision();
    this.detector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: modelBuffer, delegate },
      runningMode: 'VIDEO',
      scoreThreshold: 0.18,
      maxResults: 8,
    });
  }

  reset() {
    this.prevGray = null;
    this.track = null;
    this.trajectory = [];
    this.frameIndex = 0;
    this.lastCandidates = [];
  }

  /* ---------------- 動体ブロブ検出 ---------------- */

  _grayscale(video, w, h) {
    this.canvas.width = w; this.canvas.height = h;
    this.ctx.drawImage(video, 0, 0, w, h);
    const img = this.ctx.getImageData(0, 0, w, h).data;
    const g = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = (img[p] * 299 + img[p + 1] * 587 + img[p + 2] * 114) / 1000;
    }
    return g;
  }

  /** 差分マスクを連結成分に分け、ボールらしさでスコアリングした候補を返す */
  _motionCandidates(gray, prev, w, h, bodyBoxes) {
    const th = this.diffThreshold;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      if (Math.abs(gray[i] - prev[i]) > th) mask[i] = 1;
    }

    const minA = Math.PI * (this.minDiameter / 2) ** 2 * 0.5;
    const maxA = Math.PI * (this.maxDiameter / 2) ** 2 * 1.6;
    const out = [];
    const stack = new Int32Array(w * h);

    for (let start = 0; start < mask.length; start++) {
      if (mask[start] !== 1) continue;
      // 4近傍フラッドフィルで1ブロブを取り出す
      let sp = 0; stack[sp++] = start; mask[start] = 2;
      let area = 0, sx = 0, sy = 0, bright = 0;
      let minX = w, maxX = -1, minY = h, maxY = -1;
      while (sp > 0) {
        const idx = stack[--sp];
        const x = idx % w, y = (idx / w) | 0;
        area++; sx += x; sy += y; bright += gray[idx];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x > 0 && mask[idx - 1] === 1) { mask[idx - 1] = 2; stack[sp++] = idx - 1; }
        if (x < w - 1 && mask[idx + 1] === 1) { mask[idx + 1] = 2; stack[sp++] = idx + 1; }
        if (y > 0 && mask[idx - w] === 1) { mask[idx - w] = 2; stack[sp++] = idx - w; }
        if (y < h - 1 && mask[idx + w] === 1) { mask[idx + w] = 2; stack[sp++] = idx + w; }
        if (area > maxA * 4) break; // 体などの巨大ブロブは早期に打ち切る
      }
      if (area < minA || area > maxA) continue;

      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      const aspect = bw / bh;
      if (aspect < 0.35 || aspect > 2.8) continue;      // 極端に細長い＝腕やバットの軌跡
      const fill = area / (bw * bh);
      if (fill < 0.42) continue;                         // 中身が詰まっていない＝輪郭ノイズ

      const cx = sx / area, cy = sy / area;
      const meanBright = bright / area;

      // 形と明るさからボールらしさを採点（野球のボールは白く丸い）
      const circScore = Math.min(1, fill / 0.78) * (1 - Math.min(1, Math.abs(Math.log(aspect)) / 1.0));
      const brightScore = Math.min(1, Math.max(0, (meanBright - 90) / 120));
      const dia = (bw + bh) / 2;
      const sizeScore = 1 - Math.min(1, Math.abs(dia - (this.minDiameter + this.maxDiameter) / 2) /
        ((this.maxDiameter - this.minDiameter) / 2 + 1e-6));

      let bodyPenalty = 0;
      for (const b of bodyBoxes || []) {
        if (cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1) { bodyPenalty = b.penalty; break; }
      }

      const score = Math.max(0, 0.45 * circScore + 0.30 * brightScore + 0.25 * sizeScore - bodyPenalty);
      out.push({ x: cx, y: cy, r: dia / 2, score, src: 'motion' });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 24);
  }

  /**
   * 胴体まわりの除外ボックス（縮小座標）。
   * 手の周辺はボールの出発点／インパクト地点なので除外しない。
   */
  _bodyBoxes(poseNorm, w, h) {
    if (!poseNorm) return [];
    const P = (i) => ({ x: poseNorm[i].x * w, y: poseNorm[i].y * h });
    const idx = [11, 12, 23, 24, 25, 26]; // 肩・腰・膝
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of idx) {
      const p = P(i);
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const pad = (x1 - x0) * 0.12;
    return [{ x0: x0 - pad, x1: x1 + pad, y0: y0 - pad, y1: y1 + pad, penalty: 0.45 }];
  }

  /* ---------------- トラッキング ---------------- */

  _updateTrack(cands, tMs, w, h) {
    const T = this.track;
    if (T) {
      const dt = Math.max(1, tMs - T.t) / 1000;
      const px = T.x + T.vx * dt;
      const py = T.y + T.vy * dt;
      const speed = Math.hypot(T.vx, T.vy);
      const gate = Math.max(w * 0.05, speed * dt * 1.6 + w * 0.03);

      let best = null, bestCost = Infinity;
      for (const c of cands) {
        const d = Math.hypot(c.x - px, c.y - py);
        if (d > gate) continue;
        const cost = d / gate - c.score * 0.8 - (c.src === 'detector' ? 0.5 : 0);
        if (cost < bestCost) { bestCost = cost; best = c; }
      }
      if (best) {
        const nvx = (best.x - T.x) / dt, nvy = (best.y - T.y) / dt;
        T.vx = T.vx * 0.35 + nvx * 0.65;
        T.vy = T.vy * 0.35 + nvy * 0.65;
        T.x = best.x; T.y = best.y; T.t = tMs;
        T.r = best.r ?? T.r;
        T.hits++; T.misses = 0;
        if (T.hits >= 3) T.confirmed = true;
        return { ...T, measured: true, score: best.score, src: best.src };
      }
      T.misses++;
      if (T.misses > 6) { this.track = null; return null; }
      // 欠測フレームは等速度で外挿する
      T.x = px; T.y = py; T.t = tMs;
      return { ...T, measured: false, score: 0, src: 'predicted' };
    }

    // 新規トラック開始（物体検出の結果か、十分スコアの高い動体）
    const seed = cands.find((c) => c.src === 'detector') || cands.find((c) => c.score > 0.55);
    if (seed) {
      this.track = { x: seed.x, y: seed.y, vx: 0, vy: 0, r: seed.r ?? 6, t: tMs, hits: 1, misses: 0, confirmed: false };
      return { ...this.track, measured: true, score: seed.score, src: seed.src };
    }
    return null;
  }

  /**
   * 1フレーム処理する。
   * @param video     HTMLVideoElement
   * @param tMs       タイムスタンプ(ms)
   * @param poseNorm  正規化ランドマーク（体の除外に使う。無くても可）
   * @returns {{ball: object|null, candidates: Array}} 動画ピクセル座標
   */
  process(video, tMs, poseNorm) {
    if (!this.enabled) return { ball: null, candidates: [] };
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return { ball: null, candidates: [] };

    const w = this.workW, h = Math.max(1, Math.round((vh / vw) * w));
    const scale = vw / w;
    const gray = this._grayscale(video, w, h);

    let cands = [];
    if (this.prevGray && this.prevGray.length === gray.length) {
      cands = this._motionCandidates(gray, this.prevGray, w, h, this._bodyBoxes(poseNorm, w, h));
    }
    this.prevGray = gray;

    // 物体検出は数フレームおきに走らせ、検出できたら最優先の候補にする
    if (this.detector && this.frameIndex % this.detectorEvery === 0) {
      try {
        const res = this.detector.detectForVideo(video, Math.round(tMs));
        for (const d of res.detections || []) {
          const name = (d.categories?.[0]?.categoryName || '').toLowerCase();
          if (!name.includes('ball')) continue;
          const b = d.boundingBox;
          cands.unshift({
            x: (b.originX + b.width / 2) / scale,
            y: (b.originY + b.height / 2) / scale,
            r: Math.max(b.width, b.height) / 2 / scale,
            score: 0.9 * (d.categories[0].score ?? 0.5) + 0.1,
            src: 'detector',
          });
        }
      } catch { /* 検出器が未対応でも動体検出だけで継続する */ }
    }
    this.frameIndex++;
    this.lastCandidates = cands;

    const t = this._updateTrack(cands, tMs, w, h);
    if (!t) return { ball: null, candidates: cands.map((c) => ({ ...c, x: c.x * scale, y: c.y * scale, r: c.r * scale })) };

    const ball = {
      t: tMs, x: t.x * scale, y: t.y * scale, r: t.r * scale,
      vx: t.vx * scale, vy: t.vy * scale,
      confirmed: t.confirmed, measured: t.measured, src: t.src, score: t.score,
    };
    if (t.confirmed) this.trajectory.push({ t: tMs, x: ball.x, y: ball.y, measured: t.measured, src: t.src });
    return { ball, candidates: cands.map((c) => ({ ...c, x: c.x * scale, y: c.y * scale, r: c.r * scale })) };
  }
}

/* ------------------------------------------------------------------ *
 * 軌道の解析
 * ------------------------------------------------------------------ */

/** 点列に直線を当てはめ、進行方向の仰角（度。正=上向き）を返す */
export function pathAngle(points) {
  if (!points || points.length < 3) return null;
  const n = points.length;
  let sx = 0, sy = 0, st = 0, stt = 0, stx = 0, sty = 0;
  const t0 = points[0].t;
  for (const p of points) {
    const t = (p.t - t0) / 1000;
    sx += p.x; sy += p.y; st += t; stt += t * t; stx += t * p.x; sty += t * p.y;
  }
  const den = n * stt - st * st;
  if (Math.abs(den) < 1e-9) return null;
  const vx = (n * stx - st * sx) / den;
  const vy = (n * sty - st * sy) / den;   // 画面座標なのでyは下向き正
  if (Math.hypot(vx, vy) < 1e-6) return null;
  return { deg: Math.atan2(-vy, Math.abs(vx)) * RAD, vx, vy, speedPx: Math.hypot(vx, vy) };
}

/**
 * インパクト（バットとボールの接触）を推定する。
 * ボールの進行方向が大きく反転し、かつグリップ（両手首の中点）の近くで起きたフレームを探す。
 */
export function detectImpact(trajectory, gripByTime, opts = {}) {
  const minTurn = opts.minTurnDeg ?? 60;
  const maxGripDistRatio = opts.maxGripDistRatio ?? 0.45; // 画面幅に対する比
  const frameW = opts.frameW ?? 1280;
  if (!trajectory || trajectory.length < 6) return null;

  let best = null;
  for (let i = 2; i < trajectory.length - 2; i++) {
    const a = trajectory[i - 2], b = trajectory[i], c = trajectory[i + 2];
    const v1 = { x: b.x - a.x, y: b.y - a.y };
    const v2 = { x: c.x - b.x, y: c.y - b.y };
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y);
    if (l1 < 2 || l2 < 2) continue;
    const cos = (v1.x * v2.x + v1.y * v2.y) / (l1 * l2);
    const turn = Math.acos(Math.min(1, Math.max(-1, cos))) * RAD;
    if (turn < minTurn) continue;

    const grip = gripByTime(b.t);
    let gripScore = 0.5;
    if (grip) {
      const d = Math.hypot(grip.x - b.x, grip.y - b.y);
      if (d > frameW * maxGripDistRatio) continue;
      gripScore = 1 - d / (frameW * maxGripDistRatio);
    }
    const score = turn / 180 + gripScore;
    if (!best || score > best.score) {
      best = { index: i, t: b.t, x: b.x, y: b.y, turnDeg: +turn.toFixed(1), score };
    }
  }
  return best;
}

/** インパクト前後の軌道から、投球の入射角と打球の打ち出し角を求める */
export function analyzeImpact(trajectory, impact, framesEachSide = 5) {
  if (!impact) return null;
  const i = impact.index;
  const before = trajectory.slice(Math.max(0, i - framesEachSide), i);
  const after = trajectory.slice(i + 1, i + 1 + framesEachSide);
  return {
    t: impact.t, x: impact.x, y: impact.y, turnDeg: impact.turnDeg,
    incoming: pathAngle(before),   // 入射角（負＝落ちてくる）
    outgoing: pathAngle(after),    // 打ち出し角（正＝上がる）
  };
}

/** グリップ（両手首の中点）の軌道から、インパクト時のスイング軌道角を求める */
export function swingPathAngle(gripTrack, tImpact, windowMs = 45) {
  if (!gripTrack || gripTrack.length < 3) return null;
  const pts = gripTrack.filter((p) => Math.abs(p.t - tImpact) <= windowMs);
  if (pts.length < 3) return null;
  return pathAngle(pts);
}
