"""Private R2 configuration and signed uploads; never part of public content."""
import contextlib
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import quote, urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from flask import abort, g, jsonify, request
from werkzeug.utils import secure_filename
from r2_multipart import MultipartUploads, SessionLocks

MAX_R2_BYTES=512*1024*1024
DEFAULT_R2_FILE_MB=10240
R2_MIMES={'.zip':'application/zip','.7z':'application/x-7z-compressed','.gz':'application/gzip',
          '.xz':'application/x-xz','.tar':'application/x-tar','.exe':'application/octet-stream',
          '.msi':'application/octet-stream','.dmg':'application/x-apple-diskimage','.pkg':'application/octet-stream',
          '.deb':'application/vnd.debian.binary-package','.rpm':'application/x-rpm','.appimage':'application/octet-stream',
          '.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.md':'text/markdown','.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
          '.jpeg':'image/jpeg','.webp':'image/webp'}


class R2Settings:
    def __init__(self,path,origin,client_factory=None):
        self.path=Path(path);self.origin=origin;self.lock=threading.RLock();self.client_factory=client_factory

    def read(self):
        with self.lock:
            try:
                data=json.loads(self.path.read_text(encoding='utf-8'))
                data.setdefault('maxFileMB',DEFAULT_R2_FILE_MB)
                return data
            except FileNotFoundError:return {'revision':0,'enabled':False,'accountId':'','bucket':'','publicBase':'','prefix':'downloads','accessKeyId':'','secretAccessKey':'','maxFileMB':DEFAULT_R2_FILE_MB}
            except (ValueError,OSError):abort(503,description='R2 私有配置读取失败，请联系管理员')

    def cors(self):
        return [{'AllowedOrigins':[self.origin],'AllowedMethods':['PUT','GET','HEAD'],
                 'AllowedHeaders':['content-type','content-disposition','x-amz-meta-portal-upload-id'],
                 'ExposeHeaders':['ETag'],'MaxAgeSeconds':3600}]

    def public(self):
        data=self.read()
        return {k:data[k] for k in ['revision','enabled','accountId','bucket','publicBase','prefix']} | {
            'hasCredentials':bool(data.get('accessKeyId') and data.get('secretAccessKey')),
            'keySuffix':data.get('accessKeyId','')[-4:], 'maxFileMB':data['maxFileMB'],
            'extensions':list(R2_MIMES),'cors':self.cors()}

    def save(self,body):
        if not isinstance(body,dict):abort(400,description='存储配置格式错误')
        allowed={'revision','enabled','accountId','bucket','publicBase','prefix','accessKeyId','secretAccessKey','maxFileMB'}
        if set(body)-allowed:abort(400,description='存储配置字段错误')
        with self.lock:
            old=self.read()
            if type(body.get('revision')) is not int or body['revision']!=old['revision']:abort(409,description='存储设置已变化，请刷新后重新填写')
            data={k:body.get(k,old.get(k,'')) for k in allowed if k!='revision'}
            if type(data['enabled']) is not bool:abort(400,description='启用状态错误')
            if type(data['maxFileMB']) is not int or not 512<=data['maxFileMB']<=102400:abort(400,description='R2 单文件上限应为 512 至 102400 MB 的整数')
            for key in ['accountId','bucket','publicBase','prefix','accessKeyId','secretAccessKey']:
                if not isinstance(data[key],str) or len(data[key])>2048 or any(ord(c)<32 for c in data[key]):abort(400,description='存储配置包含无效字段')
                data[key]=data[key].strip()
            if bool(data['accessKeyId'])!=bool(data['secretAccessKey']):abort(400,description='更换密钥时请同时填写 Access Key ID 和 Secret Access Key')
            if not data['accessKeyId']:
                data['accessKeyId']=old.get('accessKeyId','');data['secretAccessKey']=old.get('secretAccessKey','')
            elif not all(16<=len(data[k])<=256 for k in ['accessKeyId','secretAccessKey']):abort(400,description='R2 密钥长度不正确')
            if data['accountId'] and not re.fullmatch(r'[a-fA-F0-9]{32}',data['accountId']):abort(400,description='Account ID 应为 32 位十六进制字符')
            if data['bucket'] and not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]',data['bucket']):abort(400,description='请填写有效的 R2 桶名')
            data['prefix']=data['prefix'].strip('/') or 'downloads'
            if not re.fullmatch(r'[a-zA-Z0-9_-]+(?:/[a-zA-Z0-9_-]+)*',data['prefix']) or len(data['prefix'])>180:abort(400,description='目录前缀只支持字母、数字、短横线、下划线和斜杠')
            if data['publicBase']:
                try:u=urlsplit(data['publicBase'])
                except ValueError:abort(400,description='公开域名格式错误')
                if u.scheme!='https' or not u.hostname or u.username or u.password or u.query or u.fragment or '\\' in data['publicBase']:abort(400,description='公开地址需要不带查询参数的 HTTPS 域名或路径')
                data['publicBase']=data['publicBase'].rstrip('/')
            if data['enabled'] and not all(data.get(k) for k in ['accountId','bucket','publicBase','accessKeyId','secretAccessKey']):abort(400,description='启用 R2 前请补齐 Account ID、桶名、公开域名和密钥')
            data['revision']=old['revision']+1
            temp=self.path.with_name('.r2-settings-'+secrets.token_hex(6)+'.tmp')
            try:
                fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                with os.fdopen(fd,'w',encoding='utf-8') as handle:
                    json.dump(data,handle,ensure_ascii=False);handle.flush();os.fsync(handle.fileno())
                os.replace(temp,self.path);self.path.chmod(0o600)
            finally:temp.unlink(missing_ok=True)
            return self.public()

    def client(self,data=None):
        data=data or self.read()
        if not data.get('enabled'):abort(409,description='R2 尚未启用，请先到存储设置完成配置')
        if self.client_factory:return self.client_factory(data)
        return boto3.client('s3',endpoint_url='https://'+data['accountId']+'.r2.cloudflarestorage.com',
            aws_access_key_id=data['accessKeyId'],aws_secret_access_key=data['secretAccessKey'],region_name='auto',
            config=Config(signature_version='s3v4',connect_timeout=4,read_timeout=12,retries={'max_attempts':1},s3={'addressing_style':'path'},
                          request_checksum_calculation='when_required',response_checksum_validation='when_required'))

    def cors_status(self,client,data):
        try:rules=client.get_bucket_cors(Bucket=data['bucket']).get('CORSRules',[])
        except ClientError as error:
            code=error.response.get('Error',{}).get('Code','')
            if code=='NoSuchCORSConfiguration':return {'ready':False,'message':'桶未配置 CORS，浏览器上传会失败。请将下方 CORS JSON 保存到 Cloudflare 对应桶。'}
            return {'ready':None,'message':'当前密钥不能读取桶的 CORS 设置，请在 Cloudflare 桶设置中核对下方 JSON。'}
        required={'content-type','content-disposition','x-amz-meta-portal-upload-id'}
        for rule in rules:
            origins=rule.get('AllowedOrigins',[]);headers={h.lower() for h in rule.get('AllowedHeaders',[])}
            if self.origin in origins or '*' in origins:
                if 'PUT' in rule.get('AllowedMethods',[]) and ('*' in headers or required<=headers):
                    return {'ready':True,'message':'CORS 已允许本站签名 PUT 上传。'}
        return {'ready':False,'message':'桶的 CORS 未完整允许本站 Origin、PUT 方法或上传请求头，请按下方 JSON 核对。'}


@contextlib.contextmanager
def r2_errors():
    try:yield
    except ClientError as error:
        code=error.response.get('Error',{}).get('Code','')
        if code in ['AccessDenied','InvalidAccessKeyId','SignatureDoesNotMatch']:message='R2 拒绝访问，请检查密钥及桶的对象读写权限'
        elif code in ['NoSuchBucket','NotFound','404']:message='R2 桶或上传对象不存在，请检查配置或先完成上传'
        else:message='R2 操作未成功，请检查存储设置和连接后重试'
        abort(502,description=message)
    except BotoCoreError:abort(502,description='R2 连接失败，请检查 Account ID、网络及密钥')


def register_r2(app,connect,administrator,record):
    settings=R2Settings(Path(app.config['DATA_DIR'])/'r2-settings.json',app.config['ALLOWED_ORIGIN'],app.config.get('R2_CLIENT_FACTORY'))
    app.extensions['r2_settings']=settings
    with connect() as db:
        db.execute('''CREATE TABLE IF NOT EXISTS r2_uploads (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, object_key TEXT NOT NULL, size INTEGER NOT NULL,
            mime TEXT NOT NULL, public_url TEXT NOT NULL, settings_revision INTEGER NOT NULL,
            state TEXT NOT NULL, created_at INTEGER NOT NULL, actor INTEGER NOT NULL, etag TEXT)''')

    def file_data(row):
        return {'id':row['id'],'name':row['name'],'size':row['size'],'mime':row['mime'],
                'url':row['public_url'],'storage':'r2','etag':row['etag'] or ''}

    locks=SessionLocks()
    multipart=MultipartUploads(app,connect,administrator,record,settings,file_data,locks,r2_errors)

    @app.get('/portal-api/admin/storage')
    @administrator
    def get_storage():return jsonify(success=True,data=settings.public())

    @app.put('/portal-api/admin/storage')
    @administrator
    def save_storage():
        if request.content_length and request.content_length>16384:abort(413,description='配置请求过大')
        result=settings.save(request.get_json(silent=True))
        with connect() as db:record(db,'storage_settings_saved',detail='R2 enabled='+str(result['enabled']))
        return jsonify(success=True,data=result)

    @app.post('/portal-api/admin/storage/test')
    @administrator
    def test_storage():
        data=settings.read();client=settings.client(data)
        key=data['prefix']+'/_connection-check/'+secrets.token_hex(16)+'.txt';payload=b'Shiny R2 connectivity check\n'
        with r2_errors():
            created=False
            try:
                client.put_object(Bucket=data['bucket'],Key=key,Body=payload,ContentType='text/plain',ContentDisposition='attachment');created=True
                head=client.head_object(Bucket=data['bucket'],Key=key)
                if head['ContentLength']!=len(payload):abort(502,description='R2 写入校验失败')
            finally:
                if created:client.delete_object(Bucket=data['bucket'],Key=key)
        with r2_errors():cors=settings.cors_status(client,data)
        with connect() as db:record(db,'storage_connection_test',detail='R2 read/write/delete passed; CORS='+str(cors['ready']))
        return jsonify(success=True,cors=cors,message='R2 桶读写测试通过。'+cors['message']+' 公开域名和本机网络仍需通过实际上传、下载验证。')

    @app.post('/portal-api/admin/r2/uploads')
    @administrator
    def start_upload():
        body=request.get_json(silent=True) or {}
        if not isinstance(body,dict):abort(400,description='上传参数错误')
        name=body.get('name');size=body.get('size')
        if not isinstance(name,str) or not 1<=len(name)<=180 or any(ord(c)<32 for c in name) or '/' in name or '\\' in name:abort(400,description='文件名不合法')
        ext=Path(name).suffix.lower()
        if ext not in R2_MIMES:abort(400,description='不支持的公开资源文件类型')
        protocol=body.get('protocol',1)
        if type(protocol) is not int or protocol not in [1,2]:abort(400,description='上传协议版本不正确，请刷新页面')
        if protocol==2:
            if not isinstance(body.get('fingerprint'),str) or not re.fullmatch(r'[a-f0-9]{64}',body['fingerprint']):abort(400,description='文件指纹格式不正确')
            if type(body.get('lastModified')) is not int or not 0<=body['lastModified']<=9007199254740991:abort(400,description='文件修改时间不正确')
        data=settings.read()
        maximum=data['maxFileMB']*1024*1024 if protocol==2 else min(MAX_R2_BYTES,data['maxFileMB']*1024*1024)
        if type(size) is not int or not 0<size<=maximum:abort(413,description=f'R2 单文件应为 1 字节至 {maximum//(1024*1024)} MB，请使用新版页面上传大文件')
        client=settings.client(data);ident=secrets.token_hex(16)
        filename=secure_filename(name) or 'resource'+ext
        if not filename.lower().endswith(ext):filename='resource'+ext
        key=data['prefix']+'/'+time.strftime('%Y/%m',time.gmtime())+'/'+ident+'/'+filename
        public_url=data['publicBase']+'/'+quote(key,safe='/')
        disposition='attachment; filename="'+filename+'"; filename*=UTF-8\'\''+quote(name,safe='')
        if protocol==2 and size>64*1024*1024:
            return jsonify(success=True,data=multipart.create(ident,name,key,size,R2_MIMES[ext],public_url,disposition,body,data))
        with r2_errors():signed=client.generate_presigned_url('put_object',Params={'Bucket':data['bucket'],'Key':key,'ContentType':R2_MIMES[ext],
            'ContentDisposition':disposition,'Metadata':{'portal-upload-id':ident}},ExpiresIn=900,HttpMethod='PUT')
        with connect() as db:
            db.execute("INSERT INTO r2_uploads (id,name,object_key,size,mime,public_url,settings_revision,state,created_at,actor,etag) VALUES (?,?,?,?,?,?,?,'pending',?,?,NULL)",(ident,name,key,size,R2_MIMES[ext],public_url,data['revision'],int(time.time()),g.actor))
            record(db,'r2_upload_started',detail=ident)
        return jsonify(success=True,data={'id':ident,'mode':'single','uploadUrl':signed,'headers':{'Content-Type':R2_MIMES[ext],'Content-Disposition':disposition,'x-amz-meta-portal-upload-id':ident},'expiresIn':900})

    @app.get('/portal-api/admin/r2/uploads/completed')
    @administrator
    def recoverable_uploads():
        with connect() as db:
            urls=set()
            for record_content in db.execute('SELECT value FROM content'):
                urls.update(r['url'] for r in json.loads(record_content['value'])['resources'])
            files=[]
            for row in db.execute('SELECT * FROM r2_uploads WHERE state=\'complete\' AND actor=? ORDER BY created_at DESC',(g.actor,)):
                if row['public_url'] not in urls:
                    files.append(file_data(row)|{'createdAt':row['created_at']})
                    if len(files)>=50:break
        return jsonify(success=True,data=files)

    def pending(ident):
        if not re.fullmatch(r'[a-f0-9]{32}',ident):abort(404)
        with connect() as db:row=db.execute("SELECT u.*, CASE WHEN EXISTS (SELECT 1 FROM r2_multipart m WHERE m.id=u.id) THEN 'multipart' ELSE 'single' END AS mode FROM r2_uploads u WHERE u.id=? AND u.actor=?",(ident,g.actor)).fetchone()
        if row is None:abort(404,description='上传记录不存在')
        return row

    @app.post('/portal-api/admin/r2/uploads/<ident>/complete')
    @administrator
    def complete_upload(ident):
        with locks.hold(ident),settings.lock:return complete_upload_locked(ident)

    def complete_upload_locked(ident):
        row=pending(ident)
        if row['mode']=='multipart':return jsonify(success=True,data=multipart.complete(row))
        if row['state']=='complete':return jsonify(success=True,data=file_data(row))
        if row['state']!='pending':abort(409,description='这次上传已取消')
        data=settings.read()
        if data['revision']!=row['settings_revision']:abort(409,description='上传期间存储配置已变化，请重新上传')
        client=settings.client(data)
        with r2_errors():head=client.head_object(Bucket=data['bucket'],Key=row['object_key'])
        metadata={k.lower():v for k,v in head.get('Metadata',{}).items()}
        if head.get('ContentLength')!=row['size'] or head.get('ContentType')!=row['mime'] or metadata.get('portal-upload-id')!=ident:
            abort(400,description='R2 文件大小或元数据不匹配，请取消后重新上传')
        with connect() as db:
            db.execute('UPDATE r2_uploads SET state=\'complete\',etag=? WHERE id=? AND state=\'pending\'',(head.get('ETag','')[:200],ident))
            updated=db.execute('SELECT * FROM r2_uploads WHERE id=?',(ident,)).fetchone()
            if updated['state']!='complete':abort(409,description='上传状态已变化，请刷新资源列表')
            record(db,'r2_upload_completed',detail=ident)
        return jsonify(success=True,data=file_data(updated))

    @app.post('/portal-api/admin/r2/uploads/<ident>/abort')
    @administrator
    def abort_upload(ident):
        with locks.hold(ident),settings.lock:return abort_upload_locked(ident)

    def abort_upload_locked(ident):
        row=pending(ident)
        if row['mode']=='multipart':
            multipart.abort(row)
            return jsonify(success=True)
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM r2_uploads WHERE id=? AND actor=?',(ident,g.actor)).fetchone()
            if row is None:abort(404)
            if row['state']=='complete':abort(409,description='已完成文件不会自动删除，请到 R2 管理其生命周期')
            data=settings.read()
            if data['revision']!=row['settings_revision']:abort(409,description='配置已变更，请在原桶中清理未完成文件')
            client=settings.client(data)
            with r2_errors():client.delete_object(Bucket=data['bucket'],Key=row['object_key'])
            db.execute('UPDATE r2_uploads SET state=\'aborted\' WHERE id=?',(ident,))
            record(db,'r2_upload_aborted',detail=ident)
        return jsonify(success=True)
