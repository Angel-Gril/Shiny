import hashlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import zipfile

release='portal-20261016-v3'
base=pathlib.Path('/opt/shiny-portal');target=base/'releases'/release
if target.exists():raise SystemExit('Release exists')
target.mkdir(parents=True)
with zipfile.ZipFile('/tmp/'+release+'.zip') as z:
    for name in z.namelist():
        if not (target/name).resolve().is_relative_to(target.resolve()):raise SystemExit('Unsafe zip')
    z.extractall(target)
manifest=json.loads((target/'manifest.json').read_text())
for name,sha in manifest.items():
    if hashlib.sha256((target/name).read_bytes()).hexdigest()!=sha:raise SystemExit('Digest mismatch')
user=pwd.getpwnam('shiny-portal');cache=pathlib.Path('/var/cache/shiny-portal')
cache.mkdir(mode=0o755,exist_ok=True);os.chown(cache,user.pw_uid,user.pw_gid)
new=base/'current.next';new.symlink_to(target);os.replace(new,base/'current')
shutil.copy2('/tmp/shiny-portal.service','/etc/systemd/system/shiny-portal.service')
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','shiny-portal'],check=True)
site=str(target/'site')
html_headers='''
    add_header Cache-Control "no-cache" always;
    add_header X-Shiny-Portal "portal-20261016-v3" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" always;
'''
locations=f'''
location = / {{
    root {site};
    try_files /index.html =404;
{html_headers}
}}
location ^~ /shiny-home-assets/{release}/ {{
    root {site};
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header X-Content-Type-Options "nosniff" always;
}}
# The previous release remains available to existing browser tabs.
location ^~ /shiny-home-assets/ {{
    root /var/www/shiny-homepage/releases/home-20261014-r2/site;
    try_files $uri =404;
    add_header Cache-Control "public, max-age=604800, immutable" always;
}}
location = /docs {{ return 302 /docs/; }}
location ^~ /docs/ {{
    root {site};
    try_files /index.html =404;
{html_headers}
}}
'''
for name in ['downloads','announcements','site-admin']:
    locations+=f'''location = /{name} {{ return 302 /{name}/; }}
location = /{name}/ {{
    root {site};
    try_files /index.html =404;
{html_headers}
}}
'''
locations+=f'''location ^~ /portal-templates/ {{
    root {site};
    try_files $uri =404;
    add_header Content-Disposition "attachment" always;
    add_header X-Content-Type-Options "nosniff" always;
}}
location = /portal-api/content {{
    proxy_pass http://127.0.0.1:18441;
    proxy_connect_timeout 2s;
    proxy_read_timeout 8s;
    proxy_intercept_errors on;
    error_page 502 503 504 = @shiny_portal_snapshot;
}}
location @shiny_portal_snapshot {{
    root /var/cache/shiny-portal;
    try_files /content.json =503;
    add_header Cache-Control "public, max-age=30" always;
    add_header X-Shiny-Content "published-fallback" always;
}}
location ^~ /portal-api/ {{
    client_max_body_size 21m;
    proxy_pass http://127.0.0.1:18441;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header Origin $http_origin;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_connect_timeout 2s;
    proxy_read_timeout 40s;
    proxy_send_timeout 40s;
    proxy_buffering off;
}}
'''
config=target/'portal-locations.conf';config.write_text(locations)
candidate=pathlib.Path('/etc/nginx/conf.d/shiny-portal-candidate.conf')
if candidate.exists():raise SystemExit('Candidate config already exists')
candidate.write_text(f'''server {{
 listen 127.0.0.1:18442;
 server_name _;
 include {config};
 location /api/ {{ proxy_pass http://127.0.0.1:3000; }}
 location / {{ return 404; }}
}}
''')
test=subprocess.run(['nginx','-t'],capture_output=True,text=True)
if test.returncode:
    candidate.unlink();raise SystemExit(test.stderr)
subprocess.run(['systemctl','reload','nginx'],check=True)
print(json.dumps({'candidate':'http://127.0.0.1:18442','release':release,'main_site_changed':False,'nginx_test':True}))
