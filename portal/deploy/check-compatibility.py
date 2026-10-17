"""Read-only check after a New API or portal upgrade; does not call models."""
import json
import pathlib
import urllib.error
import urllib.request

checks=[]
def probe(path, expected, portal=False):
    request=urllib.request.Request('https://shinyapi.com'+path)
    try:
        with urllib.request.urlopen(request,timeout=12) as response:
            code=response.status;headers=response.headers;body=response.read(2*1024*1024)
    except urllib.error.HTTPError as error:
        code=error.code;headers=error.headers;body=error.read();error.close()
    owned=bool(headers.get('X-Shiny-Portal'))
    checks.append({'path':path,'status':code,'expected':expected,'portal':owned,'pass':code==expected and owned==portal})
    return body

for path in ['/','/docs/','/docs/quickstart','/downloads/','/announcements/','/site-admin/']:
    probe(path,200,True)
for path in ['/sign-in','/sign-up','/dashboard','/pricing','/api/status']:
    probe(path,200)
for path in ['/api/user/self','/v1/models','/portal-api/admin/content']:
    probe(path,401)
data=json.loads(probe('/portal-api/content',200))
checks.append({'content_articles':len(data.get('articles',[])),'pass':bool(data.get('articles'))})
site=pathlib.Path('/etc/nginx/sites-available/shinyapi.com')
if site.exists():
    config=site.read_text()
    checks.append({'nginx_portal_include':True,'pass':config.count('portal-locations.conf')==1 and '# BEGIN SHINY HOMEPAGE' not in config and 'client_max_body_size 32m' in config})
print(json.dumps({'checks':checks,'all_passed':all(c['pass'] for c in checks)},ensure_ascii=False,indent=2))
raise SystemExit(0 if all(c['pass'] for c in checks) else 1)
