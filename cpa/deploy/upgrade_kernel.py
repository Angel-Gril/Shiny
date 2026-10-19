"""Switch only the CPA binary after isolated checks; retain a private rollback copy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import stat
import subprocess
import time
import urllib.request


parser = argparse.ArgumentParser()
parser.add_argument('--stage', required=True)
parser.add_argument('--candidate', required=True)
parser.add_argument('--from-sha256', required=True)
parser.add_argument('--version', required=True)
args = parser.parse_args()
stage, candidate = Path(args.stage), Path(args.candidate)
assert stage.parent == Path('/root/shiny-maintenance') and stage.is_dir() and stage.resolve() == stage and not stage.is_symlink()
assert candidate.parent == Path('/var/lib/relay-native') and candidate.name.startswith('cpa-candidate-')
assert not candidate.is_symlink() and candidate.resolve() == candidate
binary = Path('/var/lib/relay-native/bin/CLIProxyAPI')
config = Path('/var/lib/relay-native/bin/config.yaml')
auth_dir = Path('/var/lib/relay-native/cpa-auths')
backup = stage / 'temporary-backup'
peers = ['relay-native-new-api', 'shiny-cpamp', 'shiny-portal']
management = Path('/etc/shiny-cpamp/admin.key').read_text().strip()


def run(command, **kwargs):
    return subprocess.run(command, check=True, capture_output=True, text=True, **kwargs).stdout.strip()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def pid(name):
    return run(['systemctl', 'show', name, '-p', 'MainPID', '--value'])


def api(path, port=8317):
    request = urllib.request.Request('http://127.0.0.1:' + str(port) + path, headers={'Authorization': 'Bearer ' + management})
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response), {k.lower(): v for k, v in response.headers.items()}


def plugins():
    rows = api('/v0/management/plugins')[0]['plugins']
    return {row['id']: {'registered': row['registered'], 'enabled': row['effective_enabled'],
                        'version': row.get('metadata', {}).get('version')} for row in rows}


def credentials():
    result = {}
    for path in sorted(auth_dir.glob('*.json')):
        data = json.loads(path.read_text())
        # Only OAuth refresh fields may change automatically. Protect every other
        # field, including newly introduced manual settings, without recording PII.
        protected = {key: value for key, value in data.items()
                     if key not in {'access_token', 'refresh_token', 'id_token', 'expired', 'last_refresh'}}
        if 'email' in protected:
            protected['email'] = str(protected['email']).casefold()
        for key, default in {'disabled': False, 'priority': 0, 'prefix': '', 'excluded_models': []}.items():
            if protected.get(key) in (None, default):
                protected.pop(key, None)
        digest = hashlib.sha256(json.dumps(protected, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        result[path.name] = {'sha256': sha(path), 'identity_and_controls_sha256': digest}
    return result


def controls():
    paths = [config, Path('/etc/shiny-cpamp/config.json'), Path('/etc/shiny-cpamp/admin.key'),
             Path('/var/lib/shiny-cpamp/data.key'), Path('/etc/nginx/sites-available/shinyapi.com'),
             Path('/etc/nginx/sites-available/api.shinyapi.com'), Path('/etc/nginx/sites-available/www.shinyapi.com'),
             Path('/etc/nginx/conf.d/shiny-cpa-unified.conf')]
    paths += list(Path('/var/lib/shiny-portal').glob('*settings*.json'))
    return {str(path): sha(path) for path in paths if path.is_file()}


def database_summary():
    with sqlite3.connect('file:/var/lib/shiny-cpamp/usage.sqlite?mode=ro', uri=True) as database:
        count, maximum = database.execute('SELECT count(*),coalesce(max(id),0) FROM usage_events').fetchone()
        return {'events': count, 'maximum_event_id': maximum, 'quick_check': database.execute('PRAGMA quick_check').fetchone()[0]}


def verify_credentials(before):
    current = credentials()
    assert set(before).issubset(current), 'A pre-upgrade credential file is missing'
    for name, prior in before.items():
        assert current[name]['identity_and_controls_sha256'] == prior['identity_and_controls_sha256'], 'Credential identity or manual settings changed'
    return current


verification = json.loads((stage / 'candidate-verification.json').read_text())
assert verification['all_passed'] and verification['version'] == 'v' + args.version
assert sha(candidate / 'CLIProxyAPI') == verification['candidate_binary_sha256']
assert sha(binary) == args.from_sha256, 'Unexpected current kernel'
assert not backup.exists(), 'Inspect the existing rollback copy before retrying'
old_stat = binary.stat()
before = {'cpa_pid': pid('relay-native-cpa'), 'peer_pids': {name: pid(name) for name in peers},
          'control_files': controls(), 'plugins': plugins(), 'credentials': credentials(),
          'database': database_summary(), 'cpa_version': api('/v0/management/auth-files')[1]['x-cpa-version']}
baseline_status = api('/status', 18318)[0]
assert baseline_status['collector']['collector'] == 'running' and baseline_status['deadLetters'] == 0
assert before['database']['quick_check'] == 'ok'
(stage / 'before.json').write_text(json.dumps(before, indent=2))
(stage / 'before.json').chmod(0o600)

# Wait for an idle observation, then rely on normal SIGTERM shutdown for any race.
consecutive = 0
end = time.monotonic() + 180
while time.monotonic() < end:
    usage = api('/v0/management/plugins/cpa-account-concurrency/usage')[0]
    assert not usage.get('stale'), 'Concurrency observation unavailable'
    inflight = usage.get('summary', {}).get('total', {}).get('in_flight', -1)
    consecutive = consecutive + 1 if inflight == 0 else 0
    if consecutive >= 3:
        break
    print(json.dumps({'waiting_for_quiet_requests': True, 'observed_in_flight': inflight}), flush=True)
    time.sleep(.5)
assert consecutive >= 3, 'CPA remained busy; kernel has not been changed'
assert controls() == before['control_files'], 'Configuration changed while preparing'
assert {name: pid(name) for name in peers} == before['peer_pids']
replacement = binary.with_name('CLIProxyAPI.upgrade-next')
assert not replacement.exists()
shutil.copy2(candidate / 'CLIProxyAPI', replacement)
os.chown(replacement, old_stat.st_uid, old_stat.st_gid)
replacement.chmod(stat.S_IMODE(old_stat.st_mode))
assert sha(replacement) == verification['candidate_binary_sha256'], 'Replacement copy failed verification'
record = {'from': 'v' + before['cpa_version'], 'to': 'v' + args.version, 'from_binary_sha256': args.from_sha256,
          'to_binary_sha256': verification['candidate_binary_sha256'], 'started_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
stopped = False
swapped = False
started = time.monotonic()


class UpgradeInterrupted(RuntimeError):
    """An operator signal must escape readiness retry handlers."""


def interrupted(signum, frame):
    raise UpgradeInterrupted('Upgrade interrupted by signal ' + str(signum))


for signum in (signal.SIGTERM, signal.SIGHUP):
    signal.signal(signum, interrupted)
try:
    stopped = True
    run(['systemctl', 'stop', 'relay-native-cpa'], timeout=100)
    assert controls() == before['control_files'], 'Configuration changed during shutdown'
    assert sha(binary) == args.from_sha256
    offline_credentials = credentials()
    # Capture the latest persisted token state only after normal CPA shutdown.
    backup.mkdir(mode=0o700)
    shutil.copy2(binary, backup / 'CLIProxyAPI')
    shutil.copy2(config, backup / 'config.yaml')
    shutil.copytree(auth_dir, backup / 'auths')
    assert sha(backup / 'CLIProxyAPI') == args.from_sha256, 'Rollback binary failed verification'
    for path in backup.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)
    before['offline_credentials'] = offline_credentials
    (stage / 'before.json').write_text(json.dumps(before, indent=2))
    os.replace(replacement, binary)
    swapped = True
    run(['systemctl', 'start', 'relay-native-cpa'])
    stopped = False
    end = time.monotonic() + 30
    while time.monotonic() < end:
        try:
            files, headers = api('/v0/management/auth-files')
            assert headers.get('x-cpa-version') == args.version
            assert len(files['files']) >= len(offline_credentials)
            current_plugins = plugins()
            for name, previous in before['plugins'].items():
                assert name in current_plugins
                assert current_plugins[name]['enabled'] == previous['enabled']
                if previous['enabled']:
                    assert current_plugins[name]['registered'] is True
                    assert current_plugins[name]['version'] == previous['version']
            break
        except (OSError, ValueError, AssertionError):
            time.sleep(.25)
    else:
        raise RuntimeError('Upgraded CPA management or plugins did not become ready')
    assert sha(binary) == verification['candidate_binary_sha256']
    assert controls() == before['control_files'], 'Protected configuration changed'
    assert {name: pid(name) for name in peers} == before['peer_pids'], 'An unrelated backend restarted'
    current = verify_credentials(offline_credentials)
    for _ in range(40):
        status = api('/status', 18318)[0]
        if status['collector']['collector'] == 'running' and status['deadLetters'] == 0:
            break
        time.sleep(.25)
    else:
        raise RuntimeError('CPAMP collector did not recover')
    database = database_summary()
    assert database['quick_check'] == 'ok' and database['events'] >= before['database']['events']
    record.update(restart_to_healthy_seconds=round(time.monotonic() - started, 3), cpa_pid=pid('relay-native-cpa'),
                  config_and_control_files_unchanged=True, credentials_preserved=True,
                  credential_count=len(current), credential_files_refreshed=sum(current[name]['sha256'] != prior['sha256'] for name, prior in offline_credentials.items()),
                  peers_not_restarted=True, collector=status['collector']['collector'], dead_letters=status['deadLetters'],
                  database_events_before=before['database']['events'], database_events_after=database['events'],
                  completed_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()))
    (stage / 'upgrade.json').write_text(json.dumps(record, indent=2))
    print(json.dumps(record), flush=True)
except BaseException as error:
    # A second interrupt must not cut the recovery sequence short.
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, signal.SIG_IGN)
    # Roll back the kernel only; never overwrite legitimately refreshed tokens or user edits.
    # Inspect disk too: a signal may land after replace but before swapped=True.
    if swapped or sha(binary) != args.from_sha256:
        run(['systemctl', 'stop', 'relay-native-cpa'], timeout=100)
        restore = binary.with_name('CLIProxyAPI.rollback-next')
        assert not restore.exists()
        shutil.copy2(backup / 'CLIProxyAPI', restore)
        os.chown(restore, old_stat.st_uid, old_stat.st_gid)
        restore.chmod(stat.S_IMODE(old_stat.st_mode))
        assert sha(restore) == args.from_sha256, 'Rollback copy failed verification'
        os.replace(restore, binary)
        run(['systemctl', 'start', 'relay-native-cpa'])
    elif stopped:
        run(['systemctl', 'start', 'relay-native-cpa'])
    end = time.monotonic() + 30
    while time.monotonic() < end:
        try:
            assert sha(binary) == args.from_sha256
            assert api('/v0/management/auth-files')[1]['x-cpa-version'] == before['cpa_version']
            assert pid('relay-native-cpa') != '0'
            break
        except (OSError, ValueError, AssertionError):
            time.sleep(.25)
    else:
        raise RuntimeError('Rollback requires operator recovery') from error
    (stage / 'rollback.json').write_text(json.dumps({'rolled_back': True, 'reason_type': type(error).__name__,
                                                   'binary_sha256': sha(binary), 'service_active': True}, indent=2))
    raise
finally:
    replacement.unlink(missing_ok=True)
