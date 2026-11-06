// 로컬 미리보기용 정적 서버: node scripts/serve.mjs [포트]
// - 화면(index.html)과 데이터 파일을 제공하고, POST /api/explain(AI 설명)은 api/explain.js를 그대로 불러 처리한다. (배포 환경의 Vercel 서버 함수와 같은 코드)
// - AI 설명을 로컬에서 시험하려면 이 폴더에 .env 파일을 만들고 한 줄을 적는다 (.env는 저장소에 올라가지 않는다):
//     OPENROUTER_API_KEY=여기에_키
//   키가 없으면 AI 설명은 실패하고 화면은 기본 설명을 보여 준다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 5173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.geojson': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const PUBLIC = new Set(['index.html', 'config.js', 'route.js', 'data/risk_segments.geojson', 'data/points.json', 'data/graph.json']); // 원본 CSV와 .env는 제공하지 않음
const require = createRequire(import.meta.url);

try { // .env 읽기 (KEY=VALUE 한 줄씩)
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env 없음 */ }

function runApi(req, res) { // Vercel 서버 함수와 같은 모양(req.body, res.status().json())으로 api/explain.js 호출
  const chunks = []; let size = 0;
  req.on('data', c => { size += c.length; if (size <= 20000) chunks.push(c); });
  req.on('end', () => {
    const file = path.join(ROOT, 'api', 'explain.js'); delete require.cache[file]; // 수정하면 바로 반영
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
    req.body = size > 20000 ? 'x'.repeat(20001) : Buffer.concat(chunks).toString('utf8');
    Promise.resolve(require(file)(req, res)).catch(e => { console.error(e); if (!res.writableEnded) { res.statusCode = 500; res.end('error'); } });
  });
}

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
  if (p === 'api/explain') return runApi(req, res);
  if (!PUBLIC.has(p)) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}/  (카카오 도메인 등록은 localhost 기준이므로 주소창에 127.0.0.1이 아니라 localhost로 여세요)  AI 키: ${process.env.OPENROUTER_API_KEY ? '있음' : '없음(.env 확인)'}`));
