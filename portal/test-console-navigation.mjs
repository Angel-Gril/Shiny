// Portal-to-console links must load New API in the current tab, not the portal router.
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
const release='console-nav-fixture-'+process.pid+'-'+Date.now();
const build=resolve(root,'build',release),site=resolve(build,'site');
execFileSync(process.env.PYTHON||'python',[resolve(root,'build.py'),'--release',release],{stdio:'pipe'});
const content=JSON.parse(await readFile(resolve(root,'backend/seed.json'),'utf8'));
const server=http.createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://fixture.invalid').pathname;
  if(path==='/portal-api/content'||path==='/api/notice'){
   res.writeHead(200,{'Content-Type':'application/json'});
   res.end(JSON.stringify(path==='/api/notice'?{success:true,data:''}:content));return;
  }
  if(path==='/dashboard'){
   res.writeHead(302,{Location:'/dashboard/overview'});res.end();return;
  }
  if(path==='/dashboard/overview'||path==='/sign-up'||path==='/sign-in'){
   res.writeHead(200,{'Content-Type':'text/html'});
   res.end('<!doctype html><title>New API fixture</title><main data-console-page>'+path+'</main>');return;
  }
  const file=path.startsWith('/shiny-home-assets/')?resolve(site,'.'+path):resolve(site,'index.html');
  assert.ok(file.startsWith(site+sep));
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':mime});res.end(await readFile(file));
 }catch(error){res.writeHead(500);res.end('Fixture request failed');console.error(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true});
const checks=[];
try{
 for(const width of [1440,390]){
  const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
  try{
   const page=await context.newPage();
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   for(const [selector,destination,label] of [
    ['#site-header a.btn-dark','/dashboard/overview','控制台'],
    ['.hero-buttons a.btn-primary','/sign-up','开始使用'],
    ['#site-header .login-link','/sign-in','登录'],
   ]){
    if(width<600&&label==='登录')continue; // The mobile header intentionally hides the login shortcut.
    for(const activation of ['click','Enter']){
     await page.goto(base+'/',{waitUntil:'domcontentloaded'});
     const anchor=page.locator(selector);await anchor.waitFor({state:'visible'});
     assert.notEqual(await anchor.getAttribute('target'),'_blank',label+' must not open a new tab');
     assert.equal(await anchor.getAttribute('data-route'),null,label+' must bypass the portal SPA router');
     const navigation=page.waitForURL(base+destination,{waitUntil:'domcontentloaded'});
     if(activation==='Enter'){await anchor.focus();await anchor.press('Enter');}
     else await anchor.click();
     await navigation;
     assert.equal(await page.locator('[data-console-page]').textContent(),destination);
     assert.equal(context.pages().length,1,label+' unexpectedly created another page');
     checks.push({width,label,activation,same_tab:true,full_navigation:true});
    }
   }
   await page.goto(base+'/',{waitUntil:'domcontentloaded'});
   await page.locator('#site-header a.btn-dark').waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.deepEqual(errors,[]);
  }finally{await context.close();}
 }
 console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{
 await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 assert.ok(build.startsWith(resolve(root,'build')+sep));await rm(build,{recursive:true,force:true});
}
