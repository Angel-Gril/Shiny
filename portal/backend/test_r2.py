import json
import os
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from unittest.mock import Mock
from app import create_app
from test_portal import IdentityServer


class S3Fixture(BaseHTTPRequestHandler):
    """Real SDK/HTTP fixture; no credentials or external cloud account required."""
    objects={}
    def log_message(self,*args):pass
    def cors(self):
        self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','*'))
        self.send_header('Access-Control-Allow-Methods','PUT, GET, HEAD, DELETE, OPTIONS')
        self.send_header('Access-Control-Allow-Headers','content-type,content-disposition,x-amz-meta-portal-upload-id')
        self.send_header('Access-Control-Expose-Headers','ETag')
    def do_OPTIONS(self):
        self.send_response(204);self.cors();self.end_headers()
    def do_PUT(self):
        raw=self.rfile.read(int(self.headers.get('Content-Length','0')))
        self.objects[urlsplit(self.path).path]={'raw':raw,'headers':dict(self.headers)}
        self.send_response(200);self.send_header('ETag','"fixture-etag"');self.send_header('Content-Length','0');self.cors();self.end_headers()
    def do_HEAD(self):
        stored=self.objects.get(urlsplit(self.path).path)
        self.send_response(200 if stored else 404)
        if stored:
            self.send_header('Content-Length',str(len(stored['raw'])));self.send_header('ETag','"fixture-etag"')
            for name,value in stored['headers'].items():
                if name.lower() in ['content-type','content-disposition'] or name.lower().startswith('x-amz-meta-'):self.send_header(name,value)
        self.cors();self.end_headers()
    def do_DELETE(self):
        self.objects.pop(urlsplit(self.path).path,None)
        self.send_response(204);self.cors();self.end_headers()
    def do_GET(self):
        stored=self.objects.get(urlsplit(self.path).path)
        self.send_response(200 if stored else 404);self.cors()
        if stored:self.send_header('Content-Length',str(len(stored['raw'])));self.send_header('Content-Disposition',stored['headers'].get('Content-Disposition','attachment'))
        self.end_headers()
        if stored:self.wfile.write(stored['raw'])


def fixture_client(endpoint,settings):
    return boto3.client('s3',endpoint_url=endpoint,aws_access_key_id=settings['accessKeyId'],aws_secret_access_key=settings['secretAccessKey'],region_name='auto',
        config=Config(signature_version='s3v4',s3={'addressing_style':'path'},request_checksum_calculation='when_required',response_checksum_validation='when_required'))


class R2Contracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identity=ThreadingHTTPServer(('127.0.0.1',0),IdentityServer)
        cls.s3=ThreadingHTTPServer(('127.0.0.1',0),S3Fixture)
        for server in [cls.identity,cls.s3]:threading.Thread(target=server.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        for server in [cls.identity,cls.s3]:server.shutdown();server.server_close()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();S3Fixture.objects={}
        self.endpoint=f'http://127.0.0.1:{self.s3.server_port}'
        self.app=create_app({'TESTING':True,'DATA_DIR':self.tmp.name,'NEWAPI_URL':f'http://127.0.0.1:{self.identity.server_port}',
            'R2_CLIENT_FACTORY':lambda settings:fixture_client(self.endpoint,settings)})
        self.client=self.app.test_client();self.headers={'Authorization':'Bearer root-test','Origin':'https://shinyapi.com','X-Portal-Request':'1'}
        self.settings={'revision':0,'enabled':True,'accountId':'a'*32,'bucket':'fixture-bucket','publicBase':'https://downloads.example.com','prefix':'downloads',
            'accessKeyId':'fixture-access-key-id-1234','secretAccessKey':'fixture-secret-do-not-expose-5678'}
    def tearDown(self):self.tmp.cleanup()
    def enable(self):
        r=self.client.put('/portal-api/admin/storage',json=self.settings,headers=self.headers)
        self.assertEqual(r.status_code,200);return r.json['data']
    def start(self,name='client.zip',size=7):
        r=self.client.post('/portal-api/admin/r2/uploads',headers=self.headers,json={'name':name,'size':size})
        self.assertEqual(r.status_code,200);return r.json['data']
    def put(self,job,raw=b'fixture'):
        req=urllib.request.Request(job['uploadUrl'],method='PUT',headers=job['headers'],data=raw)
        with urllib.request.urlopen(req,timeout=5) as r:self.assertEqual(r.status,200)
    def test_disabled_config_and_local_upload_not_affected(self):
        safe=self.client.get('/portal-api/admin/storage',headers=self.headers).json['data']
        self.assertFalse(safe['enabled']);self.assertFalse(safe['hasCredentials'])
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads',headers=self.headers,json={'name':'test.zip','size':7}).status_code,409)
        self.assertEqual(self.client.get('/portal-api/content').status_code,200)
    def test_private_config_write_only_permissions_and_restart(self):
        result=self.enable();serialized=json.dumps(result)
        for value in ['accessKeyId','secretAccessKey',self.settings['secretAccessKey'],self.settings['accessKeyId']]:self.assertNotIn(value,serialized)
        self.assertTrue(result['hasCredentials']);self.assertEqual(result['keySuffix'],'1234')
        for endpoint in ['/portal-api/content','/portal-api/admin/content']:
            r=self.client.get(endpoint,headers=self.headers);self.assertNotIn(self.settings['secretAccessKey'],r.get_data(as_text=True))
        path=Path(self.tmp.name)/'r2-settings.json';self.assertTrue(path.is_file())
        if os.name!='nt':self.assertEqual(path.stat().st_mode&0o777,0o600)
        reloaded=create_app(self.app.config).test_client();self.assertTrue(reloaded.get('/portal-api/admin/storage',headers=self.headers).json['data']['hasCredentials'])
        update={**self.settings,'revision':1,'accessKeyId':'','secretAccessKey':'','prefix':'installers'}
        self.assertEqual(self.client.put('/portal-api/admin/storage',json=update,headers=self.headers).status_code,200)
        saved=json.loads(path.read_text());self.assertEqual(saved['secretAccessKey'],self.settings['secretAccessKey'])
    def test_settings_identity_origin_validation_and_revision(self):
        endpoint='/portal-api/admin/storage'
        self.assertEqual(self.client.get(endpoint).status_code,401)
        self.assertEqual(self.client.get(endpoint,headers={'Authorization':'Bearer user-test'}).status_code,403)
        self.assertEqual(self.client.put(endpoint,json=self.settings,headers={**self.headers,'Origin':'https://evil.example'}).status_code,403)
        for change in [{'accountId':'localhost'},{'publicBase':'http://127.0.0.1'},{'publicBase':'https://user:password@host.test'},{'publicBase':'https://downloads.test/?token=abc'},{'prefix':'../private'},{'secretAccessKey':''},{'enabled':'yes'}]:
            self.assertEqual(self.client.put(endpoint,json=self.settings|change,headers=self.headers).status_code,400,change)
        self.enable();self.assertEqual(self.client.put(endpoint,json=self.settings,headers=self.headers).status_code,409)
    def test_real_sdk_bucket_test_cleanup(self):
        self.enable();r=self.client.post('/portal-api/admin/storage/test',headers=self.headers,json={})
        self.assertEqual(r.status_code,200);self.assertEqual(S3Fixture.objects,{})

    def test_cors_diagnostic_detects_missing_and_incomplete_policy(self):
        self.enable();settings=self.app.extensions['r2_settings'];data=settings.read();client=Mock()
        client.get_bucket_cors.side_effect=ClientError({'Error':{'Code':'NoSuchCORSConfiguration'}},'GetBucketCors')
        self.assertFalse(settings.cors_status(client,data)['ready'])
        client.get_bucket_cors.side_effect=None;client.get_bucket_cors.return_value={'CORSRules':settings.cors()}
        self.assertTrue(settings.cors_status(client,data)['ready'])
        client.get_bucket_cors.return_value={'CORSRules':[{'AllowedOrigins':['https://shinyapi.com'],'AllowedMethods':['GET'],'AllowedHeaders':['*']}]}
        self.assertFalse(settings.cors_status(client,data)['ready'])
    def test_presigned_browser_upload_complete_and_idempotence(self):
        self.enable();job=self.start();self.assertIn('X-Amz-Signature',job['uploadUrl']);self.assertNotIn(self.settings['secretAccessKey'],job['uploadUrl'])
        self.put(job);endpoint='/portal-api/admin/r2/uploads/'+job['id']+'/complete'
        complete=self.client.post(endpoint,headers=self.headers,json={});self.assertEqual(complete.status_code,200)
        data=complete.json['data'];self.assertEqual(data['size'],7);self.assertEqual(data['storage'],'r2');self.assertTrue(data['url'].startswith('https://downloads.example.com/downloads/'))
        self.assertNotIn('X-Amz-',data['url']);self.assertEqual(self.client.post(endpoint,headers=self.headers,json={}).json['data'],data)
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads/'+job['id']+'/abort',headers=self.headers,json={}).status_code,409)
    def test_limits_types_mismatch_cancel_and_credential_change(self):
        self.enable()
        for body,expected in [({'name':'script.html','size':7},400),({'name':'../client.zip','size':7},400),({'name':'client.zip','size':512*1024*1024+1},413),({'name':'client.zip','size':0},413)]:
            self.assertEqual(self.client.post('/portal-api/admin/r2/uploads',headers=self.headers,json=body).status_code,expected)
        job=self.start(size=8);self.put(job)
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads/'+job['id']+'/complete',headers=self.headers,json={}).status_code,400)
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads/'+job['id']+'/abort',headers=self.headers,json={}).status_code,200)
        self.assertEqual(S3Fixture.objects,{})
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads/'+job['id']+'/complete',headers=self.headers,json={}).status_code,409)
        another=self.start();self.put(another)
        self.client.put('/portal-api/admin/storage',headers=self.headers,json=self.settings|{'revision':1,'accessKeyId':'','secretAccessKey':''})
        self.assertEqual(self.client.post('/portal-api/admin/r2/uploads/'+another['id']+'/complete',headers=self.headers,json={}).status_code,409)

    def test_completed_files_recover_without_reupload_and_hide_after_registration(self):
        self.enable();job=self.start();self.put(job)
        file=self.client.post('/portal-api/admin/r2/uploads/'+job['id']+'/complete',headers=self.headers,json={}).json['data']
        response=self.client.get('/portal-api/admin/r2/uploads/completed',headers=self.headers)
        self.assertEqual(response.status_code,200);self.assertEqual(response.json['data'][0]['id'],job['id'])
        original=self.client.get('/portal-api/admin/content',headers=self.headers).json['data']
        resource={**original['draft']['resources'][0],'id':'recovered-resource','url':file['url'],'storage':'r2','file_size':file['size']}
        self.assertEqual(self.client.post('/portal-api/admin/resources/batch',headers=self.headers,json={'changes':[{'resource':resource,'base':None}]}).status_code,200)
        self.assertEqual(self.client.get('/portal-api/admin/r2/uploads/completed',headers=self.headers).json['data'],[])
        self.assertEqual(self.client.get('/portal-api/admin/r2/uploads/completed').status_code,401)

