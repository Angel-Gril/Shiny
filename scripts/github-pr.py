"""Create/update a PR using the Git credential helper; never persist its token."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request

parser=argparse.ArgumentParser()
parser.add_argument('--head',required=True)
parser.add_argument('--title',required=True)
parser.add_argument('--body-file',required=True)
parser.add_argument('--merge',action='store_true')
args=parser.parse_args()
remote=subprocess.check_output(['git','remote','get-url','origin'],text=True).strip()
assert remote=='https://github.com/Angel-Gril/Shiny.git','Unexpected repository'
credential=subprocess.run(['git','-c','credential.interactive=never','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,check=True,env={**os.environ,'GCM_INTERACTIVE':'never'})
fields=dict(line.split('=',1) for line in credential.stdout.splitlines() if '=' in line)
token=fields.get('password')
if not token:raise SystemExit('GitHub credentials unavailable')
def api(path,method='GET',body=None):
    request=urllib.request.Request('https://api.github.com/repos/Angel-Gril/Shiny/'+path,method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization':'Bearer '+token,'User-Agent':'Shiny-maintenance','Accept':'application/vnd.github+json','Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit('GitHub API failed: HTTP '+str(error.code)) from None
existing=api('pulls?state=open&head='+urllib.parse.quote('Angel-Gril:'+args.head,safe=''))
body={'title':args.title,'body':Path(args.body_file).read_text(encoding='utf-8'),'head':args.head,'base':'main'}
pr=api('pulls/'+str(existing[0]['number']),'PATCH',body) if existing else api('pulls','POST',body)
print(json.dumps({'url':pr['html_url'],'number':pr['number'],'head':pr['head']['sha']}))
if args.merge:
    result=api('pulls/'+str(pr['number'])+'/merge','PUT',{'sha':pr['head']['sha'],'merge_method':'merge'})
    if not result.get('merged'):raise SystemExit('PR was not merged')
    print(json.dumps({'merged':True,'commit':result['sha']}))
