"""Restore only portal routing/docs entry; never touch model or payment settings."""
import hashlib
import json
import pathlib
import runpy
import subprocess

stage=pathlib.Path('/root/shiny-maintenance/portal-production-20261016')
receipt=json.loads((stage/'deployment.json').read_text())
site=pathlib.Path(receipt['site_path'])
if hashlib.sha256(site.read_bytes()).hexdigest()!=receipt['after_sha256']:
    raise SystemExit('Nginx changed after this deployment; review before rollback')
before=(stage/'nginx.before.conf').read_bytes()
if hashlib.sha256(before).hexdigest()!=receipt['before_sha256']:
    raise SystemExit('Rollback configuration digest mismatch')
current=site.read_bytes();site.write_bytes(before)
check=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if check.returncode:
    site.write_bytes(current);raise SystemExit(check.stderr)
subprocess.run(['systemctl','reload','nginx'],check=True)
request=runpy.run_path('/root/shiny-maintenance/request-checks-turnstile-20261015/policy-admin.py')['admin_request']
request('/api/option/','PUT',{'key':'general_setting.docs_link','value':receipt['previous_docs_link']})
print('Previous homepage routes restored. Content database and uploaded files retained.')
