// File bytes go directly to R2. Only session metadata passes through the portal.
const MiB=1024*1024, SAMPLE_BYTES=64*1024, MAX_RETRIES=4;
const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const issue=(message,code,status)=>Object.assign(new Error(message),{code,...(status===undefined?{}:{status})});
const interrupted=signal=>issue(signal?.reason==='pause'?'上传已暂停，重新选择原文件后可继续':'上传已取消',signal?.reason==='pause'?'UPLOAD_PAUSED':'UPLOAD_CANCELLED');
function checkSignal(signal){if(signal?.aborted)throw interrupted(signal);}
const hex=buffer=>Array.from(new Uint8Array(buffer),value=>value.toString(16).padStart(2,'0')).join('');
async function digest(blob,signal){
  checkSignal(signal);
  if(!globalThis.crypto?.subtle)throw issue('文件校验需要 HTTPS 安全连接，请使用本站 HTTPS 管理页面','SECURE_CONTEXT_REQUIRED');
  const buffer=await blob.arrayBuffer();checkSignal(signal);
  const result=hex(await crypto.subtle.digest('SHA-256',buffer));checkSignal(signal);return result;
}

// Fast file selection check; full hashes of every completed part are also checked on resume.
export async function fingerprintFile(file,signal){
  const starts=[...new Set([0,Math.max(0,Math.floor((file.size-SAMPLE_BYTES)/2)),Math.max(0,file.size-SAMPLE_BYTES)])];
  const metadata=JSON.stringify([file.name,file.size,Number(file.lastModified)||0,starts])+'\n';
  return digest(new Blob([metadata,...starts.map(start=>file.slice(start,Math.min(file.size,start+SAMPLE_BYTES)))]),signal);
}

export function formatUploadLimit(maxFileMB=10240){
  const value=Number(maxFileMB)||10240;
  return value>=1024?`${Number((value/1024).toFixed(2))} GB`:`${value} MB`;
}

function wait(milliseconds,signal){
  checkSignal(signal);
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);reject(interrupted(signal));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},milliseconds);
    signal?.addEventListener('abort',cancel,{once:true});
  });
}

function putBlob(blob,signed,onBytes,signal){
  checkSignal(signal);
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest(),cancel=()=>xhr.abort();let settled=false;
    const finish=(error)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);
      if(error)reject(error);else resolve();
    };
    xhr.open('PUT',signed.uploadUrl);xhr.timeout=30*60*1000;
    for(const [key,value] of Object.entries(signed.headers||{}))xhr.setRequestHeader(key,value);
    xhr.upload.onprogress=event=>{if(event.lengthComputable)onBytes(Math.min(blob.size,event.loaded));};
    xhr.onload=()=>{
      if(xhr.status>=200&&xhr.status<300){onBytes(blob.size);finish();}
      else finish(issue('R2 上传被拒绝（HTTP '+xhr.status+'），请检查网络、桶的 CORS 策略和密钥权限','R2_UPLOAD_HTTP',xhr.status));
    };
    xhr.onerror=()=>finish(issue('浏览器未能连接 R2。已上传分片会保留，请检查网络或桶的 CORS 后重试。','R2_UPLOAD_NETWORK',0));
    xhr.onabort=()=>finish(interrupted(signal));
    xhr.ontimeout=()=>finish(issue('R2 上传超时，已上传分片会保留，请重试','R2_UPLOAD_TIMEOUT',408));
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted){finish(interrupted(signal));return;}
    try{xhr.send(blob);}catch(error){finish(error);}
  });
}

const retryable=error=>error?.status===undefined||[0,408,425,429].includes(error.status)||error.status>=500||(error.code==='R2_UPLOAD_HTTP'&&error.status===403);
async function withRetry(task,signal,onRetry){
  for(let attempt=0;;attempt++){
    checkSignal(signal);
    try{return await task();}catch(error){
      checkSignal(signal);
      if(attempt>=MAX_RETRIES||!retryable(error))throw error;
      onRetry?.(attempt+1);await wait(Math.min(400*2**attempt,4000),signal);
    }
  }
}

function sessionDescriptor(job,file,fingerprint){
  // Do not expose signed URLs, S3 upload IDs or credentials to queue persistence.
  const descriptor={id:job.id,mode:job.mode||'single',name:file.name,size:file.size,lastModified:Number(file.lastModified)||0,fingerprint};
  for(const key of ['partSize','createdAt','expiresAt','state'])if(job[key]!==undefined)descriptor[key]=job[key];
  return descriptor;
}

async function multipart(file,job,api,onProgress,signal,onStatus){
  const partSize=job.partSize;
  if(!Number.isInteger(partSize)||partSize!==32*MiB)throw issue('上传分片配置不受支持，请刷新后重试','INVALID_UPLOAD_SESSION');
  const count=Math.ceil(file.size/partSize),confirmed=new Map(),inFlight=new Map();
  const progress=()=>onProgress(Math.min(99,Math.floor((Array.from(confirmed.values()).reduce((a,b)=>a+b,0)+Array.from(inFlight.values()).reduce((a,b)=>a+b,0))/file.size*100)));
  const existing=job.parts||[];
  if(!Array.isArray(existing))throw issue('上传会话分片数据异常，请刷新后重试','INVALID_UPLOAD_SESSION');
  // Verify all existing bytes before uploading anything, including unsampled file regions.
  for(const part of existing){
    checkSignal(signal);
    const number=part.partNumber,start=(number-1)*partSize,size=Math.min(partSize,file.size-start);
    if(!Number.isInteger(number)||number<1||number>count||confirmed.has(number)||part.size!==size||!/^[a-f0-9]{64}$/.test(part.sha256||''))throw issue('已上传分片信息不完整，请重新上传此文件','INVALID_UPLOAD_SESSION');
    onStatus('verifying',{partNumber:number,partsTotal:count});
    const sha256=await digest(file.slice(start,start+size),signal);
    if(sha256!==part.sha256)throw issue('所选文件内容与已上传分片不同。请重新选择原文件，不能将不同版本混合续传。','FILE_MISMATCH');
    confirmed.set(number,size);progress();
  }
  onStatus('uploading',{partsTotal:count,completedParts:confirmed.size});
  const controller=new AbortController(),forward=()=>controller.abort(signal?.reason);
  signal?.addEventListener('abort',forward,{once:true});if(signal?.aborted)forward();
  let next=1,firstError;
  async function worker(){
    try{
      for(;;){
        checkSignal(controller.signal);
        const number=next++;if(number>count)return;if(confirmed.has(number))continue;
        const start=(number-1)*partSize,blob=file.slice(start,Math.min(file.size,start+partSize));
        const sha256=await digest(blob,controller.signal);
        await withRetry(async()=>{
          checkSignal(controller.signal);inFlight.set(number,0);progress();
          // Every attempt gets a fresh signature, including expired URL retries.
          const signed=(await api('r2/uploads/'+job.id+'/parts',json({partNumber:number,sha256}))).data;
          checkSignal(controller.signal);
          await putBlob(blob,signed,bytes=>{inFlight.set(number,bytes);progress();},controller.signal);
          inFlight.delete(number);confirmed.set(number,blob.size);progress();
          onStatus('uploading',{partNumber:number,partsTotal:count,completedParts:confirmed.size});
        },controller.signal,retry=>{
          inFlight.delete(number);progress();onStatus('retrying',{partNumber:number,retry,maxRetries:MAX_RETRIES});
        });
      }
    }catch(error){if(!firstError)firstError=error;controller.abort('peer-failed');}
  }
  try{
    await Promise.all(Array.from({length:Math.min(2,count)},worker));
    if(firstError)throw firstError;checkSignal(signal);
    onStatus('verifying',{completing:true,partsTotal:count});
    // Completion is idempotent. If its response is lost, retry without uploading bytes again.
    return (await withRetry(()=>api('r2/uploads/'+job.id+'/complete',json({})),signal,retry=>onStatus('retrying',{completing:true,retry,maxRetries:MAX_RETRIES}))).data;
  }finally{signal?.removeEventListener('abort',forward);}
}

export async function uploadR2(file,api,onProgress=()=>{},signal,options={}){
  const onStatus=options.onStatus||(()=>{});let job;
  checkSignal(signal);onStatus('verifying',{fingerprint:true});
  const fingerprint=await fingerprintFile(file,signal);
  try{
    if(options.sessionId){
      job=(await api('r2/uploads/'+encodeURIComponent(options.sessionId))).data;
      if(job.name!==file.name||job.size!==file.size||Number(job.lastModified)!==(Number(file.lastModified)||0)||job.fingerprint!==fingerprint)throw issue('所选文件与原上传任务不一致，请选择相同名称、大小和修改时间的原文件','FILE_MISMATCH');
      if(job.mode!=='multipart')throw issue('此上传任务不支持续传，请重新选择文件上传','INVALID_UPLOAD_SESSION');
    }else{
      job=(await api('r2/uploads',json({name:file.name,size:file.size,protocol:2,fingerprint,lastModified:Number(file.lastModified)||0}))).data;
    }
    options.onSession?.(sessionDescriptor(job,file,fingerprint));
    if(job.state==='complete'&&job.file){onProgress(100);return job.file;}
    if(['expired','missing','aborted'].includes(job.state))throw issue(job.message||'此上传会话已失效，请取消后重新上传',job.state==='expired'?'UPLOAD_EXPIRED':'UPLOAD_UNAVAILABLE');
    checkSignal(signal);
    let result;
    if(job.mode==='multipart')result=await multipart(file,job,api,onProgress,signal,onStatus);
    else{
      onStatus('uploading',{});
      await putBlob(file,job,bytes=>onProgress(Math.min(99,Math.round(bytes/file.size*100))),signal);
      checkSignal(signal);onStatus('verifying',{completing:true});
      result=(await withRetry(()=>api('r2/uploads/'+job.id+'/complete',json({})),signal,retry=>onStatus('retrying',{completing:true,retry,maxRetries:MAX_RETRIES}))).data;
    }
    onProgress(100);return result;
  }catch(error){
    if(signal?.aborted){
      // Multipart pause keeps the server session. Single PUT has no resumable parts.
      if(job&&!(signal.reason==='pause'&&job.mode==='multipart')){
        try{await api('r2/uploads/'+job.id+'/abort',json({}));}catch(cleanup){
          if(cleanup.status!==409)throw issue('上传已停止，但清理未完成；可在未完成上传列表再次取消','UPLOAD_CLEANUP_FAILED',cleanup.status);
        }
      }
      throw interrupted(signal);
    }
    // Preserve multipart sessions on network/validation failure for safe manual retry.
    if(job&&job.mode!=='multipart'){
      try{await api('r2/uploads/'+job.id+'/abort',json({}));}catch(cleanup){if(cleanup.status!==409)error.message+='；未完成文件可能需要在 R2 中清理';}
    }
    throw error;
  }
}
