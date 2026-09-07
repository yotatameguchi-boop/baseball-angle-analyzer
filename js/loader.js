/**
 * モバイル回線を想定したモデルの読み込み。
 * - Cache Storage に保存し、2回目以降は通信ゼロで起動する
 * - ダウンロード進捗をバイト単位で報告する
 * - MediaPipe には modelAssetBuffer として渡すため、キャッシュ済みなら即座に初期化できる
 */

import { resolveSource, modelUrl } from './config.js';

const CACHE = 'bml-models-v1';

const META = {
  pose_lite:  { bytes: 5777746,  label: '姿勢モデル Lite' },
  pose_full:  { bytes: 9398198,  label: '姿勢モデル Full' },
  pose_heavy: { bytes: 30664242, label: '姿勢モデル Heavy' },
  detector:   { bytes: 13836895, label: '物体検出モデル' },
};

// url は配信元が確定してから引くので getter にしておく
export const ASSETS = Object.fromEntries(Object.entries(META).map(([k, m]) => [k, {
  ...m, key: k, get url() { return modelUrl(k); },
}]));

export { resolveSource };

export function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

async function openCache() {
  try { return await caches.open(CACHE); } catch { return null; }
}

/** キャッシュ済みかどうか */
export async function isCached(url) {
  const c = await openCache();
  if (!c) return false;
  return !!(await c.match(url));
}

/**
 * モデルのバイト列を取得する。キャッシュにあれば通信しない。
 * @param onProgress (loaded, total) => void
 */
export async function loadModelBytes(url, onProgress) {
  const cache = await openCache();
  if (cache) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = new Uint8Array(await hit.arrayBuffer());
      onProgress?.(buf.byteLength, buf.byteLength, true);
      return buf;
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} の取得に失敗 (${res.status})`);
  const total = +(res.headers.get('content-length') || 0);

  // 進捗を出しつつ読み込む
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.byteLength, buf.byteLength, false);
    if (cache) await cache.put(url, new Response(buf));
    return buf;
  }
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress?.(loaded, total, false);
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const ch of chunks) { buf.set(ch, off); off += ch.byteLength; }
  if (cache) { try { await cache.put(url, new Response(buf)); } catch { /* 容量超過は無視 */ } }
  return buf;
}

/** オフライン用に一括で取得しておく */
export async function prefetchAll(keys, onProgress) {
  const list = keys.map((k) => ASSETS[k]).filter(Boolean);
  const total = list.reduce((s, a) => s + a.bytes, 0);
  let done = 0;
  for (const a of list) {
    await loadModelBytes(a.url, (l, t) => onProgress?.(done + l, total, a.label));
    done += a.bytes;
  }
  onProgress?.(total, total, null);
}

/** 保存済みキャッシュを消す */
export async function clearCache() {
  try { await caches.delete(CACHE); return true; } catch { return false; }
}

/** 端末・回線からの推奨設定 */
export function recommendedSettings() {
  const nav = navigator;
  const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 820;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  const type = conn?.effectiveType || 'unknown';   // 'slow-2g' | '2g' | '3g' | '4g'
  const saveData = !!conn?.saveData;
  const cores = nav.hardwareConcurrency || 4;
  const slow = saveData || ['slow-2g', '2g', '3g'].includes(type);

  return {
    mobile, effectiveType: type, saveData, cores,
    model: (mobile || slow || cores <= 4) ? 'lite' : 'full',
    resolution: mobile ? 'low' : 'mid',
    ballWorkWidth: mobile ? 224 : 320,
    // 物体検出モデルは14MBあるので、モバイル/低速回線では既定でオフにする
    loadDetector: !(mobile || slow),
    targetFps: mobile ? 24 : 30,
  };
}

export const RESOLUTIONS = {
  low:  { width: 640,  height: 360,  label: '低 (640×360) — 通信量と負荷が最小' },
  mid:  { width: 1280, height: 720,  label: '中 (1280×720) — 標準' },
  high: { width: 1920, height: 1080, label: '高 (1920×1080) — 高精度・高負荷' },
};
