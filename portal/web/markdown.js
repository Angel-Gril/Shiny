import MarkdownIt from './vendor/markdown-it.mjs';
import DOMPurify from './vendor/purify.mjs';

const md = new MarkdownIt({html:true,linkify:true,breaks:false});
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const allowedTags = ['p','br','hr','h1','h2','h3','h4','h5','h6','strong','em','s','del','a','img','ul','ol','li','blockquote','pre','code','table','thead','tbody','tfoot','tr','th','td','details','summary','kbd','sup','sub','input'];

export function articleMarkdown(article) {
  if(typeof article.body_markdown==='string')return article.body_markdown;
  return (article.sections||[]).map(s=>{
    let out=`## ${s.title}\n\n${s.text||''}`;
    if(s.code){const fence='`'.repeat(Math.max(3,...[...s.code.matchAll(/`+/g)].map(m=>m[0].length+1)));out+=`\n\n${fence}${s.language||''}\n${s.code}\n${fence}`;}
    if(s.callout)out+='\n\n'+s.callout.split('\n').map(line=>'> '+line).join('\n');
    if(s.link)out+=`\n\n[${s.link.label}](<${s.link.url}>)`;
    return out;
  }).join('\n\n');
}

export function importInfo(raw, filename='article.md') {
  const source=raw.replace(/^\uFEFF/,'');let body=source,fields={};
  const front=source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(front){
    for(const line of front[1].split(/\r?\n/)){const m=line.match(/^([a-z_]+):\s*(.*?)\s*$/);if(m)fields[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}
    body=source.slice(front[0].length);
  }
  const heading=md.parse(body,{}).findIndex(t=>t.type==='heading_open'&&t.tag==='h1');
  const tokens=md.parse(body,{});const title=(fields.title||(heading>=0?tokens[heading+1].content:'')||filename.replace(/\.(md|markdown)$/i,'')).slice(0,100);
  const paragraph=tokens.findIndex(t=>t.type==='paragraph_open');
  const sourcePath=filename.replaceAll('\\','/');
  const slug=(fields.slug||filename.replace(/\.(md|markdown)$/i,'')).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70).replace(/-$/,'')||'guide-'+Date.now().toString(36);
  return {body:source,title,slug,category:fields.category||'',summary:(fields.description||fields.summary||plainText(paragraph>=0?tokens[paragraph+1].content:body).replace(title,'').trim()).slice(0,180),source_path:sourcePath,source_url:fields.source_url||fields.source||''};
}

function normalizePath(path){return new URL(path,'https://local.invalid/').pathname;}
function mappedLink(href,article,articles){
  if(!href||href.startsWith('#')||/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('//'))return href;
  let pathname,hash;
  try{const target=new URL(href,'https://local.invalid/'+(article.source_path||article.slug+'.md'));pathname=decodeURIComponent(target.pathname);hash=target.hash;}catch{return href;}
  if(!/\.(?:md|markdown)$/i.test(pathname))return href;
  const exact=articles.filter(a=>a.source_path&&decodeURIComponent(normalizePath(a.source_path))===pathname);
  const basename=pathname.split('/').pop();
  const matches=exact.length?exact:articles.filter(a=>a.source_path?.split('/').pop()===basename);
  return matches.length===1?'/docs/'+matches[0].slug+hash:href;
}

export function renderMarkdown(source,{article={},articles=[],stripTitle=false}={}) {
  source=(source||'').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'');
  // Explicit allowlist; raw HTML is never trusted, including administrator imports.
  const fragment=DOMPurify.sanitize(md.render(source||''),{RETURN_DOM_FRAGMENT:true,ALLOWED_TAGS:allowedTags,ALLOWED_ATTR:['href','src','alt','title','class','start','colspan','rowspan','align','type','checked','disabled','open'],ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false});
  if(stripTitle&&fragment.firstElementChild?.tagName==='H1'&&fragment.firstElementChild.textContent.trim()===article.title?.trim())fragment.firstElementChild.remove();
  const used=new Set(),toc=[];
  for(const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')){
    const base=heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-|-$/g,'')||'section';let id=base,n=2;
    while(used.has(id))id=base+'-'+n++;used.add(id);heading.id=id;
    toc.push({id,title:heading.textContent,level:Number(heading.tagName[1])});
  }
  for(const anchor of fragment.querySelectorAll('a')){
    const href=mappedLink(anchor.getAttribute('href'),article,articles);
    if(!href||/^(?:javascript|data|vbscript):/i.test(href)){anchor.removeAttribute('href');continue;}
    if(href.startsWith('/')&&!href.startsWith('//')){anchor.setAttribute('href',href);if(/^\/docs(?:\/|$)/.test(href))anchor.dataset.route='';}
    else if(href.startsWith('#'))anchor.setAttribute('href',href);
    else if(/^https?:\/\//i.test(href)){anchor.setAttribute('href',href);anchor.target='_blank';anchor.rel='noopener noreferrer';}
    else if(/^mailto:/i.test(href))anchor.setAttribute('href',href);
    else{anchor.removeAttribute('href');anchor.classList.add('unresolved-link');anchor.title='关联文件尚未导入或需要改为本站链接';}
  }
  for(const image of fragment.querySelectorAll('img')){
    const src=image.getAttribute('src')||'';
    if(!/^https:\/\//i.test(src)&&!/^\/(?!\/)/.test(src)){const note=document.createElement('span');note.className='missing-image';note.textContent='[请上传图片：'+(image.alt||src)+']';image.replaceWith(note);continue;}
    image.loading='lazy';image.decoding='async';image.referrerPolicy='no-referrer';
  }
  for(const input of fragment.querySelectorAll('input')){if(input.type!=='checkbox')input.remove();else input.disabled=true;}
  for(const li of fragment.querySelectorAll('li')){
    const node=li.firstChild;if(node?.nodeType===3&&/^\[[ xX]\] /.test(node.textContent)){const box=document.createElement('input');box.type='checkbox';box.disabled=true;box.checked=/^\[[xX]\]/.test(node.textContent);node.textContent=node.textContent.slice(4);li.prepend(box);}
  }
  for(const pre of fragment.querySelectorAll('pre')){
    const code=pre.querySelector('code');if(!code)continue;
    const wrapper=document.createElement('div');wrapper.className='code-block';const head=document.createElement('div');head.className='code-block-head';
    const lang=document.createElement('span');lang.textContent=(code.className.match(/language-([^\s]+)/)||[])[1]||'示例';
    const button=document.createElement('button');button.type='button';button.textContent='复制';button.dataset.copy=code.textContent;
    head.append(lang,button);pre.replaceWith(wrapper);wrapper.append(head,pre);
  }
  for(const table of fragment.querySelectorAll('table')){const wrap=document.createElement('div');wrap.className='markdown-table';wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','表格，可横向滚动');table.replaceWith(wrap);wrap.append(table);}
  const container=document.createElement('div');container.append(fragment);
  return {html:container.innerHTML,toc};
}

export function plainText(source){
  return md.parse(source||'',{}).flatMap(t=>t.type==='inline'||t.type==='fence'||t.type==='code_block'?[t.content]:[]).join(' ').replace(/<[^>]*>/g,' ').replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/\s+/g,' ').trim();
}

export function inspectMarkdown(source,article,articles){
  const issues=[];const rendered=renderMarkdown(source,{article,articles});const div=document.createElement('div');div.innerHTML=rendered.html;
  for(const el of div.querySelectorAll('.unresolved-link,.missing-image'))issues.push(el.title||el.textContent);
  const hosts=new Set();for(const el of div.querySelectorAll('a[href],img[src]')){try{const u=new URL(el.getAttribute('href')||el.getAttribute('src'),location.origin);if(u.origin!==location.origin)hosts.add(u.hostname);}catch{}}
  if(hosts.size)issues.push('外部链接／图片来源：'+[...hosts].join('、')+'，发布前请核对品牌、客服与接口地址。');
  return [...new Set(issues)];
}

export function tocHTML(toc){return toc.map(h=>`<a class="toc-level-${h.level}" href="#${esc(h.id)}">${esc(h.title)}</a>`).join('');}
