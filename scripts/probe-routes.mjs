// 경로 탐색 시험(벤치마크): data/graph.json + data/risk_segments.geojson 으로 "최단 경로"와 "안전 경로"를 비교한다.
// 화면과 같은 계산 코드(route.js)를 쓰므로, 이 결과와 화면의 결과가 같아야 한다.
// 실행: node scripts/probe-routes.mjs [쌍 개수=250] [α=2]
//
// 경로 비용: 최단 = 길이, 안전 = 길이 × (1 + α × 점수/100). 산길(path/track) 제외, 계단 비용 ×3, 걷는 속도 4km/h (route.js 참고)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Route from '../route.js';

const DATA = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const graph = JSON.parse(fs.readFileSync(path.join(DATA, 'graph.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(DATA, 'risk_segments.geojson'), 'utf8'));
const pts = JSON.parse(fs.readFileSync(path.join(DATA, 'points.json'), 'utf8'));
const N = Number(process.argv[2]) || 250;
const ALPHA = Number(process.argv[3]) || Route.DEFAULTS.alpha;
const { detourCap: DETOUR_CAP, speedKmh: SPEED_KMH, stepsFactor: STEPS_X } = Route.DEFAULTS;

// 구간 id → 속성. 요소값으로 다시 계산한 점수가 저장된 점수와 같은지도 확인한다.
const W = pts.meta.weights;
const scoreFromR = r => { let s = 0, w = 0; for (const k of Object.keys(W)) if (W[k] > 0 && r[k] != null) { s += W[k] * r[k]; w += W[k]; } return (s / w) * 100; };
const segById = new Map(); let maxDiff = 0;
for (const f of geo.features) { const p = f.properties; segById.set(p.id, p); maxDiff = Math.max(maxDiff, Math.abs(scoreFromR(p.r) - p.score)); }
console.log(`구간 ${segById.size}개, 요소값으로 다시 계산한 점수와 저장된 점수의 최대 차이 ${maxDiff.toFixed(2)}점`);

const g = Route.buildGraph(graph, segById, { alpha: ALPHA });
const main = g.group.map((v, i) => i).filter(i => g.group[i] === 0); // 본 도로망 노드만 출발·도착으로 허용
console.log(`그래프: 노드 ${g.nodes.length}, 간선 ${graph.edges.length}, 경로 탐색 가능 본 도로망 노드 ${main.length}`);

// 무작위 출발·도착 쌍 (재현 가능하도록 고정 시드)
let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const pairs = []; while (pairs.length < N) { const a = main[Math.floor(rnd() * main.length)], b = main[Math.floor(rnd() * main.length)]; const d = Math.hypot(g.xy[a][0] - g.xy[b][0], g.xy[a][1] - g.xy[b][1]); if (d > 400 && d < 1200) pairs.push([a, b]); }

const stat = r => ({ len: r.len, avg: r.edges.reduce((x, e) => x + e.len * e.score, 0) / r.len, hi: r.edges.filter(e => e.score >= 60).reduce((x, e) => x + e.len, 0) / r.len });
let same = 0, n = 0, over = 0; const detour = [], dAvg = [], dHi = [], lens = [], ms = [], sAvg = [];
for (const [a, b] of pairs) {
  const t1 = Date.now(); const r = Route.findRoutes(g, a, b, { alpha: ALPHA }); ms.push(Date.now() - t1);
  if (!r.ok) continue; n++; if (r.same) same++; detour.push(r.detour); if (r.detour > DETOUR_CAP) over++;
  const s = stat(r.shortest), f = stat(r.safe); dAvg.push(s.avg - f.avg); dHi.push((s.hi - f.hi) * 100); lens.push(s.len); sAvg.push(s.avg);
}
const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)], mean = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`\n무작위 ${n}쌍 (직선거리 400~1200m, 본 도로망 안, α=${ALPHA}, 산길 제외, 계단 비용 ×${STEPS_X})`);
console.log(`  최단 경로 평균 ${mean(lens).toFixed(0)}m (약 ${(mean(lens) / (SPEED_KMH * 1000 / 60)).toFixed(0)}분)`);
console.log(`  안전 경로가 최단과 같은 경우: ${(same / n * 100).toFixed(0)}%`);
console.log(`  우회 배율: 중앙값 ${med(detour).toFixed(2)}, 평균 ${mean(detour).toFixed(2)}, 최대 ${Math.max(...detour).toFixed(2)}, ${DETOUR_CAP}배 초과 ${over}쌍`);
console.log(`  평균 점수 개선: ${mean(dAvg).toFixed(1)}점 (최단 ${mean(sAvg).toFixed(1)} → 안전 ${(mean(sAvg) - mean(dAvg)).toFixed(1)})`);
console.log(`  60점 이상 구간 비율 감소: ${mean(dHi).toFixed(1)}%p`);
console.log(`  경로 두 개 계산 시간: 평균 ${mean(ms).toFixed(1)}ms, 최대 ${Math.max(...ms)}ms (이 컴퓨터 Node 기준)`);
