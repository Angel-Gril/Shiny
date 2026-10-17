"""Exercise deletion only in a disposable candidate database."""
import copy
import json
import os
from pathlib import Path
import runpy
import urllib.error
import urllib.request

stage=Path(os.environ['PORTAL_STAGE'])
namespace=runpy.run_path('/tmp/refresh-docs-qa-identity.py')
token=namespace['captured']['bearer'];base='http://127.0.0.1:18442'
checks=[]
def call(path,method='GET',body=None,auth=True):
    headers={'Origin':'https://shinyapi.com','X-Portal-Request':'1','X-Portal-Editor':'markdown-v2'}
    if auth:headers['Authorization']=token
    raw=None
    if body is not None:raw=json.dumps(body,ensure_ascii=False).encode();headers['Content-Type']='application/json'
    req=urllib.request.Request(base+path,headers=headers,method=method,data=raw)
    try:
        with urllib.request.urlopen(req,timeout=12) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as e:
        code=e.code;data=e.read();e.close();return code,data
def check(name,ok):
    if not ok:raise AssertionError(name)
    checks.append(name)

check('real administrator identity',call('/portal-api/admin/session')[0]==200)
state=call('/portal-api/admin/content')[1]['data'];before=copy.deepcopy(state['draft']);rev=state['revision'];public=call('/portal-api/content')[1]
data=copy.deepcopy(before);article=copy.deepcopy(data['articles'][0]);article.update(slug='draft-delete-candidate-qa',title='Temporary deletion QA');data['articles'].append(article)
status,result=call('/portal-api/admin/content','PUT',{'revision':rev,'content':data});check('temporary draft saved',status==200);rev=result['revision']
endpoint='/portal-api/admin/articles/'+article['slug']
check('anonymous deletion denied',call(endpoint,'DELETE',{'revision':rev},auth=False)[0]==401)
check('stale deletion denied',call(endpoint,'DELETE',{'revision':rev-1})[0]==409)
status,result=call(endpoint,'DELETE',{'revision':rev});check('unpublished draft deletion succeeds',status==200 and result['wasPublished'] is False);rev=result['revision']
check('unpublished draft absent',not any(a['slug']==article['slug'] for a in call('/portal-api/admin/content')[1]['data']['draft']['articles']))
check('published content unchanged',call('/portal-api/content')[1]['articles']==public['articles'])
referenced=before['resources'][0]['article']
check('resource association blocks deletion',call('/portal-api/admin/articles/'+referenced,'DELETE',{'revision':rev})[0]==409)
target=next(a for a in before['articles'] if any(p['slug']==a['slug'] for p in public['articles']) and not any(r['article']==a['slug'] for r in before['resources']))
status,result=call('/portal-api/admin/articles/'+target['slug'],'DELETE',{'revision':rev});check('published article removed from draft',status==200 and result['wasPublished'] is True);rev=result['revision']
check('published article remains online',any(a['slug']==target['slug'] for a in call('/portal-api/content')[1]['articles']))
status,result=call('/portal-api/admin/content','PUT',{'revision':rev,'content':before});check('candidate draft restored',status==200)
check('restore is exact',call('/portal-api/admin/content')[1]['data']['draft']==before)
record={'release':json.loads((stage/'candidate.json').read_text())['release'],'all_passed':True,'passed':len(checks),'checks':checks,'production_data_modified':False}
(stage/'candidate-verification.json').write_text(json.dumps(record,ensure_ascii=False,indent=2))
print(json.dumps(record,ensure_ascii=False))
