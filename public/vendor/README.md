# public/vendor — 프런트 번들 서드파티 자산

CSP(`script-src 'self'`)상 CDN 로드가 금지되므로, 프런트에서 쓰는 서드파티 라이브러리는
이 폴더에 **로컬 번들**로 두고 app://('self')로 로드한다.

## Sortable.min.js
- **SortableJS** v1.15.6 (MIT) — https://github.com/SortableJS/Sortable
- 용도: 대시보드 카드 드래그 재정렬(placeholder 라이브 프리뷰). `window.Sortable` UMD.
- 로드: `public/index.html` → `<script src="./vendor/Sortable.min.js" defer>` (app.js 보다 먼저).
- 갱신 방법: `npm i -D sortablejs@<ver>` 후 `node_modules/sortablejs/Sortable.min.js` 를 이 파일로 복사.
  (devDependency 로만 둔다 — 런타임 소스는 번들된 이 파일이며 node_modules 사본은 패키징하지 않음.)

## mermaid.min.js
- **Mermaid** v10.9.6 (MIT) — https://github.com/mermaid-js/mermaid
- 용도: 마크다운 편집기 미리보기의 ```mermaid 코드블록을 다이어그램으로 렌더. `self.mermaid` UMD(전 다이어그램 번들·동적 import 0).
- 로드: **메인 문서가 아니라** 격리 iframe(`public/mermaid.html`)에서만 로드한다 — mermaid 가 주입하는
  인라인 스타일/eval 은 그 iframe 전용 스코프 CSP(`style-src 'unsafe-inline'`, `script-src 'unsafe-eval'`)에서만
  허용되고, 메인 앱의 엄격한 CSP 는 그대로 유지된다. iframe 은 SVG 를 렌더해 **data: URI** 로 부모에 회신하고,
  미리보기는 그 이미지를 `<img>` 로만 표시한다(메인 문서엔 iframe/인라인스타일 유입 0).
- 갱신 방법: `npm pack mermaid@<ver>` → tarball 의 `package/dist/mermaid.min.js` 를 이 파일로 복사(UMD 빌드).
