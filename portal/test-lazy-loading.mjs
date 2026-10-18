// Real built pages and modules, with synthetic APIs and an R2 PUT endpoint.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,rm} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const root=fileURLToPath(new URL('.',import.meta.url));
const release='lazy-fixture-'+process.pid+'-'+Date.now(),build=resolve(root,'build',release),site=resolve(build,'site');
execFileSync(process.env.PYTHON||'python',[resolve(root,'build.py'),'--release',release],{stdio:'pipe'});
const content=JSON.parse(await readFile(resolve(root,'backend/seed.json'),'utf8'));
const article={...content.articles[0],title:'Fixture guide',slug:'quickstart',source_path:'guides/start.md',body_markdown:'# Fixture guide\n\nBodyOnlyKeyword for search.\n\n## Steps\n\n[Next guide](../next.md)\n\n<script>window.fixtureXss=true</script><img src="x" onerror="window.fixtureXss=true">',format_version:2};
content.articles=[article,{...content.articles[1],title:'Next guide',slug:'next',source_path:'next.md',body_markdown:'# Next guide\n\nNext document body.',format_version:2}];
let draft=structuredClone(content),requests=[],uploads=0,batches=0,lastBatch,r2Enabled=false,r2Job,r2Puts=[],appGate=null,markdownGate=null,markdownError=false,contentError=false,contentSeen,markdownSeen;
const r2FileURL='https://fixture-r2.invalid/downloads/client-r2.zip';
function gate(){let release;const promise=new Promise(r=>release=r);return {promise,release};}
async function waitForGate(event,message){
 let timer;
 try{await Promise.race([event.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),10000);})]);}
 finally{clearTimeout(timer);}
}
function answer(res,status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}
const server=http.createServer(async(req,res)=>{
 try{
  const p=new URL(req.url,'http://fixture.invalid').pathname;requests.push(p);
  if(p==='/portal-api/content'){contentSeen?.release();answer(res,contentError?503:200,contentError?{}:content);return;}
  if(p==='/api/user/auth/refresh'){answer(res,200,{success:true,data:{access_token:'fixture-only',access_expires_at:Date.now()/1000+3600}});return;}
  if(p==='/portal-api/admin/session'){answer(res,200,{success:true,data:{id:7,name:'fixture-admin'}});return;}
  if(p==='/portal-api/admin/content'){answer(res,200,{success:true,data:{draft,published:content,revision:1,history:[]}});return;}
  if(p==='/portal-api/admin/storage'){answer(res,200,{success:true,data:{enabled:r2Enabled,revision:0,hasCredentials:r2Enabled,maxFileMB:10240,extensions:r2Enabled?['.zip']:[],cors:[]}});return;}
  if(p==='/portal-api/admin/r2/uploads/completed'||p==='/portal-api/admin/r2/uploads/pending'){answer(res,200,{success:true,data:[]});return;}
  if(p==='/portal-api/admin/r2/uploads'){
   assert.equal(req.method,'POST');let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);
   assert.equal(payload.protocol,2);assert.match(payload.fingerprint,/^[a-f0-9]{64}$/);
   r2Job={id:'fixture-r2',mode:'single',state:'uploading',name:payload.name,size:payload.size,uploadUrl:base+'/object/fixture-r2.zip',headers:{'Content-Type':'application/zip','X-Fixture-Upload':'fixture-only'}};
   answer(res,200,{success:true,data:r2Job});return;
  }
  if(p==='/object/fixture-r2.zip'){
   assert.equal(req.method,'PUT');assert.equal(req.headers['x-fixture-upload'],'fixture-only');assert.equal(req.headers['content-type'],'application/zip');
   const chunks=[];for await(const chunk of req)chunks.push(chunk);r2Puts.push(Buffer.concat(chunks));
   res.writeHead(200);res.end();return;
  }
  if(p==='/portal-api/admin/r2/uploads/fixture-r2/complete'){
   assert.equal(req.method,'POST');assert.equal(r2Puts.length,1);assert.equal(r2Puts[0].length,r2Job.size);
   answer(res,200,{success:true,data:{id:'fixture-r2-file',name:r2Job.name,url:r2FileURL,size:r2Job.size,storage:'r2'}});return;
  }
  if(p==='/portal-api/admin/upload'){
   for await(const chunk of req){}uploads++;
   answer(res,200,{success:true,data:{id:'fixture-'+uploads,name:'fixture.zip',url:'/portal-api/files/fixture-'+uploads+'.zip',size:12,sha256:'a'.repeat(64)}});return;
  }
  if(p==='/portal-api/admin/resources/batch'){
   let raw='';for await(const chunk of req)raw+=chunk;const payload=JSON.parse(raw);lastBatch=payload;batches++;
   draft.resources.push(...payload.changes.map(x=>x.resource));answer(res,200,{success:true,data:{draft,published:content,revision:2,history:[]}});return;
  }
  if(p.endsWith('/app.js')&&appGate)await appGate.promise;
  if(p.endsWith('/markdown.js')){
   markdownSeen?.release();if(markdownGate)await markdownGate.promise;
   if(markdownError){res.writeHead(503);res.end('fixture module failure');return;}
  }
  const file=p.startsWith('/shiny-home-assets/')?resolve(site,'.'+p):resolve(site,'index.html');
  assert.ok(file.startsWith(site+sep));
  const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':mime});res.end(await readFile(file));
 }catch(error){answer(res,500,{error:'Fixture request failed'});console.error(error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true}),checks=[],errors=[];
let context;
async function fresh(path='/'){
 await context?.close();context=await browser.newContext();const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));requests=[];
 await page.goto(base+path,{waitUntil:'commit'});return page;
}
const optional=p=>/\/(markdown|storage|upload-queue|multipart)\.js$|\/vendor\//.test(p);
try{
 appGate=gate();contentSeen=gate();let page=await fresh();
 await waitForGate(contentSeen,'Content waited for application download');
 appGate.release();appGate=null;await page.locator('.hero h1').waitFor();
 assert.equal(requests.filter(p=>p==='/portal-api/content').length,1);assert.equal(requests.some(optional),false);
 checks.push('Public content starts before the application finishes; homepage fetches no optional modules');

 markdownGate=gate();markdownSeen=gate();
 await page.locator('#main-nav a[href="/docs/"]').click();await waitForGate(markdownSeen,'Document navigation did not request Markdown');
 assert.match(await page.locator('#main').innerText(),/正在加载文档/);
 await page.locator('#site-header a[href="/"]').first().click();await page.locator('.hero h1').waitFor();
 markdownGate.release();markdownGate=null;await page.waitForLoadState('networkidle');assert.ok(await page.locator('.hero h1').count());
 checks.push('A delayed document module cannot overwrite a later navigation back home');
 await page.locator('#main-nav a[href="/docs/"]').click();await page.locator('a[href="/docs/quickstart"]').first().click();
 await page.locator('.markdown-body').getByText('BodyOnlyKeyword for search.',{exact:true}).waitFor();
 assert.equal(await page.locator('.markdown-body a').first().getAttribute('href'),'/docs/next');
 assert.equal(await page.evaluate(()=>window.fixtureXss),undefined);assert.equal(await page.locator('.markdown-body script,.markdown-body [onerror]').count(),0);
 checks.push('On-demand Markdown preserves relative document links and HTML sanitization');

 page=await fresh();await page.locator('.hero h1').waitFor();assert.equal(requests.some(optional),false);
 await page.locator('.search-trigger').click();await page.locator('#global-search').fill('BodyOnlyKeyword');await page.locator('#search-results a[href="/docs/quickstart"]').waitFor();
 assert.equal(requests.some(p=>/\/(storage|upload-queue|multipart)\.js$/.test(p)),false);
 checks.push('Search lazily loads Markdown and still finds body-only text without upload modules');

 page=await fresh('/site-admin/?tab=resources');await page.locator('#resource-upload').waitFor({state:'attached'});
 assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('paper-portal')),false,'Public paper skin leaked into administration');
 assert.ok(requests.some(p=>p.endsWith('/multipart.js')));assert.ok(requests.some(p=>p.endsWith('/upload-queue.js')));
 await page.locator('#resource-upload').setInputFiles([{name:'client-windows-x64.zip',mimeType:'application/zip',buffer:Buffer.from('fixture-win')},{name:'client-macos-arm64.zip',mimeType:'application/zip',buffer:Buffer.from('fixture-mac')}]);
 assert.equal(await page.locator('.upload-queue-row').count(),2);
 await page.locator('#resource-form [name=name]').fill('Fixture client');await page.locator('#resource-form [name=version]').fill('v1');await page.locator('#resource-form [name=summary]').fill('Fixture upload');
 await page.locator('#resource-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('2 个文件'));
 assert.equal(uploads,2);assert.equal(batches,1);
 checks.push('Admin-only modules support multi-file upload and a single resource batch save');
 await page.locator('#site-header a[href="/"]').first().click();await page.locator('.hero h1').waitFor();
 assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('paper-portal')),true);
 await page.locator('#site-footer a[href="/site-admin/"]').click();await page.locator('.admin-layout').waitFor();
 assert.equal(await page.locator('body').evaluate(node=>node.classList.contains('paper-portal')),false,'Public/admin navigation retained the wrong visual scope');

 r2Enabled=true;const localUploadsBeforeR2=uploads,batchesBeforeR2=batches,r2Bytes=Buffer.from('fixture-r2-data');
 page=await fresh('/site-admin/?tab=resources');await page.locator('#resource-upload').waitFor({state:'attached'});
 assert.equal(await page.locator('#upload-target').inputValue(),'r2');
 await page.locator('#resource-upload').setInputFiles({name:'client-r2.zip',mimeType:'application/zip',buffer:r2Bytes});
 await page.locator('#resource-form [name=name]').fill('Fixture R2 client');await page.locator('#resource-form [name=version]').fill('v1');await page.locator('#resource-form [name=summary]').fill('Fixture direct upload');
 await page.locator('#resource-form button[type=submit]').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('1 个文件'));
 assert.equal(uploads,localUploadsBeforeR2);assert.equal(r2Puts.length,1);assert.deepEqual(r2Puts[0],r2Bytes);assert.equal(r2Job.name,'client-r2.zip');
 assert.equal(batches,batchesBeforeR2+1);assert.equal(lastBatch.changes.length,1);assert.equal(lastBatch.changes[0].resource.url,r2FileURL);assert.equal(lastBatch.changes[0].resource.storage,'r2');
 checks.push('Lazy R2 upload sends file bytes to the signed PUT endpoint and saves its stable resource URL without a local upload');

 markdownError=true;page=await fresh('/docs/quickstart');await page.getByRole('heading',{name:'文档暂时无法加载'}).waitFor();assert.ok(await page.locator('#main-nav').isVisible());
 markdownError=false;await page.getByRole('button',{name:'重新加载',exact:true}).click();await page.locator('.markdown-body').waitFor();
 checks.push('Document module errors retain navigation and a working reload recovery');

 contentError=true;page=await fresh();await page.getByRole('heading',{name:'内容暂时无法加载'}).waitFor();contentError=false;
 await page.locator('#portal-retry').click();await page.locator('.hero h1').waitFor();
 checks.push('Public content failure has a working reload recovery');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);checks.push('Homepage remains usable on mobile; no uncaught browser errors');
 console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{
 appGate?.release();markdownGate?.release();await context?.close();await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));
 assert.ok(build.startsWith(resolve(root,'build')+sep));await rm(build,{recursive:true,force:true});
}
