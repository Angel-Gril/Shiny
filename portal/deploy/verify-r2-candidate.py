"""Check candidate storage UI endpoints without configuring any real R2 account."""
import hashlib
import json
import os
from pathlib import Path
import runpy
import urllib.error
import urllib.request

stage=Path(os.environ['PORTAL_STAGE']);namespace=runpy.run_path('/tmp/refresh-docs-qa-identity.py');bearer=namespace['captured']['bearer']
base='http://127.0.0.1:18442';checks=[]
def call(path,method='GET',data=None,auth=True,origin='https://shinyapi.com'):
    headers={'Origin':origin,'X-Portal-Request':'1','X-Portal-Editor':'markdown-v2'}
    if auth:headers['Authorization']=bearer
    body=None
    if data is not None:body=json.dumps(data).encode();headers['Content-Type']='application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(base+path,method=method,headers=headers,data=body),timeout=12) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:
        code=e.code;e.close();return code,None
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append(name)

check('R2-capable health',call('/portal-api/health')[1]['r2_supported'])
check('real administrator session',call('/portal-api/admin/session')[0]==200)
state=call('/portal-api/admin/content')[1]['data']
status,data=call('/portal-api/admin/storage');settings=data['data']
check('R2 defaults disabled without credentials',status==200 and not settings['enabled'] and not settings['hasCredentials'])
check('settings omit secret fields',not {'accessKeyId','secretAccessKey'}&set(settings))
check('CORS is scoped to Shiny',settings['cors'][0]['AllowedOrigins']==['https://shinyapi.com'])
check('anonymous storage access denied',call('/portal-api/admin/storage',auth=False)[0]==401)
check('cross-origin settings write denied',call('/portal-api/admin/storage','PUT',{},origin='https://example.invalid')[0]==403)
check('disabled upload rejects',call('/portal-api/admin/r2/uploads','POST',{'name':'installer.exe','size':25*1024*1024})[0]==409)
check('512 MB limit enforced',call('/portal-api/admin/r2/uploads','POST',{'name':'installer.zip','size':512*1024*1024+1})[0]==413)
status,data=call('/portal-api/admin/storage','PUT',{'revision':settings['revision'],'enabled':False,'accountId':'','bucket':'','publicBase':'','prefix':'downloads','accessKeyId':'','secretAccessKey':''})
check('private settings can save while disabled',status==200 and not data['data']['hasCredentials'])
check('content draft and publication unchanged',call('/portal-api/admin/content')[1]['data']==state)
record={'release':json.loads((stage/'candidate.json').read_text())['release'],'all_passed':True,'passed':len(checks),'checks':checks,'real_r2_configured':False,'production_data_modified':False}
(stage/'candidate-verification.json').write_text(json.dumps(record,ensure_ascii=False,indent=2))
print(json.dumps(record,ensure_ascii=False))
