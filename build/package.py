#!/usr/bin/env python3
"""Reproducible Windows x64 portable package; no installers or runtime fetches."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ELECTRON = '22.3.27'
ELECTRON_SHA256 = 'ad723ed7dad32f9459f7a9de1fd6d718cf713c4809c2431503bea62ce8f786e6'

def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024*1024), b''):
            h.update(chunk)
    return h.hexdigest()

def run(command, **kwargs):
    return subprocess.run(command, check=True, **kwargs)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--go', default=os.environ.get('GO_BINARY', 'go'))
    parser.add_argument('--cc', default=os.environ.get('CC'))
    args = parser.parse_args()
    version = subprocess.check_output([args.go, 'version'], text=True)
    if 'go1.20.14 ' not in version:
        raise SystemExit('Go 1.20.14 is required for the Windows 7 compatibility build.')
    artifact = ROOT / 'artifacts'
    cache = artifact / 'cache'
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f'electron-v{ELECTRON}-win32-x64.zip'
    if not archive.exists():
        url = f'https://github.com/electron/electron/releases/download/v{ELECTRON}/{archive.name}'
        urllib.request.urlretrieve(url, archive)
    if digest(archive) != ELECTRON_SHA256:
        raise SystemExit('Electron checksum mismatch. Refusing to package.')
    env = os.environ.copy()
    env.update(GOOS='windows', GOARCH='amd64', CGO_ENABLED='1', CGO_CFLAGS='-D_WIN32_WINNT=0x0601 -O2')
    if args.cc:
        env['CC'] = args.cc
    run([args.go, 'build', '-mod=readonly', '-trimpath', '-ldflags=-s -w -extldflags=-static', '-o', str(artifact/'ConferenceServer.exe'), '.'], cwd=ROOT/'src/server', env=env)
    output = artifact / 'LocalConf-0.1.0-win-x64'
    if output.exists():
        shutil.rmtree(output)  # Only generated, versioned artifacts; never user data.
    output.mkdir()
    with zipfile.ZipFile(archive) as z:
        z.extractall(output)
    (output/'electron.exe').rename(output/'Conference.exe')
    app = output/'resources/app'
    (app/'src').mkdir(parents=True)
    shutil.copytree(ROOT/'src/desktop', app/'src/desktop')
    shutil.copy2(ROOT/'package.json', app/'package.json')
    shutil.copy2(ROOT/'package-lock.json', app/'package-lock.json')
    shutil.copytree(ROOT/'node_modules/ws', app/'node_modules/ws')
    shutil.copy2(artifact/'ConferenceServer.exe', output/'ConferenceServer.exe')
    shutil.copytree(ROOT/'docs', output/'docs')
    shutil.copy2(ROOT/'README.md', output/'README.md')
    for directory in ['recordings', 'logs', 'licenses']:
        (output/directory).mkdir(exist_ok=True)
    # Runtime state and pairing secrets must never enter the release archive.
    modules_raw = subprocess.check_output([args.go, 'list', '-m', '-json', 'all'], cwd=ROOT/'src/server', env=env, text=True)
    decoder, offset, modules = json.JSONDecoder(), 0, []
    while offset < len(modules_raw):
        while offset < len(modules_raw) and modules_raw[offset].isspace(): offset += 1
        if offset == len(modules_raw): break
        module, offset = decoder.raw_decode(modules_raw, offset)
        if module.get('Main'): continue
        modules.append({key: module[key] for key in ['Path','Version','Sum','GoModSum'] if key in module})
        folder = module.get('Dir')
        if folder:
            for pattern in ['LICENSE*','COPYING*','NOTICE*','AUTHORS*']:
                for license_file in Path(folder).glob(pattern):
                    if license_file.is_file():
                        destination = output/'licenses'/module['Path'].replace('/','_')
                        destination.mkdir(exist_ok=True)
                        shutil.copy2(license_file, destination/license_file.name)
    shutil.copy2(ROOT/'node_modules/ws/LICENSE',output/'licenses/ws-LICENSE')
    shutil.copy2(Path(subprocess.check_output([args.go,'env','GOROOT'],text=True).strip())/'LICENSE',output/'licenses/Go-LICENSE')
    (output/'licenses/SBOM.json').write_text(json.dumps({'application':'LocalConf','version':'0.1.0','electron':ELECTRON,'electronArchiveSHA256':ELECTRON_SHA256,'go':'1.20.14','npm':{'ws':'8.18.3'},'goModules':modules},indent=2))
    files = {str(p.relative_to(output)).replace('\\','/'):digest(p) for p in sorted(output.rglob('*')) if p.is_file()}
    (output/'manifest.json').write_text(json.dumps({'version':'0.1.0','files':files},indent=2))
    zip_path = artifact/(output.name+'.zip')
    with zipfile.ZipFile(zip_path,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        for p in sorted(output.rglob('*')):
            if p.is_file(): z.write(p, str(p.relative_to(artifact)))
    (artifact/(zip_path.name+'.sha256')).write_text(f'{digest(zip_path)}  {zip_path.name}\n')
    print(f'Created {zip_path} ({zip_path.stat().st_size / 1024 / 1024:.1f} MiB)')

if __name__ == '__main__':
    main()
