/*
 * route.js — 두 길 비교 계산 (최단 경로 대 안전 경로)
 *
 * 브라우저(<script src="route.js">, 전역 Route)와 Node(import Route from '../route.js')에서 같은 코드를 쓴다.
 * 그래서 scripts/probe-routes.mjs(시험)와 화면의 결과가 같은지 바로 비교할 수 있다.
 * 화면(DOM)에 관한 코드는 없다. 입력은 data/graph.json, data/risk_segments.geojson, data/points.json의 내용이다.
 *
 * 경로 비용 (PRD 4번 확정 결정):
 *   최단 = 길이 × (계단이면 3)
 *   안전 = 길이 × (계단이면 3) × (1 + α × 구간 점수/100),  α = 2
 *   산길(path·track)은 경로 탐색에서 제외, 걷는 속도 4km/h, 우회 상한 1.3배(넘으면 경고)
 *
 * 출발·도착 붙이기 (snapToRoad): 누른 위치에서 "도로 위의 가장 가까운 점"을 찾는다 (60m 이내).
 *   도로의 꼭짓점이 아니라 도로 위의 점이므로 길이 긴 도로의 한가운데를 눌러도 붙는다.
 *   그 점에서 도로(간선)를 둘로 나눈 임시 노드를 만들어 경로를 계산하고, 계산이 끝나면 원래대로 되돌린다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Route = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = { alpha: 2, stepsFactor: 3, speedKmh: 4, detourCap: 1.3, snapMaxM: 60, hiScore: 60, trails: ['path', 'track'] };
  const CAMPUS = { lat: 35.1816, lon: 128.5532 };
  const M_LAT = 110540, M_LON = 111320 * Math.cos(CAMPUS.lat * Math.PI / 180);
  const toXY = (lat, lon) => [(lon - CAMPUS.lon) * M_LON, (lat - CAMPUS.lat) * M_LAT]; // 학교 기준 미터 좌표

  // 이진 힙 (다익스트라용)
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() {
      const a = this.a, top = a[0], last = a.pop();
      if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
      return top;
    }
  }

  /**
   * 그래프 만들기.
   * @param graph  graph.json의 내용
   * @param segById  구간 id → 구간 properties (risk_segments.geojson의 features[].properties)
   * @returns 경로 탐색용 그래프. 산길 간선은 인접 목록(adj)에서 빠져 있다.
   *   edges: 경로에 쓰는 본 도로망의 간선(붙이기 대상), isoEdges: 산길·끊긴 지역의 간선(안내 문구용)
   */
  function buildGraph(graph, segById, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const hw = graph.meta.hw, trail = new Set(o.trails), stepsIdx = hw.indexOf('steps');
    const group = graph.nodes.map(n => n[2]); // 0 = 본 도로망, 1 = 끊긴 작은 덩어리, 2 = 산길 전용
    const adj = graph.nodes.map(() => []), edges = [], isoEdges = [];
    for (const [a0, b0, len, sid, h] of graph.edges) {
      const a = Math.min(a0, b0), b = Math.max(a0, b0); // 간선 방향을 번호가 작은 쪽 → 큰 쪽으로 통일
      if (trail.has(hw[h])) { isoEdges.push({ a, b }); continue; }
      const seg = segById.get(sid); if (!seg) continue;
      const e = { a, b, len, score: seg.score, steps: h === stepsIdx, sid };
      adj[a].push(Object.assign({ to: b }, e)); adj[b].push({ a: b, b: a, to: a, len, score: e.score, steps: e.steps, sid });
      if (group[a] === 0) edges.push(e); else isoEdges.push({ a, b });
    }
    return { opts: o, nodes: graph.nodes, adj, edges, isoEdges, xy: graph.nodes.map(n => toXY(n[0], n[1])), group };
  }

  const edgeCost = (e, alpha, stepsFactor) => e.len * (e.steps ? stepsFactor : 1) * (1 + alpha * e.score / 100);

  /** 다익스트라. 경로가 없으면 null. 반환: { nodes: [노드...], edges: [{a,b,len,score,steps,sid}...], len } */
  function shortestPath(g, s, t, alpha) {
    const n = g.adj.length, d = new Float64Array(n).fill(Infinity), prev = new Array(n).fill(null); // 임시 노드까지 포함한 크기
    const sf = g.opts.stepsFactor; d[s] = 0;
    const h = new Heap(); h.push([0, s]);
    while (h.size) {
      const [dc, u] = h.pop(); if (dc > d[u]) continue; if (u === t) break;
      for (const e of g.adj[u]) { const nd = dc + edgeCost(e, alpha, sf); if (nd < d[e.to]) { d[e.to] = nd; prev[e.to] = e; h.push([nd, e.to]); } }
    }
    if (s !== t && !prev[t]) return null;
    const edges = [], nodes = [t];
    for (let c = t; c !== s; c = prev[c].a) { edges.push(prev[c]); nodes.push(prev[c].a); }
    edges.reverse(); nodes.reverse();
    return { nodes, edges, len: edges.reduce((x, e) => x + e.len, 0) };
  }

  // 점 p에서 선분 a–b까지: 가장 가까운 점의 위치 t(0~1)와 거리
  function projectOnSegment(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return { t, d: Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)) };
  }

  /**
   * 누른 위치를 도로 위의 가장 가까운 점에 붙인다.
   * status: 'ok' (경로에 쓸 수 있는 도로가 snapMaxM 안에 있음) / 'isolated' (산길·끊긴 지역만 가까이 있음) / 'far' (도로 근처가 아님)
   * ok일 때: { lat, lon: 도로 위의 점, dist: 누른 위치에서 그 점까지(m), edge, t: 간선 위치(번호 작은 노드 쪽이 0) }
   */
  function snapToRoad(g, lat, lon) {
    const p = toXY(lat, lon), max = g.opts.snapMaxM;
    let best = null;
    for (const e of g.edges) { const r = projectOnSegment(p, g.xy[e.a], g.xy[e.b]); if (!best || r.d < best.d) best = { e, t: r.t, d: r.d }; }
    if (best && best.d <= max) {
      const A = g.nodes[best.e.a], B = g.nodes[best.e.b];
      return { status: 'ok', dist: best.d, edge: best.e, t: best.t, lat: A[0] + best.t * (B[0] - A[0]), lon: A[1] + best.t * (B[1] - A[1]), clickLat: lat, clickLon: lon };
    }
    let iso = Infinity;
    for (const e of g.isoEdges) iso = Math.min(iso, projectOnSegment(p, g.xy[e.a], g.xy[e.b]).d);
    return { status: iso <= max ? 'isolated' : 'far', dist: best ? best.d : null, isoDist: iso, clickLat: lat, clickLon: lon };
  }

  // 붙인 점에 임시 노드를 만들어 간선을 둘로 나눈다. 계산이 끝나면 되돌린다.
  function withVirtual(g, snaps, fn) {
    const base = g.adj.length, added = [], vcoords = new Map(), ids = [];
    try {
      for (const sn of snaps) {
        const e = sn.edge, id = g.adj.length; g.adj.push([]); ids.push(id); vcoords.set(id, [sn.lat, sn.lon]);
        const la = e.len * sn.t, lb = e.len * (1 - sn.t), mk = (a, b, len) => ({ a, b, to: b, len, score: e.score, steps: e.steps, sid: e.sid });
        g.adj[id].push(mk(id, e.a, la), mk(id, e.b, lb));
        const ea = mk(e.a, id, la), eb = mk(e.b, id, lb); g.adj[e.a].push(ea); g.adj[e.b].push(eb); added.push([e.a, ea], [e.b, eb]);
      }
      if (snaps.length === 2 && snaps[0].edge.a === snaps[1].edge.a && snaps[0].edge.b === snaps[1].edge.b) { // 같은 간선 위의 두 점: 서로 직접 연결
        const e = snaps[0].edge, len = Math.abs(snaps[0].t - snaps[1].t) * e.len, mk = (a, b) => ({ a, b, to: b, len, score: e.score, steps: e.steps, sid: e.sid });
        g.adj[ids[0]].push(mk(ids[0], ids[1])); g.adj[ids[1]].push(mk(ids[1], ids[0]));
      }
      return fn(ids, vcoords);
    } finally {
      for (const [node, e] of added) { const arr = g.adj[node], k = arr.indexOf(e); if (k >= 0) arr.splice(k, 1); }
      g.adj.length = base;
    }
  }

  /**
   * 최단 경로와 안전 경로를 함께 구한다.
   * @param start, end  snapToRoad의 결과(권장) 또는 노드 번호(시험용)
   * @returns { ok, reason?, shortest, safe, same, detour, warnings }
   *   reason: 'same-point' | 'no-route' | 'far' | 'isolated'(붙이기 실패한 쪽의 status). 각 경로에는 coords([[lat,lon]...])가 들어 있다.
   */
  function findRoutes(g, start, end, opts) {
    const alpha = (opts && opts.alpha != null) ? opts.alpha : g.opts.alpha;
    const finish = (shortest, safe, coords) => {
      if (!shortest || !safe) return { ok: false, reason: 'no-route' };
      shortest.coords = coords(shortest.nodes); safe.coords = coords(safe.nodes);
      const same = shortest.nodes.join('>') === safe.nodes.join('>'), detour = safe.len / shortest.len, warnings = [];
      if (detour > g.opts.detourCap) warnings.push('detour');
      if (safe.edges.some(e => e.steps)) warnings.push('steps');
      return { ok: true, shortest, safe, same, detour, warnings };
    };
    if (typeof start === 'number') { // 노드 번호로 직접 (시험 스크립트용)
      if (start === end) return { ok: false, reason: 'same-point' };
      return finish(shortestPath(g, start, end, 0), shortestPath(g, start, end, alpha), ids => ids.map(i => g.nodes[i].slice(0, 2)));
    }
    for (const sn of [start, end]) if (sn.status !== 'ok') return { ok: false, reason: sn.status };
    const [x1, y1] = toXY(start.lat, start.lon), [x2, y2] = toXY(end.lat, end.lon);
    if (Math.hypot(x1 - x2, y1 - y2) < 3) return { ok: false, reason: 'same-point' };
    return withVirtual(g, [start, end], (ids, vcoords) =>
      finish(shortestPath(g, ids[0], ids[1], 0), shortestPath(g, ids[0], ids[1], alpha), list => list.map(i => i < g.nodes.length ? g.nodes[i].slice(0, 2) : vcoords.get(i))));
  }

  /**
   * 경로의 비교 표 숫자. (같은 보안등·CCTV가 여러 구간에 반영되므로 중복을 제거해서 센다)
   * @param ctx  { segById, lights: points.lights, cctv: points.cctv }
   */
  function summarize(route, ctx, opts) {
    const o = Object.assign({}, DEFAULTS, opts), len = route.len;
    let scoreLen = 0, hiLen = 0, stepsLen = 0;
    const segIds = [], seen = new Set();
    for (const e of route.edges) {
      scoreLen += e.len * e.score; if (e.score >= o.hiScore) hiLen += e.len; if (e.steps) stepsLen += e.len;
      if (!seen.has(e.sid)) { seen.add(e.sid); segIds.push(e.sid); }
    }
    const li = new Set(), ci = new Set(), acc = new Set();
    for (const sid of segIds) { const p = ctx.segById.get(sid); p.li.forEach(i => li.add(i)); p.ci.forEach(i => ci.add(i)); if (p.accName) acc.add(p.accName); }
    return {
      distanceM: len, minutes: len / (o.speedKmh * 1000 / 60), avgScore: scoreLen / len, hiShare: hiLen / len, hiLenM: hiLen, stepsLenM: stepsLen,
      lightPoints: li.size, lightCount: [...li].reduce((x, i) => x + (ctx.lights[i][2] || 1), 0),
      cctvSpots: ci.size, cctvCameras: [...ci].reduce((x, i) => x + (ctx.cctv[i][3] || 1), 0),
      accidents: [...acc], segmentCount: segIds.length,
    };
  }

  // 점수가 높은 구간의 이유 (항목별 주의도 r.light 등 0~1, 가중치가 큰 순으로 최대 2개)
  const REASONS = [['light', '근처 보안등 부족', 0.6], ['cctv', '근처 CCTV 부족', 0.6], ['accident', '사고다발지와 가까움', 0.5], ['road', '도로 등급상 불리한 조건', 0.6]];
  function reasonsOf(p, weights) {
    return REASONS.filter(([k, , thr]) => p.r && p.r[k] != null && p.r[k] >= thr && (!weights || weights[k] > 0))
      .sort((a, b) => (weights ? weights[b[0]] : 1) * p.r[b[0]] - (weights ? weights[a[0]] : 1) * p.r[a[0]]).slice(0, 2).map(x => x[1]);
  }

  /**
   * AI 설명에 쓸 "사실 묶음" (facts). 숫자는 모두 여기서 계산해서 넘긴다. AI는 계산하지 않고 이 값만 문장으로 풀어 쓴다.
   * @param r  findRoutes의 결과(ok)   @param ctx  { segById, lights, cctv, weights?, roadLabel?(props) }
   */
  function buildFacts(r, ctx, opts) {
    const o = Object.assign({}, DEFAULTS, opts), r1 = v => Math.round(v * 10) / 10;
    const pack = rt => { const s = summarize(rt, ctx, opts); return { distanceM: Math.round(s.distanceM), minutes: Math.max(1, Math.round(s.minutes)), avgScore: r1(s.avgScore), hiSharePct: Math.round(s.hiShare * 100), lights: s.lightCount, cctvSpots: s.cctvSpots, accidents: s.accidents, stairsM: Math.round(s.stepsLenM) }; };
    const rec = pack(r.safe), sh = pack(r.shortest), bySeg = new Map();
    for (const e of r.safe.edges) bySeg.set(e.sid, (bySeg.get(e.sid) || 0) + e.len);
    const worst = [...bySeg].map(([sid, len]) => ({ p: ctx.segById.get(sid), len })).filter(x => x.p && x.p.score >= o.hiScore)
      .sort((a, b) => b.p.score - a.p.score || b.len - a.len).slice(0, 3)
      .map(x => ({ road: ctx.roadLabel ? ctx.roadLabel(x.p) : (x.p.name || x.p.hw), lengthM: Math.round(x.len), score: x.p.score, reasons: reasonsOf(x.p, ctx.weights) }));
    return {
      same: !!r.same, warnings: r.warnings.slice(), recommended: rec, shortest: sh,
      diff: { extraM: rec.distanceM - sh.distanceM, extraPct: Math.round((r.detour - 1) * 100), extraMinutes: rec.minutes - sh.minutes, scoreDrop: r1(sh.avgScore - rec.avgScore), hiSharePointsDrop: sh.hiSharePct - rec.hiSharePct, lightsMore: rec.lights - sh.lights, cctvMore: rec.cctvSpots - sh.cctvSpots },
      worstSegments: worst, hiScoreThreshold: o.hiScore, scoreScale: [0, 100], detourCapPct: Math.round((o.detourCap - 1) * 100),
    };
  }

  /** facts로 만든 기본 설명 (AI 없이 규칙으로 만든 문장). AI를 쓸 수 없을 때의 대체 문구이기도 하다. */
  function templateText(f) {
    const R = f.recommended, S = f.shortest, d = f.diff, out = [];
    if (f.same) out.push(`두 경로가 같은 길입니다. 점수를 고려해도 최단 경로가 바뀌지 않았습니다. 약 ${R.minutes}분(${R.distanceM}m) 걸리고 평균 보행 주의 점수는 ${R.avgScore}점입니다.`);
    else {
      const extra = d.extraM > 0 ? `${d.extraM}m(${d.extraPct}%) 더 걷지만` : '거리는 비슷하면서';
      out.push(d.scoreDrop >= 0.5
        ? `추천 경로는 최단 경로보다 ${extra} 평균 보행 주의 점수가 ${d.scoreDrop}점 낮습니다(${S.avgScore}점 → ${R.avgScore}점).`
        : `추천 경로와 최단 경로의 평균 보행 주의 점수 차이는 크지 않습니다(${S.avgScore}점, ${R.avgScore}점).`);
      const both = (a, b, fmt) => a === b ? `둘 다 ${fmt(a)}` : `최단 ${fmt(a)}, 추천 ${fmt(b)}`; // 값이 같으면 "둘 다"로
      out.push(`60점 이상 구간 비율은 ${both(S.hiSharePct, R.hiSharePct, v => v + '%')}이고, 걷는 시간은 ${both(S.minutes, R.minutes, v => '약 ' + v + '분')}입니다.`);
      out.push(`경로 구간에 반영된 보안등은 ${both(S.lights, R.lights, v => v + '개')}이고, CCTV는 ${both(S.cctvSpots, R.cctvSpots, v => v + '곳')}입니다.`);
    }
    if (f.worstSegments.length) {
      const w = f.worstSegments[0];
      out.push(`추천 경로에서 가장 주의가 필요한 구간은 ${w.road}(${w.lengthM}m, ${w.score}점)${w.reasons.length ? `이고, 주된 이유는 ${w.reasons.join(', ')}입니다` : '입니다'}.`);
    } else out.push(`추천 경로에는 ${f.hiScoreThreshold}점 이상인 구간이 없습니다.`);
    if (f.warnings.includes('detour')) out.push(`추천 경로가 최단 경로보다 ${f.detourCapPct}%를 넘게 멀어서, 돌아갈 만한지 판단이 필요합니다.`);
    if (f.warnings.includes('steps')) out.push(`추천 경로에 계단 구간이 약 ${R.stairsM}m 있습니다.`);
    out.push('이 점수는 보안등·CCTV·사고다발지·도로 등급으로 만든 환경 기반 지표이며, 안전을 보장하거나 범죄 발생을 예측하지 않습니다.');
    return out.join(' ');
  }

  /** 3줄 요약 (이유 · 거리 · 주의할 곳). 화면에 기본으로 보이는 짧은 설명. 숫자는 모두 facts의 값이다. [{ label, text }] */
  function summaryLines(f) {
    const R = f.recommended, S = f.shortest, d = f.diff, lines = [];
    if (f.same) {
      lines.push({ label: '결과', text: '두 경로가 같은 길이에요. 점수를 따져도 최단 경로가 그대로예요.' });
      lines.push({ label: '정보', text: `약 ${R.minutes}분 · ${R.distanceM}m · 평균 보행 주의 점수 ${R.avgScore}점` });
    } else {
      lines.push({ label: '이유', text: d.scoreDrop >= 0.5 ? `보행 주의 점수가 ${d.scoreDrop}점 더 낮은 길이에요 (${S.avgScore}점 → ${R.avgScore}점)` : `보행 주의 점수 차이는 작아요 (${S.avgScore}점, ${R.avgScore}점)` });
      lines.push({ label: '거리', text: d.extraM > 0 ? (d.extraMinutes > 0 ? `${d.extraM}m(${d.extraPct}%) 더 걷고 약 ${d.extraMinutes}분 더 걸려요` : `${d.extraM}m(${d.extraPct}%) 더 걷지만 시간은 비슷해요`) : '거리와 시간은 비슷해요' });
    }
    if (f.worstSegments.length) { const w = f.worstSegments[0]; lines.push({ label: '주의', text: `가장 주의할 구간은 ${w.road} ${w.lengthM}m (${w.score}점)` }); }
    else lines.push({ label: '주의', text: `${f.hiScoreThreshold}점 이상인 구간이 없어요` });
    return lines;
  }

  return { DEFAULTS, CAMPUS, toXY, buildGraph, shortestPath, snapToRoad, findRoutes, summarize, buildFacts, templateText, summaryLines };
});
