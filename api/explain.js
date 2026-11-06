// =====================================================
// Vercel 서버 함수: POST /api/explain
// 두 길 비교 결과(숫자 묶음 facts)를 받아, "왜 이 길이 추천(보행 주의 점수가 더 낮은 쪽)으로 정해졌는지"를 OpenRouter 무료 AI가 쉬운 문장으로 설명한다.
// - 질문은 받지 않는다. 항상 같은 요청(추천 이유 설명)만 한다.
// - 비밀 키(OPENROUTER_API_KEY)는 이 파일(서버)에서만 읽는다. 브라우저로는 나가지 않는다. (Vercel 환경 변수로 설정)
// - AI는 계산하지 않는다. 숫자는 모두 브라우저가 계산해서 facts로 보낸 값이고, AI는 그 값만 문장으로 쓴다.
// - 안전장치: AI 답에 facts에 없는 숫자가 있거나, "안전합니다"·"범죄가 많다" 같은 단정이 있거나, 내부 항목 이름이 새면 그 답을 버린다.
//   빈 답이나 거부된 답이면 한 번 더 시도하고, 그래도 안 되면 { answer: null, source: 'fallback' }을 돌려준다. 화면은 규칙으로 만든 기본 설명을 계속 보여 준다.
//
// 이 저장소에는 package.json이 없어서 .js 파일은 CommonJS로 읽힌다 → module.exports 사용.
// =====================================================

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openrouter/free';      // 무료 모델 중 하나를 자동으로 골라 줌
const AI_TIMEOUT_MS = 11000;          // 한 번의 AI 호출이 11초 안에 답이 없으면 포기
const RETRY_BEFORE_MS = 12000;        // 첫 시도가 이 시간 안에 끝났을 때만 한 번 더 시도 (최대 약 22초, vercel.json의 maxDuration 30초 이내)
const MAX_TOKENS = 900;               // 일부 무료 모델은 답하기 전에 '생각'에 토큰을 쓰므로 넉넉하게 (답 자체는 짧음)
const MAX_BODY_CHARS = 6000;          // 받는 요청 최대 크기
const MAX_ANSWER_CHARS = 450;
const LIMIT_PER_MINUTE = 6;           // 같은 사람(IP)이 1분에 부를 수 있는 횟수 (서버 한 대 기준의 대략적인 제한)

const recentCalls = new Map();

function tooManyCalls(ip) {
  const now = Date.now();
  const list = (recentCalls.get(ip) || []).filter((t) => now - t < 60000);
  list.push(now);
  recentCalls.set(ip, list);
  if (recentCalls.size > 500) recentCalls.clear();
  return list.length > LIMIT_PER_MINUTE;
}

const cleanStr = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

// 경로 한 개의 숫자 묶음 확인 (이상하면 null)
function readRoute(x) {
  if (!x || typeof x !== 'object') return null;
  if (!isNum(x.distanceM, 0, 20000) || !isNum(x.minutes, 0, 600) || !isNum(x.avgScore, 0, 100) || !isNum(x.hiSharePct, 0, 100)) return null;
  if (!isNum(x.lights, 0, 2000) || !isNum(x.cctvSpots, 0, 500) || !isNum(x.stairsM, 0, 20000)) return null;
  return { distanceM: x.distanceM, minutes: x.minutes, avgScore: x.avgScore, hiSharePct: x.hiSharePct, lights: x.lights, cctvSpots: x.cctvSpots, stairsM: x.stairsM,
    accidents: (Array.isArray(x.accidents) ? x.accidents : []).slice(0, 5).map((a) => cleanStr(a, 40)) };
}

// 받은 facts를 확인하고 정리 (이상하면 null). 문자열은 짧게 자르고 제어문자를 없앤다.
function readFacts(f) {
  if (!f || typeof f !== 'object') return null;
  const recommended = readRoute(f.recommended), shortest = readRoute(f.shortest), d = f.diff;
  if (!recommended || !shortest || !d || typeof d !== 'object') return null;
  const diff = {};
  for (const k of ['extraM', 'extraPct', 'extraMinutes', 'scoreDrop', 'hiSharePointsDrop', 'lightsMore', 'cctvMore']) {
    if (!isNum(d[k], -100000, 100000)) return null;
    diff[k] = d[k];
  }
  const worstSegments = (Array.isArray(f.worstSegments) ? f.worstSegments : []).slice(0, 3).map((w) => ({
    road: cleanStr(w && w.road, 30), lengthM: isNum(w && w.lengthM, 0, 20000) ? w.lengthM : 0, score: isNum(w && w.score, 0, 100) ? w.score : 0,
    reasons: (Array.isArray(w && w.reasons) ? w.reasons : []).slice(0, 2).map((r) => cleanStr(r, 30)),
  }));
  return {
    same: f.same === true, warnings: (Array.isArray(f.warnings) ? f.warnings : []).filter((w) => w === 'detour' || w === 'steps'),
    recommended, shortest, diff, worstSegments, hiScoreThreshold: 60, scoreScale: [0, 100], detourCapPct: 30,
  };
}

// 숫자 토큰 뽑기 ("1,122m" → "1122")
const numbersIn = (text) => (String(text).match(/\d[\d,]*(?:\.\d+)?/g) || []).map((n) => n.replace(/,/g, ''));

// AI 답 정리: 마크다운·따옴표 제거, 길이 제한. 쓸 수 없으면 null
function cleanAnswer(raw) {
  if (typeof raw !== 'string') return null;
  let t = raw.replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '').trim();
  if (!/[가-힣]/.test(t)) return null;
  if (t.length > MAX_ANSWER_CHARS) {
    const cut = t.slice(0, MAX_ANSWER_CHARS), end = Math.max(cut.lastIndexOf('다.'), cut.lastIndexOf('요.'), cut.lastIndexOf('니다.'));
    if (end < 40) return null;
    t = cut.slice(0, end + 2).trim();
  }
  return t || null;
}

// 안전장치: 숫자가 facts에 있는 값뿐인가, 단정 표현이 없는가, 내부 항목 이름이 새지 않았는가
const BANNED = /(안전합니다|안전해요|안전한 길입니다|안전하게 갈 수|(더|가장|매우)\s*안전|안전하(고|며|다|게)|안전한\s*(길|경로|구간)|위험한\s*(구간|길|경로)|위험하지 않|위험합니다|위험해요|안심|걱정\s*(하지\s*)?마|문제\s*없|범죄(가|는|율이|율은)\s*(많|적|없|높|낮|자주)|범죄\s*위험(이|은)\s*(높|낮|없|적))/;
const LEAK = /\[데이터\]|\b[a-z]+[A-Z][A-Za-z]*\b|\b(distanceM|minutes|avgScore|hiSharePct|cctvSpots|stairsM|worstSegments|recommended|shortest|diff)\b/;
function checkAnswer(answer, facts) {
  if (!answer) return { ok: false, reason: 'empty' };
  const allowed = new Set(numbersIn(JSON.stringify(facts)));
  const stray = numbersIn(answer).filter((n) => !allowed.has(n));
  if (stray.length) return { ok: false, reason: 'number:' + stray.slice(0, 3).join(',') };
  if (BANNED.test(answer)) return { ok: false, reason: 'claim' };
  if (LEAK.test(answer)) return { ok: false, reason: 'leak' };
  return { ok: true };
}

const SYSTEM_PROMPT =
  '너는 경남대학교 주변 보행 안전 지도의 해설자다. 사용자가 고른 출발지와 도착지 사이의 두 경로(최단 경로, 추천 경로)를 비교한 결과를 [데이터]로 받고, ' +
  '"왜 추천 경로가 선택됐는지"를 일반 사용자가 이해하기 쉽게 설명한다.\n' +
  '[데이터] 항목의 뜻: recommended=추천 경로, shortest=최단 경로. 각 경로의 distanceM=거리(m), minutes=걷는 시간(분), avgScore=평균 보행 주의 점수, ' +
  'hiSharePct=점수 60점 이상인 구간이 경로 길이에서 차지하는 비율(%), lights=경로 구간에 반영된 보안등 개수, cctvSpots=반영된 CCTV 지점 수, accidents=경로 근처 사고다발지 이름, stairsM=계단 구간 길이(m). ' +
  'diff=추천 경로가 최단 경로와 다른 정도: extraM=더 걷는 거리(m), extraPct=더 걷는 비율(%), extraMinutes=더 걸리는 시간(분), scoreDrop=평균 점수가 낮아진 정도, hiSharePointsDrop=60점 이상 구간 비율이 줄어든 %p, lightsMore=보안등이 더 많은 개수(음수면 더 적음), cctvMore=CCTV가 더 많은 곳 수(음수면 더 적음). ' +
  'worstSegments=추천 경로 안에서 점수가 가장 높은(가장 주의가 필요한) 구간 최대 3개: road=도로, lengthM=그 구간의 경로 길이, score=점수, reasons=점수가 높은 이유. same이 true면 두 경로가 같은 길이다.\n' +
  '점수는 "보행 주의 점수"(0~100)다. 높을수록 걸을 때 더 주의가 필요하고, 낮을수록 주의가 덜 필요하다. 추천 경로는 이 점수가 더 낮은 길이다. 점수가 낮아졌다는 말은 주의가 덜 필요해졌다는 뜻이다.\n' +
  '설명 순서: (1) 추천 경로가 평균 보행 주의 점수가 더 낮다는 핵심 이유를 숫자와 함께 말한다. (2) 그 대가로 더 걷는 거리와 시간을 말한다. ' +
  '(3) 60점 이상 구간 비율, 보안등, CCTV 중 의미 있는 차이를 한 가지 덧붙인다. (4) worstSegments가 있으면 추천 경로에서도 주의할 구간을 한 곳 알려 준다. ' +
  'same이 true면 최단 경로가 이미 점수 면에서 가장 나은 선택이라 두 경로가 같다고 설명하고 (1)~(2) 대신 경로의 거리·시간·점수를 알려 준다.\n' +
  '규칙:\n' +
  '1) [데이터]에 있는 사실만 사용한다. 데이터에 없는 이유(교통량, 날씨, 범죄 발생 등)를 지어내지 않는다.\n' +
  '2) 숫자는 [데이터]에 있는 값을 그대로만 쓴다. 더하기·빼기·반올림·단위 변환(m→km 등)을 하지 않는다. 필요한 차이값은 diff에 이미 들어 있다.\n' +
  '3) "안전하다", "안심", "위험하지 않다", "범죄가 많다/적다"처럼 단정하지 않는다. "위험" 대신 "주의"라는 말을 쓴다.\n' +
  '4) 한국어 존댓말로 4문장 이내, 300자 이내로 쓴다. 마크다운, 목록, 이모지는 쓰지 않는다. 항목 이름(distanceM 같은 영어 이름)과 "[데이터]"라는 말은 쓰지 않고 "거리", "걷는 시간"처럼 풀어 쓴다.';

// OpenRouter에 설명을 부탁함. 실패하면 { answer: null, reason }
async function askAI(facts) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) { console.error('OPENROUTER_API_KEY 환경변수가 없습니다.'); return { answer: null, reason: 'no-key' }; }
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `[데이터]\n${JSON.stringify(facts)}\n\n위 데이터로, 추천 경로가 선택된 이유를 설명해 주세요.` }],
        max_tokens: MAX_TOKENS, temperature: 0.3, reasoning: { effort: 'low' },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
    if (!res.ok) { console.error('OpenRouter 응답 오류, 상태 코드:', res.status); return { answer: null, reason: 'http-' + res.status }; }
    const data = await res.json();
    const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { answer: cleanAnswer(raw), reason: 'empty' };
  } catch (err) {
    console.error('OpenRouter 호출 실패:', err && err.name);
    return { answer: null, reason: (err && err.name) === 'TimeoutError' ? 'timeout' : 'error' };
  }
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_CHARS) return { tooBig: true };
    try { body = JSON.parse(body); } catch (e) { return { bad: true }; }
  }
  if (!body || typeof body !== 'object') return { bad: true };
  if (JSON.stringify(body).length > MAX_BODY_CHARS) return { tooBig: true };
  return { body };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 가능합니다.' });
  const parsed = readBody(req);
  if (parsed.tooBig) return res.status(413).json({ error: '요청이 너무 큽니다.' });
  if (parsed.bad) return res.status(400).json({ error: 'JSON 형식이 아닙니다.' });
  const facts = readFacts(parsed.body.facts);
  if (!facts) return res.status(400).json({ error: '경로 정보가 올바르지 않습니다.' });
  const ip = String((req.headers && req.headers['x-forwarded-for']) || 'unknown').split(',')[0].trim();
  if (tooManyCalls(ip)) return res.status(200).json({ answer: null, source: 'fallback', reason: 'rate-limit' }); // 너무 자주 부르면 AI는 부르지 않음 (무료 한도 보호)

  // 무료 모델은 같은 요청에도 빈 답을 주거나 규칙을 어길 때가 있어서, 빈 답·거부된 답이면 한 번 더 시도한다. (함수 제한 시간 vercel.json maxDuration 30초 안에서)
  const started = Date.now();
  let reason = 'empty';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0 && Date.now() - started > RETRY_BEFORE_MS) break;
    const ai = await askAI(facts);
    if (ai.answer) {
      const check = checkAnswer(ai.answer, facts);
      if (check.ok) return res.status(200).json({ answer: ai.answer, source: 'ai' });
      console.error('AI 답 거부:', check.reason); reason = 'rejected'; continue;
    }
    reason = ai.reason;
    if (reason === 'no-key' || /^http-40[123]$/.test(reason)) break; // 키 문제는 다시 해도 소용없음
  }
  return res.status(200).json({ answer: null, source: 'fallback', reason });
}

module.exports = handler;
module.exports.helpers = { readFacts, cleanAnswer, checkAnswer, numbersIn }; // 시험용
