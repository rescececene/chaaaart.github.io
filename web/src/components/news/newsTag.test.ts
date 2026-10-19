// 뉴스 호재·악재 판단(lib/newsTag)이 AI → 투표 → 키워드 순으로 정하고, 관련 종목을 제대로 잇는지
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { listOrder, loadCoins, remember, type AiTag, type NewsItem } from '@/lib/market';
import {
  hasWord, isNewUpbitListing, isUpbitKrwListing, keywordHits, listingStudy, medianVotes, moodEffect, officialSentiment, relatedOf, resolveTag, sentimentOf,
  viaName, VOTE_NEUTRAL, type NewsState,
} from '@/lib/newsTag';

const COINS = {
  upbit: {
    'KRW-BTC': ['비트코인', 'Bitcoin', 0], 'KRW-ETH': ['이더리움', 'Ethereum', 0], 'KRW-SOL': ['솔라나', 'Solana', 0],
    'KRW-NEAR': ['니어프로토콜', 'NEAR Protocol', 0], 'KRW-XRP': ['엑스알피(리플)', 'XRP', 0], 'KRW-SAND': ['샌드박스', 'The Sandbox', 0],
  },
  binance: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'RUNEUSDT'],
};

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('coins.json')) return { ok: true, status: 200, json: async () => COINS };
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  await loadCoins();
  listOrder.krx = ['krx:005930', 'krx:000660', 'krx:009150', 'krx:207940', 'krx:000270'];
  listOrder.us = ['us:NVDA.O', 'us:AAPL.O', 'us:META.O', 'us:AMZN.O', 'us:MSTR.O', 'us:SKHY.O', 'us:NDAQ.O'];
  const names: [string, string, string][] = [
    ['krx:005930', '삼성전자', '005930'], ['krx:000660', 'SK하이닉스', '000660'], ['krx:009150', '삼성전기', '009150'],
    ['krx:207940', '삼성바이오로직스', '207940'], ['krx:000270', '기아', '000270'],
    ['us:NVDA.O', '엔비디아', 'NVDA'], ['us:AAPL.O', '애플', 'AAPL'], ['us:META.O', '메타', 'META'], ['us:AMZN.O', '아마존닷컴', 'AMZN'],
    ['us:MSTR.O', '스트래티지', 'MSTR'], ['us:SKHY.O', 'SK하이닉스 ADR', 'SKHY'], ['us:NDAQ.O', '나스닥', 'NDAQ'],
  ];
  for (const [sym, name, sub] of names) remember(sym, { name, sub });
});

const item = (o: Partial<NewsItem>): NewsItem => ({ title: '', src: '코인니스', url: 'https://x/' + Math.random(), ts: 0, ...o });
const ai = (s: AiTag['s'], r = '이유', t: string[] = []): AiTag => ({ s, r, t });

describe('sentimentOf', () => {
  it('AI 판단이 있으면 투표보다 AI 를 따른다', () => {
    const s = sentimentOf(item({ title: 'BTC 급등', bull: 400, bear: 10 }), 100, ai(-1, '대량 매도 물량'), VOTE_NEUTRAL.coinflash);
    expect(s).toMatchObject({ level: -1, label: '악재', basis: 'ai', reason: '대량 매도 물량' });
    expect(s.votes).toBe(410); // 투표는 참고로 함께
  });
  it('AI 가 판단에 실패(null)했으면 투표로', () => {
    const s = sentimentOf(item({ bull: 270, bear: 20 }), 150, null, VOTE_NEUTRAL.coinflash);
    expect(s.basis).toBe('votes');
    expect(s.level).toBe(1);
  });
  it('코인 속보 투표 — 보통 기사도 호재 표가 84~92% 라서 그 위·아래 꼬리만 호재·악재', () => {
    const med = 180, n = VOTE_NEUTRAL.coinflash;
    expect(sentimentOf(item({ bull: 190, bear: 10 }), med, undefined, n).level).toBe(1); // 95%
    expect(sentimentOf(item({ bull: 170, bear: 30 }), med, undefined, n).level).toBe(0); // 85% — 보통 기사
    expect(sentimentOf(item({ bull: 99, bear: 33 }), med, undefined, n).level).toBe(0); // 75% — 아직 보통 범위
    expect(sentimentOf(item({ bull: 51, bear: 93 }), med, undefined, n).level).toBe(-1);
    // 중요 표시 + 압도적 호재 → 미친 호재
    expect(sentimentOf(item({ bull: 480, bear: 15, important: true }), med, undefined, n).level).toBe(2);
    // 표가 적으면 투표로 판단하지 않는다
    expect(sentimentOf(item({ title: '일정 안내', bull: 9, bear: 1 }), med, undefined, n).basis).toBe('none');
  });
  it('주식 속보는 평소 악재 쪽으로 기우니 그보다 뚜렷해야 악재', () => {
    const n = VOTE_NEUTRAL.stockflash;
    expect(sentimentOf(item({ bull: 36, bear: 18 }), 50, undefined, n).level).toBe(1); // 인텔 투자의견 상향
    expect(sentimentOf(item({ bull: 19, bear: 28 }), 50, undefined, n).level).toBe(0);
    expect(sentimentOf(item({ bull: 17, bear: 55 }), 50, undefined, n).level).toBe(-1);
  });
  it('투표가 없으면 키워드로 추정하고 근거 단어를 돌려준다', () => {
    const s = sentimentOf(item({ title: '비트코인 급등…사상 최고치 경신, 현물 ETF 승인' }), 0);
    expect(s.basis).toBe('keywords');
    expect(s.level).toBeGreaterThanOrEqual(1);
    expect(s.pos?.length).toBeGreaterThan(0);
    // 같은 묶음(해킹·파산·폭락)은 한 번만 센다 — '미친 악재'는 서로 다른 큰 악재가 겹칠 때만
    expect(sentimentOf(item({ title: '거래소 해킹으로 파산 신청…코인 폭락' }), 0).level).toBe(-1);
    expect(sentimentOf(item({ title: '거래소 해킹 피해…당국 조사 착수' }), 0).level).toBe(-2);
    expect(sentimentOf(item({ title: 'ENS DAO, 투표 시작' }), 0).basis).toBe('none');
  });
  it("'~지만' 뒤가 결론 — 급락 출발했지만 반등 성공은 악재가 아니다", () => {
    expect(keywordHits('반도체 불안에 급락 출발했지만… 코스피, 반등 성공').score).toBeGreaterThan(-2);
    expect(sentimentOf(item({ title: '반도체 불안에 급락 출발했지만… 코스피, 반등 성공' }), 0).level).toBe(0);
  });
  it('medianVotes', () => {
    expect(medianVotes([item({ bull: 1, bear: 1 }), item({ bull: 10, bear: 10 }), item({ bull: 50, bear: 50 }), item({})])).toBe(20);
  });
});

describe('relatedOf / resolveTag', () => {
  it('코인니스 코드 → 업비트(없으면 바이낸스)', () => {
    expect(relatedOf(item({ codes: ['BTC', 'BNB', 'NOPE'] }), 'coin').map((r) => r.sym)).toEqual(['upbit:KRW-BTC', 'binance:BNBUSDT']);
  });
  it('AI 가 고른 티커·회사 이름을 종목으로', () => {
    expect(resolveTag('BTC', 'coin')).toBe('upbit:KRW-BTC');
    expect(resolveTag('NVDA', 'stock')).toBe('us:NVDA.O');
    expect(resolveTag('MSTR', 'coin')).toBe('us:MSTR.O'); // 코인에 없으면 미국 주식
    expect(resolveTag('삼성전기', 'stock')).toBe('krx:009150');
    expect(resolveTag('엔비디아(NVDA)', 'stock')).toBe('us:NVDA.O');
    expect(resolveTag('삼성바이오', 'stock')).toBe('krx:207940'); // 앞부분만 맞아도
    expect(resolveTag('Ethereum', 'coin')).toBe('upbit:KRW-ETH');
    expect(resolveTag('ETF', 'coin')).toBeNull();
    expect(resolveTag('한선제약', 'stock')).toBeNull();
    const r = relatedOf(item({ title: '스트래티지, 267 BTC 매수', codes: ['BTC'] }), 'coin', ai(1, '기관 매수', ['BTC', 'MSTR']));
    expect(r.map((x) => x.sym)).toEqual(['upbit:KRW-BTC', 'us:MSTR.O']);
  });
  it('본문 속 이름은 낱말로만 — 흔한 낱말과 겹치는 이름은 거른다', () => {
    expect(hasWord('엔지니어 채용', '니어')).toBe(false);
    expect(hasWord('니어가 급등', '니어')).toBe(true);
    expect(hasWord('메타플래닛, BTC 매수', '메타')).toBe(false);
    expect(hasWord('메타·테슬라 실적', '메타')).toBe(true);
    expect(relatedOf(item({ title: '규제 샌드박스 지정' }), 'coin')).toEqual([]);
    expect(relatedOf(item({ title: '나스닥 1.4% 상승' }), 'stock')).toEqual([]);
    expect(relatedOf(item({ title: '솔라나 알펜글로우 업그레이드' }), 'coin').map((x) => x.sym)).toEqual(['upbit:KRW-SOL']);
    expect(relatedOf(item({ title: '리플은 오늘' }), 'coin').map((x) => x.sym)).toEqual(['upbit:KRW-XRP']);
  });
  it('국내 종목과 같은 이름의 미국 ADR 은 국내 종목으로만', () => {
    expect(relatedOf(item({ title: '삼성전자·SK하이닉스 동반 반등' }), 'stock').map((x) => x.sym)).toEqual(['krx:005930', 'krx:000660']);
    expect(relatedOf(item({ title: '아마존 실적 발표, 기아는 신차' }), 'stock').map((x) => x.sym).sort()).toEqual(['krx:000270', 'us:AMZN.O']);
  });
  it('코인니스가 코드를 붙인 코인 기사는 본문 이름으로 더 찾지 않는다', () => {
    expect(relatedOf(item({ title: '이더리움 고래, 솔라나로 이동', codes: ['ETH'] }), 'coin').map((x) => x.sym)).toEqual(['upbit:KRW-ETH']);
  });
});

describe('cleanSummary', () => {
  it('통신사 머리말·안내문을 빼고, 중간에서 잘린 요약엔 …를 붙인다', async () => {
    vi.stubGlobal('location', { hash: '' }); // 카드 모듈이 불러오는 라우터가 주소를 읽는다
    const { cleanSummary } = await import('./NewsCard');
    expect(cleanSummary('바르샤바, 10월 19일 (로이터) - 폴란드 중앙은행이')).toBe('폴란드 중앙은행이');
    expect(cleanSummary('런던, 10월 19일 (로이터 브레이킹뷰) - 데이터센터 신생 기업들이')).toBe('데이터센터 신생 기업들이');
    expect(cleanSummary('10월 19일 (The Insurer) - 전문 보험사')).toBe('전문 보험사');
    expect(cleanSummary('**속보** 비트코인 상승 원문: https://x')).toBe('속보 비트코인 상승');
    const cut = '조서는 월요일 영국 손해보험 사업 확장을 이끌기 위해 쿠시웨이를 영입했다고 밝혔다. '.repeat(3) + '회사 측은 쿠시웨이(Ryan Cushway)가 조서(Cha';
    const out = cleanSummary(cut.slice(0, 160));
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('(Cha');
    expect(cleanSummary('짧은 요약이에요.')).toBe('짧은 요약이에요.');
    expect(cleanSummary('-- 출처 링크: https://tinyurl.com/2pxpc2t8 -- 참고: 로이터는 이 기사의 내용을 확인하지 않았으며, 그 정확성을 보증하지 않습니다.')).toBe('');
    expect(cleanSummary('골드만삭스가 펀드를 제안했다. -- 출처 링크: https://x.y/z -- 참고: 로이터는 이 기사의 내용을')).toBe('골드만삭스가 펀드를 제안했다.');
    // 160자에서 잘린 안내문뿐인 요약 → 빈 문자열 (…만 남지 않게)
    const disc = ('-- 출처 링크: https://tinyurl.com/2pxpc2t8 -- 참고: 로이터는 이 기사의 내용을 확인하지 않았으며, 그 정확성을 보증하지 않습니다. ' + '가나다 '.repeat(40)).slice(0, 160);
    expect(cleanSummary(disc)).toBe('');
    const tail = ('골드만삭스가 사모펀드에 펀드를 제안했다고 블룸버그가 보도했다 ' + '가나다 '.repeat(40)).slice(0, 160) + ' -- 출처 링크: https://x.y/z';
    expect(cleanSummary(tail).endsWith('…')).toBe(false);
  });
});

describe('keywordHits — 금리·환율 같은 지표 기사', () => {
  it('지표의 오르내림은 호재·악재로 세지 않는다', () => {
    expect(sentimentOf(item({ title: '프랑스 10년물 국채금리 16bp 급등, 4.94%...2025년 3월 이후 최대 상승' }), 0).level).toBe(0);
    expect(sentimentOf(item({ title: '원/달러 환율 1330원대 하락 마감…2년 만에 최저' }), 0).level).toBe(0);
    expect(sentimentOf(item({ title: '국제유가 급락' }), 0).level).toBe(0);
    expect(sentimentOf(item({ title: '국제 유가 폭등…WTI 사상 최고' }), 0).level).toBe(0);
    // '달러'가 금액 단위거나 '유가증권'이면 지표가 아니다
    expect(sentimentOf(item({ title: '비트코인, 1억 달러 규모 매집에 급등' }), 0).level).toBeGreaterThanOrEqual(1);
    expect(sentimentOf(item({ title: '유가증권시장 2차전지주 급등…신고가' }), 0).level).toBeGreaterThanOrEqual(1);
    // 지표 기사라도 사건 낱말(해킹 등)은 센다
    expect(sentimentOf(item({ title: '해킹 사태에 고개 숙인 은행장…대출금리도 도마' }), 0).level).toBeLessThan(0);
  });
});

describe('거래소 공지 · 코인 SNS 판단 (officialSentiment)', () => {
  const notice = (o: Partial<NewsItem>) => item({ src: '업비트', ...o });
  it('AI 판단이 있으면 공지 종류 규칙보다 AI', () => {
    const s = officialSentiment(notice({ title: '질리카(ZIL) 거래지원 종료 안내', rule: { s: -1, r: '거래지원 종료(상장폐지)' } }), ai(-2, '상장폐지 확정'));
    expect(s).toMatchObject({ level: -2, basis: 'ai', reason: '상장폐지 확정' });
  });
  it('AI 가 없으면 공지 종류 규칙(rule)', () => {
    const s = officialSentiment(notice({ title: '고체인(GO) 출금 일시 중단 안내', rule: { s: -1, r: '네트워크·보안 문제로 입출금 중단' } }));
    expect(s).toMatchObject({ level: -1, basis: 'rule', reason: '네트워크·보안 문제로 입출금 중단' });
  });
  it('SNS 글은 규칙이 없으면 판단하지 않는다 — 영어 글이라도 키워드로 추정하지 않는다', () => {
    const s = officialSentiment(item({ title: 'SEI surges to all-time high — 급등 신고가 돌파', src: 'Sei', ch: '@seinetwork' }));
    expect(s).toMatchObject({ level: 0, basis: 'none' });
    // AI 판단 실패(null)도 판단 없음
    expect(officialSentiment(item({ title: 'x', ch: '@a' }), null).basis).toBe('none');
  });
  it('업비트 원화 신규 상장 공지만 과거 신규 상장 결과를 붙인다', () => {
    const krw = { caution: 'listing' as const, rule: { s: 0 as const, r: '원화 마켓 신규 상장 — 과거엔 상장 직후 오른 뒤 7일 안에 내린 경우가 많아요' } };
    expect(isUpbitKrwListing(notice({ title: '콘크리트(CT) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)', ...krw }))).toBe(true);
    expect(isUpbitKrwListing(notice({ title: '콘크리트(CT) 원화 마켓 추가', src: '빗썸', ...krw }))).toBe(false);
    expect(isUpbitKrwListing(notice({ title: 'Binance Will List RWUSD', src: '바이낸스', caution: 'listing', rule: { s: 0, r: '바이낸스 현물 신규 상장' } }))).toBe(false);
  });
  it('옮겨 온 곳 이름은 짧게', () => {
    expect(viaName('X (formerly Twitter)')).toBe('X');
    expect(viaName('LinkedIn')).toBe('LinkedIn');
    expect(viaName(undefined)).toBe('');
  });
});

describe('뉴스 과거 검증 (news_state.json)', () => {
  const h = (n: number, med: number, win: number, vsNews?: number) => ({ n, raw: [-20, -8, med, 5, 14], rawWin: win, vsNews });
  const st: NewsState = {
    coins: { CT: { study: 'krListNew' }, BTC: { study: 'voteBad' } },
    study: {
      data: { articles: 14289, period: ['2024-01-17', '2026-10-19'] },
      groups: {
        news: { label: '기준', use: 'base', h: { 7: h(7162, -1.94, 41.29) } },
        voteGood: { label: '투표 호재', use: 'weak', h: { 7: h(1991, -2.26, 38.52, 0.41) } },
        voteBad: { label: '투표 악재', use: 'none', h: { 7: h(823, -2.44, 37.67, -0.41) } },
        kwBad: { label: '나쁜 말', use: 'none', h: { 7: h(246, -2.11, 42.28, -0.16) } },
        krListNew: { label: '업비트 신규 상장', use: 'caution', h: { 7: h(153, -11.39, 24.18, -6.65), 30: h(150, -23.5, 23.33) } },
      },
    },
  };
  it('일반 호재·악재의 7일 차이는 가장 큰 크기로 (신규 상장은 빼고)', () => {
    expect(moodEffect(st)).toMatchObject({ maxAbs: 0.41, articles: 14289, from: '2024-01-17', to: '2026-10-19' });
    expect(moodEffect({})).toBeNull();
  });
  it('업비트 신규 상장 숫자는 파일에서', () => {
    expect(listingStudy(st)).toEqual({ n: 153, med7: -11.39, win7: 24.18, med30: -23.5, baseMed7: -1.94, baseWin7: 41.29 });
    expect(listingStudy({ study: { groups: {} } })).toBeNull();
  });
  it('최근 업비트 신규 상장 코인인가 (티커 대소문자 무관)', () => {
    expect(isNewUpbitListing(st, 'CT')).toBe(true);
    expect(isNewUpbitListing(st, 'ct')).toBe(true);
    expect(isNewUpbitListing(st, 'BTC')).toBe(false);
    expect(isNewUpbitListing(undefined, 'CT')).toBe(false);
    expect(isNewUpbitListing(st, null)).toBe(false);
  });
});
