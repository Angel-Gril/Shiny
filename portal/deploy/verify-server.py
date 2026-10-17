"""Verify candidate against real New API auth, then remove exact QA artifacts."""
import json
import pathlib
import runpy
import sqlite3
import time
import urllib.error
import urllib.request

base='http://127.0.0.1:18442'
namespace=runpy.run_path('/root/shiny-maintenance/request-checks-turnstile-20261015/policy-admin.py')
request=namespace['admin_request'];original=urllib.request.urlopen;captured={}
def capture(req,*a,**kw):
    if isinstance(req,urllib.request.Request) and req.full_url.endswith('/api/option/request_policy'):
        captured['authorization']=req.get_header('Authorization')
    return original(req,*a,**kw)
urllib.request.urlopen=capture
try:request('/api/option/request_policy')
finally:urllib.request.urlopen=original
bearer=captured['authorization']
def call(path,method='GET',body=None,raw=None,content_type=None,auth=True,origin='https://shinyapi.com'):
    headers={'X-Portal-Request':'1','Origin':origin}
    if auth:headers['Authorization']=bearer
    if body is not None:raw=json.dumps(body).encode();content_type='application/json'
    if content_type:headers['Content-Type']=content_type
    req=urllib.request.Request(base+path,method=method,headers=headers,data=raw)
    try:
        with original(req,timeout=15) as res:
            b=res.read();return res.status,json.loads(b) if 'json' in res.headers.get('Content-Type','') else b
    except urllib.error.HTTPError as e:
        status=e.code;e.close();return status,None

checks=[]
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append(name)

state=call('/portal-api/admin/content')[1]['data'];before=state['draft'];before_rev=state['revision'];file_id=None
try:
    check('health',call('/portal-api/health')[0]==200)
    check('anonymous_admin_rejected',call('/portal-api/admin/content',auth=False)[0]==401)
    check('cross_origin_write_rejected',call('/portal-api/admin/publish','POST',{'revision':before_rev},origin='https://example.invalid')[0]==403)
    check('real_newapi_admin_session',call('/portal-api/admin/session')[0]==200)
    check('public_announcements_reused',len(call('/portal-api/content')[1]['announcements'])>0)
    boundary='ShinyPortalQA'+str(int(time.time()))
    payload=b'%PDF-1.4\n% Shiny portal temporary QA document\n%%EOF\n'
    body=(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="portal-qa.pdf"\r\nContent-Type: application/pdf\r\n\r\n').encode()+payload+f'\r\n--{boundary}--\r\n'.encode()
    status,data=call('/portal-api/admin/upload','POST',raw=body,content_type='multipart/form-data; boundary='+boundary)
    check('upload_saved',status==200);file=data['data'];file_id=file['id']
    check('draft_file_private',call(file['url'],auth=False)[0]==404)
    modified=json.loads(json.dumps(before));modified['resources'].append({'id':'portal-qa-temporary','name':'Temporary QA','summary':'Temporary verification only','category':'文档资料','platforms':['通用'],'version':'qa','source':'QA','url':file['url'],'article':'quickstart','icon':'file','featured':False})
    status,result=call('/portal-api/admin/content','PUT',{'content':modified,'revision':before_rev})
    check('draft_saved',status==200);rev=result['revision']
    check('stale_revision_rejected',call('/portal-api/admin/content','PUT',{'content':before,'revision':before_rev})[0]==409)
    check('draft_absent_public',not any(r['id']=='portal-qa-temporary' for r in call('/portal-api/content')[1]['resources']))
    check('publish',call('/portal-api/admin/publish','POST',{'revision':rev})[0]==200)
    status,data=call(file['url'],auth=False);check('published_attachment_download',status==200 and data==payload)
finally:
    current=call('/portal-api/admin/content')[1]['data'];status,res=call('/portal-api/admin/content','PUT',{'content':before,'revision':current['revision']})
    if status!=200:raise RuntimeError('QA restore failed')
    if call('/portal-api/admin/publish','POST',{'revision':res['revision']})[0]!=200:raise RuntimeError('QA publish restore failed')
    if file_id:
        # Delete only this freshly-created QA object after removing public refs.
        with sqlite3.connect('/var/lib/shiny-portal/content.sqlite') as db:
            db.execute('DELETE FROM files WHERE id=?',(file_id,))
        target=pathlib.Path('/var/lib/shiny-portal/uploads')/file_id
        assert target.parent==pathlib.Path('/var/lib/shiny-portal/uploads')
        target.unlink(missing_ok=True)
check('seed_restored',len(call('/portal-api/content')[1]['resources'])==len(before['resources']))
check('snapshot_written',pathlib.Path('/var/cache/shiny-portal/content.json').is_file())
print(json.dumps({'checks':checks,'passed':len(checks),'qa_file_removed':file_id is not None,'service_authenticated_against_newapi':True}))
