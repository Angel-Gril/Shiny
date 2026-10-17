"""Apply the approved preview UI to the independent production portal."""
import json
from pathlib import Path

root=Path(__file__).parent
web=root/'web'
preview=root.parent/'portal-preview'
s=(preview/'app.js').read_text(encoding='utf-8')
s=s.replace("const STORAGE = 'shiny-portal-design-v1';", "const STORAGE = 'shiny-portal-theme';\nlet serverRevision = 0, serverHistory = [], adminState = 'idle', adminError = '', accessToken = '', tokenExpires = 0, authPromise = null;")
s=s.replace("let original, published, draft,", "let saving=false;\nlet original, published, draft,")
start=s.index('function readStored()')
end=s.index('function toast(',start)
s=s[:start]+'''async function refreshIdentity() {
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
  const headers={'Authorization':'Bearer '+accessToken,'X-Portal-Request':'1',...options.headers};
  const response=await fetch('/portal-api/admin/'+path,{...options,headers,credentials:'same-origin',cache:'no-store'});
  if(response.status===401&&retry){accessToken='';await refreshIdentity();return api(path,options,false);}
  let body;
  try{body=await response.json();}catch{throw new Error('内容服务响应异常，请稍后重试');}
  if(!response.ok||!body.success){if(response.status===401||response.status===403){adminState='denied';adminError=body.message;render();}throw new Error(body.message||'操作失败');}
  return body;
}
async function loadAdmin() {
  if(adminState==='loading')return;
  editingResource=null;uploadFile=null;
  adminState='loading';render();
  try{
    await api('session');const result=await api('content');
    draft=result.data.draft;published=result.data.published;serverRevision=result.data.revision;serverHistory=result.data.history;
    adminState='ready';adminError='';
  }catch(error){adminState='denied';adminError=error.message;}
  render();
}
async function saveLocal() {
  if(saving)throw new Error('正在保存，请等待完成');
  saving=true;
  try{const result=await api('content',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:draft,revision:serverRevision})});serverRevision=result.revision;}
  catch(error){await loadAdmin();throw error;}
  finally{saving=false;}
}
function failure(error){toast(error.message||'操作失败，请稍后重试');}
''' + s[end:]
s=s.replace('本地设计预览','Shiny API')
s=s.replace("else if(path==='/site-admin'){html=admin();title='内容管理预览';}", "else if(path==='/site-admin'){html=adminState==='ready'?admin():adminLogin();title='站点内容管理';}")
s=s.replace("document.title=`${title} · Shiny API 本地预览`;", "document.title=`${title} · Shiny API`;")
s=s.replace("history.pushState({},'',target.pathname+target.search+target.hash);render({focus:true});window.scrollTo(0,0);", "history.pushState({},'',target.pathname+target.search+target.hash);render({focus:true});window.scrollTo(0,0);if(target.pathname.startsWith('/site-admin')&&adminState==='idle')void loadAdmin();")
s=s.replace("<span>示例教程</span>","<span>Shiny 使用指南</span>")
s=s.replace("按已启用模型类别整理的展示示例；具体模型、权限与价格请以控制台为准。","具体模型、可用分组、权限与价格，以模型与价格页面为准。")
s=s.replace("此处未连接 R2 或生产文件存储。","本站附件由独立文件库提供。")
s=s.replace("本站示例", "本站资料").replace("下载示例", "下载文件")
s=s.replace("${tag('仅本机演示')}","${tag('管理员内容工作台')}")
s=s.replace("当前内容已发布到本地预览", "当前草稿与发布内容一致")
s=s.replace("<button class=\"btn btn-sm\" data-action=\"reset-preview\">重置演示</button>", "<button class=\"btn btn-sm\" data-action=\"reload-admin\">刷新内容</button>")
s=s.replace('发布到本地预览','发布到网站')
s=s.replace("此页演示编辑与发布流程。<br>数据只保存在当前浏览器。<br>正式版需接入管理员鉴权、独立内容库与文件存储。", "使用 Shiny 管理员身份。<br>草稿、版本与附件独立保存。<br>发布后，公开页面自动更新。")
s=s.replace("设计预览 · 上传不发送网络请求，发布不影响线上 Shiny。", "内容服务独立于 New API 发布；草稿保存后需点击发布才会公开。")
s=s.replace("<p class=\"section-footer\">", "${adminHistory()}<p class=\"section-footer\">")
s=s.replace("<span id=\"upload-summary\">演示仅读取文件名与大小，不上传、不持久保存文件内容。</span>", "<span id=\"upload-summary\">附件保存后，随关联资源发布到网站。</span>")
s=s.replace("PDF / DOCX / Markdown / JSON / ZIP，最大 20 MB", "PDF / DOCX / Markdown / JSON / ZIP / PNG / JPG / WebP，最大 20 MB")
s=s.replace('accept=".pdf,.docx,.md,.json,.zip"','accept=".pdf,.docx,.md,.json,.zip,.png,.jpg,.jpeg,.webp"')
s=s.replace("正式版的文件可保存到 R2 或独立持久化目录。", "文件保存在服务器独立持久化目录，不随网页版本覆盖。")
s=s.replace("数据只保存在当前浏览器", "数据保存在独立内容数据库")
s=s.replace('本机','服务器')
s=s.replace("const el=event.target.closest('a,button');if(!el)return;", "const el=event.target.closest('a,button');if(!el)return;if(saving&&el.closest('.admin-layout')){event.preventDefault();toast('正在保存，请等待完成后再操作');return;}")
s=s.replace("const el=event.target;\n  if(el.id==='platform-filter')", "const el=event.target;if(saving&&el.closest('.admin-layout')){if(el.type==='checkbox')el.checked=!el.checked;toast('正在保存，请等待完成');return;}\n  if(el.id==='platform-filter')")
s=s.replace("const target=new URL(url,location.origin);", "const target=new URL(url,location.origin);editingResource=null;uploadFile=null;")
s=s.replace('同步本地首页','同步网站首页')
s=s.replace("if(el.matches('a[data-route]')&&event.button===0", "if(el.matches('a[data-route]')&&!el.hasAttribute('download')&&/^\\/(?:$|docs(?:\\/|$)|downloads\\/?$|announcements\\/?$|site-admin\\/?$)/.test(new URL(el.href).pathname)&&event.button===0")
s=s.replace("只有当前浏览器", "只有管理员")
s=s.replace("先保存草稿，再预览；确认后统一发布。", "先保存草稿，再预览；确认后点击页面上方的发布。")
s=s.replace("<h3>${a?'编辑教程':'新建教程'}</h3>", "<div class=\"admin-heading\"><h3>${a?'编辑教程':'新建教程'}</h3><button type=\"button\" class=\"link-button\" data-action=\"new-article\">新建教程</button></div>")
s=s.replace("const a=draft.articles.find(a=>a.slug===editingSlug);", "const a=draft.articles.find(a=>a.slug===editingSlug);")
s=s.replace("saveLocal();render();}return;", "try{await saveLocal();render();}catch(error){failure(error);}}return;")
s=s.replace("else if(action==='publish'){published=clone(draft);saveLocal();render();toast('已发布到网站，线上网站未改变');}", "else if(action==='publish'){try{el.disabled=true;await api('publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:serverRevision})});await loadAdmin();toast('发布成功，公开页面将在缓存更新后生效');}catch(error){failure(error);}finally{el.disabled=false;}}")
# Original message still carries its original local terminology at this stage.
start=s.index("  else if(action==='publish')")
end=s.index("  else if(action==='preview-article')",start)
s=s[:start]+'''  else if(action==='publish'){try{saving=true;el.disabled=true;await api('publish',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:serverRevision})});await loadAdmin();toast('发布成功，公开页面将在缓存更新后生效');}catch(error){failure(error);}finally{saving=false;el.disabled=false;}}
  else if(action==='reload-admin'||action==='login-retry'){adminState='idle';await loadAdmin();}
  else if(action==='new-article'){editingSlug=null;render();$('#article-form').scrollIntoView({block:'start'});}
''' + s[end:]
s=s.replace("document.addEventListener('change',async event=>{", "document.addEventListener('change',async event=>{")
s=s.replace("saveLocal();toast('导航草稿已保存，发布后生效');", "try{await saveLocal();toast('导航草稿已保存，发布后生效');}catch(error){failure(error);}")
s=s.replace("/\\.(pdf|docx|md|json|zip)$/i", "/\\.(pdf|docx|md|json|zip|png|jpg|jpeg|webp)$/i")
s=s.replace(" · 仅显示文件信息，未上传", " · 等待保存上传")
s=s.replace("document.addEventListener('submit',event=>{", "document.addEventListener('submit',async event=>{")
s=s.replace("event.preventDefault();const f=new FormData(form);", "event.preventDefault();const f=new FormData(form);const submit=form.querySelector('button[type=submit]');if(submit)submit.disabled=true;try{")
start=s.index("    if(!url){toast('已查看附件预览")
end=s.index("  }else if(form.id==='navigation-form')",start)
s=s[:start]+'''    let finalUrl=url, source='管理员添加 · 外部链接';
    if(!url){const upload=new FormData();upload.append('file',uploadFile);const result=await api('upload',{method:'POST',body:upload});finalUrl=result.data.url;source='本站附件 · '+Math.ceil(result.data.size/1024)+' KB · SHA256 '+result.data.sha256.slice(0,12);}
    draft.resources.push({id:'resource-'+Date.now(),name:f.get('name'),version:f.get('version'),category:f.get('category'),url:finalUrl,summary:f.get('summary'),platforms:['通用'],source,article:'quickstart',icon:'file',featured:false});
    uploadFile=null;
''' + s[end:]
s=s.replace("  saveLocal();render();toast('草稿已保存在服务器，尚未发布');\n});", "  await saveLocal();render();toast('草稿已保存到服务器，尚未发布');\n  }catch(error){failure(error);}finally{if(submit)submit.disabled=false;}\n});")
# Remove the local persistence/sync boot; published content is always server-owned.
start=s.index("window.addEventListener('storage'")
s=s[:start]+'''try {
  const response=await fetch('/portal-api/content',{cache:'no-cache'});if(!response.ok)throw new Error('content unavailable');original=await response.json();if(!validStored(original))throw new Error('invalid content');
  published=clone(original);draft=clone(original);
  try{document.body.classList.toggle('dark',localStorage.getItem(STORAGE+'-theme')==='dark');}catch{}
  render();if(location.pathname.startsWith('/site-admin'))void loadAdmin();
}catch(error){$('#main').innerHTML='<div class="container loading"><h1 style="font-size:28px">内容暂时无法加载</h1><p>请稍后刷新。你也可以直接访问控制台。</p><a class="btn" href="/dashboard">前往控制台</a></div>';}
'''
# Version history restores to draft first, never silently publishes an old page.
insert=s.index('function adminArticles()')
s=s[:insert]+'''function adminLogin(){return `<div class="container page-head"><div class="empty-state"><h1 style="font-size:26px">站点内容管理</h1><p>${adminState==='loading'?'正在校验登录状态…':escape(adminError||'使用现有 Shiny 超级管理员账号管理内容。')}</p><div class="admin-actions" style="justify-content:center;margin-top:22px"><a class="btn btn-primary" href="/sign-in">前往登录</a><button class="btn" data-action="login-retry">已登录，重新检查</button></div></div></div>`;}
function adminHistory(){return `<details class="admin-editor"><summary>已发布版本 · 可恢复为草稿</summary><div class="nav-history">${serverHistory.map(h=>`<div class="nav-edit-row"><span>版本 #${h.id}<small>${escape(new Date(h.published_at*1000).toLocaleString('zh-CN'))}</small></span><button data-restore="${h.id}">恢复为草稿</button></div>`).join('')}</div></details>`;}
''' + s[insert:]
s=s.replace("  if(el.dataset.copy!==undefined)","  if(el.dataset.restore){try{await api('restore/'+el.dataset.restore,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:serverRevision})});await loadAdmin();toast('历史版本已恢复到草稿，确认后再发布');}catch(error){failure(error);}return;}\n  if(el.dataset.copy!==undefined)")
# Resource management can remove or update existing entries, not only add.
s=s.replace("<th>状态</th></tr></thead><tbody>${draft.resources", "<th>操作</th></tr></thead><tbody>${draft.resources")
s=s.replace("<td>${tag(published.resources.some(x=>x.id===r.id)?'已发布':'草稿',true)}</td>","<td><button class=\"link-button\" data-edit-resource=\"${escape(r.id)}\">编辑</button> · <button class=\"link-button\" data-remove-resource=\"${escape(r.id)}\">移除</button></td>")
s=s.replace("let original, published, draft,", "let editingResource=null;\nlet original, published, draft,")
s=s.replace("<h3>添加资源</h3>","<h3>添加或编辑资源</h3>")
s=s.replace('name="url" type="url"', 'name="url" type="text"')
s=s.replace("sections:parseMarkdown(String(f.get('markdown')))","sections:mergeSections(existing,String(f.get('markdown')))")
s=s.replace("function articleToMarkdown(a)","function mergeSections(existing,markdown){if(existing&&articleToMarkdown(existing)===markdown)return clone(existing.sections);return parseMarkdown(markdown).map(section=>{const old=existing?.sections.find(s=>s.title===section.title);if(old){for(const key of ['link','callout','language'])if(old[key]!==undefined)section[key]=clone(old[key]);}return section;});}\nfunction articleToMarkdown(a)")
s=s.replace("window.addEventListener('popstate',()=>render({focus:true}));", "window.addEventListener('popstate',()=>{editingResource=null;uploadFile=null;render({focus:true});if(location.pathname.startsWith('/site-admin')&&adminState==='idle')void loadAdmin();});")
s=s.replace("  if(el.dataset.editArticle)","  if(el.dataset.removeResource){draft.resources=draft.resources.filter(r=>r.id!==el.dataset.removeResource);try{await saveLocal();render();toast('已从草稿移除，发布后生效');}catch(error){failure(error);}return;}\n  if(el.dataset.editResource){editingResource=el.dataset.editResource;const r=draft.resources.find(r=>r.id===editingResource),f=$('#resource-form');for(const k of ['name','version','category','summary'])f.elements[k].value=r[k];f.elements.url.value=r.url;f.scrollIntoView({block:'start',behavior:'smooth'});return;}\n  if(el.dataset.editArticle)")
s=s.replace("if(url&&!publicLink(url))", "if(url&&safeUrl(url)==='#')")
s=s.replace("draft.resources.push({id:'resource-'+Date.now(),", "const existingResource=draft.resources.find(r=>r.id===editingResource);const resource={id:existingResource?.id||'resource-'+Date.now(),")
s=s.replace("icon:'file',featured:false});\n    uploadFile=null;", "icon:existingResource?.icon||'file',featured:existingResource?.featured||false};if(existingResource)Object.assign(existingResource,resource);else draft.resources.push(resource);\n    uploadFile=null;editingResource=null;")
web.joinpath('app.js').write_text(s,encoding='utf-8')
html=(preview/'index.html').read_text(encoding='utf-8')
html=html.replace('<div class="preview-strip"><div class="container"><span><span class="preview-dot"></span>本地设计预览<span class="preview-note"> · 示例内容，未连接生产</span></span><a href="/site-admin/" data-route>体验内容管理 <span aria-hidden="true">↗</span></a></div></div>','')
html=html.replace('Shiny API 本地门户设计预览：教程、下载和站点内容管理。','Shiny API 统一模型接入、使用教程与工具资源。')
html=html.replace('Shiny API · 设计预览','Shiny API — 一个 Key，接入你的 AI 工作流')
html=html.replace('正在加载设计预览…','正在加载 Shiny…').replace('查看本地设计预览','查看页面')
html=html.replace('搜索仅限本地示例内容','搜索教程与资源')
web.joinpath('index.html').write_text(html,encoding='utf-8')
data=json.loads((preview/'content.json').read_text(encoding='utf-8'))
data['revision']='portal-v1'
data['announcements']=[]
for a in data['articles']:
    for section in a['sections']:
        section.pop('callout',None)
        section['text']=section.get('text','').replace('本页内容用于展示文档阅读体验，正式教程将在发布前逐步验证。','本页介绍账号、令牌和接口的基本使用方式。')
        section['text']=section['text'].replace('模板中的模型名与参数仅作示意，发布前需要对本站支持的尺寸和质量档位完成验证。','模型名与参数请以当前模型与价格页以及客户端的支持情况为准。')
for r in data['resources']:
    r['version']=r['version'].replace('预览 v1','v1.0')
    r['source']=r['source'].replace('本站示例','本站资料')
web.joinpath('content.json').unlink(missing_ok=True)
(root/'backend'/'seed.json').write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')
for p in (web/'templates').iterdir():
    if p.suffix=='.json':
        d=json.loads(p.read_text(encoding='utf-8'));d['notice']='按实际客户端要求填写，文件不包含真实密钥。';p.write_text(json.dumps(d,ensure_ascii=False,indent=2),encoding='utf-8')
    elif p.suffix=='.md':
        t=p.read_text(encoding='utf-8').replace('（设计预览）','').replace('本文件为前端设计预览附件，正式教程发布前需要实际验收。','请以控制台当前模型、分组和价格为准。');p.write_text(t,encoding='utf-8')
print('Production frontend prepared; no deployment performed.')
