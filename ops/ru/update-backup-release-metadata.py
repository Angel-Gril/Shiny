"""Patch the installed RU backup to include its effective release and drop-ins."""
import ast
import os
from pathlib import Path
import subprocess


def main():
    if os.geteuid() != 0:
        raise SystemExit("Run on the RU server as root")
    backup = Path("/usr/local/lib/shiny-ru/backup-r2.py")
    source = backup.read_text()
    if "effective-release.json" in source and "shiny-ru-newapi.service.d" in source:
        print("RU backup already records the effective release and drop-ins")
        return
    old = "        manifest={'database':'shiny_ru','created_utc':stamp,'dump_sha256':checksum(dump),'release':'/srv/shiny/new-api/releases/ru-c0eae777','source_commit':'c0eae7770d2b65f3ed7b83d40cfb7592f65d89e3','main_database_included':False}"
    assert source.count(old) == 1, "Unknown installed backup; inspect before patching"
    new = '''        dropins=Path('/etc/systemd/system/shiny-ru-newapi.service.d')
        if dropins.exists():
            shutil.copytree(dropins,payload/dropins.name)
        pid=run(['systemctl','show','shiny-ru-newapi','-p','MainPID','--value'])
        executable=Path('/proc/'+pid+'/exe').resolve(strict=True)
        release=executable.parent
        assert release.parent==Path('/srv/shiny/new-api/releases')
        release_manifest=release/'manifest.json'
        if release_manifest.exists():
            deployed=json.loads(release_manifest.read_text())
            assert checksum(executable)==deployed['binary_sha256']
            shutil.copyfile(release_manifest,payload/'effective-release.json')
            source_commit=deployed['source_commit']
        else:
            assert release.name=='ru-c0eae777'
            source_commit='c0eae7770d2b65f3ed7b83d40cfb7592f65d89e3'
        manifest={'database':'shiny_ru','created_utc':stamp,'dump_sha256':checksum(dump),'release':str(release),'source_commit':source_commit,'binary_sha256':checksum(executable),'main_database_included':False}'''
    patched = source.replace(old, new, 1)
    ast.parse(patched)
    subprocess.run(["systemctl", "is-active", "shiny-ru-newapi"], check=True, capture_output=True)
    previous = backup.stat()
    temporary = backup.with_name(backup.name + ".release-metadata-next")
    temporary.write_text(patched)
    temporary.chmod(previous.st_mode & 0o777)
    os.chown(temporary, previous.st_uid, previous.st_gid)
    os.replace(temporary, backup)
    print("RU backup now captures the effective release manifest and service drop-ins")


if __name__ == "__main__":
    main()
