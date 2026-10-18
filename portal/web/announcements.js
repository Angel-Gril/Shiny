import {normalizeNotice, noticeVersion, isNoticeRead, markNoticeRead, subscribeNoticeRead} from './notice-policy.js';

export {markNoticeRead};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function publicJSON(path, signal) {
  const timeout = AbortSignal.timeout(8000);
  const response = await fetch(path, {cache:'no-cache', signal:signal ? AbortSignal.any([signal, timeout]) : timeout});
  if (!response.ok) throw new Error('Announcement unavailable');
  const data = await response.json();
  if (data?.success !== true) throw new Error('Announcement unavailable');
  return data.data;
}

export async function mountNotice({signal, isCurrent, onDetails}) {
  const noop = {dispose() {}};
  const current = () => !signal.aborted && isCurrent();
  const content = normalizeNotice(await publicJSON('/api/notice', signal));
  const version = await noticeVersion(content);
  if (!current() || !version || isNoticeRead(version)) return noop;
  const {renderMarkdown} = await import('./markdown.js');
  if (!current() || isNoticeRead(version)) return noop;
  const dialog = document.createElement('dialog');
  dialog.className = 'site-notice';
  dialog.dataset.siteNotice = '';
  dialog.setAttribute('aria-labelledby', 'site-notice-title');
  dialog.innerHTML = `<header class="site-notice-header"><div><div class="kicker">SHINY NOTICE</div><h2 id="site-notice-title">站点公告</h2></div><button type="button" class="icon-button" data-notice-close aria-label="关闭公告">×</button></header><div class="markdown-body site-notice-body" data-notice-body>${renderMarkdown(content).html}</div><footer class="site-notice-actions"><a class="text-link" href="/announcements/system-notice" data-notice-details>查看详情 →</a><button class="btn btn-primary" type="button" data-notice-dismiss autofocus>我知道了</button></footer>`;
  let done = false;
  let unsubscribe = () => {};
  const finish = (read) => {
    if (done) return;
    done = true;
    unsubscribe();
    signal.removeEventListener('abort', dispose);
    document.removeEventListener('close', deferShow, true);
    document.removeEventListener('visibilitychange', deferShow);
    if (read) markNoticeRead(version);
    dialog.removeEventListener('close', acknowledge);
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  function dispose() {finish(false);}
  function acknowledge() {finish(true);}
  function show() {
    if (done) return;
    if (!current() || isNoticeRead(version)) {dispose(); return;}
    if (dialog.open || document.hidden || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    dialog.showModal();
  }
  function deferShow() {queueMicrotask(show);}
  dialog.addEventListener('cancel', event => {event.preventDefault(); acknowledge();});
  dialog.addEventListener('close', acknowledge);
  for (const button of dialog.querySelectorAll('[data-notice-dismiss], [data-notice-close]')) button.addEventListener('click', acknowledge);
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) acknowledge();
  });
  dialog.querySelector('[data-notice-details]').addEventListener('click', event => {
    if(event.button!==0||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.defaultPrevented){acknowledge();return;}
    event.preventDefault(); acknowledge(); onDetails();
  });
  unsubscribe = subscribeNoticeRead(() => {if (isNoticeRead(version)) dispose();});
  signal.addEventListener('abort', dispose, {once:true});
  document.addEventListener('close', deferShow, true);
  document.addEventListener('visibilitychange', deferShow);
  document.body.append(dialog);
  try {show();} catch {dispose();}
  return {dispose};
}

export async function renderAnnouncementDetail({id, announcements, signal}) {
  let notice = announcements.find(item => String(item.id) === id);
  let body = '', extra = '', version = null, cached = false, canonicalPath;
  if (id === 'system-notice') {
    body = normalizeNotice(await publicJSON('/api/notice', signal));
    version = await noticeVersion(body);
    notice = {title:'系统公告', tag:'站点公告', date:''};
    if (!body) return unavailable('当前没有系统公告', '可以返回公告列表查看历史更新。');
  } else if (id.startsWith('newapi-') || /^legacy-[a-f0-9]{64}$/.test(id)) {
    try {
      const status = await publicJSON('/api/status', signal);
      // Keep the existing portal backend's generated IDs for older records.
      const list = status?.announcements_enabled && Array.isArray(status.announcements)
        ? status.announcements.slice(0,100).filter(item => typeof item?.content === 'string' && item.content.trim()) : [];
      let original;
      if(id.startsWith('legacy-')){
        const matches=await Promise.all(list.map(async item=>({item,key:await legacyAnnouncementKey(item)})));
        const found=matches.filter(match=>match.key===id);
        if(found.length===1)original=found[0].item;
      }else{
        original = list.find((item,index) => {
          const projectedId = Object.hasOwn(item,'id') ? (item.id === null ? 'None' : String(item.id)) : String(index);
          return projectedId === id.slice(7);
        });
      }
      if (!original) return unavailable('公告不存在或已下线', '可以返回公告列表查看其他更新。');
      if(!Object.hasOwn(original,'id')){
        const key=await legacyAnnouncementKey(original);
        if(key)canonicalPath='/announcements/'+key;
      }
      body = typeof original.content === 'string' ? original.content : '';
      extra = typeof original.extra === 'string' ? original.extra : '';
      notice = {...notice, title:original.title || notice?.title || body.split('\n')[0].slice(0,90), date:String(original.publishDate || '').slice(0,10), tag:'站点公告'};
    } catch (error) {
      if (signal.aborted) throw error;
      if (!notice) throw error;
      body = notice.summary || ''; cached = true;
    }
  } else if (notice) {
    body = notice.body_markdown || notice.content || notice.summary || '';
    extra = notice.extra || '';
  }
  if (!notice) return unavailable('公告不存在或已下线', '可以返回公告列表查看其他更新。');
  const {renderMarkdown, plainText} = await import('./markdown.js');
  const title = plainText(notice.title || '站点公告');
  const full = [body, extra].filter(Boolean).join('\n\n---\n\n');
  return {title, version, canonicalPath, html:`<div class="container"><div class="page-head"><div class="breadcrumb"><a href="/" data-route>首页</a><span>/</span><a href="/announcements/" data-route>公告</a><span>/</span>公告详情</div></div><article class="announcement-detail article-content" data-announcement-detail><header><div class="kicker">${escape(notice.tag || '站点公告')}</div><h1>${escape(title)}</h1>${notice.date?`<p class="article-meta"><time datetime="${escape(notice.date)}">${escape(notice.date)}</time></p>`:''}</header>${cached?'<p class="announcement-cache-note" role="status">公告服务暂时不可用，当前显示最近同步的公开内容。</p>':''}<div class="markdown-body">${renderMarkdown(full).html}</div><nav class="announcement-back"><a class="text-link" href="/announcements/" data-route>← 返回公告列表</a></nav></article></div>`};
}

async function legacyAnnouncementKey(item) {
  const digest=await noticeVersion(JSON.stringify([normalizeNotice(item.content),normalizeNotice(item.extra),String(item.publishDate||'')]));
  return digest?'legacy-'+digest.slice('notice-v1:'.length):null;
}

function unavailable(title, text) {
  return {title, version:null, html:`<div class="container page-head" data-announcement-detail><h1>${escape(title)}</h1><p>${escape(text)}</p><a class="btn" href="/announcements/" data-route>返回公告列表</a></div>`};
}
