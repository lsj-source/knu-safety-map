// 경로 탐색 시험(벤치마크): data/graph.json + data/risk_segments.geojson 으로 "최단 경로"와 "안전 경로"를 비교한다.
// 다음 주 두 길 비교 기능의 완료 기준을 재는 용도. 실행: node scripts/probe-routes.mjs [쌍 개수=250]
//
// 경로 비용 (결정 D3~D6, D9):
//   최단 = 길이                       안전 = 길이 × (1 + α × 점수/100)   (α = 2)
//   산길(path/track)은 경로 탐색에서 제외(D3), 계단(steps)은 비용 3배(D4), 걷는 속도 4km/h(D9)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const g = JSON.parse(fs.readFileSync(path.join(DATA, 'graph.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(DATA, 'risk_segments.geojson'), 'utf8'));
const pts = JSON.parse(fs.readFileSync(path.join(DATA, 'points.json'), 'utf8'));
const N = Number(process.argv[2]) || 250;
const ALPHA = Number(process.argv[3]) || 2, STEPS_X = 3, SPEED_KMH = 4, DETOUR_CAP = 1.3; // 실행: node scripts/probe-routes.mjs [쌍 개수] [α]

// 구간 id → 점수 (요소값 r과 가중치로 다시 계산해서, 저장된 score와 같은지도 확인한다)
const W = pts.meta.weights;
const scoreFromR = r => { let s = 0, w = 0; for (const k of Object.keys(W)) if (W[k] > 0 && r[k] != null) { s += W[k] * r[k]; w += W[k]; } return (s / w) * 100; };
const seg = new Map(); let maxDiff = 0;
for (const f of geo.features) { const p = f.properties; seg.set(p.id, p); maxDiff = Math.max(maxDiff, Math.abs(scoreFromR(p.r) - p.score)); }
console.log(`구간 ${seg.size}개, 요소값으로 다시 계산한 점수와 저장된 점수의 최대 차이 ${maxDiff.toFixed(2)}점`);

const hw = g.meta.hw, TRAIL = new Set(g.meta.trailHw), stepsIdx = hw.indexOf('steps');
const adj = g.nodes.map(() => []);
for (const [a, b, len, sid, h] of g.edges) {
  if (TRAIL.has(hw[h])) continue;                         // D3: 산길 제외
  const e = { len, sc: seg.get(sid).score, steps: h === stepsIdx, sid };
  adj[a].push({ to: b, ...e }); adj[b].push({ to: a, ...e });
}
const main = g.nodes.map((n, i) => i).filter(i => g.nodes[i][2] === 0); // 본 도로망 노드만 출발·도착으로 허용
console.log(`그래프: 노드 ${g.nodes.length}, 간선 ${g.edges.length}, 경로 탐색 가능 본 도로망 노드 ${main.length}`);

// 이진 힙 다익스트라
class Heap { constructor() { this.a = []; } push(x) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; } }
const cost = (e, alpha) => e.len * (e.steps ? STEPS_X : 1) * (1 + alpha * e.sc / 100);
function route(s, t, alpha) {
  const d = new Float64Array(g.nodes.length).fill(Infinity); const prev = new Array(g.nodes.length).fill(null);
  d[s] = 0; const h = new Heap(); h.push([0, s]);
  while (h.size) { const [dc, u] = h.pop(); if (dc > d[u]) continue; if (u === t) break; for (const e of adj[u]) { const nd = dc + cost(e, alpha); if (nd < d[e.to]) { d[e.to] = nd; prev[e.to] = { from: u, e }; h.push([nd, e.to]); } } }
  if (!prev[t]) return null;
  const es = []; for (let c = t; c !== s; c = prev[c].from) es.push(prev[c].e);
  const len = es.reduce((x, e) => x + e.len, 0);
  return { len, avg: es.reduce((x, e) => x + e.len * e.sc, 0) / len, hi: es.filter(e => e.sc >= 60).reduce((x, e) => x + e.len, 0) / len, sig: es.map(e => e.sid).join(','), min: len / (SPEED_KMH * 1000 / 60) };
}

// 무작위 출발·도착 쌍 (재현 가능하도록 고정 시드)
const C = { lat: 35.1816, lon: 128.5532 }, M_LAT = 110540, M_LON = 111320 * Math.cos(C.lat * Math.PI / 180);
const xy = n => [(g.nodes[n][1] - C.lon) * M_LON, (g.nodes[n][0] - C.lat) * M_LAT];
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pairs = []; while (pairs.length < N) { const a = main[Math.floor(rnd() * main.length)], b = main[Math.floor(rnd() * main.length)]; const [ax, ay] = xy(a), [bx, by] = xy(b); const d = Math.hypot(ax - bx, ay - by); if (d > 400 && d < 1200) pairs.push([a, b]); }

const t0 = Date.now();
let same = 0, n = 0, over = 0; const detour = [], dAvg = [], dHi = [], lens = [], ms = [];
for (const [a, b] of pairs) {
  const t1 = Date.now(); const s = route(a, b, 0), f = route(a, b, ALPHA); ms.push(Date.now() - t1);
  if (!s || !f) continue; n++; if (s.sig === f.sig) same++; const dr = f.len / s.len; detour.push(dr); if (dr > DETOUR_CAP) over++;
  dAvg.push(s.avg - f.avg); dHi.push((s.hi - f.hi) * 100); lens.push(s.len);
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)], mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`\n무작위 ${n}쌍 (직선거리 400~1200m, 본 도로망 안, α=${ALPHA}, 산길 제외, 계단 비용 ×${STEPS_X})`);
console.log(`  최단 경로 평균 ${mean(lens).toFixed(0)}m (약 ${(mean(lens) / (SPEED_KMH * 1000 / 60)).toFixed(0)}분)`);
console.log(`  안전 경로가 최단과 같은 경우: ${(same / n * 100).toFixed(0)}%`);
console.log(`  우회 배율: 중앙값 ${med(detour).toFixed(2)}, 평균 ${mean(detour).toFixed(2)}, 최대 ${Math.max(...detour).toFixed(2)}, ${DETOUR_CAP}배 초과 ${over}쌍`);
console.log(`  평균 점수 개선: ${mean(dAvg).toFixed(1)}점 (최단 ${mean(pairs.map(([a, b]) => route(a, b, 0)).filter(Boolean).map(r => r.avg)).toFixed(1)} → 안전 ${(mean(pairs.map(([a, b]) => route(a, b, 0)).filter(Boolean).map(r => r.avg)) - mean(dAvg)).toFixed(1)})`);
console.log(`  60점 이상 구간 비율 감소: ${mean(dHi).toFixed(1)}%p`);
console.log(`  경로 두 개 계산 시간: 평균 ${mean(ms).toFixed(1)}ms, 최대 ${Math.max(...ms)}ms (이 컴퓨터 Node 기준)`);
