import io
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from app import create_app


class IdentityServer(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_GET(self):
        if self.path=='/api/user/sessions':
            if self.headers.get('Authorization')=='Bearer readonly-root-pat':
                self.send_response(403);self.end_headers();return
            data={'success':True,'data':[]}
        elif self.path=='/api/user/self':
            token=self.headers.get('Authorization')
            role=100 if token in ['Bearer root-test','Bearer readonly-root-pat'] else 1
            if token not in ['Bearer root-test','Bearer user-test','Bearer readonly-root-pat']:
                self.send_response(401);self.end_headers();return
            data={'success':True,'data':{'id':7,'username':'test','role':role,'status':1}}
        else:data={'success':True,'data':{'announcements_enabled':True,'announcements':[{'id':1,'content':'Public announcement','publishDate':'2026-10-16'}]}}
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())


class PortalContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identity=ThreadingHTTPServer(('127.0.0.1',0),IdentityServer)
        threading.Thread(target=cls.identity.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):cls.identity.shutdown();cls.identity.server_close()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.app=create_app({'TESTING':True,'DATA_DIR':self.tmp.name,'SEED_PATH':str(Path(__file__).with_name('seed.json')),'NEWAPI_URL':f'http://127.0.0.1:{self.identity.server_port}'})
        self.client=self.app.test_client()
        self.headers={'Authorization':'Bearer root-test','Origin':'https://shinyapi.com','X-Portal-Request':'1','X-Portal-Editor':'markdown-v2'}
    def tearDown(self):self.tmp.cleanup()
    def content(self):return self.client.get('/portal-api/admin/content',headers=self.headers).json['data']
    def test_authorization_origin_and_identity_revalidation(self):
        self.assertEqual(self.client.get('/portal-api/admin/content').status_code,401)
        self.assertEqual(self.client.get('/portal-api/admin/content',headers={'Authorization':'Bearer user-test'}).status_code,403)
        self.assertEqual(self.client.get('/portal-api/admin/content',headers={'Authorization':'Bearer readonly-root-pat'}).status_code,403)
        self.assertEqual(self.client.put('/portal-api/admin/content',json={},headers={'Authorization':'Bearer root-test','Origin':'https://evil.test','X-Portal-Request':'1'}).status_code,403)
        self.assertEqual(self.client.get('/portal-api/admin/content',headers=self.headers).status_code,200)
        self.assertEqual(self.client.get('/portal-api/admin/content',headers={'Authorization':'Bearer revoked-test'}).status_code,401)
    def test_draft_publication_conflict_restore_and_restart_persistence(self):
        state=self.content();changed=state['draft'];changed['site']['headline']='Changed title'
        save=self.client.put('/portal-api/admin/content',headers=self.headers,json={'content':changed,'revision':1})
        self.assertEqual(save.status_code,200)
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'content':changed,'revision':1}).status_code,409)
        self.assertNotEqual(self.client.get('/portal-api/content').json['site']['headline'],'Changed title')
        self.assertEqual(self.client.post('/portal-api/admin/publish',headers=self.headers,json={'revision':1}).status_code,409)
        self.assertEqual(self.client.post('/portal-api/admin/publish',headers=self.headers,json={'revision':2}).status_code,200)
        self.assertEqual(self.client.get('/portal-api/content').json['site']['headline'],'Changed title')
        reloaded=create_app(self.app.config).test_client()
        self.assertEqual(reloaded.get('/portal-api/content').json['site']['headline'],'Changed title')
        initial=self.content()['history'][-1]['id']
        self.assertEqual(self.client.post(f'/portal-api/admin/restore/{initial}',headers=self.headers,json={'revision':2}).status_code,200)
        self.assertNotEqual(self.content()['draft']['site']['headline'],'Changed title')
        self.assertEqual(self.client.get('/portal-api/content').json['site']['headline'],'Changed title')
    def test_upload_is_private_until_published_and_persists(self):
        upload=self.client.post('/portal-api/admin/upload',headers=self.headers,data={'file':(io.BytesIO(b'# Test file'),'guide.md')})
        self.assertEqual(upload.status_code,200);file=upload.json['data']
        self.assertEqual(self.client.get(file['url']).status_code,404)
        state=self.content();state['draft']['resources'][2]['url']=file['url']
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,200)
        self.assertEqual(self.client.post('/portal-api/admin/publish',headers=self.headers,json={'revision':2}).status_code,200)
        response=self.client.get(file['url']);self.assertEqual(response.status_code,200);self.assertEqual(response.data,b'# Test file');self.assertIn('attachment',response.headers['Content-Disposition']);response.close()
        self.assertEqual(self.client.get('/portal-api/files/../seed.json').status_code,404)
    def test_invalid_upload_and_navigation_are_rejected(self):
        for name,body in [('script.svg',b'<svg/>'),('fake.pdf',b'<script>'),('bad.json',b'invalid')]:
            self.assertEqual(self.client.post('/portal-api/admin/upload',headers=self.headers,data={'file':(io.BytesIO(body),name)}).status_code,400)
        state=self.content();state['draft']['navigation'][0]['url']='javascript:alert(1)'
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,400)
    def test_public_announcements_and_cache_revalidation(self):
        response=self.client.get('/portal-api/content')
        self.assertEqual(response.status_code,200);self.assertIn('Public announcement',[n['title'] for n in response.json['announcements']])
        self.assertEqual(self.client.get('/portal-api/content',headers={'If-None-Match':response.headers['ETag']}).status_code,304)
        self.assertNotIn('history',response.json);self.assertNotIn('draft',response.json)

    def test_markdown_roundtrip_old_articles_and_old_editor_guard(self):
        state=self.content();before=json.loads(json.dumps(state['draft']['articles']))
        raw='---\ntitle: Test\n---\n# Test\n\n| A | B |\n| - | - |\n| 一 | 二 |\n\n```js\nconst a = 1;\n```\n\n```json\n{"x":2}\n```\n\n末尾保留\n'
        article={**before[0],'slug':'markdown-test','title':'Test','format_version':2,'body_markdown':raw,'source_path':'guides/test.md'}
        article.pop('sections');state['draft']['articles'].append(article)
        old_headers={k:v for k,v in self.headers.items() if k!='X-Portal-Editor'}
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=old_headers,json={'revision':1,'content':state['draft']}).status_code,409)
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,200)
        self.assertEqual(self.content()['draft']['articles'][-1]['body_markdown'],raw)
        self.assertEqual(self.content()['draft']['articles'][:-1],before)
        self.assertFalse(any(a['slug']=='markdown-test' for a in self.client.get('/portal-api/content').json['articles']))
        self.assertEqual(self.client.post('/portal-api/admin/publish',headers=self.headers,json={'revision':2}).status_code,200)
        self.assertEqual(self.client.get('/portal-api/content').json['articles'][-1]['body_markdown'],raw)

    def test_markdown_validation_and_private_image_preview(self):
        state=self.content();article=state['draft']['articles'][0]
        for body in [None,{},'x'*(1024*1024+1)]:
            article.update(body_markdown=body,format_version=2)
            self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,400)
        article.update(body_markdown='# Valid',format_version=7)
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,400)
        upload=self.client.post('/portal-api/admin/upload',headers=self.headers,data={'file':(io.BytesIO(b'\x89PNG\r\n\x1a\npreview'),'image.png')}).json['data']
        private='/portal-api/admin/files/'+upload['id']
        self.assertEqual(self.client.get(upload['url']).status_code,404)
        self.assertEqual(self.client.get(private).status_code,401)
        self.assertEqual(self.client.get(private,headers={'Authorization':'Bearer user-test'}).status_code,403)
        preview=self.client.get(private,headers=self.headers)
        self.assertEqual(preview.status_code,200);self.assertEqual(preview.headers['Cache-Control'],'no-store');preview.close()
        article.update(body_markdown='![image]('+upload['url']+')',format_version=2)
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,200)
        self.assertEqual(self.client.post('/portal-api/admin/publish',headers=self.headers,json={'revision':2}).status_code,200)
        public=self.client.get(upload['url']);self.assertEqual(public.status_code,200);public.close()

    def test_delete_draft_only_article_preserves_published_and_files(self):
        state=self.content();article={**state['draft']['articles'][0],'slug':'draft-delete-test','title':'Temporary draft'}
        state['draft']['articles'].append(article)
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':state['draft']}).status_code,200)
        before=self.client.get('/portal-api/content').json
        deleted=self.client.delete('/portal-api/admin/articles/draft-delete-test',headers=self.headers,json={'revision':2})
        self.assertEqual(deleted.status_code,200)
        self.assertEqual(deleted.json['revision'],3)
        self.assertFalse(deleted.json['wasPublished'])
        self.assertFalse(any(a['slug']=='draft-delete-test' for a in self.content()['draft']['articles']))
        self.assertEqual(self.client.get('/portal-api/content').json,before)

    def test_delete_published_article_requires_publish_and_history_can_restore(self):
        before=self.client.get('/portal-api/content').json
        deleted=self.client.delete('/portal-api/admin/articles/image-guide',headers=self.headers,json={'revision':1})
        self.assertEqual(deleted.status_code,200);self.assertTrue(deleted.json['wasPublished'])
        self.assertTrue(any(a['slug']=='image-guide' for a in self.client.get('/portal-api/content').json['articles']))
        self.assertFalse(any(a['slug']=='image-guide' for a in self.content()['draft']['articles']))
        self.assertEqual(self.client.post('/portal-api/admin/publish',headers=self.headers,json={'revision':2}).status_code,200)
        self.assertFalse(any(a['slug']=='image-guide' for a in self.client.get('/portal-api/content').json['articles']))
        initial=self.content()['history'][-1]['id']
        self.assertEqual(self.client.post(f'/portal-api/admin/restore/{initial}',headers=self.headers,json={'revision':2}).status_code,200)
        self.assertTrue(any(a['slug']=='image-guide' for a in self.content()['draft']['articles']))

    def test_delete_requires_identity_revision_and_no_resource_references(self):
        endpoint='/portal-api/admin/articles/image-guide'
        self.assertEqual(self.client.delete(endpoint,headers={'Origin':'https://shinyapi.com','X-Portal-Request':'1'},json={'revision':1}).status_code,401)
        self.assertEqual(self.client.delete(endpoint,headers={**self.headers,'Authorization':'Bearer user-test'},json={'revision':1}).status_code,403)
        self.assertEqual(self.client.delete(endpoint,headers={**self.headers,'Origin':'https://evil.test'},json={'revision':1}).status_code,403)
        self.assertEqual(self.client.delete(endpoint,headers=self.headers,json={}).status_code,409)
        self.assertEqual(self.client.delete(endpoint,headers=self.headers,json={'revision':0}).status_code,409)
        self.assertEqual(self.client.delete('/portal-api/admin/articles/not-present',headers=self.headers,json={'revision':1}).status_code,404)
        blocked=self.client.delete('/portal-api/admin/articles/quickstart',headers=self.headers,json={'revision':1})
        self.assertEqual(blocked.status_code,409);self.assertIn('资源',blocked.json['message'])
        self.assertEqual(self.content()['revision'],1)

    def test_resource_batch_merges_after_concurrent_content_save_and_retries(self):
        original=self.content()['draft'];resource={**original['resources'][0],'id':'new-uploaded-resource','name':'Uploaded installer','url':'https://files.example.com/new.zip'}
        other=json.loads(json.dumps(original));other['site']['intro']='Changed in another window'
        self.assertEqual(self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':other}).status_code,200)
        saved=self.client.post('/portal-api/admin/resources/batch',headers=self.headers,json={'changes':[{'resource':resource,'base':None}]})
        self.assertEqual(saved.status_code,200);self.assertEqual(saved.json['data']['revision'],3)
        current=self.content();self.assertEqual(current['draft']['site']['intro'],'Changed in another window')
        self.assertEqual(current['draft']['resources'][-1],resource)
        self.assertFalse(any(r['id']==resource['id'] for r in self.client.get('/portal-api/content').json['resources']))
        retry=self.client.post('/portal-api/admin/resources/batch',headers=self.headers,json={'changes':[{'resource':resource,'base':None}]})
        self.assertEqual(retry.status_code,200);self.assertEqual(self.content()['revision'],3)
        self.assertEqual(sum(r['id']==resource['id'] for r in self.content()['draft']['resources']),1)

    def test_resource_batch_conflict_is_per_resource_and_transactional(self):
        before=self.content()['draft'];base=before['resources'][0];mine={**base,'version':'my-version'}
        other=json.loads(json.dumps(before));other['resources'][0]['version']='other-version'
        self.client.put('/portal-api/admin/content',headers=self.headers,json={'revision':1,'content':other})
        added={**base,'id':'should-not-be-inserted','url':'https://files.example.com/newer.zip'}
        response=self.client.post('/portal-api/admin/resources/batch',headers=self.headers,json={'changes':[{'resource':added,'base':None},{'resource':mine,'base':base}]})
        self.assertEqual(response.status_code,409);self.assertEqual(self.content()['draft'],other)
        self.assertEqual(self.client.post('/portal-api/admin/resources/batch',json={'changes':[]}).status_code,403)
        self.assertEqual(self.client.post('/portal-api/admin/resources/batch',headers=self.headers,json={'changes':[]}).status_code,400)


if __name__=='__main__':unittest.main()
