"""Durable R2 multipart control plane. File bytes travel browser -> R2 only.

The portal currently runs one worker with threaded requests. SessionLocks covers
all complete/abort/part operations, and durable ``completing`` state plus HEAD
reconciliation survives a process restart or a lost S3 completion response.
"""
import contextlib
import re
import threading
import time

from botocore.exceptions import BotoCoreError, ClientError
from flask import abort, g, jsonify, request

PART_SIZE=32*1024*1024
SESSION_TTL=7*24*60*60


class SessionLocks:
    def __init__(self):
        self.guard=threading.Lock()
        self.entries={}

    @contextlib.contextmanager
    def hold(self,ident):
        # Refcounts include waiters; removing an idle lock cannot race a waiter.
        with self.guard:
            entry=self.entries.setdefault(ident,[threading.RLock(),0])
            entry[1]+=1
        try:
            with entry[0]:yield
        finally:
            with self.guard:
                entry[1]-=1
                if not entry[1]:del self.entries[ident]


def error_code(error):
    return error.response.get('Error',{}).get('Code','')


class MultipartUploads:
    def __init__(self,app,connect,administrator,record,settings,file_data,locks,r2_errors):
        self.connect=connect;self.record=record;self.settings=settings
        self.file_data=file_data;self.locks=locks;self.r2_errors=r2_errors
        with connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS r2_multipart (
                    id TEXT PRIMARY KEY, upload_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, last_modified INTEGER NOT NULL,
                    part_size INTEGER NOT NULL, expires_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS r2_multipart_parts (
                    id TEXT NOT NULL, part_number INTEGER NOT NULL, sha256 TEXT NOT NULL,
                    PRIMARY KEY (id,part_number));
                CREATE INDEX IF NOT EXISTS r2_uploads_actor_state ON r2_uploads(actor,state,created_at);
            ''')

        @app.get('/portal-api/admin/r2/uploads/pending')
        @administrator
        def pending_multipart():
            with connect() as db:
                rows=db.execute(self.select+" WHERE u.actor=? AND u.state IN ('pending','completing','expired','missing') ORDER BY u.created_at DESC LIMIT 100",(g.actor,)).fetchall()
            return jsonify(success=True,data=[self.describe(row) for row in rows])

        @app.get('/portal-api/admin/r2/uploads/<ident>')
        @administrator
        def multipart_status(ident):
            with locks.hold(ident):
                row=self.row(ident)
                if row['state']=='complete':return jsonify(success=True,data=self.describe(row))
                if row['state']=='aborted':return jsonify(success=True,data=self.describe(row))
                with settings.lock:
                    data,client=self.storage(row)
                    parts=self.list_parts(row,data,client)
                row=self.row(ident)
                return jsonify(success=True,data=self.describe(row,parts))

        @app.post('/portal-api/admin/r2/uploads/<ident>/parts')
        @administrator
        def multipart_sign_part(ident):
            body=request.get_json(silent=True)
            if not isinstance(body,dict):abort(400,description='分片参数不正确')
            number=body.get('partNumber');digest=body.get('sha256')
            if type(number) is not int or not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):abort(400,description='分片序号或 SHA256 不正确')
            with locks.hold(ident),settings.lock:
                row=self.row(ident)
                self.require_pending(row)
                if not 1<=number<=self.part_count(row):abort(400,description='分片序号超出文件范围')
                data,client=self.storage(row)
                with connect() as db:
                    db.execute('INSERT OR IGNORE INTO r2_multipart_parts(id,part_number,sha256) VALUES(?,?,?)',(ident,number,digest))
                    saved=db.execute('SELECT sha256 FROM r2_multipart_parts WHERE id=? AND part_number=?',(ident,number)).fetchone()
                    if saved['sha256']!=digest:abort(409,description='原文件与已登记分片不同，请选择原文件或取消后重新上传')
                with r2_errors():
                    signed=client.generate_presigned_url('upload_part',Params={'Bucket':data['bucket'],'Key':row['object_key'],'UploadId':row['upload_id'],'PartNumber':number},ExpiresIn=900,HttpMethod='PUT')
                return jsonify(success=True,data={'uploadUrl':signed,'headers':{},'expiresIn':900})

    select="SELECT u.*,'multipart' AS mode,m.upload_id,m.fingerprint,m.last_modified,m.part_size,m.expires_at FROM r2_uploads u JOIN r2_multipart m ON m.id=u.id"

    def row(self,ident):
        if not isinstance(ident,str) or not re.fullmatch('[a-f0-9]{32}',ident):abort(404)
        with self.connect() as db:
            row=db.execute(self.select+' WHERE u.id=? AND u.actor=?',(ident,g.actor)).fetchone()
        if row is None:abort(404,description='分片上传记录不存在')
        return row

    def describe(self,row,parts=None):
        state=row['state']
        if state in ['pending','completing'] and row['expires_at']<=int(time.time()):state='expired'
        result={'id':row['id'],'mode':'multipart','name':row['name'],'size':row['size'],
                'fingerprint':row['fingerprint'],'lastModified':row['last_modified'],
                'partSize':row['part_size'],'createdAt':row['created_at'],
                'expiresAt':row['expires_at'],'state':state,'parts':parts or []}
        if state=='complete':result['file']=self.file_data(row)
        elif state=='expired':result['message']='上传会话已超过 7 天，请取消以清理原分片，然后重新上传'
        elif state=='missing':result['message']='R2 上的分片会话已不存在，请重新上传；可能已被桶生命周期规则清理'
        return result

    def storage(self,row):
        data=self.settings.read()
        if data['revision']!=row['settings_revision']:abort(409,description='上传期间存储配置已变化，不能续传；请在原桶中清理未完成分片，然后重新上传')
        return data,self.settings.client(data)

    def part_count(self,row):return (row['size']+row['part_size']-1)//row['part_size']

    def require_pending(self,row):
        if row['state']=='complete':abort(409,description='文件已经合并完成，请使用已完成文件')
        if row['state']=='aborted':abort(409,description='这次上传已取消')
        if row['state']=='missing':abort(410,description='R2 分片会话已不存在，请重新上传')
        if row['state']=='expired' or row['expires_at']<=int(time.time()):abort(410,description='分片会话已超过 7 天，请取消清理后重新上传')

    def create(self,ident,name,key,size,mime,public_url,disposition,body,data):
        # Pin configuration during S3 creation and local registration. Failed DB
        # registration aborts only this newly created multipart upload.
        with self.settings.lock:
            if self.settings.read()['revision']!=data['revision']:abort(409,description='存储设置已变化，请重新开始上传')
            client=self.settings.client(data)
            with self.r2_errors():
                remote=client.create_multipart_upload(Bucket=data['bucket'],Key=key,ContentType=mime,ContentDisposition=disposition,Metadata={'portal-upload-id':ident})
            upload_id=remote.get('UploadId')
            if not isinstance(upload_id,str) or not upload_id:abort(502,description='R2 未返回分片会话，请重试')
            now=int(time.time())
            try:
                with self.connect() as db:
                    db.execute("INSERT INTO r2_uploads(id,name,object_key,size,mime,public_url,settings_revision,state,created_at,actor,etag) VALUES(?,?,?,?,?,?,?,'pending',?,?,NULL)",(ident,name,key,size,mime,public_url,data['revision'],now,g.actor))
                    db.execute('INSERT INTO r2_multipart(id,upload_id,fingerprint,last_modified,part_size,expires_at) VALUES(?,?,?,?,?,?)',(ident,upload_id,body['fingerprint'],body['lastModified'],PART_SIZE,now+SESSION_TTL))
                    self.record(db,'r2_multipart_started',detail=ident)
            except Exception:
                try:client.abort_multipart_upload(Bucket=data['bucket'],Key=key,UploadId=upload_id)
                except (ClientError,BotoCoreError):pass
                raise
        return self.describe(self.row(ident))

    def head(self,row,data,client):
        try:head=client.head_object(Bucket=data['bucket'],Key=row['object_key'])
        except ClientError as error:
            if error_code(error) in ['404','NotFound','NoSuchKey']:return None
            raise
        metadata={k.lower():v for k,v in head.get('Metadata',{}).items()}
        if head.get('ContentLength')!=row['size'] or head.get('ContentType')!=row['mime'] or metadata.get('portal-upload-id')!=row['id']:
            abort(409,description='R2 完整文件大小或元数据不匹配，请保留现场并联系管理员')
        return head

    def mark_complete(self,row,head):
        with self.connect() as db:
            db.execute("UPDATE r2_uploads SET state='complete',etag=? WHERE id=? AND state!='aborted'",(str(head.get('ETag',''))[:200],row['id']))
            current=db.execute('SELECT * FROM r2_uploads WHERE id=?',(row['id'],)).fetchone()
            if current['state']!='complete':abort(409,description='上传状态已变化，请刷新')
            if row['state']!='complete':self.record(db,'r2_upload_completed',detail=row['id'])
        return self.file_data(current)

    def list_parts(self,row,data,client):
        parts=[];marker=None
        try:
            with self.r2_errors():
                while True:
                    params={'Bucket':data['bucket'],'Key':row['object_key'],'UploadId':row['upload_id'],'MaxParts':1000}
                    if marker is not None:params['PartNumberMarker']=marker
                    try:page=client.list_parts(**params)
                    except ClientError as error:
                        if error_code(error)=='NoSuchUpload':
                            head=self.head(row,data,client)
                            if head is not None:self.mark_complete(row,head)
                            else:
                                with self.connect() as db:db.execute("UPDATE r2_uploads SET state='missing' WHERE id=? AND state!='complete'",(row['id'],))
                            return []
                        raise
                    parts.extend(page.get('Parts',[]))
                    if len(parts)>10000:abort(502,description='R2 分片列表超出上限')
                    if not page.get('IsTruncated'):break
                    next_marker=page.get('NextPartNumberMarker')
                    if not isinstance(next_marker,int) or (marker is not None and next_marker<=marker):abort(502,description='R2 分片列表分页无效，请重试')
                    marker=next_marker
        except (ClientError,BotoCoreError):raise
        with self.connect() as db:
            digests={r['part_number']:r['sha256'] for r in db.execute('SELECT part_number,sha256 FROM r2_multipart_parts WHERE id=?',(row['id'],))}
        output=[];seen=set()
        for part in parts:
            number=part.get('PartNumber');size=part.get('Size');etag=part.get('ETag')
            if type(number) is not int or not 1<=number<=self.part_count(row) or number in seen or type(size) is not int or not isinstance(etag,str) or not etag or len(etag)>200:
                abort(409,description='R2 分片列表与上传记录不符，请取消后重新上传')
            if number not in digests:abort(409,description='R2 存在未登记 SHA256 的分片，请取消后重新上传')
            expected=min(row['part_size'],row['size']-(number-1)*row['part_size'])
            if size!=expected:abort(409,description='R2 分片大小与原文件不一致，请取消后重新上传')
            seen.add(number)
            output.append({'partNumber':number,'size':size,'etag':etag,'sha256':digests[number]})
        return sorted(output,key=lambda part:part['partNumber'])

    def complete(self,base):
        row=self.row(base['id'])
        if row['state']=='complete':return self.file_data(row)
        if row['state']=='aborted':abort(409,description='这次上传已取消')
        with self.settings.lock:
            data,client=self.storage(row)
            # HEAD first is essential when completion succeeded but its HTTP
            # response or subsequent DB transaction was lost.
            with self.r2_errors():head=self.head(row,data,client)
            if head is not None:return self.mark_complete(row,head)
            self.require_pending(row)
            parts=self.list_parts(row,data,client)
            current=self.row(row['id'])
            if current['state']=='complete':return self.file_data(current)
            self.require_pending(current)
            if len(parts)!=self.part_count(row) or sum(p['size'] for p in parts)!=row['size']:
                abort(409,description='文件分片尚未全部上传，请继续上传后再合并')
            with self.connect() as db:db.execute("UPDATE r2_uploads SET state='completing' WHERE id=? AND state IN ('pending','completing')",(row['id'],))
            try:
                with self.r2_errors():
                    client.complete_multipart_upload(Bucket=data['bucket'],Key=row['object_key'],UploadId=row['upload_id'],MultipartUpload={'Parts':[{'ETag':p['etag'],'PartNumber':p['partNumber']} for p in parts]})
                    head=self.head(row,data,client)
                    if head is None:abort(502,description='R2 合并后暂未读取到完整文件，请稍后重试完成确认')
            except Exception:
                # Do not abort or discard state on a nonterminal failure.
                # Reconcile again because S3 may have committed before timeout.
                try:
                    with self.r2_errors():head=self.head(row,data,client)
                except Exception:head=None
                if head is not None:return self.mark_complete(row,head)
                raise
            return self.mark_complete(row,head)

    def abort(self,base):
        row=self.row(base['id'])
        if row['state']=='complete':abort(409,description='已完成文件不会自动删除，请到 R2 管理其生命周期')
        if row['state']=='aborted':return
        with self.settings.lock:
            data,client=self.storage(row)
            with self.r2_errors():
                head=self.head(row,data,client)
                if head is not None:
                    self.mark_complete(row,head)
                    abort(409,description='文件已合并完成，不会自动删除，请从已上传文件中恢复')
                try:client.abort_multipart_upload(Bucket=data['bucket'],Key=row['object_key'],UploadId=row['upload_id'])
                except ClientError as error:
                    if error_code(error)!='NoSuchUpload':raise
            with self.connect() as db:
                db.execute("UPDATE r2_uploads SET state='aborted' WHERE id=? AND state!='complete'",(row['id'],))
                self.record(db,'r2_upload_aborted',detail=row['id'])
