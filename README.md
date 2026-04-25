# Vocal Practice Web App

브라우저에서 실행되는 보컬 pitch 연습용 MVP입니다.

## 기능

- 기준음 패턴: 도-미-솔-미-도
- 기준음 재생
- 마이크 입력을 통한 실시간 pitch detection
- 현재 음정 scatter 표시
- 타겟 음정 ±35 cents 이내면 초록색, 벗어나면 빨간색
- 결과 요약
- 반음 올리기 / 반음 내리기 / 같은 음 유지

## 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 표시되는 localhost 주소로 접속하세요.

## 중요

마이크 입력은 보안 정책상 다음 환경에서 동작합니다.

- localhost
- HTTPS 배포 환경

GitHub Pages, Vercel, Netlify 등에 배포하면 웹페이지로 사용할 수 있습니다.

## 참고

현재 pitch detector는 간단한 autocorrelation 기반 MVP입니다.
나중에 더 정확하게 만들고 싶으면 YIN 알고리즘 또는 pitchy 라이브러리로 교체하는 것을 추천합니다.
