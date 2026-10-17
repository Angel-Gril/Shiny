"""Check staged source paths and high-confidence credential patterns without printing values."""
from pathlib import Path
import re
import subprocess
import sys

paths=subprocess.check_output(['git','ls-files','-z'] if '--all' in sys.argv else ['git','diff','--cached','--name-only','--diff-filter=ACMR','-z']).decode().split('\0')
patterns=[re.compile(rb'(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{25,}'),
          re.compile(rb'gh[pousr]_[A-Za-z0-9]{25,}'),
          re.compile(rb'github_pat_[A-Za-z0-9_]{30,}'),
          re.compile(rb'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{64,}')]
findings=[]
selected=list(filter(None,paths))
batch=subprocess.run(['git','cat-file','--batch'],input=('\n'.join(':'+name for name in selected)+'\n').encode(),capture_output=True,check=True).stdout
offset=0
for name in filter(None,paths):
    end=batch.index(b'\n',offset)
    size=int(batch[offset:end].rsplit(b' ',1)[1])
    raw=batch[end+1:end+1+size]
    offset=end+size+2
    p=Path(name)
    if name.startswith(('maintenance/','exports/')) or p.suffix in ['.sqlite','.db','.key','.pem'] or p.name in ['r2-settings.json','data.key','admin.key']:
        findings.append({'path':name,'reason':'runtime/private file'});continue
    if len(raw)>10*1024*1024:findings.append({'path':name,'reason':'unexpected large artifact'})
    for number,pattern in enumerate(patterns):
        for match in pattern.finditer(raw):
            # Upstream's deterministic fake fixture is not a usable credential.
            if name.endswith('_test.go') and match.group() in [b'sk-'+b'midjourney-funding-failure']:
                continue
            findings.append({'path':name,'reason':'credential pattern '+str(number+1)})
if findings:
    for finding in findings:print(finding['path']+': '+finding['reason'])
    sys.exit(1)
print('Staged source secret scan passed ('+str(len(list(filter(None,paths))))+' files).')
