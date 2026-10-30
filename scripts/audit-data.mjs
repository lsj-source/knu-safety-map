// 데이터 점검: 원본 점 데이터, OSM 도로, 점-도로 연결, 경로용 도로망(graph.json)이 서로 맞는지 계산 결과 파일만 읽어서 확인한다.
// 실행: node scripts/audit-data.mjs   (build-risk.mjs를 돌린 뒤)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'data');
const rd = f => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const geo = rd('risk_segments.geojson'), pts = rd('points.json'), graph = rd('graph.json'), osm = rd('osm_roads_knu.json');
const C = pts.campus, M_LAT = 110540, M_LON = 111320 * Math.cos(C.lat * Math.PI / 180);
const xy = (lat, lon) => [(lon - C.lon) * M_LON, (lat - C.lat) * M_LAT];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const ptSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0; return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)); };
const ptLine = (p, l) => { let m = Infinity; for (let i = 1; i < l.length; i++) m = Math.min(m, ptSeg(p, l[i - 1], l[i])); return m; };
const HALF = pts.meta.areaHalfM, { lightBufM: LB, cctvBufM: CB } = pts.meta.params;
let problems = 0; const bad = (m) => { problems++; console.log('  ✗ ' + m); }; const ok = m => console.log('  ✓ ' + m);
const sect = t => console.log('\n■ ' + t);

function parseCsv(t) { const rows = []; let row = [], cur = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; } else cur += c; } if (cur || row.length) { row.push(cur); rows.push(row); } const h = rows[0]; return rows.slice(1).filter(r => r.length > 3).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); }
const loadCsv = f => { const b = fs.readFileSync(path.join(DATA, f)); let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { t = new TextDecoder('euc-kr').decode(b); } return parseCsv(t.replace(/^﻿/, '')); };

// ---------- 1. 원본 보안등·CCTV 데이터 ----------
sect('1. 원본 점 데이터');
const lightsRaw = loadCsv('streetlight_changwon.csv'), cctvRaw = loadCsv('cctv_changwon.csv');
const inChangwon = (la, lo) => la > 34.9 && la < 35.5 && lo > 128.3 && lo < 129.0;
const badCoord = lightsRaw.filter(o => !inChangwon(+o['위도'], +o['경도']));
badCoord.length ? bad(`보안등 ${lightsRaw.length}행 중 좌표가 창원 범위 밖/비어 있는 행 ${badCoord.length}`) : ok(`보안등 ${lightsRaw.length}행 모두 좌표가 창원 범위 안`);
const badC2 = cctvRaw.filter(o => !inChangwon(+o['WGS84위도'], +o['WGS84경도']));
badC2.length ? bad(`CCTV ${cctvRaw.length}행 중 좌표가 창원 범위 밖/비어 있는 행 ${badC2.length}`) : ok(`CCTV ${cctvRaw.length}행 모두 좌표가 창원 범위 안`);
// 보안등: 주소의 동과 좌표 위치가 맞는지 (같은 동 점들의 중앙 위치에서 너무 멀면 의심)
const dongOf = a => { const m = a.match(/(마산합포구|마산회원구|의창구|성산구|진해구)\s*(\S+)/); return m ? m[1] + ' ' + m[2] : '?'; }; // 같은 동 이름이 구마다 있어서(예: 신월동) 구까지 붙여 구분
const byDong = new Map(); lightsRaw.forEach(o => { const d = dongOf(o['소재지지번주소']); const p = xy(+o['위도'], +o['경도']); (byDong.get(d) || byDong.set(d, []).get(d)).push(p); });
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const dongCenter = new Map(); byDong.forEach((ps, d) => dongCenter.set(d, [med(ps.map(p => p[0])), med(ps.map(p => p[1])), med(ps.map(p => dist(p, [med(ps.map(q => q[0])), med(ps.map(q => q[1]))])))]));
let dongOut = 0; const dongEx = [];
const used6 = new Set(pts.lights.map(P => P[0].toFixed(6) + ',' + P[1].toFixed(6))); // 실제로 점수에 쓰이는 보안등만 검사 (좌표가 어긋난 보안등은 빌드에서 이미 제외됨)
for (const o of lightsRaw) { const p = xy(+o['위도'], +o['경도']); if (Math.hypot(p[0], p[1]) > 2300) continue; if (!used6.has((+o['위도']).toFixed(6) + ',' + (+o['경도']).toFixed(6))) continue; const d = dongOf(o['소재지지번주소']); const [cx, cy, med] = dongCenter.get(d); const dd = dist(p, [cx, cy]); if (dd > Math.max(3000, med * 4)) { dongOut++; if (dongEx.length < 5) dongEx.push(`${o['보안등위치명']} (${o['소재지지번주소']}) 동 중심에서 ${(dd / 1000).toFixed(1)}km`); } }
dongOut ? (bad(`학교 2.3km 안 보안등 중 주소의 동과 위치가 크게 어긋난 것 ${dongOut}개`), dongEx.forEach(e => console.log('      ' + e))) : ok('학교 2.3km 안 보안등의 주소(동)와 좌표 위치가 서로 맞음');
// 좌표 중복
const dupKey = new Map(); let dupExtra = 0; lightsRaw.forEach(o => { const k = o['위도'] + ',' + o['경도']; dupKey.set(k, (dupKey.get(k) || 0) + 1); }); dupKey.forEach(v => { if (v > 1) dupExtra += v - 1; });
console.log(`  · 참고: 보안등 좌표가 같은 중복 행 ${dupExtra}개 (빌드가 합산해서 설치개수로 처리)`);

// CCTV: 도로명주소의 도로 이름과 가장 가까운 OSM 도로 이름이 같은지 (좌표가 맞는지 간접 확인)
sect('2. CCTV 좌표 ↔ 도로명주소 (좌표가 맞는지 간접 확인)');
// 도로명주소에서 "도로 이름 + 건물번호" 형태의 이름을 뽑는다 (예: "월영남18길 68" → "월영남18길", "3·15대로 12" → "3·15대로")
const roadNameOf = a => { const m = a.replace(/([가-힣])\s+(\d+(?:대로|로|길))/g, '$1$2').match(/([가-힣0-9·.]+(?:대로|로|길))\s+\d/); return m ? m[1].replace(/\./g, '·') : null; }; // "월영남 14길"처럼 띄어 쓴 이름도 붙여서 읽음
const sameNameDist = new Map(); // 도로 이름 → 그 이름의 OSM 도로선들 (불일치한 CCTV가 같은 이름 도로에서 얼마나 떨어졌는지 보기 위함)
for (const w of osm.elements.filter(e => e.type === 'way' && e.geometry && e.tags.name)) { const k = w.tags.name.replace(/\./g, '·'); (sameNameDist.get(k) || sameNameDist.set(k, []).get(k)).push(w.geometry.map(g => xy(g.lat, g.lon))); }
const nameLines = []; for (const f of geo.features) if (f.properties.name) nameLines.push({ name: f.properties.name.replace(/\./g, '·'), line: f.geometry.coordinates.map(([lo, la]) => xy(la, lo)) });
let checked = 0, matchNear = 0, cannot = 0; const mism = [];
for (const o of cctvRaw) {
  const p = xy(+o['WGS84위도'], +o['WGS84경도']); if (Math.hypot(p[0], p[1]) > HALF) continue;
  const name = roadNameOf(o['소재지도로명주소'] || ''); if (!name) continue; // 지번 주소만 있는 경우는 도로 이름을 알 수 없음
  const nearNames = new Set(nameLines.filter(n => ptLine(p, n.line) <= 60).map(n => n.name));
  if (!nearNames.size) { cannot++; continue; } // 60m 안에 이름 있는 OSM 도로가 없어서 확인 불가
  checked++;
  if (nearNames.has(name)) matchNear++;
  else { // 같은 이름의 OSM 도로가 어디에 있는지 확인: 가까우면 좌표 오차 범위, 멀면 좌표나 도로 이름을 의심
    const lines = sameNameDist.get(name); const d = lines ? Math.min(...lines.map(l => ptLine(p, l))) : null;
    mism.push({ d, text: `${o['소재지도로명주소']} → 60m 안 도로: ${[...nearNames].slice(0, 3).join(', ')} | ${name}까지 ${d == null ? 'OSM에 같은 이름 도로 없음' : d.toFixed(0) + 'm'}` });
  }
}
const near100 = mism.filter(m => m.d != null && m.d <= 100).length, far100 = mism.filter(m => m.d != null && m.d > 100).length, none = mism.filter(m => m.d == null).length;
console.log(`  · 도로명주소로 확인 가능한 CCTV ${checked}개 중 60m 안에 같은 이름의 도로가 있는 것 ${matchNear}개 (${(matchNear / checked * 100).toFixed(0)}%) · 확인 불가(주변 OSM 도로에 이름 없음) ${cannot}개`);
console.log(`  · 일치하지 않은 ${mism.length}개: 같은 이름 도로가 100m 이내 ${near100}개(좌표 오차 범위), 100m 넘게 멂 ${far100}개(좌표 또는 도로 이름 의심), OSM에 같은 이름 도로 없음 ${none}개`);
(far100 > 0 ? bad : ok)(`같은 이름 도로에서 100m 넘게 떨어진 CCTV ${far100}개`);
mism.filter(m => m.d == null || m.d > 100).slice(0, 8).forEach(m => console.log('      확인 필요: ' + m.text));

// ---------- 2. OSM 도로 데이터 ----------
sect('3. OSM 도로 데이터');
const ways = osm.elements.filter(e => e.type === 'way' && e.geometry);
const tagCount = k => { const m = {}; ways.forEach(w => { const v = w.tags[k]; if (v) m[v] = (m[v] || 0) + 1; }); return m; };
console.log('  · foot 태그:', JSON.stringify(tagCount('foot')), '| access 태그:', JSON.stringify(tagCount('access')), '| service 종류:', JSON.stringify(tagCount('service')));
console.log('  · footway 종류:', JSON.stringify(tagCount('footway')), '| bridge:', JSON.stringify(tagCount('bridge')), '| tunnel:', JSON.stringify(tagCount('tunnel')));
const noName = geo.features.filter(f => !f.properties.name).length;
console.log(`  · 이름 없는 구간 ${noName}/${geo.features.length} (${(noName / geo.features.length * 100).toFixed(0)}%)`);
const notWalk = ways.filter(w => ['use_sidepath', 'discouraged'].includes(w.tags.foot));
notWalk.length ? bad(`보행자가 이용하지 않는 것으로 표시된 도로(foot=use_sidepath/discouraged) ${notWalk.length}개가 포함되어 있음`) : ok('foot=use_sidepath/discouraged 도로 없음');

// ---------- 3. 구간-점 연결 ----------
sect('4. 점 ↔ 구간 연결');
const segs = geo.features.map(f => ({ p: f.properties, line: f.geometry.coordinates.map(([lo, la]) => xy(la, lo)) }));
let idxBad = 0, farBad = 0, cntBad = 0, usedBad = 0;
for (const s of segs) {
  let sl = 0, sc = 0;
  for (const i of s.p.li) { const P = pts.lights[i]; if (!P) { idxBad++; continue; } sl += P[2]; if (ptLine(xy(P[0], P[1]), s.line) > LB + 0.5) farBad++; }
  for (const i of s.p.ci) { const P = pts.cctv[i]; if (!P) { idxBad++; continue; } sc += P[3]; if (!P[5]) usedBad++; if (ptLine(xy(P[0], P[1]), s.line) > CB + 0.5) farBad++; }
  if (sl !== s.p.lights || sc !== s.p.cctv) cntBad++;
}
(idxBad ? bad : ok)(`연결된 점 번호가 실제로 존재함 (오류 ${idxBad})`);
(farBad ? bad : ok)(`연결된 모든 점이 집계 거리(보안등 ${LB}m, CCTV ${CB}m) 안에 있음 (초과 ${farBad})`);
(cntBad ? bad : ok)(`패널에 표시되는 개수와 연결된 점의 합계가 일치함 (불일치 구간 ${cntBad})`);
(usedBad ? bad : ok)(`점수에 반영하지 않는 목적의 CCTV가 섞이지 않음 (섞임 ${usedBad})`);
// "가장 가까운 도로"에 연결됐는지: 이름 같은 구간 + 이어진 무명 구간을 한 도로로 묶어 확인
// 독립 검증: OSM 원본 도로선 "전체"(사각형 밖 포함)로 점마다 가장 가까운 도로를 다시 구해서, 구간에 연결된 점이 그 도로(5m 오차)에 속하는지 확인.
// 도로의 기준은 계산과 같다: 이름이 있으면 "이름|등급"(상·하행으로 나뉜 같은 이름의 도로는 한 도로), 이름이 없으면 도로선 하나.
const clsOf = w => w.tags.footway === 'crossing' ? 'crossing' : w.tags.highway;
const WALK = new Set(graph.meta.hw);
const rawWays = ways.filter(w => WALK.has(clsOf(w)) && w.tags.foot !== 'no' && w.tags.access !== 'private');
const keyOfWay = w => w.tags.name ? `${w.tags.name}|${clsOf(w)}` : `way${w.id}`;
const rawLines = rawWays.map(w => ({ key: keyOfWay(w), line: w.geometry.map(g => xy(g.lat, g.lon)) }));
const k6 = (lat, lon) => Math.round(lat * 1e6) + ',' + Math.round(lon * 1e6); // 구간 파일이 좌표를 소수 6자리로 반올림해 저장하므로 같은 방식으로 비교
const vtx = new Map(); rawWays.forEach(w => w.geometry.forEach(g => { const k = k6(g.lat, g.lon); (vtx.get(k) || vtx.set(k, new Set()).get(k)).add(w); }));
segs.forEach((s, i) => { // 구간 → 도로 key
  if (s.p.name) { s.keys = [`${s.p.name}|${s.p.hw}`]; return; }
  // 이름 없는 구간: 구간의 첫·끝 꼭짓점을 모두 가진 도로선 중 "도로 등급이 같은 것"을 찾는다 (교차로에서 다른 등급의 도로선이 같은 꼭짓점을 가질 수 있음)
  const c = geo.features[i].geometry.coordinates; const a = vtx.get(k6(c[0][1], c[0][0])), b = vtx.get(k6(c[c.length - 1][1], c[c.length - 1][0]));
  const both = a && b ? [...a].filter(x => b.has(x)) : [];
  const same = both.filter(x => clsOf(x) === s.p.hw);
  s.keys = (same.length ? same : both).map(keyOfWay);
});
const noKey = segs.filter(s => !s.keys.length).length; (noKey ? bad : ok)(`모든 구간의 도로(OSM 도로선)를 원본에서 찾을 수 있음 (못 찾은 구간 ${noKey})`);
const perKey = P => { const q = xy(P[0], P[1]); const m = new Map(); for (const r of rawLines) { const d = ptLine(q, r.line); if (d < (m.get(r.key) ?? Infinity)) m.set(r.key, d); } return m; };
const TOL = 0.7; // 좌표 반올림(약 0.1m)과 거리 계산 차이를 흡수
const checkLinks = (kind, ids, arr, buf) => {
  const wrong = []; let pairs = 0;
  for (const s of segs) for (const i of s.p[ids]) { pairs++; const m = perKey(arr[i]); const d0 = Math.min(...m.values()); const mine = Math.min(...s.keys.map(k => m.get(k) ?? Infinity)); if (!(mine <= d0 + 5 + TOL) || mine > buf + TOL) wrong.push({ i, s, mine, d0 }); }
  (wrong.length ? bad : ok)(`${kind} 연결 ${pairs}건이 모두 "가장 가까운 도로(5m 오차 이내)"에 속함 (어긋난 건 ${wrong.length})`);
  wrong.slice(0, 5).forEach(w => console.log(`      ${kind}#${w.i}: 구간#${w.s.p.id} ${w.s.keys.join('/')} ${Number.isFinite(w.mine) ? w.mine.toFixed(1) + 'm' : '(거리 없음)'}, 가장 가까운 도로는 ${w.d0.toFixed(1)}m`));
};
checkLinks('보안등', 'li', pts.lights, LB); checkLinks('CCTV', 'ci', pts.cctv, CB);
// 점이 어떤 구간에도 연결되지 않은 경우: 도로가 없는 곳의 점 (사각형 안쪽 점만 대상)
const linkedL = new Set(segs.flatMap(s => s.p.li)), linkedC = new Set(segs.flatMap(s => s.p.ci));
const orphan = (arr, linked, buf, cond) => arr.map((P, i) => ({ P, i })).filter(o => cond(o.P) && !linked.has(o.i) && Math.abs(xy(o.P[0], o.P[1])[0]) <= HALF - 100 && Math.abs(xy(o.P[0], o.P[1])[1]) <= HALF - 100);
const oL = orphan(pts.lights, linkedL, LB, () => true), oC = orphan(pts.cctv, linkedC, CB, P => P[5]);
console.log(`  · 사각형 안쪽(경계 100m 제외)에서 어떤 구간에도 연결되지 않은 점: 보안등 ${oL.length}/${pts.lights.length}, CCTV(반영 대상) ${oC.length}/${pts.cctv.filter(P => P[5]).length}`);
const nearestRoad = P => Math.min(...segs.map(s => ptLine(xy(P[0], P[1]), s.line)));
const far = oL.map(o => nearestRoad(o.P)); console.log(`    - 보안등: 가장 가까운 도로까지 ${LB}m 초과 ${far.filter(d => d > LB).length}개 (중앙값 ${med(far.length ? far : [0]).toFixed(0)}m, 최대 ${Math.max(0, ...far).toFixed(0)}m) → 나머지는 거리 안에 도로가 있는데 다른 도로로 배정된 경우`);
// 반영 안 된 점 중, 가장 가까운 도로(5m 오차)의 구간이 집계 거리 안(경계 1m 여유)에 있는데도 빠진 것이 있으면 오류
const missed = oL.filter(o => { const m = perKey(o.P); const d0 = Math.min(...m.values()); const q = xy(o.P[0], o.P[1]); return segs.some(s => s.keys.some(k => (m.get(k) ?? Infinity) <= d0 + 5) && ptLine(q, s.line) <= LB - 1); });
(missed.length ? bad : ok)(`도로 ${LB}m 안(1m 여유)에 있는데 어떤 구간에도 반영되지 않은 보안등 ${missed.length}개`);
missed.slice(0, 5).forEach(o => console.log(`      보안등#${o.i} (${o.P[0]}, ${o.P[1]})`));

// ---------- 4. 경로용 도로망 ----------
sect('5. graph.json ↔ 구간');
const segById = new Map(geo.features.map(f => [f.properties.id, f]));
let badSid = 0, zero = 0; const lenBySeg = new Map(); const seen = new Set(); let dupE = 0;
for (const [a, b, len, sid] of graph.edges) { if (!segById.has(sid)) badSid++; if (len <= 0 || a === b) zero++; lenBySeg.set(sid, (lenBySeg.get(sid) || 0) + len); const k = Math.min(a, b) + '-' + Math.max(a, b); if (seen.has(k)) dupE++; seen.add(k); }
(badSid ? bad : ok)(`간선이 가리키는 구간 id가 모두 존재함 (없는 id ${badSid})`);
(zero ? bad : ok)(`길이 0이거나 같은 노드를 잇는 간선 없음 (${zero})`);
console.log(`  · 같은 두 노드를 잇는 중복 간선 ${dupE}개 (OSM에서 도로가 겹쳐 그려진 곳)`);
let noEdge = 0, lenBad = 0; for (const f of geo.features) { const s = lenBySeg.get(f.properties.id); if (s === undefined) noEdge++; else if (Math.abs(s - f.properties.len) > 3) lenBad++; }
(noEdge ? bad : ok)(`모든 구간에 간선이 있음 (간선 없는 구간 ${noEdge})`);
(lenBad ? bad : ok)(`구간 길이와 간선 길이 합이 일치함 (3m 넘게 다른 구간 ${lenBad})`);
let nodeOut = 0; graph.nodes.forEach(([la, lo]) => { const p = xy(la, lo); if (Math.abs(p[0]) > HALF + 400 || Math.abs(p[1]) > HALF + 400) nodeOut++; });
(nodeOut ? bad : ok)(`모든 노드가 점수 범위(+400m) 안에 있음 (밖 ${nodeOut})`);

console.log(`\n=== 점검 결과: 문제 ${problems}건 ===`);
process.exitCode = problems ? 1 : 0;
