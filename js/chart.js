/** 角度の時系列を描く軽量チャート（依存ライブラリなし） */

export class TimeChart {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.padding = { l: 46, r: 12, t: 12, b: 24 };
    this.series = [];
    this.events = [];
    this.bands = [];
    this.playheadT = null;
    this.range = null;
    this.onScrub = opts.onScrub || null;
    this.hover = null;
    this._bindEvents();
  }

  _bindEvents() {
    const c = this.canvas;
    let dragging = false;
    const toTime = (ev) => {
      const rect = c.getBoundingClientRect();
      const x = (ev.clientX - rect.left) * (c.width / rect.width);
      const { l, r } = this.padding;
      const w = c.width - l - r;
      const f = Math.min(1, Math.max(0, (x - l) / w));
      const [t0, t1] = this.range || [0, 1];
      return t0 + f * (t1 - t0);
    };
    c.addEventListener('pointerdown', (e) => {
      dragging = true; c.setPointerCapture(e.pointerId);
      if (this.onScrub && this.range) this.onScrub(toTime(e));
    });
    c.addEventListener('pointermove', (e) => {
      if (dragging && this.onScrub && this.range) this.onScrub(toTime(e));
      const rect = c.getBoundingClientRect();
      this.hover = { x: (e.clientX - rect.left) * (c.width / rect.width) };
      this.draw();
    });
    c.addEventListener('pointerup', (e) => { dragging = false; c.releasePointerCapture(e.pointerId); });
    c.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
  }

  setData({ series, range, events, bands }) {
    if (series) this.series = series;
    if (range) this.range = range;
    if (events) this.events = events;
    if (bands !== undefined) this.bands = bands;
    this.draw();
  }

  setPlayhead(t) { this.playheadT = t; this.draw(); }

  _yRange() {
    let lo = Infinity, hi = -Infinity;
    for (const s of this.series) {
      if (!s.visible) continue;
      for (const p of s.points) {
        if (p.v == null) continue;
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
      }
    }
    for (const b of this.bands) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); }
    if (!Number.isFinite(lo)) return [0, 180];
    if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 800, cssH = c.clientHeight || 220;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    }
    const W = c.width, H = c.height;
    const { l, r, t, b } = { l: this.padding.l * dpr, r: this.padding.r * dpr, t: this.padding.t * dpr, b: this.padding.b * dpr };
    const pw = W - l - r, ph = H - t - b;
    ctx.clearRect(0, 0, W, H);

    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--fg').trim() || '#e8ecf1';
    const dim = css.getPropertyValue('--dim').trim() || '#7b8794';
    const grid = css.getPropertyValue('--grid').trim() || '#252b36';

    if (!this.range || !this.series.length) {
      ctx.fillStyle = dim; ctx.font = `${12 * dpr}px system-ui`; ctx.textAlign = 'center';
      ctx.fillText('記録するとここに角度の推移が表示されます', W / 2, H / 2);
      return;
    }

    const [t0, t1] = this.range;
    const [ylo, yhi] = this._yRange();
    const X = (tt) => l + ((tt - t0) / Math.max(1e-6, t1 - t0)) * pw;
    const Y = (v) => t + (1 - (v - ylo) / Math.max(1e-6, yhi - ylo)) * ph;

    // 基準レンジの帯
    for (const band of this.bands) {
      ctx.fillStyle = band.color || 'rgba(80,200,140,0.12)';
      const y1 = Y(band.hi), y2 = Y(band.lo);
      ctx.fillRect(l, y1, pw, y2 - y1);
      if (band.mean != null) {
        ctx.strokeStyle = band.lineColor || 'rgba(80,200,140,0.55)';
        ctx.setLineDash([5 * dpr, 4 * dpr]); ctx.lineWidth = 1 * dpr;
        ctx.beginPath(); ctx.moveTo(l, Y(band.mean)); ctx.lineTo(l + pw, Y(band.mean)); ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // グリッドとY軸ラベル
    ctx.strokeStyle = grid; ctx.lineWidth = 1 * dpr;
    ctx.fillStyle = dim; ctx.font = `${10 * dpr}px system-ui`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const step = niceStep(yhi - ylo);
    for (let v = Math.ceil(ylo / step) * step; v <= yhi; v += step) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(l + pw, y); ctx.stroke();
      ctx.fillText(`${Math.round(v)}°`, l - 6 * dpr, y);
    }

    // X軸（秒）
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const durS = (t1 - t0) / 1000;
    const tStep = niceStep(durS) * 1000;
    for (let tt = Math.ceil(t0 / tStep) * tStep; tt <= t1; tt += tStep) {
      const x = X(tt);
      ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + ph); ctx.stroke();
      ctx.fillStyle = dim; ctx.fillText(`${((tt - t0) / 1000).toFixed(2)}s`, x, t + ph + 4 * dpr);
    }

    // イベント（踏込・インパクトなど）
    for (const ev of this.events) {
      const x = X(ev.t);
      ctx.strokeStyle = ev.color || '#ff6b81'; ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([3 * dpr, 3 * dpr]);
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = ev.color || '#ff6b81'; ctx.font = `${10 * dpr}px system-ui`; ctx.textAlign = 'left';
      ctx.fillText(ev.label, x + 3 * dpr, t + 2 * dpr);
    }

    // 系列
    for (const s of this.series) {
      if (!s.visible) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.8 * dpr;
      ctx.lineJoin = 'round'; ctx.beginPath();
      let pen = false;
      for (const p of s.points) {
        if (p.v == null) { pen = false; continue; }
        const x = X(p.t), y = Y(p.v);
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 再生位置
    if (this.playheadT != null) {
      const x = X(this.playheadT);
      ctx.strokeStyle = fg; ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, t + ph); ctx.stroke();
    }
  }
}

function niceStep(span) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const mult = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return mult * mag;
}
