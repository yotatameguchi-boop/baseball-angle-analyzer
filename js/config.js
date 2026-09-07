/**
 * 配信元の切り替え。
 *
 * リポジトリには巨大なバイナリ（wasm 約24MB・モデル 約81MB）を含めていない。
 * ローカルに vendor/ と models/ が置かれていればそれを使い、無ければ CDN から取得する。
 * どちらの場合も一度取得すれば Cache Storage に保存され、以降は通信しない。
 */
const TV = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1';
const GS = 'https://storage.googleapis.com/mediapipe-models';

const localUrl = (p) => new URL(p, import.meta.url).href;

const LOCAL = {
  visionBundle: localUrl('../vendor/tasks-vision/vision_bundle.mjs'),
  wasmBase: localUrl('../vendor/tasks-vision/wasm'),
  models: {
    pose_lite: localUrl('../models/pose_landmarker_lite.task'),
    pose_full: localUrl('../models/pose_landmarker_full.task'),
    pose_heavy: localUrl('../models/pose_landmarker_heavy.task'),
    detector: localUrl('../models/efficientdet_lite0.tflite'),
  },
};

const CDN = {
  visionBundle: `${TV}/vision_bundle.mjs`,
  wasmBase: `${TV}/wasm`,
  models: {
    pose_lite: `${GS}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`,
    pose_full: `${GS}/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task`,
    pose_heavy: `${GS}/pose_landmarker/pose_landmarker_heavy/float16/latest/pose_landmarker_heavy.task`,
    detector: `${GS}/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite`,
  },
};

let source = CDN;
let resolved = null;

/** ローカルに同梱資産があるか一度だけ確認する */
export function resolveSource() {
  if (resolved) return resolved;
  resolved = (async () => {
    try {
      const r = await fetch(LOCAL.visionBundle, { method: 'HEAD' });
      if (r.ok) source = LOCAL;
    } catch { /* 取得できなければ CDN のまま */ }
    return source;
  })();
  return resolved;
}

export const isLocalAssets = () => source === LOCAL;
export const wasmBase = () => source.wasmBase;
export const modelUrl = (key) => source.models[key];

/** vision_bundle を1度だけ読み込む */
let _vision = null;
export async function loadVision() {
  await resolveSource();
  if (!_vision) _vision = import(/* webpackIgnore: true */ source.visionBundle);
  return _vision;
}
