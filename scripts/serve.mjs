// 로컬 미리보기용 정적 서버: node scripts/serve.mjs [포트]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 5173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.geojson': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const PUBLIC = new Set(['index.html', 'config.js', 'route.js', 'data/risk_segments.geojson', 'data/points.json', 'data/graph.json']); // 원본 CSV와 .env는 제공하지 않음

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  if (!PUBLIC.has(p)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/  (카카오 도메인 등록은 localhost 기준이므로 주소창에 127.0.0.1이 아니라 localhost로 여세요)`));
