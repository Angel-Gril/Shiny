"""SDK + local S3 HTTP contracts, including durable lost-response recovery."""
import hashlib
import json
import sqlite3
import tempfile
import threading
import time
import unittest
import urllib.request
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs,urlsplit
from xml.sax.saxutils import escape

from app import create_app
from r2_multipart import PART_SIZE,SESSION_TTL
from test_portal import IdentityServer
from test_r2 import fixture_client


class MultipartS3Fixture(BaseHTTPRequestHandler):
    """Reusable browser/SDK fixture. Never stores real cloud credentials."""
    objects={}
    uploads={}
    calls=[]
    lock=threading.RLock()
    page_size=1000
    fail_complete_after_commit=0
    fail_list=0
    fail_abort=0
    pause_complete=None
    complete_entered=None
    _serial=0

    @classmethod
    def reset(cls):
        with cls.lock:
            cls.objects={};cls.uploads={};cls.calls=[];cls._serial=0
            cls.page_size=1000;cls.fail_complete_after_commit=0;cls.fail_list=0;cls.fail_abort=0
            cls.pause_complete=None;cls.complete_entered=None

    def log_message(self,*args):pass
    def cors(self):
        self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','*'))
        self.send_header('Access-Control-Allow-Methods','PUT, GET, HEAD, DELETE, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers','content-type,content-disposition,x-amz-meta-portal-upload-id')
        self.send_header('Access-Control-Expose-Headers','ETag')
    def reply(self,status=200,body=b'',headers=None):
        self.send_response(status)
        for name,value in (headers or {}).items():self.send_header(name,str(value))
        self.send_header('Content-Length',str(len(body)));self.cors();self.end_headers()
        if self.command!='HEAD':self.wfile.write(body)
    def xml(self,body,status=200):
        self.reply(status,('<?xml version="1.0" encoding="UTF-8"?>'+body).encode(),{'Content-Type':'application/xml'})
    def error(self,code,status=404):self.xml('<Error><Code>'+code+'</Code><Message>Fixture</Message></Error>',status)
    def location(self):
        parsed=urlsplit(self.path)
        return parsed.path,parse_qs(parsed.query,keep_blank_values=True)
    def do_OPTIONS(self):self.reply(204)
    def do_POST(self):
        path,query=self.location()
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        cls=type(self)
        if 'uploads' in query:
            with cls.lock:
                cls._serial+=1;ident='fixture-upload-'+str(cls._serial)
                cls.uploads[ident]={'path':path,'headers':dict(self.headers),'parts':{}}
                cls.calls.append(('create',path,ident))
            self.xml('<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>fixture-bucket</Bucket><Key>'+escape(path.split('/',2)[-1])+'</Key><UploadId>'+ident+'</UploadId></InitiateMultipartUploadResult>')
            return
        ident=query.get('uploadId',[''])[0]
        with cls.lock:
            upload=cls.uploads.get(ident)
            if upload is None or upload['path']!=path:self.error('NoSuchUpload');return
            cls.calls.append(('complete',path,ident))
        if cls.complete_entered:cls.complete_entered.set()
        if cls.pause_complete:cls.pause_complete.wait(5)
        requested=ET.fromstring(raw)
        requested_parts=[]
        for part in requested:
            values={child.tag.split('}')[-1]:child.text for child in part}
            number=int(values['PartNumber'])
            if number not in upload['parts'] or values['ETag']!=upload['parts'][number]['etag']:self.error('InvalidPart',400);return
            requested_parts.append(upload['parts'][number]['raw'])
        combined=b''.join(requested_parts)
        with cls.lock:
            cls.objects[path]={'raw':combined,'headers':upload['headers'],'etag':'"completed-'+hashlib.md5(combined).hexdigest()+'"'}
            del cls.uploads[ident]
            fault=cls.fail_complete_after_commit
            if fault:cls.fail_complete_after_commit-=1
        if fault:self.error('InternalError',503);return
        self.xml('<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Location>http://fixture/'+escape(path)+'</Location><Bucket>fixture-bucket</Bucket><Key>'+escape(path)+'</Key><ETag>"completed"</ETag></CompleteMultipartUploadResult>')
    def do_PUT(self):
        path,query=self.location();cls=type(self)
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        ident=query.get('uploadId',[''])[0]
        if ident:
            with cls.lock:
                upload=cls.uploads.get(ident)
                if upload is None or upload['path']!=path:self.error('NoSuchUpload');return
                number=int(query['partNumber'][0]);etag='"'+hashlib.md5(raw).hexdigest()+'"'
                upload['parts'][number]={'raw':raw,'etag':etag}
                cls.calls.append(('part',path,number))
            self.reply(headers={'ETag':etag});return
        with cls.lock:cls.objects[path]={'raw':raw,'headers':dict(self.headers),'etag':'"single"'}
        self.reply(headers={'ETag':'"single"'})
    def do_GET(self):
        path,query=self.location();cls=type(self)
        ident=query.get('uploadId',[''])[0]
        if ident:
            with cls.lock:
                if cls.fail_list:
                    cls.fail_list-=1;self.error('InternalError',503);return
                upload=cls.uploads.get(ident)
                if upload is None or upload['path']!=path:self.error('NoSuchUpload');return
                marker=int(query.get('part-number-marker',['0'])[0])
                candidates=sorted(n for n in upload['parts'] if n>marker)
                numbers=candidates[:cls.page_size];truncated=len(candidates)>len(numbers)
                parts=''.join('<Part><PartNumber>'+str(n)+'</PartNumber><LastModified>2026-10-17T00:00:00.000Z</LastModified><ETag>'+escape(upload['parts'][n]['etag'])+'</ETag><Size>'+str(len(upload['parts'][n]['raw']))+'</Size></Part>' for n in numbers)
                cls.calls.append(('list',path,ident))
            self.xml('<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Bucket>fixture-bucket</Bucket><Key>'+escape(path)+'</Key><UploadId>'+ident+'</UploadId><PartNumberMarker>'+str(marker)+'</PartNumberMarker><NextPartNumberMarker>'+str(numbers[-1] if numbers else marker)+'</NextPartNumberMarker><MaxParts>1000</MaxParts><IsTruncated>'+str(truncated).lower()+'</IsTruncated>'+parts+'</ListPartsResult>');return
        stored=cls.objects.get(path)
        if stored is None:self.error('NoSuchKey');return
        self.reply(body=stored['raw'],headers={'ETag':stored['etag']})
    def do_HEAD(self):
        path,_=self.location();stored=type(self).objects.get(path)
        if stored is None:self.reply(404);return
        self.send_response(200);self.send_header('Content-Length',str(len(stored['raw'])));self.send_header('ETag',stored['etag'])
        for name,value in stored['headers'].items():
            if name.lower() in ['content-type','content-disposition'] or name.lower().startswith('x-amz-meta-'):self.send_header(name,value)
        self.cors();self.end_headers()
    def do_DELETE(self):
        path,query=self.location();cls=type(self);ident=query.get('uploadId',[''])[0]
        with cls.lock:
            if ident:
                if cls.fail_abort:
                    cls.fail_abort-=1;self.error('InternalError',503);return
                upload=cls.uploads.get(ident)
                if upload is None or upload['path']!=path:self.error('NoSuchUpload');return
                del cls.uploads[ident];cls.calls.append(('abort',path,ident))
            else:
                cls.objects.pop(path,None);cls.calls.append(('delete',path))
        self.reply(204)


class MultipartContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identity=ThreadingHTTPServer(('127.0.0.1',0),IdentityServer)
        cls.s3=ThreadingHTTPServer(('127.0.0.1',0),MultipartS3Fixture)
        for server in [cls.identity,cls.s3]:threading.Thread(target=server.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        for server in [cls.identity,cls.s3]:server.shutdown();server.server_close()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();MultipartS3Fixture.reset()
        self.endpoint=f'http://127.0.0.1:{self.s3.server_port}'
        self.config={'TESTING':True,'DATA_DIR':self.tmp.name,'NEWAPI_URL':f'http://127.0.0.1:{self.identity.server_port}',
                     'R2_CLIENT_FACTORY':lambda settings:fixture_client(self.endpoint,settings)}
        self.app=create_app(self.config);self.client=self.app.test_client()
        self.headers={'Authorization':'Bearer root-test','Origin':'https://shinyapi.com','X-Portal-Request':'1'}
        self.settings={'revision':0,'enabled':True,'accountId':'a'*32,'bucket':'fixture-bucket','publicBase':'https://downloads.example.com','prefix':'downloads',
                       'accessKeyId':'fixture-access-key-id-1234','secretAccessKey':'fixture-secret-test-value-5678'}
        self.assertEqual(self.client.put('/portal-api/admin/storage',headers=self.headers,json=self.settings).status_code,200)
    def tearDown(self):self.tmp.cleanup()
    def post(self,job,suffix,body=None,client=None):
        return (client or self.client).post('/portal-api/admin/r2/uploads/'+job['id']+suffix,headers=self.headers,json=body or {})
    def start(self,size=64*1024*1024+3):
        response=self.client.post('/portal-api/admin/r2/uploads',headers=self.headers,json={'protocol':2,'name':'large.zip','size':size,'fingerprint':'f'*64,'lastModified':1770000000000})
        self.assertEqual(response.status_code,200,response.json)
        return response.json['data']
    def status(self,job):return self.client.get('/portal-api/admin/r2/uploads/'+job['id'],headers=self.headers)
    def put(self,job,number,raw):
        digest=hashlib.sha256(raw).hexdigest()
        signed=self.post(job,'/parts',{'partNumber':number,'sha256':digest})
        self.assertEqual(signed.status_code,200,signed.json)
        with urllib.request.urlopen(urllib.request.Request(signed.json['data']['uploadUrl'],method='PUT',headers=signed.json['data']['headers'],data=raw),timeout=10) as response:
            self.assertEqual(response.status,200)
        return digest
    def upload_all(self,job):
        total=hashlib.sha256()
        for index,offset in enumerate(range(0,job['size'],PART_SIZE),1):
            body=bytes([index])*min(PART_SIZE,job['size']-offset);total.update(body);self.put(job,index,body)
        return total.hexdigest()
    def execute(self,sql,args=()):
        db=sqlite3.connect(Path(self.tmp.name)/'content.sqlite')
        try:
            with db:return db.execute(sql,args).fetchall()
        finally:db.close()

    def test_large_file_roundtrip_list_pagination_and_lost_completion_response(self):
        job=self.start(70*1024*1024+17)
        self.assertEqual(job['mode'],'multipart');self.assertEqual(job['partSize'],PART_SIZE)
        self.assertNotIn('uploadId',json.dumps(job));self.assertEqual(job['expiresAt']-job['createdAt'],SESSION_TTL)
        expected=self.upload_all(job);MultipartS3Fixture.page_size=1
        progress=self.status(job);self.assertEqual(progress.status_code,200,progress.json)
        self.assertEqual(len(progress.json['data']['parts']),3)
        self.assertEqual(sum(p['size'] for p in progress.json['data']['parts']),job['size'])
        MultipartS3Fixture.fail_complete_after_commit=1
        completed=self.post(job,'/complete');self.assertEqual(completed.status_code,200,completed.json)
        self.assertEqual(completed.json['data']['size'],job['size'])
        stored=next(iter(MultipartS3Fixture.objects.values()))
        self.assertEqual(hashlib.sha256(stored['raw']).hexdigest(),expected)
        path=next(iter(MultipartS3Fixture.objects))
        with urllib.request.urlopen(self.endpoint+path) as response:self.assertEqual(hashlib.sha256(response.read()).hexdigest(),expected)
        self.assertEqual(self.post(job,'/complete').json,completed.json)
        self.assertEqual(self.status(job).json['data']['state'],'complete')
        self.assertEqual(self.post(job,'/abort').status_code,409)
        self.assertEqual(len(MultipartS3Fixture.objects),1)
        self.assertFalse(any(call[0]=='delete' for call in MultipartS3Fixture.calls))

    def test_resume_after_restart_sha_digest_immutable_and_actor_isolation(self):
        job=self.start();digest=self.put(job,1,b'x'*PART_SIZE)
        reloaded=create_app(self.config).test_client()
        self.assertEqual(reloaded.get('/portal-api/admin/r2/uploads/'+job['id'],headers=self.headers).json['data']['parts'][0]['sha256'],digest)
        changed=self.post(job,'/parts',{'partNumber':1,'sha256':'a'*64},reloaded)
        self.assertEqual(changed.status_code,409)
        self.assertEqual(self.post(job,'/parts',{'partNumber':1,'sha256':digest}).status_code,200)
        pending=self.client.get('/portal-api/admin/r2/uploads/pending',headers=self.headers)
        self.assertEqual(pending.json['data'][0]['id'],job['id'])
        self.execute('UPDATE r2_uploads SET actor=8 WHERE id=?',(job['id'],))
        self.assertEqual(self.status(job).status_code,404)
        self.assertEqual(self.post(job,'/complete').status_code,404)
        self.assertEqual(self.post(job,'/abort').status_code,404)
        self.assertEqual(self.client.get('/portal-api/admin/r2/uploads/pending',headers=self.headers).json['data'],[])

    def test_limits_default_admin_cas_protocol_and_legacy_single(self):
        storage=self.client.get('/portal-api/admin/storage',headers=self.headers).json['data']
        self.assertEqual(storage['maxFileMB'],10240)
        huge=self.start(1024*1024*1024+1);self.assertEqual(huge['mode'],'multipart')
        legacy=self.client.post('/portal-api/admin/r2/uploads',headers=self.headers,json={'name':'old.zip','size':512*1024*1024+1})
        self.assertEqual(legacy.status_code,413)
        for value in [511,102401,512.5,True,'10240']:
            result=self.client.put('/portal-api/admin/storage',headers=self.headers,json={'revision':1,'maxFileMB':value})
            self.assertEqual(result.status_code,400,result.json)
        changed=self.client.put('/portal-api/admin/storage',headers=self.headers,json={'revision':1,'maxFileMB':512})
        self.assertEqual(changed.status_code,200,changed.json)
        self.assertEqual(self.client.put('/portal-api/admin/storage',headers=self.headers,json={'revision':1,'maxFileMB':1024}).status_code,409)
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads',headers=self.headers,json={'protocol':2,'name':'new.zip','size':513*1024*1024,'fingerprint':'a'*64,'lastModified':0}).status_code,413)
        self.assertEqual(self.post(huge,'/abort').status_code,409)
        self.assertEqual(len(MultipartS3Fixture.uploads),1)
        # Old private configuration transparently defaults, never replaces keys.
        path=Path(self.tmp.name)/'r2-settings.json';settings=json.loads(path.read_text());settings.pop('maxFileMB');path.write_text(json.dumps(settings))
        self.assertEqual(self.client.get('/portal-api/admin/storage',headers=self.headers).json['data']['maxFileMB'],10240)

    def test_missing_remote_expiry_cleanup_and_transient_errors_preserve(self):
        job=self.start();MultipartS3Fixture.fail_list=6
        failed=self.status(job);self.assertEqual(failed.status_code,502,failed.json)
        self.assertEqual(self.execute('SELECT state FROM r2_uploads WHERE id=?',(job['id'],))[0][0],'pending')
        MultipartS3Fixture.fail_list=0
        self.execute('UPDATE r2_multipart SET expires_at=? WHERE id=?',(int(time.time())-1,job['id']))
        self.assertEqual(self.status(job).json['data']['state'],'expired')
        self.assertEqual(self.post(job,'/parts',{'partNumber':1,'sha256':'b'*64}).status_code,410)
        self.assertEqual(self.post(job,'/complete').status_code,410)
        self.assertEqual(self.post(job,'/abort').status_code,200)
        self.assertEqual(self.post(job,'/abort').status_code,200)
        missing=self.start();MultipartS3Fixture.uploads={}
        self.assertEqual(self.status(missing).json['data']['state'],'missing')
        self.assertEqual(self.post(missing,'/complete').status_code,410)
        self.assertEqual(self.post(missing,'/abort').status_code,200)

    def test_incomplete_wrong_size_unregistered_parts_and_invalid_digest_rejected(self):
        job=self.start()
        self.assertEqual(self.post(job,'/complete').status_code,409)
        for body in [{'partNumber':0,'sha256':'a'*64},{'partNumber':4,'sha256':'a'*64},{'partNumber':True,'sha256':'a'*64},{'partNumber':1,'sha256':'not-a-digest'}]:
            self.assertEqual(self.post(job,'/parts',body).status_code,400)
        self.put(job,1,b'wrong-size')
        self.assertEqual(self.status(job).status_code,409)
        self.assertEqual(self.post(job,'/complete').status_code,409)
        self.assertEqual(self.post(job,'/abort').status_code,200)
        second=self.start();upload=next(iter(MultipartS3Fixture.uploads.values()))
        upload['parts'][1]={'raw':b'x'*PART_SIZE,'etag':'"undocumented"'}
        self.assertEqual(self.status(second).status_code,409)
        self.assertEqual(self.post(second,'/complete').status_code,409)

    def test_complete_abort_serialization_does_not_delete_final_file(self):
        job=self.start();self.upload_all(job)
        MultipartS3Fixture.pause_complete=threading.Event();MultipartS3Fixture.complete_entered=threading.Event()
        results={}
        def finish():results['complete']=self.post(job,'/complete',client=self.app.test_client())
        def cancel():results['abort']=self.post(job,'/abort',client=self.app.test_client())
        finishing=threading.Thread(target=finish);finishing.start()
        self.assertTrue(MultipartS3Fixture.complete_entered.wait(5))
        cancelling=threading.Thread(target=cancel);cancelling.start()
        MultipartS3Fixture.pause_complete.set();finishing.join(10);cancelling.join(10)
        self.assertEqual(results['complete'].status_code,200)
        self.assertEqual(results['abort'].status_code,409)
        self.assertEqual(len(MultipartS3Fixture.objects),1)
        self.assertFalse(any(call[0] in ['delete','abort'] for call in MultipartS3Fixture.calls))

    def test_durable_completion_recovered_before_abort_and_head_metadata_checked(self):
        job=self.start();self.upload_all(job)
        # Simulate S3 commit followed by portal process loss before DB update.
        ident,upload=next(iter(MultipartS3Fixture.uploads.items()))
        client=fixture_client(self.endpoint,self.app.extensions['r2_settings'].read())
        client.complete_multipart_upload(Bucket='fixture-bucket',Key=upload['path'].split('/',2)[-1],UploadId=ident,
            MultipartUpload={'Parts':[{'PartNumber':n,'ETag':p['etag']} for n,p in sorted(upload['parts'].items())]})
        self.execute("UPDATE r2_uploads SET state='completing' WHERE id=?",(job['id'],))
        reloaded=create_app(self.config).test_client()
        response=self.post(job,'/abort',client=reloaded)
        self.assertEqual(response.status_code,409)
        self.assertEqual(self.execute('SELECT state FROM r2_uploads WHERE id=?',(job['id'],))[0][0],'complete')
        self.assertEqual(len(MultipartS3Fixture.objects),1)
        self.assertFalse(any(call[0] in ['delete','abort'] for call in MultipartS3Fixture.calls))
        second=self.start();self.upload_all(second)
        ident,upload=next(iter(MultipartS3Fixture.uploads.items()))
        upload['headers']['Content-Type']='text/plain'
        result=self.post(second,'/complete')
        self.assertEqual(result.status_code,409,result.json)
        self.assertEqual(self.execute('SELECT state FROM r2_uploads WHERE id=?',(second['id'],))[0][0],'completing')
        self.assertEqual(self.post(second,'/abort').status_code,409)
        self.assertEqual(len(MultipartS3Fixture.objects),2)

    def test_revision_change_refuses_all_remote_operations_in_new_bucket(self):
        job=self.start();before=len(MultipartS3Fixture.calls)
        changed=self.client.put('/portal-api/admin/storage',headers=self.headers,json={'revision':1,'bucket':'another-bucket'})
        self.assertEqual(changed.status_code,200)
        self.assertEqual(self.status(job).status_code,409)
        self.assertEqual(self.post(job,'/parts',{'partNumber':1,'sha256':'a'*64}).status_code,409)
        self.assertEqual(self.post(job,'/complete').status_code,409)
        self.assertEqual(self.post(job,'/abort').status_code,409)
        self.assertEqual(len(MultipartS3Fixture.calls),before)
        pending=self.client.get('/portal-api/admin/r2/uploads/pending',headers=self.headers)
        self.assertEqual(pending.json['data'][0]['id'],job['id'])

    def test_v12_positional_insert_rollback_schema_and_legacy_recovery(self):
        # v12 writes 11 values without column names. New bootstrap must leave
        # that table's shape intact so reverting binaries remains safe.
        self.assertEqual(len(self.execute('PRAGMA table_info(r2_uploads)')),11)
        job=self.start()
        ident='1'*32;key='downloads/legacy/old.zip';url='https://downloads.example.com/'+key
        self.execute("INSERT INTO r2_uploads VALUES (?,?,?,?,?,?,?,'pending',?,?,NULL)",
            (ident,'old.zip',key,7,'application/zip',url,1,int(time.time()),7))
        fixture_client(self.endpoint,self.app.extensions['r2_settings'].read()).put_object(
            Bucket='fixture-bucket',Key=key,Body=b'fixture',ContentType='application/zip',Metadata={'portal-upload-id':ident})
        response=self.post({'id':ident},'/complete')
        self.assertEqual(response.status_code,200,response.json)
        self.assertEqual(response.json['data']['url'],url)
        recovered=self.client.get('/portal-api/admin/r2/uploads/completed',headers=self.headers)
        self.assertIn(ident,[entry['id'] for entry in recovered.json['data']])
        self.assertEqual(self.status(job).json['data']['mode'],'multipart')


if __name__=='__main__':unittest.main()
