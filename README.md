# 경남대 주변 보행 안전 지도

경남대학교 주변 도로를 약 50m 구간으로 나눠, 보안등·CCTV·교통사고 다발지·도로 등급으로 **"야간 주의" 점수(0~100)**를 계산해 지도에 보여 주는 학교 프로젝트입니다.
점수는 환경 기반의 상대 비교용 지표이며, 범죄나 사고 발생 가능성을 단정하지 않습니다.

- 지도: 카카오맵 / 데이터: 공공데이터포털, 지방행정 인허가 데이터, OpenStreetMap
- 점수 범위: 학교 중심 한 변 3km 정사각형
- 데이터베이스 없이 점수를 미리 계산한 JSON 파일을 그대로 보여 주는 정적 사이트입니다.
- 배포 주소: (배포 후 기재)

## 로컬에서 보기

1. `config.example.js`를 `config.js`로 복사하고 카카오 JavaScript 키를 넣습니다. (`config.js`는 `.gitignore`에 있어 올라가지 않습니다.)
   - 카카오 개발자 콘솔 > 앱 > 플랫폼 키 > JavaScript 키
   - 같은 화면의 **JavaScript SDK 도메인**에 `http://localhost:5173`을 등록해야 합니다.
2. 서버를 켭니다.

```bash
node scripts/serve.mjs
```

3. 브라우저에서 `http://localhost:5173` 을 엽니다. (`127.0.0.1`은 등록한 도메인과 달라서 지도가 뜨지 않습니다.)

## 배포 (Vercel)

- Vercel에서 이 저장소를 Import합니다. 빌드 설정은 `vercel.json`에 있습니다(빌드할 때 `scripts/make-config.mjs`가 `config.js`를 만듭니다).
- Environment Variables에 **`KAKAO_JS_KEY`**를 추가합니다. 키는 저장소에 두지 않습니다.
- 배포 주소를 카카오 콘솔의 **JavaScript SDK 도메인**에 등록합니다. 등록하지 않으면 배포본에서 지도가 뜨지 않습니다.
- 환경 변수를 나중에 넣었다면 Deployments에서 Redeploy 합니다.

## 데이터와 계산

데이터 출처, 파일 설명, 점수를 다시 만드는 방법은 [`data/README.md`](data/README.md)에 있습니다.

```bash
node scripts/build-risk.mjs   # 점수 계산 (원본 CSV 필요: data/README.md 참고)
node scripts/audit-data.mjs   # 데이터 점검 (문제 0건이어야 함)
node scripts/probe-routes.mjs # 경로 탐색 시험 (최단 경로 대 안전 경로)
```

## 주의

- 보안등에는 밝기·고장 정보가 없고, CCTV는 공개된 일부만 포함됩니다. 사고다발지는 2012~2020년 자료입니다.
- 도로 등급 점수와 가중치는 근거 자료 없이 정한 임의 설정값입니다.
- 도로 데이터 출처: © OpenStreetMap contributors (ODbL)
