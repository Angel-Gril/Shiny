// Fetch public content while the application downloads. Optional document and
// administration modules are loaded by the application only when requested.
const content=fetch('/portal-api/content',{cache:'no-cache'}).then(response=>{
  if(!response.ok)throw new Error('content unavailable');
  return response.json();
}).catch(error=>{
  throw {stage:'content',cause:error};
});
const application=import('./app.js').catch(error=>{
  throw {stage:'module',cause:error};
});
Promise.all([content,application]).then(([data,app])=>app.startPortal(data)).catch(error=>{
  const message=error.stage==='content'?'请检查网络后重试。你也可以直接访问控制台。':error.stage==='module'?'页面资源未能加载。请重新加载，或尝试更新浏览器。':'页面未能正常启动。请更新浏览器后重试，或使用其他浏览器打开。';
  console.error('Shiny portal failed to load',error.cause||error);
  document.getElementById('main').innerHTML='<div class="container loading"><h1 style="font-size:28px">内容暂时无法加载</h1><p>'+message+'</p><button class="btn" id="portal-retry">重新加载</button> <a class="btn" href="/dashboard">前往控制台</a></div>';
  document.getElementById('portal-retry').addEventListener('click',()=>location.reload());
});
