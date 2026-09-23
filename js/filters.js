/**
 * 時系列の平滑化。
 *
 * 方針は Sports2D（Pagnon & Kim, JOSS 2024, BSD-3）に倣う。
 * 同ツールの既定は「Hampel で外れ値除去 → バターワース低域通過 6Hz」で、
 * これは生体力学で標準的な処理（Winter, Biomechanics and Motor Control of Human Movement）。
 *
 *   記録済みデータ … Hampel → 補間 → バターワース（ゼロ位相）
 *   ライブ映像     … 1€ フィルタ（未来のデータが使えないため）
 *
 * 固定係数の指数移動平均（従来の実装）は、平滑化を強めると速い局面で遅れが出て
 * インパクト時の角度がずれ、弱めると角速度がノイズで暴れる。上記はその両立を狙う。
 */

/* ------------------------------------------------------------------ *
 * 1€ フィルタ（ライブ用）
 * Casiez, Roussel & Vogel (2012) "1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems", CHI '12.
 * 速度が大きいほどカットオフを上げ、静止時は強く平滑化して
 * 「止めるとブレない・動かすと遅れない」を両立する。
 * ------------------------------------------------------------------ */

class LowPass {
  constructor() { this.y = null; this.s = null; }
  filter(x, alpha) {
    this.s = this.y == null ? x : alpha * x + (1 - alpha) * this.s;
    this.y = x;
    return this.s;
  }
  get last() { return this.s; }
  reset() { this.y = null; this.s = null; }
}

export class OneEuroFilter {
  /**
   * @param minCutoff 静止時のカットオフ(Hz)。小さいほど滑らかでブレない
   * @param beta      速度への追従度。大きいほど速い動きで遅れない
   * @param dCutoff   速度推定のカットオフ(Hz)
   *
   * beta は信号の単位に依存する。角度(度)は速い動作で角速度が
   * 数百〜1000 deg/s に達するため、原著の例にある 0.1〜1 をそのまま使うと
   * カットオフが100Hz超になり平滑化が効かなくなる。
   * 既定値はスイング相当の波形（緩やかな区間＋急変）で実測して決めた。
   * この組では従来の固定EMAより静止時のブレ・急変時のずれとも小さい。
   */
  constructor({ minCutoff = 3.0, beta = 0.1, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.lastT = null;
  }

  reset() { this.x.reset(); this.dx.reset(); this.lastT = null; }

  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  /** @param tMs タイムスタンプ(ms) */
  filter(value, tMs) {
    if (!Number.isFinite(value)) return value;
    let dt = 1 / 60;
    if (this.lastT != null) {
      const d = (tMs - this.lastT) / 1000;
      if (d > 0 && d < 1) dt = d;
    }
    this.lastT = tMs;

    const prev = this.x.last;
    const rate = prev == null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(rate, OneEuroFilter.alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, OneEuroFilter.alpha(cutoff, dt));
  }
}

/* ------------------------------------------------------------------ *
 * 周期量（回旋角など）の展開
 * ------------------------------------------------------------------ */

/** ±180°をまたぐ跳びを取り除いて連続な系列にする */
export function unwrapDeg(series) {
  const out = series.slice();
  let offset = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i] == null || out[i - 1] == null) continue;
    const d = (series[i] + offset) - out[i - 1];
    if (d > 180) offset -= 360;
    else if (d < -180) offset += 360;
    out[i] = series[i] + offset;
  }
  return out;
}

export function wrapDeg180(v) {
  if (v == null || !Number.isFinite(v)) return v;
  let x = v;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

/* ------------------------------------------------------------------ *
 * 欠測の補間
 * ------------------------------------------------------------------ */

/** maxGap 以下の連続欠測を線形補間で埋める。それより長い欠測はそのまま残す。 */
export function interpolateGaps(series, maxGap = 10) {
  const out = series.slice();
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i] != null) { i++; continue; }
    let j = i;
    while (j < n && out[j] == null) j++;
    const len = j - i;
    const before = i - 1, after = j;
    if (len <= maxGap && before >= 0 && after < n && out[before] != null && out[after] != null) {
      for (let k = 0; k < len; k++) {
        out[i + k] = out[before] + (out[after] - out[before]) * ((k + 1) / (len + 1));
      }
    }
    i = j;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 外れ値の除去
 *
 * 素の Hampel（窓の中央値±3×MAD）は、速い動作＋低フレームレートでは使えない。
 * 例: 190°/s で動く角度を30fpsで撮ると1フレームあたり6.3°動くため、
 * 窓内の広がりだけで σ≈21° になり、45°の棘が 2σ に埋もれて検出できない。
 *
 * そこで前後のフレームからの線形予測との残差で判定する。
 * 等速で動いている限り残差はほぼ0になるので、孤立した棘だけが際立つ。
 * ------------------------------------------------------------------ */

function median(arr) {
  const a = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 孤立した外れ値を、前後フレームの中点で置き換える。
 * @param nSigmas 残差のMADから求めた標準偏差の何倍を外れ値とみなすか
 */
export function hampel(series, nSigmas = 4) {
  const n = series.length;
  const out = series.slice();
  if (n < 5) return { series: out, replaced: 0 };

  // 残差 = 実測 − 前後の中点（＝ 2階差分の −1/2 倍）
  const resid = new Array(n).fill(null);
  for (let i = 1; i < n - 1; i++) {
    const a = series[i - 1], b = series[i], c = series[i + 1];
    if (a == null || b == null || c == null) continue;
    resid[i] = b - (a + c) / 2;
  }
  const med = median(resid);
  if (med == null) return { series: out, replaced: 0 };
  const mad = median(resid.map((v) => (v == null ? null : Math.abs(v - med))));
  if (mad == null) return { series: out, replaced: 0 };
  const sigma = 1.4826 * mad;
  if (!(sigma > 1e-9)) return { series: out, replaced: 0 };

  // 外れ値は一旦欠測にしてから補間する。
  // 前後の中点で直接置き換えると、棘そのものを置換値に使ってしまい
  // 隣接フレームまで壊れる（棘の影響で隣も外れ値と判定されるため）。
  const bad = new Array(n).fill(false);
  let replaced = 0;
  for (let i = 1; i < n - 1; i++) {
    if (resid[i] == null) continue;
    if (Math.abs(resid[i] - med) > nSigmas * sigma) { bad[i] = true; replaced++; }
  }
  if (!replaced) return { series: out, replaced: 0 };

  for (let i = 0; i < n; i++) if (bad[i]) out[i] = null;
  const filled = interpolateGaps(out, 10);
  // 補間できなかった箇所（端など）は元の値に戻す
  for (let i = 0; i < n; i++) out[i] = filled[i] == null ? series[i] : filled[i];
  return { series: out, replaced };
}

/* ------------------------------------------------------------------ *
 * バターワース低域通過（2次・ゼロ位相）
 * ------------------------------------------------------------------ */

/**
 * 2次バターワース低域通過の係数（双一次変換）。
 * Winter の教科書で示される形。
 */
function butterCoeffs(fc, fs) {
  const wc = Math.tan(Math.PI * fc / fs);
  const k1 = Math.SQRT2 * wc;
  const k2 = wc * wc;
  const a0 = k2 / (1 + k1 + k2);
  const a1 = 2 * a0;
  const a2 = a0;
  const b1 = 2 * a0 * (1 / k2 - 1);
  const b2 = 1 - (a0 + a1 + a2 + b1);
  return { a0, a1, a2, b1, b2 };
}

function applyOnce(x, c) {
  const n = x.length;
  const y = new Array(n).fill(0);
  // 端の立ち上がりを抑えるため、最初の値で初期化する
  y[0] = x[0];
  y[1] = x[1] ?? x[0];
  for (let i = 2; i < n; i++) {
    y[i] = c.a0 * x[i] + c.a1 * x[i - 1] + c.a2 * x[i - 2] + c.b1 * y[i - 1] + c.b2 * y[i - 2];
  }
  return y;
}

/**
 * 順方向と逆方向の2回かけて位相遅れを打ち消す（filtfilt）。
 * 2回通すと実効的なカットオフが下がるので、Winter の補正係数で戻す。
 * @param fc 目標カットオフ(Hz)  @param fs サンプリング周波数(Hz)
 */
export function butterworthZeroLag(series, fc, fs) {
  const n = series.length;
  if (n < 6 || !(fs > 0) || !(fc > 0) || fc >= fs / 2) return series.slice();

  // 2パス分の補正: C = (2^(1/2) - 1)^(1/4)
  const correction = Math.pow(Math.pow(2, 1 / 2) - 1, 1 / 4);
  const c = butterCoeffs(Math.min(fc / correction, fs / 2 * 0.99), fs);

  // 欠測は一旦埋めてから通し、最後に戻す
  const filled = interpolateGaps(series, n);
  const first = filled.find((v) => v != null);
  if (first == null) return series.slice();
  const x = filled.map((v) => (v == null ? first : v));

  // 端の跳ねを抑えるため、両端を鏡像で延長してから処理する
  const pad = Math.min(30, n - 1);
  const head = [], tail = [];
  for (let i = pad; i >= 1; i--) head.push(2 * x[0] - x[i]);
  for (let i = 1; i <= pad; i++) tail.push(2 * x[n - 1] - x[n - 1 - i]);
  const ext = [...head, ...x, ...tail];

  const fwd = applyOnce(ext, c);
  const bwd = applyOnce(fwd.slice().reverse(), c).reverse();

  const out = bwd.slice(pad, pad + n);
  // 元が欠測だった箇所は欠測のまま返す
  return out.map((v, i) => (series[i] == null ? null : v));
}

/* ------------------------------------------------------------------ *
 * まとめ
 * ------------------------------------------------------------------ */

/**
 * 記録済み系列に対する標準処理。
 * @param circular ±180°をまたぐ量（回旋角など）は展開してから処理する
 */
export function smoothRecorded(series, { fs, cutoff = 6, circular = false, maxGap = 10 } = {}) {
  if (!series.length) return series.slice();
  let s = circular ? unwrapDeg(series) : series.slice();
  s = hampel(s).series;
  s = interpolateGaps(s, maxGap);
  s = butterworthZeroLag(s, cutoff, fs);
  return circular ? s.map(wrapDeg180) : s;
}
