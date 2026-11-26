#!/usr/bin/env python3
"""Manage only the optional local WorkBuddy2API instances on ports 7861/7862."""

import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import time

PORTS = (7861, 7862)
ROOT = Path('/opt/workbuddy2api-instances')
SOURCE = Path('/opt/workbuddy2api')
MANAGER_DB = Path('/opt/workbuddy-manager/data/manager.db')
SERVICE_USER = 'workbuddy'


def run(*args):
    subprocess.run(args, check=True)


def paths(port):
    directory = ROOT / str(port)
    return directory, Path(f'/etc/systemd/system/workbuddy2api-{port}.service')


def load_managed(port):
    directory, _ = paths(port)
    if directory.is_symlink() or not (directory / 'deployment.json').is_file():
        raise RuntimeError(f'{directory} is not a managed instance')
    metadata = json.loads((directory / 'deployment.json').read_text())
    if metadata.get('port') != port or metadata.get('scope') != 'shiny-extra-workbuddy':
        raise RuntimeError('instance manifest does not match')
    return directory, metadata


def registration(port, remove=False, enabled=None):
    """Called as workbuddy so SQLite sidecar permissions stay compatible."""
    directory, _ = load_managed(port)
    config = json.loads((directory / 'config.json').read_text())
    base = f'http://127.0.0.1:{port}'
    db = sqlite3.connect(MANAGER_DB, timeout=15)
    db.row_factory = sqlite3.Row
    try:
        db.execute('BEGIN IMMEDIATE')
        rows = db.execute('SELECT * FROM upstreams WHERE base_url = ?', (base,)).fetchall()
        if len(rows) > 1:
            raise RuntimeError('duplicate manager upstreams for this port')
        row = rows[0] if rows else None
        if row and (row['api_key'] != config['api_key'] or row['auth_dir'] != str(directory / 'auths')):
            raise RuntimeError('manager registration belongs to a different configuration')
        now = int(time.time())
        if remove:
            if row:
                used = db.execute('SELECT COUNT(*) FROM api_keys WHERE upstream_id = ?', (row['id'],)).fetchone()[0]
                if used:
                    raise RuntimeError(f'{used} manager keys still reference this instance')
                if list((directory / 'auths').iterdir()):
                    raise RuntimeError('account directory is not empty; move accounts before removing')
                db.execute('DELETE FROM upstreams WHERE id = ?', (row['id'],))
            result = {'port': port, 'registration_removed': bool(row)}
        elif enabled is not None:
            if not row:
                raise RuntimeError('manager registration is missing')
            db.execute('UPDATE upstreams SET enabled = ?, updated_at = ? WHERE id = ?', (int(enabled), now, row['id']))
            result = {'port': port, 'manager_enabled': enabled, 'upstream_id': row['id']}
        elif row:
            result = {'port': port, 'upstream_id': row['id'], 'registration': 'already present'}
        else:
            cursor = db.execute(
                'INSERT INTO upstreams(name,base_url,api_key,note,enabled,auth_dir,container,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
                (f'独立号池-{port}', base, config['api_key'], 'Shiny optional instance; systemd; empty until accounts are imported', 1, str(directory / 'auths'), '', now, now),
            )
            result = {'port': port, 'upstream_id': cursor.lastrowid, 'registration': 'created'}
        db.commit()
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def manager_action(port, action):
    run('runuser', '-u', SERVICE_USER, '--', sys.executable, str(Path(__file__).resolve()), action, str(port))


def probe(port, key=None):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=5)
    try:
        conn.request('GET', '/v1/models' if key else '/healthz', headers={'Authorization': 'Bearer ' + key} if key else {})
        response = conn.getresponse()
        body = response.read(512 * 1024)
        result = json.loads(body)
        if not key and response.status == 503 and result.get('service') == 'workbuddy2api' and result.get('total') == 0:
            return result  # Empty pools are live, but explicitly not inference-ready.
        if response.status != 200:
            raise RuntimeError(f'port {port} probe returned HTTP {response.status}')
        return result
    finally:
        conn.close()


def install(port):
    directory, unit = paths(port)
    account = pwd.getpwnam(SERVICE_USER)
    ROOT.mkdir(mode=0o755, exist_ok=True)
    os.chmod(ROOT, 0o755)
    # InaccessiblePaths cannot hide a sibling created after service startup.
    # Reserve both paths before starting either instance, so isolation holds.
    for sibling in PORTS:
        reserved = ROOT / str(sibling)
        if not reserved.exists():
            reserved.mkdir(mode=0o750)
            os.chown(reserved, 0, account.pw_gid)
            os.chmod(reserved, 0o750)
            (reserved / '.shiny-reserved').write_text('shiny-extra-workbuddy\n')
    source_hash = hashlib.sha256((SOURCE / 'wb2api').read_bytes()).hexdigest()
    if (directory / 'deployment.json').exists():
        directory, metadata = load_managed(port)
        if metadata['binary_sha256'] != source_hash:
            raise RuntimeError('source binary differs; explicit instance upgrade is required')
        if not (directory / 'wb2api').exists():
            shutil.copyfile(SOURCE / 'wb2api', directory / 'wb2api')
            os.chmod(directory / 'wb2api', 0o755)
    else:
        reservation = directory / '.shiny-reserved'
        if directory.is_symlink() or sorted(item.name for item in directory.iterdir()) != ['.shiny-reserved'] or reservation.read_text() != 'shiny-extra-workbuddy\n':
            raise RuntimeError(f'{directory} contains unmanaged files')
        if unit.exists():
            raise RuntimeError(f'{unit} already exists')
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', port))
        reservation.unlink()
        for name in ('auths', 'data'):
            target = directory / name
            target.mkdir(mode=0o700)
            os.chown(target, account.pw_uid, account.pw_gid)
        shutil.copyfile(SOURCE / 'wb2api', directory / 'wb2api')
        os.chmod(directory / 'wb2api', 0o755)
        original = json.loads((SOURCE / 'config.json').read_text())
        allowed = ('cooldown', 'schedule', 'admin', 'upstream', 'features', 'pool', 'session_sticky', 'server')
        config = {key: original[key] for key in allowed if key in original}
        config.update(listen=f'127.0.0.1:{port}', api_key=secrets.token_urlsafe(48), auth_dir=str(directory / 'auths'), state_file=str(directory / 'data/state.json'))
        config['admin'] = {'enabled': False}
        config['global'] = {'enabled': True, 'chat_base': '', 'billing_base': ''}
        config['upstash'] = {'url': '', 'token': ''}
        config['prompt'] = {'mode': 'passthrough', 'file': ''}
        config.setdefault('server', {})['max_body_mb'] = 256
        for name in ('device_token', 'device_token_file', 'user_agent', 'client_version', 'cli_version'):
            config.setdefault('upstream', {})[name] = ''
        with (directory / 'config.json').open('x') as file:
            json.dump(config, file, ensure_ascii=False, indent=2)
            file.write('\n')
        os.chown(directory / 'config.json', 0, account.pw_gid)
        os.chmod(directory / 'config.json', 0o640)
        metadata = {'scope': 'shiny-extra-workbuddy', 'port': port, 'binary_sha256': source_hash, 'created_at': int(time.time()), 'source': str(SOURCE / 'wb2api')}
        (directory / 'deployment.json').write_text(json.dumps(metadata, indent=2) + '\n')
        os.chmod(directory / 'deployment.json', 0o644)
    other_port = next(value for value in PORTS if value != port)
    script_dir = directory / 'scripts'
    script_dir.mkdir(mode=0o755, exist_ok=True)
    os.chmod(script_dir, 0o755)
    for name in ('task_common.py', 'global_region.py', 'school_open_day_2026.py', 'task_runner.py'):
        source = SOURCE / 'scripts' / name
        target = script_dir / name
        if target.exists() and target.read_bytes() != source.read_bytes():
            raise RuntimeError('scheduled-task helper differs; explicit instance upgrade is required')
        if not target.exists():
            shutil.copyfile(source, target)
            os.chmod(target, 0o644)
    expected_unit = f'''[Unit]
Description=WorkBuddy2API optional local instance {port}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={SERVICE_USER}
Group={SERVICE_USER}
WorkingDirectory={directory}
Environment=PYTHONDONTWRITEBYTECODE=1
Environment=WB2A_AUTH_DIR={directory}/auths
ExecStart={directory}/wb2api -config {directory}/config.json
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths={directory}/auths {directory}/data
InaccessiblePaths=/opt/workbuddy2api /opt/workbuddy-manager -{ROOT}/{other_port}
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
UMask=0077
StandardOutput=journal
StandardError=journal
SyslogIdentifier=workbuddy2api-{port}

[Install]
WantedBy=multi-user.target
'''
    if unit.exists() and unit.read_text() != expected_unit:
        raise RuntimeError('service unit differs; refusing to overwrite it')
    unit.write_text(expected_unit)
    os.chmod(unit, 0o644)
    run('systemd-analyze', 'verify', str(unit))
    run('systemctl', 'daemon-reload')
    run('systemctl', 'enable', '--now', unit.name)
    for attempt in range(20):
        try:
            health = probe(port)
            config = json.loads((directory / 'config.json').read_text())
            models = probe(port, config['api_key'])
            print(json.dumps({'port': port, 'process': 'ok', 'accounts': health.get('total'), 'inference_ready': health.get('healthy', 0) > 0, 'model_count': len(models.get('data', [])), 'binary_sha256': source_hash}))
            break
        except (OSError, RuntimeError):
            if attempt == 19:
                raise
            time.sleep(0.5)
    manager_action(port, '_register')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['install', 'status', 'stop', 'start', 'restart', 'remove', '_register', '_unregister', '_disable', '_enable'])
    parser.add_argument('ports', nargs='+', type=int, choices=PORTS)
    args = parser.parse_args()
    if not args.action.startswith('_') and os.geteuid() != 0:
        raise SystemExit('run this command as root')
    os.umask(0o077)
    for port in args.ports:
        if args.action.startswith('_'):
            if os.geteuid() != pwd.getpwnam(SERVICE_USER).pw_uid:
                raise RuntimeError('manager database updates must run as workbuddy')
            registration(port, remove=args.action == '_unregister', enabled=False if args.action == '_disable' else True if args.action == '_enable' else None)
            continue
        if args.action == 'install':
            install(port)
            continue
        directory, metadata = load_managed(port)
        _, unit = paths(port)
        if args.action == 'status':
            active = subprocess.run(['systemctl', 'is-active', unit.name], capture_output=True, text=True).stdout.strip()
            print(json.dumps({'port': port, 'service': unit.name, 'active': active, 'account_files': len(list((directory / 'auths').glob('*.json'))), 'binary_sha256': metadata['binary_sha256']}))
        elif args.action == 'stop':
            manager_action(port, '_disable')
            run('systemctl', 'disable', '--now', unit.name)
        elif args.action in ('start', 'restart'):
            run('systemctl', 'enable', '--now', unit.name)
            if args.action == 'restart':
                run('systemctl', 'restart', unit.name)
            for attempt in range(20):
                try:
                    probe(port)
                    break
                except (OSError, RuntimeError):
                    if attempt == 19:
                        raise
                    time.sleep(0.5)
            manager_action(port, '_enable')
        elif args.action == 'remove':
            if list((directory / 'auths').iterdir()):
                raise RuntimeError('account directory is not empty; move accounts before removing')
            manager_action(port, '_unregister')
            run('systemctl', 'disable', '--now', unit.name)
            unit.unlink(missing_ok=True)
            (directory / 'wb2api').unlink(missing_ok=True)
            run('systemctl', 'daemon-reload')
            print(json.dumps({'port': port, 'removed': True, 'configuration_and_state_retained': str(directory)}))


if __name__ == '__main__':
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        raise SystemExit(1)
