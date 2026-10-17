"""Independent Shiny public content and administrator service.

New API owns identity. This service never receives its signing secret, stores a
dashboard token, or calls model endpoints. The browser supplies a short-lived
dashboard bearer; every admin operation revalidates it with New API.
"""
import copy
import contextlib
import functools
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, abort, g, jsonify, request, send_file
from werkzeug.exceptions import HTTPException
from r2_storage import register_r2

SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
FILE_ID = re.compile(r"^[a-f0-9]{32}$")
MIMES = {'.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         '.md': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip',
         '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp'}


def text(value, maximum, label, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        abort(400, description=f'{label}格式不正确或超出长度限制')
    if any(ord(c) < 32 and c not in '\n\r\t' for c in value):
        abort(400, description=f'{label}含有无效字符')
    return value.strip()


def url(value, label='链接'):
    value = text(value, 2048, label)
    if '\\' in value or any(ord(c) < 32 for c in value):
        abort(400, description=f'{label}不合法')
    parsed = urlsplit(value)
    if value.startswith('/') and not value.startswith('//') and not parsed.scheme and not parsed.netloc:
        return value
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        abort(400, description=f'{label}需要本站路径或 HTTPS 地址')
    return value


def validate_content(data):
    if not isinstance(data, dict):
        abort(400, description='内容格式错误')
    expected = {'revision', 'site', 'navigation', 'models', 'articles', 'resources', 'announcements'}
    if set(data) != expected:
        abort(400, description='内容字段不匹配，请刷新页面')
    text(data['revision'], 100, '内容版本')
    site = data['site']
    if not isinstance(site, dict) or set(site) != {'headline', 'intro', 'baseUrl'}:
        abort(400, description='首页配置格式错误')
    text(site['headline'], 100, '首页标题'); text(site['intro'], 300, '首页介绍'); url(site['baseUrl'], 'API 地址')
    for collection, limit in [('navigation', 8), ('models', 12), ('articles', 200), ('resources', 300), ('announcements', 100)]:
        if not isinstance(data[collection], list) or len(data[collection]) > limit:
            abort(400, description=f'{collection}数量超出限制')
        if any(not isinstance(row, dict) for row in data[collection]):
            abort(400, description='内容条目格式错误')
    for n in data['navigation']:
        if set(n) != {'id', 'title', 'url', 'enabled'} or type(n['enabled']) is not bool:
            abort(400, description='导航配置格式错误')
        text(n['id'], 80, '导航标识'); text(n['title'], 16, '导航标题'); url(n['url'])
    for m in data['models']:
        for key in ['name', 'subtitle', 'mark', 'tone']:
            text(m.get(key), 200, '模型简介')
        tags(m.get('tags'))
    slugs = set()
    for a in data['articles']:
        slug = text(a.get('slug'), 70, '文章路径')
        if not SLUG.fullmatch(slug) or slug in slugs:
            abort(400, description='文章路径重复或格式错误')
        slugs.add(slug)
        for key, limit in [('title',100),('summary',300),('category',40),('updated',30),('icon',30)]:
            text(a.get(key), limit, '文章字段')
        if type(a.get('featured')) is not bool or type(a.get('minutes')) is not int or not 1 <= a['minutes'] <= 240:
            abort(400, description='文章属性错误')
        tags(a.get('tags'))
        if 'body_markdown' in a:
            text(a['body_markdown'], 1024*1024, 'Markdown 正文')
            if len(a['body_markdown'].encode('utf-8')) > 1024*1024 or a.get('format_version') != 2:
                abort(400, description='Markdown 正文最大 1 MB，格式版本应为 2')
        elif not isinstance(a.get('sections'), list) or not 1 <= len(a['sections']) <= 100:
            abort(400, description='文章章节数量错误')
        for key,limit in [('source_path',512),('source_name',180),('client_version',80)]:
            if key in a:text(a[key],limit,'文章来源',empty=True)
        if a.get('source_url'):url(a['source_url'],'来源地址')
        if 'sections' in a and (not isinstance(a['sections'],list) or len(a['sections'])>100):
            abort(400,description='文章章节格式错误')
        for section in a.get('sections',[]):
            text(section.get('id'), 100, '章节标识'); text(section.get('title'), 200, '章节标题')
            for key in ['text','code','callout','language']:
                if key in section: text(section[key], 100000 if key in ['text','code'] else 2000, '章节内容', empty=True)
            if 'link' in section:
                text(section['link'].get('label'), 160, '链接标题'); url(section['link'].get('url'))
    ids = set()
    for r in data['resources']:
        ident = text(r.get('id'), 100, '资源标识')
        if ident in ids: abort(400, description='资源标识重复')
        ids.add(ident)
        for key, limit in [('name',100),('summary',300),('category',40),('version',80),('source',200),('icon',30)]:
            text(r.get(key), limit, '资源字段')
        url(r.get('url')); tags(r.get('platforms'))
        if r.get('article') not in slugs: abort(400, description='资源关联教程不存在')
        if 'architecture' in r:text(r['architecture'],80,'适用架构',empty=True)
        if 'file_size' in r and (type(r['file_size']) is not int or r['file_size']<0):abort(400,description='文件大小错误')
        if r.get('sha256') and not re.fullmatch(r'[a-f0-9]{64}',r['sha256']):abort(400,description='文件摘要错误')
    for n in data['announcements']:
        for key, limit in [('id',100),('title',200),('summary',5000),('date',30),('tag',40)]:
            text(n.get(key), limit, '公告字段')
        url(n.get('href'))
        if type(n.get('pinned')) is not bool: abort(400, description='公告属性错误')
    if not any(n['enabled'] and n['url'] == '/' for n in data['navigation']):
        abort(400, description='请至少保留一个启用的首页导航')
    return data


def tags(values):
    if not isinstance(values, list) or len(values) > 12:
        abort(400, description='标签格式错误')
    for value in values: text(value, 50, '标签')


def create_app(config=None):
    app = Flask(__name__)
    app.config.update(DATA_DIR=os.environ.get('PORTAL_DATA_DIR', '/var/lib/shiny-portal'),
                      SEED_PATH=os.environ.get('PORTAL_SEED_PATH', str(Path(__file__).parent / 'seed.json')),
                      NEWAPI_URL=os.environ.get('PORTAL_NEWAPI_URL', 'http://127.0.0.1:3000'),
                      ALLOWED_ORIGIN=os.environ.get('PORTAL_ORIGIN', 'https://shinyapi.com'),
                      SNAPSHOT_DIR=os.environ.get('PORTAL_SNAPSHOT_DIR',''),
                      MAX_CONTENT_LENGTH=21 * 1024 * 1024, MAX_FORM_MEMORY_SIZE=1024*1024)
    if config: app.config.update(config)
    root = Path(app.config['DATA_DIR']); root.mkdir(parents=True, exist_ok=True)
    uploads = root / 'uploads'; uploads.mkdir(exist_ok=True)
    db_path = root / 'content.sqlite'

    @contextlib.contextmanager
    def connect():
        db = sqlite3.connect(db_path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        try:
            with db:
                yield db
        finally:
            db.close()

    with connect() as db:
        db.executescript('''
            CREATE TABLE IF NOT EXISTS content (name TEXT PRIMARY KEY, value TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, value TEXT NOT NULL, published_at INTEGER NOT NULL, actor INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, actor INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, action TEXT NOT NULL, actor INTEGER NOT NULL, created_at INTEGER NOT NULL, revision INTEGER, detail TEXT NOT NULL);
        ''')
        if not db.execute('SELECT 1 FROM content LIMIT 1').fetchone():
            with app.app_context():
                seed = validate_content(json.loads(Path(app.config['SEED_PATH']).read_text(encoding='utf-8')))
            value = json.dumps(seed, ensure_ascii=False)
            db.executemany('INSERT INTO content VALUES (?,?,1,?)', [('draft',value,int(time.time())),('published',value,int(time.time()))])
            db.execute('INSERT INTO history(value,published_at,actor) VALUES(?,?,0)',(value,int(time.time())))

    @app.before_request
    def guard_origin():
        if request.method not in ['GET','HEAD','OPTIONS']:
            if request.headers.get('Origin') != app.config['ALLOWED_ORIGIN'] or request.headers.get('X-Portal-Request') != '1':
                abort(403, description='写入请求必须来自本站管理页面')

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['Cache-Control'] = 'no-store' if '/admin/' in request.path else response.headers.get('Cache-Control','no-cache')
        return response

    @app.errorhandler(Exception)
    def error(exc):
        if isinstance(exc, HTTPException): return jsonify(success=False, message=exc.description),exc.code
        app.logger.error('portal request failed: %s',type(exc).__name__)
        return jsonify(success=False,message='内容服务暂时不可用'),503

    def fetch_json(path, token=None):
        # Destination is fixed configuration, never taken from browser input.
        headers={'Accept':'application/json'}
        if token: headers['Authorization']=token
        req=urllib.request.Request(app.config['NEWAPI_URL']+path,headers=headers)
        with urllib.request.urlopen(req, timeout=4) as response:
            return json.loads(response.read(2*1024*1024))

    def administrator(fn):
        @functools.wraps(fn)
        def wrapped(*args,**kwargs):
            token=request.headers.get('Authorization','')
            if not token.startswith('Bearer ') or len(token)>8192: abort(401,description='请先登录 Shiny 管理员账号')
            try:
                result=fetch_json('/api/user/self',token)
                # /self also accepts scoped PATs. Site publishing must require
                # the existing browser-session boundary, not just a root role.
                session_result=fetch_json('/api/user/sessions',token)
                if not session_result.get('success'):abort(403,description='请使用浏览器管理员会话')
            except urllib.error.HTTPError as e:
                status=e.code;e.close()
                abort(401 if status==401 else 403 if status==403 else 503,description='登录状态校验失败，请刷新登录')
            except Exception: abort(503,description='登录服务暂时不可用，请稍后重试')
            user=result.get('data',{})
            if not result.get('success') or user.get('status')!=1: abort(401,description='登录已失效')
            # Site configuration belongs to the New API root administrator.
            if user.get('role')!=100: abort(403,description='仅站点超级管理员可以管理内容')
            g.actor=user['id'];g.username=user.get('display_name') or user.get('username')
            return fn(*args,**kwargs)
        return wrapped

    def record(db,action,revision=None,detail=''):
        db.execute('INSERT INTO audit(action,actor,created_at,revision,detail) VALUES(?,?,?,?,?)',(action,g.actor,int(time.time()),revision,detail))

    def row_content(db,name):
        row=db.execute('SELECT * FROM content WHERE name=?',(name,)).fetchone()
        return json.loads(row['value']),row['revision']

    def snapshot(data):
        if not app.config['SNAPSHOT_DIR']:return
        folder=Path(app.config['SNAPSHOT_DIR']);folder.mkdir(parents=True,exist_ok=True)
        encoded=json.dumps(data,ensure_ascii=False)
        current=folder/'content.json'
        try:
            if current.read_text(encoding='utf-8')==encoded:return
        except OSError:pass
        temp=folder/('content-'+secrets.token_hex(6)+'.tmp')
        try:
            temp.write_text(encoded,encoding='utf-8')
            temp.chmod(0o644);os.replace(temp,folder/'content.json')
        finally:temp.unlink(missing_ok=True)

    status_cache={'time':0,'announcements':[]}; status_lock=threading.Lock()
    def announcements():
        if time.monotonic()-status_cache['time']<60:return copy.deepcopy(status_cache['announcements'])
        if not status_lock.acquire(blocking=False):return copy.deepcopy(status_cache['announcements'])
        try:
            status=fetch_json('/api/status')
            if not status.get('success'):raise ValueError()
            data=status.get('data',{}); items=[]
            if data.get('announcements_enabled'):
                for n in data.get('announcements',[])[:100]:
                    body=str(n.get('content','')).strip()
                    if not body:continue
                    title=str(n.get('title') or body.split('\n')[0])[:90]
                    items.append({'id':'newapi-'+str(n.get('id',len(items))), 'title':title,'summary':body[:5000],
                                  'date':str(n.get('publishDate',''))[:10],'tag':'站点公告','pinned':False,'href':'/announcements/'})
            status_cache['announcements']=items
            # Persist last known public data so a restart during New API failure
            # does not discard the last published announcement snapshot.
            snapshot=root/'announcements.json';tmp=root/('announcements-'+secrets.token_hex(5)+'.tmp')
            tmp.write_text(json.dumps(items,ensure_ascii=False),encoding='utf-8');os.replace(tmp,snapshot)
        except Exception:
            if not status_cache['announcements']:
                try:status_cache['announcements']=json.loads((root/'announcements.json').read_text(encoding='utf-8'))
                except (OSError,ValueError):pass
        finally:
            status_cache['time']=time.monotonic();status_lock.release()
        return copy.deepcopy(status_cache['announcements'])

    @app.get('/portal-api/health')
    def health():
        with connect() as db: db.execute('SELECT 1').fetchone()
        return jsonify(success=True,service='shiny-portal',storage='local',version='1.2.0',editor_format=2,r2_supported=True)

    @app.get('/portal-api/content')
    def public_content():
        with connect() as db:data,revision=row_content(db,'published')
        data['announcements']=announcements()+data['announcements']
        snapshot(data)
        response=jsonify(data)
        response.set_etag(hashlib.sha256(response.data).hexdigest())
        response.headers['Cache-Control']='public, max-age=30, stale-if-error=300'
        return response.make_conditional(request)

    @app.get('/portal-api/admin/session')
    @administrator
    def session():return jsonify(success=True,data={'id':g.actor,'name':g.username})

    @app.get('/portal-api/admin/content')
    @administrator
    def admin_content():
        with connect() as db:
            data,rev=row_content(db,'draft');pub,pubrev=row_content(db,'published')
            histories=[dict(r) for r in db.execute('SELECT id,published_at,actor FROM history ORDER BY id DESC LIMIT 20')]
        return jsonify(success=True,data={'draft':data,'published':pub,'revision':rev,'publishedRevision':pubrev,'history':histories})

    @app.put('/portal-api/admin/content')
    @administrator
    def save():
        if request.headers.get('X-Portal-Editor') != 'markdown-v2':
            abort(409, description='编辑器已更新，请刷新整个网页后再保存，避免旧页面覆盖新格式正文')
        if request.content_length and request.content_length>2*1024*1024:abort(413,description='内容超过 2 MB')
        body=request.get_json();data=validate_content(body.get('content'));rev=body.get('revision')
        if type(rev) is not int:abort(400,description='缺少版本信息')
        value=json.dumps(data,ensure_ascii=False)
        if len(value.encode())>2*1024*1024:abort(413,description='内容超过 2 MB')
        with connect() as db:
            cursor=db.execute('UPDATE content SET value=?, revision=revision+1, updated_at=? WHERE name=\'draft\' AND revision=?',(value,int(time.time()),rev))
            if cursor.rowcount!=1:abort(409,description='内容已被其他窗口修改，请刷新后再编辑')
            record(db,'draft_saved',rev+1)
        return jsonify(success=True,revision=rev+1)

    @app.post('/portal-api/admin/resources/batch')
    @administrator
    def save_resource_batch():
        if request.content_length and request.content_length>256*1024:abort(413,description='资源请求过大')
        body=request.get_json(silent=True) or {}
        changes=body.get('changes') if isinstance(body,dict) else None
        if not isinstance(changes,list) or not 1<=len(changes)<=20:abort(400,description='每次保存 1 至 20 个资源')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');data,rev=row_content(db,'draft');seen=set();changed=False
            for entry in changes:
                if not isinstance(entry,dict) or set(entry)!={'resource','base'} or not isinstance(entry['resource'],dict):abort(400,description='资源变更格式错误')
                resource=entry['resource'];ident=text(resource.get('id'),100,'资源标识');base=entry['base']
                if ident in seen or (base is not None and (not isinstance(base,dict) or base.get('id')!=ident)):abort(400,description='资源标识重复或基准错误')
                seen.add(ident)
                index=next((i for i,r in enumerate(data['resources']) if r['id']==ident),None)
                current=data['resources'][index] if index is not None else None
                if current==resource:continue
                if current!=base:abort(409,description='这项资源已被其他窗口修改，请保留上传结果并核对该资源后再保存')
                # Recovered uploads should not produce duplicate download entries.
                if current is None and any(r['url']==resource.get('url') for r in data['resources']):abort(409,description='该文件链接已在资源库中，请编辑已有资源')
                if index is None:data['resources'].append(resource)
                else:data['resources'][index]=resource
                changed=True
            validate_content(data);value=json.dumps(data,ensure_ascii=False)
            if len(value.encode())>2*1024*1024:abort(413,description='内容超过 2 MB')
            if changed:
                rev+=1;db.execute('UPDATE content SET value=?,revision=?,updated_at=? WHERE name=\'draft\'',(value,rev,int(time.time())))
                record(db,'resources_saved',rev,','.join(seen))
            published,pubrev=row_content(db,'published')
            history=[dict(r) for r in db.execute('SELECT id,published_at,actor FROM history ORDER BY id DESC LIMIT 20')]
        return jsonify(success=True,data={'draft':data,'published':published,'revision':rev,'publishedRevision':pubrev,'history':history})

    @app.post('/portal-api/admin/publish')
    @administrator
    def publish():
        expected=request.get_json().get('revision')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');data,rev=row_content(db,'draft')
            if type(expected) is not int or expected!=rev:abort(409,description='草稿已发生变化，请刷新确认后发布')
            validate_content(data);value=json.dumps(data,ensure_ascii=False)
            # Reject broken local file references before publishing them.
            for ident in re.findall(r'/portal-api/files/([a-f0-9]{32})',value):
                if not db.execute('SELECT 1 FROM files WHERE id=?',(ident,)).fetchone() or not (uploads/ident).is_file():
                    abort(400,description='附件不存在，无法发布')
            db.execute('UPDATE content SET value=?,revision=?,updated_at=? WHERE name=\'published\'',(value,rev,int(time.time())))
            db.execute('INSERT INTO history(value,published_at,actor) VALUES(?,?,?)',(value,int(time.time()),g.actor));record(db,'published',rev)
        public=copy.deepcopy(data);public['announcements']=announcements()+public['announcements'];snapshot(public)
        return jsonify(success=True,revision=rev)

    @app.post('/portal-api/admin/restore/<int:ident>')
    @administrator
    def restore(ident):
        expected=request.get_json().get('revision')
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');_,rev=row_content(db,'draft')
            if type(expected) is not int or expected!=rev:abort(409,description='草稿已变化，请刷新')
            row=db.execute('SELECT value FROM history WHERE id=?',(ident,)).fetchone()
            if row is None:abort(404,description='历史版本不存在')
            db.execute('UPDATE content SET value=?,revision=revision+1,updated_at=? WHERE name=\'draft\'',(row['value'],int(time.time())))
            record(db,'restored_to_draft',rev+1,str(ident))
        return jsonify(success=True,revision=rev+1)

    @app.delete('/portal-api/admin/articles/<slug>')
    @administrator
    def delete_draft_article(slug):
        if not SLUG.fullmatch(slug):abort(404,description='教程不存在')
        body=request.get_json(silent=True) or {}
        expected=body.get('revision') if isinstance(body,dict) else None
        with connect() as db:
            db.execute('BEGIN IMMEDIATE');data,rev=row_content(db,'draft')
            if type(expected) is not int or expected!=rev:abort(409,description='草稿已变化，请刷新后再删除')
            article=next((a for a in data['articles'] if a['slug']==slug),None)
            if article is None:abort(404,description='教程不存在或已从草稿移除')
            references=[r['name'] for r in data['resources'] if r['article']==slug]
            if references:abort(409,description='请先在资源管理中更换或移除关联教程：'+'、'.join(references[:5]))
            published,_=row_content(db,'published')
            was_published=any(a['slug']==slug for a in published['articles'])
            data['articles']=[a for a in data['articles'] if a['slug']!=slug]
            validate_content(data)
            db.execute('UPDATE content SET value=?,revision=revision+1,updated_at=? WHERE name=\'draft\'',(json.dumps(data,ensure_ascii=False),int(time.time())))
            record(db,'article_removed_from_draft',rev+1,slug)
        # Published content, history and physical attachments are intentionally retained.
        return jsonify(success=True,revision=rev+1,wasPublished=was_published)

    @app.post('/portal-api/admin/upload')
    @administrator
    def upload():
        f=request.files.get('file')
        if not f or not f.filename:abort(400,description='请选择文件')
        name=text(f.filename.replace('\\','/').split('/')[-1],180,'文件名')
        ext=Path(name).suffix.lower()
        if ext not in MIMES:abort(400,description='不支持的附件类型')
        raw=f.read(20*1024*1024+1)
        if not raw or len(raw)>20*1024*1024:abort(413,description='附件应为 1 字节至 20 MB')
        if ext=='.pdf' and not raw.startswith(b'%PDF-'):abort(400,description='PDF 格式不正确')
        if ext=='.png' and not raw.startswith(b'\x89PNG\r\n\x1a\n'):abort(400,description='PNG 格式不正确')
        if ext in ['.jpg','.jpeg'] and not raw.startswith(b'\xff\xd8\xff'):abort(400,description='JPEG 格式不正确')
        if ext=='.webp' and not (raw[:4]==b'RIFF' and raw[8:12]==b'WEBP'):abort(400,description='WebP 格式不正确')
        if ext in ['.zip','.docx']:
            try:
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    if ext=='.docx' and not all(n in archive.namelist() for n in ['[Content_Types].xml','word/document.xml']):raise ValueError()
            except (zipfile.BadZipFile,ValueError):abort(400,description='压缩包或 DOCX 格式不正确')
        if ext in ['.md','.json']:
            try:
                decoded=raw.decode('utf-8-sig')
                if ext=='.json':json.loads(decoded)
            except (ValueError,UnicodeError):abort(400,description='请上传 UTF-8 文本或有效 JSON')
        ident=secrets.token_hex(16);digest=hashlib.sha256(raw).hexdigest();target=uploads/ident
        try:
            with target.open('xb') as out:out.write(raw)
            target.chmod(0o600)
            with connect() as db:
                db.execute('INSERT INTO files VALUES(?,?,?,?,?,?,?)',(ident,name,len(raw),digest,MIMES[ext],int(time.time()),g.actor))
                record(db,'uploaded',detail=ident)
        except Exception:
            target.unlink(missing_ok=True);raise
        return jsonify(success=True,data={'id':ident,'name':name,'size':len(raw),'sha256':digest,'mime':MIMES[ext],'url':'/portal-api/files/'+ident,'storage':'local'})

    @app.get('/portal-api/files/<ident>')
    def file(ident):
        if not FILE_ID.fullmatch(ident):abort(404)
        with connect() as db:
            # Random IDs alone are not access control: drafts stay private.
            data,_=row_content(db,'published')
            if '/portal-api/files/'+ident not in json.dumps(data,ensure_ascii=False):abort(404)
            row=db.execute('SELECT * FROM files WHERE id=?',(ident,)).fetchone()
        if row is None or not (uploads/ident).is_file():abort(404)
        response=send_file(uploads/ident,mimetype=row['mime'],as_attachment=not row['mime'].startswith('image/'),download_name=row['name'],etag=row['sha256'],max_age=86400,conditional=True)
        response.headers['Content-Security-Policy']="default-src 'none'; sandbox"
        return response

    @app.get('/portal-api/admin/files/<ident>')
    @administrator
    def draft_file(ident):
        if not FILE_ID.fullmatch(ident):abort(404)
        with connect() as db:row=db.execute('SELECT * FROM files WHERE id=?',(ident,)).fetchone()
        if row is None or not (uploads/ident).is_file():abort(404)
        response=send_file(uploads/ident,mimetype=row['mime'],as_attachment=not row['mime'].startswith('image/'),download_name=row['name'],conditional=False)
        response.headers['Cache-Control']='no-store'
        response.headers['Content-Security-Policy']="default-src 'none'; sandbox"
        return response

    register_r2(app,connect,administrator,record)
    return app
