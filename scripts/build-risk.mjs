// 경남대 주변 보행 구간별 "야간 주의" 점수 계산 (프로토타입)
// 입력: data/streetlight_changwon.csv, data/cctv_changwon.csv, data/accident_hotspots_knu_2.4km.csv, OSM 도로망(Overpass)
// 출력: data/risk_segments.geojson, data/points.json, data/graph.json (경로 탐색용 도로망)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

// ---------- 설정 ----------
const CAMPUS = { name: '경남대학교', lat: 35.1816, lon: 128.5532 };
// 점수를 계산하는 범위: 학교를 중심으로 한 변이 2*AREA_HALF 인 정사각형 (OSM 조회 범위와 같음).
// 반경(원)으로 자르면 경로가 끊기므로 사각형 전체를 쓴다. 모서리는 학교에서 AREA_HALF*√2 ≈ 2.12km 떨어져 있다.
const AREA_HALF = 1500;
const DATA_R = 2300;       // 점 데이터를 읽는 반경(m): 모서리(2.12km) + CCTV 집계 거리(100m) + 여유
const SEG_LEN = 50;        // 구간 길이(m)
const LIGHT_BUF = 40;      // 보안등 집계 거리(m)
const CCTV_BUF = 100;      // CCTV 집계 거리(m)
const CCTV_PURPOSES = new Set(['생활방범', '어린이보호']); // 야간 보행 안전과 관련된 목적만
const ACC_NEAR = 100, ACC_FAR = 250;

// 항목별 가중치 (slope는 추가 예정: 0이면 점수에서 제외)
const WEIGHTS = { light: 0.35, cctv: 0.20, accident: 0.25, road: 0.20, slope: 0 };

// 도로 등급별 주의도(0~1). 보도 정보가 OSM에 없어 도로 등급을 대리 지표로 사용하는 임의 설정값
const ROAD_RISK = {
  trunk: 0.8, trunk_link: 0.7, primary: 0.8, primary_link: 0.7, secondary: 0.7, secondary_link: 0.6,
  tertiary: 0.55, tertiary_link: 0.5, busway: 0.8, unclassified: 0.45, residential: 0.4, service: 0.35,
  living_street: 0.25, pedestrian: 0.15, footway: 0.2, path: 0.5, track: 0.6, steps: 0.7,
};

// ---------- 유틸 ----------
const M_LAT = 110540, M_LON = 111320 * Math.cos(CAMPUS.lat * Math.PI / 180);
const toXY = (lat, lon) => [(lon - CAMPUS.lon) * M_LON, (lat - CAMPUS.lat) * M_LAT];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function ptSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
const ptLine = (p, line) => { let m = Infinity; for (let i = 1; i < line.length; i++) m = Math.min(m, ptSeg(p, line[i - 1], line[i])); return m; };

function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const h = rows[0];
  return rows.slice(1).filter(r => r.length > 3).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}
function loadCsv(file) {
  const buf = fs.readFileSync(path.join(DATA, file));
  let t; try { t = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { t = new TextDecoder('euc-kr').decode(buf); }
  return parseCsv(t.replace(/^﻿/, ''));
}
const num = v => (v === '' || v == null ? NaN : Number(v));

// ---------- 점 데이터 ----------
const lightsRaw = loadCsv('streetlight_changwon.csv');
const cctvRaw = loadCsv('cctv_changwon.csv');
const accRaw = loadCsv('accident_hotspots_knu_2.4km.csv'); // 창원시 사고다발지 140건 중 학교 2.4km 이내 9건

const near = (lat, lon) => { const xy = toXY(lat, lon); return dist(xy, [0, 0]) <= DATA_R ? xy : null; };

// 주소의 동과 좌표 위치가 크게 어긋난 보안등은 좌표(또는 주소) 오류로 보고 제외한다.
// 같은 구·동 보안등들의 중앙 위치에서 max(3km, 그 동 점들의 중앙 반경×4)보다 멀면 의심. (동 이름은 구마다 겹치므로 구까지 붙여 구분)
const dongOf = a => { const m = (a || '').match(/(마산합포구|마산회원구|의창구|성산구|진해구)\s*(\S+)/); return m ? m[1] + ' ' + m[2] : null; };
const medOf = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const dongPts = new Map();
for (const o of lightsRaw) { const d = dongOf(o['소재지지번주소']), lat = num(o['위도']), lon = num(o['경도']); if (d && lat > 30 && lon > 120) (dongPts.get(d) || dongPts.set(d, []).get(d)).push(toXY(lat, lon)); }
const dongInfo = new Map();
dongPts.forEach((ps, d) => { const cx = medOf(ps.map(p => p[0])), cy = medOf(ps.map(p => p[1])); dongInfo.set(d, { cx, cy, r: medOf(ps.map(p => dist(p, [cx, cy]))) }); });
const suspectLight = o => { const info = dongInfo.get(dongOf(o['소재지지번주소'])); return !!info && dist(toXY(num(o['위도']), num(o['경도'])), [info.cx, info.cy]) > Math.max(3000, info.r * 4); };
const excludedLights = [];

const lights = []; // {xy, lat, lon, n, kind}
{
  const byKey = new Map();
  for (const o of lightsRaw) {
    const lat = num(o['위도']), lon = num(o['경도']); if (!(lat > 30 && lon > 120)) continue;
    const xy = near(lat, lon); if (!xy) continue;
    if (suspectLight(o)) { excludedLights.push(`${o['보안등위치명']} (${o['소재지지번주소']})`); continue; }
    const key = lat + ',' + lon; const n = num(o['설치개수']) || 1;
    if (byKey.has(key)) byKey.get(key).n += n;
    else byKey.set(key, { xy, lat, lon, n, kind: o['설치형태'] || '' });
  }
  lights.push(...byKey.values());
}
const cctvs = [];
for (const o of cctvRaw) {
  const lat = num(o['WGS84위도']), lon = num(o['WGS84경도']); if (!(lat > 30 && lon > 120)) continue;
  const xy = near(lat, lon); if (!xy) continue;
  cctvs.push({ xy, lat, lon, purpose: o['설치목적구분'], n: num(o['카메라대수']) || 1, ym: o['설치연월'] || '', used: CCTV_PURPOSES.has(o['설치목적구분']) });
}
const accidents = accRaw.map(o => ({
  lat: num(o['위도']), lon: num(o['경도']), type: o['사고유형구분'], year: o['사고연도'], name: o['사고지역위치명'].replace('경상남도 창원시 ', ''),
  count: num(o['사고건수']), casualties: num(o['사상자수']), dead: num(o['사망자수']), serious: num(o['중상자수']),
})).map(a => ({ ...a, xy: toXY(a.lat, a.lon) }));

// ---------- OSM 도로망 ----------
async function loadRoads() {
  const cache = path.join(DATA, 'osm_roads_knu.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const dLat = AREA_HALF / M_LAT, dLon = AREA_HALF / M_LON;
  const bbox = [CAMPUS.lat - dLat, CAMPUS.lon - dLon, CAMPUS.lat + dLat, CAMPUS.lon + dLon].map(v => v.toFixed(5)).join(',');
  const q = `[out:json][timeout:60];way["highway"](${bbox});out tags geom;`;
  console.log('Overpass 조회:', bbox);
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': 'knu-safety-route-school-project/0.1 (student project)', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q),
  });
  if (!res.ok) throw new Error('Overpass ' + res.status);
  const j = await res.json();
  fs.writeFileSync(cache, JSON.stringify(j));
  return j;
}
const osm = await loadRoads();
const walkable = w => w.type === 'way' && w.geometry && !['motorway', 'motorway_link'].includes(w.tags.highway) &&
  w.tags.foot !== 'no' && w.tags.access !== 'private' && w.tags.highway in ROAD_RISK;

function chunk(coords) {
  const segs = []; let cur = [coords[0]], len = 0;
  for (let i = 1; i < coords.length; i++) {
    cur.push(coords[i]); len += dist(coords[i - 1].xy, coords[i].xy);
    if (len >= SEG_LEN && i < coords.length - 1) { segs.push({ pts: cur, len }); cur = [coords[i]]; len = 0; }
  }
  if (cur.length > 1) {
    if (len < SEG_LEN / 2 && segs.length) { const l = segs[segs.length - 1]; l.pts.push(...cur.slice(1)); l.len += len; }
    else segs.push({ pts: cur, len });
  }
  return segs;
}

// ---------- 도로 구간 만들기 ----------
const chunks = [];
for (const w of osm.elements.filter(walkable)) {
  const coords = w.geometry.map(g => ({ lat: g.lat, lon: g.lon, xy: toXY(g.lat, g.lon) }));
  const cls = w.tags.footway === 'crossing' ? 'crossing' : w.tags.highway;
  // 같은 이름·같은 등급의 도로선(상·하행으로 나뉜 도로 등)은 같은 도로로 본다. 이름이 없으면 도로선(way) 하나가 한 도로.
  const key = w.tags.name ? `${w.tags.name}|${cls}` : `way${w.id}`;
  for (const s of chunk(coords)) chunks.push({ wayId: w.id, key, name: w.tags.name || '', cls, len: s.len, pts: s.pts, line: s.pts.map(p => p.xy) });
}

// 점 목록(출력에 쓰는 것과 같은 순서). 구간이 "어떤 점을 반영했는지"를 이 순번으로 기록한다.
const lightsOut = lights; // 이미 DATA_R(점수 범위 모서리 + 집계 거리) 안의 점만 읽었음
const cctvOut = cctvs;
const inArea = xy => Math.abs(xy[0]) <= AREA_HALF && Math.abs(xy[1]) <= AREA_HALF; // 점수 범위(정사각형) 안인지

// 점을 "가장 가까운 도로 하나"에만 배정한다.
// 예전에는 구간에서 일정 거리 안의 점을 모두 셌기 때문에, 골목이 촘촘한 곳에서 옆 도로의 보안등·CCTV까지 같이 잡혔다.
// 거의 같은 거리(TIE_M 이내)인 도로는 함께 배정한다(교차로 등).
const TIE_M = 5;
function assignToWays(points, buf) {
  return points.map(p => {
    const byRoad = new Map();
    for (const c of chunks) {
      const d = ptLine(p.xy, c.line);
      if (d <= buf && d < (byRoad.get(c.key) ?? Infinity)) byRoad.set(c.key, d);
    }
    if (!byRoad.size) return new Set();
    const d0 = Math.min(...byRoad.values());
    return new Set([...byRoad].filter(([, d]) => d <= d0 + TIE_M).map(([k]) => k));
  });
}
const lightWays = assignToWays(lightsOut, LIGHT_BUF);
const cctvWays = assignToWays(cctvOut, CCTV_BUF);
const stat = { oldLightPairs: 0, newLightPairs: 0, oldCctvPairs: 0, newCctvPairs: 0 };

// ---------- 점수 ----------
const STEP = [1, 0.6, 0.3, 0];
const features = [];
let id = 0;
for (const c of chunks) {
  {
    const line = c.line, s = c, cls = c.cls, w = { tags: { name: c.name } };
    const mid = line[Math.floor(line.length / 2)];
    if (!inArea(mid)) continue;

    // 이 구간에 반영되는 점: 거리 안에 있고, 이 구간이 속한 도로에 배정된 점만
    const li = [], ci = [];
    lightsOut.forEach((l, i) => {
      if (ptLine(l.xy, line) > LIGHT_BUF) return;
      stat.oldLightPairs++;
      if (lightWays[i].has(c.key)) { li.push(i); stat.newLightPairs++; }
    });
    cctvOut.forEach((cv, i) => {
      if (!cv.used || ptLine(cv.xy, line) > CCTV_BUF) return;
      stat.oldCctvPairs++;
      if (cctvWays[i].has(c.key)) { ci.push(i); stat.newCctvPairs++; }
    });
    const nLights = li.reduce((a, i) => a + lightsOut[i].n, 0);
    const nCctv = ci.reduce((a, i) => a + cctvOut[i].n, 0);
    let accD = Infinity, accName = null;
    for (const a of accidents) { const d = ptLine(a.xy, line); if (d < accD) { accD = d; accName = a.name; } }

    const r = {
      light: STEP[Math.min(nLights, 3)],
      cctv: STEP[Math.min(nCctv, 3)],
      accident: accD <= ACC_NEAR ? 1 : accD <= ACC_FAR ? 1 - (accD - ACC_NEAR) / (ACC_FAR - ACC_NEAR) : 0,
      road: ROAD_RISK[cls] ?? 0.4,
      slope: null, // 추가 예정 (Copernicus DEM)
    };
    let sum = 0, wsum = 0;
    for (const k of Object.keys(WEIGHTS)) if (WEIGHTS[k] > 0 && r[k] != null) { sum += WEIGHTS[k] * r[k]; wsum += WEIGHTS[k]; }
    const score = Math.round((sum / wsum) * 100);

    c.segId = id + 1; // 경로 탐색용 간선이 이 구간의 점수를 찾을 수 있게 기록
    features.push({
      type: 'Feature',
      properties: {
        id: ++id, name: w.tags.name || '', hw: cls, len: Math.round(s.len), score,
        lights: nLights, cctv: nCctv, li, ci, accD: Number.isFinite(accD) && accD <= 500 ? Math.round(accD) : null, accName: accD <= ACC_FAR ? accName : null,
        r: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? null : Math.round(v * 100) / 100])),
      },
      geometry: { type: 'LineString', coordinates: s.pts.map(p => [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6]) },
    });
  }
}

// ---------- 출력 ----------
const r6 = v => Math.round(v * 1e6) / 1e6;
fs.writeFileSync(path.join(DATA, 'risk_segments.geojson'), JSON.stringify({ type: 'FeatureCollection', features }));
fs.writeFileSync(path.join(DATA, 'points.json'), JSON.stringify({
  campus: CAMPUS,
  meta: {
    generated: new Date().toISOString().slice(0, 10), areaHalfM: AREA_HALF, weights: WEIGHTS,
    params: { segLenM: SEG_LEN, lightBufM: LIGHT_BUF, cctvBufM: CCTV_BUF, cctvPurposes: [...CCTV_PURPOSES], accNearM: ACC_NEAR, accFarM: ACC_FAR },
    sources: { lights: '경상남도 창원시 보안등정보 (data.go.kr, 기준일 2025-02-12)', cctv: '경상남도 창원시 CCTV정보 (localdata.go.kr, 기준일 2026-05-02)', accidents: '전국교통사고다발지역표준데이터 (도로교통공단, 2012~2020년 항목)', roads: 'OpenStreetMap contributors (ODbL)' },
  },
  lights: lightsOut.map(l => [r6(l.lat), r6(l.lon), l.n, l.kind]),
  cctv: cctvOut.map(c => [r6(c.lat), r6(c.lon), c.purpose, c.n, c.ym, c.used ? 1 : 0]),
  accidents: accidents.map(({ xy, ...a }) => a),
}));

// ---------- 경로 탐색용 도로망 (graph.json) ----------
// 노드: [위도, 경도, 그룹]  그룹 0 = 경로 탐색에 쓸 본 도로망, 1 = 본 도로망과 끊긴 작은 덩어리, 2 = 산길(path/track)만 닿는 노드
// 간선: [노드A, 노드B, 길이(m), 구간 id(risk_segments.geojson의 properties.id), 도로 등급 번호(meta.hw의 위치)]
// 구간 파일의 끝점만으로는 교차로가 이어지지 않아서(구간이 50m 단위로 잘려 있음), OSM 원본 꼭짓점으로 그래프를 만든다.
const HW_LIST = [...new Set(chunks.filter(c => c.segId).map(c => c.cls))].sort();
const hwIdx = Object.fromEntries(HW_LIST.map((h, i) => [h, i]));
const TRAIL = new Set(['path', 'track']); // 경로 탐색에서는 제외하는 산길 등급 (D3 결정)
const nodeIdx = new Map(), gNodes = [];
const nid = p => {
  const k = p.lat.toFixed(7) + ',' + p.lon.toFixed(7); let i = nodeIdx.get(k);
  if (i === undefined) { i = gNodes.length; nodeIdx.set(k, i); gNodes.push([r6(p.lat), r6(p.lon)]); }
  return i;
};
const gEdges = [];
for (const c of chunks) {
  if (!c.segId) continue;
  for (let i = 1; i < c.pts.length; i++) {
    const a = nid(c.pts[i - 1]), b = nid(c.pts[i]); if (a === b) continue;
    gEdges.push([a, b, Math.round(dist(c.pts[i - 1].xy, c.pts[i].xy) * 10) / 10, c.segId, hwIdx[c.cls]]);
  }
}
// 산길을 뺀 도로망의 연결 덩어리 (union-find)
const par = gNodes.map((_, i) => i);
const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
const inRouting = new Set();
for (const [a, b, , , h] of gEdges) if (!TRAIL.has(HW_LIST[h])) { par[find(a)] = find(b); inRouting.add(a); inRouting.add(b); }
const compSize = new Map(); inRouting.forEach(n => compSize.set(find(n), (compSize.get(find(n)) || 0) + 1));
const mainRoot = [...compSize].sort((x, y) => y[1] - x[1])[0][0];
const group = i => !inRouting.has(i) ? 2 : find(i) === mainRoot ? 0 : 1;
const gCount = [0, 0, 0]; gNodes.forEach((_, i) => gCount[group(i)]++);
fs.writeFileSync(path.join(DATA, 'graph.json'), JSON.stringify({
  meta: { generated: new Date().toISOString().slice(0, 10), hw: HW_LIST, trailHw: [...TRAIL], groups: '0=경로 탐색 본 도로망, 1=끊긴 작은 덩어리, 2=산길 전용 노드', counts: gCount },
  nodes: gNodes.map(([la, lo], i) => [la, lo, group(i)]),
  edges: gEdges,
}));
console.log(`도로망(graph.json): 노드 ${gNodes.length}개, 간선 ${gEdges.length}개 | 본 도로망 ${gCount[0]}, 끊긴 덩어리 ${gCount[1]}, 산길 전용 ${gCount[2]} (산길 제외 덩어리 ${compSize.size}개)`);

// ---------- 요약 ----------
if (excludedLights.length) console.log(`주소(동)와 좌표 위치가 크게 어긋나 제외한 보안등 ${excludedLights.length}개: ${excludedLights.join(', ')}`);
console.log(`보안등-구간 연결: 거리만 보면 ${stat.oldLightPairs}건 → 같은 도로만 ${stat.newLightPairs}건 (옆 도로 것으로 잡히던 ${stat.oldLightPairs - stat.newLightPairs}건 제외)`);
console.log(`CCTV-구간 연결: 거리만 보면 ${stat.oldCctvPairs}건 → 같은 도로만 ${stat.newCctvPairs}건 (옆 도로 것으로 잡히던 ${stat.oldCctvPairs - stat.newCctvPairs}건 제외)`);
const sc = features.map(f => f.properties.score).sort((a, b) => a - b);
const q = p => sc[Math.floor((sc.length - 1) * p)];
const km = features.reduce((a, f) => a + f.properties.len, 0) / 1000;
console.log(`구간 ${features.length}개, 연장 ${km.toFixed(1)}km, 보안등 ${lights.length}지점, CCTV ${cctvs.length}건(반영 ${cctvs.filter(c => c.used).length}), 사고다발지 ${accidents.length}건`);
console.log(`점수 분포: min ${sc[0]} / 25% ${q(0.25)} / 중앙값 ${q(0.5)} / 75% ${q(0.75)} / max ${sc.at(-1)}`);
const bins = [0, 20, 40, 60, 80, 101]; console.log('구간 수:', bins.slice(0, -1).map((b, i) => `${b}-${bins[i + 1] - 1}: ${sc.filter(s => s >= b && s < bins[i + 1]).length}`).join(' | '));
const byHw = {}; features.forEach(f => { const h = f.properties.hw; (byHw[h] ||= []).push(f.properties.score); });
console.log('도로 등급별 평균:', Object.entries(byHw).map(([h, a]) => `${h} ${Math.round(a.reduce((x, y) => x + y, 0) / a.length)}(${a.length})`).join(', '));
