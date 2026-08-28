/**
 * life-news - 생활뉴스 주제를 입력하면 글과 "영상"(이미지 슬라이드쇼+음성내레이션)을 함께 생성하는 워커
 * Veo 대신 Workers AI의 이미지생성(FLUX)+음성합성(MeloTTS)만 사용 — 사실상 무료, 폴링 크론 불필요(동기 처리)
 */

const CF_ACCOUNT_ID = '709dcc6af36c8ee7b6d3d99e7a9fe422';
const VEO_MODEL = 'veo-3.1-fast-generate-preview';
const VIDEO_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30분 넘게 안 끝나면 포기
const VIDEO_POLL_CRON = '*/5 * * * *'; // 이 크론이 실행되면 콘텐츠 발행 대신 영상 작업 폴링만 함
const CF_AI_GATEWAY = 'yzusb';
const VEO_BASE_URL = `https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AI_GATEWAY}/google-ai-studio/v1beta`;
const SCENE_COUNT = 10; // 슬라이드쇼에 쓸 장면 이미지 개수 — 유료 플랜 전환(서브요청 10,000개)으로 다시 10장

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
  table{ width:100%; border-collapse:collapse; margin-top:16px; }
  th,td{ text-align:left; padding:10px; border-bottom:1px solid var(--border); font-size:13px; }
  input[type=text]{ padding:9px 12px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--text); font-size:13px; font-family:inherit; }
  button{ background:var(--teal); color:#0B1210; border:none; padding:10px 16px; border-radius:6px; font-weight:700; cursor:pointer; }
  button.danger{ background:#E06C6C; color:#fff; }
  .slideshow{ position:relative; aspect-ratio:16/9; background:#000; border-radius:10px; overflow:hidden; margin:20px 0; }
  .slideshow .slide{ position:absolute; inset:0; width:100%; height:100%; object-fit:cover; opacity:0; transition:opacity 0.8s ease; }
  .slideshow .slide.active{ opacity:1; }
  .slideshow .playbtn{ position:absolute; bottom:14px; right:14px; z-index:5; background:rgba(0,0,0,0.6); color:#fff; border:1px solid rgba(255,255,255,0.4); padding:8px 16px; border-radius:20px; font-size:13px; font-weight:600; cursor:pointer; backdrop-filter:blur(4px); }
  .slideshow .playbtn:hover{ background:rgba(0,0,0,0.8); }
`;

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=Fraunces:opsz,wght@9..144,400;9..144,500&family=Black+Han+Sans&display=swap" rel="stylesheet">`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/') return await renderHomePage(env);
      if (path === '/admin') return await renderAdminPage(env);
      if (path === '/admin/generate' && request.method === 'POST') return await handleGenerate(request, env);
      if (path === '/api/generate' && request.method === 'POST') return await handleApiGenerate(request, env);
      if (path === '/admin/delete' && request.method === 'POST') return await handleDelete(request, env);
      if (path === '/admin/render-progress') return await handleRenderProgress(request, env);
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
          await pollPendingVideoJobs(env);
          await pollPendingRenderJobs(env);
        }
      })()
    );
  },
};

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function makeExcerpt(html, maxLen = 130) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen).trim() + '…' : text;
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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

async function callAiChain(systemPrompt, userPrompt, env) {
  const attemptErrors = [];

  if (env.CEREBRAS_API_KEY) {
    try {
      const res = await fetch(`https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AI_GATEWAY}/cerebras/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CEREBRAS_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-oss-120b',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.7,
          max_tokens: 2000,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        let raw = data?.choices?.[0]?.message?.content;
        if (raw) {
          raw = raw.trim().replace(/^```json\s*|\s*```$/gm, '').trim();
          try {
            return { result: JSON.parse(raw), error: null, modelUsed: 'cerebras:gpt-oss-120b' };
          } catch (e) {
            attemptErrors.push(`[cerebras] JSON 파싱 실패: ${e.message}`);
          }
        } else {
          attemptErrors.push('[cerebras] 응답에 content 없음');
        }
      } else {
        const bodyText = await res.text();
        attemptErrors.push(`[cerebras] HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
      }
    } catch (e) {
      attemptErrors.push(`[cerebras] 네트워크 오류: ${e.message}`);
    }
  } else {
    attemptErrors.push('[cerebras] CEREBRAS_API_KEY 미설정');
  }

  if (env.GROQ_API_KEY) {
    for (const model of ['llama-3.1-8b-instant', 'openai/gpt-oss-120b']) {
      try {
        const res = await fetch(`https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_AI_GATEWAY}/groq/openai/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
            temperature: 0.7,
            max_tokens: 2000,
          }),
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
            attemptErrors.push(`[${model}] 응답에 content 없음`);
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
      const response = await env.AI.run('@cf/zai-org/glm-4.7-flash', {
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        max_tokens: 2000,
      }, { gateway: { id: CF_AI_GATEWAY } });
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

async function generateArticle(topic, newsResults, env) {
  let systemPrompt, userPrompt;
  if (newsResults.length) {
    console.log(`네이버 뉴스 ${newsResults.length}건 참고자료로 사용`);
    const referenceText = newsResults
      .map((n, i) => `[참고자료 ${i + 1}] ${n.title}\n${n.description}`)
      .join('\n\n');
    systemPrompt = '너는 한국어 생활뉴스 블로그 필자다. 아래에 실제 뉴스 검색 결과가 참고자료로 주어진다. 이 참고자료에 있는 사실만을 근거로 글을 쓴다. 참고자료에 없는 구체적 수치·통계·날짜를 지어내지 않는다. 참고자료끼리 내용이 다르면 "~라는 보도가 있다"처럼 출처를 명시하는 톤으로 서술한다. 참고자료 문장을 그대로 베끼지 말고 반드시 자신의 표현으로 다시 쓴다(패러프레이즈). 과장된 표현이나 광고성 문구는 쓰지 않는다. 본문은 반드시 순수 한글로만 작성한다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"title": "제목(한국어)", "intro_html": "<p>도입부 1~2문단</p>", "sections": [{"heading":"소제목","body_html":"<p>본문</p>"}], "outro_html":"<p>마무리 문단</p>"}';
    userPrompt = `주제: ${topic}\n\n${referenceText}`;
  } else {
    console.log('네이버 뉴스검색 결과 없음(또는 키 미설정), 참고자료 없이 작성');
    systemPrompt = '너는 한국어 생활뉴스 블로그 필자다. 주어진 주제에 대해 정직하고 담백한 정보성 글을 쓴다. 실제 사용 경험이나 확인 안 된 통계·수치를 단정적으로 지어내지 않는다. 확실하지 않은 내용은 "일반적으로", "~로 알려져 있다" 같은 표현을 쓴다. 과장된 표현이나 광고성 문구는 쓰지 않는다. 본문은 반드시 순수 한글로만 작성한다. 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"title": "제목(한국어)", "intro_html": "<p>도입부 1~2문단</p>", "sections": [{"heading":"소제목","body_html":"<p>본문</p>"}], "outro_html":"<p>마무리 문단</p>"}';
    userPrompt = `주제: ${topic}`;
  }

  const { result, error, modelUsed } = await callAiChain(systemPrompt, userPrompt, env);
  return { article: result, error, modelUsed };
}

const MIN_USABLE_IMAGE_BYTES = 15 * 1024; // 15KB 미만이면 아이콘/로고/썸네일일 가능성이 높아 "못 쓰는 이미지"로 판단

function isUsableImage(buffer) {
  return !!buffer && buffer.byteLength >= MIN_USABLE_IMAGE_BYTES;
}

async function generateScenePrompts(topic, articleTitle, env) {
  const systemPrompt = `너는 짧은 슬라이드쇼 영상을 위한 아트 디렉터다. 주어진 주제와 글 제목을 참고해서, 정지 이미지로 표현할 장면 ${SCENE_COUNT}개를 구상한다. 각 장면은 서로 다른 각도/구도로 주제를 시각화하며, 실제 인물/유명인/브랜드 로고를 특정해서 묘사하지 않는다. 각 장면마다 두 가지를 만든다: 1) keyword — 실제 스톡사진 사이트(Pexels)에서 진짜로 검색될 만한, 실존하는 사물/장소/상황을 나타내는 짧은 영어 키워드(2~4단어). 너무 추상적이거나 상상 속 장면이 아니라, 사진작가가 실제로 찍었을 법한 평범하고 구체적인 소재로 만든다(예: "laptop office desk", "grocery shopping supermarket", "family dinner table"). 2) prompt — 만약 실사진이 없을 경우에 대비한 AI 이미지 생성용 상세한 장면 묘사(사진처럼 사실적인 스타일, 한국어 또는 영어). 결과는 반드시 아래 JSON 형식으로만 출력한다:\n{"scenes": [{"keyword": "영어 검색어", "prompt": "상세 장면 묘사"}, ...]} (배열 길이는 정확히 ${SCENE_COUNT}개)`;
  const userPrompt = `주제: ${topic}\n글 제목: ${articleTitle}`;
  const { result } = await callAiChain(systemPrompt, userPrompt, env);
  if (Array.isArray(result?.scenes) && result.scenes.length) {
    return result.scenes.slice(0, SCENE_COUNT).map((s) => ({
      keyword: typeof s === 'string' ? topic : (s.keyword || topic),
      prompt: typeof s === 'string' ? s : (s.prompt || `${topic}을(를) 표현하는 사실적인 사진`),
    }));
  }
  return Array.from({ length: SCENE_COUNT }, (_, i) => ({
    keyword: topic,
    prompt: `${topic}을(를) 표현하는 사실적인 사진, 장면 ${i + 1}`,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchPixabayImage(query, env, attempt = 0) {
  if (!env.PIXABAY_API_KEY) return null;
  try {
    const res = await fetch(`https://pixabay.com/api/?key=${env.PIXABAY_API_KEY}&q=${encodeURIComponent(query)}&image_type=photo&orientation=horizontal&per_page=3&safesearch=true`);
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
    const hit = data?.hits?.[0];
    const imageUrl = hit?.largeImageURL || hit?.webformatURL;
    if (!imageUrl) return null;
    const imgRes = await fetch(imageUrl);
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
    console.log(`Pixabay 검색 오류("${query}"): ${e.message}`);
    return null;
  }
}

async function searchPexelsImage(query, env, attempt = 0) {
  if (!env.PEXELS_API_KEY) return null;
  try {
    const res = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`, {
      headers: { Authorization: env.PEXELS_API_KEY },
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
    const photo = data?.photos?.[0];
    const imageUrl = photo?.src?.large || photo?.src?.medium;
    if (!imageUrl) return null;
    const imgRes = await fetch(imageUrl);
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
    console.log(`Pexels 검색 오류("${query}"): ${e.message}`);
    return null;
  }
}

async function getSceneImage(scene, topic, env) {
  // 1순위: Workers AI(FLUX) — 요청 제한(429) 걱정 없이 바로 생성, 초상권/저작권 문제 원천 차단
  let image = await generateSceneImage(scene.prompt, env);
  if (image) {
    console.log(`FLUX 이미지 생성 사용: "${scene.keyword}"`);
    return image;
  }

  // 2순위: FLUX 실패(바인딩 오류 등 드문 경우)했을 때만 Pixabay로 보완
  console.log(`FLUX 생성 실패, Pixabay로 대체 시도: "${scene.keyword}"`);
  image = await searchPixabayImage(scene.keyword, env);
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

  // 3순위: 그래도 안 되면 Pexels까지
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

  console.log(`모든 이미지 소스 실패: "${scene.keyword}"`);
  return null;
}

async function generateSceneImage(prompt, env) {
  if (!env.AI) return null;
  try {
    const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt }, { gateway: { id: CF_AI_GATEWAY } });
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

async function generateNarrationAudio(text, env) {
  if (!env.GOOGLE_TTS_API_KEY) {
    console.log('음성합성 건너뜀: GOOGLE_TTS_API_KEY 미설정');
    return null;
  }
  const trimmed = text.slice(0, 3000); // Google Cloud TTS는 요청당 5000바이트 제한이라 여유있게 자름

  const tryVoice = async (voiceName, useNaturalConfig) => {
    const audioConfig = useNaturalConfig
      ? { audioEncoding: 'MP3' } // Chirp3-HD는 속도/피치 파라미터 자체를 거부함
      : { audioEncoding: 'MP3', speakingRate: 0.9 };
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${env.GOOGLE_TTS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: trimmed },
        voice: { languageCode: 'ko-KR', name: voiceName },
        audioConfig,
      }),
    });
    if (!res.ok) {
      const bodyText = await res.text();
      return { ok: false, error: `HTTP ${res.status} — ${bodyText.slice(0, 300)}` };
    }
    return { ok: true, data: await res.json() };
  };

  try {
    const naturalVoice = KOREAN_TTS_VOICES_NATURAL[Math.floor(Math.random() * KOREAN_TTS_VOICES_NATURAL.length)];
    let voiceName = naturalVoice;
    let attempt = await tryVoice(naturalVoice, true);

    if (!attempt.ok) {
      console.log(`음성합성 실패(목소리: ${naturalVoice}): ${attempt.error} — 폴백 음성으로 재시도`);
      voiceName = KOREAN_TTS_VOICES_FALLBACK[Math.floor(Math.random() * KOREAN_TTS_VOICES_FALLBACK.length)];
      attempt = await tryVoice(voiceName, false);
      if (!attempt.ok) {
        console.log(`음성합성 폴백도 실패(목소리: ${voiceName}): ${attempt.error}`);
        return null;
      }
    }

    const data = attempt.data;
    if (!data?.audioContent) {
      console.log('음성합성 실패: 응답에 audioContent 없음 — raw: ' + JSON.stringify(data).slice(0, 300));
      return null;
    }
    const binary = atob(data.audioContent);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    console.log(`음성합성 성공 (Google Cloud TTS, 목소리: ${voiceName})`);
    return bytes.buffer;
  } catch (e) {
    console.log('음성합성 오류: ' + e.message);
    return null;
  }
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

// Oracle Always Free VM(kiwoomapi 릴레이와 동일 서버)에서 ffmpeg로 직접 렌더링 — 완전 무료,
// 결과 mp4는 릴레이가 R2(usbkr-videos)에 바로 업로드하므로 Worker는 재다운로드할 필요 없음.
async function startRelayRender(rawImageKeys, audioKey, outputKey, weights, captions, env) {
  if (!env.RELAY_URL || !env.RELAY_SECRET) return { ok: false, error: 'RELAY_URL/RELAY_SECRET 환경변수가 설정 안 됨' };
  if (!rawImageKeys.length) return { ok: false, error: '원본 이미지가 없음' };

  const imageUrls = rawImageKeys.map((k) => `${SITE_ORIGIN}/media/${k}`);
  const audioUrl = audioKey ? `${SITE_ORIGIN}/media/${audioKey}` : null;

  try {
    const res = await fetch(`${env.RELAY_URL}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-secret': env.RELAY_SECRET },
      // weights: 이미지별 자막 글자수 비율(노출시간 배분용), captions: 이미지별 실제 자막 텍스트(drawtext로 mp4에 번인)
      body: JSON.stringify({ images: imageUrls, audioUrl, outputKey, weights, captions }),
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

async function pollPendingRenderJobs(env) {
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
      });
    } catch (e) {
      console.log(`[${keyInfo.name}] 릴레이 상태 조회 네트워크 오류: ${e.message}`);
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
      console.log(`[${keyInfo.name}] 릴레이 렌더링 실패 — ${data?.error || '알 수 없는 오류'}`);
      await env.POSTS.delete(keyInfo.name);
      continue;
    }

    // 릴레이가 이미 R2(env.MEDIA와 동일 버킷)에 mp4를 직접 업로드해둔 상태 — 재다운로드/재업로드 불필요
    const postRaw = await env.POSTS.get(`post:${job.slug}`);
    if (postRaw) {
      const post = JSON.parse(postRaw);
      post.video = job.r2Key;

      // mp4가 완성되면 SVG 이미지·mp3는 더 이상 필요 없음(웹 화면도 이제 mp4 하나만 보여줌) — 전부 삭제하고 mp4만 남김
      const toDelete = [...(post.images || []), ...(job.rawImageKeys || [])];
      if (post.audio) toDelete.push(post.audio);
      if (toDelete.length) {
        await Promise.all(toDelete.map((k) => env.MEDIA.delete(k).catch(() => {})));
        console.log(`[${keyInfo.name}] SVG/mp3/원본jpg ${toDelete.length}개 정리 완료 — mp4만 남김`);
      }
      post.images = [];
      post.audio = null;

      await env.POSTS.put(`post:${job.slug}`, JSON.stringify(post));
    }

    await env.POSTS.delete(keyInfo.name);
    console.log(`[${keyInfo.name}] 릴레이 렌더링 완료 및 저장: ${job.r2Key}`);
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

// 문장을 N개 구간으로 나누되, 문장 "개수"가 아니라 "글자수"가 균등해지도록 배분 —
// 이래야 각 이미지에 배정된 자막 분량이 실제 발화 시간과 비례해서, 나레이션 속도와 슬라이드 전환이 맞아떨어짐.
function splitTextIntoNChunks(text, n) {
  const sentences = (text || '').split(/(?<=[.!?。！？])\s+/).filter(Boolean);
  if (n <= 0) return [];
  if (!sentences.length) return Array.from({ length: n }, () => ({ text: '', weight: 1 / n }));

  const totalChars = sentences.reduce((sum, s) => sum + s.length, 0) || 1;
  const target = totalChars / n;
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const sentence of sentences) {
    current.push(sentence);
    currentLen += sentence.length;
    if (currentLen >= target && chunks.length < n - 1) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
  }
  if (current.length) chunks.push(current);
  while (chunks.length < n) chunks.push([]);
  if (chunks.length > n) {
    const overflow = chunks.splice(n - 1).flat();
    chunks.push(overflow);
  }

  // 문장이 끝날 때마다 TTS가 짧게 쉬는 시간(정지)이 있는데, 글자수만 세면 이게 빠져서
  // 문장이 여러 개 들어간 컷일수록 실제보다 더 짧게 잡히는 문제가 있었음.
  // → 문장 하나당 "정지시간에 해당하는 글자수"를 가상으로 더해서 가중치를 보정.
  const PAUSE_EQUIVALENT_CHARS = 6;
  const chunkTexts = chunks.map((sents) => sents.join(' ').trim());
  const rawWeights = chunks.map((sents) => {
    const chars = sents.reduce((sum, s) => sum + s.length, 0);
    const pauseChars = sents.length * PAUSE_EQUIVALENT_CHARS;
    return Math.max(chars + pauseChars, PAUSE_EQUIVALENT_CHARS); // 빈 칸도 최소 노출시간은 보장
  });
  const sumWeights = rawWeights.reduce((a, b) => a + b, 0) || 1;
  return chunkTexts.map((text, i) => ({ text, weight: rawWeights[i] / sumWeights }));
}

function wrapCaptionLines(text, maxCharsPerLine = 20, maxLines = 3) {
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = w;
      if (lines.length >= maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines);
}

// 자막 스타일: mp4(ffmpeg drawtext)와 동일하게 Black Han Sans 굵은 서체 + 진한 배경 박스로 통일.
// 그라데이션 대신 확실한 반투명 박스를 깔아서 어떤 사진 위에서도 대비가 확보되게 함.
function buildCaptionedImageSvg(imageBuffer, caption) {
  const width = 1280;
  const height = 720;
  const dataUri = `data:image/jpeg;base64,${arrayBufferToBase64(imageBuffer)}`;
  const lines = wrapCaptionLines(caption, 20, 3);
  const fontSize = 48;
  const lineHeight = 60;
  const boxPaddingV = 28;
  const textBlockHeight = lines.length * lineHeight;
  const boxHeight = lines.length ? textBlockHeight + boxPaddingV * 2 : 0;
  const boxY = height - boxHeight - 40;
  const firstLineY = boxY + boxPaddingV + fontSize * 0.78;
  const tspans = lines
    .map((line, i) => `<tspan x="${width / 2}" y="${firstLineY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');
  const captionMarkup = lines.length
    ? `<rect x="24" y="${boxY}" width="${width - 48}" height="${boxHeight}" rx="12" fill="#000000" fill-opacity="0.68"/>
       <text
         font-family="'Black Han Sans','Noto Sans KR','Apple SD Gothic Neo','Malgun Gothic',sans-serif"
         font-size="${fontSize}" font-weight="400" text-anchor="middle"
         letter-spacing="0.3"
         paint-order="stroke fill" stroke="rgba(0,0,0,0.9)" stroke-width="8" stroke-linejoin="round"
         fill="#ffffff"
       >${tspans}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <image href="${dataUri}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>
    ${captionMarkup}
  </svg>`;
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

async function generateAndSavePost(topic, env) {
  if (!env.POSTS) return { ok: false, reason: 'POSTS(KV) 바인딩 없음' };

  // 실제로 운영 중인 사이트(뉴스)가 있는지 최우선으로 검색 — 글 작성 근거이자 이미지 출처로도 재사용
  const newsResults = await searchNaverNews(topic, env);
  const usedNews = newsResults.length > 0;

  const { article, error: articleError, modelUsed } = await generateArticle(topic, newsResults, env);
  if (!article) {
    return { ok: false, reason: `글 생성 실패 — ${articleError || '알 수 없는 오류'}` };
  }
  console.log(`글 생성 성공 (모델: ${modelUsed})`);

  const slug = String(Date.now());

  // 내레이션 텍스트(음성+자막 공용) — 실제 음성으로 변환되는 길이(3000자)로 맞춤
  const narrationText = [stripHtml(article.intro_html), ...(article.sections || []).map((s) => stripHtml(s.body_html)), stripHtml(article.outro_html)].join(' ').slice(0, 3000);

  let audioKey = null;
  if (env.MEDIA) {
    const audioBuffer = await generateNarrationAudio(narrationText, env);
    if (audioBuffer) {
      audioKey = `${slug}-narration.mp3`;
      await env.MEDIA.put(audioKey, audioBuffer, { httpMetadata: { contentType: 'audio/mpeg' } });
      console.log('내레이션 음성 생성 완료');
    } else {
      console.log('내레이션 음성 생성 실패(글 발행은 계속 진행)');
    }
  }

  let images = [];
  let rawImageKeys = [];
  let captionWeights = [];
  let captionTexts = []; // ffmpeg drawtext용 — 줄바꿈까지 미리 적용된 자막 텍스트
  if (env.MEDIA) {
    // 이미지 소스는 저작권이 명확한 것만 사용: Pixabay/Pexels(무료 라이선스) → FLUX(직접 생성) 순서
    const scenes = await generateScenePrompts(topic, article.title, env);
    const rawImages = (await mapWithConcurrency(scenes, 3, (s) => getSceneImage(s, topic, env))).filter(Boolean);
    console.log(`장면 원본 이미지 ${rawImages.length}/${scenes.length}개 확보`);

    // 내레이션 텍스트를 확보된 이미지 개수만큼 나눠서, 각 이미지 파일 안에 자막으로 직접 그려넣음(번인) — 웹 슬라이드쇼용.
    // 글자수 비례로 나눈 chunk의 weight를 그대로 저장해뒀다가, 웹 슬라이드쇼 전환 속도/mp4 렌더링 이미지 노출시간에
    // 동일하게 적용해서 자막 분량과 실제 노출시간이 항상 비례하도록 함(= 나레이션 속도와 자막 싱크).
    const perImageCaptions = splitTextIntoNChunks(narrationText, rawImages.length || 1);
    for (let i = 0; i < rawImages.length; i++) {
      const chunk = perImageCaptions[i] || { text: '', weight: 1 / (rawImages.length || 1) };
      const svg = buildCaptionedImageSvg(rawImages[i], chunk.text);
      const key = `${slug}-scene-${i}.svg`;
      await env.MEDIA.put(key, svg, { httpMetadata: { contentType: 'image/svg+xml' } });
      images.push(key);
      captionWeights.push(chunk.weight);
      // SVG랑 똑같은 줄바꿈 규칙으로 미리 wrap해서 relay에 넘김 — mp4에도 동일한 자막이 그대로 들어가게
      captionTexts.push(wrapCaptionLines(chunk.text, 20, 3).join('\n'));

      // ffmpeg가 안정적으로 읽을 수 있게 자막 없는 순수 JPEG 원본도 별도 저장 (mp4 렌더링 전용, 자막은 relay가 drawtext로 입힘)
      const rawKey = `${slug}-raw-${i}.jpg`;
      await env.MEDIA.put(rawKey, rawImages[i], { httpMetadata: { contentType: 'image/jpeg' } });
      rawImageKeys.push(rawKey);
    }
    console.log(`자막이 삽입된 이미지 ${images.length}개 + ffmpeg용 원본 이미지 ${rawImageKeys.length}개 저장 완료`);
  }

  const post = {
    slug, topic, title: article.title, createdAt: new Date().toISOString(),
    intro: article.intro_html, sections: article.sections || [], outro: article.outro_html,
    images, audio: audioKey, usedNews, captionWeights,
  };
  await env.POSTS.put(`post:${slug}`, JSON.stringify(post));
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  idx.unshift(slug);
  await env.POSTS.put('index', JSON.stringify(idx.slice(0, 500)));

  // 진짜 mp4 영상(유튜브 업로드용) — 우리가 만든 이미지+음성을 Oracle 릴레이(ffmpeg)로 합성. 기다리지 않고 등록만.
  if (env.RELAY_URL && env.RELAY_SECRET && env.MEDIA && rawImageKeys.length) {
    const outputKey = `${slug}.mp4`;
    const render = await startRelayRender(rawImageKeys, audioKey, outputKey, captionWeights, captionTexts, env);
    if (render.ok) {
      await env.POSTS.put(`renderJob:${slug}`, JSON.stringify({
        jobId: render.jobId, slug, r2Key: outputKey, rawImageKeys, startedAt: Date.now(),
      }));
      console.log(`릴레이 렌더링 작업 등록됨: ${slug} (jobId: ${render.jobId})`);
    } else {
      console.log(`릴레이 렌더링 작업 시작 실패(글 발행은 계속 진행): ${render.error}`);
    }
  }

  console.log(`발행 완료: ${slug}`);
  return { ok: true, post };
}

function renderSlideshow(post) {
  if (!post.images?.length) return '';
  const slides = post.images.map((key, i) => `<img class="slide${i === 0 ? ' active' : ''}" src="/media/${key}" alt="장면 ${i + 1}">`).join('');
  const hasAudio = !!post.audio;
  const audioTag = hasAudio ? `<audio id="narration-${post.slug}" src="/media/${post.audio}" preload="auto"></audio>` : '';
  // 자동재생 없음 — 항상 이 버튼을 눌러야 슬라이드쇼(+음성)가 시작됨
  const playBtn = `<button class="playbtn" id="playbtn-${post.slug}">▶ 재생</button>`;
  const weightsJson = JSON.stringify(Array.isArray(post.captionWeights) ? post.captionWeights : []);
  const script = `<script>
    (function(){
      var root = document.getElementById('slideshow-${post.slug}');
      var slides = root.querySelectorAll('.slide');
      var weights = ${weightsJson};
      var current = 0, timerId = null, isPlaying = false;
      var DEFAULT_MS = 6000;
      function show(i){ slides.forEach(function(s,idx){ s.classList.toggle('active', idx===i); }); }
      // 자막 글자수 비율(weights)이 있으면 그 비율대로, 없으면 균등 분배 — 어느 쪽이든 합은 totalMs
      function durationsFor(totalMs){
        if (weights.length === slides.length && slides.length) {
          var sum = weights.reduce(function(a,b){ return a+b; }, 0) || 1;
          return weights.map(function(w){ return Math.max(1500, (w/sum)*totalMs); });
        }
        return slides.length ? Array.from({length:slides.length}, function(){ return totalMs/slides.length; }) : [];
      }
      var currentDurations = durationsFor(DEFAULT_MS * slides.length);
      function scheduleNext(){
        clearTimeout(timerId);
        if (!slides.length || !isPlaying) return;
        var d = currentDurations[current] || DEFAULT_MS;
        timerId = setTimeout(function(){
          current = (current + 1) % slides.length;
          show(current);
          scheduleNext();
        }, d);
      }
      var btn = document.getElementById('playbtn-${post.slug}');
      ${hasAudio ? "var audio = document.getElementById('narration-" + post.slug + "');" : ''}
      function play(){
        isPlaying = true;
        btn.textContent = '⏸ 정지';
        ${hasAudio ? 'audio.play();' : ''}
        scheduleNext();
      }
      function pause(){
        isPlaying = false;
        btn.textContent = '▶ 재생';
        clearTimeout(timerId);
        ${hasAudio ? 'audio.pause();' : ''}
      }
      btn.addEventListener('click', function(){
        if (isPlaying) pause(); else play();
      });
      ${hasAudio ? `
      audio.addEventListener('loadedmetadata', function(){
        // 실제 음성 길이를 알면 그 길이 기준으로 각 이미지 노출시간을 자막 비율대로 재계산 (나레이션과 싱크)
        currentDurations = durationsFor(Math.max(4000 * slides.length, audio.duration * 1000));
      });
      audio.addEventListener('ended', function(){
        currentDurations = durationsFor(DEFAULT_MS * slides.length);
        current = 0; show(0);
        pause();
      });
      ` : ''}
    })();
  </script>`;
  return `<div class="slideshow" id="slideshow-${post.slug}">${slides}${playBtn}</div>${audioTag}${script}`;
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
    const dateStr = new Date(p.createdAt).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
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
  const veoVideoBlock = p.video
    ? `<div style="margin:20px 0;">
        <video controls preload="metadata" style="width:100%;border-radius:10px;background:#000;" src="/media/${p.video}"></video>
        <p class="mono" style="font-size:12px;color:var(--muted);margin-top:8px;">🎬 실제 영상 파일(mp4) — 다운로드해서 유튜브 등에 업로드할 수 있어요. (우클릭 → 다른 이름으로 저장)</p>
      </div>`
    : '';

  const body = `${siteHeader()}
    <div class="wrap post-body">
      <h1>${escapeHtml(p.title)}</h1>
      <div class="meta">${escapeHtml(p.topic)} · ${new Date(p.createdAt).toLocaleDateString('ko-KR')}</div>
      ${veoVideoBlock}
      ${slideshow}
      ${p.intro}
      ${sectionsHtml}
      ${p.outro}
      <div style="display:flex;gap:12px;align-items:flex-start;background:#FFFBEB;border:1.5px solid var(--amber);border-radius:10px;padding:16px 18px;margin:32px 0 0;">
        <span style="font-size:20px;line-height:1;">⚠️</span>
        <p style="margin:0;font-size:14px;line-height:1.6;color:#7C2D12;">이 글과 이미지/음성은 AI가 자동 생성한 참고용 콘텐츠이며, 실제 사실과 다를 수 있습니다.${p.usedNews ? ' 실제 뉴스 검색 결과를 참고해 작성했지만, 원문과 대조 확인을 권장합니다.' : ' 실시간 뉴스 검색 없이 작성된 내용이니 최신성이 중요한 정보는 별도로 확인해주세요.'}</p>
      </div>
    </div>
    <footer><div class="wrap">life.news</div></footer>`;

  return new Response(page(`${p.title} - life.news`, body, { description: makeExcerpt(p.intro, 150) }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function renderAdminPage(env) {
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

  const rows = posts.map((p) => {
    const mediaStatus = `${p.images?.length ? `🖼️ ${p.images.length}장` : '이미지 없음'}${p.audio ? ' · 🔊 음성' : ''}${p.usedNews ? ' · 📰 뉴스참고' : ''}`;
    const isRendering = pendingRenderSlugs.has(p.slug) || pendingVeoSlugs.has(p.slug);
    const videoStatus = p.video
      ? '🎬 mp4 완료'
      : isRendering
        ? `<span class="render-progress" data-slug="${p.slug}">대기 중 · 0%</span>`
        : '—';
    return `<tr>
      <td>${escapeHtml(p.title)}</td>
      <td class="mono">${escapeHtml(p.topic)}</td>
      <td class="mono">${mediaStatus}</td>
      <td class="mono">${videoStatus}</td>
      <td class="mono">${new Date(p.createdAt).toLocaleString('ko-KR')}</td>
      <td><a href="/${p.slug}" target="_blank">보기</a></td>
      <td><form method="POST" action="/admin/delete" style="margin:0;"><input type="hidden" name="slug" value="${p.slug}"><button class="danger" type="submit">삭제</button></form></td>
    </tr>`;
  }).join('');

  const hasPending = posts.some((p) => !p.video && (pendingRenderSlugs.has(p.slug) || pendingVeoSlugs.has(p.slug)));
  const progressScript = hasPending ? `<script>
    (function(){
      function poll(){
        var els = document.querySelectorAll('.render-progress');
        if (!els.length) return;
        var pending = false;
        els.forEach(function(el){
          var slug = el.dataset.slug;
          fetch('/admin/render-progress?slug=' + encodeURIComponent(slug))
            .then(function(r){ return r.json(); })
            .then(function(data){
              if (data.status === 'done' || data.status === 'failed') {
                location.reload();
                return;
              }
              pending = true;
              el.textContent = (data.stage || '진행 중') + ' · ' + (data.percent || 0) + '%';
            })
            .catch(function(){});
        });
      }
      poll();
      setInterval(poll, 3000);
    })();
  </script>` : '';

  const body = `${siteHeader()}<div class="wrap" style="padding:32px 0;">
    <h2>관리자 (총 ${idx.length}건)</h2>
    <p class="mono" style="color:var(--muted);font-size:12px;">생성은 동기 처리라 완료까지 페이지가 대기해요 (보통 몇십 초 내외).</p>
    <form method="POST" action="/admin/generate" style="display:flex;gap:8px;margin:16px 0;">
      <input type="text" name="topic" placeholder="생활뉴스 주제 (예: 여름철 냉방병 예방법)" maxlength="100" style="flex:1;" required>
      <button type="submit">글+슬라이드쇼 생성</button>
    </form>
    <table><thead><tr><th>제목</th><th>주제</th><th>미디어</th><th>mp4</th><th>작성일</th><th></th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="7">글이 없습니다.</td></tr>'}</tbody></table>
  </div>${progressScript}`;

  return new Response(page('관리자 - life.news', body, { noindex: true }), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

async function handleRenderProgress(request, env) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return new Response(JSON.stringify({ error: 'slug 필요' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const jobRaw = await env.POSTS.get(`renderJob:${slug}`);
  if (!jobRaw) {
    // renderJob이 이미 없어졌다는 건 크론이 처리 완료(또는 정리)했다는 뜻 — post.video 유무로 결과 판단
    const postRaw = await env.POSTS.get(`post:${slug}`);
    const post = postRaw ? JSON.parse(postRaw) : null;
    return new Response(JSON.stringify({ status: post?.video ? 'done' : 'failed', percent: post?.video ? 100 : 0 }), { headers: { 'Content-Type': 'application/json' } });
  }
  const job = JSON.parse(jobRaw);
  if (!env.RELAY_URL || !env.RELAY_SECRET) {
    return new Response(JSON.stringify({ status: 'processing', stage: '진행 중', percent: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const res = await fetch(`${env.RELAY_URL}/render/status?jobId=${encodeURIComponent(job.jobId)}`, {
      headers: { 'x-relay-secret': env.RELAY_SECRET },
    });
    if (!res.ok) {
      await res.text().catch(() => {});
      return new Response(JSON.stringify({ status: 'processing', stage: '상태 확인 중', percent: 0 }), { headers: { 'Content-Type': 'application/json' } });
    }
    const data = await res.json();
    return new Response(JSON.stringify({ status: data.status, stage: data.stage, percent: data.percent }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ status: 'processing', stage: '상태 확인 중', percent: 0 }), { headers: { 'Content-Type': 'application/json' } });
  }
}

async function handleGenerate(request, env) {
  const form = await request.formData();
  const topic = (form.get('topic') || '').toString().trim().slice(0, 100);
  if (!topic) return new Response('주제를 입력해주세요', { status: 400 });

  const result = await generateAndSavePost(topic, env);
  const msg = result.ok ? `발행 완료: ${result.post.title}` : `생성 실패 — ${result.reason}`;
  return new Response(null, { status: 302, headers: { Location: '/admin?msg=' + encodeURIComponent(msg) } });
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

  const result = await generateAndSavePost(topic, env);
  if (!result.ok) return new Response(JSON.stringify({ ok: false, error: result.reason }), { status: 500, headers: { 'Content-Type': 'application/json' } });

  return new Response(JSON.stringify({
    ok: true,
    slug: result.post.slug,
    title: result.post.title,
    url: `${SITE_ORIGIN}/${result.post.slug}`,
  }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleDelete(request, env) {
  const form = await request.formData();
  const slug = form.get('slug');
  await env.POSTS.delete(`post:${slug}`);
  const idxRaw = await env.POSTS.get('index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  await env.POSTS.put('index', JSON.stringify(idx.filter((s) => s !== slug)));
  return new Response(null, { status: 302, headers: { Location: '/admin' } });
}
