#!/usr/bin/env python3
"""
server.py - 本地静态开发服务器

本项目是纯静态前端（零构建、零第三方产物），相比 02/03 连 .wasm 都没有，
所以这个服务器只做两件本来就该做的事：

  1. 给 .mjs / .json 正确的 MIME（部分环境会猜错导致 module 加载失败）；
  2. 开发期间一律 no-store——改完文件刷新就能看到效果，不被缓存挡住。

用法：
    python3 server.py            # 默认 6326 端口
    python3 server.py 8080
"""

import functools
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 6326
ROOT = os.path.dirname(os.path.abspath(__file__))

EXTRA_TYPES = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        # 开发时改了文件刷新就能生效，不要被缓存挡住
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith("2") and not self.path.endswith((".html", "/")):
            return
        super().log_message(fmt, *args)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    handler = functools.partial(Handler, directory=ROOT)
    with Server(("127.0.0.1", PORT), handler) as httpd:
        print(f"Gomoku dev server → http://127.0.0.1:{PORT}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")
