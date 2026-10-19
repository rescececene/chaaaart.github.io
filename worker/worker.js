/**
 * 마켓렌즈 중계 Worker (Cloudflare Workers 무료 플랜)
 *
 * 브라우저(GitHub Pages)에서 직접 부를 수 없는 시세 API를 대신 호출하고 CORS 헤더를 붙여 돌려준다.
 *   - 네이버 증권: 외부 사이트에서 부르면 403 → 국내·미국 주식 실시간 시세, 차트, 검색
 *   - 업비트: 브라우저 요청은 IP당 10초에 1번 정도로 제한 → 캔들 조회
 *   - 야후 파이낸스: 미국 주식 분봉 / 구글 뉴스: 종목별 뉴스 RSS
 *   - 코인니스: 코인·주식 속보 (브라우저에서 직접 부르면 CORS 로 막힌다)
 *
 * 요청 형식:  https://<worker 주소>/<경로 이름>/<나머지 경로>?<쿼리>
 *   예) /naver-poll/domestic/stock/005930
 *
 * 누가 쓸 수 있나 (사이트에는 비밀값을 넣지 않는다):
 *   1) 마켓렌즈 사이트에서 온 요청 — 브라우저가 붙이는 Origin 헤더로 확인한다.
 *      다른 웹사이트는 Origin 을 바꿀 수 없으므로 이 Worker 를 가져다 쓸 수 없다.
 *      허용할 사이트를 바꾸려면 변수 ALLOWED_ORIGINS 에 쉼표로 적는다.
 *   2) ?k=<ACCESS_KEY> 를 붙인 요청 — 로컬 개발·다른 도구용 예비 수단 (Secret 으로 저장)
 */
const DEFAULT_ORIGINS = ['https://rescececene.github.io'];
const ROUTES = {
  'naver-poll': 'https://polling.finance.naver.com/api/realtime/',
  'naver-m': 'https://m.stock.naver.com/api/',
  'naver-api': 'https://api.stock.naver.com/',
  'naver-ac': 'https://ac.stock.naver.com/ac',
  'upbit': 'https://api.upbit.com/v1/',
  'yahoo': 'https://query1.finance.yahoo.com/v8/finance/chart/',
  'gnews': 'https://news.google.com/rss/search',
  'coinness': 'https://api.coinness.com/feed/', // 코인·주식 속보 (feed 아래만)
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 같은 IP 가 1분에 너무 많이 부르면 잠시 막는다 — 남이 Origin 을 흉내 내 무료 한도(계정 전체 하루 10만 건)를
// 다 써 버리는 것을 늦추는 장치. Worker 인스턴스 메모리 기준이라 대략적이다 (사이트 한 화면은 1분에 100~200건 정도).
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 900;
const hits = new Map(); // ip → { start, n }
function limited(ip) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.start > RATE_WINDOW_MS) { h = { start: now, n: 0 }; hits.set(ip, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > RATE_WINDOW_MS) hits.delete(k);
  return h.n > RATE_MAX;
}

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()) : DEFAULT_ORIGINS;
    const fromSite = allowed.includes(origin);
    const keyOk = !!env.ACCESS_KEY && url.searchParams.get('k') === env.ACCESS_KEY;
    const cors = {
      'Access-Control-Allow-Origin': fromSite ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') return reply({ error: 'GET 요청만 됩니다' }, 405, cors);
    if (url.pathname === '/') return reply({ ok: true, service: 'market-lens relay', access: fromSite || keyOk, keyOk }, 200, cors);
    if (!fromSite && !keyOk) return reply({ error: '허용되지 않은 요청입니다' }, 401, cors);
    if (url.pathname.length + url.search.length > 2000) return reply({ error: '주소가 너무 깁니다' }, 414, cors);
    if (limited(request.headers.get('CF-Connecting-IP') || 'unknown')) {
      return new Response(JSON.stringify({ error: '요청이 너무 많습니다. 잠시 뒤 다시 시도하세요' }), {
        status: 429, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '30', ...cors },
      });
    }

    const m = url.pathname.match(/^\/([a-z-]+)(?:\/(.*))?$/);
    const base = m && ROUTES[m[1]];
    if (!base) return reply({ error: '알 수 없는 경로' }, 404, cors);
    const rest = m[2] || '';
    if (/\.\.|%2e%2e/i.test(rest)) return reply({ error: '잘못된 경로' }, 400, cors); // 경로 거슬러 오르기 차단 (인코딩 포함)
    url.searchParams.delete('k');

    let upstream;
    try {
      upstream = await fetch(base + rest + url.search, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      });
    } catch (e) {
      return reply({ error: '원본 서버 연결 실패: ' + e.message }, 502, cors);
    }
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
