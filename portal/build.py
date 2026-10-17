"""Build immutable web asset paths without editing the approved preview."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

parser=argparse.ArgumentParser();parser.add_argument('--release',default='portal-20261016-v1');args=parser.parse_args()
root=Path(__file__).parent
out=root/'build'/args.release
if out.exists():raise SystemExit('Release already exists; choose a new immutable release ID')
web=out/'site';assets=web/'shiny-home-assets'/args.release
assets.mkdir(parents=True)
for name in ['boot.js','app.js','markdown.js','storage.js','multipart.js','upload-queue.js','styles.css','content.css']:
    shutil.copy2(root/'web'/name,assets/name)
shutil.copytree(root/'web'/'assets',assets/'assets')
shutil.copytree(root/'web'/'vendor',assets/'vendor')
html=(root/'web'/'index.html').read_text(encoding='utf-8')
for old,new in [('/assets/mark.svg',f'/shiny-home-assets/{args.release}/assets/mark.svg'),('/styles.css',f'/shiny-home-assets/{args.release}/styles.css'),('/content.css',f'/shiny-home-assets/{args.release}/content.css'),('/app.js',f'/shiny-home-assets/{args.release}/app.js'),('/boot.js',f'/shiny-home-assets/{args.release}/boot.js')]:html=html.replace(old,new)
(web/'index.html').write_text(html,encoding='utf-8')
app=(assets/'app.js').read_text(encoding='utf-8').replace('/assets/mark.svg',f'/shiny-home-assets/{args.release}/assets/mark.svg')
(assets/'app.js').write_text(app,encoding='utf-8')
shutil.copytree(root/'web'/'templates',web/'portal-templates')
app=app.replace('/templates/','/portal-templates/')
(assets/'app.js').write_text(app,encoding='utf-8')
shutil.copytree(root/'backend',out/'backend',ignore=shutil.ignore_patterns('__pycache__'))
seed=json.loads((out/'backend'/'seed.json').read_text(encoding='utf-8'))
for item in seed['resources']:item['url']=item['url'].replace('/templates/','/portal-templates/')
(out/'backend'/'seed.json').write_text(json.dumps(seed,ensure_ascii=False,indent=2),encoding='utf-8')
manifest={p.relative_to(out).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob('*') if p.is_file()}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print(out)
