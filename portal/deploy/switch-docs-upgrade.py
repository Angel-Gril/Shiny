"""Switch only the independent portal after candidate validation; preserve data."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time
import urllib.request

base=Path('/opt/shiny-portal');old=(base/'current').resolve();target=base/'releases'/os.environ.get('PORTAL_RELEASE','portal-20261016-v6')
stage=Path(os.environ.get('PORTAL_STAGE','/root/shiny-maintenance/portal-docs-upgrade-20261016'))
assert old.name==os.environ.get('PORTAL_PREVIOUS_RELEASE','portal-20261016-v5') and (target/'portal-locations.conf').is_file()
assert (stage/'candidate-verification.json').is_file(),'Verify candidate before switching'
verification=json.loads((stage/'candidate-verification.json').read_text());assert verification['all_passed']
assert verification.get('release')==target.name,'Verification does not match the release to deploy'
site=Path('/etc/nginx/sites-available/shinyapi.com');before=site.read_text()
assert before.count(str(old/'portal-locations.conf'))==1
after=before.replace(str(old/'portal-locations.conf'),str(target/'portal-locations.conf')).replace('SHINY PORTAL '+old.name,'SHINY PORTAL '+target.name)
def content_state():
    with sqlite3.connect('file:/var/lib/shiny-portal/content.sqlite?mode=ro',uri=True) as db:
        return {name:{'revision':rev,'sha256':hashlib.sha256(value.encode()).hexdigest()} for name,value,rev in db.execute('SELECT name,value,revision FROM content')}
state=content_state();pid=subprocess.check_output(['systemctl','show','-p','MainPID','--value','relay-native-new-api'],text=True).strip()
# Consistent database safety copy; no seed initialization or content migration.
with sqlite3.connect('file:/var/lib/shiny-portal/content.sqlite?mode=ro',uri=True) as source,sqlite3.connect(stage/'content.before.sqlite') as backup:source.backup(backup)
(stage/'nginx.before.conf').write_text(before)
record={'previous_release':old.name,'release':target.name,'content_before':state,'newapi_pid_before':pid,'nginx_before_sha256':hashlib.sha256(before.encode()).hexdigest()}
def point(folder):
    temp=base/'current.docs-next';assert not temp.exists();temp.symlink_to(folder);os.replace(temp,base/'current')
try:
    assert site.read_text()==before
    point(target);subprocess.run(['systemctl','restart','shiny-portal'],check=True)
    for _ in range(20):
        try:
            health=json.load(urllib.request.urlopen('http://127.0.0.1:18441/portal-api/health',timeout=2));assert health['editor_format']==2;break
        except Exception:time.sleep(.25)
    else:raise RuntimeError('New portal service failed health check')
    assert content_state()==state,'Content unexpectedly changed during restart'
    site.write_text(after);subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
    # systemctl reload returns before Nginx's new workers accept every connection.
    for attempt in range(20):
        with urllib.request.urlopen('https://shinyapi.com/',timeout=10) as response:
            if response.headers.get('X-Shiny-Portal')==target.name:
                record['web_ready_attempt']=attempt+1
                break
        time.sleep(.25)
    else:raise RuntimeError('Public portal did not reach the expected release')
    # Populate the new-format-compatible public fallback without writing content.
    urllib.request.urlopen('http://127.0.0.1:18441/portal-api/content',timeout=10).close()
except Exception:
    site.write_text(before);point(old);subprocess.run(['systemctl','restart','shiny-portal'],check=True)
    subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
    raise
record.update(content_after=content_state(),newapi_pid_after=subprocess.check_output(['systemctl','show','-p','MainPID','--value','relay-native-new-api'],text=True).strip(),deployed_at_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),nginx_after_sha256=hashlib.sha256(after.encode()).hexdigest())
assert record['newapi_pid_before']==record['newapi_pid_after']
(stage/'deployment.json').write_text(json.dumps(record,indent=2));print(json.dumps(record))
