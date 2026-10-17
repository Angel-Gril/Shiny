"""Switch only the standalone homepage/content routes after candidate checks."""
import hashlib
import json
import pathlib
import runpy
import subprocess
import time
import urllib.error
import urllib.request

release='portal-20261016-v5'
target=pathlib.Path('/opt/shiny-portal/releases')/release
stage=pathlib.Path('/root/shiny-maintenance/portal-production-20261016')
stage.mkdir(parents=True,exist_ok=True)
site=pathlib.Path('/etc/nginx/sites-available/shinyapi.com')
if not site.exists():site=pathlib.Path('/etc/nginx/sites-enabled/shinyapi.com').resolve()
old=site.read_text()
begin=old.index('    # BEGIN SHINY HOMEPAGE home-20261014-r2')
end=old.index('    # END SHINY HOMEPAGE',begin)+len('    # END SHINY HOMEPAGE')
new=old[:begin]+f'    # BEGIN SHINY PORTAL {release}\n    include {target}/portal-locations.conf;\n    # END SHINY PORTAL'+old[end:]
if not (stage/'nginx.before.conf').exists():(stage/'nginx.before.conf').write_text(old)
record={'release':release,'site_path':str(site),'before_sha256':hashlib.sha256(old.encode()).hexdigest(),'after_sha256':hashlib.sha256(new.encode()).hexdigest()}
fn=runpy.run_path('/root/shiny-maintenance/request-checks-turnstile-20261015/policy-admin.py')['admin_request']
status=json.load(urllib.request.urlopen('http://127.0.0.1:3000/api/status'))['data']
record['previous_docs_link']=status.get('docs_link')

# Validate graceful public-content fallback and retained state before exposure.
subprocess.run(['systemctl','stop','shiny-portal'],check=True)
try:
    with urllib.request.urlopen('http://127.0.0.1:18442/portal-api/content',timeout=5) as response:
        body=json.load(response)
        assert response.status==200 and response.headers.get('X-Shiny-Content')=='published-fallback'
        assert body.get('articles')
        record['snapshot_fallback_verified']=True
finally:subprocess.run(['systemctl','start','shiny-portal'],check=True)
for i in range(15):
    try:
        data=json.load(urllib.request.urlopen('http://127.0.0.1:18441/portal-api/content',timeout=3))
        assert len(data['resources'])==4
        break
    except Exception:time.sleep(.3)
else:raise SystemExit('Restart persistence verification failed')
record['restart_persistence_verified']=True
assert site.read_text()==old,'Concurrent nginx change; do not overwrite'
site.write_text(new)
test=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if test.returncode:
    site.write_text(old);raise SystemExit(test.stderr)
try:
    subprocess.run(['systemctl','reload','nginx'],check=True)
    # Point the existing New API documentation navigation to the local portal.
    fn('/api/option/','PUT',{'key':'general_setting.docs_link','value':'https://shinyapi.com/docs/'})
    actual=json.load(urllib.request.urlopen('http://127.0.0.1:3000/api/status'))['data'].get('docs_link')
    assert actual=='https://shinyapi.com/docs/'
    record['docs_link']=actual
except Exception:
    site.write_text(old);subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
    raise
record['deployed_at_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
(stage/'deployment.json').write_text(json.dumps(record,ensure_ascii=False,indent=2))
print(json.dumps(record,ensure_ascii=False))
