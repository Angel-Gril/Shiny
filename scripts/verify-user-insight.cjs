// Browser verification with synthetic support records; never contacts production.
// PLAYWRIGHT_PATH may point to an existing local Playwright installation.
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const base='http://127.0.0.1:18591',out=path.resolve('maintenance/user-insight-20261017');
const user={id:42,username:'member-42',display_name:'演示用户',email:'member@example.invalid',role:1,status:1,group:'default',remark:'退款前核对实付与赠金',created_at:1792000000,last_login_at:1792220000,inviter_id:2,inviter_username:'inviter',quota:1500000,used_quota:100000,request_count:6};
const viewer={id:1,username:'fixture-root',display_name:'Fixture Root',role:100,status:1,group:'default'};
const overview={user,stats:{successful_topups:1,redemptions:1,checkins:1,log_count:2,consume_count:1,refund_count:0},limitations:{wallet_provenance_complete:false,payment_currency_recorded:false}};
const items={topups:[{id:1,trade_no:'FIXTURE-PAID-ORDER',amount:10,credited_quota:5000000,money:10,payment_method:'alipay',payment_provider:'epay',create_time:1792200000,complete_time:1792200010,status:'success'}],redemptions:[{id:2,name:'活动额度',quota:500000,redeemed_time:1792200000}],checkins:[{id:3,checkin_date:'2026-10-17',quota_awarded:5000,created_at:1792200000}],logs:[{id:4,created_at:1792200000,type:4,content:'Registration gift: $3',model_name:'',quota:0,prompt_tokens:0,completion_tokens:0,use_time:0,is_stream:false,channel_id:0,token_name:'',request_id:'fixture-grant'},{id:5,created_at:1792220000,type:2,content:'',model_name:'example-model',quota:10000,prompt_tokens:1000,completion_tokens:50,use_time:3,is_stream:true,channel_id:9,token_name:'Fixture token',request_id:'fixture-request'}]};
(async()=>{
 fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),errors=[],checks=[],unknown=[];
 await context.addCookies([{name:'new_api_has_session',value:'1',url:base}]);await context.addInitScript(()=>localStorage.setItem('i18nextLng','zh'));
 page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error')console.error('Browser console:',message.text().slice(0,900));});
 await context.route(base+'/**',async route=>{
  const request=route.request(),url=new URL(request.url()),p=url.pathname;
  if(!p.startsWith('/api/')){if(request.resourceType()==='document')return route.fulfill({path:path.resolve('new-api/web/dist/index.html'),contentType:'text/html'});return route.continue();}
  const reply=data=>route.fulfill({json:{success:true,data}});
  if(p==='/api/status')return reply({version:'shiny-test',system_name:'Shiny',quota_per_unit:500000,usd_exchange_rate:7.3,display_in_currency:true,setup:true,password_login:true,logo:'/logo.png'});
  if(p==='/api/setup')return reply({status:true,root_init:true});
  if(p==='/api/notice')return reply('');
  if(p==='/api/user/auth/refresh')return reply({access_token:'fixture-session',access_expires_at:Date.now()/1000+3600,token_type:'Bearer',user:viewer,session:{sid:'fixture-sid',current:true,login_method:'password',ip:'127.0.0.1',user_agent:'fixture',created_at:1792200000,last_active_at:1792220000,expires_at:Date.now()/1000+3600}});
  if(p==='/api/user/self')return reply(viewer);
  if(p==='/api/group/')return reply(['default']);
  if(p==='/api/user/'||p==='/api/user/search')return reply({items:[user],total:1,p:1,page_size:20});
  if(p==='/api/user/42/insight'){const section=url.searchParams.get('section')||'overview';return reply(section==='overview'?overview:{items:items[section]||[],total:(items[section]||[]).length,p:1,page_size:10});}
  if(p==='/api/user/42')return reply(user);
  if(p==='/api/authz/catalog')return reply({resources:[],roles:[]});
  unknown.push(p);return reply([]);
 });
 try{
  await page.goto(base+'/users',{waitUntil:'domcontentloaded'});
  const trigger=page.getByText('member-42',{exact:true}).first();await trigger.waitFor({timeout:25000});await trigger.click({force:true});
  const dialog=page.getByRole('dialog');await dialog.getByText('member@example.invalid',{exact:true}).waitFor();assert.match(await dialog.innerText(),/退款|实付/);checks.push('User list opens unified details with refund-review context');
  const logsLink=dialog.getByRole('link').filter({hasText:/日志|Logs/}).first();assert.ok((await logsLink.getAttribute('href')).includes('username=member-42'));checks.push('Full-log link preserves exact user filter');
  await page.screenshot({path:path.join(out,'details-desktop.png'),fullPage:true,animations:'disabled'});
  await dialog.getByRole('tab',{name:/充值订单|Top-up orders/}).click();await dialog.getByText('FIXTURE-PAID-ORDER',{exact:true}).waitFor();assert.match(await dialog.innerText(),/币种.*未记录|Currency not recorded/);checks.push('Historical payments retain currency-unknown label');
  await dialog.getByRole('tab',{name:/签到/}).click();await dialog.getByText('2026-10-17',{exact:true}).waitFor();checks.push('Recorded check-in gifts visible separately');
  await dialog.getByRole('tab',{name:/额度日志|Usage and quota logs|消费/}).click();await dialog.getByText('Registration gift: $3',{exact:true}).waitFor();const grant=dialog.getByRole('row').filter({hasText:'Registration gift: $3'});assert.match(await grant.innerText(),/未记录|Not recorded/);checks.push('Grant without numeric quota is not shown as zero');
  const requestLink=dialog.getByRole('link',{name:'fixture-request',exact:true});assert.ok((await requestLink.getAttribute('href')).includes('requestId=fixture-request'));checks.push('Request ID opens full diagnostic log filter');
  await page.setViewportSize({width:390,height:844});
  // Responsive table swaps its row renderers; reopen from the mobile row.
  await page.getByText('member-42',{exact:true}).first().click();await dialog.getByText('member@example.invalid',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'details-mobile.png'),fullPage:true,animations:'disabled'});checks.push('Mobile user entry opens details without document overflow');
  assert.deepEqual(errors,[]);const result={passed:checks.length,checks,errors,unknownApi:unknown,syntheticDataOnly:true,productionModified:false};fs.writeFileSync(path.join(out,'browser.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(error){await page.screenshot({path:path.join(out,'error.png'),fullPage:true});console.error(JSON.stringify({url:page.url(),unknown,errors,cookies:(await context.cookies()).map(c=>c.name)}));console.error((await page.locator('body').innerText()).slice(0,1200));throw error;}
 finally{await context.close();await browser.close();}
})().catch(error=>{console.error(error.name,error.message.split('\n')[0]);process.exitCode=1});
