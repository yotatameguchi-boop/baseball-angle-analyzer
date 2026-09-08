import { loadVision, resolveSource, wasmBase, isLocalAssets } from './config.js';
import * as LOAD from './loader.js';
import { METRICS, METRIC_BY_ID, CONNECTIONS, LM, PRESETS, computeAngles, AngleSmoother, wrapDeg } from './metrics.js';
import { BallTracker, detectImpact, analyzeImpact, swingPathAngle, pathAngle } from './ball.js';
import { TimeChart } from './chart.js';
import * as REF from './reference.js';
import * as EV from './events.js';

const $ = (id) => document.getElementById(id);
const el = {
  video: $('video'), overlay: $('overlay'), stage: $('stage'),
  status: $('status'), fps: $('fps'),
  btnCamera: $('btnCamera'), btnStopCamera: $('btnStopCamera'),
  fileInput: $('fileInput'), fileControls: $('fileControls'),
  btnAnalyzeFile: $('btnAnalyzeFile'), btnCancelAnalyze: $('btnCancelAnalyze'),
  analyzeFps: $('analyzeFps'),
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
  btnStepBack: $('btnStepBack'), btnStepFwd: $('btnStepFwd'),
  speedSel: $('speedSel'), chkLoop: $('chkLoop'),
  btnSetA: $('btnSetA'), btnSetB: $('btnSetB'), btnClearAB: $('btnClearAB'), abLabel: $('abLabel'),
  timeLabel: $('timeLabel'), btnClear: $('btnClear'), btnCsv: $('btnCsv'),
  chart: $('chart'), legend: $('legend'), angleCards: $('angleCards'),
  eventList: $('eventList'), compareTable: $('compareTable'), diagNotice: $('diagNotice'),
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
  playing: false, playIdx: null, playTimer: null, playGen: 0,
  loopA: null, loopB: null,
  mediaRecorder: null, recChunks: [], recordedUrl: null, ballTimeOffset: 0,
  // frames[].t のうち、動画の 0 秒に対応する時刻（録画開始の遅れを吸収する）
  videoTimeOffset: 0, captureT0: null,
  eventT: null, impact: null, events: {}, seq: null, maxSep: null, window: null,
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
  renderEvents();
  renderCompare();
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
  state.ballTimeOffset = 0;
  state.videoTimeOffset = 0;
  state.ball.reset();
  state.smoother.reset();

  el.btnAnalyzeFile.disabled = true;
  el.btnCancelAnalyze.hidden = false;
  el.analyzeProgress.hidden = false;
  const bar = el.analyzeProgress.firstElementChild;

  const fps = +el.analyzeFps.value || 30;
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
  setStatus(`解析完了 ${state.frames.length} フレーム（${fps}fps）`, 'on');
}

/* ================= 記録・再生 ================= */

async function toggleRecord() {
  if (!state.recording) {
    // 前回の記録を見返している最中なら、まずライブ映像に戻す
    if (state.source === 'recorded' && state.stream) await resumeLive();
    clearRecording();
    state.recording = true;
    state.recT0 = performance.now();
    state.ballTimeOffset = state.recT0;
    state.smoother.reset();
    state.ball.reset();
    startVideoCapture();
    el.btnRecord.textContent = '■ 記録停止';
    el.btnRecord.classList.add('active');
  } else {
    state.recording = false;
    el.btnRecord.textContent = '● 記録開始';
    el.btnRecord.classList.remove('active');
    el.btnRecord.disabled = true;
    try {
      const blob = await stopVideoCapture();
      finishRecording();
      if (blob) await attachRecordedVideo(blob);
    } finally {
      el.btnRecord.disabled = false;
    }
  }
}

/* ---------- カメラ記録の映像保存（あとで繰り返し見返すため） ---------- */

function startVideoCapture() {
  state.recChunks = [];
  state.mediaRecorder = null;
  state.captureT0 = null;
  if (state.source !== 'camera' || !state.stream || typeof MediaRecorder === 'undefined') return;
  try {
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
      .find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(state.stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = (e) => { if (e.data && e.data.size) state.recChunks.push(e.data); };
    // MediaRecorder の開始は記録開始より僅かに遅れるので、その差を保持しておく
    mr.onstart = () => { state.captureT0 = performance.now(); };
    mr.start();
    state.mediaRecorder = mr;
  } catch (e) {
    console.warn('映像の保存を開始できません（骨格のみ見返せます）', e);
  }
}

async function stopVideoCapture() {
  const mr = state.mediaRecorder;
  state.mediaRecorder = null;
  if (!mr || mr.state === 'inactive') return null;
  await new Promise((res) => { mr.onstop = res; try { mr.stop(); } catch { res(); } });
  if (!state.recChunks.length) return null;
  return new Blob(state.recChunks, { type: state.recChunks[0].type || 'video/webm' });
}

/** 記録した映像を video 要素に読み込み、繰り返し見返せる状態にする */
async function attachRecordedVideo(blob) {
  state.running = false;                       // ライブ解析ループを止める
  if (state.recordedUrl) URL.revokeObjectURL(state.recordedUrl);
  state.recordedUrl = URL.createObjectURL(blob);
  const v = el.video;
  v.pause();
  v.srcObject = null;
  v.src = state.recordedUrl;
  v.loop = false;
  await new Promise((res) => {
    const done = () => { v.removeEventListener('loadedmetadata', done); res(); };
    v.addEventListener('loadedmetadata', done);
    setTimeout(done, 4000);
  });
  await resolveDuration(v);
  state.videoTimeOffset = state.captureT0 != null ? state.captureT0 - state.recT0 : 0;
  v.currentTime = 0;
  state.source = 'recorded';
  resizeOverlay();
  showFrame(0, true);
  setStatus('記録を見返せます（カメラは一時停止中）', 'on');
}

/** ライブのカメラ映像に戻す */
async function resumeLive() {
  const v = el.video;
  if (!state.stream) return false;
  v.pause();
  v.removeAttribute('src');
  v.load();
  v.srcObject = state.stream;
  try { await v.play(); } catch { /* 自動再生が拒否されても続行 */ }
  state.source = 'camera';
  setStatus('カメラ計測中', 'on');
  startLoop();
  return true;
}

function clearRecording() {
  state.frames = []; state.gripTrack = []; state.eventT = null; state.impact = null;
  state.events = {}; state.seq = null; state.maxSep = null;
  state.loopA = state.loopB = null; state.playIdx = null;
  stopPlayback();
  for (const b of [el.btnPlay, el.scrub, el.btnCsv, el.btnClear,
                   el.btnStepBack, el.btnStepFwd, el.btnSetA, el.btnSetB, el.btnClearAB]) b.disabled = true;
  renderAbLabel();
  renderEvents();
  chart.setData({ series: [], range: null, events: [], bands: [] });
  el.compareTable.innerHTML = '';
  renderSwingPanel();
}

function finishRecording() {
  if (!state.frames.length) return;
  for (const b of [el.btnPlay, el.scrub, el.btnCsv, el.btnClear,
                   el.btnStepBack, el.btnStepFwd, el.btnSetA, el.btnSetB, el.btnClearAB]) b.disabled = false;

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

  // 打撃／投球のどちらとして解析するかで、検出するイベントを変える
  const set = REF.REFERENCE_SETS[el.refSetSel.value];
  state.events = EV.detectEvents(state.frames, {
    kind: set.kind, lead: set.lead, trail: set.trail,
    ballTrajectory: state.ball.trajectory,
    ballTimeOffset: state.ballTimeOffset,
    impactT: state.impact ? state.impact.t - state.ballTimeOffset : null,
  });
  const win = EV.analysisWindow(state.events, set.kind);
  state.window = win;
  state.seq = EV.kineticSequence(state.frames, set.trail, win);
  state.maxSep = EV.maxSeparation(state.frames, win);
  // グラフの縦線は主要イベントに合わせる
  const primary = set.kind === 'bat' ? 'contact' : 'release';
  state.eventT = state.events[primary]?.t ?? state.events.foot_contact?.t ?? null;

  updateChart();
  renderEvents();
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
  for (const [k, e] of Object.entries(state.events || {})) {
    if (e) events.push({ t: e.t, label: EV.EVENT_LABEL[k] || k, color: EV.EVENT_COLOR[k] || '#ff6b81' });
  }
  if (state.loopA != null) events.push({ t: state.loopA, label: 'A', color: '#3ddc84' });
  if (state.loopB != null) events.push({ t: state.loopB, label: 'B', color: '#3ddc84' });
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
  if (state.playing) stopPlayback();
  showFrame(nearestFrameIndex(t), true);
}

/** 記録した映像を見返せる状態か（動画ファイル or カメラ録画） */
function hasVideo() {
  return (state.source === 'file' || state.source === 'recorded') && !!el.video.src;
}

function nearestFrameIndex(tMs) {
  const F = state.frames;
  if (!F.length) return 0;
  let lo = 0, hi = F.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (F[mid].t < tMs) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(F[lo - 1].t - tMs) <= Math.abs(F[lo].t - tMs)) return lo - 1;
  return lo;
}

/**
 * @param seekVideo 再生中は映像側が時刻を進めているので、シークし返さない
 */
/**
 * シークの詰まり防止。進行中は最新の目的地だけを保持し、完了後にまとめて1回だけ実行する。
 * スクラブバーをドラッグすると毎イベントでシークが発生し、video 要素が固まることがある。
 */
let pendingSeekSec = null;
function seekVideoThrottled(timeSec) {
  const v = el.video;
  if (v.seeking) { pendingSeekSec = timeSec; return; }
  pendingSeekSec = null;
  v.currentTime = timeSec;
}

function showFrame(idx, seekVideo = true) {
  const f = state.frames[idx];
  if (!f) return;
  state.playIdx = idx;
  el.scrub.value = String(Math.round((idx / Math.max(1, state.frames.length - 1)) * 1000));
  el.timeLabel.textContent = `${(f.t / 1000).toFixed(2)}s`;
  chart.setPlayhead(f.t);
  renderCards(f.angles, f.conf);
  if (seekVideo && hasVideo()) seekVideoThrottled(Math.max(0, (f.t - state.videoTimeOffset) / 1000));
  const norm = f.lm.map((p) => ({ x: p.x, y: p.y, z: 0, visibility: p.v }));
  draw(norm, f.angles, f.conf, { ball: null, candidates: [] });
}

/* ================= 繰り返し再生 ================= */

/** 再生する時間範囲。A/B区間が設定されていればその区間。 */
function playbackBounds() {
  const F = state.frames;
  if (!F.length) return [0, 0];
  let a = state.loopA ?? F[0].t;
  let b = state.loopB ?? F[F.length - 1].t;
  if (a > b) [a, b] = [b, a];
  return [a, b];
}

/**
 * 再生ループの駆動。requestVideoFrameCallback は映像が停止すると発火しなくなり、
 * ループごと止まってしまうため、タイマーで独立して回す。
 */
function nextFrameCallback(fn) {
  state.playTimer = setTimeout(fn, 16);
}

function startPlayback() {
  if (!state.frames.length) return;
  const [a, b] = playbackBounds();
  const cur = state.frames[state.playIdx ?? 0]?.t ?? a;
  // 終端まで見終わっている、または区間の外にいるときは区間の先頭から再生し直す
  const startT = (cur >= b - 1 || cur < a) ? a : cur;
  state.playing = true;
  // 世代を進めて、以前の再生ループを全て無効にする（同時に走ると互いにシークを奪い合う）
  const gen = ++state.playGen;
  el.btnPlay.textContent = '⏸ 一時停止';
  if (hasVideo()) playWithVideo(gen, startT, a, b);
  else playSkeletonOnly(gen, startT, a, b);
}

function stopPlayback() {
  state.playing = false;
  state.playGen++;
  if (state.playTimer) { clearTimeout(state.playTimer); state.playTimer = null; }
  el.btnPlay.textContent = '▶ 再生';
  if (hasVideo()) el.video.pause();
}

/** シーク完了を待ってからコールバックを呼ぶ（完了イベントが来ない場合に備えて保険付き） */
function seekThen(v, timeSec, cb) {
  let done = false;
  const fin = () => {
    if (done) return;
    done = true;
    v.removeEventListener('seeked', fin);
    cb();
  };
  v.addEventListener('seeked', fin);
  setTimeout(fin, 600);
  // シーク進行中は currentTime が古い値を返すため、到達済み判定に使ってはいけない。
  // 必ず目的地を設定し直して 'seeked' を待つ。
  if (!v.seeking && Math.abs(v.currentTime - timeSec) < 0.005) fin();
  else v.currentTime = timeSec;
}

/**
 * 映像がある場合は動画を実際に再生し、骨格をその時刻に同期させる。
 * 区間の終端でシークして戻す間は終端判定を止める。止めないと
 * 「シーク→未完了のまま再び終端と判定→再シーク」で先に進まなくなる。
 */
function playWithVideo(gen, startT, a, b) {
  const v = el.video;
  const toVideo = (t) => Math.max(0, (t - state.videoTimeOffset) / 1000);
  const alive = () => state.playing && state.playGen === gen;
  v.playbackRate = +el.speedSel.value;
  let seeking = false;

  const tick = () => {
    if (!alive() || seeking) return;
    const tMs = v.currentTime * 1000 + state.videoTimeOffset;
    if (tMs >= b - 8 || v.ended) {
      if (el.chkLoop.checked) {
        seeking = true;
        seekThen(v, toVideo(a), () => {
          seeking = false;
          if (!alive()) return;
          if (v.paused) v.play().catch(() => {});
          nextFrameCallback(tick);
        });
        return;
      }
      stopPlayback();
      showFrame(nearestFrameIndex(b), true);
      return;
    }
    showFrame(nearestFrameIndex(tMs), false);
    nextFrameCallback(tick);
  };

  seeking = true;
  pendingSeekSec = null;
  seekThen(v, toVideo(startT), () => {
    seeking = false;
    if (!alive()) return;
    v.play().catch(() => {});
    nextFrameCallback(tick);
  });
}

/** 映像が無い（カメラ録画に失敗した等）場合は骨格だけをタイマーで再生する */
function playSkeletonOnly(gen, startT, a, b) {
  const alive = () => state.playing && state.playGen === gen;
  let i = nearestFrameIndex(startT);
  const step = () => {
    if (!alive()) return;
    if (i >= state.frames.length || state.frames[i].t > b) {
      if (el.chkLoop.checked) i = nearestFrameIndex(a);
      else { stopPlayback(); return; }
    }
    showFrame(i, false);
    const next = state.frames[i + 1];
    const dt = next ? next.t - state.frames[i].t : 33;
    i++;
    state.playTimer = setTimeout(step, Math.max(8, dt / (+el.speedSel.value || 1)));
  };
  step();
}

function stepFrame(delta) {
  if (!state.frames.length) return;
  stopPlayback();
  const idx = Math.min(state.frames.length - 1, Math.max(0, (state.playIdx ?? 0) + delta));
  showFrame(idx, true);
}

function renderAbLabel() {
  const set = (btn, on) => btn.classList.toggle('set', on);
  set(el.btnSetA, state.loopA != null);
  set(el.btnSetB, state.loopB != null);
  if (state.loopA == null && state.loopB == null) { el.abLabel.textContent = '区間: 全体'; return; }
  const [a, b] = playbackBounds();
  el.abLabel.textContent = `区間: ${(a / 1000).toFixed(2)}s → ${(b / 1000).toFixed(2)}s（${((b - a) / 1000).toFixed(2)}s）`;
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

/** 検出したイベントの一覧。自動検出が外れた場合はここで手動修正する。 */
function renderEvents() {
  const set = REF.REFERENCE_SETS[el.refSetSel.value];
  if (!set) return;
  const wanted = set.kind === 'bat' ? ['contact', 'foot_contact'] : ['foot_contact', 'release'];
  if (!state.frames.length) {
    el.eventList.innerHTML = '<p class="hint">記録または動画解析を行うと、イベントが自動検出されます。</p>';
    return;
  }
  el.eventList.innerHTML = wanted.map((k) => {
    const e = state.events[k];
    const color = EV.EVENT_COLOR[k];
    return `<div class="evt ${e ? '' : 'missing'}">
      <span class="dot" style="background:${color}"></span>
      <span class="body">
        <span class="nm">${EV.EVENT_LABEL[k]}</span>
        <span class="mt">${e ? `${(e.t / 1000).toFixed(3)}s ／ ${e.method}` : '自動検出できませんでした'}</span>
      </span>
      <button class="btn" data-evt="${k}">今の位置に設定</button>
    </div>`;
  }).join('');
  el.eventList.querySelectorAll('button[data-evt]').forEach((b) => {
    b.onclick = () => setEventHere(b.dataset.evt);
  });
}

function renderCompare() {
  const set = REF.REFERENCE_SETS[el.refSetSel.value];
  if (!set) return;
  if (!state.frames.length) {
    el.compareTable.innerHTML = '<p class="hint">記録または動画解析を行うと、文献値と比較できます。</p>';
    return;
  }

  const rows = set.refs.map((r) => {
    const m = METRIC_BY_ID[r.metric];
    const ev = state.events[r.event];
    const evLabel = EV.EVENT_LABEL[r.event] || r.event;
    if (!ev) {
      return `<tr><td><b>${r.label}</b> <span class="tag l1">${r.level}</span>
        <div class="rawnote">${r.raw}</div></td>
        <td colspan="2"><span class="na">${evLabel}が未検出</span></td></tr>`;
    }
    const f = state.frames[ev.index] || frameAt(ev.t);
    let actual = f ? adjust(r.metric, f.angles[r.metric]) : null;
    let note = '';
    if (r.needsCalib) {
      if (!state.calib) note = '<div class="caution">「構えの姿勢を基準にセット」が未実行のため、この値は文献と同じ基準になっていません。</div>';
      actual = actual == null ? null : Math.abs(actual);
      note += '<div class="rawnote">回旋の向きは自動的に正方向へ揃えています。</div>';
    }
    if (el.dimSel.value === '2d' && m?.dim === '3d') {
      return `<tr><td><b>${r.label}</b><div class="rawnote">${r.raw}</div></td>
        <td colspan="2"><span class="na">3Dモードでのみ計測可</span></td></tr>`;
    }
    const c = REF.compare(actual, r.mean, r.sd);
    return `<tr>
      <td><b>${r.label}</b> <span class="tag l1">${r.level}</span>
        <div class="rawnote">${evLabel}時点 ${(ev.t / 1000).toFixed(3)}s ／ 基準 ${r.mean}° ± ${r.sd}°（${REF.CITATIONS[r.cite].key}）</div>
        <div class="rawnote">${r.raw}</div>
        ${r.caution ? `<div class="caution">⚠ ${r.caution}</div>` : ''}
        ${note}</td>
      <td class="v">${c ? `${c.actual}°` : '—'}<div class="rawnote">${c ? `${c.diff >= 0 ? '+' : ''}${c.diff}° / ${c.z}SD` : ''}</div></td>
      <td>${c ? `<span class="verdict ${c.verdict.tone}">${c.verdict.label}</span>` : ''}</td>
    </tr>`;
  }).join('');

  // 最大角速度（打撃のみ文献値あり）
  let peakRows = '';
  if (set.peaks?.length && state.seq) {
    peakRows = set.peaks.map((pk) => {
      const item = state.seq.items.find((x) => x.key === pk.key);
      const c = item ? REF.compare(Math.abs(item.value), pk.mean, pk.sd) : null;
      return `<tr>
        <td><b>${pk.label}</b> <span class="tag l1">${pk.level}</span>
          <div class="rawnote">基準 ${pk.mean} ± ${pk.sd} °/s（${REF.CITATIONS[pk.cite].key}）</div>
          <div class="rawnote">${pk.raw}</div></td>
        <td class="v">${c ? `${c.actual}°/s` : '—'}<div class="rawnote">${c ? `${c.diff >= 0 ? '+' : ''}${c.diff} / ${c.z}SD` : ''}</div></td>
        <td>${c ? `<span class="verdict ${c.verdict.tone}">${c.verdict.label}</span>` : ''}</td>
      </tr>`;
    }).join('');
  }

  el.compareTable.innerHTML = `<table class="cmp">
    <thead><tr><th>項目</th><th>実測</th><th>判定</th></tr></thead>
    <tbody>${rows}${peakRows}</tbody></table>
    <p class="hint">比較対象: ${set.label}</p>`;
}

/** 打撃／投球で内容が切り替わる診断パネル */
function renderSwingPanel() {
  const set = REF.REFERENCE_SETS[el.refSetSel.value];
  if (!set) return;
  if (set.kind === 'pitch') renderPitchDiagnosis(set);
  else renderBatDiagnosis(set);
}

/** 運動連鎖（骨盤→体幹→腕の順に最大角速度が出るか）と捻転差の最大値 */
function renderSequenceBlock() {
  if (!state.seq) return '';
  const seq = state.seq;
  const sep = state.maxSep;
  const rows = seq.items.map((it) => `<div class="seqrow">
      <span>${it.label}</span>
      <span class="n">${Math.abs(it.value).toFixed(0)}<small style="color:var(--dim)">°/s</small></span>
      <span class="tm">${(it.t / 1000).toFixed(3)}s</span>
    </div>`).join('');
  return `<div class="metric-big">
    <div class="t">運動連鎖（最大角速度の順序）</div>
    <div class="n" style="font-size:16px;color:${seq.correct ? 'var(--good)' : 'var(--warn)'}">
      ${seq.correct ? '骨盤 → 体幹 → 腕 の順序どおり' : '順序が入れ替わっています'}
    </div>
    <div class="rawnote">実際の順序: ${seq.actualOrder.join(' → ')}</div>
    <div class="seqbox">${rows}</div>
    ${sep ? `<div class="t" style="margin-top:10px">捻転差の最大値</div>
      <div class="n">${Math.abs(sep.value).toFixed(1)}<small>° （${(sep.t / 1000).toFixed(3)}s）</small></div>` : ''}
    <div class="caution">下半身から上半身へ順に力が伝わる（proximal-to-distal）のが望ましいとされる順序です。
      角速度は角度の微分（中心差分＋平滑化）から求めています。<b>フレームレートが低いほど最大値は小さく出ます</b>
      — 特に肘の伸展は実際には2000°/sを超えるため、30fpsではまったく捉えられません。順序の判定には使えますが、
      大きさの絶対値は120fps以上で撮影しない限り参考値です。撮影方向と検出精度の影響も受けます。
      ${state.window ? `解析対象の時間帯: ${(state.window[0] / 1000).toFixed(2)}s 〜 ${(state.window[1] / 1000).toFixed(2)}s` : ''}</div>
  </div>`;
}

/** イベント時点の角度をまとめて出す */
function eventAngles(eventKey, ids) {
  const ev = state.events[eventKey];
  if (!ev) return `<div class="rawnote">${EV.EVENT_LABEL[eventKey]}が未検出です。「文献比較」タブで手動設定できます。</div>`;
  const f = state.frames[ev.index] || frameAt(ev.t);
  if (!f) return '';
  return `<div class="seqbox">${ids.map((id) => {
    const m = METRIC_BY_ID[id];
    const v = adjust(id, f.angles[id]);
    const na = el.dimSel.value === '2d' && m.dim === '3d';
    return `<div class="seqrow"><span>${m.label}</span>
      <span class="n">${na ? '<small style="color:var(--dim)">2Dでは不可</small>' : v == null ? '—' : `${v.toFixed(1)}<small style="color:var(--dim)">°</small>`}</span></div>`;
  }).join('')}</div>`;
}

function renderPitchDiagnosis(set) {
  el.diagNotice.innerHTML = `<div class="notice">
    <b>投球として解析しています（${set.label}）</b><br>
    踏込足の接地とリリースを骨格の動きから自動検出し、それぞれの時点の角度を見ます。
    投球には打撃のアタックアングルに相当する「体格から決まる目標角度」の文献的な根拠がないため、
    ここでは文献の基準値との比較と、運動連鎖の順序を示します。
  </div>`;

  const trail = set.trail, lead = set.lead;
  el.swingPanel.innerHTML = `
    <div class="metric-big">
      <div class="t">リリース時点の角度</div>
      ${eventAngles('release', [`elbow_${trail}`, `shoulder_elev_${trail}`, `shoulder_horiz_${trail}`,
                                'trunk_lateral', 'trunk_sagittal', 'shoulder_rot'])}
    </div>

    <div class="metric-big">
      <div class="t">踏込足の接地時点の角度</div>
      ${eventAngles('foot_contact', [`knee_${lead}`, `hip_${lead}`, 'pelvis_rot', 'shoulder_rot', 'x_factor', 'trunk_lateral'])}
    </div>

    ${renderSequenceBlock()}

    <div class="metric-big">
      <div class="t">この解析で分かること・分からないこと</div>
      <div class="rawnote" style="line-height:1.9">
        測れる: 肘・膝・股関節の角度、体幹の傾き、肩と骨盤の回旋、捻転差、各部の最大角速度と順序<br>
        <span style="color:#d3ab5a">測れない: 肩の最大外旋角（投球で最も重要な指標のひとつ）。
        33点のランドマークには上腕の捻れを表す点が無いため、原理的に算出できません。</span>
      </div>
      <div class="caution">撮影は三塁側／一塁側から全身が入る位置を推奨します。回旋角は「構えの姿勢を基準にセット」を
        セットポジションで押してから記録すると、文献と同じ基準になります。</div>
    </div>`;
}

function renderBatDiagnosis(set) {
  el.diagNotice.innerHTML = `<div class="notice warn">
    <b>身長・体重から理想の関節角度を出す検証済みの式は文献に存在しません。</b><br>
    ここでは ①文献が示すバットスピードと最適アタックアングルの関係 と
    ②体格によるバットスピード補正（当アプリの推定）を組み合わせて目標値を出しています。
    推定部分には <span class="tag l3">体格補正(推定)</span> を付けています。
  </div>`;

  const h = +el.heightCm.value, m = +el.massKg.value;
  const anth = REF.anthropometry(h, m);
  const bat = REF.batRecommendation(h, m);
  const ideal = REF.idealAttackAngle({
    levelKey: el.levelSel.value, heightCm: h, massKg: m,
    measuredMph: el.batSpeed.value ? +el.batSpeed.value : null,
    pitchType: el.pitchTypeSel.value,
  });

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
      <div class="t">インパクト時点の角度</div>
      ${eventAngles('contact', [`elbow_${set.trail}`, `knee_${set.lead}`, `hip_${set.lead}`, 'trunk_lateral', 'pelvis_rot', 'x_factor'])}
    </div>

    ${renderSequenceBlock()}

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
  if (state.playing) stopPlayback();
  const idx = Math.round((+el.scrub.value / 1000) * (state.frames.length - 1));
  showFrame(idx, true);
};
el.btnPlay.onclick = () => { if (state.playing) stopPlayback(); else startPlayback(); };
el.btnStepBack.onclick = () => stepFrame(-1);
el.btnStepFwd.onclick = () => stepFrame(1);
el.speedSel.onchange = () => { if (state.playing && hasVideo()) el.video.playbackRate = +el.speedSel.value; };
el.btnSetA.onclick = () => {
  const f = state.frames[state.playIdx ?? 0]; if (!f) return;
  state.loopA = f.t; renderAbLabel(); updateChart();
};
el.btnSetB.onclick = () => {
  const f = state.frames[state.playIdx ?? 0]; if (!f) return;
  state.loopB = f.t; renderAbLabel(); updateChart();
};
el.btnClearAB.onclick = () => { state.loopA = state.loopB = null; renderAbLabel(); updateChart(); };

// キーボード操作（入力欄にフォーカスがあるときは邪魔しない）
window.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea', 'button'].includes(tag)) return;
  if (!state.frames.length) return;
  if (e.code === 'Space') { e.preventDefault(); state.playing ? stopPlayback() : startPlayback(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); stepFrame(e.shiftKey ? -10 : -1); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); stepFrame(e.shiftKey ? 10 : 1); }
});

/** イベントを今の再生位置に設定し直す（自動検出が外れたときの手動補正） */
function setEventHere(key) {
  const idx = state.playIdx ?? 0;
  const f = state.frames[idx];
  if (!f) return;
  state.events = { ...state.events, [key]: { index: idx, t: f.t, confidence: 1, method: '手動で設定' } };
  const set = REF.REFERENCE_SETS[el.refSetSel.value];
  const primary = set.kind === 'bat' ? 'contact' : 'release';
  state.eventT = state.events[primary]?.t ?? state.eventT;
  updateChart();
  renderEvents();
  renderCompare();
  renderSwingPanel();
}

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
el.refSetSel.onchange = () => {
  // 打撃／投球を切り替えたらイベントを検出し直す
  if (state.frames.length) {
    const set = REF.REFERENCE_SETS[el.refSetSel.value];
    state.events = EV.detectEvents(state.frames, {
      kind: set.kind, lead: set.lead, trail: set.trail,
      ballTrajectory: state.ball.trajectory,
      ballTimeOffset: state.ballTimeOffset,
      impactT: state.impact ? state.impact.t - state.ballTimeOffset : null,
    });
    const win = EV.analysisWindow(state.events, set.kind);
    state.window = win;
    state.seq = EV.kineticSequence(state.frames, set.trail, win);
    state.maxSep = EV.maxSeparation(state.frames, win);
    const primary = set.kind === 'bat' ? 'contact' : 'release';
    state.eventT = state.events[primary]?.t ?? state.events.foot_contact?.t ?? null;
    updateChart();
  }
  renderEvents();
  renderCompare();
  renderSwingPanel();
};

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
el.video.addEventListener('seeked', () => {
  if (pendingSeekSec == null) return;
  const t = pendingSeekSec;
  pendingSeekSec = null;
  el.video.currentTime = t;
});

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
