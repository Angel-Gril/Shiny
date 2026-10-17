"""Deduplicate equivalent MIME declarations; no routes or assets are changed."""
from pathlib import Path
import subprocess

target=Path('/opt/shiny-portal/current').resolve()
assert target.name=='portal-20261016-v7'
mime='    types { application/javascript js mjs; text/css css; image/svg+xml svg; application/json json; text/plain txt; }'
before={}
for name in ['portal-locations.conf','candidate-locations.conf']:
    path=target/name
    if path.exists():
        old=path.read_text();new=old.replace(mime+'\n'+mime,mime)
        if old!=new:before[path]=old;path.write_text(new)
try:subprocess.run(['nginx','-t'],check=True)
except Exception:
    for path,old in before.items():path.write_text(old)
    raise
subprocess.run(['systemctl','reload','nginx'],check=True)
print('Equivalent duplicate MIME declarations removed; nginx test passed.')
