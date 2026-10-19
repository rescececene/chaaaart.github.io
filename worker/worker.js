/**
 * 마켓렌즈 중계 Worker (Cloudflare Workers 무료 플랜)
 *
 * 브라우저(GitHub Pages)에서 직접 부를 수 없는 시세 API를 대신 호출하고 CORS 헤더를 붙여 돌려준다.
 *   - 네이버 증권: 외부 사이트에서 부르면 403 → 국내·미국 주식 실시간 시세, 차트, 검색
 *   - 업비트: 브라우저 요청은 분당 6회로 제한 → 캔들 조회
 *   - 야후 파이낸스: 미국 주식 분봉 / 구글 뉴스: 종목별 뉴스 RSS
 *
 * 요청 형식:  https://<worker 주소>/<경로 이름>/<나머지 경로>?<쿼리>&k=<ACCESS_KEY>
 *   예) /naver-poll/domestic/stock/005930?k=비밀키
 *
 * 설정: Worker → Settings → Variables and Secrets 에 ACCESS_KEY (Secret) 를 추가하면
 *       그 키를 아는 사람만 쓸 수 있다. (안 넣으면 누구나 쓸 수 있으니 꼭 넣을 것)
 */
const ROUTES = {
  'naver-poll': 'https://polling.finance.naver.com/api/realtime/',
  'naver-m': 'https://m.stock.naver.com/api/',
  'naver-api': 'https://api.stock.naver.com/',
  'naver-ac': 'https://ac.stock.naver.com/ac',
  'upbit': 'https://api.upbit.com/v1/',
  'yahoo': 'https://query1.finance.yahoo.com/v8/finance/chart/',
  'gnews': 'https://news.google.com/rss/search',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function reply(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return reply({ error: 'GET 요청만 됩니다' }, 405);

    const url = new URL(request.url);
    const keyOk = !env.ACCESS_KEY || url.searchParams.get('k') === env.ACCESS_KEY;
    if (url.pathname === '/') return reply({ ok: true, service: 'market-lens relay', keyOk });
    if (!keyOk) return reply({ error: '접근 키가 맞지 않습니다' }, 401);

    const m = url.pathname.match(/^\/([a-z-]+)(?:\/(.*))?$/);
    const base = m && ROUTES[m[1]];
    if (!base) return reply({ error: '알 수 없는 경로' }, 404);
    const rest = m[2] || '';
    if (rest.includes('..')) return reply({ error: '잘못된 경로' }, 400);
    url.searchParams.delete('k');

    let upstream;
    try {
      upstream = await fetch(base + rest + url.search, {
        headers: { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'ko-KR,ko;q=0.9' },
      });
    } catch (e) {
      return reply({ error: '원본 서버 연결 실패: ' + e.message }, 502);
    }
    const headers = new Headers(CORS);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
