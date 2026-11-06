// route.js 동작 검증. 실행: node scripts/test-route.mjs   (실패가 있으면 종료 코드 1)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Route from '../route.js';

const DATA = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const graph = JSON.parse(fs.readFileSync(path.join(DATA, 'graph.json'), 'utf8'));
const geo = JSON.parse(fs.readFileSync(path.join(DATA, 'risk_segments.geojson'), 'utf8'));
const pts = JSON.parse(fs.readFileSync(path.join(DATA, 'points.json'), 'utf8'));
const segById = new Map(geo.features.map(f => [f.properties.id, f.properties]));
const g = Route.buildGraph(graph, segById);
const ctx = { segById, lights: pts.lights, cctv: pts.cctv };

let fail = 0, total = 0;
const check = (name, cond, detail = '') => { total++; if (!cond) fail++; console.log(`${cond ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`); };
const main = g.group.map((v, i) => i).filter(i => g.group[i] === 0);
const hav = (a, b) => Math.hypot(...[0, 1].map(k => Route.toXY(a[0], a[1])[k] - Route.toXY(b[0], b[1])[k]));
const snapAt = (e, t) => { const A = g.nodes[e.a], B = g.nodes[e.b]; return { status: 'ok', edge: e, t, dist: 0, lat: A[0] + t * (B[0] - A[0]), lon: A[1] + t * (B[1] - A[1]) }; };
const cost = r => r.edges.reduce((s, e) => s + e.len * (e.steps ? 3 : 1), 0);
const snapshot = () => g.adj.length + ':' + g.adj.reduce((s, a) => s + a.length, 0);
const before = snapshot();

// 1. 그래프 구성
const trailIdx = new Set(graph.meta.trailHw.map(h => graph.meta.hw.indexOf(h)));
const trailEdges = graph.edges.filter(e => trailIdx.has(e[4])).length, usedEdges = g.adj.reduce((s, a) => s + a.length, 0) / 2;
check('산길 간선이 경로 그래프에서 제외됨', usedEdges === graph.edges.length - trailEdges, `(전체 ${graph.edges.length} - 산길 ${trailEdges} = ${usedEdges})`);
check('붙이기 대상 간선은 모두 본 도로망(그룹 0) 안', g.edges.every(e => g.group[e.a] === 0 && g.group[e.b] === 0), `(${g.edges.length}개)`);

// 2. 도로 위의 점에 붙이기: 지난번 결함(꼭짓점 방식이면 긴 도로 한가운데에서 실패)이 고쳐졌는지
const long = g.edges.filter(e => e.len > 120);
let midOk = 0; for (const e of long) { const sn = Route.snapToRoad(g, ...Object.values(snapAt(e, 0.5)).slice(4, 6)); if (sn.status === 'ok' && sn.dist < 0.5 && Math.abs(sn.t - 0.5) < 0.02) midOk++; }
check('120m보다 긴 도로의 한가운데를 눌러도 도로 위에 붙음', midOk === long.length, `(${midOk}/${long.length}개 도로)`);
const e0 = long[0], mid0 = snapAt(e0, 0.5), A0 = g.xy[e0.a], B0 = g.xy[e0.b];
const nx = -(B0[1] - A0[1]) / e0.len, ny = (B0[0] - A0[0]) / e0.len, mx = (A0[0] + B0[0]) / 2, my = (A0[1] + B0[1]) / 2;
const off = Route.snapToRoad(g, Route.CAMPUS.lat + (my + ny * 20) / 110540, Route.CAMPUS.lon + (mx + nx * 20) / (111320 * Math.cos(Route.CAMPUS.lat * Math.PI / 180)));
check('도로에서 20m 떨어진 곳을 누르면 ok, 거리는 20m 이하 (더 가까운 다른 도로가 있으면 그쪽에 붙음)', off.status === 'ok' && off.dist <= 20.5, `(status ${off.status}, ${off.dist && off.dist.toFixed(1)}m)`);

// 3. 먼 곳 / 산길로만 이어진 곳
let farPt = null; for (let x = -1500; x <= 1500 && !farPt; x += 100) for (let y = -1500; y <= 1500 && !farPt; y += 100) { const sn = Route.snapToRoad(g, Route.CAMPUS.lat + y / 110540, Route.CAMPUS.lon + x / (111320 * Math.cos(Route.CAMPUS.lat * Math.PI / 180))); if (sn.status === 'far') farPt = sn; }
check('도로에서 먼 곳은 status far', !!farPt && farPt.status === 'far', farPt ? `(본 도로망까지 ${Math.round(farPt.dist)}m, 산길까지 ${Math.round(farPt.isoDist)}m)` : '(대상 못 찾음)');
let isoSnap = null; for (const e of g.isoEdges) { const a = g.nodes[e.a], b = g.nodes[e.b]; const sn = Route.snapToRoad(g, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); if (sn.status === 'isolated') { isoSnap = sn; break; } }
check('산길·끊긴 지역 위를 누르면 status isolated', !!isoSnap, isoSnap ? `(본 도로망까지 ${Math.round(isoSnap.dist)}m, 산길까지 ${isoSnap.isoDist.toFixed(1)}m)` : '(대상 못 찾음)');

// 4. 같은 점 / 붙이기 실패 전달
const s0 = snapAt(g.edges[10], 0.3);
check('같은 지점은 same-point', Route.findRoutes(g, s0, s0).reason === 'same-point');
check('2m 떨어진 두 지점도 same-point', Route.findRoutes(g, snapAt(long[0], 0.50), snapAt(long[0], 0.50 + 2 / long[0].len)).reason === 'same-point');
check('붙이기 실패한 쪽의 이유를 그대로 돌려줌 (far / isolated)', Route.findRoutes(g, s0, farPt).reason === 'far' && Route.findRoutes(g, isoSnap, s0).reason === 'isolated');

// 5. 같은 간선 위의 두 점
const q = Route.findRoutes(g, snapAt(long[1], 0.25), snapAt(long[1], 0.75));
check('같은 도로 위 두 점: 거리 = 두 점 사이 길이, 간선 1개', q.ok && Math.abs(q.shortest.len - 0.5 * long[1].len) < 1e-6 && q.shortest.edges.length === 1 && q.same, `(${q.shortest && q.shortest.len.toFixed(1)}m, 기대 ${(0.5 * long[1].len).toFixed(1)}m)`);

// 6. 서로 다른 간선 위의 점: 임시 노드 방식이 꼭짓점 4가지 조합을 직접 따져 본 최솟값과 같은가 (독립 검증)
let seed = 11; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
let okBrute = 0, okCont = 0, nPair = 0, maxErr = 0;
while (nPair < 40) {
  const e1 = g.edges[Math.floor(rnd() * g.edges.length)], e2 = g.edges[Math.floor(rnd() * g.edges.length)];
  if (e1 === e2) continue; const t1 = 0.1 + 0.8 * rnd(), t2 = 0.1 + 0.8 * rnd(), a = snapAt(e1, t1), b = snapAt(e2, t2);
  const r = Route.findRoutes(g, a, b); nPair++;
  if (!r.ok) { continue; }
  const sc = e => e.len * (e.steps ? 3 : 1);
  let best = Infinity;
  for (const [i, ci] of [[e1.a, t1 * sc(e1)], [e1.b, (1 - t1) * sc(e1)]]) for (const [j, cj] of [[e2.a, t2 * sc(e2)], [e2.b, (1 - t2) * sc(e2)]]) {
    const nr = i === j ? { edges: [] } : Route.shortestPath(g, i, j, 0); if (!nr) continue; best = Math.min(best, ci + cost(nr) + cj);
  }
  maxErr = Math.max(maxErr, Math.abs(cost(r.shortest) - best)); if (Math.abs(cost(r.shortest) - best) < 1e-6) okBrute++;
  const rt = r.safe; if (rt.coords.length === rt.nodes.length && Math.abs(rt.coords[0][0] - a.lat) < 1e-9 && Math.abs(rt.coords.at(-1)[1] - b.lon) < 1e-9 && rt.edges.every((x, i) => x.a === rt.nodes[i] && x.b === rt.nodes[i + 1])) okCont++;
}
check('임시 노드 방식의 최단 경로 = 꼭짓점 조합을 직접 따진 최솟값 (40쌍)', okBrute === 40, `(${okBrute}/40, 최대 오차 ${maxErr.toExponential(1)})`);
check('경로 좌표가 출발점~도착점으로 이어지고 간선이 끊김 없이 연결 (40쌍)', okCont === 40, `(${okCont}/40)`);
check('계산 뒤 그래프가 원래대로 돌아옴 (임시 노드·간선 제거)', snapshot() === before && g.adj.length === g.nodes.length, `(${before})`);

// 7. 노드 번호 방식(시험 스크립트용)과 기존 성질
check('노드 번호 방식: 출발=도착은 same-point', Route.findRoutes(g, main[0], main[0]).reason === 'same-point');
const iso = g.group.map((v, i) => i).filter(i => g.group[i] === 1)[0];
check('노드 번호 방식: 본 도로망과 끊긴 노드 사이는 no-route', Route.findRoutes(g, main[0], iso).reason === 'no-route');
let cost2 = 0, short2 = 0, lenOk = 0, ded = 0, inflate = 0, n = 0;
while (n < 20) {
  const a = main[Math.floor(rnd() * main.length)], b = main[Math.floor(rnd() * main.length)]; if (Math.hypot(g.xy[a][0] - g.xy[b][0], g.xy[a][1] - g.xy[b][1]) < 400) continue; n++;
  const r = Route.findRoutes(g, a, b), s = Route.summarize(r.shortest, ctx);
  const ac = rt => rt.edges.reduce((x, e) => x + e.len * (e.steps ? 3 : 1) * (1 + 2 * e.score / 100), 0);
  if (ac(r.safe) <= ac(r.shortest) + 1e-6) cost2++; if (r.shortest.len <= r.safe.len + 1e-6) short2++;
  if (Math.abs(s.distanceM - r.shortest.edges.reduce((x, e) => x + e.len, 0)) < 1e-6) lenOk++;
  const ids = [...new Set(r.safe.edges.map(e => e.sid))], uni = new Set(ids.flatMap(id => segById.get(id).li)), sm = Route.summarize(r.safe, ctx);
  if (sm.lightPoints === uni.size) ded++; if (ids.reduce((x, id) => x + segById.get(id).li.length, 0) > uni.size) inflate++;
}
check('안전 경로는 안전 비용이 최단 경로보다 작거나 같음 (20쌍)', cost2 === 20, `(${cost2}/20)`);
check('최단 경로는 길이가 안전 경로보다 짧거나 같음 (20쌍)', short2 === 20, `(${short2}/20)`);
check('비교 표의 거리 = 경로 간선 길이 합 (20쌍)', lenOk === 20, `(${lenOk}/20)`);
check('보안등 점 수 = 경로 구간 보안등 번호의 합집합 (20쌍)', ded === 20, `(${ded}/20, 중복을 안 빼면 부풀려지는 경로 ${inflate}/20)`);
const rr = Route.findRoutes(g, main[10], main[900]).safe, ss = Route.summarize(rr, ctx);
check('예상 시간 = 거리 ÷ (4km/h)', Math.abs(ss.minutes - ss.distanceM / (4000 / 60)) < 1e-9, `(${ss.distanceM.toFixed(0)}m → ${ss.minutes.toFixed(1)}분)`);
check('모든 시험이 끝난 뒤에도 그래프가 원래대로', snapshot() === before);

console.log(`\n=== 테스트 ${total}개 중 실패 ${fail}개 ===`);
process.exitCode = fail ? 1 : 0;
