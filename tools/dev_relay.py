"""worker/worker.js 와 똑같이 동작하는 로컬 중계기 + 빌드된 사이트 미리보기 서버 (개발·테스트용)

    py tools/dev_relay.py            → http://localhost:8787  (web/dist 빌드 결과 + 중계 경로)
    py tools/dev_relay.py --key abc  → 접근 키 필요

개발 중에는 Vite(web 에서 npm run dev → http://127.0.0.1:5173)를 쓰고, 주소에 ?relay=http://127.0.0.1:8787 을 붙여
이 중계를 쓴다 (배포된 Worker 를 다시 올리기 전에도 새 경로를 시험할 수 있다).
/__sleep?ms=5000 은 헤드리스 브라우저 캡처가 데이터를 기다리게 하는 용도.
"""
import argparse
import json
import time
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit

SITE = Path(__file__).resolve().parent.parent / "web" / "dist"
ROUTES = {
    "naver-poll": "https://polling.finance.naver.com/api/realtime/",
    "naver-m": "https://m.stock.naver.com/api/",
    "naver-api": "https://api.stock.naver.com/",
    "naver-ac": "https://ac.stock.naver.com/ac",
    "upbit": "https://api.upbit.com/v1/",
    "yahoo": "https://query1.finance.yahoo.com/v8/finance/chart/",
    "gnews": "https://news.google.com/rss/search",
    "coinness": "https://api.coinness.com/feed/",
}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
KEY = None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlsplit(self.path)
        if u.path == "/__sleep":  # 헤드리스 브라우저 테스트용: 페이지 load 를 일부러 늦춘다
            time.sleep(min(30, int(dict(parse_qsl(u.query)).get("ms", "5000")) / 1000))
            self.send_response(204)
            self.end_headers()
            return
        parts = u.path.lstrip("/").split("/", 1)
        if parts[0] not in ROUTES:
            return super().do_GET()  # 사이트 파일
        q = dict(parse_qsl(u.query, keep_blank_values=True))
        if KEY and q.pop("k", None) != KEY:
            return self._json({"error": "접근 키가 맞지 않습니다"}, 401)
        q.pop("k", None)
        rest = parts[1] if len(parts) > 1 else ""
        target = ROUTES[parts[0]] + rest + ("?" + urlencode(q) if q else "")
        try:
            req = urllib.request.Request(target, headers={"User-Agent": UA, "Accept": "*/*"})
            with urllib.request.urlopen(req, timeout=15) as r:
                status, ctype, body = r.status, r.headers.get("Content-Type"), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, body = e.code, e.headers.get("Content-Type"), e.read()
        except Exception as e:
            return self._json({"error": f"원본 서버 연결 실패: {e}"}, 502)
        self.send_response(status)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *a):
        if "/data/" not in (a[0] if a else ""):
            print(fmt % a)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--key")
    args = ap.parse_args()
    KEY = args.key
    print(f"http://localhost:{args.port}/?relay=http://localhost:{args.port}")
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
