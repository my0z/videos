/**
 * 생성(마지막 작업): 2026-09-07 02:15 (KST) — 글쓰기/이미지/음성 단계(genJob) 실패가 3분만 보이고
 * 흔적 없이 사라지던 문제 수정: 렌더링 실패(renderFail)처럼 genFail:{id}로 3일간 영구 기록을 남기고
 * 관리자 페이지 상단에 표시(recordGenFailure) — dismiss-fail이 genId도 받아서 지울 수 있게 확장
 * life-news - 생활뉴스 주제를 입력하면 글과 진짜 mp4 영상(이미지 슬라이드쇼+내레이션 음성)을 만드는 워커
 *
 * 글: 낭독 약 4분(공백 포함 1,700~2,000자) 분량, 싱크 친화 문장 규칙(20~45자 짧은 문장, 특수기호 금지 등) 적용
 * 미디어: 장면 20개 = 실사 클립 3개(Pixabay/Pexels 영상, 연관성 검사 통과분만) + 사진 17장
 *        (사진: Pixabay → Pexels → Unsplash → 다 실패하면 Workers AI(FLUX) 생성)
 * 음성: Google Cloud TTS(Chirp3-HD 우선, 실패시 Wavenet, 최후 Workers AI MeloTTS) — 목소리는 영상당 하나로 고정.
 *      문장 하나하나를 따로 합성해 relay.js가 실측 길이로 이어붙임 — 모든 문장 시작이 실측 리셋 지점(자막 싱크의 핵심).
 *      세그먼트 하나라도 끝내 실패하면 무음으로 발행하지 않고 발행 자체를 중단(올린 조각/이미지 정리 후 실패 처리).
 *      mp4까지 다 만들었는데 최종 파일에 오디오 트랙이 없는 경우(relay.js가 ffprobe로 검증)도 글째로 삭제.
 * 자막: 문장 하나를 통째(내부 줄바꿈)로 이미지별 "비트"에 배정 + 비트마다 음성 조각 번호(segIndex)를 실어 보내
 *      relay.js가 세그먼트 실측 시각으로 타이밍을 맞춤(추정 없음). 위치/폰트/색은 영상당 하나씩 랜덤 고정.
 * mp4 렌더링: Oracle VM의 relay.js(ffmpeg)에 비동기로 위임 — 자막 굽기/전환(xfade)/컬러그레이딩/loudnorm/
 *            청크 분할 렌더링(5장씩)까지 relay.js가 처리, 이 워커는 1분 크론 + 실시간 폴링으로 완료 감지
 * 유튜브: mp4 렌더링 확정되는 즉시 백그라운드로 자동 업로드(청크 업로드, 진행률 실시간 표시) + 숏츠 3개(도입/중간/결론, 세로 9:16, 각 ~57초, #Shorts)도 이어서 업로드,
 *        privacyStatus public. 실패해도 글은 유지하고 youtubeError만 기록(음성과 달리 발행을 막지 않음)
 * [2026-08-31 07:05] 생성 자체는 /admin/generate-step을 여러 번 호출해 단계별로 진행(Workers 30초 실행제한 회피).
 *   관리자 페이지가 열려있으면 1.5초마다 빠르게 진행되고, 페이지를 닫아도 1분 크론(scheduled)이 pollPendingGenJobs로
 *   같은 runGenerationStep을 대신 호출해 한 단계씩 이어서 진행함 — 더 이상 "탭을 보고 있어야만" 만들어지지 않음.
 *   다만 크론 주기가 느려서(1.5초 vs 1분) 탭 없이 완성되는 데는 몇십 분 걸릴 수 있음(1분마다 한 단계씩).
 */

const CF_ACCOUNT_ID = '709dcc6af36c8ee7b6d3d99e7a9fe422';
const VEO_MODEL = 'veo-3.1-fast-generate-preview';
const VIDEO_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30분 넘게 안 끝나면 포기
// [2026-08-31 07:05] 5분 → 1분: Cloudflare Cron 트리거의 최소 단위가 1분이라 이보다 더 못 줄임.
// wrangler.toml의 crons 배열도 이 값과 반드시 똑같이 '* * * * *'로 맞춰야 실제로 1분마다 실행됨(둘이 안 맞으면
// event.cron이 이 상수와 달라서 아래 scheduled()의 if문을 그냥 건너뜀 — 배포 후 크론 안 도는 흔한 원인).
const VIDEO_POLL_CRON = '* * * * *'; // 이 크론이 실행되면 콘텐츠 발행 대신 영상 작업 폴링 + 생성 작업 진행만 함
const CF_AI_GATEWAY = 'yzusb';
const VEO_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AI_GATEWAY}/google-ai-studio/v1beta`;
const SCENE_COUNT = 20; // 슬라이드쇼에 쓸 장면 이미지 개수 — 4분 분량 영상 기준 20장(장당 평균 12초 내외)
// [2026-09-02 20:21] genJob 동시실행 방지 락 — 원인: 관리자 탭의 1.5초 폴링(stepGen) + 1분 크론
// (pollPendingGenJobs) + relay의 cron-tick(약 20초마다, runVideoPollTick)이 전부 서로 모른 채 같은
// genJob을 동시에 runGenerationStep()으로 처리할 수 있었음. Cloudflare KV는 원자적 CAS가 없어서, 세
// 경로가 거의 동시에 같은 job을 읽으면 finalize 단계(post 저장 + index에 slug 추가)가 여러 번 실행돼
// 같은 글이 index에 중복으로 쌓이고 관리자 목록에 똑같은 글이 여러 줄로 보이는 원인이 됐음(실제 발생 사례:
// "면역·유전 치료가 바꾸는 암과..." 글이 완전히 같은 내용/시각으로 4줄 중복). 진짜 원자적 락은 KV로는
// 못 만들지만, job을 읽자마자(무거운 작업 시작 전에) lockedAt을 바로 기록해 다른 경로가 곧바로 이어서
// 같은 job을 읽더라도 "방금 누가 막 잠갔다"를 보고 건너뛰게 함 — 경쟁 창을 수 초~수십 초에서 KV
// 왕복시간(수십 ms) 수준으로 좁힘. finalize의 index 중복 방지(idx.includes 체크)는 그래도 혹시 겹치면
// 최후의 안전장치로 같이 넣음.
const GEN_JOB_LOCK_MS = 20000; // 이 시간 안에 다시 같은 job이 잡히면 "이미 처리 중"으로 보고 건너뜀
// 나레이션 길이 안전 상한(공백 포함) — 글 생성 프롬프트가 목표 분량을 쓰지만, 모델이 초과해서 쓸 경우를
// 대비해 문장 경계에서 잘라 상한을 넘지 않게 함(한국어 TTS ≈ 분당 400자).
// [2026-08-31] 실제 영상이 2분 남짓밖에 안 나온다는 피드백 — AI가 목표 분량(2,000~2,500자)을 못 채우고
// 짧게 쓰고 있었던 것(undershoot). "약 N분" 대신 "최소 O자 이상" 문구로 강하게 못박아 목표를 정함.
// [2026-09-02 19:56] 3,500~4,200자(7~8분)로 올렸더니 문장 수(=음성 세그먼트 수)가 너무 많아져서 relay
// 렌더링이 실패하는 빈도가 늘어남(사용자 관찰) — 2,500~3,000자(약 5분)로 다시 낮춤. 상한도 그에 맞춰 축소.
const NARRATION_MAX_CHARS = 3300;
const CAPTION_STYLE_COUNT = 5; // 자막 "위치" 종류 개수 — 웹(CSS)과 mp4(relay.js drawtext) 둘 다 같은 인덱스 규칙을 씀
// 자막 위치/폰트/색 전부 영상 하나당 하나씩만 랜덤 고정(비트마다 안 바뀜 — 계속 바뀌면 산만해서 전부 고정으로 변경).
// font key는 relay.js가 실제로 서버에 설치해둔 폰트 파일과 매칭되는 키만 사용(웹/mp4 폰트 일치 보장).
// [2026-09-06 22:00] 진짜 원인 발견/수정 — fonttools로 실측 검사한 결과, songmyung/gaegu/cutefont/
// yeonsung/gugi/sunflower 6개가 완성형 한글 11,172자 중 2,350자(21%)만 담고 있었음(자주 쓰는
// "울" 같은 흔한 글자도 빠져있어서 자막이 네모로 깨지던 진짜 원인). 커버리지 100%인 폰트만 남김.
const CAPTION_FONT_CHOICES = [
  { key: 'gowun', css: "'Gowun Dodum','Noto Sans KR',sans-serif" },
  { key: 'nanumpen', css: "'Nanum Pen Script','Gowun Dodum',cursive" },
  { key: 'gowunbatang', css: "'Gowun Batang',serif" },
  { key: 'himelody', css: "'Hi Melody',cursive" },
  { key: 'poorstory', css: "'Poor Story',cursive" },
  { key: 'gamjaflower', css: "'Gamja Flower',cursive" },
  { key: 'singleday', css: "'Single Day',cursive" },
  { key: 'stylish', css: "'Stylish',sans-serif" },
  { key: 'nanumbrush', css: "'Nanum Brush Script',cursive" },
  // [2026-09-06 22:40] fonttools 실측 검사로 100% 통과 확인된 폰트 2종 추가(relay.js CAPTION_FONT_PATHS 참고)
  { key: 'nanummyeongjo', css: "'Nanum Myeongjo',serif" },
  { key: 'nanumgothiccoding', css: "'Nanum Gothic Coding',monospace" },
  // [2026-09-06 23:00] 2차 후보 검사 통과 3종 추가(relay.js CAPTION_FONT_PATHS 참고)
  { key: 'gothica1', css: "'Gothic A1',sans-serif" },
  { key: 'ibmplexsanskr', css: "'IBM Plex Sans KR',sans-serif" },
  { key: 'nanumgothic', css: "'Nanum Gothic',sans-serif" },
];
const CAPTION_COLOR_CHOICES = ['#ffffff', '#FFD93D', '#FF6FA5', '#4FC3F7', '#6EE7B7', '#FFA94D', '#B197FC', '#FF8787'];
function pickCaptionStyle() {
  const font = CAPTION_FONT_CHOICES[Math.floor(Math.random() * CAPTION_FONT_CHOICES.length)];
  const color = CAPTION_COLOR_CHOICES[Math.floor(Math.random() * CAPTION_COLOR_CHOICES.length)];
  const positionIndex = Math.floor(Math.random() * CAPTION_STYLE_COUNT);
  return { captionFontKey: font.key, captionColor: color, captionPositionIndex: positionIndex };
}

const STYLE = `
  :root{
    --bg:#FFFFFF; --surface:#F7F8FA; --border:#E3E6EB;
    --teal:#14B8A6; --teal-text:#0D7B6C; --amber:#F59E0B; --amber-text:#B45309;
    --text:#14171C; --muted:#667085;
  }
  *{box-sizing:border-box;}
  body{ background:var(--bg); color:var(--text); margin:0; font-family:'Inter',system-ui,-apple-system,sans-serif; line-height:1.6; }
  .mono{ font-family:'IBM Plex Mono',monospace; }
  h1,h2,h3{ font-family:'Space Grotesk',sans-serif; letter-spacing:-0.02em; margin:0; }
  a{ color:inherit; text-decoration:none; }
  .wrap{ max-width:820px; margin:0 auto; padding:0 24px; }
  header.site{ border-bottom:1px solid var(--border); padding:22px 0; }
  header.site .wrap{ display:flex; justify-content:space-between; align-items:center; }
  .logo{ font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:21px; }
  .logo span{ color:var(--teal-text); }
  .hero{ padding:56px 0 32px; border-bottom:1px solid var(--border); }
  .hero .eyebrow{ font-family:'IBM Plex Mono',monospace; font-size:12px; letter-spacing:0.12em; color:var(--teal-text); text-transform:uppercase; margin-bottom:12px; display:block; }
  .hero h1{ font-size:36px; font-weight:700; line-height:1.2; }
  .hero p.sub{ color:var(--muted); font-size:15px; margin:12px 0 0; max-width:520px; }
  .index{ padding:8px 0 48px; }
  .entry{ display:flex; gap:20px; align-items:stretch; padding:28px 0; border-top:1px solid var(--border); }
  .entry:first-child{ border-top:none; padding-top:8px; }
  .entry-main{ flex:1; min-width:0; }
  .entry-eyebrow{ font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--teal-text); letter-spacing:0.04em; margin-bottom:8px; }
  .entry-title{ font-family:'Fraunces',serif; font-optical-sizing:auto; font-weight:500; font-size:23px; line-height:1.3; margin:0 0 8px; }
  .entry:hover .entry-title{ color:var(--teal-text); }
  .entry-excerpt{ color:var(--muted); font-size:14px; line-height:1.6; margin:0 0 10px; }
  .entry-meta{ font-family:'IBM Plex Mono',monospace; font-size:11px; color:var(--muted); }
  .entry-thumb{ flex-shrink:0; width:120px; border-radius:8px; overflow:hidden; background:#000; }
  .entry-thumb img{ width:100%; height:100%; object-fit:cover; }
  .post-body{ padding:40px 0; max-width:720px; }
  .post-body h1{ font-size:30px; margin-bottom:8px; }
  .post-body .meta{ color:var(--muted); font-size:13px; font-family:'IBM Plex Mono',monospace; margin-bottom:24px; }
  .post-body h2{ font-size:20px; margin:28px 0 10px; }
  .post-body p{ margin:0 0 16px; color:var(--text); }
  footer{ border-top:1px solid var(--border); padding:24px 0; color:var(--muted); font-size:13px; }
  .table-scroll{ width:100%; overflow-x:auto; margin-top:16px; -webkit-overflow-scrolling:touch; }
  table{ width:100%; min-width:640px; border-collapse:collapse; }
  th,td{ text-align:left; padding:10px; border-bottom:1px solid var(--border); font-size:13px; word-break:keep-all; overflow-wrap:break-word; white-space:normal; vertical-align:top; }
  th:first-child,td:first-child{ min-width:160px; }
  input[type=text]{ padding:9px 12px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--text); font-size:13px; font-family:inherit; }
  button{ background:var(--teal); color:#0B1210; border:none; padding:10px 16px; border-radius:6px; font-weight:700; cursor:pointer; }
  button.danger{ background:#E06C6C; color:#fff; }
  .slideshow{ position:relative; aspect-ratio:16/9; background:#000; border-radius:10px; overflow:hidden; margin:20px 0; }
  .slideshow .slide{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; transition:opacity 0.8s ease; }
  .slideshow .slide.active{ opacity:1; }
  .slideshow .playbtn{ position:absolute; bottom:14px; right:14px; z-index:5; background:rgba(0,0,0,0.6); color:#fff; border:1px solid rgba(255,255,255,0.4); padding:8px 16px; border-radius:20px; font-size:13px; font-weight:600; cursor:pointer; backdrop-filter:blur(4px); }
  .slideshow .playbtn:hover{ background:rgba(0,0,0,0.8); }
  .slideshow .caption-box{ position:absolute; z-index:4; min-height:0; background:transparent; padding:0 12px; white-space:pre-line; transition:top 0.3s ease, bottom 0.3s ease, left 0.3s ease, right 0.3s ease;
    -webkit-text-stroke:7px #000;
    paint-order:stroke fill;
    text-shadow:-6px -6px 0 #000, 6px -6px 0 #000, -6px 6px 0 #000, 6px 6px 0 #000, 0 -6px 0 #000, 0 6px 0 #000, -6px 0 0 #000, 6px 0 0 #000;
  }
  .slideshow .caption-box:empty{ display:none; }

  /* [2026-09-02 20:30] 관리자 페이지 카드 그리드 — 인스타그램 피드처럼 정사각형 썸네일 그리드로 표시 */
  .admin-grid{ display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:14px; margin-top:18px; }
  .admin-card{ border:1px solid var(--border); border-radius:12px; overflow:hidden; background:#fff; display:flex; flex-direction:column; }
  .admin-card.is-pending{ border-color:#F59E0B; }
  .admin-card.is-failed{ border-color:#DC2626; }
  .admin-card .thumb{ display:block; position:relative; aspect-ratio:1/1; width:100%; background:#11151A; overflow:hidden; }
  .admin-card .thumb img, .admin-card .thumb video{ width:100%; height:100%; object-fit:cover; display:block; }
  .admin-card .thumb .placeholder{ position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:34px; color:#3A4048; }
  .admin-card .thumb .dur-badge{ position:absolute; right:6px; bottom:6px; background:rgba(0,0,0,0.65); color:#fff; font-size:10px; padding:2px 6px; border-radius:4px; font-family:'IBM Plex Mono',monospace; }
  .admin-card .body{ padding:10px 11px 11px; display:flex; flex-direction:column; gap:6px; flex:1; }
  .admin-card .title{ font-size:12.5px; font-weight:600; line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .admin-card .topic{ font-family:'IBM Plex Mono',monospace; font-size:10.5px; color:var(--teal-text); }
  .admin-card .status-line{ font-size:11px; color:var(--muted); line-height:1.5; }
  .admin-card .progress-track{ height:5px; border-radius:3px; background:var(--surface); overflow:hidden; }
  .admin-card .progress-fill{ height:100%; width:0%; background:var(--teal); transition:width 0.5s ease; }
  .admin-card.is-failed .progress-fill{ background:#DC2626; }
  .admin-card .date{ font-family:'IBM Plex Mono',monospace; font-size:10px; color:var(--muted); margin-top:auto; }
  .admin-card .actions{ display:flex; flex-wrap:wrap; gap:5px; }
  .admin-card .actions a, .admin-card .actions button{ font-size:10.5px; padding:4px 8px; border-radius:5px; }
  .admin-card .actions a{ background:var(--surface); color:var(--text); border:1px solid var(--border); }
  .admin-card .actions form{ margin:0; display:inline; }
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Gowun+Dodum&family=Nanum+Pen+Script&family=Gowun+Batang&family=Song+Myung&family=Gaegu&family=Hi+Melody&family=Poor+Story&family=Gamja+Flower&family=Single+Day&family=Cute+Font&family=Stylish&family=Yeon+Sung&family=Gugi&family=Nanum+Brush+Script&family=Sunflower:wght@300&display=swap" rel="stylesheet">`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/') return await renderHomePage(env);
      if (path === '/sitemap.xml') return await handleSitemap(env);
      if (path === '/robots.txt') return handleRobotsTxt();
      if (path === '/rss.xml' || path === '/feed.xml') return await handleRssFeed(env);
      if (path === '/admin') return await renderAdminPage(env, url);
      if (path === '/admin/generate' && request.method === 'POST') return await handleGenerate(request, env);
      if (path === '/admin/generate-script' && request.method === 'POST') return await handleGenerateScript(request, env);
      if (path === '/api/generate' && request.method === 'POST') return await handleApiGenerate(request, env);
      if (path === '/admin/delete' && request.method === 'POST') return await handleDelete(request, env);
      if (path === '/admin/dismiss-fail' && request.method === 'POST') { // [2026-08-30 19:52] 렌더링/생성 실패 기록 확인 후 지우기
        const form = await request.formData();
        const failSlug = (form.get('slug') || '').toString();
        const failGenId = (form.get('genId') || '').toString(); // [2026-09-07 02:15] 생성 단계 실패 기록용
        if (failSlug) await env.POSTS.delete(`renderFail:${failSlug}`);
        if (failGenId) await env.POSTS.delete(`genFail:${failGenId}`);
        return new Response(null, { status: 302, headers: { Location: '/admin' } });
      }
      if (path === '/admin/render-progress') return await handleRenderProgress(request, env, ctx);
      if (path === '/admin/retry-render' && request.method === 'POST') return await handleRetryRender(request, env);
      // [2026-09-06 02:00] 관리자 페이지가 주기적으로 폴링해서 Oracle VM 사용량을 실시간처럼 갱신
      if (path === '/admin/oracle-stats') {
        const stats = await getOracleVmStats(env);
        return new Response(JSON.stringify(stats || {}), { headers: { 'Content-Type': 'application/json' } });
      }
      // [2026-08-31] relay VM이 20초마다 이걸 호출 — 1분 Cloudflare Cron 대신(또는 같이) 훨씬 자주
      // 폴링 로직을 실행시켜서 탭 안 열어놔도 생성/렌더/유튜브 재시도가 빠르게 진행되게 함.
      // x-relay-secret으로 인증(기존 RELAY_SECRET 재사용, 별도 시크릿 안 만듦).
      if (path === '/admin/cron-tick' && request.method === 'POST') {
        if (!env.RELAY_SECRET || request.headers.get('x-relay-secret') !== env.RELAY_SECRET) {
          return new Response('unauthorized', { status: 401 });
        }
        await runVideoPollTick(env, ctx);
        return new Response(JSON.stringify({ ok: true, at: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/admin/generate-step' && request.method === 'POST') return await handleGenerateStep(request, env);
      if (path === '/admin/cancel-gen' && request.method === 'POST') return await handleCancelGen(request, env);
      if (path === '/admin/upload-media' && request.method === 'POST') return await handleUploadMedia(request, env);
      if (path.startsWith('/media/')) return await serveMedia(request, env, ctx, decodeURIComponent(path.slice('/media/'.length)));
      const rootSlugMatch = path.match(/^\/([^\/]+)$/);
      if (rootSlugMatch) return await renderPostPage(env, decodeURIComponent(rootSlugMatch[1]));
      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return new Response('Server error: ' + e.message, { status: 500 });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        console.log(`=== 크론 실행: ${new Date().toISOString()} (cron: ${event.cron}) ===`);
        if (event.cron === VIDEO_POLL_CRON) {
          await runVideoPollTick(env, ctx);
        }
      })()
    );
  },
};

// [2026-08-31] 1분 Cloudflare Cron과, relay VM에서 5초마다 호출하는 /admin/cron-tick 둘 다 이 함수를 씀 —
// 로직 하나로 통일해서 두 경로가 어긋나지 않게 함.
async function runVideoPollTick(env, ctx) {
  await checkRelayHealth(env);
  await pollPendingGenJobs(env); // [2026-08-31 07:05] 탭이 안 열려있어도 생성이 이어지도록 한 단계씩 진행
  await pollYoutubeQuotaRetries(env); // [2026-08-31] 유튜브 할당량 초과로 막혔던 업로드, 리셋 시각 지나면 자동 재시도
  await pollPendingVideoJobs(env);
  await pollPendingRenderJobs(env, ctx);
  await pollR2CleanupQueue(env); // [2026-09-06 04:00] 유튜브 조회수 2회 이상 확인되면 R2 mp4/숏츠 삭제
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// [2026-08-30 21:17] 긴 에러를 앞+뒤로 나눠 표시 — 다단계 폴백 에러는 마지막 단계 결과가 끝에 있어서 앞만 자르면 안 보임
function truncErrText(msg, head = 220, tail = 220) {
  const s = String(msg || '');
  return s.length <= head + tail + 3 ? s : s.slice(0, head) + ' … ' + s.slice(-tail);
}

function makeExcerpt(html, maxLen = 130) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen).trim() + '…' : text;
}

// [2026-09-07 00:20] 버그 수정 — "대본 먼저 만들기"에서 사용자가 &,<,>,따옴표 등을 쓰면
// parseScriptToArticle이 안전하게 escapeHtml() 처리해서 body_html에 넣는데(글 페이지에 그대로
// 렌더링되므로 이스케이프 자체는 맞음), 이걸 다시 나레이션/이미지검색 키워드용 텍스트로 뽑을 때
// (stripHtml) 엔티티가 안 풀려서 "&amp;" 같은 게 그대로 섞여 들어갔음. 태그 제거 후 엔티티도 복원.
function stripHtml(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// [2026-09-01] 초 단위 시간을 "N분 M초"/"N초"로 표시 — admin 목록, 글 페이지 등 여러 곳에서 공용으로 씀
function fmtDurSec(sec) {
  return (typeof sec === 'number' && sec >= 0) ? (sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`) : '';
}

function page(title, body, options = {}) {
  const { description = '생활 속 다양한 주제를 다루는 글과 영상', noindex = false } = options;
  const meta = `<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
${noindex ? '<meta name="robots" content="noindex, nofollow">' : ''}`;
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${meta}${FONTS}<style>${STYLE}</style></head><body>${body}</body></html>`;
}

function siteHeader() {
  return `<header class="site"><div class="wrap"><a class="logo" href="/">life<span>.news</span></a><div class="mono" style="font-size:12px;color:var(--muted)">생활뉴스 · 글+슬라이드쇼</div></div></header>`;
}

// [2026-08-30 19:41] Cerebras 제거(크레딧 소진으로 402만 뱉어서 뺌) — 이제 Groq(2개 모델) → Workers AI 순.
// CEREBRAS_API_KEY 환경변수는 더 이상 안 읽으므로 그대로 둬도 무해함(지워도 됨).
async function callAiChain(systemPrompt, userPrompt, env) {
  const attemptErrors = [];

  // [2026-08-30 22:44] SambaNova Cloud 1순위 연결(사용자 요청) — OpenAI 호환 API, 무료 티어.
  // DeepSeek-V3.1(다국어 강함) → Llama-3.3-70B 순. 실패하면 아래 Groq → Workers AI로 폴백.
  // Cloudflare에 SAMBANOVA_API_KEY 시크릿 등록 필요(없으면 이 단계는 건너뜀).
  if (env.SAMBANOVA_API_KEY) {
    for (const model of ['DeepSeek-V3.1', 'Meta-Llama-3.3-70B-Instruct']) {
      try {
        const res = await fetch('https://api.sambanova.ai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SAMBANOVA_API_KEY}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7,
            max_tokens: 4000,
          }),
          signal: AbortSignal.timeout(45000),
        });
        if (res.ok) {
          const data = await res.json();
          let raw = data?.choices?.[0]?.message?.content;
          if (raw) {
            // DeepSeek 계열이 <think>...</think>를 앞에 붙이는 경우 제거 후 JSON 파싱
            raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().replace(/^```json\s*|\s*```$/gm, '').trim();
            try {
              return { result: JSON.parse(raw), error: null, modelUsed: `sambanova:${model}` };
            } catch (e) {
              attemptErrors.push(`[sambanova:${model}] JSON 파싱 실패: ${e.message}`);
              continue;
            }
          } else {
            attemptErrors.push(`[sambanova:${model}] 응답에 content 없음(finish: ${data?.choices?.[0]?.finish_reason || '?'})`);
            continue;
          }
        } else {
          const bodyText = await res.text();
          attemptErrors.push(`[sambanova:${model}] HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
          continue;
        }
      } catch (e) {
        attemptErrors.push(`[sambanova:${model}] 네트워크 오류: ${e.message}`);
        continue;
      }
    }
  } else {
    attemptErrors.push('[sambanova] SAMBANOVA_API_KEY 미설정');
  }

  if (env.GROQ_API_KEY) {
    // [2026-08-30 21:08] 모델 현행화: llama-3.1-8b-instant가 2026-08-16 Groq에서 퇴역(404) → gpt-oss-20b(빠름) →
    // gpt-oss-120b(품질) → qwen3.6-27b 순. gpt-oss 계열은 추론(리즈닝) 모델이라 생각 토큰이 한도를 다 먹으면
    // content가 비어버림 → reasoning_effort를 low로 낮추고 max_tokens도 8000으로 넉넉히.
    for (const model of ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.6-27b']) {
      try {
        const res = await fetch(`https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AI_GATEWAY}/groq/openai/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7,
            max_tokens: 4000, // [2026-08-30 21:17] 8000→4000: 무료 티어 분당 토큰 한도에 입력+max_tokens가 합산돼 413 나던 문제(reasoning low라 4000이면 충분)
            ...(model.startsWith('openai/gpt-oss') ? { reasoning_effort: 'low' } : {}),
          }),
          signal: AbortSignal.timeout(45000), // 4분 분량 생성이라 넉넉히(스텝 방식이라 오래 기다려도 됨)
        });
        if (res.ok) {
          const data = await res.json();
          let raw = data?.choices?.[0]?.message?.content;
          if (raw) {
            raw = raw.trim().replace(/^```json\s*|\s*```$/gm, '').trim();
            try {
              return { result: JSON.parse(raw), error: null, modelUsed: model };
            } catch (e) {
              attemptErrors.push(`[${model}] JSON 파싱 실패: ${e.message}`);
              continue;
            }
          } else {
            attemptErrors.push(`[${model}] 응답에 content 없음(finish: ${data?.choices?.[0]?.finish_reason || '?'})`);
            continue;
          }
        } else {
          const bodyText = await res.text();
          attemptErrors.push(`[${model}] HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
          continue;
        }
      } catch (e) {
        attemptErrors.push(`[${model}] 네트워크 오류: ${e.message}`);
        continue;
      }
    }
  } else {
    attemptErrors.push('[groq] GROQ_API_KEY 미설정');
  }

  if (env.AI) {
    try {
      const response = await withTimeout(env.AI.run('@cf/zai-org/glm-4.7-flash', {
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: 5000, // [2026-08-30 19:38] 4분 분량(1,700~2,000자) 글이 2000토큰에서 잘려 JSON 파싱 실패하던 문제 수정
      }, { gateway: { id: CF_AI_GATEWAY } }), 90000, 'workers-ai 글 생성'); // [2026-08-30 21:17] 90초로 확대(55초도 4분 분량 한국어 JSON엔 빠듯했음)
      let raw = response?.response;
      if (raw) {
        raw = raw.trim().replace(/^```json\s*|\s*```$/gm, '').trim();
        try {
          return { result: JSON.parse(raw), error: null, modelUsed: 'workers-ai:glm-4.7-flash' };
        } catch (e) {
          attemptErrors.push(`[workers-ai] JSON 파싱 실패: ${e.message}`);
        }
      } else {
        attemptErrors.push('[workers-ai] 응답에 content 없음');
      }
    } catch (e) {
      attemptErrors.push(`[workers-ai] 오류: ${e.message}`);
    }
  } else {
    attemptErrors.push('[workers-ai] AI 바인딩 없음');
  }

  return { result: null, error: `모든 모델 시도 실패 — ${attemptErrors.join(' / ')}` };
}

function stripNaverHighlight(text) {
  // 네이버 검색 API는 강조 부분에 <b></b> 태그를 붙여서 줌, 순수 텍스트로 정리
  return (text || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

async function searchNaverNews(topic, env) {
  if (!env.NAVER_CLIENT_ID || !env.NAVER_CLIENT_SECRET) return [];
  try {
    const res = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(topic)}&display=5&sort=date`, {
      headers: {
        'X-Naver-Client-Id': env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': env.NAVER_CLIENT_SECRET,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await res.text().catch(() => {}); // body 미소비 시 "stalled response" 경고 발생 방지
      console.log(`네이버 뉴스검색 실패: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map((item) => ({
      title: stripNaverHighlight(item.title),
      description: stripNaverHighlight(item.description),
      pubDate: item.pubDate,
      originalLink: item.originallink || item.link || '',
    }));
  } catch (e) {
    console.log('네이버 뉴스검색 오류: ' + e.message);
    return [];
  }
}

async function generateArticle(topic, newsResults, env, detail) {
  let systemPrompt, userPrompt;
  // [2026-09-06 00:20] 사용자가 상세 내용을 적으면 프롬프트에 반드시 반영하도록 지시 한 줄 추가
  const detailInstruction = detail ? ' 사용자가 다루고 싶은 세부 내용을 아래에 함께 제공하니 그 내용을 반드시 반영해서 글을 쓴다.' : '';
  const detailBlock = detail ? `\n\n다룰 상세 내용: ${detail}` : '';
  if (newsResults.length) {
    console.log(`네이버 뉴스 ${newsResults.length}건 참고자료로 사용`);
    const referenceText = newsResults
      .map((n, i) => `[참고자료 ${i + 1}] ${n.title}\n${n.description}`)
      .join('\n\n');
    systemPrompt = `너는 한국어 생활뉴스를 진행자처럼 구어체로 설명하는 내레이터다. 아래에 실제 뉴스 검색 결과가 참고자료로 주어진다. 이 참고자료에 있는 사실만을 근거로 글을 쓴다. 참고자료에 없는 구체적 수치·통계·날짜를 지어내지 않는다. 참고자료끼리 내용이 다르면 "~라는 보도가 있다"처럼 출처를 명시하는 톤으로 서술한다. 참고자료 문장을 그대로 베끼지 말고 반드시 자신의 표현으로 다시 쓴다(패러프레이즈). 과장된 표현이나 광고성 문구는 쓰지 않는다.${detailInstruction} 본문은 반드시 순수 한글로만 작성한다. 문체(가장 중요): 딱딱한 문어체(-습니다, -였다 같은 서술문투) 대신, 청자에게 직접 말하듯이 설명하는 자연스러운 구어체 존댓말을 쓴다(예: -해요, -거든요, -그런데요, -인데요, -더라고요). 뉴스 기사를 읽는 게 아니라 사람이 옆에서 이야기해주는 느낌이어야 한다. 문장 규칙(음성 낭독과 자막 표시에 그대로 쓰이므로 반드시 지킨다, 구어체와 함께 지켜야 함): 한 문장은 공백 포함 20~45자로 아주 짧게 쓰고, 한 문장에 한 가지 내용만 담는다. 긴 설명은 짧은 문장 여러 개로 나눈다. 문장과 문장 사이는 그런데, 그래서, 사실은, 특히 같은 자연스러운 구어체 접속어로 이어서 술술 읽히게 한다. 모든 문장은 마침표·물음표·느낌표로 끝낸다. 말줄임표, 괄호 보충설명, 따옴표 인용, 이모지, 특수기호, 영어 약어는 쓰지 않는다(음성 합성이 다르게 읽어서 자막과 어긋나는 원인이 된다). 숫자와 단위는 소리 내어 읽는 그대로 한글 표기를 우선한다(예: 25% 대신 25퍼센트). 쉼표는 전혀 쓰지 않는다. 쉼표를 쓸 자리는 문장을 끊어서 짧은 문장 두 개로 나눈다. 띄어쓰기(매우 중요 — TTS가 단어를 붙여서 급하게 읽는 사고의 직접 원인): 마침표·물음표·느낌표·쉼표 뒤에는 반드시 띄어쓰기를 하나 넣는다(붙여쓰면 음성 합성이 두 단어를 숨 쉴 틈 없이 이어 읽어버린다). 단어와 단어 사이도 표준 띄어쓰기를 정확히 지킨다. 분량(반드시 지킬 것 — 목표보다 짧게 쓰지 않는다): 전체(도입부+본문+마무리)를 소리 내어 읽으면 약 5분 분량이 되도록 공백 포함 최소 2,500자 이상, 2,500~3,000자로 쓴다. 이보다 짧으면 안 된다. 소제목 섹션은 5~7개로 나누고, 각 섹션 본문은 짧게 끝내지 말고 최소 250자 이상으로 충분히 풀어서 쓴다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"title": "제목(한국어)", "intro_html": "<p>도입부 1~2문단</p>", "sections": [{"heading":"소제목","body_html":"<p>본문</p>"}], "outro_html":"<p>마무리 문단</p>", "threads_text": "스레드(SNS) 홍보 글 — 이 형식을 정확히 지킨다: 첫 줄은 어울리는 이모지 1개로 시작하는 짧고 강렬한 훅 한 문장, 빈 줄 하나, 핵심 요약 2~3줄(한 줄에 한 가지 내용, 각 줄 짧게), 빈 줄 하나, 마지막 줄에 어울리는 해시태그 2~3개. 본문과 달리 이 필드에서만 이모지 사용 가능. 전체 공백 포함 300자 이내, 링크는 넣지 않는다, 줄바꿈은 \\n"}`;
    userPrompt = `주제: ${topic}${detailBlock}\n\n${referenceText}`;
  } else {
    console.log('네이버 뉴스검색 결과 없음(또는 키 미설정), 참고자료 없이 작성');
    systemPrompt = `너는 한국어 생활뉴스를 진행자처럼 구어체로 설명하는 내레이터다. 주어진 주제에 대해 정직하고 담백한 정보성 글을 쓴다. 실제 사용 경험이나 확인 안 된 통계·수치를 단정적으로 지어내지 않는다. 확실하지 않은 내용은 "일반적으로", "~로 알려져 있다" 같은 표현을 쓴다. 과장된 표현이나 광고성 문구는 쓰지 않는다.${detailInstruction} 본문은 반드시 순수 한글로만 작성한다. 문체(가장 중요): 딱딱한 문어체(-습니다, -였다 같은 서술문투) 대신, 청자에게 직접 말하듯이 설명하는 자연스러운 구어체 존댓말을 쓴다(예: -해요, -거든요, -그런데요, -인데요, -더라고요). 뉴스 기사를 읽는 게 아니라 사람이 옆에서 이야기해주는 느낌이어야 한다. 문장 규칙(음성 낭독과 자막 표시에 그대로 쓰이므로 반드시 지킨다, 구어체와 함께 지켜야 함): 한 문장은 공백 포함 20~45자로 아주 짧게 쓰고, 한 문장에 한 가지 내용만 담는다. 긴 설명은 짧은 문장 여러 개로 나눈다. 문장과 문장 사이는 그런데, 그래서, 사실은, 특히 같은 자연스러운 구어체 접속어로 이어서 술술 읽히게 한다. 모든 문장은 마침표·물음표·느낌표로 끝낸다. 말줄임표, 괄호 보충설명, 따옴표 인용, 이모지, 특수기호, 영어 약어는 쓰지 않는다(음성 합성이 다르게 읽어서 자막과 어긋나는 원인이 된다). 숫자와 단위는 소리 내어 읽는 그대로 한글 표기를 우선한다(예: 25% 대신 25퍼센트). 쉼표는 전혀 쓰지 않는다. 쉼표를 쓸 자리는 문장을 끊어서 짧은 문장 두 개로 나눈다. 띄어쓰기(매우 중요 — TTS가 단어를 붙여서 급하게 읽는 사고의 직접 원인): 마침표·물음표·느낌표·쉼표 뒤에는 반드시 띄어쓰기를 하나 넣는다(붙여쓰면 음성 합성이 두 단어를 숨 쉴 틈 없이 이어 읽어버린다). 단어와 단어 사이도 표준 띄어쓰기를 정확히 지킨다. 분량(반드시 지킬 것 — 목표보다 짧게 쓰지 않는다): 전체(도입부+본문+마무리)를 소리 내어 읽으면 약 5분 분량이 되도록 공백 포함 최소 2,500자 이상, 2,500~3,000자로 쓴다. 이보다 짧으면 안 된다. 소제목 섹션은 5~7개로 나누고, 각 섹션 본문은 짧게 끝내지 말고 최소 250자 이상으로 충분히 풀어서 쓴다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"title": "제목(한국어)", "intro_html": "<p>도입부 1~2문단</p>", "sections": [{"heading":"소제목","body_html":"<p>본문</p>"}], "outro_html":"<p>마무리 문단</p>", "threads_text": "스레드(SNS) 홍보 글 — 이 형식을 정확히 지킨다: 첫 줄은 어울리는 이모지 1개로 시작하는 짧고 강렬한 훅 한 문장, 빈 줄 하나, 핵심 요약 2~3줄(한 줄에 한 가지 내용, 각 줄 짧게), 빈 줄 하나, 마지막 줄에 어울리는 해시태그 2~3개. 본문과 달리 이 필드에서만 이모지 사용 가능. 전체 공백 포함 300자 이내, 링크는 넣지 않는다, 줄바꿈은 \\n"}`;
    userPrompt = `주제: ${topic}${detailBlock}`;
  }

  const { result, error, modelUsed } = await callAiChain(systemPrompt, userPrompt, env);
  return { article: result, error, modelUsed };
}

// [2026-09-07 00:10] "대본 먼저 만들기" 기능 — article 객체(title/intro_html/sections/outro_html)를
// 사람이 읽고 고치기 편한 평문 텍스트로 바꾸고, 고친 뒤 다시 article 객체로 되돌리는 왕복 변환.
// 구분자는 고정 포맷([도입부]/[소제목: ...]/[마무리])이라 사용자가 텍스트만 자유롭게 고쳐도 파싱이 깨지지 않음.
function stripHtmlToText(html) {
  return (html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
function formatArticleAsScript(article) {
  const lines = [`제목: ${article.title || ''}`, '', '[도입부]', stripHtmlToText(article.intro_html)];
  (article.sections || []).forEach((s) => {
    lines.push('', `[소제목: ${s.heading || ''}]`, stripHtmlToText(s.body_html));
  });
  lines.push('', '[마무리]', stripHtmlToText(article.outro_html));
  return lines.join('\n');
}
function parseScriptToArticle(scriptText, fallbackTitle) {
  const text = (scriptText || '').replace(/\r\n/g, '\n');
  const titleMatch = text.match(/^제목:\s*(.+)$/m);
  const title = (titleMatch ? titleMatch[1].trim() : '') || fallbackTitle || '';
  // 텍스트를 [마커] 기준으로 조각냄 — 마커 자체와 그 뒤 내용을 순서대로 수집
  const markerRe = /\[(도입부|소제목:\s*[^\]]*|마무리)\]/g;
  const parts = [];
  let lastIndex = 0;
  let lastMarker = null;
  let m;
  while ((m = markerRe.exec(text))) {
    if (lastMarker) parts.push({ marker: lastMarker, body: text.slice(lastIndex, m.index) });
    lastMarker = m[1];
    lastIndex = markerRe.lastIndex;
  }
  if (lastMarker) parts.push({ marker: lastMarker, body: text.slice(lastIndex) });

  let introHtml = '';
  let outroHtml = '';
  const sections = [];
  for (const part of parts) {
    const body = part.body.trim();
    const bodyHtml = body ? `<p>${escapeHtml(body)}</p>` : '';
    if (part.marker === '도입부') {
      introHtml = bodyHtml;
    } else if (part.marker === '마무리') {
      outroHtml = bodyHtml;
    } else {
      const headingMatch = part.marker.match(/^소제목:\s*(.*)$/);
      sections.push({ heading: (headingMatch ? headingMatch[1].trim() : ''), body_html: bodyHtml });
    }
  }
  // 마커를 하나도 못 찾았으면(사용자가 형식을 다 지워버린 경우) 전체를 도입부 하나로 취급 — 유실 방지
  if (!parts.length) introHtml = `<p>${escapeHtml(text.replace(/^제목:.*\n?/, '').trim())}</p>`;
  return { title, intro_html: introHtml, sections, outro_html: outroHtml, threads_text: '' };
}

// [2026-09-02 21:20] 생성된 글을 다시 한 번 AI로 다듬어 TTS가 자연스럽게 읽도록 함 — 원래 글쓰기
// 프롬프트의 20~45자 규칙만으로는 실제로 정확히 5초 분량이 되도록 맞추기 어려워서, 완성된 글을 놓고
// "문장 하나 = 약 5초"를 유일한 목표로 삼아 다시 나누고 다듬는 전용 편집 패스를 추가함(의미는 그대로 유지).
// 실패하거나 결과가 너무 짧으면(원문 절반 미만) 원문을 그대로 씀 — 발행 자체가 막히지 않게.
async function reeditForTtsPacing(text, env) {
  if (!text || text.length < 15) return text;
  // [2026-09-06 03:00] 못박기 — "약 5초 분량" 지시를 AI가 "단어 하나마다 마침표를 찍어서 문장을
  // 쪼개라"로 잘못 해석해서, "오늘은." "운적석이." "배치된." 식으로 단어 단위 초단문이 나오던 문제가
  // 있었음(TTS가 한 단어만 읽고 다음 문장으로 넘어가서 자막도 한 단어씩만 뜨고 나레이션도 뚝뚝 끊김).
  // 최소 어절 수를 명시하고, 단어 하나짜리 문장을 만들지 말라고 구체적으로 금지함.
  const systemPrompt = '너는 TTS(음성합성)가 자연스럽게 읽을 수 있도록 나레이션 글을 다시 다듬는 편집자다. 아래 글에 나온 문장과 정보의 순서를 절대 바꾸지 않는다 — 원문에 등장하는 순서 그대로 처음부터 끝까지 유지하면서, 문장을 나누거나 합치거나 표현만 다듬는다(내용을 앞뒤로 옮기거나 재배열하지 않는다). 의미와 정보는 하나도 빠짐없이 그대로 유지하면서 모든 문장을 소리 내어 읽었을 때 각각 약 5초(공백 포함 28~35자, 최소 4개 어절 이상) 분량이 되도록 조정한다. 절대로 단어 하나나 두 개짜리를 문장으로 만들지 않는다(예: "오늘은." "운적석이." 처럼 쪼개는 것 금지 — 이러면 TTS가 한 단어만 읽고 뚝뚝 끊겨서 부자연스럽다). 문장 하나에 한 가지 내용만 담되 최소 4어절 이상 자연스러운 구어체 흐름으로 잇는다(-해요, -거든요, -그런데요 같은 말투 유지). 모든 문장은 마침표 물음표 느낌표로 끝낸다. 쉼표 괄호 따옴표 이모지 특수기호는 쓰지 않는다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"text": "재편집된 전체 글(원문과 같은 순서, 문장 사이는 공백 하나로 구분)"}';
  try {
    const { result } = await callAiChain(systemPrompt, text, env);
    const edited = typeof result?.text === 'string' ? result.text.trim() : '';
    if (edited.length < text.length * 0.5) return text; // 결과가 너무 짧으면 뭔가 잘못된 것으로 보고 원문 사용
    // [2026-09-06 03:00] 안전장치 — AI가 그래도 단어 단위로 잘게 쪼갰는지 평균 문장 길이로 검증.
    // 정상이면 문장 하나가 28~35자여야 하는데, 평균이 15자도 안 되면 단어 단위로 쪼개진 것으로 보고
    // 재편집 결과를 버리고 원문(20~45자 규칙으로 이미 생성된 글)을 그대로 씀.
    const sentences = edited.split(/(?<=[.!?。！？])\s+/).filter(Boolean);
    const avgLen = sentences.length ? sentences.reduce((a, s) => a + s.length, 0) / sentences.length : 0;
    if (avgLen < 15) {
      console.log(`reeditForTtsPacing 결과가 단어 단위로 잘게 쪼개짐(평균 ${avgLen.toFixed(1)}자, 문장 ${sentences.length}개) — 원문 사용`);
      return text;
    }
    return edited;
  } catch (e) {
    return text;
  }
}

const MIN_USABLE_IMAGE_BYTES = 15 * 1024; // 15KB 미만이면 아이콘/로고/썸네일일 가능성이 높아 "못 쓰는 이미지"로 판단

function isUsableImage(buffer) {
  return !!buffer && buffer.byteLength >= MIN_USABLE_IMAGE_BYTES;
}

// [2026-09-02 20:45] wantCount 파라미터 추가 — 사용자가 미디어를 직접 첨부한 만큼 AI가 생성할 장면 수를
// SCENE_COUNT에서 빼서 요청함(전체 장면 수는 항상 SCENE_COUNT로 유지, 첨부분 + AI생성분 = SCENE_COUNT)
// [2026-09-06 00:20] 장면 키워드가 주제+제목만 보고 뭉뚱그려지던 문제 — 실제 글 본문에 나온 구체적
// 소재/상황을 반영하도록 섹션별 짧은 요약을 만들어 generateScenePrompts에 같이 넘김. 전체를 다 넣으면
// 프롬프트가 너무 커지니 섹션당 앞부분만 발췌(소제목 + 120자 내외)해서 총량을 적당히 유지.
function buildArticleDigestForScenes(article) {
  if (!article) return '';
  const introBrief = stripHtml(article.intro_html).slice(0, 200);
  const sectionBriefs = (article.sections || []).map((s) => `${s.heading}: ${stripHtml(s.body_html).slice(0, 120)}`).join('\n');
  return [introBrief, sectionBriefs].filter(Boolean).join('\n').slice(0, 1200);
}

async function generateScenePrompts(topic, articleTitle, env, wantCount = SCENE_COUNT, articleDigest = '') {
  const systemPrompt = `너는 짧은 슬라이드쇼 영상을 위한 아트 디렉터다. 주어진 주제와 글 제목, 그리고 글 본문 요약을 참고해서, 정지 이미지로 표현할 장면 ${wantCount}개를 구상한다. 본문 요약에 나온 구체적인 소재/상황/장소를 최대한 반영해서 장면을 고른다 — 주제만 보고 막연하게 고르지 않는다. 순서(매우 중요): 글 본문 요약은 도입부 → 섹션들 → 순서 그대로 나열되어 있다. 장면 배열의 순서도 반드시 그 순서를 그대로 따라야 한다 — 배열 앞쪽 장면은 글 앞부분(도입부) 내용을, 뒤쪽 장면은 글 뒷부분(뒤쪽 섹션) 내용을 나타내야 한다. 이렇게 해야 영상이 재생될 때 화면 순서와 나레이션이 읽는 내용 순서가 서로 어긋나지 않는다. 각 장면은 서로 다른 각도/구도로 시각화하며, 실제 인물/유명인/브랜드 로고를 특정해서 묘사하지 않는다. 각 장면마다 두 가지를 만든다: 1) keyword — 실제 스톡사진 사이트(Pexels)에서 진짜로 검색될 만한, 실존하는 사물/장소/상황을 나타내는 짧은 영어 키워드(2~4단어). 너무 추상적이거나 상상 속 장면이 아니라, 사진작가가 실제로 찍었을 법한 평범하고 구체적인 소재로 만든다(예: "laptop office desk", "grocery shopping supermarket", "family dinner table"). 2) prompt — 만약 실사진이 없을 경우에 대비한 AI 이미지 생성용 상세한 장면 묘사. 이 프롬프트는 반드시 영어로만 작성한다(한국어 절대 금지) — 이미지 생성 모델이 영어 캡션으로 학습되어 있어서 한국어를 넣으면 엉뚱한 결과가 나옴. 사진처럼 사실적인 스타일, 카메라 앵글/조명까지 구체적으로 묘사. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"scenes": [{"keyword": "영어 검색어", "prompt": "영어로만 작성된 상세 장면 묘사"}, ...]} (배열 길이는 정확히 ${wantCount}개, 배열 순서 = 글 내용 순서)`;
  const userPrompt = `주제: ${topic}\n글 제목: ${articleTitle}${articleDigest ? `\n\n글 본문 요약(이 순서 그대로 도입부→섹션 순서임):\n${articleDigest}` : ''}`;
  const { result } = await callAiChain(systemPrompt, userPrompt, env);
  if (Array.isArray(result?.scenes) && result.scenes.length) {
    return result.scenes.slice(0, wantCount).map((s) => ({
      keyword: typeof s === 'string' ? topic : (s.keyword || topic),
      prompt: typeof s === 'string' ? s : (s.prompt || `A realistic photo representing: ${topic}`),
    }));
  }
  return Array.from({ length: wantCount }, (_, i) => ({
    keyword: topic,
    prompt: `A realistic photo representing: ${topic}, scene ${i + 1}`,
  }));
}

// [2026-09-02 21:05] 쇼츠(하이라이트) 구간 선정 — 문장(=음성 세그먼트) 번호가 매겨진 목록을 AI에게
// 보여주고, 소리 내어 읽었을 때 약 35~45초가 되는 연속 구간 중 가장 하이라이트가 될 만한 곳을 고르게 함.
// relay.js가 이 구간(문장 인덱스)을 실측 세그먼트 시각으로 변환해서 그 부분만 쇼츠로 잘라냄.
// 실패하면 null 반환 — relay.js는 null이면 예전처럼 도입/중간/결론 후보 로직으로 폴백함.
async function pickHighlightRange(sentences, topic, env) {
  if (!sentences?.length) return null;
  if (sentences.length === 1) return { start: 0, end: 0 };
  const numbered = sentences.map((s, i) => `${i}: ${s}`).join('\n');
  const systemPrompt = '너는 짧은 하이라이트 클립(쇼츠)을 만들기 위해 나레이션 문장들 중 가장 흥미롭고 핵심적인 구간을 고르는 편집자다. 아래에 번호가 매겨진 문장 목록이 주어진다. 이 중 연속된 문장 구간 하나를 고른다 — 시청자의 관심을 가장 끌만한 핵심 정보나 임팩트 있는 내용이 담긴 구간이어야 한다. 고른 구간을 소리 내어 읽었을 때 총 길이가 약 35~45초(대략 230~300자)가 되도록 문장 개수를 조절한다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"startIndex": 시작문장번호, "endIndex": 끝문장번호}';
  const userPrompt = `주제: ${topic}\n\n문장 목록:\n${numbered}`;
  try {
    const { result } = await callAiChain(systemPrompt, userPrompt, env);
    const start = Number(result?.startIndex);
    const end = Number(result?.endIndex);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= sentences.length) return null;
    return { start, end };
  } catch (e) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// env.AI.run()은 fetch가 아니라 바인딩 호출이라 AbortSignal이 안 먹힘 — Promise.race로 강제 타임아웃.
// (이게 없어서 응답이 하염없이 안 돌아오면 진행률이 특정 %에서 영원히 멈추는 문제가 있었음)
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} 타임아웃(${ms}ms)`)), ms)),
  ]);
}

// [2026-09-07 00:35] 정확도 개선 — 예전엔 "관련 있음/없음"만 판단했는데, 이제 겹치는 단어 개수로
// "얼마나" 관련 있는지 점수를 매김. 검색 결과 여러 개 중 가장 점수 높은 걸 고르는 데 씀.
function relevanceScore(query, metaText) {
  if (!metaText) return 0;
  const stopwords = new Set(['the', 'and', 'with', 'for', 'from', 'this', 'that']);
  const queryWords = query.toLowerCase().split(/[^a-z0-9가-힣]+/).filter((w) => w.length >= 3 && !stopwords.has(w));
  if (!queryWords.length) return 1; // 쿼리 자체가 너무 짧으면 걸러낼 기준이 없으니 일단 통과 취급
  const lowerMeta = metaText.toLowerCase();
  return queryWords.reduce((score, w) => score + (lowerMeta.includes(w) ? 1 : 0), 0);
}
// 검색 결과가 실제로 쿼리랑 관련 있는지 대충 확인 — Pixabay tags / Pexels alt 텍스트에
// 쿼리 단어가 하나라도 들어있으면 "관련 있음"으로 판단. 이걸 통과 못 하면 그 이미지는 버리고
// 다음 소스(Pexels → 그래도 없으면 FLUX 생성)로 넘어가게 함.
function isRelevantMatch(query, metaText) {
  return relevanceScore(query, metaText) > 0;
}

async function searchPixabayImage(query, env, attempt = 0) {
  if (!env.PIXABAY_API_KEY) return null;
  try {
    // [2026-09-07 00:35] per_page 3→8로 늘려서 고를 후보를 넓힘(정확도 개선)
    const res = await fetch(`https://pixabay.com/api/?key=${env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=8&safesearch=true`, { signal: AbortSignal.timeout(10000) });
    if (res.status === 429 && attempt < 2) {
      await res.text().catch(() => {});
      const backoffMs = 800 * (attempt + 1); // 레이트리밋이면 잠깐 쉬었다가 최대 2번 더 시도
      console.log(`Pixabay 요청 제한("${query}"), ${backoffMs}ms 대기 후 재시도`);
      await sleep(backoffMs);
      return searchPixabayImage(query, env, attempt + 1);
    }
    if (!res.ok) {
      await res.text().catch(() => {}); // body 미소비 시 "stalled response" 경고 발생 방지 (429 등 빈번함)
      console.log(`Pixabay 검색 실패("${query}"): HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const hits = data?.hits || [];
    if (!hits.length) return null;
    // [2026-09-07 00:35] 정확도 개선 — 1등만 보고 안 맞으면 포기하던 것을, 후보들 중 태그 겹침
    // 점수가 가장 높은 걸 고르는 방식으로 변경(더 정확한 이미지를 찾을 확률이 크게 올라감)
    let best = null;
    let bestScore = 0;
    for (const hit of hits) {
      const score = relevanceScore(query, hit.tags);
      if (score > bestScore) { bestScore = score; best = hit; }
    }
    if (!best) {
      console.log(`Pixabay 결과 ${hits.length}개 다 "${query}"랑 안 맞아 보임 — 건너뜀`);
      return null;
    }
    const imageUrl = best?.largeImageURL || best?.webformatURL;
    if (!imageUrl) return null;
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) {
      await imgRes.text().catch(() => {});
      return null;
    }
    const buffer = await imgRes.arrayBuffer();
    if (!isUsableImage(buffer)) {
      console.log(`Pixabay 이미지가 너무 작아(용량 기준) 못 씀("${query}"): ${buffer.byteLength}바이트`);
      return null;
    }
    return buffer;
  } catch (e) {
    console.log(`Pixabay 검색 오류("${query}"): ${e.name === 'TimeoutError' ? '응답 지연으로 타임아웃' : e.message}`);
    return null;
  }
}

async function searchPexelsImage(query, env, attempt = 0) {
  if (!env.PEXELS_API_KEY) return null;
  try {
    // [2026-09-07 00:35] per_page 1→8로 늘려서 고를 후보를 넓힘(정확도 개선)
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape`, {
      headers: { Authorization: env.PEXELS_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429 && attempt < 2) {
      await res.text().catch(() => {});
      const backoffMs = 800 * (attempt + 1);
      console.log(`Pexels 요청 제한("${query}"), ${backoffMs}ms 대기 후 재시도`);
      await sleep(backoffMs);
      return searchPexelsImage(query, env, attempt + 1);
    }
    if (!res.ok) {
      await res.text().catch(() => {}); // body 미소비 시 "stalled response" 경고 발생 방지
      console.log(`Pexels 검색 실패("${query}"): HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const photos = data?.photos || [];
    if (!photos.length) return null;
    // [2026-09-07 00:35] 정확도 개선 — 1등만 보고 안 맞으면 포기하던 것을, 후보들 중 alt 텍스트
    // 겹침 점수가 가장 높은 걸 고르는 방식으로 변경
    let best = null;
    let bestScore = 0;
    for (const photo of photos) {
      const score = relevanceScore(query, photo.alt);
      if (score > bestScore) { bestScore = score; best = photo; }
    }
    if (!best) {
      console.log(`Pexels 결과 ${photos.length}개 다 "${query}"랑 안 맞아 보임 — 건너뜀`);
      return null;
    }
    const imageUrl = best?.src?.large || best?.src?.medium;
    if (!imageUrl) return null;
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) {
      await imgRes.text().catch(() => {});
      return null;
    }
    const buffer = await imgRes.arrayBuffer();
    if (!isUsableImage(buffer)) {
      console.log(`Pexels 이미지가 너무 작아(용량 기준) 못 씀("${query}"): ${buffer.byteLength}바이트`);
      return null;
    }
    return buffer;
  } catch (e) {
    console.log(`Pexels 검색 오류("${query}"): ${e.name === 'TimeoutError' ? '응답 지연으로 타임아웃' : e.message}`);
    return null;
  }
}

async function searchUnsplashImage(query, env) {
  if (!env.UNSPLASH_ACCESS_KEY) return null;
  try {
    // [2026-09-07 00:35] per_page 1→5(요청 제한이 시간당 50건이라 늘려도 API 호출 횟수는 그대로임)
    const res = await fetch(`https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`, {
      headers: { Authorization: `Client-ID ${env.UNSPLASH_ACCESS_KEY}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await res.text().catch(() => {}); // 429(시간당 50건 제한)도 여기서 조용히 넘어감 — 어차피 폴백 체인 마지막이라 재시도 안 함
      console.log(`Unsplash 검색 실패("${query}"): HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const photos = data?.results || [];
    if (!photos.length) return null;
    // [2026-09-07 00:35] 정확도 개선 — 후보들 중 설명 텍스트 겹침 점수가 가장 높은 걸 고름
    let best = null;
    let bestScore = 0;
    for (const p of photos) {
      const altText = [p.alt_description, p.description].filter(Boolean).join(' ');
      const score = relevanceScore(query, altText);
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (!best) {
      console.log(`Unsplash 결과 ${photos.length}개 다 "${query}"랑 안 맞아 보임 — 건너뜀`);
      return null;
    }
    const imageUrl = best?.urls?.regular || best?.urls?.small;
    if (!imageUrl) return null;
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) {
      await imgRes.text().catch(() => {});
      return null;
    }
    const buffer = await imgRes.arrayBuffer();
    if (!isUsableImage(buffer)) {
      console.log(`Unsplash 이미지가 너무 작아(용량 기준) 못 씀("${query}"): ${buffer.byteLength}바이트`);
      return null;
    }
    return buffer;
  } catch (e) {
    console.log(`Unsplash 검색 오류("${query}"): ${e.name === 'TimeoutError' ? '응답 지연으로 타임아웃' : e.message}`);
    return null;
  }
}

async function getSceneImage(scene, topic, env) {
  // 1순위: Pixabay — 규모가 크고(1900만+) 빠름(다운로드 위주라 FLUX 생성보다 훨씬 짧게 걸림)
  let image = await searchPixabayImage(scene.keyword, env);
  if (image) {
    console.log(`Pixabay 이미지 사용(장면 키워드): "${scene.keyword}"`);
    return image;
  }
  if (scene.keyword !== topic) {
    image = await searchPixabayImage(topic, env);
    if (image) {
      console.log(`Pixabay 이미지 사용(주제 검색): "${topic}"`);
      return image;
    }
  }

  // 2순위: Pexels — 마찬가지로 라이선스 안전한 스톡사진, Pixabay에 없을 때 보조
  image = await searchPexelsImage(scene.keyword, env);
  if (image) {
    console.log(`Pexels 이미지 사용(장면 키워드): "${scene.keyword}"`);
    return image;
  }
  if (scene.keyword !== topic) {
    image = await searchPexelsImage(topic, env);
    if (image) {
      console.log(`Pexels 이미지 사용(주제 검색): "${topic}"`);
      return image;
    }
  }

  // 3순위: Unsplash — 퀄리티는 제일 좋은 편인데 요청 제한(시간당 50건)이 셋 중 제일 빡빡해서 마지막에 배치
  image = await searchUnsplashImage(scene.keyword, env);
  if (image) {
    console.log(`Unsplash 이미지 사용(장면 키워드): "${scene.keyword}"`);
    return image;
  }
  if (scene.keyword !== topic) {
    image = await searchUnsplashImage(topic, env);
    if (image) {
      console.log(`Unsplash 이미지 사용(주제 검색): "${topic}"`);
      return image;
    }
  }

  // 4순위: 실사진을 못 찾았을 때만 FLUX로 생성(느림, 최후 수단)
  console.log(`실사진 소스 전부 실패(장면/주제 둘 다), FLUX로 생성: "${scene.keyword}"`);
  // FLUX는 네거티브 프롬프트가 아예 안 먹혀서(구조적 제약), 원하는 걸 긍정문으로 항상 덧붙여줌
  const qualitySuffix = ', photorealistic, sharp focus, natural lighting, high detail, professional photography';
  image = await generateSceneImage(scene.prompt + qualitySuffix, env);
  if (image) return image;

  console.log(`모든 이미지 소스 실패: "${scene.keyword}"`);
  return null;
}

// [2026-08-30 19:10] ---------- 영상 클립 검색 (장면 일부를 사진 대신 실사 클립으로) ----------
// 영상당 클립 CLIP_TARGET개 + 나머지는 사진. 연관성(isRelevantMatch) 통과 못 하면 클립을 포기하고
// 사진으로 폴백 — "아무 클립이나"보다 "관련 있는 사진"이 낫다는 방침. 클립 소스도 사진과 같은
// Pixabay/Pexels 무료 스톡(같은 API 키), 다운로드가 커서 해상도 1280 이하 변형만 고름.
const CLIP_TARGET = 3; // 영상 하나당 목표 클립 수
const CLIP_MAX_BYTES = 30 * 1024 * 1024; // 이 이상은 다운로드/렌더링 부담이 커서 스킵
const CLIP_MIN_BYTES = 100 * 1024; // 너무 작으면 썸네일급 저품질일 가능성
const CLIP_DURATION_RANGE = [3, 60]; // 초 — 너무 짧으면 루프 티가 나고, 너무 길면 파일이 큼

// [2026-08-30 19:10] Pixabay 영상 검색 — 사진 검색과 같은 키, hits[].videos에 해상도별 변형이 옴.
async function searchPixabayClip(query, env, attempt = 0) {
  if (!env.PIXABAY_API_KEY) return null;
  try {
    const res = await fetch(`https://pixabay.com/api/videos/?key=${env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&per_page=3&safesearch=true`, { signal: AbortSignal.timeout(10000) });
    if (res.status === 429 && attempt < 2) {
      await res.text().catch(() => {});
      await sleep(800 * (attempt + 1));
      return searchPixabayClip(query, env, attempt + 1);
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      console.log(`Pixabay 클립 검색 실패("${query}"): HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    for (const hit of data?.hits || []) {
      if (!isRelevantMatch(query, hit.tags)) continue; // 연관성 없으면 다음 후보
      if (hit.duration < CLIP_DURATION_RANGE[0] || hit.duration > CLIP_DURATION_RANGE[1]) continue;
      // 1280 이하 변형 중 가장 큰 것(보통 medium=1280, small=960)
      const variants = Object.values(hit.videos || {}).filter((v) => v?.url && v.width && v.width <= 1280);
      variants.sort((a, b) => b.width - a.width);
      const v = variants[0];
      if (!v || (v.size && v.size > CLIP_MAX_BYTES)) continue;
      const clipRes = await fetch(v.url, { signal: AbortSignal.timeout(20000) });
      if (!clipRes.ok) { await clipRes.text().catch(() => {}); continue; }
      const buffer = await clipRes.arrayBuffer();
      if (buffer.byteLength < CLIP_MIN_BYTES || buffer.byteLength > CLIP_MAX_BYTES) continue;
      console.log(`Pixabay 클립 사용("${query}"): ${hit.duration}s, ${v.width}px, ${Math.round(buffer.byteLength / 1024)}KB`);
      return buffer;
    }
    return null;
  } catch (e) {
    console.log(`Pixabay 클립 검색 오류("${query}"): ${e.name === 'TimeoutError' ? '응답 지연으로 타임아웃' : e.message}`);
    return null;
  }
}

// [2026-08-30 19:10] Pexels 영상 검색 — 태그가 따로 없어서 영상 페이지 URL 슬러그(설명 단어 포함)로 연관성 판단.
async function searchPexelsClip(query, env, attempt = 0) {
  if (!env.PEXELS_API_KEY) return null;
  try {
    const res = await fetch(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=3&orientation=landscape`, {
      headers: { Authorization: env.PEXELS_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 429 && attempt < 2) {
      await res.text().catch(() => {});
      await sleep(800 * (attempt + 1));
      return searchPexelsClip(query, env, attempt + 1);
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      console.log(`Pexels 클립 검색 실패("${query}"): HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    for (const video of data?.videos || []) {
      if (!isRelevantMatch(query, video.url)) continue; // URL 슬러그에 설명 단어가 들어있음
      if (video.duration < CLIP_DURATION_RANGE[0] || video.duration > CLIP_DURATION_RANGE[1]) continue;
      const files = (video.video_files || []).filter((f) => f?.link && f.file_type === 'video/mp4' && f.width && f.width <= 1280);
      files.sort((a, b) => b.width - a.width);
      const f = files[0];
      if (!f) continue;
      const clipRes = await fetch(f.link, { signal: AbortSignal.timeout(20000) });
      if (!clipRes.ok) { await clipRes.text().catch(() => {}); continue; }
      const buffer = await clipRes.arrayBuffer();
      if (buffer.byteLength < CLIP_MIN_BYTES || buffer.byteLength > CLIP_MAX_BYTES) continue;
      console.log(`Pexels 클립 사용("${query}"): ${video.duration}s, ${f.width}px, ${Math.round(buffer.byteLength / 1024)}KB`);
      return buffer;
    }
    return null;
  } catch (e) {
    console.log(`Pexels 클립 검색 오류("${query}"): ${e.name === 'TimeoutError' ? '응답 지연으로 타임아웃' : e.message}`);
    return null;
  }
}

// [2026-08-30 19:10] 장면 하나에 쓸 클립 찾기 — 장면 키워드 → 주제 순서로 검색, 연관성 통과 못 하면 null(사진 폴백).
async function getSceneClip(scene, topic, env) {
  let clip = await searchPixabayClip(scene.keyword, env);
  if (clip) return clip;
  clip = await searchPexelsClip(scene.keyword, env);
  if (clip) return clip;
  if (scene.keyword !== topic) {
    clip = await searchPixabayClip(topic, env);
    if (clip) return clip;
    clip = await searchPexelsClip(topic, env);
    if (clip) return clip;
  }
  return null;
}

async function generateSceneImage(prompt, env) {
  if (!env.AI) return null;
  try {
    // flux-1-schnell은 prompt/seed/steps만 지원 (width/height 파라미터 없음 — FLUX.2 계열 얘기와 다름)
    // steps 4(기본) → 6으로 올려서 품질 개선(최대 8, 그 이상은 효과 미미하고 느려지기만 함)
    // 네거티브 프롬프트는 구조상 아예 안 먹혀서 품질 키워드는 프롬프트 자체(긍정문)에 미리 박아둠(generateScenePrompts 참고)
    const response = await withTimeout(env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt,
      steps: 6,
    }, { gateway: { id: CF_AI_GATEWAY } }), 25000, 'FLUX 이미지 생성');
    if (!response?.image) return null;
    const binary = atob(response.image);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  } catch (e) {
    console.log('이미지 생성 실패: ' + e.message);
    return null;
  }
}

// Chirp3-HD: Google의 최신 생성형 TTS, Wavenet보다 훨씬 인간미 있는 억양/호흡 표현.
// 단점: speakingRate/pitch 파라미터를 아예 지원 안 함(넣으면 400 에러) — audioConfig는 인코딩만.
const KOREAN_TTS_VOICES_NATURAL = [
  'ko-KR-Chirp3-HD-Aoede', 'ko-KR-Chirp3-HD-Kore', 'ko-KR-Chirp3-HD-Leda',
  'ko-KR-Chirp3-HD-Charon', 'ko-KR-Chirp3-HD-Puck', 'ko-KR-Chirp3-HD-Orus',
];
// Chirp3-HD가 실패할 경우(지역/쿼터 이슈 등) 대비한 예전 세대 폴백
const KOREAN_TTS_VOICES_FALLBACK = ['ko-KR-Wavenet-A', 'ko-KR-Wavenet-B', 'ko-KR-Wavenet-C', 'ko-KR-Wavenet-D'];

// 영상 하나에서 쓸 목소리를 한 번만 뽑아 고정 — 문장(세그먼트)별로 음성을 따로 합성하게 되면서,
// 호출마다 랜덤으로 뽑으면 문장마다 목소리가 바뀌어버리기 때문. 자막 폰트/색과 같은 원리.
function pickTtsVoices() {
  return {
    natural: KOREAN_TTS_VOICES_NATURAL[Math.floor(Math.random() * KOREAN_TTS_VOICES_NATURAL.length)],
    fallback: KOREAN_TTS_VOICES_FALLBACK[Math.floor(Math.random() * KOREAN_TTS_VOICES_FALLBACK.length)],
  };
}

// voices: {natural, fallback} — 지정하면 그 목소리로 고정(세그먼트 합성용), 없으면 시도마다 랜덤(예전 동작).
async function generateNarrationAudio(text, env, voices) {
  if (!env.GOOGLE_TTS_API_KEY) {
    return { buffer: null, error: 'GOOGLE_TTS_API_KEY 환경변수 미설정' };
  }
  const trimmed = text.slice(0, 3000); // Google Cloud TTS는 요청당 5000바이트 제한이라 여유있게 자름

  // 버그였던 지점: fetch()가 타임아웃(AbortSignal)이나 네트워크 오류로 "실패 응답"이 아니라 "예외"를
  // 던지면, 이 함수에 try/catch가 없어서 그 예외가 그대로 generateNarrationAudio 바깥 catch까지
  // 뚫고 나가버렸음 — 그러면 Chirp3-HD 2번째 시도는커녕 Wavenet/MeloTTS 폴백까지 전부 건너뛰고
  // "1번 타임아웃 = 그 패스 전체 포기"가 돼버림(RETRIES_PER_TIER를 아무리 올려도 소용없었던 이유).
  // 실제 로그("3차 전량 실패 — 오류: The operation was aborted due to timeout")가 이 패턴과 정확히 일치.
  // 여기서 잡아서 { ok:false } 로 정상 반환해야 재시도/폴백 루프가 원래 설계대로 다음 시도로 넘어감.
  const tryVoice = async (voiceName, useNaturalConfig) => {
    const audioConfig = useNaturalConfig
      ? { audioEncoding: 'MP3' } // Chirp3-HD는 속도/피치 파라미터 자체를 거부함
      : { audioEncoding: 'MP3', speakingRate: 0.9 };
    try {
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: trimmed },
          voice: { languageCode: 'ko-KR', name: voiceName },
          audioConfig,
        }),
        signal: AbortSignal.timeout(30000), // Chirp3-HD가 긴 텍스트에선 20초를 넘기는 경우가 있어서 여유를 둠
      });
      if (!res.ok) {
        const bodyText = await res.text();
        return { ok: false, error: `HTTP ${res.status} — ${bodyText.slice(0, 300)}` };
      }
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: `요청 실패(타임아웃/네트워크): ${e.message}` };
    }
  };

  try {
    // 각 목소리군마다 최대 2번씩 시도(사이에 잠깐 대기) — 일시적인 오류(타임아웃, 순간 과부하 등)면
    // 재시도로 넘어갈 수 있는데, 예전엔 한 번 실패하면 바로 포기해서 음성 없이 발행되는 경우가 잦았음.
    const RETRIES_PER_TIER = 3;
    const attemptErrors = [];
    let voiceName = null;
    let attempt = null;

    for (let i = 0; i < RETRIES_PER_TIER && !attempt?.ok; i++) {
      voiceName = voices?.natural || KOREAN_TTS_VOICES_NATURAL[Math.floor(Math.random() * KOREAN_TTS_VOICES_NATURAL.length)];
      attempt = await tryVoice(voiceName, true);
      if (!attempt.ok) {
        attemptErrors.push(`Chirp3-HD 시도${i + 1}(${voiceName}) 실패: ${attempt.error}`);
        if (i < RETRIES_PER_TIER - 1) await sleep(1000);
      }
    }

    if (!attempt.ok) {
      for (let i = 0; i < RETRIES_PER_TIER && !attempt.ok; i++) {
        voiceName = voices?.fallback || KOREAN_TTS_VOICES_FALLBACK[Math.floor(Math.random() * KOREAN_TTS_VOICES_FALLBACK.length)];
        attempt = await tryVoice(voiceName, false);
        if (!attempt.ok) {
          attemptErrors.push(`Wavenet 시도${i + 1}(${voiceName}) 실패: ${attempt.error}`);
          if (i < RETRIES_PER_TIER - 1) await sleep(1000);
        }
      }
    }

    // Google TTS 두 계열 다 실패하면, Workers AI 자체 TTS(MeloTTS)도 마지막으로 한 번 시도 —
    // 별도 API 키 필요 없이 이미 쓰고 있는 AI 바인딩 그대로라 부담 없이 끼워넣을 수 있는 마지막 카드.
    if (!attempt.ok && env.AI) {
      try {
        const meloResponse = await withTimeout(
          env.AI.run('@cf/myshell-ai/melotts', { prompt: trimmed, lang: 'ko' }, { gateway: { id: CF_AI_GATEWAY } }),
          20000, 'MeloTTS 음성합성'
        );
        if (meloResponse?.audio) {
          const binary = atob(meloResponse.audio);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          console.log('음성합성 성공 (Workers AI MeloTTS, 마지막 폴백)');
          return { buffer: bytes.buffer, error: null };
        }
        attemptErrors.push('MeloTTS 실패: 응답에 audio 없음');
      } catch (e) {
        attemptErrors.push(`MeloTTS 실패: ${e.message}`);
      }
    }

    if (!attempt.ok) {
      return { buffer: null, error: attemptErrors.join(' / ') };
    }

    const data = attempt.data;
    if (!data?.audioContent) {
      return { buffer: null, error: '응답에 audioContent 없음 — raw: ' + JSON.stringify(data).slice(0, 300) };
    }
    const binary = atob(data.audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    console.log(`음성합성 성공 (Google Cloud TTS, 목소리: ${voiceName})`);
    return { buffer: bytes.buffer, error: null };
  } catch (e) {
    return { buffer: null, error: `오류: ${e.message}` };
  }
}

// generateNarrationAudio 하나가 이미 Chirp3-HD 3회 + Wavenet 3회 + MeloTTS 1회(7번)를 시도하지만,
// 그래도 다 실패하면 예전엔 그냥 무음으로 발행돼버렸음. 여기서 그 전체 패스를 한 번 더 감싸서
// 총 3패스(최대 21번 시도)까지 기다렸다가 포기하도록 함 — 순간적인 429/5xx/게이트웨이 hiccup 정도는
// 이 정도면 거의 다 흡수됨. API 키 자체가 없는 경우는 각 패스가 즉시 실패라 금방 끝남.
async function generateNarrationAudioWithRetry(text, env, maxAttempts = 3, voices = null) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await generateNarrationAudio(text, env, voices);
    if (result.buffer) {
      if (attempt > 1) console.log(`음성합성 ${attempt}차 시도에서 성공`);
      return result;
    }
    lastError = result.error;
    console.log(`음성합성 ${attempt}차 전체 실패: ${result.error}`);
    if (attempt < maxAttempts) await sleep(2000);
  }
  return { buffer: null, error: `음성합성 ${maxAttempts}차 전량 실패 — ${lastError}` };
}

// ---------- 문장(세그먼트)별 음성 합성 ----------
// 자막-음성 싱크의 근본 해결책: 나레이션 전체를 한 번에 합성하면 각 문장이 언제 시작하는지 알 방법이
// 없어서(Chirp3-HD는 SSML 타임포인트 미지원) 글자수로 추정할 수밖에 없고, 그 추정 오차가 누적돼 뒤로
// 갈수록 자막이 어긋났음. 무음 감지로 맞추는 시도도 실제 TTS(숨소리 섞인 사람 같은 음성)에선 불안정.
// → 문장을 몇 개씩 묶은 "세그먼트" 단위로 음성을 따로따로 합성하면, 릴레이(ffmpeg)가 각 조각의 실제
// 길이를 정확히 잰 뒤 이어붙이므로 세그먼트 경계마다 자막 타이밍이 구조적으로 정확해짐(추정이 아예 없음).

function splitIntoSentences(text) {
  return (text || '').split(/(?<=[.!?。！？])\s+/).filter(Boolean);
}

// [2026-08-30 19:25] 나레이션 텍스트 정규화 — 음성·자막 싱크에 유리한 형태로 다듬음.
// TTS가 기호를 예상 밖 길이로 읽으면(예: '%'→"퍼센트", 이모지 무시) 글자수 기반 줄 배분이 어긋나므로,
// 읽는 소리와 글자수가 일치하도록 기호를 한글로 바꾸거나 제거. 괄호는 기호만 벗기고 내용은 유지.
// 나레이션과 자막이 같은 이 텍스트를 쓰기 때문에 여기서 뭘 바꿔도 둘은 항상 일치함(본문 HTML은 원문 유지).
function sanitizeNarrationText(text) {
  return (text || '')
    .replace(/[…]+|\.{3,}/g, '.') // 말줄임표 → 마침표(TTS가 길게 끌지 않게)
    .replace(/[%％]/g, '퍼센트')
    .replace(/[℃]/g, '도')
    .replace(/[·•]/g, ', ') // 나열 기호 → 쉼표(TTS가 통째로 건너뛰는 걸 방지)
    .replace(/[()\[\]{}「」『』<>《》〈〉"'‘’“”]/g, ' ') // 괄호/따옴표 기호 제거(내용은 유지)
    .replace(/[^가-힣ᄀ-ᇿ0-9a-zA-Z.,!?~\s]/g, ' ') // 이모지 등 나머지 특수문자 제거
    .replace(/\s+([.,!?])/g, '$1') // 기호 제거로 생긴 "텍스트 ." 꼴 정리
    .replace(/\s+/g, ' ')
    .trim();
}

// [2026-08-30 19:25] 긴 문장은 쉼표에서 쪼갬 — 문장 하나가 세그먼트 상한(90자)을 넘으면 그 안에서는
// 글자수 추정 배분만 남아 싱크 이점이 줄어듦. 가운데에 가장 가까운 쉼표에서 갈라 두 문장처럼 취급
// (자막·음성 둘 다 같은 조각을 쓰므로 어색함 없음). 쪼갠 뒤에도 길면 재귀적으로 계속.
function splitLongSentence(sentence, maxChars = 100) {
  if (sentence.length <= maxChars) return [sentence];
  const mid = sentence.length / 2;
  let best = -1;
  for (let i = 0; i < sentence.length; i++) {
    if (sentence[i] === ',' && (best === -1 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  if (best <= 0 || best >= sentence.length - 1) return [sentence]; // 쉼표가 없으면 그대로 둠
  const head = sentence.slice(0, best + 1).trim();
  const tail = sentence.slice(best + 1).trim();
  return [...splitLongSentence(head, maxChars), ...splitLongSentence(tail, maxChars)];
}

// [2026-08-30 19:25] 나레이션 문장 배열 준비 — 정규화 → 문장 분리 → 긴 문장 쪼개기. 음성 합성과 자막이
// 모두 이 결과를 쓰는 단일 기준(같은 배열에서 세그먼트와 자막 비트가 나옴 → 싱크가 구조적으로 일치).
function prepareNarrationSentences(text) {
  return splitIntoSentences(sanitizeNarrationText(text)).flatMap((s) => splitLongSentence(s)).filter(Boolean);
}

// 나레이션이 상한을 넘으면 "문장이 끝나는 지점"에서 자름 — 예전처럼 글자수로 뚝 자르면
// 마지막 문장이 중간에 끊긴 채 읽히고 자막도 어색하게 끝났음.
function trimNarrationToSentence(text, maxChars) {
  if ((text || '').length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const m = cut.match(/[\s\S]*[.!?。！？]/);
  return m ? m[0] : cut;
}

// [2026-09-01] TTS가 갑자기 두 단어를 붙여서 급하게 읽는 현상 대응 — AI가 프롬프트 지시(마침표/쉼표 뒤
// 띄어쓰기)를 가끔 놓칠 수 있어서(분량 undershoot 때와 같은 패턴), 프롬프트만 믿지 않고 코드에서 한 번 더
// 강제 보정함. 마침표·물음표·느낌표·쉼표 뒤에 공백이 없으면 넣어주고, 문장부호 앞에 붙은 불필요한 공백은
// 제거해서 리듬이 자연스럽게 유지되게 함. 이 정규화는 자막 표시 문장과도 100% 동일 텍스트에 적용되므로
// 자막-음성 매칭에는 영향 없음(양쪽 다 같은 결과를 봄).
// [2026-09-06 23:15] TTS 발음 정정 — "42.195km" 같은 소수+단위 표기를 그냥 보내면 TTS가 소수점 뒤
// "195"를 하나의 수(백구십오)로 읽어버림(마라톤 "사십이점백구십오케이엠"). 원래는 소수점 뒤는 숫자를
// 하나씩(일구오) 읽어야 맞음. TTS에 보내기 전에 미리 올바른 한글 발음 문자열로 바꿔줌.
const SINO_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const SINO_UNITS_SMALL = ['', '십', '백', '천'];
const SINO_UNITS_BIG = ['', '만', '억', '조'];
function sinoKoreanNumber(n) {
  if (n === 0) return '영';
  const groups = [];
  let num = n;
  while (num > 0) {
    groups.push(num % 10000);
    num = Math.floor(num / 10000);
  }
  let result = '';
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    let groupStr = '';
    const digits = [Math.floor(g / 1000) % 10, Math.floor(g / 100) % 10, Math.floor(g / 10) % 10, g % 10];
    for (let d = 0; d < 4; d++) {
      const digit = digits[d];
      if (digit === 0) continue;
      // 십/백/천 자리의 "1"은 보통 생략해서 읽음(100=백, 일백 아님) — 단 만 단위(그룹) 자체가 1이면 자릿수 규칙과 무관하게 나중에 그냥 "만"으로 처리됨
      const digitStr = (digit === 1 && d < 3) ? '' : SINO_DIGITS[digit];
      groupStr += digitStr + SINO_UNITS_SMALL[3 - d];
    }
    result += groupStr + SINO_UNITS_BIG[i];
  }
  return result;
}
function decimalDigitsToKorean(decStr) {
  return decStr.split('').map((d) => SINO_DIGITS[parseInt(d, 10)] || '영').join('');
}
const TTS_UNIT_KOREAN = {
  km: '킬로미터', kg: '킬로그램', cm: '센티미터', mm: '밀리미터', m: '미터', g: '그램',
  kcal: '킬로칼로리', cal: '칼로리', mah: '밀리암페어시', l: '리터', ml: '밀리리터',
  '%': '퍼센트', '℃': '도',
};
// [2026-09-06 23:45] 정수(소수점 없는) + "항상 한자어(사·오·구...)로 읽는 단위" 조합도 변환.
// 예: "10분"을 그냥 두면 TTS가 고유어(열분)로 읽을 위험이 있음 — 시간/측정 단위는 숫자 크기와
// 무관하게 항상 한자어로 읽는 게 맞아서(3시간=세시간X, "세시간"이 아니라 "삼시간"?) 실제로는
// "시간"만 예외(한 시간/두 시간처럼 고유어 사용)이므로 시간(hour)은 목록에서 제외하고, 분/초/년/월/일
// 등 명확히 한자어로만 읽는 단위만 포함함. "개/명/살/번/마리" 같은 고유어 전용 단위는 절대 포함하지 않음
// (포함하면 오히려 틀리게 됨 — 예: "3개"는 "삼개"가 아니라 "세 개"가 맞음).
const SINO_ONLY_UNITS = ['분', '초', '개월', '년', '월', '일', '주일', '회', '차', '원'];
function normalizeNumbersForTts(text) {
  let result = (text || '').replace(/(\d+)\.(\d+)\s*(km|kg|cm|mm|kcal|mah|ml|cal|[a-zA-Z%℃]{1,4})?/gi, (match, intPart, decPart, unit) => {
    const intKr = sinoKoreanNumber(parseInt(intPart, 10));
    const decKr = decimalDigitsToKorean(decPart);
    const unitKr = unit ? (TTS_UNIT_KOREAN[unit.toLowerCase()] || TTS_UNIT_KOREAN[unit] || unit) : '';
    return `${intKr}점${decKr}${unitKr}`;
  });
  result = result.replace(/(\d+)\s*(km|kg|cm|mm|kcal|mah|ml|cal|%|℃)/gi, (match, intPart, unit) => {
    const unitKr = TTS_UNIT_KOREAN[unit.toLowerCase()] || TTS_UNIT_KOREAN[unit] || unit;
    return `${sinoKoreanNumber(parseInt(intPart, 10))}${unitKr}`;
  });
  const sinoUnitPattern = new RegExp(`(\\d+)(${SINO_ONLY_UNITS.join('|')})`, 'g');
  result = result.replace(sinoUnitPattern, (match, intPart, unit) => `${sinoKoreanNumber(parseInt(intPart, 10))}${unit}`);
  return result;
}

function normalizeNarrationSpacing(text) {
  return normalizeNumbersForTts(text || '')
    .replace(/\s+([.!?,])/g, '$1') // 문장부호 앞의 공백 제거(". " 처럼 앞에 붙어있던 경우)
    .replace(/([.!?,])(?=\S)/g, '$1 ') // 문장부호 뒤에 공백이 없으면 하나 넣음(붙여 읽기 방지의 핵심)
    .replace(/\s+/g, ' ')
    .trim();
}

// 인접 문장을 maxChars 이내로 묶어 세그먼트 목록을 만듦 — 너무 잘게 나누면 TTS 호출이 많아지고
// 문장 사이 억양이 뚝뚝 끊기므로 적당히 묶되, 한 세그먼트 안에서의 자막 줄 배분(글자수 비례 추정)
// 오차가 눈에 안 띄게 세그먼트를 짧게 유지함. 반환: [{ text, sentences: [문장...] }]
function planAudioSegments(sentences, maxChars) {
  const segments = [];
  let current = [];
  let currentLen = 0;
  for (const s of sentences) {
    if (current.length && currentLen + s.length > maxChars) {
      segments.push({ text: current.join(' '), sentences: current });
      current = [];
      currentLen = 0;
    }
    current.push(s);
    currentLen += s.length;
  }
  if (current.length) segments.push({ text: current.join(' '), sentences: current });
  return segments;
}

// 세그먼트들을 순서대로 이어붙인 하나의 mp3 버퍼 — 웹 슬라이드쇼 재생용(post.audio).
// mp3는 프레임 단위 포맷이라 단순 바이트 연결로도 대부분의 플레이어에서 정상 재생됨.
function concatAudioBuffers(buffers) {
  const total = buffers.reduce((a, b) => a + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

async function buildVeoPrompt(topic, articleTitle, env) {
  const systemPrompt = '너는 짧은 AI 생성 영상을 위한 크리에이티브 디렉터다. 주어진 주제와 글 제목을 참고해서 Google Veo에 넣을 영상 생성 프롬프트를 하나 작성한다. 장면 묘사, 카메라 움직임, 조명을 구체적으로 포함하고 5~8초 분량의 장면 하나로 압축한다. 실제 인물/유명인/브랜드 로고를 특정해서 묘사하지 않는다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"prompt": "Veo에 넣을 프롬프트 문장"}';
  const userPrompt = `주제: ${topic}\n글 제목: ${articleTitle}`;
  const { result } = await callAiChain(systemPrompt, userPrompt, env);
  if (result?.prompt) return result.prompt;
  return `${topic}을(를) 표현하는 짧고 차분한 영상. 다큐멘터리 스타일의 자연스러운 장면, 부드러운 조명, 절제된 카메라 움직임.`;
}

async function startVeoOperation(prompt, env) {
  let res;
  try {
    res = await fetch(`${VEO_BASE_URL}/models/${VEO_MODEL}:predictLongRunning`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({ instances: [{ prompt }] }),
    });
  } catch (e) {
    return { ok: false, error: `Veo 시작 네트워크 오류: ${e.message}` };
  }
  if (!res.ok) {
    const bodyText = await res.text();
    return { ok: false, error: `Veo 시작 실패 HTTP ${res.status}: ${bodyText.slice(0, 300)}` };
  }
  const data = await res.json();
  if (!data?.name) return { ok: false, error: `operation name 없음 — raw: ${JSON.stringify(data).slice(0, 300)}` };
  return { ok: true, operationName: data.name };
}

async function fetchVeoVideoBytes(videoUri, videoBase64, env) {
  if (videoBase64) {
    const binary = atob(videoBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  const res = await fetch(videoUri, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
  if (!res.ok) throw new Error(`영상 다운로드 실패: HTTP ${res.status}`);
  return await res.arrayBuffer();
}

const SITE_ORIGIN = 'https://videos.usb.kr'; // Oracle 릴레이가 외부에서 접근할 이미지/음성 URL의 기준 도메인

// ---------- 쿠팡파트너스 관련 상품 추천 — 작업: 2026-09-07 01:10 ----------
// 주제로 상품을 검색해서 글 하단에 파트너스 링크로 게시함. 오픈API는 HMAC-SHA256 서명이 필요
// (쿠팡파트너스 공식 예제 방식 그대로 구현). COUPANG_ACCESS_KEY/COUPANG_SECRET_KEY 시크릿 필요 —
// 둘 다 없으면 이 기능은 조용히 건너뜀(글 생성 자체가 막히면 안 되므로).
function coupangSignedDate() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear()).slice(2)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}
async function coupangAuthHeader(method, pathAndQuery, env) {
  const [path, query] = pathAndQuery.split('?');
  const datetime = coupangSignedDate();
  const message = datetime + method + path + (query || '');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.COUPANG_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const signature = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`;
}
// 주제로 관련 상품 검색 — 응답 필드는 쿠팡 공식 문서 기준으로 짰지만, 실제 승인 계정으로 첫 호출
// 해보고 필드명이 다르면(예: data.productData vs data) 로그로 원본을 남겨서 바로 확인 가능하게 함.
// ---------- 첨부 미디어 AI 분석(장면 이미지 검색 정확도 향상용) — 작업: 2026-09-07 01:45 ----------
// 사용자가 직접 첨부한 미디어를 SambaNova 비전 모델로 분석해서 "뭐가 나오는지" 짧게 설명을 뽑고,
// 그 설명을 generateScenePrompts에 같이 넘겨서 AI가 만드는 나머지 장면들이 첨부 미디어의 분위기/
// 소재와 더 잘 어울리게(검색 키워드가 더 정확하게) 유도함. Gemini는 막혀있어서 안 씀.
async function analyzeAttachedMediaForContext(imageBuffer, contentType, env) {
  if (!env.SAMBANOVA_API_KEY) return '';
  try {
    const base64 = arrayBufferToBase64(imageBuffer);
    const res = await fetch('https://api.sambanova.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.SAMBANOVA_API_KEY}` },
      body: JSON.stringify({
        model: 'Llama-4-Maverick-17B-128E-Instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '이 이미지에 뭐가 나오는지 영어로 짧게(10단어 이내) 스톡사진 검색어처럼 설명해줘. 다른 말은 하지 말고 설명만.' },
            { type: 'image_url', image_url: { url: `data:${contentType || 'image/jpeg'};base64,${base64}` } },
          ],
        }],
        temperature: 0.3,
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      console.log(`첨부 미디어 분석 실패: HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    return (data?.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.log(`첨부 미디어 분석 오류: ${e.message}`);
    return '';
  }
}

async function searchCoupangProducts(keyword, env, limit = 3) {
  if (!env.COUPANG_ACCESS_KEY || !env.COUPANG_SECRET_KEY) return [];
  try {
    const pathAndQuery = `/v2/providers/affiliate_open_api/apis/openapi/products/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
    const auth = await coupangAuthHeader('GET', pathAndQuery, env);
    const res = await fetch(`https://api-gateway.coupang.com${pathAndQuery}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      console.log(`쿠팡 상품검색 실패("${keyword}"): HTTP ${res.status} ${bodyText.slice(0, 300)}`);
      return [];
    }
    const data = await res.json();
    // 문서 기준 productData 배열 — 혹시 필드명이 다르면 raw를 로그로 남겨 확인
    const products = data?.data?.productData || data?.rData?.productData || data?.data || [];
    if (!Array.isArray(products) || !products.length) {
      console.log(`쿠팡 상품검색 결과 없음/형식 다름("${keyword}"): ${JSON.stringify(data).slice(0, 300)}`);
      return [];
    }
    return products.slice(0, limit).map((p) => ({
      name: p.productName || p.title || '',
      price: p.productPrice || p.price || null,
      image: p.productImage || p.imageUrl || '',
      url: p.productUrl || p.url || '',
      isRocket: !!(p.isRocket || p.rocket),
    })).filter((p) => p.url);
  } catch (e) {
    console.log(`쿠팡 상품검색 오류("${keyword}"): ${e.message}`);
    return [];
  }
}


// [2026-08-30 23:31] 스레드 공유 캡션 — 훅 / 요약 / 해시태그 / 링크를 빈 줄로 나눠 보기 좋게 구성.
// AI가 줄바꿈 없이 한 덩어리로 준 경우에도 첫 문장(훅)과 해시태그를 분리해 자동으로 재구성함.
function buildThreadsCaption(p) {
  const raw = (p.threadsText || '').trim();
  let bodyText = raw;
  if (raw && !raw.includes('\n')) {
    const tags = (raw.match(/#[^\s#]+/g) || []).join(' ');
    const rest = raw.replace(/#[^\s#]+/g, '').replace(/\s+/g, ' ').trim();
    const m = rest.match(/^(.+?[.!?])\s*(.*)$/);
    bodyText = m && m[2] ? `${m[1]}\n\n${m[2]}` : rest;
    if (tags) bodyText += `\n\n${tags}`;
  }
  if (!bodyText) bodyText = `${p.title || ''}\n${p.topic || ''}`.trim();
  const link = p.youtubeUrl || `${SITE_ORIGIN}/${p.slug}`;
  return `${bodyText}\n\n🎬 영상 보기 👉 ${link}\n\n— 제로지`;
}

// Oracle Always Free VM(kiwoomapi 릴레이와 동일 서버)에서 ffmpeg로 직접 렌더링 — 완전 무료,
// 결과 mp4는 릴레이가 R2(usbkr-videos)에 바로 업로드하므로 Worker는 재다운로드할 필요 없음.
async function startRelayRender(imageKeys, audioKey, audioSegmentKeys, outputKey, shortOutputKeys, weights, captionBeats, captionFontKey, captionColor, env, highlightSegRange) {
  if (!env.RELAY_URL || !env.RELAY_SECRET) return { ok: false, error: 'RELAY_URL/RELAY_SECRET 환경변수가 설정 안 됨' };
  if (!imageKeys.length) return { ok: false, error: '원본 이미지가 없음' };

  const imageUrls = imageKeys.map((k) => `${SITE_ORIGIN}/media/${k}`);
  const audioUrl = audioKey ? `${SITE_ORIGIN}/media/${audioKey}` : null;
  // 세그먼트 원본 목록 — 릴레이가 각각의 실제 길이를 재서 이어붙이고, 자막 타이밍을 실측으로 맞추는 데 씀.
  const audioSegments = Array.isArray(audioSegmentKeys) && audioSegmentKeys.length
    ? audioSegmentKeys.map((k) => `${SITE_ORIGIN}/media/${k}`)
    : null;

  try {
    // [2026-08-31 00:33] 렌더링 전 메모리 정리 — 오래된 작업 제거 + GC 강제 실행
    try {
      const cleanupRes = await fetch(`${env.RELAY_URL}/cleanup`, {
        method: 'POST',
        headers: { 'x-relay-secret': env.RELAY_SECRET },
        signal: AbortSignal.timeout(5000),
      });
      // cleanup 실패는 경고만 하고 계속 진행
      if (!cleanupRes.ok) console.warn(`relay cleanup 실패: HTTP ${cleanupRes.status}`);
    } catch (cleanupErr) {
      console.warn(`relay cleanup 요청 오류: ${cleanupErr.message}`);
    }

    const res = await fetch(`${env.RELAY_URL}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-secret': env.RELAY_SECRET },
      // weights: 이미지별 노출시간 배분 비율, captionBeats: 이미지별 자막 "비트" 배열(그 이미지가 떠 있는
      // 동안 순서대로 갈아끼울 문장들 — drawtext에 시간대별로 나눠서 그림; 비트마다 segIndex로 음성 세그먼트 매핑)
      // captionFontKey/captionColor: 이 영상 전체에 고정으로 쓸 폰트 키/색 하나(위치도 영상당 하나로 고정 — captionBeats의 styleIndex가 이미 전부 동일한 값으로 옴)
      // [2026-09-02 21:05] highlightSegRange: 쇼츠를 잘라낼 하이라이트 문장 구간(있으면 relay가 이 구간만
      // 사용, 없으면 예전처럼 도입/중간/결론 후보 로직으로 폴백)
      body: JSON.stringify({ images: imageUrls, audioUrl, audioSegments, outputKey, shortOutputKeys, weights, captionBeats, captionFontKey, captionColor, highlightSegRange: highlightSegRange || null }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      return { ok: false, error: `릴레이 렌더링 요청 실패: HTTP ${res.status} — ${bodyText.slice(0, 400)}` };
    }
    const data = await res.json();
    if (!data?.jobId) return { ok: false, error: `릴레이 응답에 jobId 없음 — raw: ${JSON.stringify(data).slice(0, 400)}` };
    return { ok: true, jobId: data.jobId };
  } catch (e) {
    return { ok: false, error: `릴레이 요청 오류: ${e.message}` };
  }
}

// 렌더링 완료/실패 처리를 공통 함수로 분리 — 5분 크론뿐 아니라 admin 페이지가 실시간으로 상태를
// 물어볼 때도(handleRenderProgress) 그 자리에서 바로 반영시켜서, "완료라고 뜨는데 실제로는 최대 5분
// 기다려야 반영되는" 시차를 없앰.
async function finalizeRenderDone(job, renderJobKeyName, env, ctx) {
  const postRaw = await env.POSTS.get(`post:${job.slug}`);
  if (postRaw) {
    const post = JSON.parse(postRaw);
    post.video = job.r2Key;
    if (job.durationSec) post.videoDurationSec = job.durationSec; // [2026-09-01] 관리자 목록에 "몇 분짜리"로 표시
    // [2026-08-30 22:14] 숏츠가 실제로 R2에 있는지 확인해 기록(릴레이가 조건에 따라 건너뛸 수 있어 head로 검증)
    const shortKeyList = Array.isArray(job.shortKeys) ? job.shortKeys : (job.shortKey ? [job.shortKey] : []); // [2026-08-30 22:55] 숏츠 3개 지원
    const existingShorts = [];
    for (const sk of shortKeyList) {
      const head = await env.MEDIA.head(sk).catch(() => null);
      if (head) existingShorts.push(sk);
    }
    if (existingShorts.length) {
      post.videoShorts = existingShorts;
      post.videoShort = existingShorts[0]; // 하위호환(기존 표시/다운로드 코드)
    }

    // mp4가 완성되면 이미지·mp3(세그먼트 포함)는 더 이상 필요 없음(웹 화면도 이제 mp4 하나만 보여줌) — 전부 삭제하고 mp4만 남김
    const toDelete = [...(post.images || []), ...(post.audioSegments || [])];
    if (post.audio) toDelete.push(post.audio);
    if (toDelete.length) {
      await Promise.all(toDelete.map((k) => env.MEDIA.delete(k).catch(() => {})));
    }
    post.images = [];
    post.audio = null;
    post.audioSegments = [];

    await env.POSTS.put(`post:${job.slug}`, JSON.stringify(post));

    // 유튜브 자동 업로드 — 응답/크론을 안 붙잡고 백그라운드로 돌림(ctx.waitUntil). 실패해도 글은 그대로 살려두고
    // youtubeError만 남김(음성처럼 삭제하진 않음 — 유튜브는 부가 기능이라 실패가 발행 자체를 막을 이유는 없음).
    const uploadPromise = triggerYoutubeUpload(job.slug, job.r2Key, env);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(uploadPromise);
    else await uploadPromise;
  } else {
    // [2026-09-02 18:45] 고아 mp4 자동청소 — post가 삭제/취소된 상태로 렌더가 끝나면 결과물을 R2에서 지운다
    const orphanKeys = [job.r2Key, ...(Array.isArray(job.shortKeys) ? job.shortKeys : (job.shortKey ? [job.shortKey] : []))].filter(Boolean);
    if (orphanKeys.length && env.MEDIA) {
      await Promise.all(orphanKeys.map((k) => env.MEDIA.delete(k).catch(() => {})));
      console.log(`[${renderJobKeyName}] post 없음 — 고아 렌더 결과물 삭제: ${orphanKeys.join(', ')}`);
    }
  }
  await env.POSTS.delete(renderJobKeyName);
  console.log(`[${renderJobKeyName}] 릴레이 렌더링 완료 및 저장: ${job.r2Key}`);
}

// ---------- 유튜브 자동 업로드 ----------
// refresh_token으로 access_token을 매번 새로 발급받음(access_token은 수명이 짧아서 캐싱 안 하고 그때그때 발급).
async function getYoutubeAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.YOUTUBE_CLIENT_ID,
      client_secret: env.YOUTUBE_CLIENT_SECRET,
      refresh_token: env.YOUTUBE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`access_token 발급 실패: HTTP ${res.status} — ${bodyText.slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error(`access_token 응답에 값 없음: ${JSON.stringify(data).slice(0, 300)}`);
  return data.access_token;
}

// ---------- R2 정리 큐 — 작업: 2026-09-06 04:00 ----------
// 유튜브 업로드가 성공해도 유튜브 쪽에서 처리(인코딩)가 끝나기 전까지는 실제로 재생이 안 될 수 있음.
// 그 틈에 R2 원본까지 지워버리면 어디서도 재생 안 되는 공백이 생길 수 있어서, 업로드 성공 직후 바로
// 지우지 않고 큐에 넣어둠 — 이후 폴링에서 유튜브 조회수가 실제로 2회 이상 찍힌 걸 확인한 뒤에야
// (= 유튜브에서 정상 재생되고 있다는 증거) R2에서 지움.
const R2_CLEANUP_QUEUE_KEY = 'r2CleanupQueue';
const R2_CLEANUP_VIEW_THRESHOLD = 2;
async function getR2CleanupQueue(env) {
  const raw = await env.POSTS.get(R2_CLEANUP_QUEUE_KEY);
  if (!raw) return [];
  try {
    const q = JSON.parse(raw);
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}
async function saveR2CleanupQueue(items, env) {
  await env.POSTS.put(R2_CLEANUP_QUEUE_KEY, JSON.stringify(items)).catch(() => {});
}
async function enqueueR2Cleanup(item, env) {
  const queue = await getR2CleanupQueue(env);
  queue.push(item);
  await saveR2CleanupQueue(queue, env);
}
async function getYoutubeViewCount(videoId, env) {
  try {
    const accessToken = await getYoutubeAccessToken(env);
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${encodeURIComponent(videoId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      return null;
    }
    const data = await res.json();
    const stats = data?.items?.[0]?.statistics;
    return stats ? (parseInt(stats.viewCount, 10) || 0) : null;
  } catch (e) {
    console.log(`유튜브 조회수 확인 실패(${videoId}): ${e.message}`);
    return null;
  }
}
// 1분 크론(및 relay의 20초 cron-tick)이 호출 — 큐에 쌓인 항목마다 조회수를 확인해서 기준 넘으면 R2 삭제.
async function pollR2CleanupQueue(env) {
  const queue = await getR2CleanupQueue(env);
  if (!queue.length) return;
  const remaining = [];
  for (const item of queue) {
    const postRaw = await env.POSTS.get(`post:${item.slug}`);
    if (!postRaw) continue; // 글 자체가 이미 삭제됨(R2도 그때 같이 정리됐을 것) — 큐에서도 그냥 제거
    const viewCount = await getYoutubeViewCount(item.youtubeId, env);
    if (viewCount != null && viewCount >= R2_CLEANUP_VIEW_THRESHOLD) {
      await env.MEDIA.delete(item.r2Key).catch(() => {});
      const post = JSON.parse(postRaw);
      if (item.kind === 'main') {
        post.videoDeletedFromR2 = true;
      } else {
        if (!Array.isArray(post.videoShortsDeletedFromR2)) post.videoShortsDeletedFromR2 = [];
        post.videoShortsDeletedFromR2[item.idx] = true;
      }
      await env.POSTS.put(`post:${item.slug}`, JSON.stringify(post)).catch(() => {});
      console.log(`[r2-cleanup] ${item.slug} ${item.kind} 조회수 ${viewCount}회 확인 — R2 삭제: ${item.r2Key}`);
    } else {
      remaining.push(item); // 아직 기준 미달(또는 조회 실패) — 다음 틱에 재확인
    }
  }
  if (remaining.length !== queue.length) await saveR2CleanupQueue(remaining, env);
}

// YouTube Data API v3 resumable upload — 세션을 먼저 열고(POST) 실제 영상 바이트를 청크 단위로 PUT함.
// 예전엔 한 번에 통째로 PUT했지만, 그러면 업로드 도중 진행률을 전혀 알 수 없어서(관리자 화면이 "업로드 중"에서
// 멈춰있음) 8MiB씩 나눠 순차 PUT하고, 청크가 성공할 때마다 onProgress(percent)로 진행률을 알려줌.
const YOUTUBE_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024; // YouTube 리줌 업로드 규격상 256KiB의 배수여야 함 — 8MiB는 배수
// [2026-08-30 22:13] opts.shorts: 숏츠 업로드 모드 — 제목에 #Shorts 추가(세로 + 60초 이내라 유튜브가 자동으로 숏츠 분류)
async function uploadVideoToYoutube(post, videoBuffer, env, onProgress, opts = {}) {
  if (!env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN) {
    return { ok: false, error: 'YOUTUBE_CLIENT_ID/CLIENT_SECRET/REFRESH_TOKEN 환경변수 미설정' };
  }
  try {
    const accessToken = await getYoutubeAccessToken(env);
    const description = `${stripHtml(post.intro).slice(0, 400)}\n\n작성자: 제로지\n원문: ${SITE_ORIGIN}/${post.slug}`;
    const shortsSuffix = opts.shorts ? `${opts.partTotal > 1 ? ` (${opts.partNo}/${opts.partTotal})` : ''} #Shorts` : ''; // [2026-08-30 22:55] 숏츠 여러 개면 (1/3) 식으로 제목 구분
    // 유튜브 tags 정제: 빈 문자열/null 제거, 개수 제한(≤10), 각 태그 50자 이하
    const sanitizeTag = (t) => (typeof t === 'string' ? t.trim().replace(/[<>"{}|\\^`\[\]]/g, '').slice(0, 50) : '');
    const tags = [post.topic, ...(post.tags || [])].map(sanitizeTag).filter((t) => t.length > 0).slice(0, 10);
    const metadata = {
      snippet: {
        title: (post.title || post.topic || 'life.news').slice(0, 100 - shortsSuffix.length) + shortsSuffix,
        description: description.slice(0, 4900),
        tags: tags.length > 0 ? tags : undefined, // 유튜브: tags 배열이 비면 필드 자체 제거
        categoryId: '25', // News & Politics — 생활뉴스 성격에 맞춤
      },
      status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
    };
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(videoBuffer.byteLength),
      },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(20000),
    });
    if (!initRes.ok) {
      const bodyText = await initRes.text();
      return { ok: false, error: `업로드 세션 생성 실패: HTTP ${initRes.status} — ${bodyText.slice(0, 300)}`, quotaExceeded: isQuotaExceededBody(bodyText) };
    }
    const uploadUrl = initRes.headers.get('Location');
    if (!uploadUrl) return { ok: false, error: '업로드 세션 응답에 Location 헤더 없음' };

    const total = videoBuffer.byteLength;
    let uploaded = 0;
    let finalData = null;
    if (onProgress) await onProgress(0);
    while (uploaded < total) {
      const end = Math.min(uploaded + YOUTUBE_UPLOAD_CHUNK_SIZE, total);
      const chunk = videoBuffer.slice(uploaded, end);
      const chunkRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(chunk.byteLength),
          'Content-Range': `bytes ${uploaded}-${end - 1}/${total}`,
        },
        body: chunk,
        signal: AbortSignal.timeout(60000), // 청크 하나(최대 8MiB)당 타임아웃 — 전체를 한 번에 기다리지 않아도 됨
      });
      if (chunkRes.status === 200 || chunkRes.status === 201) {
        // 마지막 청크까지 다 받으면 여기서 완성된 video 리소스(JSON)를 돌려줌
        finalData = await chunkRes.json();
        uploaded = end;
        if (onProgress) await onProgress(100);
        break;
      }
      if (chunkRes.status === 308) {
        // 중간 청크 정상 접수 — Range 헤더로 서버가 실제 받은 바이트 수를 알려주면 그걸 신뢰, 없으면 방금 보낸 만큼으로 간주
        const rangeHeader = chunkRes.headers.get('Range'); // 형식: "bytes=0-8388607"
        const match = rangeHeader && /bytes=0-(\d+)/.exec(rangeHeader);
        uploaded = match ? parseInt(match[1], 10) + 1 : end;
        if (onProgress) await onProgress(Math.floor((uploaded / total) * 100));
        continue;
      }
      const bodyText = await chunkRes.text().catch(() => '');
      return { ok: false, error: `영상 업로드 실패: HTTP ${chunkRes.status} — ${bodyText.slice(0, 300)}`, quotaExceeded: isQuotaExceededBody(bodyText) };
    }
    if (!finalData || !finalData.id) return { ok: false, error: `업로드 응답에 video id 없음: ${JSON.stringify(finalData || {}).slice(0, 300)}` };
    return { ok: true, youtubeId: finalData.id, youtubeUrl: `https://youtu.be/${finalData.id}` };
  } catch (e) {
    return { ok: false, error: `유튜브 업로드 오류: ${e.message}` };
  }
}

// KV에 저장된 post의 유튜브 업로드 진행률만 갱신 — 관리자 화면 폴링이 이 값을 읽어 "업로드 중 N%"로 표시함.
async function updateYoutubeUploadPercent(slug, percent, env) {
  try {
    const raw = await env.POSTS.get(`post:${slug}`);
    if (!raw) return;
    const p = JSON.parse(raw);
    p.youtubeUploadPercent = percent;
    await env.POSTS.put(`post:${slug}`, JSON.stringify(p));
  } catch (e) {
    console.log(`[youtube:${slug}] 진행률 저장 실패(무시하고 계속 업로드): ${e.message}`);
  }
}

// [2026-08-31 00:07] relay.js health check — 주기적으로 폴링 → 3회 연속 실패 시 자동 재시작 시도
let relayHealthFailCount = 0;
// ---------- Oracle Cloud VM 사용량 표시 — 작업: 2026-09-06 01:00 ----------
// OCI API는 요청마다 RSA-SHA256 서명이 필요함(https://docs.oracle.com/iaas/Content/API/Concepts/signingrequests.htm).
// Workers엔 Node crypto가 없어서 Web Crypto(SubtleCrypto)로 직접 구현. 개인키는 PKCS8 PEM 형식이라
// (-----BEGIN PRIVATE KEY-----) importKey('pkcs8', ...)에 바로 씀 — RSA PRIVATE KEY(PKCS1) 형식이면 이 방식이 안 통함.
function pemToArrayBuffer(pem) {
  // [2026-09-06 01:10] BEGIN/END 마커 밖에 다른 텍스트가 붙어있어도(예: 파일 라벨 "OCI_API_KEY" 같은 게
  // 끝에 같이 붙는 경우) 그건 무시하고 마커 "사이"의 내용만 정확히 뽑아냄 — atob 깨지던 원인
  const match = pem.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  const clean = (match ? match[1] : pem).replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importOciPrivateKey(pem) {
  return crypto.subtle.importKey('pkcs8', pemToArrayBuffer(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

async function sha256Base64(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let binary = '';
  new Uint8Array(digest).forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

async function arrayBufferToBase64Async(buf) {
  let binary = '';
  new Uint8Array(buf).forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

// method: 'GET'|'POST', url: 전체 URL 문자열, bodyObj: POST일 때 JSON 바디(없으면 null)
async function ociSignedRequest(env, method, url, bodyObj) {
  const u = new URL(url);
  const date = new Date().toUTCString(); // RFC 1123 형식 — OCI가 요구하는 date 헤더 형식과 일치
  const keyId = `${env.OCI_TENANCY_OCID}/${env.OCI_USER_OCID}/${env.OCI_FINGERPRINT}`;
  const requestTarget = `${method.toLowerCase()} ${u.pathname}${u.search}`;

  let headersToSign = ['(request-target)', 'date', 'host'];
  let signingLines = [`(request-target): ${requestTarget}`, `date: ${date}`, `host: ${u.host}`];
  const fetchHeaders = { date, host: u.host };

  let bodyStr = null;
  if (bodyObj != null) {
    bodyStr = JSON.stringify(bodyObj);
    const contentSha256 = await sha256Base64(bodyStr);
    headersToSign = [...headersToSign, 'content-length', 'content-type', 'x-content-sha256'];
    signingLines = [...signingLines, `content-length: ${bodyStr.length}`, `content-type: application/json`, `x-content-sha256: ${contentSha256}`];
    fetchHeaders['content-length'] = String(bodyStr.length);
    fetchHeaders['content-type'] = 'application/json';
    fetchHeaders['x-content-sha256'] = contentSha256;
  }

  const privateKey = await importOciPrivateKey(env.OCI_PRIVATE_KEY);
  const signatureBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingLines.join('\n')));
  const signature = await arrayBufferToBase64Async(signatureBuf);

  fetchHeaders.authorization = `Signature version="1",headers="${headersToSign.join(' ')}",keyId="${keyId}",algorithm="rsa-sha256",signature="${signature}"`;

  return fetch(url, { method, headers: fetchHeaders, body: bodyStr });
}

// 지정 메트릭의 최근 1시간 평균값을 하나 가져옴(Monitoring API summarizeMetricsData) — 실패하면 null
// [2026-09-06 01:20] 버그 수정 — mql에 [1h] 구간을 쓰면서 resolution도 1m으로 요청하니 "1시간 롤링
// 합계"가 1분마다 찍혀서 마지막 값 하나만 써도 실제보다 훨씬 크게 나왔음(네트워크가 200GB로 보이던 원인).
// [1m] 구간으로 바꿔서 분당 값들을 받은 뒤, CPU는 평균(mean of means)·네트워크는 합계(총 전송량)로
// 직접 집계함 — 이래야 진짜 "최근 1시간" 수치가 됨.
async function fetchOciMetricSeries(env, mql, startTime, endTime, resolution = '1m') {
  try {
    const region = env.OCI_REGION;
    const url = `https://telemetry.${region}.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?compartmentId=${encodeURIComponent(env.OCI_TENANCY_OCID)}`;
    const res = await ociSignedRequest(env, 'POST', url, {
      namespace: 'oci_computeagent',
      query: mql,
      resolution,
      startTime: (startTime || new Date(Date.now() - 60 * 60 * 1000)).toISOString(),
      endTime: (endTime || new Date()).toISOString(),
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      return null;
    }
    const data = await res.json();
    const points = data?.[0]?.aggregatedDatapoints;
    return Array.isArray(points) && points.length ? points : null;
  } catch (e) {
    console.log(`OCI 메트릭 조회 실패(${mql}): ${e.message}`);
    return null;
  }
}

// 관리자 페이지 상단에 표시할 값들을 한 번에 모음 — OCI 시크릿이 없으면(설정 전) 조용히 null 반환.
async function getOracleVmStats(env) {
  if (!env.OCI_USER_OCID || !env.OCI_TENANCY_OCID || !env.OCI_FINGERPRINT || !env.OCI_PRIVATE_KEY || !env.OCI_REGION || !env.OCI_INSTANCE_OCID) {
    return null;
  }
  try {
    const filter = `{resourceId = "${env.OCI_INSTANCE_OCID}"}`;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); // 이번 달 1일 00:00 UTC
    const [cpuPoints, netInPoints, netOutPoints, monthNetOutPoints] = await Promise.all([
      fetchOciMetricSeries(env, `CpuUtilization[1m]${filter}.mean()`),
      fetchOciMetricSeries(env, `NetworksBytesIn[1m]${filter}.mean()`),
      fetchOciMetricSeries(env, `NetworksBytesOut[1m]${filter}.mean()`),
      // [2026-09-06 02:20] "내가 쓸 수 있는 양" — Oracle Free Tier에서 실제로 한도가 있는 건
      // 아웃바운드(외부로 나가는) 네트워크뿐(월 10TB, 넘으면 과금). 컴퓨트/스토리지는 이 VM 스펙
      // 안에서는 원래 무료라 별도 한도 표시가 의미 없어서 제외. 한 달치라 데이터가 많아 1시간 해상도로 조회.
      fetchOciMetricSeries(env, `NetworksBytesOut[1h]${filter}.mean()`, monthStart, now, '1h'),
    ]);
    const avgOf = (pts) => (pts && pts.length ? pts.reduce((a, b) => a + b.value, 0) / pts.length : null);
    // [2026-09-06 01:30] NetworksBytesIn/Out은 분당 전송량이 아니라 부팅 이후 계속 늘어나는 누적
    // 카운터로 보임(합계를 냈더니 60배로 부풀려짐) — "마지막 값 - 처음 값"으로 그 1시간 동안
    // 늘어난 양만 계산. 재부팅 등으로 카운터가 리셋돼 값이 줄어들면(음수) 그냥 마지막 값을 씀.
    const deltaOf = (pts) => {
      if (!pts || pts.length < 2) return null;
      const delta = pts[pts.length - 1].value - pts[0].value;
      return delta >= 0 ? delta : pts[pts.length - 1].value;
    };
    const cpu = avgOf(cpuPoints); // CPU는 분당 평균들의 평균 — 지난 1시간 평균 사용률
    const netIn = deltaOf(netInPoints);
    const netOut = deltaOf(netOutPoints);
    const monthNetOut = deltaOf(monthNetOutPoints);
    const FREE_EGRESS_LIMIT_GB = 10 * 1024; // Oracle Always Free 아웃바운드 한도: 월 10TB
    return {
      cpuPercent: typeof cpu === 'number' ? Math.round(cpu * 10) / 10 : null,
      netInMb: typeof netIn === 'number' ? Math.round((netIn / 1024 / 1024) * 10) / 10 : null,
      netOutMb: typeof netOut === 'number' ? Math.round((netOut / 1024 / 1024) * 10) / 10 : null,
      monthNetOutGb: typeof monthNetOut === 'number' ? Math.round((monthNetOut / 1024 / 1024 / 1024) * 100) / 100 : null,
      egressLimitGb: FREE_EGRESS_LIMIT_GB,
    };
  } catch (e) {
    console.log(`Oracle VM 사용량 조회 실패: ${e.message}`);
    return null;
  }
}

async function checkRelayHealth(env) {
  if (!env.RELAY_URL || !env.RELAY_SECRET) return; // env 미설정이면 체크 스킵
  try {
    const res = await fetch(`${env.RELAY_URL}/health`, {
      headers: { 'x-relay-secret': env.RELAY_SECRET },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      relayHealthFailCount = 0; // 성공하면 카운트 리셋
      console.log(`[relay-health] OK: ${data.status}, ${data.processingJobCount} jobs rendering`);
      return { ok: true, ...data };
    } else {
      relayHealthFailCount++;
      console.log(`[relay-health] HTTP ${res.status}, fail count: ${relayHealthFailCount}`);
    }
  } catch (e) {
    relayHealthFailCount++;
    console.log(`[relay-health] 폴링 실패: ${e.message}, fail count: ${relayHealthFailCount}`);
  }
  // 3회 연속 실패 → 자동 재시작 시도
  if (relayHealthFailCount >= 3) {
    console.log(`[relay-health] 3회 연속 실패 → 자동 재시작 시도 (주소: ${env.RELAY_URL})`);
    relayHealthFailCount = 0; // 재시작 시도 후 카운트 리셋(반복 호출 방지)
    // 실제 재시작은 관리자가 수동으로 하거나, SSH로 systemctl restart를 호출할 env 권한이 필요
    // 지금은 알림만 하고, 향후 SSH/systemctl 권한 있으면 자동 실행
    try {
      await env.POSTS.put(`relay:health-alert`, JSON.stringify({
        alert: '⚠️ relay 응답 없음 — 3회 폴링 실패. 수동 재시작 필요.',
        failedAt: new Date().toISOString(),
        relayUrl: env.RELAY_URL,
      }), { expirationTtl: 30 * 60 }); // 30분 유지
      console.log(`[relay-health] 알림 저장 완료`);
    } catch (e) {
      console.log(`[relay-health] 알림 저장 실패: ${e.message}`);
    }
  }
  return { ok: false };
}

// mp4가 R2(env.MEDIA)에 올라간 직후 호출 — 그 자리에서 바로 바이트를 읽어 유튜브에 올리고 결과를 post에 반영.
// [2026-08-31] 유튜브 일일 업로드 할당량(태평양 시간 자정 리셋) 초과를 다른 실패(네트워크 오류, 파일 문제 등)와
// 구분해서 감지 — 이거여야 "내일 자동 재시도"가 의미 있음(다른 실패는 재시도해도 똑같이 실패할 뿐).
function isQuotaExceededBody(bodyText) {
  return /quotaExceeded|dailyLimitExceeded/i.test(bodyText || '');
}

// 유튜브 할당량은 매일 태평양 시간(America/Los_Angeles) 자정에 리셋됨 — 지금 시각 기준으로
// "다음 자정 + 5분 여유"를 밀리초 타임스탬프로 계산. DST 전환일 근처엔 몇 분 오차 있을 수 있는데
// 재시도 타이밍이라 치명적이지 않음(그 정도는 몇 분 일찍/늦게 재시도돼도 무방).
function nextYoutubeQuotaResetMs() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  const y = get('year'), mo = get('month'), d = get('day'), h = get('hour'), mi = get('minute'), s = get('second');
  // "지금 태평양시간 벽시계"를 UTC로 착각하고 만든 값과 실제 now의 차이 = 현재 UTC-PT 오프셋(ms)
  const offsetMs = now.getTime() - Date.UTC(y, mo - 1, d, h, mi, s);
  const nextMidnightAsUtc = Date.UTC(y, mo - 1, d + 1, 0, 0, 0);
  return nextMidnightAsUtc + offsetMs + 5 * 60 * 1000; // 5분 여유
}

// [2026-08-31] 할당량 초과로 막힌 영상들을 "순서가 있는 큐"로 관리 — 개별 재시도 시각을 각자 따로 예약하던
// 방식(ytRetry:슬러그) 대신, 하나의 KV 키에 순번이 있는 목록을 유지함. 막힌 순서대로 쌓이고, 리셋 시각이
// 지나면 크론이 맨 앞부터 하나씩 차례로 다시 시도 — 본편이든 숏츠든 같은 큐로 관리.
const YT_QUEUE_KEY = 'ytUploadQueue';
async function getYoutubeQueue(env) {
  const raw = await env.POSTS.get(YT_QUEUE_KEY);
  if (!raw) return { items: [], nextAttemptAt: null };
  try {
    const q = JSON.parse(raw);
    return { items: Array.isArray(q.items) ? q.items : [], nextAttemptAt: q.nextAttemptAt || null };
  } catch {
    return { items: [], nextAttemptAt: null };
  }
}
async function saveYoutubeQueue(queue, env) {
  await env.POSTS.put(YT_QUEUE_KEY, JSON.stringify(queue)).catch(() => {});
}
// 이 슬러그가 큐에서 몇 번째인지(1부터) — 없으면 null. admin 화면에 순번 표시용.
async function getYoutubeQueuePosition(slug, env) {
  const queue = await getYoutubeQueue(env);
  const idx = queue.items.findIndex((it) => it.slug === slug);
  return idx === -1 ? null : idx + 1;
}
// 할당량 초과로 여전히 막혀있으면 큐에 남겨두고(이미 있으면 순번 그대로, 없으면 맨 뒤에 새로 추가) 다음
// 리셋 시각을 갱신 — 성공했거나 할당량과 무관한 실패로 확정되면 큐에서 뺌(재시도해도 소용없으므로).
async function updateYoutubeQueue(slug, stillBlocked, env) {
  const queue = await getYoutubeQueue(env);
  const idx = queue.items.findIndex((it) => it.slug === slug);
  if (stillBlocked) {
    if (idx === -1) queue.items.push({ slug, addedAt: Date.now() }); // 새로 막힌 것 — 맨 뒤에 추가(도착 순서 = 순번)
    queue.nextAttemptAt = nextYoutubeQuotaResetMs();
    await saveYoutubeQueue(queue, env);
    const whenText = new Date(queue.nextAttemptAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    console.log(`[youtube:${slug}] 할당량 초과 — 대기열 ${idx === -1 ? queue.items.length : idx + 1}번째, ${whenText} 이후 재시도`);
    return `오늘 유튜브 업로드 할당량을 다 써서 실패했어요. 대기열 ${idx === -1 ? queue.items.length : idx + 1}번째로 등록됐고, ${whenText} 이후 차례가 되면 자동으로 재시도됩니다.`;
  }
  if (idx !== -1) {
    queue.items.splice(idx, 1);
    await saveYoutubeQueue(queue, env);
  }
  return null;
}

// 1분 크론이 호출 — 리셋 시각이 지났으면 큐 맨 앞의 항목 "딱 하나만" 다시 시도(한 틱에 여러 건 몰아서
// 시도하면 할당량 재확인 없이 연달아 실패만 반복할 수 있어서, 한 번에 하나씩 순서대로 처리함).
// 결과에 따라 triggerYoutubeUpload 내부에서 큐 순번을 알아서 갱신(성공/영구실패=제거, 계속 막힘=유지+다음날 예약).
async function pollYoutubeQuotaRetries(env) {
  const queue = await getYoutubeQueue(env);
  if (!queue.items.length) return;
  if (queue.nextAttemptAt && Date.now() < queue.nextAttemptAt) return; // 아직 리셋 시각 안 됨
  // 맨 앞부터 훑되, 글 자체가 삭제됐거나 mp4가 없어진 무효 항목은 건너뛰지 말고 즉시 큐에서 제거하고 다음 항목으로.
  while (queue.items.length) {
    const front = queue.items[0];
    const postRaw = await env.POSTS.get(`post:${front.slug}`);
    if (!postRaw) { queue.items.shift(); await saveYoutubeQueue(queue, env); continue; }
    const post = JSON.parse(postRaw);
    if (!post.video) { queue.items.shift(); await saveYoutubeQueue(queue, env); continue; }
    console.log(`[youtube-retry] 대기열 1번째(${front.slug}) 재업로드 시도`);
    await triggerYoutubeUpload(front.slug, post.video, env); // 성공/실패 판정 후 큐 갱신은 내부에서 처리
    return; // 한 틱에 하나만 — 다음 시도는 다음 분 크론에서
  }
}

async function triggerYoutubeUpload(slug, r2Key, env) {
  const uploadStartMs = Date.now(); // [2026-08-30 19:45] 업로드 소요시간 측정(관리자 표시용)
  try {
    const postRaw0 = await env.POSTS.get(`post:${slug}`);
    if (!postRaw0) return;
    const post0 = JSON.parse(postRaw0);

    // [2026-08-31] 큐 재시도로 다시 불렸을 때, 본편이 이전 시도에서 이미 성공했다면 또 업로드하면 안 됨
    // (중복 업로드 방지) — 이미 youtubeUrl이 있으면 본편은 건너뛰고 결과를 그대로 재사용.
    let result;
    if (post0.youtubeUrl) {
      result = { ok: true, youtubeId: post0.youtubeId, youtubeUrl: post0.youtubeUrl };
    } else {
      const videoObj = await env.MEDIA.get(r2Key);
      if (!videoObj) {
        console.log(`[youtube:${slug}] mp4를 MEDIA에서 못 찾음(${r2Key}) — 업로드 스킵`);
        return;
      }
      const videoBuffer = await videoObj.arrayBuffer();
      result = await uploadVideoToYoutube(post0, videoBuffer, env, (percent) => updateYoutubeUploadPercent(slug, percent, env));
    }
    const freshRaw = await env.POSTS.get(`post:${slug}`); // 업로드 도중 post가 또 바뀌었을 수 있으니 최신본에 병합
    if (!freshRaw) return;
    const freshPost = JSON.parse(freshRaw);
    freshPost.youtubeUploadPercent = null; // 끝났으니 진행률 표시는 지우고 youtubeUrl/youtubeError로 결과만 남김
    if (!post0.youtubeUrl) freshPost.youtubeUploadSec = Math.round((Date.now() - uploadStartMs) / 1000); // 이번에 실제로 업로드했을 때만 갱신
    let mainStillBlocked = false;
    if (result.ok) {
      freshPost.youtubeId = result.youtubeId;
      freshPost.youtubeUrl = result.youtubeUrl;
      freshPost.youtubeError = null;
      freshPost.youtubeQuotaExceeded = false;
      if (!post0.youtubeUrl) console.log(`[youtube:${slug}] 본편 업로드 성공: ${result.youtubeUrl}`);
      // [2026-09-06 04:00] 유튜브 업로드 직후 바로 R2를 지우지 않음 — 유튜브 쪽 처리(인코딩)가 아직
      // 안 끝났으면 그 사이엔 어디서도 재생이 안 되는 공백이 생길 수 있음. 대신 큐에 등록해서, 이후
      // 폴링에서 실제로 조회수가 쌓인 걸 확인(=유튜브에서 정상 재생 중이라는 증거)한 뒤에 R2 삭제.
      if (!post0.videoDeletedFromR2 && !post0.videoR2CleanupQueued && r2Key) {
        await enqueueR2Cleanup({ slug, kind: 'main', youtubeId: result.youtubeId, r2Key }, env);
        freshPost.videoR2CleanupQueued = true;
      }
    } else {
      mainStillBlocked = !!result.quotaExceeded;
      freshPost.youtubeErrorRaw = result.error;
      freshPost.youtubeQuotaExceeded = !!result.quotaExceeded;
      console.log(`[youtube:${slug}] 본편 업로드 실패${result.quotaExceeded ? '(할당량 초과)' : ''}: ${result.error}`);
      if (!result.quotaExceeded) freshPost.youtubeError = result.error; // 할당량 문구는 아래서 큐 상태 보고 통일해서 채움
    }

    // [2026-08-30 23:56] 숏츠 업로드 — 본편이 아직 막혀있으면(이번에 막혔든, 전부터 막혀있었든) 숏츠도 어차피
    // 막힐 게 뻔하니 시도 자체를 건너뜀. 본편이 이미 됐으면(이전 성공분 포함) 숏츠 중 "아직 안 된 것만" 시도 —
    // 이미 성공한 숏츠를 또 올리는 중복 업로드를 막기 위함(큐 재시도 시 특히 중요).
    const allShortKeys = Array.isArray(freshPost.videoShorts) && freshPost.videoShorts.length
      ? freshPost.videoShorts : (freshPost.videoShort ? [freshPost.videoShort] : []);
    const prevShortsUrls = Array.isArray(freshPost.youtubeShortsUrls) ? freshPost.youtubeShortsUrls : [];
    const mainReady = !!freshPost.youtubeUrl;
    let anyShortStillBlocked = false;
    freshPost.youtubeShortsSkippedReason = (!mainReady) ? '본편이 아직 할당량 초과로 막혀있어서 숏츠는 시도하지 않음(본편 성공 시 함께 시도됨)' : null;

    if (mainReady && allShortKeys.length) {
      const nextUrls = new Array(allShortKeys.length).fill(null);
      const nextErrors = new Array(allShortKeys.length).fill(null);
      const toAttempt = [];
      allShortKeys.forEach((k, si) => {
        if (prevShortsUrls[si]) { nextUrls[si] = prevShortsUrls[si]; return; } // 이미 성공 — 재시도 안 함
        toAttempt.push(si);
      });
      if (toAttempt.length) {
        const results = await Promise.all(toAttempt.map(async (si) => {
          const shortKey = allShortKeys[si];
          try {
            const shortObj = await env.MEDIA.get(shortKey);
            if (!shortObj) return { index: si, ok: false, error: 'R2에서 숏츠 파일을 못 찾음', quotaExceeded: false };
            const shortBuffer = await shortObj.arrayBuffer();
            const shortResult = await uploadVideoToYoutube(freshPost, shortBuffer, env, null, { shorts: true, partNo: si + 1, partTotal: allShortKeys.length });
            if (shortResult.ok) {
              console.log(`[youtube:${slug}] 숏츠 ${si + 1} 업로드 성공: ${shortResult.youtubeUrl}`);
              return { index: si, ok: true, url: shortResult.youtubeUrl, youtubeId: shortResult.youtubeId };
            }
            console.log(`[youtube:${slug}] 숏츠 ${si + 1} 업로드 실패${shortResult.quotaExceeded ? '(할당량 초과)' : ''}: ${shortResult.error}`);
            return { index: si, ok: false, error: shortResult.error, quotaExceeded: !!shortResult.quotaExceeded };
          } catch (e) {
            console.log(`[youtube:${slug}] 숏츠 ${si + 1} 업로드 예외: ${e.message}`);
            return { index: si, ok: false, error: e.message, quotaExceeded: false };
          }
        }));
        for (const r of results) {
          if (r.ok) {
            nextUrls[r.index] = r.url;
            // [2026-09-06 04:00] 즉시삭제 대신 큐에 등록 — 조회수 2회 이상 확인되면 폴링에서 R2 삭제
            await enqueueR2Cleanup({ slug, kind: 'short', idx: r.index, youtubeId: r.youtubeId, r2Key: allShortKeys[r.index] }, env);
          } else {
            nextErrors[r.index] = r.quotaExceeded ? '할당량 초과로 실패 — 대기열에서 차례가 되면 자동 재시도' : r.error;
            if (r.quotaExceeded) anyShortStillBlocked = true;
          }
        }
      }
      freshPost.youtubeShortsUrls = nextUrls;
      freshPost.youtubeShortsErrors = nextErrors;
      freshPost.youtubeShortsUrl = nextUrls[0] || null; // 하위호환
      freshPost.youtubeShortsError = nextErrors[0] || null;
    }

    // [2026-08-31] 본편이든 숏츠든 하나라도 여전히 할당량에 막혀있으면 큐에 유지(순번 부여)하고 다음 리셋
    // 시각을 다시 예약 — 전부 끝났거나(성공) 할당량과 무관한 확정 실패면 큐에서 뺌.
    const stillBlocked = mainStillBlocked || anyShortStillBlocked;
    const queueMsg = await updateYoutubeQueue(slug, stillBlocked, env);
    if (mainStillBlocked) freshPost.youtubeError = queueMsg; // 본편이 막힌 경우 안내 문구를 화면에 노출

    await env.POSTS.put(`post:${slug}`, JSON.stringify(freshPost));
  } catch (e) {
    console.log(`[youtube:${slug}] 업로드 처리 중 예외: ${e.message}`);
  }
}

// [2026-08-30 19:52] 렌더링 실패 기록 — 실패 이유가 화면에서 사라지지 않도록 KV에 3일간 보관.
// 특히 오디오 검증 실패(NO_AUDIO_TRACK)는 글 자체가 삭제돼서 이 기록이 유일한 흔적이 됨(관리자 상단에 표시).
// [2026-09-07 02:15] 글쓰기/이미지/음성 단계(genJob) 실패도 렌더링 실패와 똑같이 며칠간 기록을
// 남김 — 예전엔 실패 화면에 3분만 보이고 아무 흔적도 없이 지워져서, 그 사이 못 보면 원인을 영영
// 알 수 없었음(이번 "newsResults is not defined" 사례가 그 예).
async function recordGenFailure(id, topic, errMsg, env) {
  try {
    await env.POSTS.put(`genFail:${id}`, JSON.stringify({
      id, topic: (topic || '').slice(0, 100), error: (errMsg || '').slice(0, 500), at: new Date().toISOString(),
    }), { expirationTtl: 3 * 24 * 3600 });
  } catch (e) {
    console.log(`생성 실패 기록 실패(무시): ${e.message}`);
  }
}

async function recordRenderFailure(slug, errMsg, postDeleted, env) {
  try {
    const postRaw = await env.POSTS.get(`post:${slug}`);
    const title = postRaw ? (JSON.parse(postRaw).title || '') : '';
    await env.POSTS.put(`renderFail:${slug}`, JSON.stringify({
      slug, title, error: (errMsg || '').slice(0, 500), postDeleted: !!postDeleted, at: new Date().toISOString(),
    }), { expirationTtl: 3 * 24 * 3600 });
  } catch (e) {
    console.log(`렌더링 실패 기록 실패(무시): ${e.message}`);
  }
}

async function finalizeRenderFailed(job, renderJobKeyName, errMsg, env) {
  // relay.js가 "나레이션은 있었는데 최종 mp4에 오디오 트랙이 없음"을 NO_AUDIO_TRACK 마커로 알려주는 경우엔
  // 일반 렌더링 실패(videoError만 기록하고 슬라이드쇼로 계속 발행)와 다르게, 글 자체를 완전히 삭제함 —
  // 음성 없는 영상이 조용히 발행되는 걸 원천 차단.
  if (errMsg && errMsg.includes('NO_AUDIO_TRACK')) {
    await recordRenderFailure(job.slug, errMsg, true, env); // 삭제 전에 제목까지 기록
    await deletePostCompletely(job.slug, env);
    await env.POSTS.delete(renderJobKeyName);
    console.log(`[${renderJobKeyName}] 오디오 트랙 검증 실패로 글 삭제됨: ${job.slug} — ${errMsg}`);
    return;
  }
  await recordRenderFailure(job.slug, errMsg, false, env);
  const failedPostRaw = await env.POSTS.get(`post:${job.slug}`);
  if (failedPostRaw) {
    const failedPost = JSON.parse(failedPostRaw);
    failedPost.videoError = errMsg;
    await env.POSTS.put(`post:${job.slug}`, JSON.stringify(failedPost));
  }
  await env.POSTS.delete(renderJobKeyName);
  console.log(`[${renderJobKeyName}] 릴레이 렌더링 실패 — ${errMsg}`);
}

// 글(post)을 관련 미디어(이미지/음성/mp4)까지 포함해서 완전히 삭제 — 음성 검증 실패 시 등
// "조용히 무음으로 발행되느니 아예 안 나오는 게 낫다" 상황에서 씀.
async function deletePostCompletely(slug, env) {
  const postRaw = await env.POSTS.get(`post:${slug}`);
  if (postRaw) {
    const post = JSON.parse(postRaw);
    const toDelete = [...(post.images || []), ...(post.audioSegments || [])];
    if (post.audio) toDelete.push(post.audio);
    if (post.video) toDelete.push(post.video);
    if (post.videoShort) toDelete.push(post.videoShort); // [2026-08-30 22:14] 숏츠도 함께 정리
    (post.videoShorts || []).forEach((k) => { if (!toDelete.includes(k)) toDelete.push(k); }); // [2026-08-30 22:55] 숏츠 3개 전부
    if (toDelete.length) {
      await Promise.all(toDelete.map((k) => env.MEDIA.delete(k).catch(() => {})));
    }
  }
  await env.POSTS.delete(`post:${slug}`);
  const idxRaw = await env.POSTS.get('index');
  if (idxRaw) {
    const idx = JSON.parse(idxRaw);
    await env.POSTS.put('index', JSON.stringify(idx.filter((s) => s !== slug)));
  }
}

// [2026-08-31] relay가 재시작되면(예: 메모리 부족 후 수동 재시작) renderJobs 맵이 메모리에만 있어서 그
// 안의 진행 중이던 작업 정보가 전부 사라짐 — Worker가 예전 jobId로 계속 물어보면 relay는 "모르는 job"(404)이라고
// 답하는데, 예전엔 이걸 그냥 무시하고 넘어가서(연결 안 됨) 타임아웃 체크도 안 타고 영원히 "확인 중"에 멈춰있었음.
// 이제 post:슬러그에 남아있는 원본 재료(이미지/음성/자막 정보)로 렌더링을 새 jobId로 재제출함 — 최대 2번까지만
// 자동 재시도하고, 그래도 안 되면 명확히 실패 처리(무한 루프 방지).
async function resubmitLostRenderJob(job, keyInfoName, env) {
  const slug = job.slug;
  const resubmitCount = job.resubmitCount || 0;
  if (resubmitCount >= 2) {
    console.log(`[${keyInfoName}] relay가 job을 계속 잃어버림 — 2회 재제출해도 실패, 최종 실패 처리`);
    await finalizeRenderFailed(job, keyInfoName, 'relay가 렌더링 작업 정보를 잃어버렸습니다(재시작 등) — 2회 자동 재제출도 실패했습니다. relay 상태를 확인해주세요.', env);
    return;
  }
  const postRaw = await env.POSTS.get(`post:${slug}`);
  if (!postRaw) { await env.POSTS.delete(keyInfoName).catch(() => {}); return; }
  const post = JSON.parse(postRaw);
  if (post.video) { await env.POSTS.delete(keyInfoName).catch(() => {}); return; } // 이미 완료돼 있으면(드문 경우) 그냥 정리
  if (!post.images?.length) {
    await finalizeRenderFailed(job, keyInfoName, 'relay가 job을 잃어버렸는데, 재제출에 필요한 원본 이미지 정보도 없습니다.', env);
    return;
  }
  console.log(`[${keyInfoName}] relay가 job(${job.jobId})을 모름 — post 원본으로 렌더링 재제출 시도 (${resubmitCount + 1}/2)`);
  const render = await startRelayRender(post.images, post.audio, post.audioSegments, job.r2Key, job.shortKeys, post.captionWeights, post.captionBeats, post.captionFontKey, post.captionColor, env, post.highlightSegRange);
  if (render.ok) {
    await env.POSTS.put(keyInfoName, JSON.stringify({ ...job, jobId: render.jobId, resubmitCount: resubmitCount + 1, startedAt: Date.now() }));
    console.log(`[${keyInfoName}] 재제출 성공, 새 jobId: ${render.jobId}`);
  } else {
    await finalizeRenderFailed(job, keyInfoName, `relay job 재제출 실패: ${render.error}`, env);
  }
}

async function pollPendingRenderJobs(env, ctx) {
  const list = await env.POSTS.list({ prefix: 'renderJob:' });
  if (!list.keys.length) {
    console.log('대기 중인 릴레이 렌더링 작업 없음.');
    return;
  }
  console.log(`대기 중인 릴레이 렌더링 작업 ${list.keys.length}건 확인.`);

  for (const keyInfo of list.keys) {
    const rawJob = await env.POSTS.get(keyInfo.name);
    if (!rawJob) continue;
    const job = JSON.parse(rawJob);

    let res;
    try {
      res = await fetch(`${env.RELAY_URL}/render/status?jobId=${encodeURIComponent(job.jobId)}`, {
        headers: { 'x-relay-secret': env.RELAY_SECRET },
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.log(`[${keyInfo.name}] 릴레이 상태 조회 네트워크 오류: ${e.message}`);
      continue;
    }
    if (res.status === 404) {
      // relay 재시작 등으로 job을 잃어버림 — 여기서 그냥 넘어가면 타임아웃 체크도 안 타고 영원히 멈춤
      await resubmitLostRenderJob(job, keyInfo.name, env);
      continue;
    }
    if (!res.ok) {
      const bodyText = await res.text();
      console.log(`[${keyInfo.name}] 릴레이 상태 조회 실패 HTTP ${res.status}: ${bodyText.slice(0, 300)}`);
      continue;
    }

    const data = await res.json();
    const status = data?.status; // processing | done | failed
    const isDone = status === 'done';
    const isFailed = status === 'failed';

    if (!isDone && !isFailed) {
      if (Date.now() - job.startedAt > VIDEO_JOB_TIMEOUT_MS) {
        console.log(`[${keyInfo.name}] 타임아웃, 정리함. 마지막 상태: ${JSON.stringify(data).slice(0, 300)}`);
        await env.POSTS.delete(keyInfo.name);
      } else {
        console.log(`[${keyInfo.name}] 아직 진행 중 (상태: ${status || '알 수 없음'})`);
      }
      continue;
    }

    if (isFailed) {
      await finalizeRenderFailed(job, keyInfo.name, data?.error || '알 수 없는 오류', env);
      continue;
    }

    await finalizeRenderDone({ ...job, durationSec: data.durationSec }, keyInfo.name, env, ctx);
  }
}

// [2026-08-31 07:05] 관리자 페이지(브라우저)가 안 열려있어도 생성이 진행되게 하는 크론 폴백 —
// runGenerationStep(handleGenerateStep과 완전히 같은 함수)을 그대로 재사용해서 대기 중인 genJob마다
// 딱 한 단계씩만 진행함. 실패 처리 규칙도 handleGenerateStep과 동일(에러 나면 job.failed=true로 표시해서
// admin 페이지의 3분 정리 로직이 그대로 정리해줌 — 이 함수는 failed:true인 작업은 건드리지 않음).
async function pollPendingGenJobs(env) {
  const list = await env.POSTS.list({ prefix: 'genJob:' });
  if (!list.keys.length) {
    console.log('대기 중인 생성 작업 없음.');
    return;
  }
  console.log(`대기 중인 생성 작업 ${list.keys.length}건 확인, 각각 한 단계씩 진행.`);

  for (const keyInfo of list.keys) {
    const raw = await env.POSTS.get(keyInfo.name);
    if (!raw) continue;
    let job = JSON.parse(raw);
    if (job.failed) continue; // 이미 실패로 끝난 건 admin 페이지의 정리 타이머가 알아서 지움
    // [2026-09-02 20:21] 동시실행 방지 — 방금 다른 경로(탭 폴링/relay tick)가 이 job을 잡았으면 건너뜀
    if (job.lockedAt && Date.now() - job.lockedAt < GEN_JOB_LOCK_MS) continue;
    await env.POSTS.put(keyInfo.name, JSON.stringify({ ...job, lockedAt: Date.now() })).catch(() => {});

    try {
      job = await runGenerationStep(job, env);
      if (job.stage === 'done') {
        await env.POSTS.delete(keyInfo.name);
        console.log(`[${keyInfo.name}] 크론이 생성 완료시킴: ${job.slug}`);
        continue;
      }
      job.startedAt = Date.now(); // 마지막 갱신 시각(admin 페이지의 "멈춤" 판정과 공유)
      await env.POSTS.put(keyInfo.name, JSON.stringify(job));
    } catch (e) {
      await env.POSTS.put(keyInfo.name, JSON.stringify({ ...job, stage: '실패', percent: 0, error: e.message, failed: true, startedAt: Date.now() })).catch(() => {});
      await recordGenFailure(keyInfo.name.split(':')[1], job.topic, e.message, env);
      console.log(`[${keyInfo.name}] 크론 진행 중 실패: ${e.message}`);
    }
  }
}

async function pollPendingVideoJobs(env) {
  const list = await env.POSTS.list({ prefix: 'videoJob:' });
  if (!list.keys.length) {
    console.log('대기 중인 영상 작업 없음.');
    return;
  }
  console.log(`대기 중인 영상 작업 ${list.keys.length}건 확인.`);

  for (const keyInfo of list.keys) {
    const raw = await env.POSTS.get(keyInfo.name);
    if (!raw) continue;
    const job = JSON.parse(raw);

    let res;
    try {
      res = await fetch(`${VEO_BASE_URL}/${job.operationName}`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
    } catch (e) {
      console.log(`[${keyInfo.name}] 상태 조회 네트워크 오류: ${e.message}`);
      continue;
    }
    if (!res.ok) {
      const bodyText = await res.text();
      console.log(`[${keyInfo.name}] 상태 조회 실패 HTTP ${res.status}: ${bodyText.slice(0, 200)}`);
      continue;
    }

    const data = await res.json();
    if (!data.done) {
      if (Date.now() - job.startedAt > VIDEO_JOB_TIMEOUT_MS) {
        console.log(`[${keyInfo.name}] 타임아웃, 정리함.`);
        await env.POSTS.delete(keyInfo.name);
      }
      continue;
    }

    if (data.error) {
      console.log(`[${keyInfo.name}] Veo 오류: ${JSON.stringify(data.error).slice(0, 300)}`);
      await env.POSTS.delete(keyInfo.name);
      continue;
    }

    const videoUri =
      data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ||
      data?.response?.generatedVideos?.[0]?.video?.uri ||
      data?.response?.videos?.[0]?.uri || null;
    const videoBase64 =
      data?.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.bytesBase64Encoded ||
      data?.response?.generatedVideos?.[0]?.video?.videoBytes || null;

    if (!videoUri && !videoBase64) {
      console.log(`[${keyInfo.name}] 영상 위치 못 찾음.`);
      await env.POSTS.delete(keyInfo.name);
      continue;
    }

    let videoBuffer;
    try {
      videoBuffer = await fetchVeoVideoBytes(videoUri, videoBase64, env);
    } catch (e) {
      console.log(`[${keyInfo.name}] 다운로드 실패: ${e.message}`);
      continue;
    }

    await env.MEDIA.put(job.r2Key, videoBuffer, { httpMetadata: { contentType: 'video/mp4' } });

    const postRaw = await env.POSTS.get(`post:${job.slug}`);
    if (postRaw) {
      const post = JSON.parse(postRaw);
      post.video = job.r2Key;
      await env.POSTS.put(`post:${job.slug}`, JSON.stringify(post));
    }
    await env.POSTS.delete(keyInfo.name);
    console.log(`[${keyInfo.name}] 완료 및 저장: ${job.r2Key}`);
  }
}

async function serveMedia(request, env, ctx, key) {
  if (!env.MEDIA) return new Response('Media storage not configured', { status: 500 });
  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const object = await env.MEDIA.get(key);
  if (!object) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=604800');
  const response = new Response(object.body, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// 문장을 N개 구간(이미지 개수)으로 나누되, 문장 "개수"가 아니라 "글자수"가 균등해지도록 배분 —
// 이래야 각 이미지에 배정된 자막 분량이 실제 발화 시간과 비례해서, 나레이션 속도와 슬라이드 전환이 맞아떨어짐.
// 문장 배열을 그대로 들고 있어야, 한 이미지에 문장이 여러 개 몰렸을 때 그걸 순서대로 갈아끼울 수 있음(자막 잘림 방지).
// sentenceInfos: [{ text, segIndex }] — segIndex는 그 문장이 몇 번째 음성 세그먼트에서 합성됐는지.
// 릴레이가 세그먼트별 실제 길이로 자막 타이밍을 정확히 맞출 때 이 매핑을 씀(비트에 그대로 실려감).
function splitTextIntoNChunks(sentenceInfos, n) {
  const sentences = Array.isArray(sentenceInfos) ? sentenceInfos : [];
  if (n <= 0) return [];
  if (!sentences.length) return Array.from({ length: n }, () => ({ sentences: [], weight: 1 / n }));

  // [2026-09-06 15:15] 진짜 원인 발견/수정 — 예전 방식(글자수 임계값으로 대충 나눈 뒤, 빈 칸을
  // "이웃한테서 하나씩 이동/pop"으로 채우는 방식)은 문장이 이미지 수보다 어중간하게 많을 때
  // (예: 문장 30개, 이미지 20장) 초반 임계값 계산이 문장을 한쪽에 몰아버리고 뒤쪽 이미지들이
  // 무더기로 비었음. 그 빈 칸들을 채우려고 앞쪽 큰 덩어리에서 pop()으로 계속 꺼내다 보니 항상
  // "뒤에서부터" 꺼내져서 뒤쪽 이미지일수록 문장 순서가 거꾸로 뒤섞였음(실제 증상: 영상 순서와
  // 나레이션 내용이 하나도 안 맞음). 아래는 처음부터 순서를 흐트러뜨릴 수 없는 방식으로 재작성 —
  // 문장을 앞에서부터 순서대로만 소비하고(idx는 항상 앞으로만 이동), 절대 뒤로 안 감.
  const chunks = Array.from({ length: n }, () => []);
  if (sentences.length >= n) {
    // 문장이 이미지 수 이상 — 이미지마다 최소 1문장은 보장하면서 글자수 비례로 몇 개씩 가져갈지 조정.
    // idx는 절대 되돌아가지 않으므로 순서가 원천적으로 안 깨짐.
    const totalChars = sentences.reduce((sum, s) => sum + s.text.length, 0) || 1;
    const target = totalChars / n;
    let idx = 0;
    for (let c = 0; c < n; c++) {
      chunks[c].push(sentences[idx++]);
      let charLen = chunks[c][0].text.length;
      const remainingImages = n - c - 1; // 이 청크 뒤에 아직 채워야 할 이미지 수
      // 목표 글자수에 도달할 때까지 계속 채우되, 뒤 이미지들 몫(최소 1개씩)은 항상 남겨둠
      while (c < n - 1 && idx < sentences.length && charLen < target && (sentences.length - idx) > remainingImages) {
        chunks[c].push(sentences[idx]);
        charLen += sentences[idx].text.length;
        idx++;
      }
    }
    while (idx < sentences.length) chunks[n - 1].push(sentences[idx++]); // 혹시 남으면 마지막 이미지에 몰아줌
  } else {
    // 문장이 이미지 수보다 적음 — 각 이미지에 문장 하나씩 순서대로 이어붙이되, 문장이 모자라면
    // "복사"(이동 아님)로 채움. 뒤로 갈수록 하나만 반복되지 않게 전체 구간에 고르게 펴서 복사함.
    for (let c = 0; c < n; c++) {
      const srcIdx = Math.min(Math.floor((c * sentences.length) / n), sentences.length - 1);
      chunks[c] = [sentences[srcIdx]];
    }
  }

  // 문장이 끝날 때마다 TTS가 짧게 쉬는 시간(정지)이 있는데, 글자수만 세면 이게 빠져서
  // 문장이 여러 개 들어간 컷일수록 실제보다 더 짧게 잡히는 문제가 있었음.
  // → 문장 하나당 "정지시간에 해당하는 글자수"를 가상으로 더해서 가중치를 보정.
  const PAUSE_EQUIVALENT_CHARS = 6;
  const rawWeights = chunks.map((sents) => {
    const chars = sents.reduce((sum, s) => sum + s.text.length, 0);
    const pauseChars = sents.length * PAUSE_EQUIVALENT_CHARS;
    return Math.max(chars + pauseChars, PAUSE_EQUIVALENT_CHARS); // 빈 칸도 최소 노출시간은 보장
  });
  const sumWeights = rawWeights.reduce((a, b) => a + b, 0) || 1;
  return chunks.map((sentences, i) => ({ sentences, weight: rawWeights[i] / sumWeights }));
}

// 세그먼트 목록(planAudioSegments 결과)을 "문장+세그먼트 번호" 평면 배열로 펼침 — 자막 배분/비트 생성 입력용.
function buildSentenceInfos(segSentences) {
  const infos = [];
  (segSentences || []).forEach((sentences, segIndex) => {
    (sentences || []).forEach((text) => infos.push({ text, segIndex }));
  });
  return infos;
}

// 한 이미지에 배정된 문장들을 "자막 비트"로 쪼갬 — 이번엔 문장 단위가 아니라 "줄" 단위로 쪼개서,
// 화면엔 항상 한 줄만 보이고 그 줄이 순서대로 갈아끼워짐(긴 문장이 여러 줄 한꺼번에 뜨지 않음).
// 각 줄의 노출시간은 글자수 비례, 문장이 끝나는 마지막 줄에만 정지시간(가상 글자수)을 더해줌.
// positionIndex: 이 영상 전체에 고정으로 쓸 위치 하나(POSITION_STYLES 참고, renderSlideshow 안) — 예전엔 비트마다
// 순환했는데 너무 산만하다는 피드백으로 위치/폰트/색 다 영상 하나당 하나로 고정.
// [2026-08-30 21:55] 자막 비트 = 문장 하나 통째(내부 줄바꿈 포함) — 예전엔 문장을 줄 단위로 쪼개 순서대로
// 갈아끼웠는데, 줄 전환 시각만은 문장 안에서 글자수 비례 "추정"이라 미세하게 어긋날 수 있었음.
// 이제 문장 전체를 2~3줄로 줄바꿈해 그 문장의 실측 구간 내내 표시 → 화면의 모든 자막 전환이
// 음성 조각의 측정된 시작 시각과 정확히 일치(추정 0). segIndex: 이 문장이 합성된 음성 조각 번호.
// isSentenceEnd: 하위호환(옛 relay의 무음 감지 정렬용) — 문장 단위 비트라 항상 true.
function buildCaptionBeats(sentences, positionIndex) {
  if (!sentences.length) return [];
  const PAUSE_EQUIVALENT_CHARS = 6;
  const beats = [];
  for (const s of sentences) {
    const text = typeof s === 'string' ? s : s.text; // 문자열(옛 형식)과 {text, segIndex} 둘 다 수용
    const segIndex = typeof s === 'string' ? null : s.segIndex;
    // [2026-09-06 00:30] 폰트를 30% 키우면서 한 줄 글자수도 그만큼 줄임(20→15) — 안 그러면 큰 폰트로
    // 20자를 다 채운 줄이 화면 가로 폭을 넘어가서 잘려 보이는 문제가 생김. 줄 수는 여유(5→6)로 늘려서
    // 문장이 더 잘게 나뉘어도 전체 내용이 잘리지 않게 함.
    const wrapped = wrapCaptionLines(text, 15, 6).join('\n');
    const weight = Math.max(text.length + PAUSE_EQUIVALENT_CHARS, 4);
    beats.push({ text: wrapped, weight, isSentenceEnd: true, segIndex });
  }
  const sumWeights = beats.reduce((a, b) => a + b.weight, 0) || 1;
  return beats.map((b) => ({ text: b.text, weight: b.weight / sumWeights, styleIndex: positionIndex, isSentenceEnd: true, segIndex: b.segIndex }));
}

function wrapCaptionLines(text, maxCharsPerLine = 20, maxLines = 3) {
  // [2026-09-06 20:15] 진짜 원인 발견/수정 — ffmpeg 단독 테스트로 확인: 줄바꿈 없이 화면 폭(1280px)을
  // 넘는 텍스트는 ffmpeg가 그냥 화면 밖으로 계속 그려버림(글씨가 깨지는 게 아니라 물리적으로 프레임
  // 밖으로 나가서 안 보이는 것 — 압축된 미리보기에서 깨진 것처럼 보였을 뿐). 예전 수정(마지막 줄
  // 한도를 넘으면 남은 단어를 전부 그 줄에 몰아넣기)이 바로 이 문제의 재발 원인이었음 — 몰아넣은
  // 마지막 줄이 가끔 화면 폭을 넘었음. 이제 줄 수 제한(maxLines)을 아예 없애고, 아무리 길어도 항상
  // 줄당 글자수(maxCharsPerLine)만 지켜서 계속 줄바꿈함 — 세로로 좀 길어질 수는 있어도 가로로는
  // 절대 넘치지 않음(내용 유실도 없음).
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = w;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// 동시성 제한된 map — 한꺼번에 다 병렬로 쏘면 Pixabay 초당 요청 제한(429)에 바로 걸림
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function generateAndSavePost(topic, env, onProgress, detail) {
  const genStartMs = Date.now(); // [2026-08-30 19:45] 생성 소요시간 측정(관리자 표시용)
  const report = (stage, percent) => { if (onProgress) onProgress(stage, percent); };
  if (!env.POSTS) return { ok: false, reason: 'POSTS(KV) 바인딩 없음' };

  report('뉴스 검색 중', 5);
  // 실제로 운영 중인 사이트(뉴스)가 있는지 최우선으로 검색 — 글 작성 근거이자 이미지 출처로도 재사용
  const newsResults = await searchNaverNews(topic, env);
  const usedNews = newsResults.length > 0;

  report('글 작성 중', 15);
  const { article, error: articleError, modelUsed } = await generateArticle(topic, newsResults, env, detail);
  if (!article) {
    return { ok: false, reason: `글 생성 실패 — ${articleError || '알 수 없는 오류'}` };
  }
  console.log(`글 생성 성공 (모델: ${modelUsed})`);

  const slug = String(Date.now());

  // 내레이션 텍스트(음성+자막 공용) — 실제 음성으로 변환되는 길이(3000자)로 맞춤
  // [2026-09-02 21:20] 문장을 5초 단위로 자연스럽게 재편집(reeditForTtsPacing)한 뒤 정규화/자름
  const rawNarration = [stripHtml(article.intro_html), ...(article.sections || []).map((s) => stripHtml(s.body_html)), stripHtml(article.outro_html)].join(' ');
  const pacedNarration = await reeditForTtsPacing(rawNarration, env);
  const narrationText = trimNarrationToSentence(normalizeNarrationSpacing(pacedNarration), NARRATION_MAX_CHARS);

  report('음성 생성 중', 30);
  // 문장 몇 개씩 묶은 세그먼트 단위로 따로 합성 — 릴레이가 각 조각의 실제 길이를 재서 자막을 실측으로 맞춤.
  // 이 경로(/api/generate)는 한 번의 호출로 전부 처리해야 해서, 요청 수를 아끼려고 스텝 방식(90자)보다
  // 세그먼트를 크게(220자) 묶음 — 세그먼트 안 오차는 조금 커지지만 경계마다 실측이라 누적은 안 됨.
  let audioKey = null;
  let audioError = null;
  let audioSegmentKeys = [];
  let segSentencesList = [];
  if (env.MEDIA) {
    const segments = planAudioSegments(prepareNarrationSentences(narrationText), 110); // [2026-08-30 21:51] 220→110자: 이 경로는 한 호출로 전부 합성해야 해서 문장 2~3개 묶음까지만
    const voices = pickTtsVoices(); // 목소리는 영상 전체에 하나로 고정(세그먼트마다 바뀌면 안 됨)
    const buffers = [];
    for (let i = 0; i < segments.length; i++) {
      report(`음성 생성 중 (${i + 1}/${segments.length})`, 25 + Math.round(((i + 1) / segments.length) * 10)); // 25~35%
      const { buffer, error } = await generateNarrationAudioWithRetry(segments[i].text, env, 2, voices);
      if (!buffer) {
        audioError = `음성 세그먼트 ${i + 1}/${segments.length} 합성 최종 실패 — ${error || '알 수 없는 오류'}`;
        break;
      }
      buffers.push(buffer);
    }
    if (!audioError && buffers.length === segments.length) {
      for (let i = 0; i < buffers.length; i++) {
        const key = `${slug}-narr-${i}.mp3`;
        await env.MEDIA.put(key, buffers[i], { httpMetadata: { contentType: 'audio/mpeg' } });
        audioSegmentKeys.push(key);
      }
      audioKey = `${slug}-narration.mp3`;
      await env.MEDIA.put(audioKey, concatAudioBuffers(buffers), { httpMetadata: { contentType: 'audio/mpeg' } });
      segSentencesList = segments.map((s) => s.sentences);
      console.log(`내레이션 음성 생성 완료 (세그먼트 ${segments.length}개)`);
    } else {
      // 부분적으로 올라간 세그먼트가 있다면 정리(아래 audioKey 없음 분기에서 발행 중단됨)
      await Promise.all(audioSegmentKeys.map((k) => env.MEDIA.delete(k).catch(() => {})));
      audioSegmentKeys = [];
      console.log(`내레이션 음성 생성 실패: ${audioError}`);
    }
  }

  report('이미지 준비 중', 40);
  // 자막 위치/폰트/색은 이 영상 하나에 쓸 값을 미리 하나씩 고정 선택 — 비트마다 안 바뀌고 영상 전체 동일.
  const { captionFontKey, captionColor, captionPositionIndex } = pickCaptionStyle();
  let images = [];
  let captionWeights = [];
  let captionBeats = []; // 이미지별 자막 "비트" 배열 — 한 이미지에 문장 여러 개면 순서대로 갈아끼울 목록
  if (env.MEDIA) {
    // 이미지 소스는 저작권이 명확한 것만 사용: FLUX 우선 생성 → 실패시 Pixabay → Pexels
    const scenes = await generateScenePrompts(topic, article.title, env, SCENE_COUNT, buildArticleDigestForScenes(article));
    // [2026-08-30 19:10] 이 경로는 병렬 수집이라 "못 찾으면 다음 장면에서 재시도" 같은 순차 슬롯이 안 됨 —
    // 고정 슬롯(시작/중간/후반 장면)에서만 클립을 시도하고, 실패하면 그 장면은 사진으로 폴백.
    const clipSlotSet = new Set([0, Math.floor(scenes.length / 3), Math.floor((scenes.length * 2) / 3)].slice(0, CLIP_TARGET));
    let doneCount = 0;
    const rawImages = (await mapWithConcurrency(scenes, 3, async (s, si) => {
      let media = null;
      let isClip = false;
      if (clipSlotSet.has(si)) {
        media = await getSceneClip(s, topic, env);
        isClip = !!media;
      }
      if (!media) media = await getSceneImage(s, topic, env);
      doneCount++;
      report(`이미지 수집 중 (${doneCount}/${scenes.length})`, 40 + Math.round((doneCount / scenes.length) * 35)); // 40~75%
      return media ? { buffer: media, isClip } : null;
    })).filter(Boolean);
    console.log(`장면 원본 미디어 ${rawImages.length}/${scenes.length}개 확보(클립 ${rawImages.filter((m) => m.isClip).length}개)`);

    // 내레이션 텍스트를 확보된 이미지 개수만큼 나눠서 각 이미지에 배정 — 자막은 이미지에 직접 굽지 않고
    // 웹/mp4 둘 다 "그 이미지가 떠 있는 동안 문장을 순서대로 갈아끼우는" 방식으로 오버레이함
    // (한 이미지에 문장이 여러 개 몰려도 잘려나가지 않고 전부 노출됨). 문장마다 음성 세그먼트 번호를 실음.
    const perImageChunks = splitTextIntoNChunks(buildSentenceInfos(segSentencesList), rawImages.length || 1);
    for (let i = 0; i < rawImages.length; i++) {
      const chunk = perImageChunks[i] || { sentences: [], weight: 1 / (rawImages.length || 1) };
      const key = `${slug}-scene-${i}.${rawImages[i].isClip ? 'mp4' : 'jpg'}`;
      await env.MEDIA.put(key, rawImages[i].buffer, { httpMetadata: { contentType: rawImages[i].isClip ? 'video/mp4' : 'image/jpeg' } });
      images.push(key);
      captionWeights.push(chunk.weight);
      const beats = buildCaptionBeats(chunk.sentences, captionPositionIndex);
      captionBeats.push(beats);
    }
    console.log(`장면 이미지 ${images.length}개 저장 완료`);
  }

  // 음성이 끝내 실패했으면(재시도 다 소진) 무음 영상을 조용히 발행하는 대신 여기서 중단 —
  // 이미 올려둔 장면 이미지는 정리하고 실패로 반환(글 자체를 안 만듦).
  if (!audioKey) {
    if (images.length && env.MEDIA) {
      await Promise.all(images.map((k) => env.MEDIA.delete(k).catch(() => {})));
    }
    return { ok: false, reason: `음성 생성 최종 실패로 발행 중단 — ${audioError || '알 수 없는 오류'}` };
  }

  report('글 저장 중', 80);
  // [2026-09-02 21:05] 쇼츠용 하이라이트 구간 — 실패해도 발행은 막지 않음
  const highlightSegRange = await pickHighlightRange(segSentencesList.flat(), topic, env);
  const post = {
    slug, topic, title: article.title, createdAt: new Date().toISOString(),
    intro: article.intro_html, sections: article.sections || [], outro: article.outro_html,
    images, audio: audioKey, audioSegments: audioSegmentKeys, audioError, usedNews, captionWeights, captionBeats, captionFontKey, captionColor, highlightSegRange,
    generationSec: Math.round((Date.now() - genStartMs) / 1000), // [2026-08-30 19:45] 생성 소요시간(관리자 표시용)
    threadsText: (article.threads_text || '').toString().slice(0, 450), // [2026-08-30 22:20] 스레드 공유용 홍보문
  };
  await env.POSTS.put(`post:${slug}`, JSON.stringify(post));
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  idx.unshift(slug);
  await env.POSTS.put('index', JSON.stringify(idx.slice(0, 500)));

  report('영상 렌더링 등록 중', 90);
  // 진짜 mp4 영상(유튜브 업로드용) — 우리가 만든 이미지+음성을 Oracle 릴레이(ffmpeg)로 합성. 기다리지 않고 등록만.
  if (env.RELAY_URL && env.RELAY_SECRET && env.MEDIA && images.length) {
    const outputKey = `${slug}.mp4`;
    const shortKeys = [`${slug}-short.mp4`]; // [2026-08-31 07:29] 3개→1개: 유튜브 일일 업로드 할당량(10,000유닛, 건당 1,600) 절약 위해 축소(사용자 요청)
    const render = await startRelayRender(images, audioKey, audioSegmentKeys, outputKey, shortKeys, captionWeights, captionBeats, captionFontKey, captionColor, env, highlightSegRange);
    if (render.ok) {
      await env.POSTS.put(`renderJob:${slug}`, JSON.stringify({
        jobId: render.jobId, slug, r2Key: outputKey, shortKeys, imageKeys: images, startedAt: Date.now(),
      }));
      console.log(`릴레이 렌더링 작업 등록됨: ${slug} (jobId: ${render.jobId})`);
    } else {
      // 시작 자체가 실패한 경우 admin 화면에 이유가 보이게 post에도 남겨둠 (안 그러면 "—"로만 보여서 뭔지 알 수 없음)
      post.videoError = render.error;
      await env.POSTS.put(`post:${slug}`, JSON.stringify(post));
      console.log(`릴레이 렌더링 작업 시작 실패(글 발행은 계속 진행): ${render.error}`);
    }
  } else if (!env.RELAY_URL || !env.RELAY_SECRET) {
    post.videoError = 'RELAY_URL/RELAY_SECRET 미설정';
    await env.POSTS.put(`post:${slug}`, JSON.stringify(post));
  }

  report('완료', 100);
  console.log(`발행 완료: ${slug}`);
  return { ok: true, post };
}

function renderSlideshow(post) {
  if (!post.images?.length) return '';
  // 폰트/색은 이 영상에 고정으로 뽑아둔 값 사용(없는 옛날 글은 첫번째 폰트/흰색으로 자동 대체 — 마이그레이션 불필요)
  const fixedFontChoice = CAPTION_FONT_CHOICES.find((f) => f.key === post.captionFontKey) || CAPTION_FONT_CHOICES[0];
  const fixedFontCss = fixedFontChoice.css;
  const fixedColorCss = post.captionColor || CAPTION_COLOR_CHOICES[0];
  // [2026-08-30 19:10] mp4(실사 클립)는 video 태그로 — muted 자동재생/반복이라 사진과 똑같이 전환됨(.slide CSS 공용)
  const slides = post.images.map((key, i) => key.endsWith('.mp4')
    ? `<video class="slide${i === 0 ? ' active' : ''}" src="/media/${key}" muted loop playsinline autoplay></video>`
    : `<img class="slide${i === 0 ? ' active' : ''}" src="/media/${key}" alt="장면 ${i + 1}">`).join('');
  const hasAudio = !!post.audio;
  const audioTag = hasAudio ? `<audio id="narration-${post.slug}" src="/media/${post.audio}" preload="auto"></audio>` : '';
  // 자동재생 없음 — 항상 이 버튼을 눌러야 슬라이드쇼(+음성)가 시작됨
  const playBtn = `<button class="playbtn" id="playbtn-${post.slug}">▶ 재생</button>`;
  const captionBox = `<div class="caption-box" id="caption-${post.slug}"></div>`;
  const weightsJson = JSON.stringify(Array.isArray(post.captionWeights) ? post.captionWeights : []);
  // 이미지별 자막 "비트" — 그 이미지가 떠 있는 동안 순서대로 갈아끼울 문장 목록(문장이 여러 개 몰려도 안 잘림)
  const beatsJson = JSON.stringify(Array.isArray(post.captionBeats) ? post.captionBeats : []);
  const script = `<script>
    (function(){
      var root = document.getElementById('slideshow-${post.slug}');
      var slides = root.querySelectorAll('.slide');
      var captionEl = document.getElementById('caption-${post.slug}');
      var weights = ${weightsJson};
      var beatsPerSlide = ${beatsJson};
      var isPlaying = false, rafId = null, startTimestamp = 0;
      var DEFAULT_MS = 6000;
      function show(i){ slides.forEach(function(s,idx){ s.classList.toggle('active', idx===i); }); }

      // 위치/폰트/색 전부 영상 하나당 하나로 고정(서버가 미리 뽑아서 내려줌, 비트마다 안 바뀜) — 위치는
      // captionBeats의 모든 styleIndex가 이미 같은 값으로 와서 자연히 고정됨. 폰트/색은 아래 FIXED_FONT/FIXED_COLOR로 고정.
      // relay.js(mp4)에도 같은 위치표 + 고정 폰트/색 규칙이 있음(POSITION_STYLES 인덱스 규칙 일치, styleIndex 그대로 재사용).
      // [2026-08-30 20:13] 자막 크기 2/3로 축소했었는데, [2026-09-06 00:30] 30% 다시 키움(사용자 요청)
      var POSITION_STYLES = [
        { pos:'bottom', size:30 },
        { pos:'top',    size:29 },
        { pos:'bl',     size:38 },
        { pos:'br',     size:35 },
        { pos:'middle', size:36 }
      ];
      var FIXED_FONT = ${JSON.stringify(fixedFontCss)};
      var FIXED_COLOR = ${JSON.stringify(fixedColorCss)};
      function applyCaptionStyle(idx){
        var st = POSITION_STYLES[idx % POSITION_STYLES.length];
        captionEl.style.color = FIXED_COLOR;
        captionEl.style.fontFamily = FIXED_FONT;
        captionEl.style.fontSize = st.size + 'px';
        captionEl.style.top = captionEl.style.bottom = captionEl.style.left = captionEl.style.right = 'auto';
        captionEl.style.textAlign = 'center';
        captionEl.style.transform = 'none';
        if (st.pos === 'bottom') { captionEl.style.bottom = '80px'; captionEl.style.left = '24px'; captionEl.style.right = '24px'; }
        else if (st.pos === 'top') { captionEl.style.top = '60px'; captionEl.style.left = '24px'; captionEl.style.right = '24px'; }
        // [2026-09-06 02:10] 버그 수정 — 예전엔 right:45%/left:45%로 폭을 절반 정도만 쓰게 가둬놔서
        // 좁은 화면(휴대폰)+커진 폰트 조합에서 한 줄에 몇 글자만 들어가고 나머지가 넘쳐서 잘려 보였음.
        // 좌우 정렬(text-align)만 유지하고 폭 제한은 풀어서 전체 가로폭을 다 쓰게 함.
        else if (st.pos === 'bl') { captionEl.style.bottom = '90px'; captionEl.style.left = '20px'; captionEl.style.right = '20px'; captionEl.style.textAlign = 'left'; }
        else if (st.pos === 'br') { captionEl.style.bottom = '90px'; captionEl.style.right = '20px'; captionEl.style.left = '20px'; captionEl.style.textAlign = 'right'; }
        else if (st.pos === 'middle') { captionEl.style.top = '42%'; captionEl.style.left = '24px'; captionEl.style.right = '24px'; }
      }

      // 이미지별 노출시간(가중치 비율대로) — 웹/mp4 공통 로직과 동일
      function durationsFor(totalMs){
        if (weights.length === slides.length && slides.length) {
          var sum = weights.reduce(function(a,b){ return a+b; }, 0) || 1;
          return weights.map(function(w){ return Math.max(1500, (w/sum)*totalMs); });
        }
        return slides.length ? Array.from({length:slides.length}, function(){ return totalMs/slides.length; }) : [];
      }

      // 절대 시간표(schedule)를 한 번에 통째로 미리 계산 — "이 구간(start~end)엔 이 슬라이드의 이 자막"
      // 형태로 전부 펼쳐두고, 재생 중엔 지금 시각(오디오 currentTime 또는 경과시간)이 어느 구간에 속하는지만
      // 찾아서 반영함. setTimeout을 연쇄로 걸지 않아서 타이머 오차가 누적될 일이 없음(= 뒤로 갈수록 밀리는 문제 원천 차단).
      var schedule = [];
      var totalScheduleMs = 0;
      function buildSchedule(totalMs){
        var durations = durationsFor(totalMs);
        var list = [];
        var cursor = 0;
        for (var i = 0; i < slides.length; i++) {
          var slideStart = cursor;
          var slideDur = durations[i] || 0;
          var beats = beatsPerSlide[i];
          if (beats && beats.length) {
            var sum = beats.reduce(function(a,b){ return a + (b.weight || 1); }, 0) || 1;
            var t = slideStart;
            for (var j = 0; j < beats.length; j++) {
              var d = Math.max(800, (beats[j].weight / sum) * slideDur);
              list.push({ start: t, end: t + d, slideIdx: i, text: beats[j].text || '', styleIndex: beats[j].styleIndex || 0 });
              t += d;
            }
          } else {
            list.push({ start: slideStart, end: slideStart + slideDur, slideIdx: i, text: '' });
          }
          cursor = slideStart + slideDur;
        }
        totalScheduleMs = cursor;
        return list;
      }
      schedule = buildSchedule(DEFAULT_MS * slides.length);

      var cursorIdx = 0, lastSlideIdx = -1, lastText = null;
      function resetCursor(){ cursorIdx = 0; lastSlideIdx = -1; lastText = null; }

      var btn = document.getElementById('playbtn-${post.slug}');
      ${hasAudio ? "var audio = document.getElementById('narration-" + post.slug + "');" : ''}

      function tick(){
        if (!isPlaying) return;
        var elapsedMs = ${hasAudio ? 'audio.currentTime * 1000' : '(Date.now() - startTimestamp)'};
        while (cursorIdx < schedule.length - 1 && elapsedMs >= schedule[cursorIdx].end) cursorIdx++;
        var seg = schedule[cursorIdx];
        if (seg) {
          if (seg.slideIdx !== lastSlideIdx) { show(seg.slideIdx); lastSlideIdx = seg.slideIdx; }
          if (seg.text !== lastText) {
            captionEl.textContent = seg.text;
            lastText = seg.text;
            applyCaptionStyle(typeof seg.styleIndex === 'number' ? seg.styleIndex : 0);
          }
        }
        ${hasAudio ? '' : `
        if (elapsedMs >= totalScheduleMs) { pause(); resetCursor(); show(0); captionEl.textContent=''; return; }
        `}
        rafId = requestAnimationFrame(tick);
      }

      function play(){
        isPlaying = true;
        btn.textContent = '⏸ 정지';
        startTimestamp = Date.now();
        ${hasAudio ? 'audio.play();' : ''}
        rafId = requestAnimationFrame(tick);
      }
      function pause(){
        isPlaying = false;
        btn.textContent = '▶ 재생';
        if (rafId) cancelAnimationFrame(rafId);
        ${hasAudio ? 'audio.pause();' : ''}
      }
      btn.addEventListener('click', function(){
        if (isPlaying) pause(); else play();
      });
      ${hasAudio ? `
      audio.addEventListener('loadedmetadata', function(){
        // 실제 음성 길이를 알면 그 길이 기준으로 전체 시간표를 다시 계산(나레이션과 싱크)
        schedule = buildSchedule(Math.max(4000 * slides.length, audio.duration * 1000));
        resetCursor();
      });
      audio.addEventListener('ended', function(){
        resetCursor(); show(0); captionEl.textContent = '';
        pause();
      });
      ` : ''}
    })();
  </script>`;
  return `<div class="slideshow" id="slideshow-${post.slug}">${slides}${captionBox}${playBtn}</div>${audioTag}${script}`;
}

// [2026-09-07 00:50] SEO/구독 기본 기능 3종 추가 — 지금까지 사이트에 sitemap.xml/robots.txt/RSS가
// 아예 없었음. 검색엔진 노출과 외부 구독(피드리더 등)에 기본적인데 빠져있어서 추가함. 영상 생성
// 파이프라인과는 완전히 무관한 독립 기능이라 안전하게 추가할 수 있음(escapeXml은 기존 함수 재사용).
async function handleSitemap(env) {
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const urls = [`  <url><loc>${SITE_ORIGIN}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`];
  for (const slug of idx.slice(0, 2000)) { // 사이트맵 규격상 URL 5만 개까지 가능하지만 넉넉히 2000개로 제한
    const raw = await env.POSTS.get(`post:${slug}`);
    if (!raw) continue;
    const post = JSON.parse(raw);
    const lastmod = new Date(post.createdAt).toISOString().slice(0, 10);
    urls.push(`  <url><loc>${SITE_ORIGIN}/${escapeXml(post.slug)}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq></url>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
function handleRobotsTxt() {
  const body = `User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
async function handleRssFeed(env) {
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const items = [];
  for (const slug of idx.slice(0, 30)) { // 최근 30개만 — RSS 관례상 전체를 다 실을 필요 없음
    const raw = await env.POSTS.get(`post:${slug}`);
    if (!raw) continue;
    const post = JSON.parse(raw);
    const excerpt = makeExcerpt(post.intro, 200);
    items.push(`  <item>
    <title>${escapeXml(post.title)}</title>
    <link>${SITE_ORIGIN}/${escapeXml(post.slug)}</link>
    <guid isPermaLink="true">${SITE_ORIGIN}/${escapeXml(post.slug)}</guid>
    <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
    <description>${escapeXml(excerpt)}</description>
  </item>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>life.news</title>
  <link>${SITE_ORIGIN}/</link>
  <description>생활뉴스 · 글+슬라이드쇼</description>
  <language>ko-kr</language>
${items.join('\n')}
</channel>
</rss>`;
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=1800' } });
}

async function renderHomePage(env) {
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const posts = [];
  for (const slug of idx.slice(0, 30)) {
    const raw = await env.POSTS.get(`post:${slug}`);
    if (raw) posts.push(JSON.parse(raw));
  }

  const entries = posts.map((p) => {
    const excerpt = makeExcerpt(p.intro);
    const dateStr = new Date(p.createdAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' });
    const thumb = p.images?.[0] ? `<div class="entry-thumb"><img src="/media/${p.images[0]}" alt="${escapeHtml(p.title)}"></div>` : '';
    return `<a class="entry" href="/${p.slug}">
      <div class="entry-main">
        <div class="entry-eyebrow">[ ${escapeHtml(p.topic)} ]</div>
        <h2 class="entry-title">${escapeHtml(p.title)}</h2>
        ${excerpt ? `<p class="entry-excerpt">${escapeHtml(excerpt)}</p>` : ''}
        <div class="entry-meta">${dateStr}${p.audio ? ' · 🔊 내레이션 포함' : ''}</div>
      </div>
      ${thumb}
    </a>`;
  }).join('');

  const body = `${siteHeader()}
    <div class="hero"><div class="wrap">
      <span class="eyebrow">Life & News</span>
      <h1>생활 속 이야기를 글과 슬라이드쇼로</h1>
      <p class="sub">주제 하나를 던지면 AI가 글을 쓰고, 장면 이미지와 내레이션 음성까지 함께 만듭니다.</p>
    </div></div>
    <div class="wrap"><div class="index">${entries || '<p style="color:var(--muted)">아직 글이 없습니다.</p>'}</div></div>
    <footer><div class="wrap">life.news — 이 사이트의 글과 이미지/음성은 AI가 자동 생성한 참고용 콘텐츠입니다.</div></footer>`;

  return new Response(page('life.news - 생활뉴스', body), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function renderPostPage(env, slug) {
  const raw = await env.POSTS.get(`post:${slug}`);
  if (!raw) return new Response('Not Found', { status: 404 });
  const p = JSON.parse(raw);

  const sectionsHtml = (p.sections || []).map((s) => `<h2>${escapeHtml(s.heading)}</h2>${s.body_html}`).join('');
  // mp4가 완성된 글은 SVG/mp3가 이미 삭제된 상태라 슬라이드쇼를 그리면 깨진 이미지만 남음 — 영상 하나만 보여줌
  const slideshow = p.video ? '' : renderSlideshow(p);
  // 유튜브는 렌더링 완료 직후 자동 업로드됨(백그라운드) — 성공하면 링크, 실패하면 사유, 아직이면 업로드 중/진행률 표시.
  // needsYoutubePoll: 아직 결과(링크도 실패도)가 없다는 뜻 — 이 페이지를 계속 보고 있어도 업로드가 끝나는 걸
  // 알 방법이 없었던 게 문제였음("업로드 대기 중"에서 새로고침 전까진 영원히 안 바뀜) → 아래 스크립트로 폴링해서 자동 갱신.
  const needsYoutubePoll = p.video && !p.youtubeUrl && !p.youtubeError;
  // [2026-08-30 22:20] 스레드 공유 링크 — 홍보문+글 링크가 미리 채워진 스레드 작성창을 엶
  const threadsShareHref = `https://www.threads.net/intent/post?text=${encodeURIComponent(buildThreadsCaption(p))}`; // [2026-08-30 23:31] 예쁜 형식 공용 빌더 사용
  // [2026-08-31] 스레드 웹 공유창은 이미지 자동 첨부가 안 돼서(메타 앱 심사 필요) 대표 이미지 다운로드 링크를 따로 둠
  const threadsImageDlHref = p.images?.[0] ? `/media/${escapeHtml(p.images[0])}` : null;
  const youtubeStatusText = p.youtubeUrl
    ? `· <a href="${escapeHtml(p.youtubeUrl)}" target="_blank" rel="noopener">▶ 유튜브에서 보기</a>${(p.youtubeShortsUrls && p.youtubeShortsUrls.length) ? p.youtubeShortsUrls.map((u, si) => u ? ` · <a href="${escapeHtml(u)}" target="_blank" rel="noopener">🩳${si + 1}</a>` : ` · ⚠️ 숏츠${si + 1}실패`).join('') : p.youtubeShortsUrl ? ` · <a href="${escapeHtml(p.youtubeShortsUrl)}" target="_blank" rel="noopener">🩳 숏츠</a>` : ''} · <a href="${escapeHtml(threadsShareHref)}" target="_blank" rel="noopener">🧵 스레드 공유</a>${threadsImageDlHref ? ` · <a href="${threadsImageDlHref}" download>⬇️ 스레드이미지</a>` : ''}`
    : p.youtubeQuotaExceeded
      ? `· ⏳ ${escapeHtml((p.youtubeError || '').slice(0, 200))}` // [2026-08-31] 할당량 초과 — 자동 재시도 예정이라는 게 명확히 보이게(⚠️ 대신 ⏳)
      : p.youtubeError
        ? `· ⚠️ 유튜브 업로드 실패(${escapeHtml(p.youtubeError.slice(0, 200))})`
        : `· 유튜브 업로드 중${typeof p.youtubeUploadPercent === 'number' ? ` ${p.youtubeUploadPercent}%` : '…'}`;
  // [2026-09-06 03:30] R2에 mp4가 아직 있으면(유튜브 업로드 전) R2에서 직접 재생, 유튜브 업로드
  // 성공 후 R2에서 지워졌으면(videoDeletedFromR2) 유튜브 임베드로 대체 재생.
  const mainVideoInR2 = p.video && !p.videoDeletedFromR2;
  const veoVideoBlock = mainVideoInR2
    ? `<div style="margin:20px 0;">
        <video controls preload="metadata" style="width:100%;border-radius:10px;background:#000;" src="/media/${p.video}"></video>
        <p class="mono" style="font-size:12px;color:var(--muted);margin-top:8px;">🎬 실제 영상 파일(mp4) <span id="yt-status" data-slug="${p.slug}">${youtubeStatusText}</span></p>
      </div>`
    : p.youtubeId
      ? `<div style="margin:20px 0;">
          <div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:10px;background:#000;">
            <iframe src="https://www.youtube.com/embed/${escapeHtml(p.youtubeId)}" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0;" allowfullscreen loading="lazy"></iframe>
          </div>
          <p class="mono" style="font-size:12px;color:var(--muted);margin-top:8px;">🎬 유튜브에서 재생 중 <span id="yt-status" data-slug="${p.slug}">${youtubeStatusText}</span></p>
        </div>`
      : '';
  // 관리자 페이지의 pollRender()와 같은 원리의 초경량 폴링 — 결과가 나올 때까지(또는 진행이 멈춰서 포기할 때까지)만 돎.
  const youtubePollScript = needsYoutubePoll ? `<script>
    (function(){
      var el = document.getElementById('yt-status');
      if (!el) return;
      var slug = el.dataset.slug;
      var lastPct = -1, stallTries = 0, timer = null;
      function poll(){
        fetch('/admin/render-progress?slug=' + encodeURIComponent(slug))
          .then(function(r){ return r.json(); })
          .then(function(data){
            if (data.youtubeUrl) {
              el.textContent = '· ';
              var a = document.createElement('a'); a.href = data.youtubeUrl; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '▶ 유튜브에서 보기';
              el.appendChild(a);
              if (timer) clearInterval(timer);
              return;
            }
            if (data.youtubeError) {
              // [2026-08-31] 할당량 초과면 ⏳(재시도 예정), 그 외 실패면 ⚠️로 구분 — 헷갈리지 않게
              el.textContent = '· ' + (data.youtubeQuotaExceeded ? '⏳ ' : '⚠️ 유튜브 업로드 실패(') + String(data.youtubeError).slice(0, 200) + (data.youtubeQuotaExceeded ? '' : ')');
              if (timer) clearInterval(timer);
              return;
            }
            var pct = (typeof data.youtubeUploadPercent === 'number') ? data.youtubeUploadPercent : null;
            el.textContent = '· 유튜브 업로드 중' + (pct !== null ? ' ' + pct + '%' : '…');
            var stalled = (pct !== null && pct === lastPct);
            if (pct !== null) lastPct = pct;
            stallTries = stalled ? stallTries + 1 : 0;
            if (stallTries >= 20) { // 진행률이 약 1분간 그대로면 포기하고 새로고침 안내(업로드 자체는 서버에서 계속 진행됨)
              el.textContent = '· 유튜브 업로드 확인은 새로고침 후 봐주세요';
              if (timer) clearInterval(timer);
            }
          })
          .catch(function(){});
      }
      poll();
      timer = setInterval(poll, 3000);
    })();
  </script>` : '';

  const body = `${siteHeader()}
    <div class="wrap post-body">
      <h1>${escapeHtml(p.title)}</h1>
      <div class="meta">${escapeHtml(p.topic)} · ${new Date(p.createdAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} · 제로지${p.videoDurationSec ? ` · ${fmtDurSec(p.videoDurationSec)}` : ''}</div>
      ${veoVideoBlock}
      ${slideshow}
      ${p.intro}
      ${sectionsHtml}
      ${p.outro}
      ${(p.coupangProducts && p.coupangProducts.length) ? `
      <div style="margin:32px 0 0;padding:16px 18px;border:1px solid var(--border);border-radius:10px;">
        <h3 style="margin:0 0 4px;font-size:16px;">🛒 관련 상품</h3>
        <p class="mono" style="margin:0 0 12px;font-size:11px;color:var(--muted);">이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</p>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          ${p.coupangProducts.map((prod) => `<a href="${escapeHtml(prod.url)}" target="_blank" rel="nofollow noopener sponsored" style="display:block;width:140px;text-decoration:none;color:var(--text);">
            ${prod.image ? `<img src="${escapeHtml(prod.image)}" alt="${escapeHtml(prod.name)}" style="width:140px;height:140px;object-fit:cover;border-radius:8px;background:var(--surface);">` : ''}
            <div style="font-size:12px;margin-top:6px;line-height:1.4;">${escapeHtml((prod.name || '').slice(0, 40))}</div>
            ${prod.price ? `<div style="font-size:13px;font-weight:700;margin-top:2px;">${Number(prod.price).toLocaleString('ko-KR')}원</div>` : ''}
          </a>`).join('')}
        </div>
      </div>` : ''}
      <div style="display:flex;gap:12px;align-items:flex-start;background:#FFFBEB;border:1.5px solid var(--amber);border-radius:10px;padding:16px 18px;margin:32px 0 0;">
        <span style="font-size:20px;line-height:1;">⚠️</span>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#7C2D12;">이 글과 이미지/음성은 AI가 자동 생성한 참고용 콘텐츠이며, 실제 사실과 다를 수 있습니다.${p.usedNews ? ' 실제 뉴스 검색 결과를 참고해 작성했지만, 원문과 대조 확인을 권장합니다.' : ' 실시간 뉴스 검색 없이 작성된 내용이니 최신성이 중요한 정보는 별도로 확인해주세요.'}</p>
      </div>
    </div>
    <footer><div class="wrap">life.news</div></footer>${youtubePollScript}`;

  return new Response(page(`${p.title} - life.news`, body, { description: makeExcerpt(p.intro, 150) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function renderAdminPage(env, requestUrl) {
  const oracleStats = await getOracleVmStats(env); // [2026-09-06 01:00] 관리자 페이지 최상단 표시용
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const posts = [];
  for (const slug of idx.slice(0, 50)) {
    const raw = await env.POSTS.get(`post:${slug}`);
    if (raw) posts.push(JSON.parse(raw));
  }
  const pendingVideoJobs = await env.POSTS.list({ prefix: 'videoJob:' });
  const pendingVeoSlugs = new Set(pendingVideoJobs.keys.map((k) => k.name.split(':')[1]));
  const pendingRenderJobs = await env.POSTS.list({ prefix: 'renderJob:' });
  const pendingRenderSlugs = new Set(pendingRenderJobs.keys.map((k) => k.name.split(':')[1]));
  // [2026-08-31] 유튜브 할당량 대기열 — 슬러그별 순번(1부터)을 미리 맵으로 만들어둠(목록 렌더링 중 매번 KV 조회하지 않도록)
  const ytQueue = await getYoutubeQueue(env);
  const ytQueuePos = new Map(ytQueue.items.map((it, i) => [it.slug, i + 1]));

  // 생성 중인(글+이미지+음성 아직 안 끝난) 작업들 — 완료되면 post로 바뀌면서 이 목록에서 빠짐
  const pendingGenJobsRaw = await env.POSTS.list({ prefix: 'genJob:' });
  const STALE_MS = 3 * 60 * 1000; // 3분 넘게 갱신 없으면 "멈춤" 경고 표시
  const CLEANUP_MS = 10 * 60 * 1000; // 10분 넘게 멈춰있으면 자동으로 지워서 목록에서 치움
  const FAILED_CLEANUP_MS = 3 * 60 * 1000; // 실패는 3분 정도 보여주고 나서 정리 (읽을 시간은 주되 계속 쌓이지 않게)
  const genJobs = [];
  const seenGenIds = new Set();
  for (const k of pendingGenJobsRaw.keys) {
    const raw = await env.POSTS.get(k.name);
    if (!raw) continue;
    const job = JSON.parse(raw);
    const cleanupThreshold = job.failed ? FAILED_CLEANUP_MS : CLEANUP_MS;
    const isVeryStale = Date.now() - (job.startedAt || 0) > cleanupThreshold;
    if (isVeryStale) {
      await env.POSTS.delete(k.name).catch(() => {}); // 죽은/실패한 작업 자동 정리 — 화면엔 아예 안 보여줌
      continue;
    }
    genJobs.push({ id: k.name.split(':')[1], ...job });
    seenGenIds.add(k.name.split(':')[1]);
  }

  // 방금 생성 버튼을 눌러 리다이렉트돼온 경우 — KV list()의 전세계 전파 지연으로 위 목록에 아직 안 잡혔을 수 있어서,
  // URL에 실어온 genId를 exact get으로 직접 확인해서 놓치지 않고 화면에 끼워넣음
  const freshGenId = requestUrl?.searchParams?.get('genId');
  if (freshGenId && !seenGenIds.has(freshGenId)) {
    const freshRaw = await env.POSTS.get(`genJob:${freshGenId}`);
    if (freshRaw) genJobs.unshift({ id: freshGenId, ...JSON.parse(freshRaw) });
  }

  // [2026-08-30 19:52] 최근 렌더링 실패 기록(3일 보관) — 이유를 그대로 보여줌. 글이 삭제된 실패는 여기서만 보임.
  const renderFailsRaw = await env.POSTS.list({ prefix: 'renderFail:' });
  const renderFails = [];
  for (const k of renderFailsRaw.keys.slice(0, 5)) {
    const raw = await env.POSTS.get(k.name);
    if (raw) renderFails.push(JSON.parse(raw));
  }
  renderFails.sort((a, b) => new Date(b.at) - new Date(a.at));
  const renderFailCards = renderFails.map((f) => `<div class="admin-card is-failed" style="grid-column:1/-1;display:block;">
    <div class="body">
      <div class="status-line" style="color:#92400E;">🎬❌ 렌더링 실패(${new Date(f.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}) — ${escapeHtml(f.title || f.slug)}${f.postDeleted ? ' · 글 자동삭제됨(오디오 검증)' : ''}<br>
      사유: ${escapeHtml(f.error || '기록 없음')}</div>
      <div class="actions"><form method="POST" action="/admin/dismiss-fail"><input type="hidden" name="slug" value="${escapeHtml(f.slug)}"><button type="submit">확인(지우기)</button></form></div>
    </div>
  </div>`).join('');

  // [2026-09-07 02:15] 글쓰기/이미지/음성 단계(genJob) 실패 기록 — 렌더링 실패랑 똑같이 며칠간 남겨서
  // 화면 갱신 타이밍을 놓쳐도 원인을 나중에 확인할 수 있게 함(예전엔 3분 지나면 흔적도 없이 사라졌음)
  const genFailsRaw = await env.POSTS.list({ prefix: 'genFail:' });
  const genFails = [];
  for (const k of genFailsRaw.keys.slice(0, 5)) {
    const raw = await env.POSTS.get(k.name);
    if (raw) genFails.push(JSON.parse(raw));
  }
  genFails.sort((a, b) => new Date(b.at) - new Date(a.at));
  const genFailCards = genFails.map((f) => `<div class="admin-card is-failed" style="grid-column:1/-1;display:block;">
    <div class="body">
      <div class="status-line" style="color:#92400E;">📝❌ 생성 실패(${new Date(f.at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}) — ${escapeHtml(f.topic || '(주제 없음)')}<br>
      사유: ${escapeHtml(f.error || '기록 없음')}</div>
      <div class="actions"><form method="POST" action="/admin/dismiss-fail"><input type="hidden" name="genId" value="${escapeHtml(f.id)}"><button type="submit">확인(지우기)</button></form></div>
    </div>
  </div>`).join('');

  // [2026-09-02 20:30] 전체진행률(0~100)을 하나의 바로 계산 — 글쓰기/음성/이미지(0~50%) → mp4 렌더링(50~80%) →
  // 유튜브 업로드(80~100%) 세 단계를 이어붙여서 보여줌. 서버 렌더링 시점의 초기값이고, 이후엔 클라이언트
  // 폴링(pollRender/stepGen)이 실측값으로 계속 갱신함.
  function genOverallPercent(genPercent) { return Math.round((genPercent || 0) * 0.5); }

  const genJobCards = genJobs.map((j) => {
    const isStale = !j.failed && (Date.now() - (j.startedAt || 0) > STALE_MS);
    const label = j.failed
      ? `❌ 생성 실패 — ${escapeHtml(truncErrText(j.error))}`
      : isStale
        ? `⚠️ 응답 없음(멈춤) — 마지막 상태: ${escapeHtml(j.stage || '')} ${j.percent || 0}% (10분 지나면 자동 정리)`
        : `📝 ${escapeHtml(j.stage || '진행 중')} · ${j.percent || 0}%`;
    const cancelBtn = j.failed ? '' : `<form method="POST" action="/admin/cancel-gen" onsubmit="return confirm('생성 취소할까요? 지금까지 만든 이미지·음성이 삭제됩니다.');"><input type="hidden" name="id" value="${j.id}"><button type="submit">🛑 취소</button></form>`;
    const thumb = j.images?.[0]
      ? (j.images[0].endsWith('.mp4') ? `<video muted preload="metadata" src="/media/${escapeHtml(j.images[0])}#t=0.1"></video>` : `<img src="/media/${escapeHtml(j.images[0])}" alt="">`)
      : `<div class="placeholder">📝</div>`;
    return `<div class="admin-card ${j.failed ? 'is-failed' : 'is-pending'}">
    <div class="thumb">${thumb}</div>
    <div class="body">
      <div class="title">${escapeHtml(j.topic)}</div>
      <span class="gen-progress status-line" data-id="${j.id}" data-stale="${isStale ? '1' : '0'}">${label}</span>
      ${j.failed ? '' : `<div class="progress-track"><div class="progress-fill" style="width:${genOverallPercent(j.percent)}%"></div></div>`}
      ${(j.logs && j.logs.length) ? `<pre class="gen-log" data-id="${j.id}" style="margin:6px 0 0;padding:6px 8px;background:#0b0b0b;color:#8f8;font-size:10px;line-height:1.4;max-height:90px;overflow-y:auto;border-radius:6px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(j.logs.join('\n'))}</pre>` : `<pre class="gen-log" data-id="${j.id}" style="margin:6px 0 0;padding:6px 8px;background:#0b0b0b;color:#8f8;font-size:10px;line-height:1.4;max-height:90px;overflow-y:auto;border-radius:6px;white-space:pre-wrap;word-break:break-all;display:none;"></pre>`}
      <div class="actions">${cancelBtn}</div>
    </div>
  </div>`;
  }).join('');

  const postCards = posts.map((p) => {
    const truncErr = (msg) => { const s = String(msg || ''); return s.length <= 260 ? s : s.slice(0, 100) + ' … ' + s.slice(-150); };
    const clipN = (p.images || []).filter((k) => k.endsWith('.mp4')).length;
    const photoN = (p.images || []).length - clipN;
    const mediaLabel = p.images?.length ? (clipN ? `🎞️ ${clipN}·🖼️ ${photoN}장` : `🖼️ ${photoN}장`) : '이미지 없음';
    const mediaStatus = p.video
      ? `✅ mp4로 통합됨${p.usedNews ? ' · 📰 뉴스참고' : ''}`
      : `${mediaLabel}${p.audio ? ' · 🔊 음성' : p.audioError ? ` · ⚠️ 음성실패` : ' · 🔇 음성없음'}${p.usedNews ? ' · 📰 뉴스참고' : ''}`;
    const isRendering = pendingRenderSlugs.has(p.slug) || pendingVeoSlugs.has(p.slug);
    const needsYoutubePoll = p.video && !p.youtubeUrl && !p.youtubeError;
    const shortsCountNum = (p.videoShorts && p.videoShorts.length) ? p.videoShorts.length : (p.videoShort ? 1 : 0);

    let statusLine, progressPct, isFailedCard, isPendingCard;
    if (p.video) {
      if (needsYoutubePoll) {
        statusLine = `<span class="render-progress" data-slug="${p.slug}">🎬 mp4 완료 · 유튜브 업로드 중${typeof p.youtubeUploadPercent === 'number' ? ` ${p.youtubeUploadPercent}%` : '…'}</span>`;
        progressPct = 80 + Math.round((p.youtubeUploadPercent || 0) * 0.2);
        isPendingCard = true;
      } else {
        const shareCaption = buildThreadsCaption(p);
        const threadsHref = `https://www.threads.net/intent/post?text=${encodeURIComponent(shareCaption)}`;
        const qPos = ytQueuePos.get(p.slug);
        const mainLine = p.youtubeUrl
          ? `<a href="${escapeHtml(p.youtubeUrl)}" target="_blank">▶ 본편</a>${p.youtubeUploadSec ? ` (${fmtDurSec(p.youtubeUploadSec)})` : ''}`
          : p.youtubeQuotaExceeded
            ? `⏳ 본편(할당량 초과·대기열 ${qPos || '?'}번째)`
            : `❌ 본편 실패(${escapeHtml((p.youtubeError || '').slice(0, 100))})`;
        const shortsUrls = p.youtubeShortsUrls && p.youtubeShortsUrls.length ? p.youtubeShortsUrls : (p.youtubeShortsUrl ? [p.youtubeShortsUrl] : []);
        const shortsErrors = p.youtubeShortsErrors && p.youtubeShortsErrors.length ? p.youtubeShortsErrors : (p.youtubeShortsError ? [p.youtubeShortsError] : []);
        const shortsCount = Math.max(shortsUrls.length, shortsErrors.length);
        let shortsLine = '';
        if (p.youtubeShortsSkippedReason) {
          shortsLine = ` · ⏳ 숏츠`;
        } else if (shortsCount) {
          shortsLine = Array.from({ length: shortsCount }, (_, si) => {
            if (shortsUrls[si]) return ` · <a href="${escapeHtml(shortsUrls[si])}" target="_blank">🩳${si + 1}</a>`;
            const errText = shortsErrors[si] || '';
            return errText.includes('할당량') ? ` · ⏳ 숏츠${si + 1}` : ` · ❌ 숏츠${si + 1}실패`;
          }).join('');
        }
        const shareBits = [
          `<a href="${escapeHtml(threadsHref)}" target="_blank">🧵</a>`,
          p.images?.[0] ? `<a href="/media/${escapeHtml(p.images[0])}" download>⬇️이미지</a>` : '',
          ...((p.videoShorts && p.videoShorts.length ? p.videoShorts : (p.videoShort ? [p.videoShort] : [])).map((k, si) => `<a href="/media/${escapeHtml(k)}" download>⬇️쇼츠${si + 1}</a>`)),
          `<button type="button" class="copy-cap" data-cap="${escapeHtml(shareCaption)}">📋</button>`,
        ].filter(Boolean).join('');
        statusLine = `${mainLine}${shortsLine}`;
        progressPct = 100;
      }
    } else if (isRendering) {
      statusLine = `<span class="render-progress" data-slug="${p.slug}">⏳ 렌더링 대기 중</span>`;
      progressPct = 50;
      isPendingCard = true;
    } else if (p.videoError) {
      statusLine = `❌ 실패: ${escapeHtml(truncErr(p.videoError))}`;
      progressPct = 0;
      isFailedCard = true;
    } else {
      statusLine = '—';
      progressPct = 0;
    }

    // [2026-09-06 03:30] R2 mp4가 지워졌으면(유튜브 업로드 성공 후) 유튜브 썸네일 이미지로 대체
    const thumb = (p.video && !p.videoDeletedFromR2)
      ? `<video muted preload="metadata" src="/media/${p.video}#t=0.1"></video>`
      : p.youtubeId
        ? `<img src="https://img.youtube.com/vi/${escapeHtml(p.youtubeId)}/hqdefault.jpg" alt="">`
        : p.images?.[0]
          ? (p.images[0].endsWith('.mp4') ? `<video muted preload="metadata" src="/media/${p.images[0]}#t=0.1"></video>` : `<img src="/media/${p.images[0]}" alt="">`)
          : `<div class="placeholder">📄</div>`;
    const durBadge = p.videoDurationSec && p.video ? `<span class="dur-badge">${fmtDurSec(p.videoDurationSec)}${shortsCountNum ? ` · 🩳${shortsCountNum}` : ''}</span>` : '';

    const retryBtn = (!p.video && !isRendering && p.videoError) ? `<form method="POST" action="/admin/retry-render"><input type="hidden" name="slug" value="${escapeHtml(p.slug)}"><button type="submit">🔁재시도</button></form>` : '';
    const shareBtnsHtml = (p.video && !needsYoutubePoll) ? (() => {
      const shareCaption = buildThreadsCaption(p);
      const threadsHref = `https://www.threads.net/intent/post?text=${encodeURIComponent(shareCaption)}`;
      return `<a href="${escapeHtml(threadsHref)}" target="_blank">🧵</a><button type="button" class="copy-cap" data-cap="${escapeHtml(shareCaption)}">📋</button>`;
    })() : '';

    return `<div class="admin-card ${isFailedCard ? 'is-failed' : isPendingCard ? 'is-pending' : ''}" data-post-slug="${escapeHtml(p.slug)}">
    <a class="thumb" href="/${p.slug}" target="_blank">${thumb}${durBadge}</a>
    <div class="body">
      <div class="title">${escapeHtml(p.title)}</div>
      <div class="topic">${escapeHtml(p.topic)}</div>
      <div class="status-line media-status">${mediaStatus}</div>
      <div class="status-line yt-status">${statusLine}</div>
      ${isRendering ? `<pre class="render-log" data-slug="${escapeHtml(p.slug)}" style="margin:6px 0 0;padding:6px 8px;background:#0b0b0b;color:#8f8;font-size:10px;line-height:1.4;max-height:90px;overflow-y:auto;border-radius:6px;white-space:pre-wrap;word-break:break-all;display:none;"></pre>` : ''}
      ${(isPendingCard || isFailedCard) ? `<div class="progress-track"><div class="progress-fill" style="width:${progressPct}%"></div></div>` : ''}
      <div class="date">${new Date(p.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</div>
      <div class="actions">
        <a href="/${p.slug}" target="_blank">보기</a>
        ${shareBtnsHtml}
        ${retryBtn}
        <form method="POST" action="/admin/delete"><input type="hidden" name="slug" value="${p.slug}"><button class="danger" type="submit">삭제</button></form>
      </div>
    </div>
  </div>`;
  }).join('');

  const hasPending = posts.some((p) => (!p.video && (pendingRenderSlugs.has(p.slug) || pendingVeoSlugs.has(p.slug))) || (p.video && !p.youtubeUrl && !p.youtubeError));
  const hasGenPending = genJobs.some((j) => !j.failed);
  const progressScript = (hasPending || hasGenPending) ? `<script>
    (function(){
      function bumpCount(delta){
        var h2 = document.querySelector('h2');
        if (!h2) return;
        var m = h2.textContent.match(/\\d+/);
        if (m) h2.textContent = h2.textContent.replace(/\\d+/, (parseInt(m[0], 10) + delta));
      }
      function esc(s){ return (s == null ? '' : String(s)); }
      function setBar(card, pct){
        if (!card) return;
        var bar = card.querySelector('.progress-fill');
        if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      }
      function insertPostCard(p){
        var emptyMsg = document.getElementById('empty-row');
        if (emptyMsg) emptyMsg.remove();
        var anchor = document.getElementById('posts-anchor');
        if (!anchor) return;
        var card = document.createElement('div');
        card.className = 'admin-card is-pending';
        card.dataset.postSlug = p.slug;
        card.innerHTML = '<a class="thumb" href="/' + p.slug + '" target="_blank"><div class="placeholder">🎬</div></a>' +
          '<div class="body">' +
          '<div class="title"></div>' +
          '<div class="topic"></div>' +
          '<div class="status-line media-status">' + ((p.imageCount ? ('🖼️ ' + p.imageCount + '장') : '이미지 없음') + (p.audio ? ' · 🔊 음성' : (p.audioError ? ' · ⚠️ 음성실패' : ' · 🔇 음성없음')) + (p.usedNews ? ' · 📰 뉴스참고' : '')) + '</div>' +
          '<div class="status-line yt-status"><span class="render-progress" data-slug="' + p.slug + '">⏳ 렌더링 대기 중</span></div>' +
          '<pre class="render-log" data-slug="' + p.slug + '" style="margin:6px 0 0;padding:6px 8px;background:#0b0b0b;color:#8f8;font-size:10px;line-height:1.4;max-height:90px;overflow-y:auto;border-radius:6px;white-space:pre-wrap;word-break:break-all;display:none;"></pre>' +
          '<div class="progress-track"><div class="progress-fill" style="width:50%"></div></div>' +
          '<div class="date"></div>' +
          '<div class="actions"><a href="/' + p.slug + '" target="_blank">보기</a>' +
          '<form method="POST" action="/admin/delete"><input type="hidden" name="slug" value="' + p.slug + '"><button class="danger" type="submit">삭제</button></form></div>' +
          '</div>';
        card.querySelector('.title').textContent = esc(p.title);
        card.querySelector('.topic').textContent = esc(p.topic);
        card.querySelector('.date').textContent = esc(p.createdAtText);
        anchor.insertAdjacentElement('afterend', card);
      }
      // [2026-09-07 01:30] 폴링이 실제로 살아있는지 눈으로 바로 확인할 수 있게, 진행 상황 옆에
      // "확인 HH:MM:SS" 시각을 매번 찍음 — 이 시각이 계속 바뀌면 폴링은 정상, 안 바뀌면 배포가
      // 안 됐거나 다른 문제가 있는 것으로 바로 구분됨.
      function nowHMS(){
        var d = new Date();
        function p2(n){ return String(n).padStart(2, '0'); }
        return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
      }
      function pollRender(){
        var renderEls = document.querySelectorAll('.render-progress');
        renderEls.forEach(function(el){
          if (el.dataset.terminal === '1') return;
          var slug = el.dataset.slug;
          var card = el.closest('.admin-card');
          // [2026-09-06 16:35] relay 실시간 로그 패널 — 데이터 오면 채우고 보이게 함
          var logEl = card ? card.querySelector('.render-log') : null;
          fetch('/admin/render-progress?slug=' + encodeURIComponent(slug), { cache: 'no-store' })
            .then(function(r){ return r.json(); })
            .then(function(data){
              if (logEl && Array.isArray(data.logs) && data.logs.length) {
                logEl.style.display = 'block';
                logEl.textContent = data.logs.join('\n');
                logEl.scrollTop = logEl.scrollHeight;
              }
              if (data.status === 'done') {
                var mediaEl = card ? card.querySelector('.media-status') : null;
                if (mediaEl) mediaEl.textContent = '✅ mp4로 통합됨';
                if (data.youtubeUrl) {
                  el.textContent = '';
                  var a = document.createElement('a'); a.href = data.youtubeUrl; a.target = '_blank'; a.textContent = '▶ 본편';
                  el.appendChild(a);
                  var shortsUrls = data.youtubeShortsUrls || (data.youtubeShortsUrl ? [data.youtubeShortsUrl] : []);
                  var shortsErrors = data.youtubeShortsErrors || [];
                  var shortsCount = Math.max(shortsUrls.length, shortsErrors.length);
                  var shortsStillQueued = false;
                  for (var si = 0; si < shortsCount; si++) {
                    el.appendChild(document.createTextNode(' · '));
                    if (shortsUrls[si]) {
                      var sa = document.createElement('a'); sa.href = shortsUrls[si]; sa.target = '_blank'; sa.textContent = '🩳' + (si + 1);
                      el.appendChild(sa);
                    } else if (shortsErrors[si] && shortsErrors[si].indexOf('할당량') !== -1) {
                      shortsStillQueued = true;
                      el.appendChild(document.createTextNode('⏳숏츠' + (si + 1)));
                    } else {
                      el.appendChild(document.createTextNode('❌숏츠' + (si + 1) + '실패'));
                    }
                  }
                  if (data.youtubeShortsSkippedReason) { shortsStillQueued = true; el.appendChild(document.createTextNode(' · ⏳숏츠')); }
                  el.dataset.terminal = shortsStillQueued ? '0' : '1';
                  setBar(card, 100);
                  if (card) card.classList.remove('is-pending');
                  if (!shortsStillQueued) refreshAdminList();
                } else if (data.youtubeError) {
                  el.textContent = data.youtubeQuotaExceeded ? '⏳ 본편(할당량 초과)' : ('❌ 본편실패(' + String(data.youtubeError).slice(0, 100) + ')');
                  el.dataset.terminal = '1';
                  setBar(card, 100);
                  refreshAdminList();
                } else {
                  var pct = (typeof data.youtubeUploadPercent === 'number') ? data.youtubeUploadPercent : null;
                  el.textContent = '🎬 mp4 완료 · 유튜브 업로드 중' + (pct !== null ? ' ' + pct + '%' : '…');
                  setBar(card, 80 + (pct || 0) * 0.2);
                  var lastPct = el.dataset.ytLastPct !== undefined ? parseInt(el.dataset.ytLastPct, 10) : -1;
                  var stalled = (pct !== null && pct === lastPct);
                  el.dataset.ytLastPct = pct === null ? '-1' : String(pct);
                  var stallTries = stalled ? (parseInt(el.dataset.ytStallTries || '0', 10) + 1) : 0;
                  el.dataset.ytStallTries = String(stallTries);
                  if (stallTries >= 20) { el.dataset.terminal = '1'; refreshAdminList(); }
                }
                return;
              }
              if (data.status === 'failed') {
                el.textContent = '❌ 렌더링 실패' + (data.error ? ': ' + String(data.error).slice(0, 150) : '');
                el.dataset.terminal = '1';
                if (card) { card.classList.remove('is-pending'); card.classList.add('is-failed'); }
                setBar(card, 0);
                refreshAdminList();
                return;
              }
              // relay가 주는 자체 percent(0~100)를 50~80% 구간으로 매핑
              var relayPct = typeof data.percent === 'number' ? data.percent : 0;
              el.textContent = (data.stage || '렌더링 중') + ' · ' + relayPct + '% · 확인 ' + nowHMS();
              setBar(card, 50 + relayPct * 0.3);
            })
            .catch(function(){});
        });
      }
      function stepGen(){
        var genEls = document.querySelectorAll('.gen-progress');
        genEls.forEach(function(el){
          if (el.dataset.terminal === '1') return;
          if (el.dataset.inflight === '1') return;
          el.dataset.inflight = '1';
          var card = el.closest('.admin-card');
          var baseText = el.textContent;
          var waitStarted = Date.now();
          var tickId = setInterval(function(){
            var sec = Math.floor((Date.now() - waitStarted) / 1000);
            el.textContent = baseText + ' · ' + sec + '초';
          }, 500);

          var id = el.dataset.id;
          // [2026-09-06 19:15] 버그 수정 — 이 요청이 응답을 오래 못 받으면(네트워크 문제, AI API 지연
          // 등) data-inflight가 '1'로 계속 남아서 다음 폴링이 전부 무시되고, 새로고침 전까진 화면이
          // 영원히 멈춰있는 것처럼 보였음. 25초 넘으면 강제로 포기하고 다음 틱에 바로 재시도되게
          // AbortController로 제한시간을 걺.
          var ctrl = new AbortController();
          var timeoutId = setTimeout(function(){ ctrl.abort(); }, 25000);
          fetch('/admin/generate-step', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id }),
            signal: ctrl.signal,
            cache: 'no-store',
          })
            .then(function(r){ return r.json(); })
            .then(function(data){
              clearTimeout(timeoutId);
              clearInterval(tickId);
              el.dataset.inflight = '0';
              // [2026-09-06 16:50] 실시간 로그 패널 갱신
              var logEl = card ? card.querySelector('.gen-log') : null;
              if (logEl && Array.isArray(data.logs) && data.logs.length) {
                logEl.style.display = 'block';
                logEl.textContent = data.logs.join('\n');
                logEl.scrollTop = logEl.scrollHeight;
              }
              if (data.status === 'done') {
                el.dataset.terminal = '1';
                if (card) card.remove();
                if (data.post) insertPostCard(data.post);
                bumpCount(1);
                refreshAdminList();
                return;
              }
              if (data.status === 'not_found') {
                el.textContent = '(사라진 작업)';
                el.dataset.terminal = '1';
                refreshAdminList();
                return;
              }
              if (data.status === 'failed') {
                el.textContent = '❌ 생성 실패: ' + (function(s){ s = String(s || ''); return s.length <= 300 ? s : s.slice(0, 150) + ' … ' + s.slice(-150); })(data.error);
                el.dataset.terminal = '1';
                if (card) { card.classList.remove('is-pending'); card.classList.add('is-failed'); }
                setBar(card, 0);
                refreshAdminList();
                return;
              }
              el.textContent = (data.stage || '진행 중') + ' · ' + (data.percent || 0) + '% · 확인 ' + nowHMS();
              setBar(card, (data.percent || 0) * 0.5);
            })
            .catch(function(){
              clearTimeout(timeoutId);
              clearInterval(tickId);
              el.dataset.inflight = '0';
            });
        });
      }
      pollRender();
      stepGen();
      setInterval(pollRender, 1000);
      setInterval(stepGen, 1000);
    })();
  </script>` : '';

  const monthUsagePctText = (v) => (oracleStats?.monthNetOutGb != null && oracleStats?.egressLimitGb) ? ` · 📊 이번달 아웃바운드 ${oracleStats.monthNetOutGb}GB / ${(oracleStats.egressLimitGb / 1024)}TB(무료한도 ${Math.round((oracleStats.monthNetOutGb / oracleStats.egressLimitGb) * 1000) / 10}% 사용)` : '';
  const oracleStatsBar = `<div class="mono" id="oracle-stats-bar" style="font-size:12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:8px 12px;margin-bottom:12px;${oracleStats ? '' : 'display:none;'}">
    🖥️ Oracle VM 최근 1시간 — CPU 평균 ${oracleStats?.cpuPercent ?? '—'}%${oracleStats?.netInMb != null ? ` · 📥 ${oracleStats.netInMb}MB` : ''}${oracleStats?.netOutMb != null ? ` · 📤 ${oracleStats.netOutMb}MB` : ''}${monthUsagePctText()} · 💰 Always Free 사용 중($0)
  </div>
  <script>
    // [2026-09-06 02:00] 30초마다 갱신 — OCI 메트릭은 1분 해상도라 이보다 더 자주 갱신해도 의미 없음
    (function(){
      var bar = document.getElementById('oracle-stats-bar');
      if (!bar) return;
      function poll(){
        fetch('/admin/oracle-stats').then(function(r){ return r.json(); }).then(function(s){
          if (!s || s.cpuPercent === undefined) return; // 시크릿 미설정 등 — 조용히 무시
          bar.style.display = '';
          // [2026-09-06 02:20] 이번 달 아웃바운드 사용량 / 무료 한도(10TB) — "내가 쓸 수 있는 양" 표시
          var monthText = '';
          if (s.monthNetOutGb != null && s.egressLimitGb) {
            var pct = Math.round((s.monthNetOutGb / s.egressLimitGb) * 1000) / 10;
            monthText = ' · 📊 이번달 아웃바운드 ' + s.monthNetOutGb + 'GB / ' + (s.egressLimitGb / 1024) + 'TB(무료한도 ' + pct + '% 사용)';
          }
          bar.textContent = '🖥️ Oracle VM 최근 1시간 — CPU 평균 ' + (s.cpuPercent ?? '—') + '%'
            + (s.netInMb != null ? ' · 📥 ' + s.netInMb + 'MB' : '')
            + (s.netOutMb != null ? ' · 📤 ' + s.netOutMb + 'MB' : '')
            + monthText
            + ' · 💰 Always Free 사용 중($0)';
        }).catch(function(){});
      }
      setInterval(poll, 30000);
    })();
  </script>`;

  const body = `${siteHeader()}<div class="wrap" style="padding:32px 0;">
    ${oracleStatsBar}
    <h2>관리자 (총 ${idx.length}건)</h2>
    <p class="mono" style="color:var(--muted);font-size:12px;">생성은 백그라운드로 처리돼요 — 눌러도 바로 페이지가 돌아와요. 이 페이지를 열어두면 1.5초마다 빠르게 진행되고, 닫아도 1분마다 크론이 대신 이어서 진행해요(다만 느려요).</p>
    <form method="POST" action="/admin/generate" style="display:flex;gap:8px;margin:16px 0;flex-wrap:wrap;" id="gen-form" onsubmit="this.querySelector('button[type=submit]').disabled=true; this.querySelector('button[type=submit]').textContent='생성 중...';">
      <input type="text" name="topic" id="topic-input" placeholder="생활뉴스 주제 (예: 여름철 냉방병 예방법)" maxlength="100" style="flex:1;min-width:200px;" required>
      <button type="button" id="media-upload-btn">📎 미디어 추가</button>
      <button type="button" id="script-btn">📝 대본 먼저 만들기</button>
      <button type="submit">글+슬라이드쇼 생성</button>
      <textarea name="detail" id="detail-input" placeholder="상세 내용(선택) — 다룰 내용을 자세히 적을수록 글과 이미지 정확도가 올라가요" maxlength="2000" rows="2" style="width:100%;resize:vertical;padding:9px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-family:inherit;"></textarea>
      <input type="hidden" name="userMediaKeys" id="user-media-keys-input" value="[]">
      <input type="hidden" name="customScript" id="custom-script-input" value="">
      <input type="file" id="media-upload-input" accept="image/*,video/*" multiple style="display:none;">
      <div id="media-upload-list" style="width:100%;"></div>
      <div id="script-preview" style="display:none;width:100%;">
        <p class="mono" style="color:var(--muted);font-size:12px;margin:8px 0 4px;">대본을 검토/수정한 뒤 "이 대본으로 생성"을 누르세요. 형식([도입부]/[소제목: ...]/[마무리])만 그대로 두면 자유롭게 고쳐도 됩니다.</p>
        <textarea id="script-textarea" rows="16" style="width:100%;resize:vertical;padding:9px 12px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);font-size:13px;font-family:inherit;white-space:pre-wrap;"></textarea>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button type="button" id="script-use-btn">✅ 이 대본으로 생성</button>
          <button type="button" id="script-cancel-btn">취소</button>
        </div>
      </div>
    </form>
    <div class="admin-grid" id="admin-tbody">${renderFailCards}${genFailCards}${genJobCards}<div id="posts-anchor" style="display:none;"></div>${postCards || '<p id="empty-row" style="grid-column:1/-1;color:var(--muted);">글이 없습니다.</p>'}</div>
  </div><script>
    // [2026-09-07 00:10] "대본 먼저 만들기" — 이미지/음성/렌더링 없이 글쓰기만 빠르게 해서 미리 보여주고,
    // 검토/수정 후 그 내용 그대로(또는 고친 대로) 최종 생성에 넘김.
    (function(){
      var scriptBtn = document.getElementById('script-btn');
      var scriptPreview = document.getElementById('script-preview');
      var scriptTextarea = document.getElementById('script-textarea');
      var customScriptInput = document.getElementById('custom-script-input');
      var useBtn = document.getElementById('script-use-btn');
      var cancelBtn = document.getElementById('script-cancel-btn');
      var genForm = document.getElementById('gen-form');
      var submitBtn = genForm.querySelector('button[type=submit]');
      if (!scriptBtn) return;
      scriptBtn.addEventListener('click', function(){
        var topic = document.getElementById('topic-input').value.trim();
        if (!topic) { alert('주제를 먼저 입력해주세요'); return; }
        var detail = document.getElementById('detail-input').value.trim();
        scriptBtn.disabled = true;
        scriptBtn.textContent = '대본 만드는 중...';
        fetch('/admin/generate-script', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: topic, detail: detail }),
        })
          .then(function(r){ return r.json(); })
          .then(function(data){
            scriptBtn.disabled = false;
            scriptBtn.textContent = '📝 대본 먼저 만들기';
            if (!data.ok) { alert('대본 생성 실패: ' + (data.error || '알 수 없는 오류')); return; }
            scriptTextarea.value = data.scriptText;
            scriptPreview.style.display = 'block';
            submitBtn.style.display = 'none'; // 대본 검토 중엔 "바로 생성" 버튼 숨김(혼동 방지)
          })
          .catch(function(e){
            scriptBtn.disabled = false;
            scriptBtn.textContent = '📝 대본 먼저 만들기';
            alert('대본 생성 중 오류: ' + e.message);
          });
      });
      useBtn.addEventListener('click', function(){
        customScriptInput.value = scriptTextarea.value;
        genForm.requestSubmit ? genForm.requestSubmit() : genForm.submit();
      });
      cancelBtn.addEventListener('click', function(){
        scriptPreview.style.display = 'none';
        customScriptInput.value = '';
        submitBtn.style.display = '';
      });
    })();
    // [2026-09-02 20:45] 첨부 미디어 업로드 — 사진은 canvas로 리사이즈(전송 용이)해서 보내고,
    // 동영상은 어차피 relay가 최종 렌더링 때 다시 인코딩하므로 원본 그대로 올림.
    (function(){
      var uploadBtn = document.getElementById('media-upload-btn');
      var fileInput = document.getElementById('media-upload-input');
      var listEl = document.getElementById('media-upload-list');
      var keysInput = document.getElementById('user-media-keys-input');
      if (!uploadBtn || !fileInput) return;
      var uploadedFiles = []; // {key, isVideo, name}
      var UPLOAD_MAX = 10;

      function resizeImageFile(file, maxDim){
        return new Promise(function(resolve){
          var img = new Image();
          var url = URL.createObjectURL(file);
          img.onload = function(){
            var w = img.width, h = img.height;
            var scale = Math.min(1, maxDim / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement('canvas');
            canvas.width = cw; canvas.height = ch;
            var ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, cw, ch);
            canvas.toBlob(function(blob){ URL.revokeObjectURL(url); resolve(blob || file); }, 'image/jpeg', 0.85);
          };
          img.onerror = function(){ URL.revokeObjectURL(url); resolve(file); };
          img.src = url;
        });
      }

      function renderList(){
        listEl.innerHTML = '';
        keysInput.value = JSON.stringify(uploadedFiles.map(function(f){ return f.key; }));
        uploadedFiles.forEach(function(f, idx){
          var chip = document.createElement('span');
          chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:3px 8px;margin:4px 4px 0 0;font-size:11px;';
          var label = document.createElement('span');
          label.textContent = (f.isVideo ? '🎞️ ' : '🖼️ ') + (f.name || '').slice(0, 14);
          chip.appendChild(label);
          var rm = document.createElement('button');
          rm.type = 'button'; rm.textContent = '✕';
          rm.style.cssText = 'border:none;background:none;cursor:pointer;font-size:11px;padding:0;margin-left:2px;color:var(--muted);';
          rm.addEventListener('click', function(){ uploadedFiles.splice(idx, 1); renderList(); });
          chip.appendChild(rm);
          listEl.appendChild(chip);
        });
      }

      uploadBtn.addEventListener('click', function(){ fileInput.click(); });
      fileInput.addEventListener('change', async function(e){
        var files = Array.prototype.slice.call(e.target.files || []);
        if (!files.length) return;
        if (uploadedFiles.length + files.length > UPLOAD_MAX) {
          alert('최대 ' + UPLOAD_MAX + '개까지 첨부할 수 있어요');
          fileInput.value = '';
          return;
        }
        uploadBtn.disabled = true;
        var origText = uploadBtn.textContent;
        uploadBtn.textContent = '업로드 중...';
        try {
          var fd = new FormData();
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f.type.indexOf('image/') === 0) {
              var blob = await resizeImageFile(f, 1600);
              fd.append('files', blob, (f.name || 'image').replace(/\\.[^.]+$/, '') + '.jpg');
            } else {
              fd.append('files', f, f.name);
            }
          }
          var res = await fetch('/admin/upload-media', { method: 'POST', body: fd });
          var data = await res.json();
          if (data.ok && data.files) {
            uploadedFiles = uploadedFiles.concat(data.files);
            renderList();
          } else {
            alert(data.error || '업로드 실패');
          }
        } catch (err) {
          alert('업로드 실패');
        }
        uploadBtn.disabled = false;
        uploadBtn.textContent = origText;
        fileInput.value = '';
      });
    })();
    document.addEventListener('click', function(e){
      var btn = e.target.closest('.copy-cap');
      if (!btn) return;
      navigator.clipboard.writeText(btn.dataset.cap || '').then(function(){
        var orig = btn.textContent;
        btn.textContent = '✅';
        setTimeout(function(){ btn.textContent = orig; }, 1500);
      });
    });
    var refreshingList = false;
    function refreshAdminList() {
      if (refreshingList) return;
      refreshingList = true;
      fetch(location.pathname + location.search)
        .then(function(r){ return r.text(); })
        .then(function(html){
          var doc = new DOMParser().parseFromString(html, 'text/html');
          var freshGrid = doc.getElementById('admin-tbody');
          var curGrid = document.getElementById('admin-tbody');
          if (freshGrid && curGrid) curGrid.innerHTML = freshGrid.innerHTML;
        })
        .catch(function(){})
        .finally(function(){ refreshingList = false; });
    }
  </script>${progressScript}`;

  return new Response(page('관리자 - life.news', body, { noindex: true }), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// 생성 과정을 "한 단계씩" 잘게 쪼갠 상태머신 — 매 호출마다 딱 한 걸음만 진행하고 KV에 상태를 저장.
// 각 단계가 몇 초 안에 끝나서 Workers/waitUntil 시간제한에 안 걸림. 관리자 페이지가 이걸 반복 호출해서 진행시킴.
// [2026-09-06 16:50] 글 생성 과정 실시간 로그 — 관리자 페이지에서 바로 보여주기 위해 각 단계마다
// 짧은 진행 기록을 job.logs에 쌓음(최근 40개만 유지, KV에 그대로 저장되므로 폴링할 때마다 같이 옴).
function pushLog(job, msg) {
  const logs = Array.isArray(job.logs) ? job.logs.slice(-39) : [];
  logs.push(msg);
  return logs;
}

async function runGenerationStep(job, env) {
  const topic = job.topic;

  if (job.stage === 'start') {
    const slug = String(Date.now());
    let article, usedNews;
    let newsResults = []; // [2026-09-07 02:00] 버그 수정 — customScript 경로에서 이 변수가 아예
    // 안 만들어지던 문제로 "newsResults is not defined" 오류가 났음. 항상 바깥 스코프에 빈 배열로
    // 미리 선언해서, 아래 로그 줄에서 어느 경로를 타든 절대 참조 오류가 안 나게 함.
    if (job.customScript) {
      // [2026-09-07 00:10] 미리 검토/수정한 대본이 있으면 AI 글쓰기를 건너뛰고 그 대본을 그대로 씀
      article = parseScriptToArticle(job.customScript, topic);
      usedNews = false;
    } else {
      newsResults = await searchNaverNews(topic, env);
      const { article: generated, error: articleError } = await generateArticle(topic, newsResults, env, job.detail);
      if (!generated) throw new Error(`글 생성 실패 — ${articleError || '알 수 없는 오류'}`);
      article = generated;
      usedNews = newsResults.length > 0;
    }
    // [2026-09-02 21:20] 문장을 5초 단위로 자연스럽게 재편집(reeditForTtsPacing)한 뒤 정규화/자름
    const rawNarration = [stripHtml(article.intro_html), ...(article.sections || []).map((s) => stripHtml(s.body_html)), stripHtml(article.outro_html)].join(' ');
    const pacedNarration = await reeditForTtsPacing(rawNarration, env);
    const narrationText = trimNarrationToSentence(normalizeNarrationSpacing(pacedNarration), NARRATION_MAX_CHARS);
    // 음성은 문장 몇 개씩 묶은 "세그먼트" 단위로 따로 합성(자막-음성 싱크를 실측으로 맞추기 위함).
    // 목소리는 여기서 한 번 뽑아 영상 전체에 고정 — 세그먼트마다 목소리가 바뀌면 안 되니까.
    const segments = planAudioSegments(prepareNarrationSentences(narrationText), 1); // [2026-08-30 21:51] 문장 하나 = 조각 하나: 모든 문장 시작마다 타이밍이 실측값으로 리셋돼 싱크가 엉킬 수 없음(사용자 제안)
    return {
      ...job, slug, article, usedNews, narrationText,
      segTexts: segments.map((s) => s.text), segSentences: segments.map((s) => s.sentences),
      ttsVoices: pickTtsVoices(), segDone: 0, audioSegmentKeys: [],
      stage: 'audio', percent: 15,
      logs: pushLog(job, `📝 ${job.customScript ? '검토된 대본 사용' : '글쓰기 완료'}: "${article.title}" (${narrationText.length}자, 문장 ${segments.length}개${usedNews ? `, 뉴스 ${newsResults.length}건 참고` : ''})`),
    };
  }

  if (job.stage === 'audio') {
    // 세그먼트를 몇 개씩(배치) 합성해 R2에 저장 — 한 스텝이 몇 초 안에 끝나도록 나눠서 진행.
    // 세그먼트 하나라도 최종 실패하면 무음/불일치 영상을 만들 수 없으니 여기서 중단(이미 올린 조각 정리).
    const AUDIO_BATCH = 4;
    if (!env.MEDIA) return { ...job, audioKey: null, audioError: 'MEDIA(R2) 바인딩 없음', scenes: [], sceneIndex: 0, images: [], stage: 'finalize', percent: 30 };
    const keys = job.audioSegmentKeys.slice();
    let segDone = job.segDone;
    const batchEnd = Math.min(segDone + AUDIO_BATCH, job.segTexts.length);
    for (; segDone < batchEnd; segDone++) {
      const { buffer, error } = await generateNarrationAudioWithRetry(job.segTexts[segDone], env, 2, job.ttsVoices);
      if (!buffer) {
        await Promise.all(keys.map((k) => env.MEDIA.delete(k).catch(() => {})));
        // [2026-09-02 20:45] 사용자가 첨부한 미디어는 이 시점엔 아직 job.images에 안 들어가 있어서
        // (audio-concat 단계에서 시딩됨) 여기서 따로 지워줘야 고아 파일이 안 남음
        if (job.userMediaKeys?.length) {
          await Promise.all(job.userMediaKeys.map((k) => env.MEDIA.delete(k).catch(() => {})));
        }
        throw new Error(`음성 세그먼트 ${segDone + 1}/${job.segTexts.length} 합성 최종 실패로 발행 중단 — ${error || '알 수 없는 오류'}`);
      }
      const key = `${job.slug}-narr-${segDone}.mp3`;
      await env.MEDIA.put(key, buffer, { httpMetadata: { contentType: 'audio/mpeg' } });
      keys.push(key);
    }
    const allDone = segDone >= job.segTexts.length;
    return {
      ...job, segDone, audioSegmentKeys: keys,
      stage: allDone ? 'audio-concat' : 'audio',
      percent: 15 + Math.round((segDone / (job.segTexts.length || 1)) * 13), // 15~28%
      logs: pushLog(job, `🔊 음성 합성 ${segDone}/${job.segTexts.length} 완료`),
    };
  }

  if (job.stage === 'audio-concat') {
    // 세그먼트들을 이어붙인 전체 나레이션 mp3 하나를 만들어 저장 — 웹 슬라이드쇼 재생용(post.audio).
    // 실제 mp4 렌더링은 이 파일이 아니라 세그먼트 원본들을 릴레이가 직접 이어붙여 씀(그래야 실측 타이밍이 정확).
    const buffers = [];
    for (const key of job.audioSegmentKeys) {
      const obj = await env.MEDIA.get(key);
      if (!obj) throw new Error(`음성 세그먼트 유실(${key}) — 발행 중단`);
      buffers.push(await obj.arrayBuffer());
    }
    const audioKey = `${job.slug}-narration.mp3`;
    await env.MEDIA.put(audioKey, concatAudioBuffers(buffers), { httpMetadata: { contentType: 'audio/mpeg' } });
    // [2026-09-02 20:45] 사용자가 직접 첨부한 미디어(job.userMediaKeys)를 images 맨 앞에 그대로 배치하고,
    // AI는 나머지 자리(SCENE_COUNT - 첨부 개수)만 생성하도록 요청 장면 수를 줄임
    const userMediaKeys = Array.isArray(job.userMediaKeys) ? job.userMediaKeys : [];
    const wantAiScenes = Math.max(0, SCENE_COUNT - userMediaKeys.length);
    // [2026-09-07 01:45] 첨부 미디어(첫 번째 이미지, 클립 제외)를 AI로 분석해서 뭐가 나오는지 파악
    // → AI가 만드는 나머지 장면 키워드가 첨부 이미지 분위기/소재와 더 잘 어울리게 유도(정확도 개선)
    let attachedMediaContext = '';
    const firstAttachedImageKey = userMediaKeys.find((k) => !/\.mp4$/i.test(k));
    if (firstAttachedImageKey && env.MEDIA) {
      const mediaObj = await env.MEDIA.get(firstAttachedImageKey);
      if (mediaObj) {
        const desc = await analyzeAttachedMediaForContext(await mediaObj.arrayBuffer(), mediaObj.httpMetadata?.contentType, env);
        if (desc) attachedMediaContext = `\n\n사용자가 직접 첨부한 사진에는 이런 게 나옵니다(참고해서 나머지 장면들의 분위기/소재를 맞춰줘): ${desc}`;
      }
    }
    const scenes = wantAiScenes ? await generateScenePrompts(topic, job.article.title, env, wantAiScenes, buildArticleDigestForScenes(job.article) + attachedMediaContext) : [];
    return {
      ...job, audioKey, audioError: null, scenes, sceneIndex: 0, images: userMediaKeys.slice(), stage: scenes.length ? 'images' : 'finalize', percent: 30,
      logs: pushLog(job, `🎬 장면 구상 완료: AI 장면 ${scenes.length}개${userMediaKeys.length ? ` + 첨부 미디어 ${userMediaKeys.length}개` : ''}${attachedMediaContext ? ' (첨부 이미지 분석 반영됨)' : ''}`),
    };
  }

  if (job.stage === 'images') {
    // [2026-08-30 19:10] 장면 일부는 사진 대신 실사 클립(mp4) 사용 — CLIP_TARGET개를 영상 전체에 고르게 분산.
    // 슬롯 규칙: k번째 클립은 sceneIndex ≥ k*(전체/CLIP_TARGET)부터 시도 — 해당 장면에서 연관 클립을 못
    // 찾으면 사진으로 넘어가고, 다음 장면들에서 계속 클립을 노림(찾을 때까지). 확장자(.mp4/.jpg)로 종류 구분.
    const scene = job.scenes[job.sceneIndex];
    const images = job.images.slice();
    let clipCount = job.clipCount || 0;
    let resultKind = '실패(건너뜀)';
    if (scene) {
      const slotStart = clipCount * Math.max(1, Math.floor(job.scenes.length / CLIP_TARGET));
      const wantClip = clipCount < CLIP_TARGET && job.sceneIndex >= slotStart;
      let stored = false;
      if (wantClip) {
        const clip = await getSceneClip(scene, topic, env);
        if (clip) {
          const key = `${job.slug}-scene-${images.length}.mp4`;
          await env.MEDIA.put(key, clip, { httpMetadata: { contentType: 'video/mp4' } });
          images.push(key);
          clipCount++;
          stored = true;
          resultKind = '실사 클립';
        }
      }
      if (!stored) {
        const img = await getSceneImage(scene, topic, env);
        if (img) {
          const key = `${job.slug}-scene-${images.length}.jpg`;
          await env.MEDIA.put(key, img, { httpMetadata: { contentType: 'image/jpeg' } });
          images.push(key);
          resultKind = '이미지';
        }
      }
    }
    const nextIndex = job.sceneIndex + 1;
    const done = nextIndex >= job.scenes.length;
    return {
      ...job, images, clipCount, sceneIndex: nextIndex,
      stage: done ? 'finalize' : 'images',
      percent: 30 + Math.round((nextIndex / job.scenes.length) * 45), // 30~75%
      logs: pushLog(job, `🖼️ 장면 ${nextIndex}/${job.scenes.length}: ${resultKind}${scene?.keyword ? ` ("${scene.keyword}")` : ''}`),
    };
  }

  if (job.stage === 'finalize') {
    // 음성이 끝내 실패했으면(재시도 다 소진) 무음 영상을 조용히 발행하는 대신 여기서 중단 —
    // 이미 올려둔 장면 이미지는 정리하고 실패로 처리(글 자체를 안 만듦, handleGenerateStep의 catch가 job.failed 처리).
    if (!job.audioKey) {
      if (job.images?.length && env.MEDIA) {
        await Promise.all(job.images.map((k) => env.MEDIA.delete(k).catch(() => {})));
      }
      if (job.audioSegmentKeys?.length && env.MEDIA) {
        await Promise.all(job.audioSegmentKeys.map((k) => env.MEDIA.delete(k).catch(() => {})));
      }
      throw new Error(`음성 생성 최종 실패로 발행 중단 — ${job.audioError || '알 수 없는 오류'}`);
    }
    // 자막 위치/폰트/색은 이 영상 하나에 쓸 값을 미리 하나씩 고정 선택 — 비트마다 안 바뀌고 영상 전체 동일.
    const { captionFontKey, captionColor, captionPositionIndex } = pickCaptionStyle();
    // 문장마다 어떤 음성 세그먼트에서 나왔는지(segIndex)를 자막 비트에 실어 보냄 — 릴레이가 실측 타이밍에 씀.
    const sentenceInfos = buildSentenceInfos(job.segSentences);
    const perImageChunks = splitTextIntoNChunks(sentenceInfos, job.images.length || 1);
    const captionWeights = [];
    const captionBeats = [];
    for (let i = 0; i < job.images.length; i++) {
      const chunk = perImageChunks[i] || { sentences: [], weight: 1 / (job.images.length || 1) };
      captionWeights.push(chunk.weight);
      const beats = buildCaptionBeats(chunk.sentences, captionPositionIndex);
      captionBeats.push(beats);
    }
    // [2026-09-02 21:05] 쇼츠용 하이라이트 구간 — 실패해도 발행은 막지 않음(null이면 relay가 예전 로직으로 폴백)
    const highlightSegRange = await pickHighlightRange(job.segTexts || [], topic, env);
    // [2026-09-07 01:10] 쿠팡파트너스 관련 상품 — 실패해도(키 미설정/API 오류) 발행은 막지 않음
    const coupangProducts = await searchCoupangProducts(topic, env, 3);
    const post = {
      slug: job.slug, topic, title: job.article.title, createdAt: new Date().toISOString(),
      intro: job.article.intro_html, sections: job.article.sections || [], outro: job.article.outro_html,
      images: job.images, audio: job.audioKey, audioSegments: job.audioSegmentKeys, audioError: job.audioError, usedNews: job.usedNews, captionWeights, captionBeats, captionFontKey, captionColor, highlightSegRange, coupangProducts,
      generationSec: job.createdAt ? Math.round((Date.now() - job.createdAt) / 1000) : null, // [2026-08-30 19:45] 생성 버튼 → 글 저장까지 걸린 시간(관리자 표시용)
      threadsText: (job.article.threads_text || '').toString().slice(0, 450), // [2026-08-30 22:20] 스레드 공유용 홍보문(글 생성 때 같이 만들어짐)
    };
    await env.POSTS.put(`post:${job.slug}`, JSON.stringify(post));
    const idxRaw = await env.POSTS.get('index');
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    // [2026-09-02 20:21] 최후의 안전장치 — 위 락으로 거의 다 막히지만 KV 왕복시간만큼의 아주 좁은 경쟁
    // 창이 여전히 이론상 남아있어서, finalize가 혹시 겹쳐 실행돼도 같은 slug가 index에 두 번 안 쌓이게 함
    if (!idx.includes(job.slug)) idx.unshift(job.slug);
    await env.POSTS.put('index', JSON.stringify(idx.slice(0, 500)));
    return {
      ...job, captionWeights, captionBeats, captionFontKey, captionColor, highlightSegRange, stage: 'render', percent: 90,
      logs: pushLog(job, `💾 글 저장 완료 — 이미지 ${job.images.length}장${coupangProducts.length ? `, 쿠팡 상품 ${coupangProducts.length}개` : ''}, 렌더링 대기열 등록 중`),
    };
  }

  if (job.stage === 'render') {
    let renderLogMsg = '⚠️ 렌더링 시작 조건 미충족(relay 미설정 또는 이미지 없음)';
    if (env.RELAY_URL && env.RELAY_SECRET && env.MEDIA && job.images.length) {
      const outputKey = `${job.slug}.mp4`;
      // [2026-08-31 07:29] 3개→1개: 유튜브 일일 업로드 할당량(10,000유닛, 건당 1,600) 절약 위해 축소(사용자 요청)
      const shortKeys = [`${job.slug}-short.mp4`];
      const render = await startRelayRender(job.images, job.audioKey, job.audioSegmentKeys, outputKey, shortKeys, job.captionWeights, job.captionBeats, job.captionFontKey, job.captionColor, env, job.highlightSegRange);
      if (render.ok) {
        await env.POSTS.put(`renderJob:${job.slug}`, JSON.stringify({
          jobId: render.jobId, slug: job.slug, r2Key: outputKey, shortKeys, startedAt: Date.now(),
        }));
        renderLogMsg = `🎞️ relay에 렌더링 요청 완료(jobId: ${render.jobId}) — 이후 진행률은 렌더링 카드에서 확인`;
      } else {
        const postRaw = await env.POSTS.get(`post:${job.slug}`);
        if (postRaw) {
          const post = JSON.parse(postRaw);
          post.videoError = render.error;
          await env.POSTS.put(`post:${job.slug}`, JSON.stringify(post));
        }
        renderLogMsg = `❌ relay 렌더링 요청 실패: ${render.error || '알 수 없는 오류'}`;
      }
    }
    return { ...job, stage: 'done', percent: 100, logs: pushLog(job, renderLogMsg) };
  }

  if (job.stage === 'done') return job;

  // 예전 방식으로 만들어지다 만 유령 작업(형식이 안 맞음) — 계속 살려두면 정리 타이머가 매번 리셋돼서
  // 영원히 "진행 중"처럼 보이게 됨. 여기서 확실히 실패로 끊어서 정리 대상이 되게 함.
  throw new Error('알 수 없는 상태 — 예전 버전에서 만들다 만 작업으로 보입니다. 삭제하고 다시 시도해주세요.');
}

async function handleGenerateStep(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const id = body.id;
  if (!id) return new Response(JSON.stringify({ error: 'id 필요' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  const raw = await env.POSTS.get(`genJob:${id}`);
  if (!raw) return new Response(JSON.stringify({ status: 'not_found' }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  let job = JSON.parse(raw);

  if (job.failed) {
    return new Response(JSON.stringify({ status: 'failed', topic: job.topic, error: job.error }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  // [2026-09-02 20:21] 동시실행 방지 — 방금 다른 경로(1분 크론/relay tick)가 이 job을 잡았으면
  // 이번 호출은 아무것도 안 하고 현재 상태만 그대로 돌려줌(진행률 표시는 계속 자연스럽게 보임)
  if (job.lockedAt && Date.now() - job.lockedAt < GEN_JOB_LOCK_MS) {
    return new Response(JSON.stringify({ status: 'processing', topic: job.topic, stage: job.stage, percent: job.percent, logs: job.logs || [] }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  await env.POSTS.put(`genJob:${id}`, JSON.stringify({ ...job, lockedAt: Date.now() })).catch(() => {});

  try {
    job = await runGenerationStep(job, env);
    if (job.stage === 'done') {
      await env.POSTS.delete(`genJob:${id}`);
      const postRaw = await env.POSTS.get(`post:${job.slug}`);
      const post = postRaw ? JSON.parse(postRaw) : null;
      return new Response(JSON.stringify({
        status: 'done',
        slug: job.slug,
        logs: job.logs || [],
        post: post ? {
          title: post.title, topic: post.topic, slug: post.slug,
          imageCount: post.images?.length || 0, audio: !!post.audio, audioError: post.audioError || null, usedNews: !!post.usedNews,
          createdAtText: new Date(post.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
        } : null,
      }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    job.startedAt = Date.now(); // 마지막 갱신 시각(멈춤 판정용)
    await env.POSTS.put(`genJob:${id}`, JSON.stringify(job));
    return new Response(JSON.stringify({ status: 'processing', topic: job.topic, stage: job.stage, percent: job.percent, logs: job.logs || [] }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    await env.POSTS.put(`genJob:${id}`, JSON.stringify({ ...job, stage: '실패', percent: 0, error: e.message, failed: true, startedAt: Date.now() }));
    await recordGenFailure(id, job.topic, e.message, env);
    return new Response(JSON.stringify({ status: 'failed', topic: job.topic, error: e.message }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}

async function handleRenderProgress(request, env, ctx) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return new Response(JSON.stringify({ error: 'slug 필요' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

  const jobRaw = await env.POSTS.get(`renderJob:${slug}`);
  if (!jobRaw) {
    // renderJob이 이미 없어졌다는 건 크론이 처리 완료(또는 정리)했다는 뜻 — post.video 유무로 결과 판단.
    // 유튜브 업로드는 ctx.waitUntil로 백그라운드 진행되므로, 여기서도 최신 post의 youtubeUrl/youtubeError를 같이 내려줘야
    // 관리자 화면이 "mp4 완료"에서 멈추지 않고 업로드 결과(링크/실패)까지 이어서 보여줄 수 있음.
    const postRaw = await env.POSTS.get(`post:${slug}`);
    const post = postRaw ? JSON.parse(postRaw) : null;
    // [2026-08-30 19:52] 실패 이유 전달 — post의 videoError, 글이 삭제된 경우(오디오 검증 실패)엔 renderFail 기록에서
    let failReason = post?.videoError || null;
    if (!post?.video && !failReason) {
      const failRaw = await env.POSTS.get(`renderFail:${slug}`);
      if (failRaw) failReason = JSON.parse(failRaw).error;
    }
    return new Response(JSON.stringify({
      status: post?.video ? 'done' : 'failed',
      percent: post?.video ? 100 : 0,
      error: failReason,
      youtubeUrl: post?.youtubeUrl || null,
      youtubeError: post?.youtubeError || null,
      youtubeUploadPercent: post?.youtubeUploadPercent ?? null,
      youtubeUploadSec: post?.youtubeUploadSec ?? null,
      youtubeShortsUrl: post?.youtubeShortsUrl || null,
      youtubeShortsUrls: post?.youtubeShortsUrls || null,
    }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const job = JSON.parse(jobRaw);
  if (!env.RELAY_URL || !env.RELAY_SECRET) {
    return new Response(JSON.stringify({ status: 'processing', stage: '진행 중', percent: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  try {
    const res = await fetch(`${env.RELAY_URL}/render/status?jobId=${encodeURIComponent(job.jobId)}`, {
      headers: { 'x-relay-secret': env.RELAY_SECRET },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) {
      // [2026-08-31] relay가 job을 잃어버림(재시작 등) — 너무 잦은 재제출을 막기 위해 마지막 제출로부터
      // 15초는 지나야 여기서 재제출(빠른 폴링 중 중복 제출 방지, 그보다 짧은 간격은 1분 크론이 처리).
      if (Date.now() - (job.startedAt || 0) > 15000) {
        await resubmitLostRenderJob(job, `renderJob:${slug}`, env);
      }
      return new Response(JSON.stringify({ status: 'processing', stage: '상태 확인 중(재제출 시도)', percent: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (!res.ok) {
      await res.text().catch(() => {});
      return new Response(JSON.stringify({ status: 'processing', stage: '상태 확인 중', percent: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const data = await res.json();
    // 릴레이가 done/failed라고 하면 여기서 바로 post에 반영 — 5분 크론까지 기다리게 하지 않음
    let youtubeUrl = null;
    let youtubeError = null;
    let youtubeQuotaExceeded = false;
    let youtubeUploadPercent = null;
    let youtubeUploadSec = null;
    let youtubeShortsUrl = null;
    let youtubeShortsUrls = null;
    let youtubeShortsErrors = null;
    let youtubeShortsSkippedReason = null;
    let youtubeQueuePosition = null;
    if (data.status === 'done') {
      await finalizeRenderDone({ ...job, durationSec: data.durationSec }, `renderJob:${slug}`, env, ctx);
      // finalizeRenderDone 안의 유튜브 업로드는 ctx.waitUntil로 백그라운드 진행돼서 이 시점엔 보통 아직 안 끝남 —
      // 그래도 혹시 바로 끝났으면 즉시 링크를 내려주고, 아니면 클라이언트가 계속 폴링하며 기다림.
      const freshPostRaw = await env.POSTS.get(`post:${slug}`);
      const freshPost = freshPostRaw ? JSON.parse(freshPostRaw) : null;
      youtubeUrl = freshPost?.youtubeUrl || null;
      youtubeError = freshPost?.youtubeError || null;
      youtubeQuotaExceeded = !!freshPost?.youtubeQuotaExceeded;
      youtubeUploadPercent = freshPost?.youtubeUploadPercent ?? null;
      youtubeUploadSec = freshPost?.youtubeUploadSec ?? null;
      youtubeShortsUrl = freshPost?.youtubeShortsUrl || null;
      youtubeShortsUrls = freshPost?.youtubeShortsUrls || null;
      youtubeShortsErrors = freshPost?.youtubeShortsErrors || null;
      youtubeShortsSkippedReason = freshPost?.youtubeShortsSkippedReason || null;
      if (youtubeQuotaExceeded || (youtubeShortsErrors || []).some((e) => e && e.includes('할당량'))) {
        youtubeQueuePosition = await getYoutubeQueuePosition(slug, env); // [2026-08-31] 대기열 순번
      }
    } else if (data.status === 'failed') {
      await finalizeRenderFailed(job, `renderJob:${slug}`, data?.error || '알 수 없는 오류', env);
    }
    return new Response(JSON.stringify({ status: data.status, stage: data.stage, percent: data.percent, error: data?.error || null, logs: data?.logs || [], youtubeUrl, youtubeError, youtubeQuotaExceeded, youtubeUploadPercent, youtubeUploadSec, youtubeShortsUrl, youtubeShortsUrls, youtubeShortsErrors, youtubeShortsSkippedReason, youtubeQueuePosition }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ status: 'processing', stage: '상태 확인 중', percent: 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}

async function handleRetryRender(request, env) {
  // [2026-09-02 18:45] 실패한 렌더를 원본 이미지·오디오로 재시도
  const form = await request.formData();
  const slug = (form.get('slug') || '').toString();
  if (!slug) return new Response('slug 필요', { status: 400 });
  const postRaw = await env.POSTS.get(`post:${slug}`);
  if (!postRaw) return new Response(null, { status: 302, headers: { Location: '/admin' } });
  const post = JSON.parse(postRaw);
  if (post.video || !post.images?.length) return new Response(null, { status: 302, headers: { Location: '/admin' } });
  const existingJobRaw = await env.POSTS.get(`renderJob:${slug}`);
  if (existingJobRaw) return new Response(null, { status: 302, headers: { Location: '/admin' } });
  const outputKey = `${slug}.mp4`;
  const shortKeys = [`${slug}-short.mp4`];
  const render = await startRelayRender(post.images, post.audio, post.audioSegments, outputKey, shortKeys, post.captionWeights, post.captionBeats, post.captionFontKey, post.captionColor, env, post.highlightSegRange);
  if (render.ok) {
    post.videoError = null;
    await env.POSTS.put(`post:${slug}`, JSON.stringify(post));
    await env.POSTS.put(`renderJob:${slug}`, JSON.stringify({
      jobId: render.jobId, slug, r2Key: outputKey, shortKeys, startedAt: Date.now(),
    }));
  } else {
    post.videoError = render.error;
    await env.POSTS.put(`post:${slug}`, JSON.stringify(post));
  }
  return new Response(null, { status: 302, headers: { Location: '/admin' } });
}

async function handleCancelGen(request, env) {
  // [2026-09-02 18:45] 생성 중 취소 — 지금까지 쌓인 R2 미디어와 genJob 정리
  const form = await request.formData();
  const id = (form.get('id') || '').toString();
  if (id) {
    const raw = await env.POSTS.get(`genJob:${id}`);
    if (raw) {
      const job = JSON.parse(raw);
      // [2026-09-02 20:45] job.images엔 이미 반영된 첨부 미디어도 있고(images 단계 이후) 아직 안 들어간
      // 경우(start/audio 단계에서 취소)도 있어서, userMediaKeys도 같이 지워야 고아 파일이 안 남음
      const toDelete = [...(job.images || []), ...(job.audioSegmentKeys || []), ...(job.userMediaKeys || [])];
      if (job.audioKey) toDelete.push(job.audioKey);
      if (toDelete.length && env.MEDIA) {
        await Promise.all(toDelete.map((k) => env.MEDIA.delete(k).catch(() => {})));
      }
      await env.POSTS.delete(`genJob:${id}`);
      // renderJob은 일부러 안 지움 — relay에 이미 제출됐다면 끝까지 돌게 두고,
      // finalizeRenderDone의 고아청소 로직이 post 없는 걸 보고 결과물을 알아서 지운다
      if (job.slug) {
        const postRaw = await env.POSTS.get(`post:${job.slug}`);
        if (postRaw) await deletePostCompletely(job.slug, env);
      }
    }
  }
  return new Response(null, { status: 302, headers: { Location: '/admin' } });
}

// [2026-09-02 20:45] 생성 시작 전에 사용자가 직접 첨부한 사진/동영상을 R2에 올려둠 — 실제 생성은 나중에
// genJob이 만들어질 때 이 키 목록(userMediaKeys)을 넘겨받아 장면 맨 앞에 그대로 씀. 사진은 클라이언트에서
// canvas로 리사이즈해서 보내지만(전송 용이), 동영상은 어차피 relay가 최종 렌더링 때 다시 인코딩하므로
// 브라우저 단에서 변환하지 않고 원본 그대로 받음.
const UPLOAD_MEDIA_MAX_FILES = 10; // 전체 장면이 20장이라 AI 생성분도 남겨둬야 함
async function handleUploadMedia(request, env) {
  if (!env.MEDIA) return new Response(JSON.stringify({ ok: false, error: 'MEDIA(R2) 바인딩 없음' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: '요청을 읽을 수 없음' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
  if (!files.length) return new Response(JSON.stringify({ ok: false, error: '파일 없음' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  if (files.length > UPLOAD_MEDIA_MAX_FILES) return new Response(JSON.stringify({ ok: false, error: `한 번에 최대 ${UPLOAD_MEDIA_MAX_FILES}개까지` }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const uploaded = [];
  for (const f of files) {
    const type = f.type || '';
    const isVideo = type.startsWith('video/');
    if (!isVideo && !type.startsWith('image/')) continue; // 사진/동영상 외 파일 타입은 건너뜀
    const buf = await f.arrayBuffer();
    if (!buf || !buf.byteLength) continue;
    const ext = isVideo ? 'mp4' : (type === 'image/png' ? 'png' : 'jpg');
    const key = `upload-${crypto.randomUUID()}.${ext}`;
    await env.MEDIA.put(key, buf, { httpMetadata: { contentType: type || (isVideo ? 'video/mp4' : 'image/jpeg') } });
    uploaded.push({ key, isVideo, name: (f.name || '').slice(0, 60) });
  }
  if (!uploaded.length) return new Response(JSON.stringify({ ok: false, error: '올릴 수 있는 사진/동영상이 없음' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ ok: true, files: uploaded }), { headers: { 'Content-Type': 'application/json' } });
}

// [2026-09-07 00:10] "대본 먼저 만들기" — 이미지/음성/렌더링 없이 글쓰기만 빠르게 해서 사용자가
// 검토/수정할 수 있게 함. 여기서 만든 텍스트를 그대로(또는 고쳐서) /admin/generate에 customScript로
// 넘기면 실제 생성 단계에서 AI 글쓰기를 다시 안 하고 이 내용을 그대로 씀.
async function handleGenerateScript(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: '요청 형식 오류' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
  const topic = (body.topic || '').toString().trim().slice(0, 100);
  const detail = (body.detail || '').toString().trim().slice(0, 2000);
  if (!topic) return new Response(JSON.stringify({ ok: false, error: '주제를 입력해주세요' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  try {
    const newsResults = await searchNaverNews(topic, env);
    const { article, error: articleError } = await generateArticle(topic, newsResults, env, detail);
    if (!article) {
      return new Response(JSON.stringify({ ok: false, error: `글 생성 실패 — ${articleError || '알 수 없는 오류'}` }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const scriptText = formatArticleAsScript(article);
    return new Response(JSON.stringify({ ok: true, scriptText, usedNews: newsResults.length > 0 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }
}

async function handleGenerate(request, env) {
  const form = await request.formData();
  const topic = (form.get('topic') || '').toString().trim().slice(0, 100);
  if (!topic) return new Response('주제를 입력해주세요', { status: 400 });
  const detail = (form.get('detail') || '').toString().trim().slice(0, 2000); // [2026-09-06 00:20] 상세 내용(선택) — 글쓰기/이미지 검색어 정확도용
  // [2026-09-07 00:10] "대본 먼저 만들기"로 미리 검토/수정한 대본이 있으면 그걸 그대로 씀 — 있으면
  // 실제 생성 단계에서 AI 글쓰기(generateArticle)를 다시 하지 않고 이 대본을 파싱해서 바로 사용함.
  const customScript = (form.get('customScript') || '').toString().trim().slice(0, 6000);

  // 같은 주제로 최근에 이미 처리 중이거나 방금 만들어진 게 있으면 중복 생성 막음
  // (진행 상황이 안 보여서 여러 번 누르는 경우가 많았음 — 서버가 대신 걸러줌)
  const DUP_WINDOW_MS = 10 * 60 * 1000;
  const pendingGenJobsRaw = await env.POSTS.list({ prefix: 'genJob:' });
  for (const k of pendingGenJobsRaw.keys) {
    const raw = await env.POSTS.get(k.name);
    if (!raw) continue;
    const job = JSON.parse(raw);
    if (!job.failed && job.topic === topic && Date.now() - (job.startedAt || 0) < DUP_WINDOW_MS) {
      const existingId = k.name.split(':')[1];
      return new Response(null, { status: 302, headers: { Location: '/admin?genId=' + existingId + '&msg=' + encodeURIComponent(`"${topic}"은(는) 이미 처리 중이에요 — 아래에서 진행 상황 확인하세요`) } });
    }
  }
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  for (const slug of idx.slice(0, 5)) { // 최근 몇 개만 확인 — 너무 오래된 글까지 다 볼 필요 없음
    const raw = await env.POSTS.get(`post:${slug}`);
    if (!raw) continue;
    const post = JSON.parse(raw);
    if (post.topic === topic && Date.now() - new Date(post.createdAt).getTime() < DUP_WINDOW_MS) {
      return new Response(null, { status: 302, headers: { Location: '/admin?msg=' + encodeURIComponent(`"${topic}"은(는) 방금 이미 만들어졌어요 — 목록에서 확인하세요`) } });
    }
  }

  // [2026-09-02 20:45] 사용자가 미리 업로드해둔 첨부 미디어 키(JSON 문자열 배열) — 실제로 R2에 있는지
  // head()로 확인해서 유령 키는 걸러냄(업로드 실패했는데 목록에만 남아있던 경우 등 방어)
  let userMediaKeys = [];
  try {
    const raw = (form.get('userMediaKeys') || '').toString();
    const parsed = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      const candidates = parsed.filter((k) => typeof k === 'string' && k.startsWith('upload-')).slice(0, UPLOAD_MEDIA_MAX_FILES);
      const checks = await Promise.all(candidates.map((k) => (env.MEDIA ? env.MEDIA.head(k).then((h) => (h ? k : null)).catch(() => null) : Promise.resolve(null))));
      userMediaKeys = checks.filter(Boolean);
    }
  } catch (e) {
    userMediaKeys = [];
  }

  // ctx.waitUntil()은 응답 보낸 뒤 최대 30초까지만 보장돼서, 전체 생성(몇십 초~1분 이상)엔 부족함 —
  // 여기선 작업 "등록"만 하고, 실제 진행은 관리자 페이지가 /admin/generate-step을 반복 호출하며
  // 한 단계씩(글쓰기/음성/이미지 1장씩/저장/렌더링등록) 진행시킴. 각 단계는 몇 초 안에 끝나서 시간제한에 안 걸림.
  const jobId = crypto.randomUUID();
  await env.POSTS.put(`genJob:${jobId}`, JSON.stringify({ topic, detail, customScript, stage: 'start', percent: 0, startedAt: Date.now(), createdAt: Date.now(), userMediaKeys /* [2026-08-30 19:45] 생성 소요시간 측정용(startedAt은 스텝마다 갱신됨) */ }));

  return new Response(null, { status: 302, headers: { Location: '/admin?genId=' + jobId + '&msg=' + encodeURIComponent(`생성 시작됨: ${topic} (진행률은 아래 목록에서 확인)`) } });
}

// 다른 워커(zerozistocks 등)가 프로그램적으로 영상 생성을 트리거하는 용도 — API 키 인증 필요.
// 동기 응답으로 slug/url을 바로 돌려줌(글+이미지+음성까지는 동기 완료, mp4 렌더링만 백그라운드로 이어짐) —
// 호출한 쪽은 이 url을 그 자리에서 바로 자기 콘텐츠에 링크로 박아 넣으면 됨.
async function handleApiGenerate(request, env) {
  if (!env.VIDEO_API_KEY) return new Response(JSON.stringify({ ok: false, error: 'VIDEO_API_KEY 미설정' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  const key = request.headers.get('x-api-key');
  if (key !== env.VIDEO_API_KEY) return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'invalid json' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const topic = (body.topic || '').toString().trim().slice(0, 100);
  if (!topic) return new Response(JSON.stringify({ ok: false, error: 'topic 필요' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const detail = (body.detail || '').toString().trim().slice(0, 2000); // [2026-09-06 00:20] 상세 내용(선택) — 글쓰기/이미지 검색어 정확도용

  const result = await generateAndSavePost(topic, env, null, detail);
  if (!result.ok) return new Response(JSON.stringify({ ok: false, error: result.reason }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  return new Response(JSON.stringify({
    ok: true,
    slug: result.post.slug,
    title: result.post.title,
    url: `${SITE_ORIGIN}/${result.post.slug}`,
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDelete(request, env) {
  // [2026-09-02 18:45] deletePostCompletely로 교체 — 기존 코드는 KV만 지우고 R2 미디어를 안 지워서 고아 파일이 계속 쌓이던 버그
  const form = await request.formData();
  const slug = (form.get('slug') || '').toString();
  if (slug) await deletePostCompletely(slug, env);
  return new Response(null, { status: 302, headers: { Location: '/admin' } });
}
