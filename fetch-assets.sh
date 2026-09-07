#!/usr/bin/env bash
# ローカルで完全オフライン動作させたい場合に、モデルとランタイムを取得する。
# 実行しなくてもアプリは動く（その場合は CDN から取得される）。
set -euo pipefail
cd "$(dirname "$0")"

TV="https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1"
GS="https://storage.googleapis.com/mediapipe-models"

mkdir -p vendor/tasks-vision/wasm models

echo "▶ ランタイムを取得中…"
curl -sL -o vendor/tasks-vision/vision_bundle.mjs "$TV/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm \
         vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  curl -sL -o "vendor/tasks-vision/wasm/$f" "$TV/wasm/$f"
done

echo "▶ 姿勢モデルを取得中…"
for m in lite full heavy; do
  curl -sL -o "models/pose_landmarker_$m.task" \
    "$GS/pose_landmarker/pose_landmarker_$m/float16/latest/pose_landmarker_$m.task"
done

echo "▶ 物体検出モデルを取得中…"
curl -sL -o models/efficientdet_lite0.tflite \
  "$GS/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite"

echo "✔ 完了"
du -sh vendor models
