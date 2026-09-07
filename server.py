#!/usr/bin/env python3
"""
静的ファイル配信用の簡易サーバ。
- .mjs / .wasm / .task / .tflite の MIME を明示する
- テキストと wasm は gzip 圧縮して返す（モバイル回線での初回読み込みを短縮）
- スレッド化してキープアライブ接続が他のリクエストをブロックしないようにする
"""
import http.server, socketserver, sys, os, gzip, io, mimetypes, posixpath

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8777
ROOT = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
os.chdir(ROOT)

COMPRESSIBLE = {
    'text/html', 'text/css', 'text/javascript', 'application/javascript',
    'application/json', 'image/svg+xml', 'application/wasm',
}

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.mjs': 'text/javascript',
        '.js': 'text/javascript',
        '.wasm': 'application/wasm',
        '.task': 'application/octet-stream',
        '.tflite': 'application/octet-stream',
        '.json': 'application/json',
        '.css': 'text/css',
    }

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, 'index.html')
        if not os.path.isfile(path):
            return self.send_error(404, "File not found")

        ctype = self.guess_type(path)
        try:
            with open(path, 'rb') as f:
                body = f.read()
        except OSError:
            return self.send_error(404, "File not found")

        accepts_gzip = 'gzip' in self.headers.get('Accept-Encoding', '')
        base = ctype.split(';')[0]
        encoding = None
        if accepts_gzip and base in COMPRESSIBLE and len(body) > 1024:
            body = gzip.compress(body, 6)
            encoding = 'gzip'

        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        if encoding:
            self.send_header('Content-Encoding', encoding)
            self.send_header('Vary', 'Accept-Encoding')
        # モデルは Cache Storage 側で管理するので、配信側では常に検証させる
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Service-Worker-Allowed', '/')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    # キープアライブ接続が他のリクエストをブロックしないようスレッド化する
    allow_reuse_address = True
    daemon_threads = True


with Server(("127.0.0.1", PORT), Handler) as httpd:
    print(f"serving {ROOT} on http://localhost:{PORT}")
    httpd.serve_forever()
