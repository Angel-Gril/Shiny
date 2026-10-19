"""Isolated Linux CPA integration checks; all credentials and upstream traffic are synthetic."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import ssl
import subprocess
import tarfile
import threading
import time
import urllib.error
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument('--archive', required=True)
parser.add_argument('--sha256', required=True)
parser.add_argument('--version', required=True)
parser.add_argument('--stage', required=True)
parser.add_argument('--root', required=True)
args = parser.parse_args()
archive, stage, root = Path(args.archive), Path(args.stage), Path(args.root)
assert root.is_absolute() and root.parent == Path('/var/lib/relay-native')
assert root.name.startswith('cpa-candidate-') and not root.exists()
assert stage.is_absolute() and stage.parent == Path('/root/shiny-maintenance')
assert stage.is_dir() and hashlib.sha256(archive.read_bytes()).hexdigest() == args.sha256
unit = 'cpa-kernel-candidate-' + args.version.replace('.', '')
assert all(c.isdigit() or c == '.' for c in args.version)
root.mkdir(mode=0o700)
for name in ['auths', 'plugins', 'logs']:
    (root / name).mkdir(mode=0o700)
with tarfile.open(archive, 'r:gz') as source:
    member = source.getmember('cli-proxy-api')
    assert member.isfile()
    (root / 'CLIProxyAPI').write_bytes(source.extractfile(member).read())
(root / 'CLIProxyAPI').chmod(0o755)

versions = {'key-router': '0.4.1', 'cpa-account-concurrency': '0.1.8', 'cpa-codex-candy-eval': '0.3.15'}
for name, version in versions.items():
    source = Path('/var/lib/relay-native/bin/plugins/linux/amd64') / (name + '-v' + version + '.so')
    shutil.copy2(source, root / 'plugins' / source.name)

management = 'candidate-management-' + secrets.token_hex(16)
keys = {name: 'candidate-call-' + name + '-' + secrets.token_hex(12) for name in ['a', 'b', 'none']}
accounts = ['a1', 'a2', 'b1', 'b2', 'b3']
tokens = {'isolated-token-' + account: account for account in accounts}
files = {account: 'codex-fixture-' + account + '@example.invalid.json' for account in accounts}


def rule(account):
    return 'codex:fixture-' + account + '@example.invalid'


users = [
    {'name': 'fixture-A', 'api-keys': [keys['a']], 'primary': [rule('a1'), rule('a2')], 'access': []},
    {'name': 'fixture-B', 'api-keys': [keys['b']], 'primary': [rule('b1'), rule('b2'), rule('b3')], 'access': []},
    {'name': 'fixture-no-access', 'api-keys': [keys['none']], 'primary': [], 'access': []},
]
config = {
    'config-version': 8,
    'server': {'host': '127.0.0.1', 'port': 18471, 'discovery': {'enabled': False}, 'commercial-mode': True},
    'management': {'allow-remote': False, 'secret-key': management, 'disable-control-panel': True, 'disable-auto-update-panel': True},
    'access': {'api-keys': list(keys.values())},
    'oauth': {'auth-dir': str(root / 'auths')},
    'requests': {'proxy-url': 'http://127.0.0.1:18474'},
    'routing': {'strategy': 'fill-first', 'retry': {'request-retry': 0}},
    'observability': {'usage': {'usage-statistics-enabled': True}},
    'plugins': {'enabled': True, 'dir': str(root / 'plugins'), 'configs': {
        'key-router': {'enabled': True, 'priority': 100, 'users': users},
        'cpa-account-concurrency': {'enabled': True, 'priority': 50, 'max_concurrency': 5, 'warm_reserved_slots': 1, 'wait_timeout': '50ms', 'authority': 'local'},
        'cpa-codex-candy-eval': {'enabled': True},
    }},
}
(root / 'config.yaml').write_text(json.dumps(config))
for account in accounts:
    data = {'type': 'codex', 'email': 'fixture-' + account + '@example.invalid', 'account_id': 'fixture-' + account,
            'access_token': 'isolated-token-' + account, 'expired': '2099-01-01T00:00:00Z',
            'last_refresh': '2026-10-20T00:00:00Z', 'plan_type': 'plus'}
    (root / 'auths' / files[account]).write_text(json.dumps(data))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=chatgpt.com',
                '-addext', 'subjectAltName=DNS:chatgpt.com', '-addext', 'basicConstraints=critical,CA:TRUE',
                '-keyout', str(root / 'tls.key'), '-out', str(root / 'tls.crt')], check=True, capture_output=True)
owner = pwd.getpwnam('relay')
for item in [root, *root.rglob('*')]:
    os.chown(item, owner.pw_uid, owner.pw_gid)
    item.chmod(0o700 if item.is_dir() else 0o600)
(root / 'CLIProxyAPI').chmod(0o755)
for item in (root / 'plugins').glob('*.so'):
    item.chmod(0o755)

seen, active, peak, failures, checks = [], {}, {}, [], []
guard = threading.Condition()
release_hold = threading.Event()
release_cancel = threading.Event()


class Upstream(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *unused):
        pass

    def do_CONNECT(self):
        if self.path != 'chatgpt.com:443':
            self.send_error(403)
            return
        self.send_response(200, 'Connection Established')
        self.end_headers()
        self.wfile.flush()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(root / 'tls.crt', root / 'tls.key')
        try:
            self.connection = context.wrap_socket(self.connection, server_side=True)
            self.rfile, self.wfile = self.connection.makefile('rb'), self.connection.makefile('wb')
            self.close_connection = False
            self.handle_one_request()
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError):
            pass
        finally:
            self.close_connection = True

    def do_POST(self):
        token = self.headers.get('Authorization', '').removeprefix('Bearer ')
        account = tokens.get(token)
        if account is None:
            failures.append('unexpected upstream authentication')
            self.send_error(403)
            return
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        hold = 'hold-fixture' in json.dumps(body.get('input'))
        cancel_probe = 'cancel-fixture' in json.dumps(body.get('input'))
        with guard:
            seen.append({'account': account, 'path': self.path, 'hold': hold,
                         'search_declared': any(tool.get('type') == 'web_search' for tool in body.get('tools', []) if isinstance(tool, dict))})
            active[account] = active.get(account, 0) + 1
            peak[account] = max(peak.get(account, 0), active[account])
            guard.notify_all()
        try:
            if hold and not release_hold.wait(20):
                failures.append('held request was not released')
            if cancel_probe and not release_cancel.wait(20):
                failures.append('cancel probe was not released')
            text = 'fixture-' + account + '-ok'
            message = {'id': 'msg_' + account, 'type': 'message', 'role': 'assistant', 'status': 'completed',
                       'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
            response = {'id': 'resp_' + account, 'object': 'response', 'created_at': int(time.time()), 'status': 'completed',
                        'model': 'gpt-6.1-sol', 'output': [message],
                        'usage': {'input_tokens': 306, 'output_tokens': 5, 'total_tokens': 311, 'input_tokens_details': {'cached_tokens': 0}}}
            if self.path.endswith('/responses/compact'):
                response.update(object='response.compaction', output=[{'id': 'cmp_fixture', 'type': 'compaction', 'encrypted_content': 'fixture-compaction'}])
                encoded, content_type = json.dumps(response).encode(), 'application/json'
            else:
                events = [
                    {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                    {'type': 'response.output_item.added', 'output_index': 0, 'item': {**message, 'status': 'in_progress', 'content': []}},
                    {'type': 'response.content_part.added', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'part': {'type': 'output_text', 'text': '', 'annotations': []}},
                    {'type': 'response.output_text.delta', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'delta': text},
                    {'type': 'response.output_text.done', 'item_id': message['id'], 'output_index': 0, 'content_index': 0, 'text': text},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': message},
                    {'type': 'response.completed', 'response': response},
                ]
                encoded = ''.join('event: ' + event['type'] + '\ndata: ' + json.dumps(event) + '\n\n' for event in events).encode()
                content_type = 'text/event-stream'
            self.send_response(200)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(encoded)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with guard:
                active[account] -= 1
                guard.notify_all()


class Proxy(ThreadingHTTPServer):
    daemon_threads = True


proxy = Proxy(('127.0.0.1', 18474), Upstream)
threading.Thread(target=proxy.serve_forever, daemon=True).start()


def call(path, method='GET', payload=None, key=None, extra=None):
    headers = {'Authorization': 'Bearer ' + (key or management)}
    data = None if payload is None else json.dumps(payload).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    headers.update(extra or {})
    request = urllib.request.Request('http://127.0.0.1:18471' + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def data(path):
    status, _, raw = call(path)
    assert status == 200, path + ': HTTP ' + str(status)
    return json.loads(raw)


def wait_until(predicate, reason, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            if predicate():
                return
        except (OSError, ValueError, AssertionError):
            pass
        time.sleep(.1)
    raise AssertionError(reason)


def check(label, ok):
    assert ok, label
    checks.append(label)
    print(json.dumps({'passed': len(checks), 'check': label}), flush=True)


def save_roles(primary, access):
    document = data('/v8/management/config')
    container = document.get('config', document)
    container['plugins']['configs']['key-router']['users'][0].update(primary=primary, access=access)
    assert call('/v8/management/config', 'PUT', document)[0] == 200
    def stored_roles_match():
        current = data('/v8/management/config')
        current = current.get('config', current)
        user = current['plugins']['configs']['key-router']['users'][0]
        return user['primary'] == primary and user['access'] == access
    wait_until(stored_roles_match, 'candidate routing rules were not saved')


try:
    subprocess.run(['systemd-run', '--unit=' + unit, '--collect', '--uid=relay', '--gid=relay',
                    '--property=WorkingDirectory=' + str(root), '--property=PrivateTmp=yes', '--property=NoNewPrivileges=yes',
                    '--setenv=HOME=' + str(root), '--setenv=SSL_CERT_FILE=' + str(root / 'tls.crt'),
                    str(root / 'CLIProxyAPI'), '--config', str(root / 'config.yaml'), '--local-model'], check=True, capture_output=True, text=True)
    wait_until(lambda: call('/v0/management/auth-files')[0] == 200, 'candidate startup failed')
    auths = data('/v0/management/auth-files')['files']
    check('five synthetic credentials loaded', len(auths) == 5)
    plugin_rows = data('/v0/management/plugins')['plugins']
    for name, version in versions.items():
        row = next(p for p in plugin_rows if p['id'] == name)
        check(name + ' registered and enabled', row.get('registered') is True and row.get('effective_enabled') is True and version in json.dumps(row['metadata']))
    check('management reports requested kernel version', call('/v0/management/auth-files')[1].get('x-cpa-version') == args.version)
    check('authorized model catalog available', call('/v1/models', key=keys['a'])[0] == 200)
    check('invalid downstream key rejected', call('/v1/models', key='invalid-fixture-key')[0] == 401)
    payload = {'model': 'gpt-6.1-sol', 'input': 'Reply fixture.', 'stream': False}
    status, _, raw = call('/v1/responses', 'POST', payload, key=keys['a'])
    first = seen[-1]['account']
    check('pool A normal Responses stays in A', status == 200 and first.startswith('a') and b'fixture-a' in raw)
    status, _, raw = call('/v1/responses', 'POST', {**payload, 'stream': True}, key=keys['b'])
    check('pool B SSE stays in B', status == 200 and seen[-1]['account'].startswith('b') and b'data:' in raw)
    status, _, raw = call('/v1/chat/completions', 'POST', {'model': 'gpt-6.1-sol', 'messages': [{'role': 'user', 'content': 'Reply fixture.'}]}, key=keys['a'])
    check('chat compatibility retains account isolation', status == 200 and seen[-1]['account'].startswith('a'))
    count = len(seen)
    status, _, raw = call('/v1/responses', 'POST', payload, key=keys['none'])
    check('authorized key with no account access never reaches upstream', status == 503 and len(seen) == count and b'key-router' in raw)

    search = {'type': 'web_search_call', 'id': 'ws_fixture', 'status': 'completed', 'action': {'type': 'search', 'query': 'fixture'}}
    status, _, raw = call('/v1/responses', 'POST', {**payload, 'input': [search, {'role': 'user', 'content': 'Reply fixture.'}]}, key=keys['a'])
    check('replayed web search history gains a declared tool', status == 200 and seen[-1]['search_declared'])
    status, _, raw = call('/v1/responses/compact', 'POST', {'model': 'gpt-6.1-sol', 'input': [{'role': 'user', 'content': 'Fixture compact.'}]}, key=keys['a'])
    check('compact endpoint remains functional', status == 200 and b'response.compaction' in raw)

    usage_path = '/v0/management/plugins/cpa-account-concurrency/usage'
    wait_until(lambda: data(usage_path).get('summary', {}).get('total', {}).get('in_flight', -1) == 0, 'initial leases not released')
    account_usage = data(usage_path).get('accounts', [])
    check('concurrency management reports limit five and warm reserve one', len(account_usage) == 5 and all(row['limit'] == 5 and row['reserved'] == 1 for row in account_usage))
    with ThreadPoolExecutor(max_workers=4) as workers:
        pending = [workers.submit(call, '/v1/responses', 'POST', {**payload, 'input': 'hold-fixture'}, keys['a']) for _ in range(4)]
        try:
            wait_until(lambda: sum(active.values()) == 4, 'four protected requests did not reach local upstream')
            count = len(seen)
            status, _, raw = call('/v1/responses', 'POST', payload, key=keys['a'])
            check('cold capacity rejects before upstream I/O', status == 503 and len(seen) == count and b'account_concurrency_limit' in raw)
            check('current Key Router full-account behavior does not spill pools', all(row['account'] == first for row in seen if row['hold']))
            status, _, raw = call('/v1/responses', 'POST', payload, key=keys['b'])
            check('other pool remains callable during A saturation', status == 200 and seen[-1]['account'].startswith('b'))
        finally:
            release_hold.set()
        check('all admitted requests complete', all(f.result()[0] == 200 for f in pending))
    wait_until(lambda: data(usage_path).get('summary', {}).get('total', {}).get('in_flight', -1) == 0, 'completion leaked concurrency leases')
    check('completion returns in-flight count to zero', data(usage_path)['summary']['total']['in_flight'] == 0)
    check('account works again after leases release', call('/v1/responses', 'POST', payload, key=keys['a'])[0] == 200)
    check('observed upstream concurrency remains below hard cap', max(peak.values()) <= 5)

    wait_until(lambda: data(usage_path)['summary']['total']['in_flight'] == 0, 'leases not ready for cancellation probe')
    cancel_client = http.client.HTTPConnection('127.0.0.1', 18471, timeout=15)
    cancel_client.request('POST', '/v1/responses', body=json.dumps({**payload, 'input': 'cancel-fixture', 'stream': True}),
                          headers={'Authorization': 'Bearer ' + keys['a'], 'Content-Type': 'application/json'})
    try:
        wait_until(lambda: data(usage_path)['summary']['total']['in_flight'] == 1, 'cancel probe was not admitted')
        check('cancel probe acquired one account lease', True)
        cancel_client.sock.shutdown(socket.SHUT_RDWR)
        cancel_client.close()
        wait_until(lambda: data(usage_path)['summary']['total']['in_flight'] == 0, 'client cancellation leaked its account lease')
        check('client cancellation releases the protected lease', True)
    finally:
        cancel_client.close()
        release_cancel.set()
    wait_until(lambda: sum(active.values()) == 0, 'cancel fixture upstream did not finish')
    check('account remains callable after client cancellation', call('/v1/responses', 'POST', payload, key=keys['a'])[0] == 200)

    first_row = next(row for row in auths if row['name'] == files[first])
    identity = first_row.get('auth_index')
    status, _, _ = call('/v0/management/auth-files/fields', 'PATCH', {'name': files[first], 'note': 'fixture-upgrade', 'excluded_models': ['fixture-never-used']})
    check('credential edit accepts string-array exclusions', status == 200)
    status, _, _ = call('/v0/management/auth-files/fields', 'PATCH', {'name': files[first], 'excluded_models': 'invalid,legacy-string'})
    check('invalid legacy string exclusions rejected', status == 400)
    check('null exclusions can clear the setting', call('/v0/management/auth-files/fields', 'PATCH', {'name': files[first], 'excluded_models': None})[0] == 200)
    wait_until(lambda: any(row['name'] == files[first] and row.get('auth_index') == identity for row in data('/v0/management/auth-files')['files']), 'credential identity changed during edit')
    check('credential identity stable after management edit', True)

    other = 'a2' if first == 'a1' else 'a1'
    save_roles([rule(first)], [rule(other)])
    check('candidate primary disabled through management', call('/v0/management/auth-files/status', 'PATCH', {'name': files[first], 'disabled': True})[0] == 200)
    status, _, raw = call('/v1/responses', 'POST', payload, key=keys['a'])
    check('explicitly permitted access fallback works', status == 200 and seen[-1]['account'] == other)
    check('second A credential can be disabled', call('/v0/management/auth-files/status', 'PATCH', {'name': files[other], 'disabled': True})[0] == 200)
    count = len(seen)
    status, _, raw = call('/v1/responses', 'POST', payload, key=keys['a'])
    check('exhausted allowed set returns 503 without entering B', status == 503 and len(seen) == count)
    check('pool B unaffected by disabled A credentials', call('/v1/responses', 'POST', payload, key=keys['b'])[0] == 200 and seen[-1]['account'].startswith('b'))
    for account in [first, other]:
        assert call('/v0/management/auth-files/status', 'PATCH', {'name': files[account], 'disabled': False})[0] == 200
    save_roles([rule('a1'), rule('a2')], [])
    status, headers, raw = call('/v8/management/config')
    document = json.loads(raw)
    check('v8 config ETag present', status == 200 and 'etag' in headers)
    check('stale config save rejected', call('/v8/management/config', 'PUT', document, extra={'If-Match': '"fixture-stale"'})[0] == 412)
    check('legacy config save remains compatible', call('/v8/management/config', 'PUT', document)[0] == 200)
    check('routing survives config save', call('/v1/responses', 'POST', payload, key=keys['a'])[0] == 200 and seen[-1]['account'].startswith('a'))
    check('production auth directory never referenced', b'/var/lib/relay-native/cpa-auths' not in (root / 'config.yaml').read_bytes())
    check('mock upstream saw only expected authentication', not failures)
    report = {'all_passed': True, 'version': 'v' + args.version, 'passed': len(checks), 'checks': checks,
              'real_accounts_used': False, 'production_changed': False, 'stub_executions': len(seen),
              'observed_maximum_in_flight': max(peak.values()), 'cold_capacity': 4, 'hard_limit': 5, 'warm_reserved': 1,
              'candidate_binary_sha256': hashlib.sha256((root / 'CLIProxyAPI').read_bytes()).hexdigest()}
    (stage / 'candidate-verification.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report), flush=True)
finally:
    release_hold.set()
    release_cancel.set()
    subprocess.run(['systemctl', 'stop', unit], capture_output=True)
    proxy.shutdown()
    proxy.server_close()
