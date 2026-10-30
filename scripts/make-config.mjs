// 배포(Vercel) 빌드 때 실행: 환경 변수 KAKAO_JS_KEY로 config.js를 만든다. (키를 저장소에 두지 않기 위함)
// Vercel 프로젝트 > Settings > Environment Variables 에 KAKAO_JS_KEY 를 넣어 두어야 한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const key = (process.env.KAKAO_JS_KEY || '').trim();
if (!key) {
  console.error('KAKAO_JS_KEY 환경 변수가 없습니다. Vercel 환경 변수에 추가한 뒤 Redeploy 하세요. (지도가 뜨지 않습니다)');
  // 빌드를 실패시키지는 않는다: 키가 없어도 사이트는 올라가고, 화면에 "키가 설정되지 않았습니다" 안내가 나온다.
}
const text = `// 자동 생성 파일 (scripts/make-config.mjs) — 직접 수정하지 마세요.\nvar KAKAO_JS_KEY = ${JSON.stringify(key || 'PUT_YOUR_KAKAO_JAVASCRIPT_KEY_HERE')};\n`;
fs.writeFileSync(path.join(ROOT, 'config.js'), text);
console.log(key ? 'config.js 생성 완료 (키 값은 출력하지 않음)' : 'config.js 생성 (키 없음)');
