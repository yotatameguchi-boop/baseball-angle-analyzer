#!/bin/sh
# カメラ(getUserMedia)は secure context でしか動かない。
# localhost 以外（スマホから LAN 経由で開く場合など）には HTTPS が必要なので、
# 証明書が無ければ自己署名のものを作る。
set -e

CERT_DIR=/etc/nginx/certs
CRT="$CERT_DIR/server.crt"
KEY="$CERT_DIR/server.key"
SANFILE="$CERT_DIR/.san"

# CERT_HOSTS に LAN の IP やホスト名をカンマ区切りで渡すと SAN に入る
SAN="DNS:localhost,IP:127.0.0.1,IP:::1"
if [ -n "$CERT_HOSTS" ]; then
    OLD_IFS=$IFS
    IFS=','
    for h in $CERT_HOSTS; do
        h=$(echo "$h" | tr -d ' ')
        [ -z "$h" ] && continue
        if echo "$h" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
            SAN="$SAN,IP:$h"
        else
            SAN="$SAN,DNS:$h"
        fi
    done
    IFS=$OLD_IFS
fi

# 証明書はボリュームに残るので、CERT_HOSTS を変えたときは作り直す必要がある
NEED_NEW=0
[ -f "$CRT" ] && [ -f "$KEY" ] || NEED_NEW=1
[ -f "$SANFILE" ] && [ "$(cat "$SANFILE")" = "$SAN" ] || NEED_NEW=1

if [ "$NEED_NEW" = "1" ]; then
    mkdir -p "$CERT_DIR"
    echo "[entrypoint] 自己署名証明書を作成します"
    echo "[entrypoint]   SAN: $SAN"
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
        -keyout "$KEY" -out "$CRT" \
        -subj "/CN=baseball-angle-analyzer" \
        -addext "subjectAltName=$SAN" >/dev/null 2>&1
    chmod 600 "$KEY"
    printf '%s' "$SAN" > "$SANFILE"
    echo "[entrypoint] 完了。スマホからは証明書の警告を承認してから使ってください。"
else
    echo "[entrypoint] 既存の証明書を使います (SAN: $SAN)"
fi

exec "$@"
