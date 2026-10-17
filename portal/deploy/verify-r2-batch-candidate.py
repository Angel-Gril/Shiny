"""Validate copied R2 settings, CORS diagnostics, and existing content in candidate."""
import json
import os
from pathlib import Path
import runpy
import urllib.error
import urllib.request

stage=Path(os.environ['PORTAL_STAGE']);namespace=runpy.run_path('/tmp/refresh-docs-qa-identity.py');bearer=namespace['captured']['bearer']
base='http://127.0.0.1:18442';checks=[]
def call(path,method='GET',data=None,auth=True):
    headers={'Origin':'https://shinyapi.com','X-Portal-Request':'1'}
    if auth:headers['Authorization']=bearer
    raw=None
    if data is not None:raw=json.dumps(data).encode();headers['Content-Type']='application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(base+path,method=method,headers=headers,data=raw),timeout=20) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:status=e.code;e.close();return status,None
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append(name)
check('administrator identity',call('/portal-api/admin/session')[0]==200)
before=call('/portal-api/admin/content')[1]['data']
settings=call('/portal-api/admin/storage')[1]['data']
check('existing R2 credentials retained privately',settings['enabled'] and settings['hasCredentials'] and 'secretAccessKey' not in settings)
status,test=call('/portal-api/admin/storage/test','POST',{})
check('real bucket read write cleanup',status==200)
check('real CORS diagnostic ready',test['cors']['ready'] is True)
check('anonymous settings denied',call('/portal-api/admin/storage',auth=False)[0]==401)
check('upload size limit preserved',call('/portal-api/admin/r2/uploads','POST',{'name':'test.zip','size':512*1024*1024+1})[0]==413)
check('content untouched',call('/portal-api/admin/content')[1]['data']==before)
record={'release':json.loads((stage/'candidate.json').read_text())['release'],'all_passed':True,'passed':len(checks),'checks':checks,'production_content_modified':False}
(stage/'candidate-verification.json').write_text(json.dumps(record,ensure_ascii=False,indent=2))
print(json.dumps(record))
