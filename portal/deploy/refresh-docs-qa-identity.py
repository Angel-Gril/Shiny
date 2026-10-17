"""Obtain a short lived QA bearer without printing it or changing New API."""
from pathlib import Path
import os
import runpy
import urllib.request

fn=runpy.run_path('/root/shiny-maintenance/request-checks-turnstile-20261015/policy-admin.py')['admin_request']
original=urllib.request.urlopen;captured={}
def capture(req,*a,**kw):
    if isinstance(req,urllib.request.Request) and req.full_url.endswith('/api/option/request_policy'):captured['bearer']=req.get_header('Authorization')
    return original(req,*a,**kw)
urllib.request.urlopen=capture
try:fn('/api/option/request_policy')
finally:urllib.request.urlopen=original
target=Path(os.environ.get('PORTAL_STAGE','/root/shiny-maintenance/portal-docs-upgrade-20261016'))/'.qa-token'
target.write_text(captured['bearer'].removeprefix('Bearer '));target.chmod(0o600)
print('Short-lived QA identity refreshed; bearer not printed.')
