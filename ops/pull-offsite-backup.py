"""Pull an existing server dump to a private Windows folder. No production writes."""
import argparse
import csv
import ctypes
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone


def checked(args, **kwargs):
    result = subprocess.run(args, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, **kwargs)
    if result.returncode:
        # Remote errors can include database/config values. Never copy them to logs.
        raise RuntimeError(f'{Path(str(args[0])).name} failed (exit {result.returncode})')
    return result.stdout


def sha256(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def protect(data, decrypt=False):
    """DPAPI CurrentUser: recovery needs this Windows account on this computer."""
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]
    buffer = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    crypt = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    method = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    method.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                       ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    method.restype = wintypes.BOOL
    # UI_FORBIDDEN: a scheduled task must never display a password dialog.
    if not method(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise RuntimeError('Windows DPAPI operation failed')
    try:
        return ctypes.string_at(outgoing.data, outgoing.size)
    finally:
        kernel.LocalFree(outgoing.data)


def private_directory(path):
    if not path.is_absolute() or path.is_symlink() or path.is_junction():
        raise RuntimeError('Backup directory must be an absolute, regular local directory')
    path.mkdir(parents=True, exist_ok=True)
    sid = next(csv.reader(checked(['whoami', '/user', '/fo', 'csv', '/nh']).decode().splitlines()))[1]
    checked(['icacls', str(path), '/inheritance:r', '/grant:r',
             f'*{sid}:(OI)(CI)F', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'])


def atomic_json(path, data):
    temporary = path.with_suffix(path.suffix + '.part')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


def pull(config):
    folder = Path(config['backupDirectory'])
    private_directory(folder)
    openssh = Path(os.environ['WINDIR']) / 'System32/OpenSSH/ssh.exe'
    ssh = [str(openssh), '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
           '-i', str(Path(config['identityFile']).expanduser()), config['sshDestination']]
    if not re.fullmatch(r'[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+', config['sshDestination']):
        raise RuntimeError('Invalid SSH destination')
    remote_folder = config['remoteBackupDirectory']
    manifest_program = '''import hashlib,json,pathlib,re
p=pathlib.Path(DIRECTORY)
files=[f for f in p.glob('argus-*.sql.gz') if re.fullmatch(r'argus-[0-9_-]+[.]sql[.]gz',f.name) and f.is_file() and not f.is_symlink()]
if not files: raise SystemExit(2)
f=max(files,key=lambda f:f.stat().st_mtime)
digest_state=hashlib.sha256()
with f.open('rb') as stream:
    for chunk in iter(lambda:stream.read(1024*1024),b''): digest_state.update(chunk)
digest=digest_state.hexdigest()
manifest=json.loads(pathlib.Path(str(f)+'.json').read_text())
if digest != manifest['sha256'] or not manifest.get('configurationMatched'): raise SystemExit(3)
print(json.dumps(dict(name=f.name,size=f.stat().st_size,modified=f.stat().st_mtime,sha256=digest,configurationSha256=manifest['configurationSha256'])))
'''.replace('DIRECTORY', repr(remote_folder))
    remote = json.loads(checked(ssh + ['python3 -'], input=manifest_program.encode(), timeout=90))
    name = remote['name']
    if not re.fullmatch(r'argus-[0-9_-]+[.]sql[.]gz', name):
        raise RuntimeError('Unexpected backup filename')
    age_hours = (datetime.now(timezone.utc).timestamp() - remote['modified']) / 3600
    if age_hours > config.get('maxAgeHours', 48) or remote['size'] < 10240:
        raise RuntimeError('Server backup is missing, stale or unexpectedly small')
    destination = folder / name
    if not destination.exists() or sha256(destination) != remote['sha256']:
        temporary = destination.with_suffix('.gz.part')
        try:
            with temporary.open('wb') as target:
                result = subprocess.run(ssh + ['cat -- ' + shlex.quote(remote_folder.rstrip('/') + '/' + name)],
                                        stdout=target, stderr=subprocess.PIPE, timeout=300,
                                        creationflags=subprocess.CREATE_NO_WINDOW)
            if result.returncode or temporary.stat().st_size != remote['size'] or sha256(temporary) != remote['sha256']:
                raise RuntimeError('Downloaded dump failed size or SHA-256 verification')
            with gzip.open(temporary, 'rb') as stream:
                while stream.read(1024 * 1024):
                    pass  # validates the complete gzip stream including CRC/trailer
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    else:
        with gzip.open(destination, 'rb') as stream:
            while stream.read(1024 * 1024):
                pass

    # The DB contains encrypted marketplace credentials. Preserve the matching
    # API recovery configuration encrypted, without writing plaintext to disk.
    env_data = checked(ssh + ['cat -- ' + shlex.quote(remote_folder.rstrip('/') + '/' + name + '.env')], timeout=60)
    if not env_data or len(env_data) > 1024 * 1024 or hashlib.sha256(env_data).hexdigest() != remote['configurationSha256']:
        raise RuntimeError('Unexpected API recovery configuration size')
    protected = protect(env_data)
    if protect(protected, decrypt=True) != env_data:
        raise RuntimeError('DPAPI roundtrip verification failed')
    recovery = folder / (name + '.env.dpapi')
    temporary = recovery.with_suffix('.part')
    temporary.write_bytes(protected)
    temporary.replace(recovery)
    del env_data, protected
    result = {**remote, 'verifiedAt': datetime.now(timezone.utc).isoformat(),
              'gzipVerified': True, 'configurationProtected': 'Windows DPAPI CurrentUser',
              'configurationCiphertextSha256': sha256(recovery), 'configurationMatched': True}
    atomic_json(folder / (name + '.json'), result)
    atomic_json(folder / 'status.json', {'ok': True, **result})
    # Only completed sets created by this tool are eligible for retention.
    manifests = sorted(folder.glob('argus-*.sql.gz.json'), reverse=True)
    for old in manifests[max(2, int(config.get('keepCopies', 14))) :]:
        old_name = old.name.removesuffix('.json')
        if re.fullmatch(r'argus-[0-9_-]+[.]sql[.]gz', old_name):
            for suffix in ('', '.env.dpapi', '.json'):
                (folder / (old_name + suffix)).unlink(missing_ok=True)
    print(f'Backup verified: {name} ({remote["size"]} bytes); recovery config protected.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8-sig'))
    try:
        pull(config)
    except Exception as error:
        # Log the stage/error class, never stdout/stderr of remote commands.
        atomic_json(Path(config['backupDirectory']) / 'status.json',
                    {'ok': False, 'checkedAt': datetime.now(timezone.utc).isoformat(),
                     'error': str(error) if isinstance(error, RuntimeError) else type(error).__name__})
        print('Backup failed. Inspect private status.json.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
