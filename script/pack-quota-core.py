#!/usr/bin/env python3
"""Build an allowlisted, byte-reproducible private ESM package. Never publish."""
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / 'packages/quota-core'
DIST = PACKAGE / 'dist'
# Only this generated package directory is replaced; stale JS must not ship.
if DIST.exists():
    shutil.rmtree(DIST)
subprocess.run([str(ROOT / 'node_modules/.bin/tsc'), '-p', str(PACKAGE / 'tsconfig.json')], check=True, cwd=ROOT)
manifest = json.loads((PACKAGE / 'package.json').read_text())
assert manifest['private'] is True
assert not manifest.get('dependencies')
files = [PACKAGE / name for name in ('package.json', 'README.md', 'LICENSE')]
files += sorted(p for p in DIST.iterdir() if p.name.endswith(('.js', '.d.ts')))
assert DIST / 'index.js' in files and DIST / 'index.d.ts' in files
archive = io.BytesIO()
with gzip.GzipFile(fileobj=archive, mode='wb', filename='', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for path in sorted(files):
            assert path.is_file() and not path.is_symlink()
            data = path.read_bytes()
            info = tarfile.TarInfo('package/' + path.relative_to(PACKAGE).as_posix())
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            tar.addfile(info, io.BytesIO(data))
output = ROOT / 'dist/quota-core'
output.mkdir(parents=True, exist_ok=True)
target = output / f"heznpc-quota-core-{manifest['version']}.tgz"
data = archive.getvalue()
target.write_bytes(data)
digest = hashlib.sha256(data).hexdigest()
target.with_suffix('.tgz.sha256').write_text(f'{digest}  {target.name}\n')
print(json.dumps({'package': target.name, 'sha256': digest, 'files': len(files)}))
