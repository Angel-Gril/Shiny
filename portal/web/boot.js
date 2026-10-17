// Fetch public content while the application downloads. Optional document and
// administration modules are loaded by the application only when requested.
const content=fetch('/portal-api/content',{cache:'no-cache'}).then(response=>{
  if(!response.ok)throw new Error('content unavailable');
  return response.json();
});
Promise.all([content,import('./app.js')]).then(([data,app])=>app.startPortal(data)).catch(()=>{
  document.getElementById('main').innerHTML='<div class="container loading"><h1 style="font-size:28px">内容暂时无法加载</h1><p>请检查网络后重试。你也可以直接访问控制台。</p><button class="btn" id="portal-retry">重新加载</button> <a class="btn" href="/dashboard">前往控制台</a></div>';
  document.getElementById('portal-retry').addEventListener('click',()=>location.reload());
});
