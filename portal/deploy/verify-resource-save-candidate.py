"""Verify resource-only merges in copied candidate content; no real uploads."""
import copy
import json
import os
from pathlib import Path
import runpy
import secrets
import urllib.error
import urllib.request

stage=Path(os.environ['PORTAL_STAGE']);ns=runpy.run_path('/tmp/refresh-docs-qa-identity.py');token=ns['captured']['bearer'];base='http://127.0.0.1:18442';checks=[]
def call(path,method='GET',data=None,auth=True):
    headers={'Origin':'https://shinyapi.com','X-Portal-Request':'1','X-Portal-Editor':'markdown-v2'}
    if auth:headers['Authorization']=token
    raw=None
    if data is not None:raw=json.dumps(data).encode();headers['Content-Type']='application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(base+path,method=method,headers=headers,data=raw),timeout=15) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as e:code=e.code;e.close();return code,None
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append(name)
check('real administrator identity',call('/portal-api/admin/session')[0]==200)
before=call('/portal-api/admin/content')[1]['data'];published=call('/portal-api/content')[1]
recovered=call('/portal-api/admin/r2/uploads/completed')[1]['data']
check('completed upload recovery available',isinstance(recovered,list))
check('anonymous recovery denied',call('/portal-api/admin/r2/uploads/completed',auth=False)[0]==401)
other=copy.deepcopy(before['draft']);other['site']['intro']='Candidate concurrent change'
status,saved=call('/portal-api/admin/content','PUT',{'revision':before['revision'],'content':other});check('simulate other window save',status==200)
resource=copy.deepcopy(other['resources'][0]);resource.update(id='qa-merge-'+secrets.token_hex(6),name='Candidate uploaded resource',url='https://example.invalid/qa-merge.zip')
changes={'changes':[{'resource':resource,'base':None}]}
status,result=call('/portal-api/admin/resources/batch','POST',changes);check('resource appends to latest revision',status==200)
check('unrelated edit preserved',result['data']['draft']['site']['intro']=='Candidate concurrent change')
rev=result['data']['revision'];status,result=call('/portal-api/admin/resources/batch','POST',changes)
check('retry idempotent',status==200 and result['data']['revision']==rev)
check('published content unchanged',call('/portal-api/content')[1]['resources']==published['resources'])
conflict=copy.deepcopy(resource);conflict['version']='conflicting edit'
check('same-resource conflicting baseline denied',call('/portal-api/admin/resources/batch','POST',{'changes':[{'resource':conflict,'base':None}]})[0]==409)
current=call('/portal-api/admin/content')[1]['data'];status,_=call('/portal-api/admin/content','PUT',{'revision':current['revision'],'content':before['draft']})
check('candidate restored',status==200 and call('/portal-api/admin/content')[1]['data']['draft']==before['draft'])
record={'release':json.loads((stage/'candidate.json').read_text())['release'],'all_passed':True,'passed':len(checks),'checks':checks,'production_content_modified':False}
(stage/'candidate-verification.json').write_text(json.dumps(record,indent=2));print(json.dumps(record))
