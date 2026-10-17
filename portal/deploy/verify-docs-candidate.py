"""Candidate-only writes, using the existing New API administrator session."""
import base64
import copy
import json
from pathlib import Path
import os
import runpy
import subprocess
import urllib.error
import urllib.request

base='http://127.0.0.1:18442';stage=Path(os.environ.get('PORTAL_STAGE','/root/shiny-maintenance/portal-docs-upgrade-20261016'))
fn=runpy.run_path('/root/shiny-maintenance/request-checks-turnstile-20261015/policy-admin.py')['admin_request']
original=urllib.request.urlopen;captured={}
def capture(req,*a,**kw):
    if isinstance(req,urllib.request.Request) and req.full_url.endswith('/api/option/request_policy'):captured['bearer']=req.get_header('Authorization')
    return original(req,*a,**kw)
urllib.request.urlopen=capture
try:fn('/api/option/request_policy')
finally:urllib.request.urlopen=original
bearer=captured['bearer']
def call(path,method='GET',body=None,raw=None,content_type=None,auth=True,modern=True):
    headers={'Origin':'https://shinyapi.com','X-Portal-Request':'1'}
    if auth:headers['Authorization']=bearer
    if modern:headers['X-Portal-Editor']='markdown-v2'
    if body is not None:raw=json.dumps(body,ensure_ascii=False).encode();content_type='application/json'
    if content_type:headers['Content-Type']=content_type
    req=urllib.request.Request(base+path,method=method,headers=headers,data=raw)
    try:
        with original(req,timeout=15) as res:
            data=res.read();return res.status,json.loads(data) if 'json' in res.headers.get('Content-Type','') else data
    except urllib.error.HTTPError as e:
        status=e.code;data=e.read();e.close();return status,data
checks=[]
def check(name,ok):
    if not ok:raise AssertionError(name)
    checks.append(name)

check('candidate health',call('/portal-api/health')[1]['editor_format']==2)
check('real New API administrator identity',call('/portal-api/admin/session')[0]==200)
check('anonymous administrator denied',call('/portal-api/admin/content',auth=False)[0]==401)
state=call('/portal-api/admin/content')[1]['data'];before=copy.deepcopy(state['draft']);rev=state['revision']
png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=')
boundary='ShinyDocsUpgradeCandidate'
payload=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="step.png"\r\nContent-Type: image/png\r\n\r\n').encode()+png+f'\r\n--{boundary}--\r\n'.encode()
status,result=call('/portal-api/admin/upload','POST',raw=payload,content_type='multipart/form-data; boundary='+boundary)
check('upload picture',status==200);file=result['data']
check('unpublished image private',call(file['url'],auth=False)[0]==404)
check('administrator image preview',call('/portal-api/admin/files/'+file['id'])[0]==200)
check('anonymous image preview denied',call('/portal-api/admin/files/'+file['id'],auth=False)[0]==401)
raw='# 文档升级候选验收\n\n## 配置\n\n| 参数 | 值 |\n| --- | --- |\n| model | test |\n\n```js\nconst ok = true;\n```\n\n```json\n{"ok":true}\n```\n\n![步骤]('+file['url']+')\n\n末尾原文保留\n'
data=copy.deepcopy(before);a=copy.deepcopy(data['articles'][0]);a.pop('sections');a.update(slug='docs-upgrade-qa',title='文档升级候选验收',format_version=2,body_markdown=raw,source_path='candidate/qa.md',featured=False);data['articles'].append(a)
check('old editor write refused',call('/portal-api/admin/content','PUT',{'revision':rev,'content':data},modern=False)[0]==409)
status,result=call('/portal-api/admin/content','PUT',{'revision':rev,'content':data});check('Markdown draft saves',status==200);rev=result['revision']
check('Markdown source lossless',call('/portal-api/admin/content')[1]['data']['draft']['articles'][-1]['body_markdown']==raw)
check('legacy articles unmodified',call('/portal-api/admin/content')[1]['data']['draft']['articles'][:-1]==before['articles'])
check('draft absent publicly',not any(a['slug']=='docs-upgrade-qa' for a in call('/portal-api/content')[1]['articles']))
check('stale write denied',call('/portal-api/admin/content','PUT',{'revision':rev-1,'content':data})[0]==409)
check('publish succeeds',call('/portal-api/admin/publish','POST',{'revision':rev})[0]==200)
check('published source lossless',call('/portal-api/content')[1]['articles'][-1]['body_markdown']==raw)
check('published image available',call(file['url'],auth=False)[1]==png)
subprocess.run(['systemctl','restart','shiny-portal-docs-candidate'],check=True)
import time
for _ in range(20):
    try:
        current=call('/portal-api/content')[1]
        if current['articles'][-1]['body_markdown']==raw:break
    except Exception:pass
    time.sleep(.25)
else:raise AssertionError('candidate restart persistence')
check('restart preserves documents and pictures',call(file['url'],auth=False)[1]==png)
record={'release':json.loads((stage/'candidate.json').read_text())['release'],'all_passed':True,'passed':len(checks),'checks':checks,'production_data_modified':False}
(stage/'candidate-verification.json').write_text(json.dumps(record,ensure_ascii=False,indent=2))
# Optional temporary browser QA bearer; never print or put it in a public folder.
(stage/'.qa-token').write_text(bearer.removeprefix('Bearer '));(stage/'.qa-token').chmod(0o600)
print(json.dumps(record,ensure_ascii=False))
