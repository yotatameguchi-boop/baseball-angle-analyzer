import { loadVision, resolveSource, wasmBase, isLocalAssets } from './config.js';
import * as LOAD from './loader.js';
import { METRICS, METRIC_BY_ID, CONNECTIONS, LM, PRESETS, computeAngles, AngleSmoother, wrapDeg } from './metrics.js';
import { BallTracker, detectImpact, analyzeImpact, swingPathAngle, pathAngle } from './ball.js';
import { TimeChart } from './chart.js';
import * as REF from './reference.js';

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), stage: $('stage'),
  status: $('status'), fps: $('fps'),
  btnCamera: $('btnCamera'), btnStopCamera: $('btnStopCamera'),
  fileInput: $('fileInput'), fileControls: $('fileControls'),
  btnAnalyzeFile: $('btnAnalyzeFile'), btnCancelAnalyze: $('btnCancelAnalyze'),
  analyzeProgress: $('analyzeProgress'),
  modelSel: $('modelSel'), dimSel: $('dimSel'), smoothing: $('smoothing'), smoothVal: $('smoothVal'),
  chkMirror: $('chkMirror'), chkSkeleton: $('chkSkeleton'), chkArcs: $('chkArcs'),
  presetSel: $('presetSel'),
  chkBall: $('chkBall'), chkBallDebug: $('chkBallDebug'),
  ballTh: $('ballTh'), ballThVal: $('ballThVal'),
  ballSizeMin: $('ballSizeMin'), ballSizeMax: $('ballSizeMax'), ballSizeVal: $('ballSizeVal'),
  heightCm: $('heightCm'), massKg: $('massKg'), levelSel: $('levelSel'), batSpeed: $('batSpeed'),
  pitchTypeSel: $('pitchTypeSel'), refSetSel: $('refSetSel'),
  btnCalib: $('btnCalib'), calibState: $('calibState'),
  btnRecord: $('btnRecord'), btnPlay: $('btnPlay'), scrub: $('scrub'),
  timeLabel: $('timeLabel'), btnClear: $('btnClear'), btnCsv: $('btnCsv'),
  chart: $('chart'), legend: $('legend'), angleCards: $('angleCards'),
  btnMarkEvent: $('btnMarkEvent'), eventState: $('eventState'), compareTable: $('compareTable'),
  swingPanel: $('swingPanel'), sourceList: $('sourceList'),
  netInfo: $('netInfo'), dlBar: $('dlBar'), dlText: $('dlText'),
  btnPrefetch: $('btnPrefetch'), btnClearCache: $('btnClearCache'), cacheList: $('cacheList'),
  resSel: $('resSel'), fpsTarget: $('fpsTarget'), fpsTargetVal: $('fpsTargetVal'),
  chkDetector: $('chkDetector'),
  loading: $('loading'), loadingText: $('loadingText'), loadingBar: $('loadingBar'),
};

const ctx = el.overlay.getContext('2d');

const state = {
  landmarker: null, fileset: null, modelKey: null,
  ball: new BallTracker(),
  smoother: new AngleSmoother(0.35),
  running: false, source: null,          // 'camera' | 'file'
  stream: null,
  recording: false, frames: [], gripTrack: [],
  recT0: 0, lastAngles: null, lastConf: null, lastLandmarks: null,
  playing: false, playIdx: null,
  eventT: null, impact: null,
  calib: null,
  visible: new Set(),
  seriesOff: new Set(),
  fpsEMA: 0, lastFrameTs: 0,
  cancelAnalyze: false,
  lastBall: null, ballCands: [],
  rec: null, lastProcessed: 0, detectorLoaded: false, skipped: 0, usingCpu: false,
};

const chart = new TimeChart(el.chart, {
  onScrub: (t) => { if (state.frames.length) seekToTime(t); },
});

/* ================= 初期化 ================= */

function setStatus(text, cls = '') {
  el.status.textContent = text;
  el.status.className = 'pill' + (cls ? ' ' + cls : '');
}

function initSelects() {
  for (const [k, v] of Object.entries(LOAD.RESOLUTIONS)) {
    el.resSel.append(new Option(v.label, k));
  }
  // 端末と回線から既定値を決める（ユーザーはいつでも変更できる）
  const rec = LOAD.recommendedSettings();
  state.rec = rec;
  el.modelSel.value = rec.model;
  el.resSel.value = rec.resolution;
  el.fpsTarget.value = String(rec.targetFps);
  el.fpsTargetVal.textContent = `${rec.targetFps} fps`;
  el.chkDetector.checked = rec.loadDetector;
  state.ball.workW = rec.ballWorkWidth;
  renderNetInfo();
  renderCacheList();

  for (const [k, p] of Object.entries(PRESETS)) {
    el.presetSel.append(new Option(p.label, k));
  }
  el.presetSel.value = 'bat_R';
  for (const [k, v] of Object.entries(REF.BAT_SPEED_BY_LEVEL)) {
    el.levelSel.append(new Option(v.label, k));
  }
  el.levelSel.value = 'high';
  for (const [k, v] of Object.entries(REF.REFERENCE_SETS)) {
    el.refSetSel.append(new Option(v.label, k));
  }
  el.refSetSel.value = 'bat_R';
  applyPreset();
  renderSources();
  renderSwingPanel();
}

function applyPreset() {
  const p = PRESETS[el.presetSel.value] || PRESETS.all;
  state.visible = new Set(p.ids);
  renderCards(state.lastAngles, state.lastConf);
  renderLegend();
  updateChart();
}

async function ensureModel() {
  const key = el.modelSel.value;
  if (state.landmarker && state.modelKey === key) return;

  const { FilesetResolver, PoseLandmarker } = await loadVision();
  showLoading(true, 'ランタイムを準備中…', 0);
  if (!state.fileset) state.fileset = await FilesetResolver.forVisionTasks(wasmBase());

  const asset = LOAD.ASSETS[`pose_${key}`];
  const cached = await LOAD.isCached(asset.url);
  showLoading(true, cached ? 'モデルを読み込み中…' : `${asset.label} をダウンロード中…`, 0);

  const buf = await LOAD.loadModelBytes(asset.url, (loaded, total, fromCache) => {
    const pct = total ? (loaded / total) * 100 : 0;
    el.loadingBar.style.width = `${pct}%`;
    el.loadingText.textContent = fromCache
      ? 'モデルを読み込み中…（保存済み・通信なし）'
      : `${asset.label} をダウンロード中… ${LOAD.fmtBytes(loaded)} / ${LOAD.fmtBytes(total || asset.bytes)}`;
  });

  showLoading(true, 'モデルを初期化中…', 100);
  if (state.landmarker) { state.landmarker.close(); state.landmarker = null; }
  state.landmarker = await createWithFallback(PoseLandmarker, {
    modelAssetBuffer: buf,
    runningMode: 'VIDEO', numPoses: 1,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  }, 'PoseLandmarker');
  state.modelKey = key;
  await ensureDetector();
  showLoading(false);
  renderCacheList();
  setStatus(state.usingCpu ? '準備完了（CPU動作）' : '準備完了', 'on');
}

/**
 * WebGL が使えない端末では GPU デリゲートの初期化が返ってこないことがある。
 * 一定時間で見切りをつけて CPU にフォールバックする。
 */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} がタイムアウトしました`)), ms); }),
  ]);
}

async function createWithFallback(Klass, options, label) {
  const { modelAssetBuffer, ...rest } = options;
  try {
    return await withTimeout(
      Klass.createFromOptions(state.fileset, { baseOptions: { modelAssetBuffer, delegate: 'GPU' }, ...rest }),
      15000, `${label}(GPU) の初期化`);
  } catch (e) {
    console.warn(`${label}: GPU が使えないため CPU で初期化します`, e);
    showLoading(true, 'GPUが使えないためCPUで初期化中…（動作が遅くなります）', 100);
    state.usingCpu = true;
    return await Klass.createFromOptions(state.fileset,
      { baseOptions: { modelAssetBuffer, delegate: 'CPU' }, ...rest });
  }
}

/** 物体検出モデルは容量が大きいので、明示的にオンにしたときだけ読み込む */
async function ensureDetector() {
  if (!el.chkDetector.checked || state.detectorLoaded || !state.fileset) return;
  const asset = LOAD.ASSETS.detector;
  try {
    showLoading(true, `${asset.label} を準備中…`, 0);
    const buf = await LOAD.loadModelBytes(asset.url, (loaded, total, fromCache) => {
      const pct = total ? (loaded / total) * 100 : 0;
      el.loadingBar.style.width = `${pct}%`;
      el.loadingText.textContent = fromCache ? '物体検出モデルを読み込み中…（保存済み）'
        : `${asset.label} をダウンロード中… ${LOAD.fmtBytes(loaded)} / ${LOAD.fmtBytes(total || asset.bytes)}`;
    });
    await state.ball.initDetector(state.fileset, buf, state.usingCpu ? 'CPU' : 'GPU');
    state.detectorLoaded = true;
    renderCacheList();
  } catch (e) {
    console.warn('物体検出の初期化に失敗（動体検出のみで継続）', e);
  } finally {
    showLoading(false);
  }
}

function showLoading(on, text, pct) {
  el.loading.hidden = !on;
  if (text) el.loadingText.textContent = text;
  if (pct != null) el.loadingBar.style.width = `${pct}%`;
}

/* ================= 通信・オフライン ================= */

function renderNetInfo() {
  const r = state.rec;
  const typeLabel = { '4g': '4G相当以上', '3g': '3G相当', '2g': '2G相当', 'slow-2g': '低速' }[r.effectiveType] || '不明';
  el.netInfo.innerHTML = `回線 <b>${typeLabel}</b>${r.saveData ? '（データセーバー ON）' : ''} ／
    端末 <b>${r.mobile ? 'モバイル' : 'デスクトップ'}</b> ／ CPU <b>${r.cores}コア</b><br>
    推奨: モデル <b>${r.model === 'lite' ? 'Lite' : 'Full'}</b> ／ 解像度 <b>${LOAD.RESOLUTIONS[r.resolution].label.split(' ')[0]}</b> ／ 処理 <b>${r.targetFps}fps</b>`;
}

async function renderCacheList() {
  const rows = [];
  for (const [k, a] of Object.entries(LOAD.ASSETS)) {
    const has = await LOAD.isCached(a.url);
    rows.push(`<div>${has ? '<span class="yes">保存済</span>' : '<span class="no">未取得</span>'} ${a.label} <span class="no">${LOAD.fmtBytes(a.bytes)}</span></div>`);
  }
  el.cacheList.innerHTML = rows.join('');
}

async function prefetchAll() {
  const keys = ['pose_lite', 'pose_full'];
  if (el.chkDetector.checked) keys.push('detector');
  if (el.modelSel.value === 'heavy') keys.push('pose_heavy');
  el.btnPrefetch.disabled = true;
  el.dlBar.hidden = false; el.dlText.hidden = false;
  try {
    await LOAD.prefetchAll(keys, (loaded, total, label) => {
      el.dlBar.firstElementChild.style.width = `${(loaded / total * 100).toFixed(1)}%`;
      el.dlText.textContent = label
        ? `${label} … ${LOAD.fmtBytes(loaded)} / ${LOAD.fmtBytes(total)}`
        : `完了 — ${LOAD.fmtBytes(total)} を保存しました`;
    });
  } catch (e) {
    el.dlText.textContent = `ダウンロードに失敗しました: ${e.message}`;
  }
  el.btnPrefetch.disabled = false;
  renderCacheList();
}

/* ================= 入力ソース ================= */

async function startCamera() {
  try {
    await ensureModel();
    setStatus('カメラ起動中…');
    const R = LOAD.RESOLUTIONS[el.resSel.value] || LOAD.RESOLUTIONS.mid;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: R.width }, height: { ideal: R.height },
        frameRate: { ideal: 60 }, facingMode: { ideal: 'environment' },
      }, audio: false,
    });
    el.video.srcObject = state.stream;
    el.video.removeAttribute('src');
    el.video.loop = false;
    await el.video.play();
    state.source = 'camera';
    state.ball.reset();
    el.stage.classList.add('has-media');
    el.btnCamera.disabled = true; el.btnStopCamera.disabled = false;
    el.fileControls.hidden = true;
    setStatus('カメラ計測中', 'on');
    startLoop();
  } catch (e) {
    showLoading(false);
    setStatus(`開始できません: ${e.message}`, 'err');
    console.error(e);
  }
}

function stopCamera() {
  state.running = false;
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  el.video.srcObject = null;
  el.btnCamera.disabled = false; el.btnStopCamera.disabled = true;
  setStatus('停止', '');
}

async function loadFile(file) {
  await ensureModel();
  stopCamera();
  const url = URL.createObjectURL(file);
  el.video.srcObject = null;
  el.video.src = url;
  el.video.loop = false;
  await new Promise((res) => { el.video.onloadedmetadata = res; });
  const dur = await resolveDuration(el.video);
  el.video.currentTime = 0;
  state.source = 'file';
  state.ball.reset();
  el.stage.classList.add('has-media');
  el.fileControls.hidden = false;
  setStatus(`動画読込 (${dur.toFixed(1)}s)`, 'on');
  resizeOverlay();
  drawFrameOnly();
}

/* ================= 解析ループ ================= */

function startLoop() {
  if (state.running) return;
  state.running = true;
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const tick = () => {
    if (!state.running) return;
    const now = performance.now();
    const minGap = 1000 / Math.max(1, +el.fpsTarget.value);
    // 目標レートを超えるフレームは推定を省いて端末の負荷を抑える
    if (now - state.lastProcessed >= minGap - 1) {
      state.lastProcessed = now;
      processFrame(now);
    } else {
      state.skipped++;
    }
    if (useRVFC) el.video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (useRVFC) el.video.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
}

function resizeOverlay() {
  const v = el.video, o = el.overlay;
  const r = v.getBoundingClientRect(), sr = el.stage.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
  o.style.left = `${r.left - sr.left}px`;
  o.style.top = `${r.top - sr.top}px`;
  o.style.width = `${w}px`; o.style.height = `${h}px`;
}

/** 1フレームの姿勢推定・角度計算・描画 */
function processFrame(tMs) {
  const v = el.video;
  if (!state.landmarker || !v.videoWidth) return;
  resizeOverlay();

  let result;
  try { result = state.landmarker.detectForVideo(v, Math.round(tMs)); }
  catch { return; }

  const now = performance.now();
  if (state.lastFrameTs) {
    const inst = 1000 / Math.max(1, now - state.lastFrameTs);
    state.fpsEMA = state.fpsEMA ? state.fpsEMA * 0.9 + inst * 0.1 : inst;
    el.fps.textContent = `${state.fpsEMA.toFixed(0)} fps`;
  }
  state.lastFrameTs = now;

  const norm = result.landmarks?.[0] || null;
  const world = result.worldLandmarks?.[0] || null;

  // ボール検出（姿勢の有無に関わらず走らせる）
  let ballRes = { ball: null, candidates: [] };
  if (el.chkBall.checked) {
    state.ball.enabled = true;
    ballRes = state.ball.process(v, tMs, norm);
  } else {
    state.ball.enabled = false;
  }
  state.lastBall = ballRes.ball;
  state.ballCands = ballRes.candidates;

  let angles = null, conf = null;
  if (norm && world) {
    const W = el.overlay.width, H = el.overlay.height;
    const pixels = norm.map((p) => ({ x: p.x * W, y: p.y * H, z: 0, visibility: p.visibility }));
    const r = computeAngles(world, pixels, el.dimSel.value);
    angles = state.smoother.apply(r.angles);
    conf = r.conf;
    state.lastAngles = angles; state.lastConf = conf; state.lastLandmarks = norm;

    if (state.recording) {
      const t = tMs - state.recT0;
      state.frames.push({ t, angles: { ...angles }, conf, lm: norm.map((p) => ({ x: p.x, y: p.y, v: p.visibility })) });
      const grip = gripPx(norm);
      if (grip) state.gripTrack.push({ t: tMs, x: grip.x * v.videoWidth, y: grip.y * v.videoHeight });
    }
  }

  draw(norm, angles, conf, ballRes);
  renderCards(angles, conf);
  if (state.recording && state.frames.length % 4 === 0) updateChart();
}

function gripPx(norm) {
  if (!norm) return null;
  const a = norm[LM.L_WRIST], b = norm[LM.R_WRIST];
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/* ================= 描画 ================= */

function draw(norm, angles, conf, ballRes) {
  const W = el.overlay.width, H = el.overlay.height;
  ctx.clearRect(0, 0, W, H);
  const mirror = el.chkMirror.checked;
  const X = (nx) => (mirror ? W - nx * W : nx * W);
  const Y = (ny) => ny * H;

  if (norm && el.chkSkeleton.checked) {
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(79,195,247,.85)';
    ctx.beginPath();
    for (const [a, b] of CONNECTIONS) {
      const pa = norm[a], pb = norm[b];
      if (!pa || !pb) continue;
      if ((pa.visibility ?? 1) < 0.35 || (pb.visibility ?? 1) < 0.35) continue;
      ctx.moveTo(X(pa.x), Y(pa.y)); ctx.lineTo(X(pb.x), Y(pb.y));
    }
    ctx.stroke();
    ctx.fillStyle = '#fff';
    for (const p of norm) {
      if ((p.visibility ?? 1) < 0.35) continue;
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  if (norm && angles && el.chkArcs.checked) {
    for (const id of state.visible) {
      const m = METRIC_BY_ID[id];
      if (!m?.arc) continue;
      const v = angles[id];
      if (v == null) continue;
      const [ia, ib, ic] = m.arc;
      const A = { x: X(norm[ia].x), y: Y(norm[ia].y) };
      const B = { x: X(norm[ib].x), y: Y(norm[ib].y) };
      const C = { x: X(norm[ic].x), y: Y(norm[ic].y) };
      drawArc(A, B, C, v, m.color, conf?.[id] ?? 1);
    }
  }

  drawBall(ballRes, mirror, W, H);
}

function drawArc(A, B, C, value, color, confidence) {
  if (confidence < 0.4) return;
  const a1 = Math.atan2(A.y - B.y, A.x - B.x);
  const a2 = Math.atan2(C.y - B.y, C.x - B.x);
  let diff = a2 - a1;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  const R = 26;
  ctx.strokeStyle = color; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(B.x, B.y, R, a1, a1 + diff, diff < 0); ctx.stroke();

  const midA = a1 + diff / 2;
  const tx = B.x + Math.cos(midA) * (R + 20), ty = B.y + Math.sin(midA) * (R + 20);
  const label = `${value.toFixed(0)}°`;
  ctx.font = '600 14px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width + 10;
  ctx.fillStyle = 'rgba(8,12,18,.82)';
  ctx.beginPath(); ctx.roundRect(tx - w / 2, ty - 10, w, 20, 5); ctx.fill();
  ctx.fillStyle = color; ctx.fillText(label, tx, ty);
}

function drawBall(ballRes, mirror, W, H) {
  const v = el.video;
  if (!v.videoWidth) return;
  const sx = W / v.videoWidth, sy = H / v.videoHeight;
  const PX = (x) => (mirror ? W - x * sx : x * sx);
  const PY = (y) => y * sy;

  if (el.chkBallDebug.checked) {
    ctx.strokeStyle = 'rgba(255,201,60,.5)'; ctx.lineWidth = 1;
    for (const c of ballRes.candidates || []) {
      ctx.beginPath(); ctx.arc(PX(c.x), PY(c.y), Math.max(4, c.r * sx), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // 追跡済みの軌跡
  const traj = state.ball.trajectory;
  if (traj.length > 1) {
    ctx.strokeStyle = 'rgba(255,107,129,.75)'; ctx.lineWidth = 2;
    ctx.beginPath();
    const from = Math.max(0, traj.length - 90);
    for (let i = from; i < traj.length; i++) {
      const p = traj[i];
      if (i === from) ctx.moveTo(PX(p.x), PY(p.y)); else ctx.lineTo(PX(p.x), PY(p.y));
    }
    ctx.stroke();
  }

  const b = ballRes.ball;
  if (b) {
    const r = Math.max(6, b.r * sx);
    ctx.strokeStyle = b.measured ? '#ffdd57' : 'rgba(255,221,87,.45)';
    ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(PX(b.x), PY(b.y), r + 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = b.measured ? '#ffdd57' : 'rgba(255,221,87,.5)';
    ctx.font = '10px system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(b.src === 'detector' ? 'BALL(検出)' : b.src === 'predicted' ? 'BALL(予測)' : 'BALL', PX(b.x) + r + 6, PY(b.y) - 4);
  }
}

function drawFrameOnly() {
  resizeOverlay();
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
}

/* ================= 動画ファイルの一括解析 ================= */

/**
 * duration が Infinity になる動画（MediaRecorder 由来の webm など）に対応する。
 * 一度大きな時刻へシークさせると、多くのブラウザで実際の長さが確定する。
 */
function resolveDuration(v) {
  if (Number.isFinite(v.duration) && v.duration > 0) return Promise.resolve(v.duration);
  return new Promise((res) => {
    const done = () => {
      v.removeEventListener('seeked', done);
      const d = Number.isFinite(v.duration) ? v.duration : 0;
      v.currentTime = 0;
      res(d);
    };
    v.addEventListener('seeked', done);
    setTimeout(done, 3000);
    try { v.currentTime = 1e6; } catch { done(); }
  });
}

function seekTo(video, t) {
  return new Promise((res) => {
    const on = () => { video.removeEventListener('seeked', on); res(); };
    video.addEventListener('seeked', on);
    video.currentTime = t;
  });
}

async function analyzeFile() {
  const v = el.video;
  const duration = await resolveDuration(v);
  if (!duration) { setStatus('動画の長さを判定できません', 'err'); return; }
  await ensureModel();
  state.running = false;
  state.cancelAnalyze = false;
  clearRecording();
  state.recording = true;
  state.recT0 = 0;
  state.ball.reset();
  state.smoother.reset();

  el.btnAnalyzeFile.disabled = true;
  el.btnCancelAnalyze.hidden = false;
  el.analyzeProgress.hidden = false;
  const bar = el.analyzeProgress.firstElementChild;

  const fps = 60;
  const dt = 1 / fps;
  v.pause();
  for (let t = 0; t < duration && !state.cancelAnalyze; t += dt) {
    await seekTo(v, t);
    processFrame(t * 1000);
    bar.style.width = `${(t / duration * 100).toFixed(1)}%`;
    if (Math.round(t / dt) % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  state.recording = false;
  el.btnAnalyzeFile.disabled = false;
  el.btnCancelAnalyze.hidden = true;
  el.analyzeProgress.hidden = true;
  bar.style.width = '0%';
  finishRecording();
  setStatus(`解析完了 ${state.frames.length} フレーム`, 'on');
}

/* ================= 記録・再生 ================= */

function toggleRecord() {
  if (!state.recording) {
    clearRecording();
    state.recording = true;
    state.recT0 = performance.now();
    state.smoother.reset();
    state.ball.reset();
    el.btnRecord.textContent = '■ 記録停止';
    el.btnRecord.classList.add('active');
  } else {
    state.recording = false;
    el.btnRecord.textContent = '● 記録開始';
    el.btnRecord.classList.remove('active');
    finishRecording();
  }
}

function clearRecording() {
  state.frames = []; state.gripTrack = []; state.eventT = null; state.impact = null;
  el.btnPlay.disabled = true; el.scrub.disabled = true; el.btnCsv.disabled = true;
  el.btnClear.disabled = true; el.btnMarkEvent.disabled = true;
  el.eventState.textContent = 'イベント未設定';
  chart.setData({ series: [], range: null, events: [], bands: [] });
  el.compareTable.innerHTML = '';
  renderSwingPanel();
}

function finishRecording() {
  if (!state.frames.length) return;
  el.btnPlay.disabled = false; el.scrub.disabled = false;
  el.btnCsv.disabled = false; el.btnClear.disabled = false;
  el.btnMarkEvent.disabled = false;

  // ボール軌道からインパクトを自動推定
  const gripAt = (t) => {
    let best = null, bd = Infinity;
    for (const g of state.gripTrack) {
      const d = Math.abs(g.t - t);
      if (d < bd) { bd = d; best = g; }
    }
    return bd < 60 ? best : null;
  };
  const imp = detectImpact(state.ball.trajectory, gripAt, { frameW: el.video.videoWidth || 1280 });
  state.impact = imp ? analyzeImpact(state.ball.trajectory, imp) : null;
  if (state.impact) {
    const relT = state.impact.t - (state.source === 'file' ? 0 : state.recT0);
    state.eventT = relT;
    el.eventState.textContent = `インパクトを自動検出: ${(relT / 1000).toFixed(3)}s（方向転換 ${state.impact.turnDeg}°）`;
  }
  updateChart();
  renderCompare();
  renderSwingPanel();
}

function updateChart() {
  if (!state.frames.length) { chart.setData({ series: [], range: null, events: [], bands: [] }); return; }
  const t0 = state.frames[0].t, t1 = state.frames[state.frames.length - 1].t;
  const series = [];
  for (const id of state.visible) {
    const m = METRIC_BY_ID[id];
    if (!m) continue;
    series.push({
      id, label: m.short, color: m.color, visible: !state.seriesOff.has(id),
      points: state.frames.map((f) => ({ t: f.t, v: adjust(id, f.angles[id]) })),
    });
  }
  const events = [];
  if (state.eventT != null) events.push({ t: state.eventT, label: 'イベント', color: '#ff6b81' });
  chart.setData({ series, range: [t0, Math.max(t1, t0 + 1)], events, bands: [] });
  renderLegend();
}

/** キャリブレーション補正を適用した表示値 */
function adjust(id, v) {
  if (v == null) return null;
  if (state.calib && (id === 'shoulder_rot' || id === 'pelvis_rot')) {
    return wrapDeg(v - state.calib[id]);
  }
  return v;
}

function seekToTime(t) {
  if (!state.frames.length) return;
  let idx = 0, bd = Infinity;
  for (let i = 0; i < state.frames.length; i++) {
    const d = Math.abs(state.frames[i].t - t);
    if (d < bd) { bd = d; idx = i; }
  }
  showFrame(idx);
}

function showFrame(idx) {
  const f = state.frames[idx];
  if (!f) return;
  state.playIdx = idx;
  el.scrub.value = String(Math.round((idx / Math.max(1, state.frames.length - 1)) * 1000));
  el.timeLabel.textContent = `${(f.t / 1000).toFixed(2)}s`;
  chart.setPlayhead(f.t);
  renderCards(f.angles, f.conf);
  if (state.source === 'file') el.video.currentTime = f.t / 1000;
  const norm = f.lm.map((p) => ({ x: p.x, y: p.y, z: 0, visibility: p.v }));
  draw(norm, f.angles, f.conf, { ball: null, candidates: [] });
}

/* ================= 右パネル描画 ================= */

function renderCards(angles, conf) {
  const ids = [...state.visible];
  if (!angles) {
    el.angleCards.innerHTML = '<p class="hint">姿勢が検出されるとここに角度が出ます。</p>';
    return;
  }
  el.angleCards.innerHTML = ids.map((id) => {
    const m = METRIC_BY_ID[id];
    if (!m) return '';
    const raw = angles[id];
    const v = adjust(id, raw);
    const c = conf?.[id] ?? 1;
    const na = el.dimSel.value === '2d' && m.dim === '3d';
    const body = na
      ? '<span class="na">2Dモードでは計測不可</span>'
      : v == null ? '<span class="na">—</span>'
      : `<span class="num">${v.toFixed(1)}<small>°</small></span>`;
    return `<div class="card ${c < 0.5 ? 'low' : ''}" style="border-left-color:${m.color}" title="${m.hint}">
      <div><div class="lbl">${m.label}</div><div class="sub">${m.group}${c < 0.5 ? ' · 検出が不安定' : ''}</div></div>
      ${body}</div>`;
  }).join('');
}

function renderLegend() {
  el.legend.innerHTML = [...state.visible].map((id) => {
    const m = METRIC_BY_ID[id];
    if (!m) return '';
    return `<span data-id="${id}" class="${state.seriesOff.has(id) ? 'off' : ''}">
      <i style="background:${m.color}"></i>${m.short}</span>`;
  }).join('');
  el.legend.querySelectorAll('span').forEach((s) => {
    s.onclick = () => {
      const id = s.dataset.id;
      if (state.seriesOff.has(id)) state.seriesOff.delete(id); else state.seriesOff.add(id);
      updateChart();
    };
  });
}

function frameAt(t) {
  if (!state.frames.length || t == null) return null;
  let best = null, bd = Infinity;
  for (const f of state.frames) {
    const d = Math.abs(f.t - t);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
}

function renderCompare() {
  const set = REF.REFERENCE_SETS[el.refSetSel.value];
  const f = frameAt(state.eventT);
  if (!set) return;
  if (!f) {
    el.compareTable.innerHTML = '<p class="hint">記録してからイベント（インパクト／踏込足接地）を設定すると比較できます。</p>';
    return;
  }
  const rows = set.refs.map((r) => {
    const m = METRIC_BY_ID[r.metric];
    let actual = adjust(r.metric, f.angles[r.metric]);
    let note = '';
    if (r.needsCalib) {
      if (!state.calib) note = '<div class="caution">「構えの姿勢を基準にセット」が未実行のため、この値は文献と同じ基準になっていません。</div>';
      actual = actual == null ? null : Math.abs(actual);
      note += '<div class="rawnote">回旋の向きは自動的に正方向へ揃えています。</div>';
    }
    const na = el.dimSel.value === '2d' && m?.dim === '3d';
    if (na) {
      return `<tr><td><b>${r.label}</b><div class="rawnote">${r.raw}</div></td>
        <td colspan="2"><span class="na">3Dモードでのみ計測可</span></td></tr>`;
    }
    const c = REF.compare(actual, r.mean, r.sd);
    return `<tr>
      <td><b>${r.label}</b> <span class="tag l1">${r.level}</span>
        <div class="rawnote">基準 ${r.mean}° ± ${r.sd}°（${REF.CITATIONS[r.cite].key}）</div>
        <div class="rawnote">${r.raw}</div>
        ${r.caution ? `<div class="caution">⚠ ${r.caution}</div>` : ''}
        ${note}</td>
      <td class="v">${c ? `${c.actual}°` : '—'}<div class="rawnote">${c ? `${c.diff >= 0 ? '+' : ''}${c.diff}° / ${c.z}SD` : ''}</div></td>
      <td>${c ? `<span class="verdict ${c.verdict.tone}">${c.verdict.label}</span>` : ''}</td>
    </tr>`;
  }).join('');

  el.compareTable.innerHTML = `<table class="cmp">
    <thead><tr><th>項目</th><th>実測</th><th>判定</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p class="hint">比較時刻: ${(f.t / 1000).toFixed(3)}s ／ 比較対象: ${set.label}</p>`;
}

function renderSwingPanel() {
  const h = +el.heightCm.value, m = +el.massKg.value;
  const anth = REF.anthropometry(h, m);
  const bat = REF.batRecommendation(h, m);
  const ideal = REF.idealAttackAngle({
    levelKey: el.levelSel.value, heightCm: h, massKg: m,
    measuredMph: el.batSpeed.value ? +el.batSpeed.value : null,
    pitchType: el.pitchTypeSel.value,
  });

  // 実測のスイング軌道角
  let measured = null, incoming = null, outgoing = null;
  if (state.impact) {
    const sp = swingPathAngle(state.gripTrack, state.impact.t);
    if (sp) measured = sp.deg;
    incoming = state.impact.incoming?.deg ?? null;
    outgoing = state.impact.outgoing?.deg ?? null;
  }

  const barFor = (val, lo, hi, target) => {
    const min = -20, max = 40;
    const pct = (v) => `${((v - min) / (max - min) * 100).toFixed(1)}%`;
    const wd = `${((hi - lo) / (max - min) * 100).toFixed(1)}%`;
    return `<div class="bar">
      <div class="band" style="left:${pct(lo)};width:${wd}"></div>
      <div class="tgt" style="left:${pct(target)}"></div>
      ${val != null ? `<div class="mark" style="left:${pct(val)}"></div>` : ''}
    </div><div class="scale"><span>-20°</span><span>0°</span><span>+40°</span></div>`;
  };

  const diff = measured != null ? measured - ideal.distance.target : null;

  el.swingPanel.innerHTML = `
    <div class="metric-big">
      <div class="t">目標アタックアングル（飛距離重視） <span class="tag l2">${ideal.distance.level}</span></div>
      <div class="n">${ideal.distance.target}<small>° （許容 ${ideal.distance.lo}〜${ideal.distance.hi}°）</small></div>
      ${barFor(measured, ideal.distance.lo, ideal.distance.hi, ideal.distance.target)}
      <div class="t" style="margin-top:10px">実測スイング軌道角（グリップ軌道から算出）</div>
      <div class="n">${measured != null ? `${measured.toFixed(1)}<small>°</small>` : '<small style="font-size:13px">未計測 — ボールのインパクトが検出されていません</small>'}</div>
      ${diff != null ? `<div class="t" style="margin-top:6px">目標との差: <b style="color:${Math.abs(diff) <= 5 ? 'var(--good)' : Math.abs(diff) <= 10 ? 'var(--warn)' : 'var(--bad)'}">${diff >= 0 ? '+' : ''}${diff.toFixed(1)}°</b></div>` : ''}
      <div class="rawnote">バットは検出していません。両手首の中点（グリップ）のインパクト前後の軌道角を、アタックアングルの近似として使っています。カメラを打者の真横に置いた場合のみ有効です。</div>
    </div>

    <div class="metric-big">
      <div class="t">目標アタックアングル（当てやすさ重視・入射角マッチ） <span class="tag l2">${ideal.contact.level}</span></div>
      <div class="n">${ideal.contact.target}<small>° （許容 ${ideal.contact.lo}〜${ideal.contact.hi}°）</small></div>
      <div class="rawnote">投球の入射角と同じ角度で振ると、タイミングが多少ずれても良い当たりになりやすい（Nathan）。</div>
    </div>

    <div class="metric-big">
      <div class="t">ボール軌道の実測</div>
      <div class="n" style="font-size:18px">
        入射角 ${incoming != null ? `${incoming.toFixed(1)}°` : '—'}
        &nbsp;/&nbsp; 打ち出し角 ${outgoing != null ? `${outgoing.toFixed(1)}°` : '—'}
      </div>
      <div class="rawnote">画面上の軌道から算出（カメラが打者の真横にある前提）。追跡点 ${state.ball.trajectory.length} 点。</div>
    </div>

    <div class="metric-big">
      <div class="t">算出の根拠</div>
      <ul class="reasons">${ideal.rationale.map((r) => `<li>${r}</li>`).join('')}</ul>
      <div class="rawnote" style="margin-top:8px">${ideal.batSpeed.detail}</div>
    </div>

    <div class="metric-big">
      <div class="t">体格から <span class="tag l3">${REF.LEVEL.L3}</span></div>
      <div class="rawnote" style="line-height:1.9">
        BMI ${anth.bmi}<br>
        推定体節長: 上腕 ${anth.segments.upperArm} / 前腕 ${anth.segments.forearm} / 大腿 ${anth.segments.thigh} / 下腿 ${anth.segments.shank} cm<br>
        肩からグリップまでの回転半径 約 ${anth.armRadiusCm} cm（Winter の身長比による推定）<br>
        バット長の目安 <b>${bat.lengthIn} インチ（約 ${bat.lengthCm} cm）</b> ／ 重さの目安 <b>約 ${bat.weightG} g</b>
      </div>
      <div class="caution">体節長の比率は文献（Winter / De Leva）由来ですが、バット長・重さの目安と、体格によるバットスピード補正は当アプリの推定であり、検証されていません。</div>
    </div>`;
}

function renderSources() {
  el.sourceList.innerHTML = `
    <div class="notice">
      <b>この画面の数値の出所</b><br>
      <span class="tag l1">${REF.LEVEL.L1}</span> 論文の mean ± SD をそのまま使用<br>
      <span class="tag l2">${REF.LEVEL.L2}</span> 論文が示した関係式を内挿<br>
      <span class="tag l3">${REF.LEVEL.L3}</span> 体格からの補正。当アプリの推定で未検証
    </div>
    ${Object.values(REF.CITATIONS).map((c) => `<div class="src">
      <b>${c.key}</b>${c.text}
      <a href="${c.url}" target="_blank" rel="noopener">${c.url}</a>
      <span class="n">${c.note}</span></div>`).join('')}
    <div class="src">
      <b>姿勢推定</b>MediaPipe Pose Landmarker（33ランドマーク）／ 物体検出 EfficientDet-Lite0（COCO）。
      <span class="n">モデル・WASM はすべてローカルに同梱されており、映像は端末外に送信されません。</span></div>
    <div class="notice warn" style="margin-top:12px">
      <b>計測上の限界</b><br>
      ・単眼カメラの奥行き(z)は推定値であり、回旋角・水平内外転角は撮影方向に強く依存します。<br>
      ・肩の内外旋（投球で重要な最大外旋角）は、この33点のランドマークからは計測できません。<br>
      ・30fpsでは投球・打球のボールは1フレームで大きく移動しブレるため、検出率が落ちます。120fps以上を推奨します。<br>
      ・比較対象の論文は成人の上級者を対象としています。成長期の選手にそのまま当てはめないでください。
    </div>`;
}

/* ================= CSV ================= */

function exportCsv() {
  const ids = METRICS.map((m) => m.id);
  const head = ['time_s', ...ids.map((id) => `${METRIC_BY_ID[id].label}(deg)`)].join(',');
  const lines = state.frames.map((f) => {
    const vals = ids.map((id) => {
      const v = adjust(id, f.angles[id]);
      return v == null ? '' : v.toFixed(2);
    });
    return [(f.t / 1000).toFixed(4), ...vals].join(',');
  });
  const blob = new Blob(['﻿' + head + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `motion_angles_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ================= イベント配線 ================= */

el.btnCamera.onclick = startCamera;
el.btnStopCamera.onclick = stopCamera;
el.fileInput.onchange = (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); };
el.btnAnalyzeFile.onclick = analyzeFile;
el.btnCancelAnalyze.onclick = () => { state.cancelAnalyze = true; };
el.modelSel.onchange = () => { state.landmarker = null; ensureModel(); };
el.dimSel.onchange = () => { state.smoother.reset(); renderCards(state.lastAngles, state.lastConf); renderCompare(); };
el.smoothing.oninput = () => {
  el.smoothVal.textContent = (+el.smoothing.value).toFixed(2);
  state.smoother.alpha = 1 - +el.smoothing.value; // スライダーは「平滑化の強さ」
};
state.smoother.alpha = 1 - +el.smoothing.value;
el.presetSel.onchange = applyPreset;
el.ballTh.oninput = () => { el.ballThVal.textContent = el.ballTh.value; state.ball.diffThreshold = +el.ballTh.value; };
const syncBallSize = () => {
  const lo = Math.min(+el.ballSizeMin.value, +el.ballSizeMax.value - 2);
  const hi = +el.ballSizeMax.value;
  state.ball.minDiameter = lo; state.ball.maxDiameter = hi;
  el.ballSizeVal.textContent = `${lo}–${hi}`;
};
el.ballSizeMin.oninput = syncBallSize; el.ballSizeMax.oninput = syncBallSize;

el.fpsTarget.oninput = () => { el.fpsTargetVal.textContent = `${el.fpsTarget.value} fps`; };
el.resSel.onchange = () => { if (state.source === 'camera') { stopCamera(); startCamera(); } };
el.chkDetector.onchange = () => {
  if (el.chkDetector.checked) ensureDetector();
  else { state.ball.detector = null; state.detectorLoaded = false; }
};
el.btnPrefetch.onclick = prefetchAll;
el.btnClearCache.onclick = async () => {
  await LOAD.clearCache();
  state.landmarker = null; state.modelKey = null; state.detectorLoaded = false;
  el.dlText.hidden = false;
  el.dlText.textContent = '保存データを削除しました。次回起動時に再ダウンロードされます。';
  renderCacheList();
};

el.btnRecord.onclick = toggleRecord;
el.btnClear.onclick = clearRecording;
el.btnCsv.onclick = exportCsv;
el.scrub.oninput = () => {
  const idx = Math.round((+el.scrub.value / 1000) * (state.frames.length - 1));
  showFrame(idx);
};
el.btnPlay.onclick = () => {
  if (state.playing) { state.playing = false; el.btnPlay.textContent = '▶ 再生'; return; }
  state.playing = true; el.btnPlay.textContent = '⏸ 一時停止';
  let i = state.playIdx ?? 0;
  const step = () => {
    if (!state.playing) return;
    if (i >= state.frames.length) { state.playing = false; el.btnPlay.textContent = '▶ 再生'; return; }
    showFrame(i);
    const dt = i + 1 < state.frames.length ? state.frames[i + 1].t - state.frames[i].t : 33;
    i++;
    setTimeout(step, Math.max(16, dt));
  };
  step();
};

el.btnMarkEvent.onclick = () => {
  const f = state.frames[state.playIdx ?? 0];
  if (!f) return;
  state.eventT = f.t;
  el.eventState.textContent = `イベント設定: ${(f.t / 1000).toFixed(3)}s（手動）`;
  updateChart();
  renderCompare();
};

el.btnCalib.onclick = () => {
  const a = state.lastAngles;
  if (!a) { el.calibState.textContent = '姿勢が検出されていません。'; return; }
  state.calib = { shoulder_rot: a.shoulder_rot ?? 0, pelvis_rot: a.pelvis_rot ?? 0 };
  el.calibState.textContent = `設定済み — 肩 ${state.calib.shoulder_rot.toFixed(1)}° / 骨盤 ${state.calib.pelvis_rot.toFixed(1)}° を 0° として扱います。`;
  renderCards(state.lastAngles, state.lastConf);
  updateChart(); renderCompare();
};

for (const id of ['heightCm', 'massKg', 'levelSel', 'batSpeed', 'pitchTypeSel']) {
  el[id].addEventListener('change', renderSwingPanel);
  el[id].addEventListener('input', renderSwingPanel);
}
el.refSetSel.onchange = renderCompare;

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $(`tab-${t.dataset.tab}`).classList.add('active');
  };
});

window.addEventListener('resize', () => { resizeOverlay(); chart.draw(); });
el.video.addEventListener('loadeddata', resizeOverlay);

// アプリ本体をキャッシュしてオフラインでも起動できるようにする
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: './' })
    .catch((e) => console.warn('Service Worker の登録に失敗', e));
}

// ローカル開発時のみ、テストから内部状態を触れるようにする
if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) {
  window.__bml = { state, updateChart, renderCompare, finishRecording, exportCsv, adjust, frameAt };
}

resolveSource().then(() => { renderCacheList(); renderNetInfo(); });
initSelects();
setStatus('モデル未読込 — カメラ開始かファイル読込で初期化されます');
