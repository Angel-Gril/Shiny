"""Rollback v7 to the compatible v6 renderer without restoring/deleting content."""
import os
from pathlib import Path
import subprocess

base=Path('/opt/shiny-portal');current=(base/'current').resolve();previous=base/'releases/portal-20261016-v6'
assert current.name=='portal-20261016-v7' and (previous/'portal-locations.conf').is_file()
site=Path('/etc/nginx/sites-available/shinyapi.com');before=site.read_text()
assert before.count(str(current/'portal-locations.conf'))==1
new=before.replace(str(current/'portal-locations.conf'),str(previous/'portal-locations.conf')).replace('SHINY PORTAL '+current.name,'SHINY PORTAL '+previous.name)
site.write_text(new)
test=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if test.returncode:site.write_text(before);raise SystemExit(test.stderr)
temp=base/'current.rollback-next';assert not temp.exists();temp.symlink_to(previous);os.replace(temp,base/'current')
subprocess.run(['systemctl','restart','shiny-portal'],check=True)
subprocess.run(['systemctl','reload','nginx'],check=True)
print('Portal rolled back to v6; production Markdown and attachments retained.')
