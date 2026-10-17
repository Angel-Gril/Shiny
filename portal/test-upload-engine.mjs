// Standalone browser engine tests with a real local HTTP object-store fixture.
// No credentials, production APIs or large generated files on disk are used.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/550W/.codex/skills/gstack-main/node_modules/playwright');
const source=await readFile(new URL('./web/multipart.js',import.meta.url),'utf8');
const MiB=1024*1024,PART=32*MiB,sessions=new Map(),checks=[];
let identifier=0,active=0,maximumActive=0;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function answer(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
async function bytes(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return Buffer.concat(chunks);}
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Multipart fixture</title>');return;}
    if(url.pathname==='/multipart.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(source);return;}
    if(url.pathname.startsWith('/object/')){
      const [, ,id,part,attempt]=url.pathname.split('/'),job=sessions.get(id),number=Number(part),tryNumber=Number(attempt);
      job.puts.push({number,attempt:tryNumber});
      if(job.name.startsWith('fail-')||(job.name.startsWith('retry-')&&number===1&&tryNumber===1)){
        req.resume();answer(res,job.name.startsWith('retry-')?403:503,{message:'Fixture transient upload failure'});return;
      }
      active++;maximumActive=Math.max(maximumActive,active);
      try{
        const body=await bytes(req);
        if(job.mode==='multipart')assert.equal(hash(body),job.hashes.get(number));
        job.parts.set(number,{partNumber:number,size:body.length,etag:'fixture-'+number,sha256:hash(body),body});
        if(job.mode==='multipart')await new Promise(r=>setTimeout(r,600));
        if(job.name.startsWith('pause-')&&number===2)await new Promise(r=>setTimeout(r,180));
        if(!res.destroyed){res.writeHead(200,{ETag:'fixture-'+number});res.end();}
      }finally{active--;}
      return;
    }
    if(!url.pathname.startsWith('/control/r2/uploads')){answer(res,404,{});return;}
    const segments=url.pathname.slice('/control/'.length).split('/'),id=segments[2],action=segments[3];
    if(req.method==='POST'&&!id){
      const payload=JSON.parse((await bytes(req)).toString());assert.equal(payload.protocol,2);assert.match(payload.fingerprint,/^[a-f0-9]{64}$/);
      const id=String(++identifier),mode=payload.size>64*MiB?'multipart':'single';
      const job={...payload,id,mode,partSize:PART,parts:new Map(),hashes:new Map(),attempts:new Map(),puts:[],aborts:0,state:'pending',completeCalls:0};sessions.set(id,job);
      const data=describe(job);if(mode==='single'){data.uploadUrl=origin+'/object/'+id+'/1/1';data.headers={'Content-Type':'application/octet-stream'};}
      answer(res,200,{data});return;
    }
    const job=sessions.get(id);assert.ok(job,'Known session');
    if(req.method==='GET'){answer(res,200,{data:describe(job)});return;}
    const body=JSON.parse((await bytes(req)).toString()||'{}');
    if(action==='parts'){
      if(job.hashes.has(body.partNumber))assert.equal(job.hashes.get(body.partNumber),body.sha256);
      job.hashes.set(body.partNumber,body.sha256);const attempt=(job.attempts.get(body.partNumber)||0)+1;job.attempts.set(body.partNumber,attempt);
      answer(res,200,{data:{uploadUrl:origin+'/object/'+id+'/'+body.partNumber+'/'+attempt,headers:{},expiresIn:900}});return;
    }
    if(action==='complete'){
      job.completeCalls++;const count=job.mode==='multipart'?Math.ceil(job.size/PART):1;
      assert.equal(job.parts.size,count);const combined=Buffer.concat([...job.parts.values()].sort((a,b)=>a.partNumber-b.partNumber).map(p=>p.body));assert.equal(combined.length,job.size);
      job.file={id:job.id,name:job.name,size:job.size,url:origin+'/download/'+job.id,sha256:hash(combined)};job.state='complete';
      if(job.name.startsWith('retry-')&&job.completeCalls===1){answer(res,503,{message:'Fixture lost completion response'});return;}
      answer(res,200,{data:job.file});return;
    }
    if(action==='abort'){job.aborts++;if(job.state==='complete'){answer(res,409,{message:'Already completed'});return;}job.state='aborted';job.parts.clear();answer(res,200,{data:{}});return;}
    answer(res,404,{});
  }catch(error){answer(res,500,{message:error.message});}
});
function describe(job){return {id:job.id,mode:job.mode,name:job.name,size:job.size,fingerprint:job.fingerprint,lastModified:job.lastModified,partSize:PART,state:job.state,parts:[...job.parts.values()].map(({body,...part})=>part),...(job.file?{file:job.file}:{})};}
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true}),page=await browser.newPage();
try{
  await page.goto(origin);
  await page.evaluate(async()=>{
    window.engine=await import('/multipart.js');
    window.api=async(path,options={})=>{
      const response=await fetch('/control/'+path,options),body=await response.json();
      if(!response.ok)throw Object.assign(new Error(body.message),{status:response.status});return body;
    };
    window.makeFile=(name,size=70*1024*1024,changed=false)=>{
      const data=new Uint8Array(size);for(let i=0;i<size;i++)data[i]=i%251;if(changed)data[8*1024*1024]^=255;
      return new File([data],name,{type:'application/octet-stream',lastModified:1700000000000});
    };
  });
  const tiny=await page.evaluate(async()=>{
    const file=makeFile('small.zip',1024),sessions=[],progress=[];
    const result=await engine.uploadR2(file,api,n=>progress.push(n),null,{onSession:job=>sessions.push(job)});
    return {result,sessions,progress,limit:engine.formatUploadLimit(10240)};
  });
  assert.equal(tiny.sessions[0].mode,'single');assert.ok(!('uploadUrl' in tiny.sessions[0]));assert.equal(tiny.progress.at(-1),100);assert.equal(tiny.limit,'10 GB');checks.push('Small files retain single PUT; protocol 2 and sanitized session callback');

  const retry=await page.evaluate(async()=>{
    const file=makeFile('retry-client.zip'),statuses=[],progress=[];let session;
    const result=await engine.uploadR2(file,api,n=>progress.push(n),null,{onSession:job=>session=job,onStatus:(status,detail)=>statuses.push({status,...detail})});
    return {result,session,statuses,progress,expected:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('')};
  });
  assert.equal(retry.result.sha256,retry.expected);assert.equal(retry.progress.at(-1),100);assert.ok(retry.progress.every(n=>n>=0&&n<=100));
  const retryJob=sessions.get(retry.session.id);assert.equal(retryJob.attempts.get(1),2);assert.equal(retryJob.completeCalls,2);assert.equal(retryJob.aborts,0);assert.ok(retry.statuses.some(s=>s.status==='retrying'));assert.equal(retryJob.parts.size,3);assert.equal(maximumActive,2);checks.push('70 MiB uses three real HTTP parts, two concurrent uploads, refreshed signature retry and idempotent completion');

  const paused=await page.evaluate(async()=>{
    const controller=new AbortController();let session;
    try{
      await engine.uploadR2(makeFile('pause-client.zip'),api,()=>{},controller.signal,{onSession:job=>session=job,onStatus:(status,info)=>{if(status==='uploading'&&info.completedParts>=1)controller.abort('pause');}});
      return {unexpected:true};
    }catch(error){return {session,code:error.code};}
  });
  assert.equal(paused.code,'UPLOAD_PAUSED');const pauseJob=sessions.get(paused.session.id);assert.equal(pauseJob.aborts,0);assert.ok(pauseJob.parts.size>=1);checks.push('Pause aborts active transports and preserves remote completed parts');
  // Wait for any accepted upload whose success response was interrupted.
  await new Promise(r=>setTimeout(r,250));
  const mismatched=await page.evaluate(async sessionId=>{
    const file=makeFile('pause-client.zip',70*1024*1024,true);
    const initialFingerprint=await engine.fingerprintFile(makeFile('pause-client.zip'));
    const changedFingerprint=await engine.fingerprintFile(file);
    try{await engine.uploadR2(file,api,()=>{},null,{sessionId});return {unexpected:true};}
    catch(error){return {code:error.code,sameSamples:initialFingerprint===changedFingerprint};}
  },paused.session.id);
  assert.equal(mismatched.code,'FILE_MISMATCH');assert.equal(mismatched.sameSamples,true);assert.equal(pauseJob.aborts,0);checks.push('Resume rehash rejects unsampled changed bytes despite identical metadata and sample fingerprint');
  const beforePuts=pauseJob.puts.length,priorParts=new Set(pauseJob.parts.keys());
  const resumed=await page.evaluate(async sessionId=>{
    const progress=[];const result=await engine.uploadR2(makeFile('pause-client.zip'),api,n=>progress.push(n),null,{sessionId});return {result,progress};
  },paused.session.id);
  assert.equal(resumed.progress.at(-1),100);assert.equal(resumed.result.size,70*MiB);assert.ok(pauseJob.puts.slice(beforePuts).every(p=>!priorParts.has(p.number)));assert.equal(pauseJob.aborts,0);checks.push('A new call after refresh/reselection verifies and skips accepted parts, then completes');

  const cancel=await page.evaluate(async()=>{
    const controller=new AbortController();let id;
    try{await engine.uploadR2(makeFile('cancel-client.zip'),api,()=>{},controller.signal,{onSession:job=>{id=job.id;controller.abort('cancel');}});return {unexpected:true};}
    catch(error){return {id,code:error.code};}
  });
  assert.equal(cancel.code,'UPLOAD_CANCELLED');assert.equal(sessions.get(cancel.id).aborts,1);assert.equal(sessions.get(cancel.id).state,'aborted');checks.push('Explicit cancellation calls remote AbortMultipartUpload');

  const failed=await page.evaluate(async()=>{
    let id;try{await engine.uploadR2(makeFile('fail-client.zip'),api,()=>{},null,{onSession:job=>id=job.id});return {unexpected:true};}
    catch(error){return {id,status:error.status};}
  });
  const failedJob=sessions.get(failed.id);assert.equal(failed.status,503);assert.ok([...failedJob.attempts.values()].every(n=>n<=5));assert.ok([...failedJob.attempts.values()].some(n=>n===5));assert.equal(failedJob.aborts,0);assert.equal(failedJob.completeCalls,0);checks.push('At most four retries per part; persistent transport errors preserve session and never complete');
  const alreadyCompleted=await page.evaluate(async id=>{
    let calls=0;const tracked=async(...args)=>{calls++;return api(...args);};
    const result=await engine.uploadR2(makeFile('retry-client.zip'),tracked,()=>{},null,{sessionId:id});return {calls,result};
  },retry.session.id);
  assert.equal(alreadyCompleted.calls,1);assert.equal(alreadyCompleted.result.sha256,retry.result.sha256);checks.push('Completed session recovery returns its existing object without new PUT or abort');
  console.log(JSON.stringify({passed:checks.length,checks},null,2));
}finally{
  await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
