"""Remove exact disposable QA data, never the production content directory."""
import json
from pathlib import Path
import os
import shutil
import subprocess

stage=Path(os.environ.get('PORTAL_STAGE','/root/shiny-maintenance/portal-docs-upgrade-20261016'))
for name in ['candidate-verification.json','deployment.json']:
    source=stage/name
    if source.exists():
        record=json.loads(source.read_text());release=record.get('release','portal-20261016-v6')
        shutil.copy2(source,stage/(source.stem+'-'+release+'.json'))
candidate=Path('/var/lib/shiny-portal-docs-candidate')
assert candidate.absolute()==Path('/var/lib/shiny-portal-docs-candidate')
assert not candidate.is_symlink()
assert candidate.resolve()!=Path('/var/lib/shiny-portal').resolve()
subprocess.run(['systemctl','stop','shiny-portal-docs-candidate'],check=False,capture_output=True)
config=Path('/etc/nginx/conf.d/shiny-portal-docs-candidate.conf')
if config.exists():config.unlink()
subprocess.run(['nginx','-t'],check=True);subprocess.run(['systemctl','reload','nginx'],check=True)
if candidate.exists():shutil.rmtree(candidate)
for target in [stage/'.qa-token',Path('/tmp/shiny-docs-qa-token')]:target.unlink(missing_ok=True)
print(json.dumps({'candidate_data_removed':not candidate.exists(),'candidate_listener_removed':not config.exists(),'production_data_preserved':Path('/var/lib/shiny-portal/content.sqlite').is_file()}))
