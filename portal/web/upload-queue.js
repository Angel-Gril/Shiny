const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function inferPackage(name){
  const lower=name.toLowerCase();let platform='通用',architecture='';
  if(/(?:windows|win32|win64|[-_]win[-_.]|\.(exe|msi|msix)$)/.test(lower))platform='Windows';
  else if(/(?:macos|mac[-_.]|darwin|osx|\.(dmg|pkg)$)/.test(lower))platform='macOS';
  else if(/(?:linux|\.(deb|rpm|appimage)$)/.test(lower))platform='Linux';
  if(/(?:aarch64|arm64)/.test(lower))architecture='ARM64';
  else if(/(?:amd64|x86_64|x64|win64)/.test(lower))architecture='x64';
  else if(/(?:i386|i686|x86(?!_64)|win32)/.test(lower))architecture='x86';
  return {platform,architecture};
}
export function createQueue(files){
  return Array.from(files,file=>({id:crypto.randomUUID(),file,...inferPackage(file.name),status:'pending',progress:0,error:'',result:null}));
}
const labels={pending:'等待上传',uploading:'正在上传',verifying:'校验续传文件',retrying:'正在重试分片',paused:'已暂停',waiting_file:'请选择原文件',complete:'已上传',error:'上传失败，可重试',cancelled:'已取消'};
export function queueHTML(queue,uploading=false){
  if(!queue.length)return '';
  return `<div class="upload-queue"><p>${queue.length} 个文件；每个文件将生成独立资源条目。大文件暂停或断网后可继续上传。</p>${queue.map(item=>`<div class="upload-queue-row"><div class="upload-queue-file"><strong>${escape(item.file.name)}</strong><small>${item.file.size>=1024**3?(item.file.size/1024**3).toFixed(2)+' GB':(item.file.size/1024/1024).toFixed(1)+' MB'} · ${labels[item.status]||''}${['uploading','verifying','retrying','paused'].includes(item.status)?' '+item.progress+'%':''}</small><progress max="100" value="${item.progress}" aria-label="${escape(item.file.name)} 上传进度"></progress>${item.error?`<span class="upload-queue-error">${escape(item.error)}</span>`:''}</div><label><span>系统</span><select data-file-platform="${item.id}" ${uploading?'disabled':''}>${['通用','Windows','macOS','Linux'].map(p=>`<option ${p===item.platform?'selected':''}>${p}</option>`).join('')}</select></label><label><span>架构</span><input data-file-architecture="${item.id}" value="${escape(item.architecture)}" maxlength="80" placeholder="x64 / ARM64" ${uploading?'disabled':''}></label><button type="button" class="link-button link-danger" data-remove-upload="${item.id}" ${uploading?'disabled':''}>${item.sessionId&&!item.result?'取消并清理':'移除'}</button></div>`).join('')}</div>`;
}
export async function processQueue(queue,upload,onUpdate,signal,concurrency=2){
  let next=0;
  async function worker(){
    while(next<queue.length){
      const item=queue[next++];if(item.result)continue;
      if(signal?.aborted){item.status=signal.reason==='pause'?'paused':'cancelled';item.error=signal.reason==='pause'?'已保留进度，点击保存资源草稿继续':'尚未开始，已取消';onUpdate();continue;}
      item.status='uploading';item.progress=0;item.error='';onUpdate();
      try{
        item.result=await upload(item.file,percent=>{item.progress=percent;onUpdate()},signal,item);
        item.status='complete';item.progress=100;
      }catch(error){item.status=error.code==='UPLOAD_PAUSED'||signal?.reason==='pause'?'paused':signal?.aborted?'cancelled':'error';item.error=error.message||'上传失败';}
      onUpdate();
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,queue.length)},worker));
  return {complete:queue.filter(item=>item.result).length,failed:queue.filter(item=>!item.result).length};
}
