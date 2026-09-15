# ---------------------------------------------------------------
# モデルとランタイムの取得（完全オフラインで動かすため同梱する）
# WITH_MODELS=false でこの段を空にすると、実行時に CDN から取得する
# ---------------------------------------------------------------
FROM alpine:3.20 AS assets
ARG WITH_MODELS=true
RUN apk add --no-cache curl
WORKDIR /assets

ARG TV=https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1
ARG GS=https://storage.googleapis.com/mediapipe-models

RUN mkdir -p vendor/tasks-vision/wasm models && \
    if [ "$WITH_MODELS" = "true" ]; then \
      echo "▶ ランタイムを取得中…" && \
      curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o vendor/tasks-vision/vision_bundle.mjs "$TV/vision_bundle.mjs" && \
      for f in vision_wasm_internal.js vision_wasm_internal.wasm \
               vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do \
        curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o "vendor/tasks-vision/wasm/$f" "$TV/wasm/$f"; \
      done && \
      echo "▶ 姿勢モデルを取得中…" && \
      for m in lite full heavy; do \
        curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o "models/pose_landmarker_$m.task" \
          "$GS/pose_landmarker/pose_landmarker_$m/float16/latest/pose_landmarker_$m.task"; \
      done && \
      echo "▶ 物体検出モデルを取得中…" && \
      curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors -o models/efficientdet_lite0.tflite \
        "$GS/object_detector/efficientdet_lite0/float32/latest/efficientdet_lite0.tflite" && \
      du -sh vendor models; \
    else \
      echo "▶ モデルは同梱しません（実行時に CDN から取得します）"; \
    fi

# ---------------------------------------------------------------
# 配信
# ---------------------------------------------------------------
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/entrypoint.sh /docker-entrypoint-custom.sh
RUN chmod +x /docker-entrypoint-custom.sh

WORKDIR /usr/share/nginx/html
RUN rm -rf ./*

# アプリ本体
COPY index.html sw.js ./
COPY css/ ./css/
COPY js/ ./js/

# モデルとランタイム（WITH_MODELS=false なら空のディレクトリだけが入る）
COPY --from=assets /assets/ ./

EXPOSE 80 443
VOLUME ["/etc/nginx/certs"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1/index.html >/dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint-custom.sh"]
CMD ["nginx", "-g", "daemon off;"]
