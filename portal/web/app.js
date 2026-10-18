let articleMarkdown, importInfo, renderMarkdown, plainText, inspectMarkdown, tocHTML;
let createQueue, queueHTML, processQueue, storagePage, uploadR2, formatUploadLimit;
let markdownPromise, adminModulesPromise;
let particleModule, particleInstance, particleIdle, particleTimer, particlePageHidden=false;
const particleFallback=new URL('./assets/shiny-particle-fallback.svg',import.meta.url).href;
const particleCredits=new URL('./particle-licenses/index.html',import.meta.url).pathname;
function stopParticles() {
  if(particleIdle!==undefined)window.cancelIdleCallback?.(particleIdle);
  clearTimeout(particleTimer);particleIdle=undefined;particleTimer=undefined;
  particleInstance?.dispose();particleInstance=null;
}
function scheduleParticles(sequence) {
  const stage=document.querySelector('[data-particle-stage]');
  const mount=async()=>{
    particleIdle=undefined;particleTimer=undefined;
    if(particlePageHidden||sequence!==renderSequence||!stage?.isConnected||location.pathname!=='/')return;
    try{
      particleModule??=import('./particles.js').catch(error=>{particleModule=null;throw error;});
      const module=await particleModule;
      if(particlePageHidden||sequence!==renderSequence||!stage.isConnected||location.pathname!=='/')return;
      particleInstance=module.mountParticles(stage);
    }catch{
      if(stage?.isConnected){stage.dataset.particleState='failed';stage.querySelector('[data-particle-status]').textContent='静态品牌图形';stage.querySelector('[data-particle-controls]').hidden=true;stage.querySelector('[data-particle-start]').hidden=true;}
    }
  };
  if('requestIdleCallback' in window)particleIdle=requestIdleCallback(mount,{timeout:1200});
  else particleTimer=setTimeout(mount,120);
}
window.addEventListener('pagehide',()=>{particlePageHidden=true;});
window.addEventListener('pageshow',()=>{
  particlePageHidden=false;
  if(!particleInstance&&location.pathname==='/'&&document.querySelector('[data-particle-stage]'))scheduleParticles(renderSequence);
});
function loadMarkdown() {
  if(!markdownPromise)markdownPromise=import('./markdown.js').then(module=>{
    ({articleMarkdown,importInfo,renderMarkdown,plainText,inspectMarkdown,tocHTML}=module);
  }).catch(error=>{markdownPromise=null;throw error;});
  return markdownPromise;
}
function loadAdminModules() {
  if(!adminModulesPromise)adminModulesPromise=Promise.all([loadMarkdown(),import('./upload-queue.js'),import('./storage.js')]).then(([,queue,storage])=>{
    ({createQueue,queueHTML,processQueue}=queue);
    ({storagePage,uploadR2,formatUploadLimit}=storage);
    storageSettings??=structuredClone(storage.defaultStorage);
  }).catch(error=>{adminModulesPromise=null;throw error;});
  return adminModulesPromise;
}
const $ = (selector, root = document) => root.querySelector(selector);
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (s) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
const iconPaths = {
  arrow:'M4 12h16m-6-6 6 6-6 6', external:'M14 4h6v6M20 4 10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  book:'M4 4h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v15h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4V4Zm8 1v15',
  code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18', spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z',
  switch:'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4', image:'M4 4h16v16H4V4Zm0 12 5-5 5 5 3-3 3 3M15 8h.01',
  chat:'M20 15a3 3 0 0 1-3 3H9l-5 3V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v9ZM8 8h8M8 12h5',
  download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', search:'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l5 5',
  copy:'M8 8h12v13H8V8ZM4 16V3h12', menu:'M4 6h16M4 12h16M4 18h16', moon:'M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z',
  sun:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  bell:'M6 9a6 6 0 0 1 12 0v7l2 2H4l2-2V9Zm4 12h4', check:'m5 12 4 4L19 6', info:'M12 16v-4m0-4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  lifebuoy:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-5 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM6 6l3 3m6 6 3 3M6 18l3-3m6-6 3-3',
  file:'M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6', settings:'M4 7h16M4 17h16M8 4v6m8 4v6', plus:'M12 4v16M4 12h16', upload:'M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5', clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2', back:'m10 6-6 6 6 6m-6-6h16'
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name] || iconPaths.file}"/></svg>`;
const brand = () => '<a class="brand" href="/" data-route aria-label="Shiny API 首页"><img src="/assets/mark.svg" alt="" width="34" height="34"><span>Shiny<small>API</small></span></a>';
const publicLink = (url) => /^https:\/\//i.test(url);
const safeUrl = (url) => typeof url === 'string' && (/^https:\/\//i.test(url) || /^\/(?!\/)/.test(url)) ? url : '#';
const attrs = (url) => publicLink(url) ? 'target="_blank" rel="noopener noreferrer"' : 'data-route';
const link = (label, url, cls = 'text-link', symbol = 'arrow') => `<a class="${cls}" href="${escape(safeUrl(url))}" ${attrs(url)}>${escape(label)}${symbol ? icon(symbol, 15) : ''}</a>`;
const tag = (text, neutral = false) => `<span class="tag${neutral ? ' tag-neutral' : ''}">${escape(text)}</span>`;
const meta = (article) => `<span>${escape(article.category)}</span><span>·</span><span>${article.minutes} 分钟阅读</span><span>·</span><span>${escape(article.updated)}</span>`;
const clone = (data) => structuredClone(data);
const STORAGE = 'shiny-portal-theme';
let serverRevision = 0, serverHistory = [], adminState = 'idle', adminError = '', accessToken = '', tokenExpires = 0, authPromise = null;
let saving=false, editorUnsaved=false, pendingImports=[], editorReturnURL='', deleteArticleSlug=null;
const draftImages=new Map(), searchCache=new Map();
function articleSearchText(a){const raw=articleMarkdown(a),old=searchCache.get(a.slug);if(old?.raw===raw)return old.text;const text=plainText(raw);searchCache.set(a.slug,{raw,text});return text;}
const articleCategories=['快速开始','客户端配置','API 接入','图像创作','计费与限制','常见问题'];
let editingResource=null, storageSettings=null, storageUnsaved=false, uploading=false, uploadController=null, uploadQueue=[], completedBatch=null, resourceUnsaved=false, recoverableFiles=[], resumableUploads=[];
let original, published, draft, editingSlug = null, articleCategory = '全部教程', docSearch = '', resourceCategory = '全部资源', resourcePlatform = '全部系统', resourceSearch = '', snippet = 'responses', uploadFile = null, toastTimer;

async function refreshIdentity() {
  if (authPromise) return authPromise;
  authPromise = (async () => {
    const refresh = async () => {
      let response;
      for (let attempt = 0; attempt < 3; attempt++) {
        response = await fetch('/api/user/auth/refresh', {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'}});
        if (response.status !== 409) break;
        await new Promise(resolve => setTimeout(resolve, [100,300,600][attempt]));
      }
      const body = await response.json();
      if (!response.ok || !body.success || !body.data?.access_token) throw new Error('请先登录 Shiny 管理员账号，再返回此页');
      accessToken=body.data.access_token;tokenExpires=body.data.access_expires_at;
    };
    if (navigator.locks) await navigator.locks.request('new-api:auth-refresh',refresh); else await refresh();
  })().finally(()=>{authPromise=null;});
  return authPromise;
}
async function api(path, options={}, retry=true) {
  if (!accessToken || tokenExpires < Date.now()/1000+30) await refreshIdentity();
  const headers={'Authorization':'Bearer '+accessToken,'X-Portal-Request':'1','X-Portal-Editor':'markdown-v2',...options.headers};
  const response=await fetch('/portal-api/admin/'+path,{...options,headers,credentials:'same-origin',cache:'no-store'});
  if(response.status===401&&retry){accessToken='';await refreshIdentity();return api(path,options,false);}
  let body;
  try{body=await response.json();}catch{throw new Error('内容服务响应异常，请稍后重试');}
  if(!response.ok||!body.success){if(response.status===401||response.status===403){adminState='denied';adminError=body.message;render();}const error=new Error(body.message||'操作失败');error.status=response.status;throw error;}
  return body;
}
async function loadAdmin() {
  if(adminState==='loading')return;
  editingResource=null;uploadFile=null;uploadQueue=[];completedBatch=null;resourceUnsaved=false;editorUnsaved=false;
  adminState='loading';render();
  try{
    await api('session');await loadAdminModules();const result=await api('content');storageSettings=(await api('storage')).data;recoverableFiles=(await api('r2/uploads/completed')).data;resumableUploads=(await api('r2/uploads/pending')).data;storageUnsaved=false;
    draft=result.data.draft;published=result.data.published;serverRevision=result.data.revision;serverHistory=result.data.history;
    adminState='ready';adminError='';
  }catch(error){adminState='denied';adminError=error.message;}
  render();
}
async function saveLocal() {
  if(saving)throw new Error('正在保存，请等待完成');
  saving=true;
  try{const result=await api('content',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:draft,revision:serverRevision})});serverRevision=result.revision;}
  catch(error){throw error;}
  finally{saving=false;}
}
function failure(error){toast(error.message||'操作失败，请稍后重试');}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3000); }
function dirty() { return JSON.stringify(draft) !== JSON.stringify(published); }
function validStored(data) { return data && data.site && Array.isArray(data.navigation) && Array.isArray(data.articles) && Array.isArray(data.resources) && Array.isArray(data.announcements) && Array.isArray(data.models); }

function renderHeader() {
  const path = location.pathname;
  $('#site-header').innerHTML = `<div class="container header-inner">${brand()}<nav class="nav" id="main-nav" aria-label="主导航">${published.navigation.filter(n => n.enabled).map(n => `<a href="${escape(safeUrl(n.url))}" ${attrs(n.url)} ${path === n.url || n.url !== '/' && path.startsWith(n.url) ? 'class="active" aria-current="page"' : ''}>${escape(n.title)}${publicLink(n.url) ? '<span class="sr-only"></span>' : ''}</a>`).join('')}</nav><div class="header-actions"><button class="icon-button search-trigger" data-action="search" aria-label="搜索教程与资源">${icon('search',16)}<span>搜索教程与资源</span><kbd>Ctrl K</kbd></button><button class="icon-button" data-action="theme" aria-label="切换${document.body.classList.contains('dark')?'浅':'深'}色模式">${icon(document.body.classList.contains('dark')?'sun':'moon',16)}</button>${link('登录','https://shinyapi.com/sign-in','btn btn-sm login-link','')}${link('控制台','https://shinyapi.com/dashboard','btn btn-sm btn-dark','external')}<button class="icon-button menu-button" data-action="menu" aria-label="打开菜单" aria-expanded="false" aria-controls="main-nav">${icon('menu',17)}</button></div></div>`;
  $('#site-footer').innerHTML = `<div class="container"><div class="footer-top"><div>${brand()}<p>一个 Key，连接你的 AI 工作流。</p></div><nav class="footer-links" aria-label="页脚导航">${link('教程文档','/docs/','','')}${link('资源下载','/downloads/','','')}${link('使用帮助','/docs/troubleshooting','','')}${link('内容管理','/site-admin/','','')}</nav></div><div class="footer-bottom"><span>© 2026 Shiny API. All rights reserved.</span><span>${link('用户协议','https://shinyapi.com/user-agreement','','')} · ${link('隐私政策','https://shinyapi.com/privacy-policy','','')} · ${link('开源与致谢',particleCredits,'','')}</span></div></div>`;
}

function requestSample(mode) {
  return mode === 'chat' ? `curl https://shinyapi.com/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "gpt-6.1-sol",\n    "messages": [{"role":"user","content":"你好"}]\n  }'` : `curl https://shinyapi.com/v1/responses \\\n  -H "Authorization: Bearer YOUR_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "gpt-6.1-sol",\n    "input": "让我们开始吧。",\n    "stream": true\n  }'`;
}
function sampleHTML() {
  const code = requestSample(snippet);
  return `<div class="snippet-tabs" role="tablist" aria-label="接口示例"><button role="tab" aria-selected="${snippet==='responses'}" class="${snippet==='responses'?'active':''}" data-snippet="responses">Responses</button><button role="tab" aria-selected="${snippet==='chat'}" class="${snippet==='chat'?'active':''}" data-snippet="chat">Chat Completions</button><button class="code-copy" data-copy="${escape(code)}" aria-label="复制请求示例">${icon('copy',14)}</button></div><pre class="hero-code"><span class="syntax-green">${escape(code.split('\n')[0])}</span>\n${escape(code.split('\n').slice(1).join('\n'))}</pre>`;
}
function particleHero() {
  const categories=[['featured','精选'],['models','模型'],['geometry','几何'],['cosmos','宇宙'],['playful','趣味'],['store','商店']];
  return `<section class="hero particle-hero"><div class="particle-wordmark" aria-hidden="true">SHINY</div><div class="particle-copy"><div class="eyebrow">为开发者与创作者准备</div><h1>${escape(published.site.headline).split('\n').map((t,i)=>i?`<span>${t}</span>`:t).join('<br>')}</h1><p class="lead">${escape(published.site.intro).replaceAll('\n','<br>')}</p><div class="hero-buttons">${link('开始使用','https://shinyapi.com/sign-up','btn btn-primary')}${link('接入教程','/docs/quickstart','text-link','arrow')}</div><p class="particle-caption">一个接口，连接模型、工具与创作。</p></div>
  <section class="particle-stage" data-particle-stage data-particle-state="static" aria-label="Shiny 交互粒子"><img class="particle-fallback" data-particle-fallback src="${escape(particleFallback)}" alt="" width="600" height="600" fetchpriority="low"><canvas data-particle-canvas aria-hidden="true"></canvas><p class="particle-scene-title" data-particle-title>Shiny</p><p class="particle-status" data-particle-status role="status">静态品牌图形</p><button class="particle-start" data-particle-start type="button" hidden>播放粒子 ${icon('spark',14)}</button><div class="particle-controls" data-particle-controls hidden><div class="particle-groups" role="group" aria-label="粒子造型分类">${categories.map(([id,name])=>`<button type="button" data-particle-group="${id}" aria-pressed="${id==='featured'}">${name}</button>`).join('')}</div><div class="particle-navigation"><button type="button" data-particle-prev aria-label="上一个粒子造型">←</button><label class="visually-hidden" for="particle-scene">选择粒子造型</label><select id="particle-scene" data-particle-select aria-label="选择粒子造型"></select><button type="button" data-particle-next aria-label="下一个粒子造型">→</button></div><div class="particle-playback"><label><input type="checkbox" data-particle-autoplay checked> 自动轮播</label><button type="button" data-particle-pause aria-pressed="false">暂停</button></div></div></section><a class="particle-continue" href="#connect">开始接入 <span aria-hidden="true">↓</span></a></section>`;
}
function home() {
  const notice = published.announcements.find(n => n.pinned) || published.announcements[0];
  return `${particleHero()}
  ${notice?`<div class="notice-rail"><div class="container notice-inner"><span class="notice-label">${icon('bell',15)}最新公告</span>${tag(notice.tag)}<a class="notice-title" href="${escape(safeUrl(notice.href))}" ${attrs(notice.href)}>${escape(notice.title)}</a>${link('全部公告','/announcements/')}</div></div>`:''}
  <section class="particle-connect container" id="connect"><div><div class="kicker">YOUR FIRST REQUEST</div><h2>从这里，开始第一次调用。</h2><p>复制接口地址，选择协议，连接你的工具。</p>${link('查看完整接入教程','/docs/quickstart')}</div><div class="code-demo"><div class="demo-bar"><div class="demo-dots"><i></i><i></i><i></i></div><span class="demo-label">你的第一次 API 调用 ${icon('code',13)}</span></div><div class="demo-inner" id="code-sample">${sampleHTML()}</div><div class="demo-foot"><span>API Base URL</span><strong>${escape(published.site.baseUrl)}</strong><button class="link-button" data-copy="${escape(published.site.baseUrl)}" aria-label="复制接口地址">${icon('copy',13)}</button></div></div></section>
  <section class="section container"><div class="section-heading"><div><div class="kicker">GET STARTED</div><h2>从这里开始，少一点摸索。</h2><p>选好工具，按步骤接入你的工作流。</p></div>${link('全部教程','/docs/')}</div><div class="quick-grid">${[
    ['book','第一次使用','注册、创建令牌，了解模型与分组。','quickstart','01 · 快速开始'],
    ['switch','配置你的客户端','使用 CC Switch 连接常用编程工具。','cc-switch','02 · 工具接入'],
    ['code','直接调用 API','从接口地址与协议选择开始。','api-basics','03 · 开发集成']
  ].map(([i,t,s,slug,step])=>`<a class="quick-item" href="/docs/${slug}" data-route><span class="tile-icon">${icon(i,20)}</span><div><h3>${t}</h3><p>${s}</p><span class="step">${step}</span></div><span class="arrow">${icon('arrow',16)}</span></a>`).join('')}</div></section>
  <div class="container tool-shortcuts" aria-label="按工具开始"><span>选择你的工具</span>${link('CC Switch','/docs/cc-switch','tool-shortcut','switch')}${link('Codex','/docs/cc-switch','tool-shortcut','code')}${link('Cherry Studio','/downloads/?q=Cherry%20Studio','tool-shortcut','download')}${link('API 开发','/docs/api-basics','tool-shortcut','code')}${link('图片调用','/docs/image-guide','tool-shortcut','image')}</div><section class="section section-tint"><div class="container"><div class="section-heading"><div><div class="kicker">MODEL COLLECTION</div><h2>找到适合你的模型。</h2><p>从代码与对话，到图像创作。</p></div>${link('模型与价格','https://shinyapi.com/pricing')}</div><div class="model-grid">${published.models.map(m=>`<a class="model-card" href="https://shinyapi.com/pricing" target="_blank" rel="noopener noreferrer"><div class="model-head"><span class="model-mark ${escape(m.tone)}">${escape(m.mark)}</span><h3>${escape(m.name)}</h3></div><p>${escape(m.subtitle)}</p><div class="tag-row">${m.tags.map(t=>tag(t,true)).join('')}</div></a>`).join('')}</div><p class="model-caption">具体模型、可用分组、权限与价格，以模型与价格页面为准。</p></div></section>
  <section class="section container"><div class="editorial-grid"><div><div class="column-heading"><h2>接入指南</h2>${link('浏览全部','/docs/')}</div>${published.articles.filter(a=>a.featured).slice(0,3).map(a=>`<a class="article-row" href="/docs/${escape(a.slug)}" data-route><span class="tile-icon">${icon(a.icon,17)}</span><div><h3>${escape(a.title)}</h3><p>${escape(a.summary)}</p><div class="item-meta">${meta(a)}</div></div><span class="arrow">${icon('arrow',15)}</span></a>`).join('')}</div><div><div class="column-heading"><h2>常用工具与资源</h2>${link('下载中心','/downloads/')}</div>${published.resources.filter(r=>r.featured).slice(0,3).map(r=>`<div class="download-row"><span class="tile-icon">${icon(r.icon,18)}</span><div><h3>${escape(r.name)}</h3><p>${escape(r.platforms.join(' / '))} · ${escape(r.category)}</p></div>${link('查看','/downloads/?q='+encodeURIComponent(r.name))}</div>`).join('')}</div></div></section>
  <section class="faq-section container"><div class="faq-layout"><div><div class="kicker">HERE TO HELP</div><h2>少一点困惑，<br>多一点专注。</h2><p>接入中遇到问题，先从这些答案开始。</p>${link('查看排错指南','/docs/troubleshooting')}</div><div class="faq-list">${[
    ['API 地址需要添加 /v1 吗？','取决于客户端填写的是接口根地址还是 Base URL。常见 OpenAI 兼容客户端使用 https://shinyapi.com/v1，具体请按对应教程填写，避免重复拼接。'],
    ['在哪里查看模型价格和可用分组？','通过顶部“模型与价格”进入现有模型页面，登录后查看你有权限使用的模型和分组。首页不单独维护价格。'],
    ['遇到 503，是不是我的请求被拒绝了？','不能仅凭状态码判断。账号池不可用、模型过载、审核暂时不可用等都可能返回 503。请保留错误码与 request_id 后查看排错指南。']
  ].map(([q,a])=>`<details><summary>${q}</summary><p>${a}</p></details>`).join('')}</div></div></section>`;
}
function breadcrumb(current, extra = '') { return `<div class="breadcrumb"><a href="/" data-route>首页</a><span>/</span>${extra}${escape(current)}</div>`; }
function articleCard(a, featured = false) {
  return `<a href="/docs/${escape(a.slug)}" data-route class="doc-card${featured?' doc-top-feature':''}"><span class="tile-icon">${icon(a.icon,featured?25:20)}</span><div>${featured?'<div class="kicker">推荐阅读 · QUICK START</div>':''}<h3>${escape(a.title)}</h3><p>${escape(a.summary)}</p><div class="item-meta">${meta(a)}${!featured?icon('arrow',15):''}</div></div>${featured?`<span class="feature-arrow">${icon('arrow',22)}</span>`:''}</a>`;
}
function docResults() {
  const articles=published.articles.filter(a=>(articleCategory==='全部教程'||a.category===articleCategory)&&(`${a.title} ${a.summary} ${a.tags.join(' ')} ${articleSearchText(a)}`).toLowerCase().includes(docSearch.toLowerCase()));
  return articles.length?articles.map((a,i)=>articleCard(a,i===0&&articleCategory==='全部教程'&&!docSearch)).join(''):'<div class="empty-state"><h2>还没有匹配的教程</h2><p>换个关键词，或选择其他分类。</p></div>';
}
function docs() {
  const categories=['全部教程',...new Set(published.articles.map(a=>a.category))];
  return `<div class="container"><div class="page-head">${breadcrumb('教程文档')}<div class="kicker">SHINY GUIDES</div><h1>从接入，到得心应手。</h1><p>找到适合你的工具与教程，把时间留给真正想做的事。</p><div class="search-box">${icon('search',16)}<input id="doc-search" type="search" placeholder="搜索教程、软件或错误码" aria-label="搜索教程" value="${escape(docSearch)}"><kbd>搜索</kbd></div></div><div class="docs-shell doc-landing"><aside class="category-nav" aria-label="教程分类"><span class="nav-caption">按主题浏览</span>${categories.map(c=>`<button class="category-button ${c===articleCategory?'active':''}" aria-pressed="${c===articleCategory}" data-doc-category="${escape(c)}">${escape(c)}<span>${published.articles.filter(a=>c==='全部教程'||a.category===c).length}</span></button>`).join('')}</aside><div class="doc-cards" id="doc-results">${docResults()}</div></div></div>`;
}
function articlePage(slug) {
  const a=published.articles.find(a=>a.slug===slug);if(!a)return notFound();
  const categories=[...new Set(published.articles.map(x=>x.category))];
  const ordered=categories.flatMap(c=>published.articles.filter(x=>x.category===c));
  const menu=categories.map(c=>`<details class="doc-group" ${c===a.category?'open':''}><summary>${escape(c)}</summary>${ordered.filter(x=>x.category===c).map(x=>`<a class="doc-sidebar-link ${x.slug===slug?'active':''}" href="/docs/${escape(x.slug)}" data-route ${x.slug===slug?'aria-current="page"':''}>${escape(x.title)}</a>`).join('')}</details>`).join('');
  let body,toc;
  if(typeof a.body_markdown==='string'){const rendered=renderMarkdown(a.body_markdown,{article:a,articles:published.articles,stripTitle:true});body=rendered.html;toc=tocHTML(rendered.toc);}
  else{body=a.sections.map(s=>`<section id="${escape(s.id)}"><h2>${escape(s.title)}</h2>${s.text?`<p>${escape(s.text).replaceAll('\n','<br>')}</p>`:''}${s.code?`<div class="code-block"><div class="code-block-head"><span>${escape(s.language||'示例')}</span><button data-copy="${escape(s.code)}">复制</button></div><pre>${escape(s.code)}</pre></div>`:''}${s.callout?`<div class="callout">${icon('info',16)}<div>${escape(s.callout)}</div></div>`:''}${s.link?link(s.link.label,s.link.url):''}</section>`).join('');toc=a.sections.map(s=>`<a href="#${escape(s.id)}">${escape(s.title)}</a>`).join('');}
  const index=ordered.findIndex(x=>x.slug===slug),previous=ordered[index-1],next=ordered[index+1];
  const resources=published.resources.filter(r=>r.article===slug);
  return `<div class="container"><div class="page-head">${breadcrumb(a.title,'<a href="/docs/" data-route>教程文档</a><span>/</span>')}</div><div class="reading-layout"><aside class="category-nav document-sidebar" aria-label="文档导航"><span class="nav-caption">教程文档</span>${menu}</aside><article class="article-content"><details class="doc-mobile-nav"><summary>浏览教程目录</summary>${menu}</details><div class="kicker">${escape(a.category)}</div><h1>${escape(a.title)}</h1><p class="article-intro">${escape(a.summary)}</p><div class="article-meta"><span>${icon('clock',13)} ${a.minutes} 分钟阅读</span><span>更新于 ${escape(a.updated)}</span>${a.client_version?`<span>适用版本 ${escape(a.client_version)}</span>`:''}</div><details class="mobile-toc"><summary>本页目录</summary>${toc}</details><div class="markdown-body">${body}</div>${resources.length?`<section class="related-resources"><h2>相关工具与资料</h2>${resources.map(r=>`<div>${link(r.name,'/downloads/?q='+encodeURIComponent(r.name))}<small>${escape(r.version)} · ${escape(r.platforms.join(' / '))}</small></div>`).join('')}</section>`:''}<nav class="doc-pagination" aria-label="前后篇">${previous?link('上一篇：'+previous.title,'/docs/'+previous.slug):'<span></span>'}${next?link('下一篇：'+next.title,'/docs/'+next.slug):link('全部教程','/docs/')}</nav></article><aside class="toc" aria-label="本页目录"><h2>本页目录</h2>${toc}</aside></div></div>`;
}
function resourceResults() {
  const rows=published.resources.filter(r=>(resourceCategory==='全部资源'||r.category===resourceCategory)&&(resourcePlatform==='全部系统'||r.platforms.includes(resourcePlatform)||r.platforms.includes('通用'))&&(`${r.name} ${r.summary}`).toLowerCase().includes(resourceSearch.toLowerCase()));
  return rows.length?rows.map(r=>`<article class="resource-card"><div class="resource-card-top"><span class="tile-icon">${icon(r.icon,22)}</span><div><h2>${escape(r.name)}</h2><p>${escape(r.version)}</p></div>${tag(r.category,true)}</div><p class="resource-summary">${escape(r.summary)}</p><div class="item-meta">${icon('check',12)}${escape(r.source)}</div><div class="resource-facts">${r.file_size?`<span>文件大小 ${formatBytes(r.file_size)}</span>`:''}${r.architecture?`<span>适用架构 ${escape(r.architecture)}</span>`:''}</div>${r.sha256?`<details class="file-checksum"><summary>SHA-256 校验值</summary><code>${escape(r.sha256)}</code></details>`:''}<div class="resource-platforms">${r.platforms.map(p=>tag(p,true)).join('')}</div><div class="resource-card-footer">${link('使用教程','/docs/'+encodeURIComponent(r.article),'text-link','book')}${publicLink(r.url)?link(r.storage==='r2'?'下载文件':'前往发布页',r.url,'btn btn-sm',r.storage==='r2'?'download':'external'):`<a class="btn btn-sm" href="${escape(safeUrl(r.url))}" download>${icon('download',14)}下载文件</a>`}</div></article>`).join(''):'<div class="empty-state"><h2>没有找到对应资源</h2><p>请尝试其他关键词、资源分类或操作系统。</p></div>';
}
function downloads() {
  resourceSearch=new URLSearchParams(location.search).get('q')||resourceSearch;
  return `<div class="container"><div class="page-head">${breadcrumb('资源下载')}<div class="kicker">TOOLS & RESOURCES</div><h1>工具就绪，灵感开工。</h1><p>常用客户端、配置模板与接入资料。每份资源，都有清楚的来源与下一步。</p></div><div class="resource-toolbar"><div class="filter-chips">${['全部资源','客户端工具','配置模板','文档资料'].map(c=>`<button class="chip ${resourceCategory===c?'active':''}" data-resource-category="${c}" aria-pressed="${resourceCategory===c}">${c}</button>`).join('')}</div><label><span class="visually-hidden">操作系统</span><select class="select-field" id="platform-filter" aria-label="选择操作系统">${['全部系统','Windows','macOS','Linux'].map(p=>`<option ${p===resourcePlatform?'selected':''}>${p}</option>`).join('')}</select></label></div><div class="resource-toolbar"><span class="item-meta">下载前，请先查看版本说明与对应教程。</span><div class="search-box resource-search">${icon('search',15)}<input type="search" id="resource-search" aria-label="搜索资源" placeholder="搜索资源名称" value="${escape(resourceSearch)}"></div></div><div class="resource-grid" id="resource-results">${resourceResults()}</div><p class="resource-note">${icon('info',14)} 软件链接指向作者发布页；本站模板使用占位符，不包含真实密钥。本站附件由独立文件库提供。</p></div>`;
}
function announcements() { return `<div class="container"><div class="page-head">${breadcrumb('公告')}<div class="kicker">WHAT’S NEW</div><h1>Shiny 的最新动态。</h1><p>功能更新、使用提示与接入说明，一处了解。</p></div><div class="notice-page-list">${[...published.announcements].sort((a,b)=>Number(b.pinned)-Number(a.pinned)).map(n=>`<article class="notice-page-item"><time datetime="${escape(n.date)}">${escape(n.date)}</time><div>${n.pinned?tag('置顶'):tag(n.tag,true)}<h2>${escape(n.title)}</h2><p>${escape(n.summary)}</p>${link('查看详情',n.href)}</div></article>`).join('')}</div></div>`; }

const adminTabs=[['articles','book','教程文档'],['resources','download','资源管理'],['navigation','menu','顶部导航'],['homepage','settings','首页内容'],['storage','settings','存储设置']];
function admin() {
  const tab = new URLSearchParams(location.search).get('tab') || 'articles';
  return `<div class="container"><div class="page-head">${breadcrumb('内容管理')}<div class="kicker">CONTENT WORKSPACE</div><h1>让更新，成为日常。</h1><p>整理教程、资源和导航，预览确认后再发布到首页。</p><div class="admin-state">${tag('管理员内容工作台')}${dirty()?'<span class="dirty-label">有未发布修改</span>':'<span class="item-meta">当前草稿与发布内容一致</span>'}</div></div><div class="admin-layout"><aside class="admin-nav" aria-label="内容管理导航">${adminTabs.map(([id,i,t])=>`<a class="category-button ${tab===id?'active':''}" href="/site-admin/?tab=${id}" data-route>${icon(i,15)}${t}</a>`).join('')}<div class="admin-note">使用 Shiny 管理员身份。<br>草稿、版本与附件独立保存。<br>发布后，公开页面自动更新。</div></aside><div><div class="admin-heading"><div><h2>${adminTabs.find(t=>t[0]===tab)?.[2]||'教程文档'}</h2><p>${tab==='storage'?'存储设置保存后立即生效。':'草稿不会出现在公开页面中。'}</p></div><div class="admin-actions"><button class="btn btn-sm" data-action="reload-admin">刷新内容</button>${tab==='storage'?'':`<button class="btn btn-sm btn-primary" data-action="publish">${icon('check',13)}发布到网站</button>`}</div></div>${tab==='articles'?adminArticles():tab==='resources'?adminResources():tab==='navigation'?adminNavigation():tab==='storage'?storagePage(storageSettings):adminHome()}${tab==='storage'?'':adminHistory()}<p class="section-footer">${tab==='storage'?'保存存储设置不会修改已有文档、资源或附件。':'内容服务独立于 New API 发布；草稿保存后需点击发布才会公开。'}</p></div></div></div>`;
}
function adminLogin(){return `<div class="container page-head"><div class="empty-state"><h1 style="font-size:26px">站点内容管理</h1><p>${adminState==='loading'?'正在校验登录状态…':escape(adminError||'使用现有 Shiny 超级管理员账号管理内容。')}</p><div class="admin-actions" style="justify-content:center;margin-top:22px"><a class="btn btn-primary" href="/sign-in">前往登录</a><button class="btn" data-action="login-retry">已登录，重新检查</button></div></div></div>`;}
function adminHistory(){return `<details class="admin-editor"><summary>已发布版本 · 可恢复为草稿</summary><div class="nav-history">${serverHistory.map(h=>`<div class="nav-edit-row"><span>版本 #${h.id}<small>${escape(new Date(h.published_at*1000).toLocaleString('zh-CN'))}</small></span><button data-restore="${h.id}">恢复为草稿</button></div>`).join('')}</div></details>`;}
function adminArticles() {
  const a=draft.articles.find(a=>a.slug===editingSlug),categories=[...new Set([...articleCategories,...draft.articles.map(x=>x.category)])];
  return `<div class="import-workspace"><div><h3>导入 Markdown 文档</h3><p>选择一篇或多篇文档，也可以选择整个文件夹。先检查内容，保存为草稿后再发布。</p></div><div class="import-actions"><label class="btn btn-sm">选择多个 .md<input type="file" id="batch-import" multiple accept=".md,.markdown" class="visually-hidden"></label><label class="btn btn-sm">选择文档文件夹<input type="file" id="folder-import" multiple webkitdirectory class="visually-hidden"></label></div><small>每篇最大 1 MB；外部图片不会自动转存。相对文档链接在关联文章导入后自动匹配。</small><div id="batch-preview">${batchPreviewHTML()}</div></div>${pendingRemovalsHTML()}<div class="admin-panel"><table class="admin-table"><thead><tr><th>教程标题</th><th class="category-column">分类</th><th>状态</th><th class="date-column">更新日期</th><th>操作</th></tr></thead><tbody>${draft.articles.map(a=>`<tr><td><span class="row-title">${escape(a.title)}</span><small>/docs/${escape(a.slug)}</small></td><td class="category-column">${escape(a.category)}</td><td>${tag(!published.articles.some(x=>x.slug===a.slug)?'仅草稿':JSON.stringify(a)===JSON.stringify(published.articles.find(x=>x.slug===a.slug))?'已发布':'有未发布修改',true)}</td><td class="date-column item-meta">${escape(a.updated)}</td><td><div class="article-actions"><button class="link-button" data-edit-article="${escape(a.slug)}">编辑</button><button class="link-button link-danger" data-delete-article="${escape(a.slug)}">${published.articles.some(x=>x.slug===a.slug)?'从草稿移除':'删除草稿'}</button></div></td></tr>`).join('')}</tbody></table></div><form class="admin-editor" id="article-form"><div class="admin-heading"><h3>${a?'编辑教程':'新建教程'}</h3><div class="admin-actions"><button type="button" class="link-button" data-action="new-article">新建教程</button><button type="button" class="link-button" data-action="discard-editor">放弃未保存编辑</button></div></div><div class="form-grid"><label class="field"><span>标题</span><input name="title" value="${escape(a?.title||'')}" required maxlength="100" placeholder="例如：CC Switch 配置指南"></label><label class="field"><span>文章路径</span><input name="slug" value="${escape(a?.slug||'')}" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="例如：cc-switch" maxlength="70" ${a?'readonly':''}></label><label class="field"><span>分类</span><input name="category" list="article-categories" value="${escape(a?.category||'快速开始')}" required maxlength="40"><datalist id="article-categories">${categories.map(c=>`<option value="${escape(c)}">`).join('')}</datalist></label><label class="field"><span>适用客户端版本（可选）</span><input name="client_version" value="${escape(a?.client_version||'')}" maxlength="80" placeholder="例如：CC Switch 3.x"></label><label class="field field-wide"><span>简介</span><input name="summary" value="${escape(a?.summary||'')}" required maxlength="180" placeholder="一句话说明教程的用途"></label><label class="field"><span>标签（逗号分隔）</span><input name="tags" value="${escape((a?.tags||[]).join('，'))}" maxlength="500" placeholder="Codex，Windows，接入"></label><label class="field"><span>首页推荐</span><select name="featured"><option value="false">不推荐</option><option value="true" ${a?.featured?'selected':''}>显示在首页精选</option></select></label><label class="field field-wide"><span>正文 · Markdown</span><textarea name="markdown" required spellcheck="false" placeholder="## 开始之前&#10;&#10;写下操作步骤…">${escape(a?articleMarkdown(a):'')}</textarea><small>支持表格、列表、图片、链接及多个代码块。Markdown 原文完整保存，可重新导出。</small></label><div class="editor-tools field-wide"><label class="btn btn-sm">导入当前正文<input type="file" id="markdown-import" accept=".md,.markdown" class="visually-hidden"></label><label class="btn btn-sm">上传并插入图片<input type="file" id="article-image" multiple accept=".png,.jpg,.jpeg,.webp" class="visually-hidden"></label><button type="button" class="btn btn-sm" data-action="export-markdown">导出 Markdown</button></div><label class="field"><span>导入文件路径（用于匹配文档链接）</span><input name="source_path" value="${escape(a?.source_path||'')}" maxlength="512" placeholder="例如：客户端配置/Codex.md"></label><label class="field"><span>来源地址（可选，仅管理时显示）</span><input name="source_url" type="url" value="${escape(a?.source_url||'')}" maxlength="2048" placeholder="https://…"></label></div><div id="import-checks" class="import-checks"></div><div class="form-footer"><p id="editor-status">${editorUnsaved?'有未保存编辑':'先预览并核对链接，再保存草稿。'}</p><div class="admin-actions"><button type="button" class="btn btn-sm" data-action="preview-article">预览正文</button><button class="btn btn-sm btn-primary" type="submit">保存草稿</button></div></div><div id="article-preview"></div></form>`;
}
function pendingRemovalsHTML(){
  const removed=published.articles.filter(a=>!draft.articles.some(x=>x.slug===a.slug));
  if(!removed.length)return '';
  return `<section class="pending-removals"><h3>待下线教程</h3><p>以下教程已从草稿移除，线上仍可访问；点击「发布到网站」后才会下线。</p>${removed.map(a=>`<div><span>${escape(a.title)}</span><button type="button" class="link-button" data-undo-delete-article="${escape(a.slug)}">恢复到草稿</button></div>`).join('')}</section>`;
}
function batchPreviewHTML(){
  if(!pendingImports.length)return '';
  return `<div class="batch-scroll"><table class="admin-table import-table"><thead><tr><th>文件 / 标题</th><th>文章路径</th><th>分类</th><th>检查</th></tr></thead><tbody>${pendingImports.map((a,i)=>`<tr><td><small>${escape(a.source_path)}</small><input aria-label="导入标题 ${i+1}" data-import-field="title" data-index="${i}" value="${escape(a.title)}" maxlength="100"></td><td><input aria-label="导入路径 ${i+1}" data-import-field="slug" data-index="${i}" value="${escape(a.slug)}" maxlength="70"></td><td><input aria-label="导入分类 ${i+1}" data-import-field="category" data-index="${i}" value="${escape(a.category)}" maxlength="40"></td><td><button type="button" class="link-button" data-preview-import="${i}">预览</button><button type="button" class="link-button" data-remove-import="${i}">移除</button></td></tr>`).join('')}</tbody></table></div><p class="item-meta">共 ${pendingImports.length} 篇。路径重复会拒绝保存，不会自动覆盖现有文章。README 和导出总目录已跳过。</p><button type="button" class="btn btn-sm btn-primary" data-action="save-imports">全部保存为草稿</button><div id="batch-article-preview" class="article-content"></div>`;
}
function articleFromForm(form){
  const f=new FormData(form),slug=String(f.get('slug')).trim(),existing=draft.articles.find(a=>a.slug===slug),body=String(f.get('markdown'));
  return {...existing,slug,title:String(f.get('title')).trim(),summary:String(f.get('summary')).trim(),category:String(f.get('category')).trim(),tags:String(f.get('tags')||'').split(/[,，]/).map(t=>t.trim()).filter(Boolean).slice(0,12),minutes:Math.max(1,Math.min(240,Math.ceil(plainText(body).length/600))),updated:new Date().toLocaleDateString('sv-SE'),featured:f.get('featured')==='true',icon:existing?.icon||'book',body_markdown:body,format_version:2,source_path:String(f.get('source_path')||'').trim(),source_url:String(f.get('source_url')||'').trim(),client_version:String(f.get('client_version')||'').trim()};
}
function formatBytes(value){return value>=1024**3?(value/1024**3).toFixed(2)+' GB':value>=1024*1024?(value/1024/1024).toFixed(1)+' MB':Math.ceil(value/1024)+' KB';}
function editorChanged(){if(!editorUnsaved)editorReturnURL=location.href;editorUnsaved=true;if($('#editor-status'))$('#editor-status').textContent='有未保存编辑，请保存草稿后再发布';}
function showChecks(issues,target=$('#import-checks')){if(target)target.innerHTML=issues.length?`<div class="import-warning"><strong>发布前检查</strong><ul>${issues.map(i=>`<li>${escape(i)}</li>`).join('')}</ul></div>`:'<p class="item-meta">未发现未匹配的文档链接或本地图片引用；请继续核对正文中的接口、价格和说明。</p>';}
async function previewImages(root){
  for(const image of root.querySelectorAll('img')){
    const src=image.getAttribute('src');if(!/^\/portal-api\/files\/[a-f0-9]{32}$/.test(src))continue;
    try{if(!draftImages.has(src)){if(!accessToken||tokenExpires<Date.now()/1000+30)await refreshIdentity();const res=await fetch(src.replace('/files/','/admin/files/'),{headers:{Authorization:'Bearer '+accessToken},cache:'no-store'});if(!res.ok)continue;draftImages.set(src,URL.createObjectURL(await res.blob()));}image.src=draftImages.get(src);}catch{}
  }
}
async function previewArticle(){
  const article=articleFromForm($('#article-form'));const issues=inspectMarkdown(article.body_markdown,article,draft.articles);showChecks(issues);
  const target=$('#article-preview');target.innerHTML=`<div class="admin-inline-preview article-content"><h2>${escape(article.title||'未命名教程')}</h2><div class="markdown-body">${renderMarkdown(article.body_markdown,{article,articles:draft.articles,stripTitle:true}).html}</div></div>`;await previewImages(target);
}
async function stageImports(files){
  const eligible=[...files].filter(f=>/\.(md|markdown)$/i.test(f.name)&&!/^README\.md$/i.test(f.name)&&!/^00-/.test(f.name));
  if(!eligible.length){toast('请选择 Markdown 正文文件');return;}
  if(eligible.length>100||eligible.some(f=>f.size>1024*1024)){toast('每批最多 100 篇，每篇不超过 1 MB');return;}
  pendingImports=[];
  for(const file of eligible){const raw=await file.text(),info=importInfo(raw,file.webkitRelativePath||file.name),folder=(file.webkitRelativePath||'').split('/').at(-2)?.replace(/^\d+-/,'');
    if(/^\d+$/.test(info.slug))info.slug='guide-'+crypto.randomUUID().slice(0,8);
    pendingImports.push({...info,body_markdown:raw.replace(/^\uFEFF/,''),category:info.category||folder||'客户端配置'});
  }
  $('#batch-preview').innerHTML=batchPreviewHTML();toast('已读取到导入预览，尚未保存或发布');
}
function adminResources() {
  return `${resumableUploadsHTML()}${recoverableFilesHTML()}<div class="admin-panel"><table class="admin-table"><thead><tr><th>资源名称</th><th>来源</th><th class="category-column">分类</th><th>操作</th></tr></thead><tbody>${draft.resources.map(r=>`<tr><td class="row-title">${escape(r.name)}<small>${escape(r.version)}</small></td><td>${publicLink(r.url)?'外部链接':'本站资料'}<small>${escape(r.source)}</small></td><td class="category-column">${escape(r.category)}</td><td><button class="link-button" data-edit-resource="${escape(r.id)}">编辑</button> · <button class="link-button" data-remove-resource="${escape(r.id)}">移除</button></td></tr>`).join('')}</tbody></table></div><form class="admin-editor" id="resource-form"><h3>添加或编辑资源</h3><div class="form-grid"><label class="field"><span>资源名称</span><input name="name" required maxlength="100" placeholder="例如：Shiny 快速接入指南"></label><label class="field"><span>版本</span><input name="version" required maxlength="50" placeholder="例如：v1.0"></label><label class="field"><span>分类</span><select name="category"><option>文档资料</option><option>配置模板</option><option>客户端工具</option></select></label><label class="field"><span>适用系统（逗号分隔）</span><input name="platforms" value="通用" required placeholder="Windows，macOS，Linux"></label><label class="field"><span>关联教程</span><select name="article">${draft.articles.map(a=>`<option value="${escape(a.slug)}">${escape(a.title)}</option>`).join('')}</select></label><label class="field"><span>适用架构（可选）</span><input name="architecture" maxlength="80" placeholder="x64 / ARM64"></label><label class="field"><span>资源链接（HTTPS，可选）</span><input name="url" type="text" placeholder="https://…"></label><label class="field field-wide"><span>简介</span><input name="summary" required maxlength="180" placeholder="这份资源能够帮助用户做什么？"></label><label class="field field-wide"><span>附件上传位置</span><select name="uploadTarget" id="upload-target"><option value="local">本站服务器 · 最大 20 MB</option><option value="r2" ${storageSettings.enabled?'selected':'disabled'}>R2 公开文件 · 最大 ${formatUploadLimit(storageSettings.maxFileMB)}${storageSettings.enabled?'':'（请先配置存储设置）'}</option></select><small id="upload-target-note">${storageSettings.enabled?'公开桶上传完成即可通过地址下载；保存与发布控制本站列表展示。':'本地附件随关联资源发布后才可公开下载。'}</small></label><label class="upload-zone field-wide">${icon('upload',25)}<strong>选择一个或多个附件</strong><span id="upload-type-hint">${storageSettings.enabled?'R2 支持安装包与公开资料，最大 '+formatUploadLimit(storageSettings.maxFileMB)+'；大文件支持暂停和续传':'PDF / DOCX / Markdown / JSON / ZIP / PNG / JPG / WebP，最大 20 MB'}</span><span class="upload-button">选择附件</span><input type="file" id="resource-upload" class="visually-hidden" aria-label="选择附件" multiple accept="${storageSettings.enabled?storageSettings.extensions.join(','):'.pdf,.docx,.md,.json,.zip,.png,.jpg,.jpeg,.webp'}"><span id="upload-summary">选择附件后，点击保存资源草稿开始上传。</span><progress class="upload-progress" id="upload-progress" max="100" value="0" hidden></progress></label></div><div id="upload-queue">${queueHTML(uploadQueue,uploading)}</div><div id="upload-batch-actions"></div><div class="form-footer"><p>文件按所选位置保存；网页更新不会迁移或覆盖已有文件。</p><div class="admin-actions"><button type="button" class="btn btn-sm" data-action="pause-upload" hidden>暂停上传</button><button type="button" class="btn btn-sm upload-cancel" data-action="cancel-upload" hidden>取消并清理</button><button type="button" class="btn btn-sm" data-action="discard-resource">放弃资源编辑</button><button class="btn btn-sm" type="submit">保存资源草稿</button></div></div></form>`;
}
function recoverableFilesHTML(){
  if(!recoverableFiles.length)return '';
  return `<section class="recoverable-files"><h3>已上传但尚未保存到资源库</h3><p>这些文件已在 R2 中，无需重新上传。恢复到队列后填写资源名称、版本和关联教程，再保存草稿。</p>${recoverableFiles.map(file=>`<div><span><strong>${escape(file.name)}</strong><small>${formatBytes(file.size)}</small></span><button type="button" class="btn btn-sm" data-recover-upload="${escape(file.id)}">恢复到上传队列</button></div>`).join('')}<button type="button" class="text-link" data-action="recover-all-uploads">恢复全部（最多 20 个）</button></section>`;
}
function resumableUploadsHTML(){
  if(!resumableUploads.length)return '<div id="resumable-uploads"></div>';
  return `<section id="resumable-uploads" class="recoverable-files resumable-files"><h3>未完成的大文件上传</h3><p>重新选择原文件后可从已上传分片继续；浏览器不会保存本地文件。超过 7 天的任务可能已由 R2 清理。</p>${resumableUploads.map(job=>`<div><span><strong>${escape(job.name)}</strong><small>${formatBytes(job.size)} · ${job.state==='expired'?'已过期，请取消后重新上传':'已保留分片进度'}</small></span><div class="resume-actions"><label class="btn btn-sm">选择原文件继续<input type="file" class="visually-hidden" data-resume-file="${escape(job.id)}" aria-label="继续上传 ${escape(job.name)}"></label><button type="button" class="link-button link-danger" data-cancel-session="${escape(job.id)}">取消并清理</button></div></div>`).join('')}</section>`;
}
async function refreshResumableUploads(){
  try{resumableUploads=(await api('r2/uploads/pending')).data;}catch{}
}
async function cancelUploadSession(id){
  await api('r2/uploads/'+id+'/abort',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  resumableUploads=resumableUploads.filter(job=>job.id!==id);
}
function selectResumableFile(job,file){
  if(uploading||editingResource){toast('请先完成当前上传或放弃现有资源编辑');return;}
  if(uploadQueue.length&&$('#upload-target').value!=='r2'){toast('请先保存或放弃本地附件队列，再恢复 R2 上传');return;}
  if(file.name!==job.name||file.size!==job.size||(job.lastModified&&file.lastModified!==job.lastModified)){toast('请选择原来的文件，名称、大小或修改时间不一致');return;}
  if(uploadQueue.some(item=>item.sessionId===job.id)){toast('这次上传已在队列中');return;}
  if(uploadQueue.length>=20){toast('上传队列已满，请先处理当前文件');return;}
  let stored=null;try{stored=JSON.parse(sessionStorage.getItem('shiny:upload-form:'+job.id)||'null');}catch{}
  if(stored?.editingResource&&uploadQueue.length){toast('替换现有资源需要单独续传，请先保存或放弃当前队列');return;}
  const item=createQueue([file])[0];Object.assign(item,{sessionId:job.id,sessionMode:'multipart',status:'paused',progress:0});uploadQueue.push(item);
  uploadFile=uploadQueue[0].file;completedBatch=null;resourceUnsaved=true;$('#upload-target').value='r2';
  try{if(stored){if(['通用','Windows','macOS','Linux'].includes(stored.platform))item.platform=stored.platform;if(typeof stored.architecture==='string')item.architecture=stored.architecture;if(!$('#resource-form').elements.name.value){for(const [key,value] of Object.entries(stored.form||stored)){const field=$('#resource-form').elements[key];if(field&&typeof value==='string')field.value=value;}if(stored.editingResource){if(draft.resources.some(resource=>resource.id===stored.editingResource))editingResource=stored.editingResource;else toast('原资源已移除，本次将保存为新资源');}}}}catch{}
  $('#upload-queue').innerHTML=queueHTML(uploadQueue);$('#upload-summary').textContent='已选择原文件，填写资源信息后点击保存资源草稿继续上传';
  $('#resource-form').scrollIntoView({block:'start',behavior:'smooth'});toast('已恢复上传任务，续传前会校验已上传分片');
}
function rememberUploadForm(item,formData){
  if(!item.sessionId)return;
  try{sessionStorage.setItem('shiny:upload-form:'+item.sessionId,JSON.stringify({form:Object.fromEntries(['name','version','category','summary','platforms','article','architecture'].map(key=>[key,String(formData.get(key)||'')])),platform:item.platform,architecture:item.architecture,editingResource}));}catch{}
}
async function saveResourceChanges(changes){
  if(saving)throw new Error('正在保存，请稍候');saving=true;
  try{
    const result=await api('resources/batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes})});
    draft=result.data.draft;published=result.data.published;serverRevision=result.data.revision;serverHistory=result.data.history;
    const savedUrls=new Set(draft.resources.map(r=>r.url));recoverableFiles=recoverableFiles.filter(file=>!savedUrls.has(file.url));
  }finally{saving=false;}
}
function recoverUploadedFiles(files){
  if(uploading||editingResource){toast('请先完成上传或放弃现有资源编辑，再恢复文件');return;}
  const candidates=files.filter(file=>!uploadQueue.some(item=>item.result?.id===file.id)).slice(0,20-uploadQueue.length);
  for(const file of candidates){const item=createQueue([{name:file.name,size:file.size}])[0];Object.assign(item,{id:'r2-'+file.id,status:'complete',progress:100,result:file});uploadQueue.push(item);}
  if(!candidates.length){toast('文件已在队列中或队列已满');return;}
  uploadFile=uploadQueue[0]?.file||null;completedBatch=null;resourceUnsaved=true;
  $('#upload-queue').innerHTML=queueHTML(uploadQueue);$('#upload-summary').textContent='已恢复 '+candidates.length+' 个文件，不会重新上传';$('#resource-form').scrollIntoView({block:'start',behavior:'smooth'});toast('已恢复上传结果，填写资源信息后保存即可');
}
async function persistUploadBatch(f,partial=false){
  const form=$('#resource-form');if(!form.reportValidity())return;
  if(!uploadQueue.length)throw new Error('请先选择文件');
  if(editingResource&&uploadQueue.length!==1)throw new Error('替换现有资源时仅支持一个文件，请先处理当前队列');
  if(!partial){
    uploading=true;uploadController=new AbortController();const cancel=$('[data-action="cancel-upload"]'),pause=$('[data-action="pause-upload"]');cancel.hidden=false;pause.hidden=f.get('uploadTarget')!=='r2';
    form.querySelectorAll('input,select,textarea').forEach(el=>el.disabled=true);
    const paint=()=>{$('#upload-queue').innerHTML=queueHTML(uploadQueue,true);};
    try{
      const report=await processQueue(uploadQueue,async(file,progress,signal,item)=>{
        if(f.get('uploadTarget')==='r2')return uploadR2(file,api,progress,signal,{sessionId:item.sessionMode==='multipart'?item.sessionId:undefined,onSession:job=>{item.sessionId=job.id;item.sessionMode=job.mode;rememberUploadForm(item,f);},onStatus:status=>{if(['uploading','verifying','retrying'].includes(status)){item.status=status;paint();}}});
        const body=new FormData();body.append('file',file);const result=await api('upload',{method:'POST',body,signal});progress(100);return result.data;
      },paint,uploadController.signal,2);
      if(uploadController.signal.aborted&&uploadController.signal.reason!=='pause'){
        for(const item of uploadQueue.filter(item=>item.sessionMode==='multipart'&&item.sessionId&&!item.result)){
          try{await cancelUploadSession(item.sessionId);item.sessionId='';item.error='已取消并清理未完成分片';}catch(error){item.error=error.message+'；请在未完成上传中重试清理';}
        }
      }
      if(report.failed){
        $('#upload-batch-actions').innerHTML=`<div class="batch-upload-actions"><p>${report.complete} 个已上传，${report.failed} 个未完成。再次保存只重试未完成项；已上传文件不会重复上传。</p>${report.complete?'<button type="button" class="btn btn-sm" data-action="save-uploaded">仅保存已上传文件</button>':''}</div>`;
        toast(uploadController.signal.reason==='pause'?'上传已暂停，点击保存资源草稿继续':'部分文件未上传完成，请重试或仅保存成功项');return;
      }
    }finally{uploading=false;uploadController=null;cancel.hidden=true;pause.hidden=true;form.querySelectorAll('input,select,textarea').forEach(el=>el.disabled=false);$('#upload-queue').innerHTML=queueHTML(uploadQueue);await refreshResumableUploads();}
  }
  const ready=uploadQueue.filter(item=>item.result);if(!ready.length)throw new Error('没有已上传文件可保存');
  if(!completedBatch){
    const existing=draft.resources.find(r=>r.id===editingResource);const multiple=uploadQueue.length>1;
    completedBatch=ready.map(item=>{const result=item.result,platform=item.platform==='通用'?String(f.get('platforms')).split(/[,，]/).map(p=>p.trim()).filter(Boolean):[item.platform],architecture=item.architecture||String(f.get('architecture')||'').trim();
      const suffix=item.platform==='通用'?item.file.name:[item.platform,architecture].filter(Boolean).join(' · ');
      const resource={...existing,id:existing?.id||(result.storage==='r2'?'resource-r2-'+result.id:'resource-'+item.id),name:(String(f.get('name'))+(multiple?' · '+suffix:'')).slice(0,100),version:f.get('version'),category:f.get('category'),url:result.url,summary:f.get('summary'),platforms:platform,architecture,source:result.storage==='r2'?'本站 R2 公开文件':'本站附件',article:f.get('article'),icon:existing?.icon||'file',featured:existing?.featured||false,file_size:result.size,storage:result.storage};
      delete resource.sha256;if(result.sha256)resource.sha256=result.sha256;return resource;
    });
  }
  const changes=completedBatch.map(resource=>({resource,base:draft.resources.find(r=>r.id===resource.id)||null}));
  try{await saveResourceChanges(changes);}catch(error){$('#upload-batch-actions').innerHTML='<p class="upload-save-error">'+escape(error.message)+'。文件仍已上传，重试保存不会重新传文件；刷新后也可从上方恢复上传结果。</p>';throw error;}
  const savedCount=completedBatch.length;
  uploadQueue=partial?uploadQueue.filter(item=>!item.result):[];uploadFile=uploadQueue[0]?.file||null;completedBatch=null;editingResource=null;resourceUnsaved=uploadQueue.length>0;
  if(uploadQueue.length){$('#upload-queue').innerHTML=queueHTML(uploadQueue);$('#upload-batch-actions').innerHTML='';toast(savedCount+' 个资源已保存为草稿；剩余失败项可重试');}
  else{render();toast('草稿已保存到服务器，尚未发布（'+savedCount+' 个文件）');}
}
function adminNavigation() {
  return `<div class="admin-panel">${draft.navigation.map((n,i)=>`<div class="nav-edit-row"><label aria-label="显示${escape(n.title)}"><input type="checkbox" data-nav-toggle="${escape(n.id)}" ${n.enabled?'checked':''}></label><span>${escape(n.title)}<small>${escape(n.url)}</small></span><button data-nav-move="${escape(n.id)}" data-direction="-1" ${i===0?'disabled':''} aria-label="上移${escape(n.title)}">↑</button><button data-nav-move="${escape(n.id)}" data-direction="1" ${i===draft.navigation.length-1?'disabled':''} aria-label="下移${escape(n.title)}">↓</button></div>`).join('')}</div><form class="admin-editor" id="navigation-form"><h3>添加导航项</h3><div class="form-grid"><label class="field"><span>显示名称</span><input name="title" required maxlength="16" placeholder="例如：帮助中心"></label><label class="field"><span>目标地址</span><input name="url" required placeholder="/docs/ 或 https://…"></label></div><div class="form-footer"><p>发布后同步网站首页、教程页与下载页导航。</p><button class="btn btn-sm" type="submit">保存导航草稿</button></div></form>`;
}
function adminHome() {
  const n=draft.announcements.find(n=>n.pinned)||draft.announcements[0];
  return `<form class="admin-editor" id="homepage-form" style="margin-top:0"><h3>首屏内容</h3><div class="form-grid"><label class="field field-wide"><span>首页标题 · 换行分隔</span><textarea name="headline" required maxlength="80" style="min-height:90px">${escape(draft.site.headline)}</textarea></label><label class="field field-wide"><span>简短介绍</span><textarea name="intro" required maxlength="180" style="min-height:90px">${escape(draft.site.intro)}</textarea></label><label class="field field-wide"><span>API Base URL</span><input name="baseUrl" type="url" required value="${escape(draft.site.baseUrl)}"></label><label class="field field-wide"><span>首页置顶公告</span><select name="pinned">${draft.announcements.map(x=>`<option value="${escape(x.id)}" ${x.id===n?.id?'selected':''}>${escape(x.title)}</option>`).join('')}</select></label></div><div class="form-footer"><p>模型权限与价格仍由 New API 管理。</p><button class="btn btn-sm" type="submit">保存首页草稿</button></div></form>`;
}
function notFound(){return `<div class="container loading"><h1 style="font-size:32px">这页还未准备好。</h1><p>可以先从教程文档或下载中心开始。</p>${link('返回首页','/','btn')}</div>`;}
let renderSequence=0;
function render({focus=false}={}) {
  stopParticles();
  const sequence=++renderSequence;
  const path=location.pathname.replace(/\/$/,'')||'/';
  document.body.classList.toggle('particle-home',path==='/');
  document.body.classList.toggle('paper-portal',path!=='/site-admin');
  renderHeader();
  if((path==='/docs'||path.startsWith('/docs/'))&&!articleMarkdown){
    $('#main').innerHTML='<div class="container loading" role="status">正在加载文档…</div>';
    loadMarkdown().then(()=>{if(sequence===renderSequence)render({focus});}).catch(()=>{
      if(sequence===renderSequence)$('#main').innerHTML='<div class="container loading"><h1>文档暂时无法加载</h1><p>请检查网络后重试，或先返回首页。</p><button class="btn" data-action="retry-module">重新加载</button></div>';
    });
    return;
  }
  let html,title;
  if(path==='/'){html=home();title='一个 Key，接入你的 AI 工作流';}
  else if(path==='/docs'){html=docs();title='教程文档';}
  else if(path.startsWith('/docs/')){const slug=path.slice(6);html=articlePage(slug);title=published.articles.find(a=>a.slug===slug)?.title||'未找到页面';}
  else if(path==='/downloads'){html=downloads();title='资源下载';}
  else if(path==='/announcements'){html=announcements();title='公告';}
  else if(path==='/site-admin'){html=adminState==='ready'?admin():adminLogin();title='站点内容管理';}
  else{html=notFound();title='未找到页面';}
  $('#main').innerHTML=html;document.title=`${title} · Shiny API`;
  if(focus)$('#main').focus({preventScroll:true});
  if(location.hash)requestAnimationFrame(()=>{try{document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();}catch{}});
  highlightTOC();
  if(path==='/')scheduleParticles(sequence);
}
function navigate(url) {
  if(uploading){toast('文件正在上传，请完成或取消后再离开');return;}
  if(resourceUnsaved){toast('资源编辑或上传队列尚未保存，请保存或放弃后再离开');return;}
  if(storageUnsaved){toast('存储设置尚未保存，请保存或刷新后再离开');return;}
  if(editorUnsaved){toast('有未保存正文，请先保存草稿或放弃编辑');return;}
  const target=new URL(url,location.origin);editingResource=null;uploadFile=null;uploadQueue=[];completedBatch=null;
  if(target.origin!==location.origin)return;
  $('#search-dialog').close();
  if(target.pathname!=='/downloads/')resourceSearch='';
  history.pushState({},'',target.pathname+target.search+target.hash);render({focus:true});window.scrollTo(0,0);if(target.pathname.startsWith('/site-admin')&&adminState==='idle')void loadAdmin();
}

let searchSequence=0;
async function renderSearch() {
  const sequence=++searchSequence;
  if(!published)return;
  if(!articleMarkdown){
    $('#search-results').innerHTML='<div class="empty-state" role="status">正在加载搜索…</div>';
    try{await loadMarkdown();}catch{
      if(sequence===searchSequence)$('#search-results').innerHTML='<div class="empty-state"><p>搜索暂时无法加载，请检查网络后重试。</p><button class="btn" data-action="retry-module">重新加载</button></div>';
      return;
    }
  }
  if(sequence!==searchSequence||!$('#search-dialog').open)return;
  const q=$('#global-search').value.trim().toLowerCase();
  const all=[...published.articles.map(a=>({name:a.title,description:a.summary,body:articleSearchText(a),meta:a.category,url:'/docs/'+a.slug})),...published.resources.map(r=>({name:r.name,description:r.summary,body:r.platforms.join(' ')+' '+r.version,meta:r.category,url:'/downloads/?q='+encodeURIComponent(r.name)}))];
  const hits=all.filter(x=>(x.name+' '+x.description+' '+x.meta+' '+x.body).toLowerCase().includes(q));
  $('#search-results').innerHTML=hits.length?hits.slice(0,12).map(x=>{const index=x.body.toLowerCase().indexOf(q),excerpt=q&&index>=0?x.body.slice(Math.max(0,index-35),index+100):x.description;return `<a class="search-result" href="${escape(x.url)}" data-route><h3>${escape(x.name)}</h3><p>${escape(x.meta)} · ${escape(excerpt)}</p></a>`;}).join(''):'<div class="empty-state"><h2>没有找到结果</h2><p>试试其他关键词或错误码。</p></div>';
}
let tocObserver;
function highlightTOC(){tocObserver?.disconnect();const headings=[...document.querySelectorAll('.markdown-body h1[id],.markdown-body h2[id],.markdown-body h3[id],.markdown-body h4[id]')];if(!headings.length)return;tocObserver=new IntersectionObserver(entries=>{for(const item of entries)if(item.isIntersecting)for(const a of document.querySelectorAll('.toc a'))a.classList.toggle('active',decodeURIComponent(a.hash.slice(1))===item.target.id);},{rootMargin:'-100px 0px -65% 0px'});headings.forEach(h=>tocObserver.observe(h));}

document.addEventListener('click',async event=>{
  const el=event.target.closest('a,button');if(!el)return;
  if(el.dataset.action==='retry-module'){location.reload();return;}
  if(el.dataset.action==='cancel-upload'){uploadController?.abort('cancel');return;}
  if(el.dataset.action==='pause-upload'){uploadController?.abort('pause');return;}
  if(resourceUnsaved&&(el.dataset.restore||['publish','reload-admin'].includes(el.dataset.action)||el.dataset.editResource||el.dataset.removeResource)){event.preventDefault();toast('资源编辑或上传队列尚未保存，请保存或放弃编辑');return;}
  if(storageUnsaved&&(el.dataset.restore||el.dataset.action==='publish')){event.preventDefault();toast('存储设置尚未保存，请先保存设置');return;}
  if(uploading&&el.closest('.admin-layout')){event.preventDefault();toast('文件正在上传，请等待或取消上传');return;}
  if(saving&&el.closest('.admin-layout')){event.preventDefault();toast('正在保存，请等待完成后再操作');return;}
  if(editorUnsaved&&(el.dataset.restore||el.dataset.action==='reload-admin')){event.preventDefault();toast('有未保存正文，请先保存草稿或放弃编辑');return;}
  if(el.matches('a[data-route]')&&!el.hasAttribute('download')&&/^\/(?:$|docs(?:\/|$)|downloads\/?$|announcements\/?$|site-admin\/?$)/.test(new URL(el.href).pathname)&&event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey){event.preventDefault();navigate(el.href);return;}
  if(el.dataset.restore){try{await api('restore/'+el.dataset.restore,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:serverRevision})});await loadAdmin();toast('历史版本已恢复到草稿，确认后再发布');}catch(error){failure(error);}return;}
  if(el.dataset.copy!==undefined){try{await navigator.clipboard.writeText(el.dataset.copy);toast('已复制到剪贴板');}catch{toast('复制失败，请手动选择文本复制');}return;}
  if(el.dataset.snippet){snippet=el.dataset.snippet;$('#code-sample').innerHTML=sampleHTML();$(`[data-snippet="${snippet}"]`).focus();return;}
  if(el.dataset.docCategory){articleCategory=el.dataset.docCategory;render();return;}
  if(el.dataset.resourceCategory){resourceCategory=el.dataset.resourceCategory;render();return;}
  if(el.dataset.removeResource){draft.resources=draft.resources.filter(r=>r.id!==el.dataset.removeResource);try{await saveLocal();render();toast('已从草稿移除，发布后生效');}catch(error){failure(error);}return;}
  if(el.dataset.recoverUpload){const file=recoverableFiles.find(file=>file.id===el.dataset.recoverUpload);if(file)recoverUploadedFiles([file]);return;}
  if(el.dataset.removeUpload){const item=uploadQueue.find(item=>item.id===el.dataset.removeUpload);try{if(item?.sessionMode==='multipart'&&item.sessionId&&!item.result)await cancelUploadSession(item.sessionId);uploadQueue=uploadQueue.filter(item=>item.id!==el.dataset.removeUpload);completedBatch=null;uploadFile=uploadQueue[0]?.file||null;$('#upload-queue').innerHTML=queueHTML(uploadQueue);$('#upload-batch-actions').innerHTML='';}catch(error){failure(error);}return;}
  if(el.dataset.cancelSession){try{el.disabled=true;await cancelUploadSession(el.dataset.cancelSession);uploadQueue=uploadQueue.filter(item=>item.sessionId!==el.dataset.cancelSession);uploadFile=uploadQueue[0]?.file||null;$('#resumable-uploads').outerHTML=resumableUploadsHTML();$('#upload-queue').innerHTML=queueHTML(uploadQueue);toast('未完成分片已清理');}catch(error){failure(error);}finally{el.disabled=false;}return;}
  if(el.dataset.editResource){editingResource=el.dataset.editResource;const r=draft.resources.find(r=>r.id===editingResource),f=$('#resource-form');for(const k of ['name','version','category','summary'])f.elements[k].value=r[k];f.elements.url.value=r.url;f.elements.platforms.value=r.platforms.join('，');f.elements.article.value=r.article;f.elements.architecture.value=r.architecture||'';f.scrollIntoView({block:'start',behavior:'smooth'});return;}
  if(el.dataset.deleteArticle){
    if(editorUnsaved||pendingImports.length){toast('请先保存或放弃当前编辑和导入预览，再删除');return;}
    const a=draft.articles.find(a=>a.slug===el.dataset.deleteArticle);if(!a)return;
    const references=draft.resources.filter(r=>r.article===a.slug);
    if(references.length){toast('请先在资源管理中更换或移除关联教程：'+references.map(r=>r.name).join('、'));return;}
    deleteArticleSlug=a.slug;const live=published.articles.some(x=>x.slug===a.slug);
    $('#delete-article-title').textContent=live?'从草稿移除教程':'删除教程草稿';
    $('[data-action="confirm-delete-article"]').textContent=live?'确认移除':'确认删除草稿';
    $('#delete-article-description').textContent=live?`「${a.title}」将从当前草稿移除。线上文章保持可见，点击「发布到网站」后才会下线；下线前可以恢复到草稿。附件与历史版本会保留。`:`确定删除未发布的「${a.title}」草稿？此操作不会影响线上文章，也不会删除附件。建议先导出需要保留的正文。`;
    $('#delete-article-dialog').showModal();return;
  }
  if(el.dataset.undoDeleteArticle){
    if(editorUnsaved||pendingImports.length){toast('请先保存当前编辑和导入预览');return;}
    const a=published.articles.find(x=>x.slug===el.dataset.undoDeleteArticle);if(!a||draft.articles.some(x=>x.slug===a.slug))return;
    draft.articles.push(clone(a));try{await saveLocal();render();toast('教程已恢复到草稿');}catch(error){draft.articles=draft.articles.filter(x=>x.slug!==a.slug);failure(error);}return;
  }
  if(el.dataset.editArticle){if(editorUnsaved){toast('请先保存草稿或放弃编辑');return;}editingSlug=el.dataset.editArticle;render();$('#article-form').scrollIntoView({block:'start',behavior:'smooth'});return;}
  if(el.dataset.navMove){const i=draft.navigation.findIndex(n=>n.id===el.dataset.navMove),j=i+Number(el.dataset.direction);if(j>=0&&j<draft.navigation.length){[draft.navigation[i],draft.navigation[j]]=[draft.navigation[j],draft.navigation[i]];try{await saveLocal();render();}catch(error){failure(error);}}return;}
  const action=el.dataset.action;
  if(action==='cancel-delete-article'){$('#delete-article-dialog').close();deleteArticleSlug=null;}
  else if(action==='confirm-delete-article'){
    if(!deleteArticleSlug||saving)return;const slug=deleteArticleSlug;saving=true;el.disabled=true;
    try{const result=await api('articles/'+encodeURIComponent(slug),{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:serverRevision})});serverRevision=result.revision;draft.articles=draft.articles.filter(a=>a.slug!==slug);if(editingSlug===slug)editingSlug=null;$('#delete-article-dialog').close();deleteArticleSlug=null;render();toast(result.wasPublished?'已从草稿移除，发布后才会下线':'未发布草稿已删除');}catch(error){failure(error);}finally{saving=false;el.disabled=false;}
  }
  else if(action==='menu'){const open=$('#main-nav').classList.toggle('open');el.setAttribute('aria-expanded',String(open));el.setAttribute('aria-label',open?'关闭菜单':'打开菜单');}
  else if(action==='theme'){document.body.classList.toggle('dark');try{localStorage.setItem(STORAGE+'-theme',document.body.classList.contains('dark')?'dark':'light');}catch{}renderHeader();particleInstance?.refreshTheme();}
  else if(action==='recover-all-uploads'){recoverUploadedFiles(recoverableFiles);}
  else if(action==='discard-resource'){resourceUnsaved=false;uploadQueue=[];uploadFile=null;completedBatch=null;editingResource=null;render();}
  else if(action==='save-uploaded'){try{await persistUploadBatch(new FormData($('#resource-form')),true);}catch(error){failure(error);}}
  else if(action==='test-r2'){if(storageUnsaved){toast('请先保存存储设置再测试');return;}try{saving=true;el.disabled=true;$('#storage-test-result').textContent='正在测试桶的读写权限…';const result=await api('storage/test',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});$('#storage-test-result').innerHTML='<p class="storage-result">'+escape(result.message)+'</p>';}catch(error){$('#storage-test-result').innerHTML='<p class="storage-result">'+escape(error.message)+'</p>';}finally{saving=false;el.disabled=false;}}
  else if(action==='search'){$('#search-dialog').showModal();renderSearch();$('#global-search').focus();}
  else if(action==='publish'){if(editorUnsaved||pendingImports.length){toast('请先保存编辑中的正文和导入预览，再发布');return;}try{saving=true;el.disabled=true;await api('publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:serverRevision})});await loadAdmin();toast('发布成功，公开页面将在缓存更新后生效');}catch(error){failure(error);}finally{saving=false;el.disabled=false;}}
  else if(action==='reload-admin'||action==='login-retry'){adminState='idle';await loadAdmin();}
  else if(action==='new-article'){if(editorUnsaved){toast('请先保存草稿或放弃编辑');return;}editingSlug=null;render();$('#article-form').scrollIntoView({block:'start'});}

  else if(action==='preview-article'){await previewArticle();}
  else if(action==='discard-editor'){editorUnsaved=false;render();}
  else if(action==='export-markdown'){const form=$('#article-form'),blob=new Blob([form.elements.markdown.value],{type:'text/markdown;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=(form.elements.slug.value||'shiny-guide')+'.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  else if(el.dataset.removeImport!==undefined){pendingImports.splice(Number(el.dataset.removeImport),1);$('#batch-preview').innerHTML=batchPreviewHTML();}
  else if(el.dataset.previewImport!==undefined){const a=pendingImports[Number(el.dataset.previewImport)],all=[...draft.articles,...pendingImports];const issues=inspectMarkdown(a.body_markdown,a,all);const target=$('#batch-article-preview');target.innerHTML=`<div class="import-checks"></div><h2>${escape(a.title)}</h2><div class="markdown-body">${renderMarkdown(a.body_markdown,{article:a,articles:all,stripTitle:true}).html}</div>`;showChecks(issues,target.querySelector('.import-checks'));await previewImages(target);target.scrollIntoView({block:'start'});}
  else if(action==='save-imports'){
    if(editorUnsaved){toast('请先保存当前编辑器的正文');return;}
    const slugs=new Set(draft.articles.map(a=>a.slug));
    for(const a of pendingImports){if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(a.slug)||slugs.has(a.slug)||!a.title.trim()||!a.category.trim()){toast('路径重复或字段不完整：'+a.title);return;}slugs.add(a.slug);}
    const previous=clone(draft.articles);
    try{for(const a of pendingImports){draft.articles.push({slug:a.slug,title:a.title,summary:a.summary||a.title,category:a.category,tags:[],minutes:Math.max(1,Math.min(240,Math.ceil(plainText(a.body_markdown).length/600))),updated:new Date().toLocaleDateString('sv-SE'),featured:false,icon:'book',format_version:2,body_markdown:a.body_markdown,source_path:a.source_path,source_url:/^https:/.test(a.source_url)?a.source_url:''});}await saveLocal();pendingImports=[];render();toast('文档已保存为草稿，请逐篇检查后再发布');}catch(error){draft.articles=previous;failure(error);}
  }

});
document.addEventListener('input',event=>{
  const el=event.target;
  if(el.closest('#article-form'))editorChanged();
  if(el.closest('#resource-form')){resourceUnsaved=true;completedBatch=null;}
  if(el.closest('#storage-form')){storageUnsaved=true;$('#storage-status').textContent='存储设置尚未保存';}
  if(el.dataset.importField)pendingImports[Number(el.dataset.index)][el.dataset.importField]=el.value.trim();
  if(el.id==='doc-search'){docSearch=el.value;$('#doc-results').innerHTML=docResults();}
  if(el.id==='resource-search'){resourceSearch=el.value;$('#resource-results').innerHTML=resourceResults();}
  if(el.id==='global-search')renderSearch();
});
document.addEventListener('change',async event=>{
  const el=event.target;if(saving&&el.closest('.admin-layout')){if(el.type==='checkbox')el.checked=!el.checked;toast('正在保存，请等待完成');return;}
  if(el.closest('#resource-form')){resourceUnsaved=true;completedBatch=null;}
  if(el.dataset.filePlatform){const item=uploadQueue.find(item=>item.id===el.dataset.filePlatform);item.platform=el.value;completedBatch=null;rememberUploadForm(item,new FormData($('#resource-form')));}
  if(el.dataset.fileArchitecture){const item=uploadQueue.find(item=>item.id===el.dataset.fileArchitecture);item.architecture=el.value.trim();completedBatch=null;rememberUploadForm(item,new FormData($('#resource-form')));}
  if(el.closest('#storage-form')){storageUnsaved=true;$('#storage-status').textContent='存储设置尚未保存';}
  if(el.id==='upload-target'){uploadQueue=[];completedBatch=null;$('#upload-queue').innerHTML='';$('#upload-batch-actions').innerHTML='';uploadFile=null;$('#resource-upload').value='';const r2=el.value==='r2';$('#resource-upload').accept=r2?storageSettings.extensions.join(','):'.pdf,.docx,.md,.json,.zip,.png,.jpg,.jpeg,.webp';$('#upload-type-hint').textContent=r2?'R2 公开资源文件，最大 '+formatUploadLimit(storageSettings.maxFileMB)+'；大文件支持分片续传':'PDF / DOCX / Markdown / JSON / ZIP / PNG / JPG / WebP，最大 20 MB';$('#upload-target-note').textContent=r2?'公开桶上传完成后，知道地址的人即可下载；发布只控制本站列表展示。':'本地附件随关联资源发布后才可公开下载。';$('#upload-summary').textContent='选择附件后，点击保存资源草稿开始上传。';}
  if(el.id==='platform-filter'){resourcePlatform=el.value;$('#resource-results').innerHTML=resourceResults();}
  if(el.dataset.navToggle){draft.navigation.find(n=>n.id===el.dataset.navToggle).enabled=el.checked;try{await saveLocal();toast('导航草稿已保存，发布后生效');}catch(error){failure(error);}}

  if(el.id==='batch-import'||el.id==='folder-import'){try{await stageImports(el.files);}catch(error){failure(error);}el.value='';}
  if(el.id==='markdown-import'){
    const file=el.files[0];if(!file)return;if(file.size>1024*1024||!(/\.(md|markdown)$/i.test(file.name))){toast('请选择不超过 1 MB 的 Markdown 文件');el.value='';return;}
    const raw=await file.text(),info=importInfo(raw,file.name),form=$('#article-form');form.elements.markdown.value=raw.replace(/^\uFEFF/,'');
    if(!editingSlug){form.elements.title.value=info.title;form.elements.summary.value=info.summary||info.title;form.elements.slug.value=/^\d+$/.test(info.slug)?'guide-'+crypto.randomUUID().slice(0,8):info.slug;if(info.category)form.elements.category.value=info.category;form.elements.source_path.value=info.source_path;if(/^https:/.test(info.source_url))form.elements.source_url.value=info.source_url;}
    editorChanged();await previewArticle();toast('已导入并预览，正文尚未保存');
  }
  if(el.id==='article-image'){
    editorChanged();
    for(const file of el.files){if(file.size>20*1024*1024||!(/\.(png|jpg|jpeg|webp)$/i.test(file.name))){toast('图片应为 PNG/JPG/WebP，最大 20 MB');continue;}
      try{const payload=new FormData();payload.append('file',file);const result=await api('upload',{method:'POST',body:payload});draftImages.set(result.data.url,URL.createObjectURL(file));const area=$('#article-form').elements.markdown;const image=`\n\n![${file.name.replace(/[\[\]]/g,'')} ](${result.data.url})\n\n`;area.setRangeText(image,area.selectionStart,area.selectionEnd,'end');editorChanged();}catch(error){failure(error);}
    }
    el.value='';await previewArticle();
  }
  if(el.dataset.resumeFile){const job=resumableUploads.find(job=>job.id===el.dataset.resumeFile),file=el.files[0];if(job&&file)selectResumableFile(job,file);el.value='';return;}
  if(el.id==='resource-upload'){
    const files=Array.from(el.files);if(!files.length)return;
    if(files.length>20){toast('每批最多选择 20 个文件');el.value='';return;}
    if(editingResource&&files.length>1){toast('编辑现有资源时只能替换一个文件；请放弃编辑后新建一批资源');el.value='';return;}
    const r2=$('#upload-target').value==='r2',limit=(r2?storageSettings.maxFileMB:20)*1024*1024,extensions=r2?storageSettings.extensions:['.pdf','.docx','.md','.json','.zip','.png','.jpg','.jpeg','.webp'];
    const invalid=files.find(file=>file.size>limit||!extensions.includes('.'+file.name.split('.').pop().toLowerCase()));
    if(invalid){toast('文件格式或大小超限：'+invalid.name+'（最大 '+(r2?formatUploadLimit(storageSettings.maxFileMB):'20 MB')+'）');el.value='';return;}
    uploadQueue=createQueue(files);completedBatch=null;uploadFile=files[0];resourceUnsaved=true;
    $('#upload-summary').textContent=files.length+' 个文件 · 点击保存资源草稿开始上传';$('#upload-queue').innerHTML=queueHTML(uploadQueue);$('#upload-batch-actions').innerHTML='';
  }
});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!form.id.endsWith('-form'))return;event.preventDefault();if(uploading||saving){toast('正在保存或上传，请稍候');return;}const f=new FormData(form);const submit=form.querySelector('button[type=submit]');if(submit)submit.disabled=true;try{
  if(form.id==='storage-form'){
    try{saving=true;const result=await api('storage',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:storageSettings.revision,enabled:f.get('enabled')==='true',accountId:String(f.get('accountId')),bucket:String(f.get('bucket')),publicBase:String(f.get('publicBase')),prefix:String(f.get('prefix')),maxFileMB:Number(f.get('maxFileMB')),accessKeyId:String(f.get('accessKeyId')),secretAccessKey:String(f.get('secretAccessKey'))})});storageSettings=result.data;storageUnsaved=false;render();toast('存储设置已保存，密钥不会回显');}finally{saving=false;}return;
  }
  if(form.id==='article-form'){
    const slug=String(f.get('slug')).trim();if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)){toast('路径请使用小写字母、数字与短横线');return;}
    const existing=draft.articles.find(a=>a.slug===slug);if(existing&&editingSlug!==slug){toast('这个路径已经存在，请更换路径');return;}

    const article=articleFromForm(form);
    if(new TextEncoder().encode(article.body_markdown).length>1024*1024){toast('正文不能超过 1 MB');return;}
    if(existing)Object.assign(existing,article);else draft.articles.push(article);editingSlug=slug;
  }else if(form.id==='resource-form'){
    const url=String(f.get('url')).trim();if(url&&safeUrl(url)==='#'){toast('外部资源地址必须使用 HTTPS');return;}
    if(!url&&!uploadFile){toast('请填写 HTTPS 链接或选择一个附件');return;}
    const existingResource=draft.resources.find(r=>r.id===editingResource);let finalUrl=url, source=existingResource&&url===existingResource.url?existingResource.source:'管理员添加 · 外部链接',fileMeta={};
    if(uploadQueue.length){await persistUploadBatch(f);return;}
    const resource={...existingResource,...fileMeta,id:existingResource?.id||'resource-'+Date.now(),name:f.get('name'),version:f.get('version'),category:f.get('category'),url:finalUrl,summary:f.get('summary'),platforms:String(f.get('platforms')).split(/[,，]/).map(p=>p.trim()).filter(Boolean),source,article:f.get('article'),architecture:String(f.get('architecture')||'').trim(),icon:existingResource?.icon||'file',featured:existingResource?.featured||false};if(existingResource&&finalUrl!==existingResource.url){if(!fileMeta.sha256){delete resource.sha256;}if(fileMeta.file_size===undefined){delete resource.file_size;}if(!fileMeta.storage){delete resource.storage;}}await saveResourceChanges([{resource,base:existingResource||null}]);uploadFile=null;editingResource=null;resourceUnsaved=false;render();toast('资源草稿已保存，尚未发布');return;
  }else if(form.id==='navigation-form'){
    const url=String(f.get('url')).trim();if(safeUrl(url)==='#'){toast('请填写本站 / 路径或 HTTPS 地址');return;}
    if(draft.navigation.length>=8){toast('预览最多支持 8 个导航项，更多内容建议归入下拉菜单');return;}
    draft.navigation.push({id:'custom-'+Date.now(),title:f.get('title'),url,enabled:true});
  }else if(form.id==='homepage-form'){
    const url=String(f.get('baseUrl')).trim();if(!publicLink(url)){toast('API 地址必须使用 HTTPS');return;}
    Object.assign(draft.site,{headline:f.get('headline'),intro:f.get('intro'),baseUrl:url});draft.announcements.forEach(n=>n.pinned=n.id===f.get('pinned'));
  }
  await saveLocal();editorUnsaved=false;resourceUnsaved=false;render();toast('草稿已保存到服务器，尚未发布');
  }catch(error){failure(error);}finally{if(submit)submit.disabled=false;}
});
document.addEventListener('keydown',event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();if(!$('#search-dialog').open)$('#search-dialog').showModal();renderSearch();$('#global-search').focus();}
  if(event.key==='Escape'){$('#main-nav')?.classList.remove('open');const button=$('[data-action="menu"]');if(button)button.setAttribute('aria-expanded','false');}
});
$('#search-dialog').addEventListener('click',event=>{if(event.target===$('#search-dialog')){const rect=event.target.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)event.target.close();}});
window.addEventListener('beforeunload',event=>{if(editorUnsaved||pendingImports.length||storageUnsaved||uploading||resourceUnsaved){event.preventDefault();event.returnValue='';}});
window.addEventListener('popstate',()=>{if(uploading||storageUnsaved||resourceUnsaved){history.pushState({},'','/site-admin/?tab='+(storageUnsaved?'storage':'resources'));toast('请先保存设置或完成上传');return;}if(editorUnsaved){history.pushState({},'',editorReturnURL);toast('有未保存正文，请先保存草稿或放弃编辑');return;}editingResource=null;uploadFile=null;render({focus:true});if(location.pathname.startsWith('/site-admin')&&adminState==='idle')void loadAdmin();});
export function startPortal(content) {
  original=content;if(!validStored(original))throw new Error('invalid content');
  published=clone(original);draft=clone(original);
  try{document.body.classList.toggle('dark',localStorage.getItem(STORAGE+'-theme')==='dark');}catch{}
  render();if(location.pathname.startsWith('/site-admin'))void loadAdmin();
}
