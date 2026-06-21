# public/vendor — 프런트 번들 서드파티 자산

CSP(`script-src 'self'`)상 CDN 로드가 금지되므로, 프런트에서 쓰는 서드파티 라이브러리는
이 폴더에 **로컬 번들**로 두고 app://('self')로 로드한다.

## Sortable.min.js
- **SortableJS** v1.15.6 (MIT) — https://github.com/SortableJS/Sortable
- 용도: 대시보드 카드 드래그 재정렬(placeholder 라이브 프리뷰). `window.Sortable` UMD.
- 로드: `public/index.html` → `<script src="./vendor/Sortable.min.js" defer>` (app.js 보다 먼저).
- 갱신 방법: `npm i -D sortablejs@<ver>` 후 `node_modules/sortablejs/Sortable.min.js` 를 이 파일로 복사.
  (devDependency 로만 둔다 — 런타임 소스는 번들된 이 파일이며 node_modules 사본은 패키징하지 않음.)
