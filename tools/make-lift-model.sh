#!/usr/bin/env bash
# 3Dリフティング用のモデルを用意する。
#
# MotionBERT (Walter0807/MotionBERT, Apache-2.0) の ONNX 変換を取得し、
# int8 量子化して 170MB -> 43MB に縮める。
#
# 重みは Human3.6M で学習されており、同データセットは学術研究用途に限定される。
# そのため量子化済みモデルは再配布せず、各自の環境で生成する方式にしている。
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=https://huggingface.co/bukuroo/MotionBERT-3d-ONNX/resolve/main/motionbert_3d_27.onnx
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "▶ MotionBERT ONNX を取得中（約170MB）…"
curl -fL --retry 3 -o "$TMP/mb.onnx" "$SRC"

echo "▶ int8 量子化中…"
python3 -m pip install --quiet onnx onnxruntime
python3 - "$TMP/mb.onnx" models/motionbert_3d_27_int8.onnx <<'PY'
import sys, os
from onnxruntime.quantization import quantize_dynamic, QuantType
src, dst = sys.argv[1], sys.argv[2]
os.makedirs(os.path.dirname(dst), exist_ok=True)
quantize_dynamic(src, dst, weight_type=QuantType.QUInt8)
print(f"  {os.path.getsize(src)/1e6:.1f} MB -> {os.path.getsize(dst)/1e6:.1f} MB")
PY
echo "✔ models/motionbert_3d_27_int8.onnx を作成しました"
