"""Prepare an isolated candidate. Does not switch production or write its data."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import sqlite3
import subprocess
import zipfile

release=os.environ.get('PORTAL_RELEASE','portal-20261016-v6')
base=Path('/opt/shiny-portal');old=(base/'current').resolve();target=base/'releases'/release
stage=Path(os.environ.get('PORTAL_STAGE','/root/shiny-maintenance/portal-docs-upgrade-20261016'));stage.mkdir(parents=True,exist_ok=True)
candidate=Path('/var/lib/shiny-portal-docs-candidate')
if target.exists() or candidate.exists():raise SystemExit('Candidate already exists; do not overwrite')
assert old.parent==base/'releases' and old.name==os.environ.get('PORTAL_PREVIOUS_RELEASE','portal-20261016-v5')
target.mkdir()
with zipfile.ZipFile('/tmp/'+release+'.zip') as archive:
    for name in archive.namelist():
        if not (target/name).resolve().is_relative_to(target.resolve()):raise SystemExit('Unsafe archive path')
    archive.extractall(target)
for name,sha in json.loads((target/'manifest.json').read_text()).items():
    assert hashlib.sha256((target/name).read_bytes()).hexdigest()==sha,name
candidate.mkdir(mode=0o700)
with sqlite3.connect('file:/var/lib/shiny-portal/content.sqlite?mode=ro',uri=True) as source,sqlite3.connect(candidate/'content.sqlite') as dest:source.backup(dest)
shutil.copytree('/var/lib/shiny-portal/uploads',candidate/'uploads')
private_r2=Path('/var/lib/shiny-portal/r2-settings.json')
if private_r2.exists():
    shutil.copy2(private_r2,candidate/'r2-settings.json')
    (candidate/'r2-settings.json').chmod(0o600)
(candidate/'cache').mkdir()
account=pwd.getpwnam('shiny-portal')
for p in [candidate,*candidate.rglob('*')]:os.chown(p,account.pw_uid,account.pw_gid)
locations=(old/'portal-locations.conf').read_text().replace(str(old),str(target)).replace(old.name,release)
# Keep v5 assets for old tabs in addition to the earlier static homepage assets.
old_assets=f'''location ^~ /shiny-home-assets/{old.name}/ {{
 types {{ application/javascript js mjs; text/css css; image/svg+xml svg; application/json json; text/plain txt; }}
 root {old}/site;
 try_files $uri =404;
 add_header Cache-Control "public, max-age=31536000, immutable" always;
 add_header X-Content-Type-Options "nosniff" always;
}}
'''
locations=old_assets+locations
locations=locations.replace("img-src 'self' data:;","img-src 'self' https: data: blob:;")
if (target/'backend/r2_storage.py').exists():
    locations=locations.replace("connect-src 'self';","connect-src 'self' https://*.r2.cloudflarestorage.com;")
asset_prefix=f'location ^~ /shiny-home-assets/{release}/ {{'
mime_line='    types { application/javascript js mjs; text/css css; image/svg+xml svg; application/json json; text/plain txt; }'
if mime_line not in locations:locations=locations.replace(asset_prefix,asset_prefix+'\n'+mime_line)
(target/'portal-locations.conf').write_text(locations)
candidate_locations=locations.replace('127.0.0.1:18441','127.0.0.1:18444').replace('/var/cache/shiny-portal',str(candidate/'cache'))
(target/'candidate-locations.conf').write_text(candidate_locations)
nginx=Path('/etc/nginx/conf.d/shiny-portal-docs-candidate.conf')
assert not nginx.exists()
nginx.write_text(f'''server {{
 listen 127.0.0.1:18442;
 server_name _;
 include {target}/candidate-locations.conf;
 location /api/ {{ proxy_pass http://127.0.0.1:3000; }}
 location / {{ return 404; }}
}}
''')
subprocess.run(['systemd-run','--unit=shiny-portal-docs-candidate','--uid=shiny-portal','--gid=shiny-portal',
    '--property=NoNewPrivileges=yes','--property=WorkingDirectory='+str(target/'backend'),
    '--setenv=PORTAL_DATA_DIR='+str(candidate),'--setenv=PORTAL_SNAPSHOT_DIR='+str(candidate/'cache'),
    '--setenv=PORTAL_SEED_PATH='+str(target/'backend/seed.json'),'--setenv=PORTAL_ORIGIN=https://shinyapi.com',
    '/opt/shiny-portal/venv/bin/gunicorn','--no-control-socket','--workers','1','--threads','4','--bind','127.0.0.1:18444','--timeout','45','wsgi:application'],check=True)
test=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if test.returncode:nginx.unlink();raise SystemExit(test.stderr)
subprocess.run(['systemctl','reload','nginx'],check=True)
record={'release':release,'previous_release':old.name,'production_switched':False,'candidate_data':str(candidate),'candidate_url':'http://127.0.0.1:18442'}
(stage/'candidate.json').write_text(json.dumps(record,indent=2))
print(json.dumps(record))
