"""Prepare independent portal service and candidate endpoint; keep main site intact."""
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

release=sys.argv[1] if len(sys.argv)>1 else 'portal-20261016-v1'
base=pathlib.Path('/opt/shiny-portal');target=base/'releases'/release
if target.exists():raise SystemExit('Immutable release exists: '+release)
archive=pathlib.Path('/tmp')/(release+'.zip')
target.mkdir(parents=True)
with zipfile.ZipFile(archive) as z:
    for item in z.infolist():
        dest=(target/item.filename).resolve()
        if not dest.is_relative_to(target.resolve()):raise SystemExit('Unsafe archive member')
    z.extractall(target)
manifest=json.loads((target/'manifest.json').read_text())
for name,sha in manifest.items():
    if hashlib.sha256((target/name).read_bytes()).hexdigest()!=sha:raise SystemExit('Artifact mismatch: '+name)
try:pwd.getpwnam('shiny-portal')
except KeyError:subprocess.run(['useradd','--system','--home-dir','/var/lib/shiny-portal','--shell','/usr/sbin/nologin','shiny-portal'],check=True)
user=pwd.getpwnam('shiny-portal');data=pathlib.Path('/var/lib/shiny-portal')
data.mkdir(mode=0o700,exist_ok=True);data.chmod(0o700);os.chown(data,user.pw_uid,user.pw_gid)
venv=base/'venv'
if not venv.exists():subprocess.run(['python3','-m','venv',str(venv)],check=True)
subprocess.run([str(venv/'bin/pip'),'install','-r',str(target/'backend/requirements.txt')],check=True)
with open('/tmp/portal-dependencies.lock','w') as f:subprocess.run([str(venv/'bin/pip'),'freeze'],stdout=f,check=True)
link=base/'current'
if link.exists() or link.is_symlink():raise SystemExit('Existing portal current link; update procedure required')
link.symlink_to(target)
shutil.copy2('/tmp/shiny-portal.service','/etc/systemd/system/shiny-portal.service')
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now','shiny-portal'],check=True)
for attempt in range(12):
    try:
        health=json.load(urllib.request.urlopen('http://127.0.0.1:18441/portal-api/health',timeout=2))
        if health.get('success'):break
    except Exception:pass
    time.sleep(.5)
else:raise SystemExit('Portal health did not pass')
print(json.dumps({'service':'active','release':release,'manifest_files':len(manifest),'health':health}))
