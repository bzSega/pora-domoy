"""Reproducible public packages. Only explicitly listed files may be exported."""
from pathlib import Path
import hashlib
import json
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist'
DISTR = ROOT / 'distr'
OUT.mkdir(exist_ok=True)
DISTR.mkdir(exist_ok=True)
version = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
assert json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'] == version
RUNTIME = {
    'manifest.json','background.js','core.js','content.js','widget.js',
    'offscreen.html','offscreen.js','offscreen.css','popup.html','popup.js','popup.css',
    'privacy.html','privacy.css','terms.html','icons/16.png','icons/32.png','icons/48.png','icons/128.png',
}
SOURCE_ROOT = {'README.md','INSTALL.md','LICENSE','TERMS.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md',
               'package.json','package-lock.json','.gitignore','.gitattributes','.github/workflows/check.yml'}
SOURCE_EXTRA = {'assets/icon.png','assets/popup.png','distr/README.md','scripts/2026-10-14_build.py',
                'tests/2026-10-12_extension.test.cjs','tests/2026-10-13_release.test.cjs','tests/2026-10-12_background-e2e.cjs'}
assert not any((ROOT / name).exists() for name in ('docs','store','TODO.md')), 'Internal planning material is not part of this repository'
actual = {p.relative_to(ROOT/'extension').as_posix() for p in (ROOT/'extension').rglob('*') if p.is_file()}
assert actual == RUNTIME, f'Unexpected runtime files: {actual ^ RUNTIME}'

def archive(destination, files):
    with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_STORED) as z:
        for name,file in sorted(files.items()):
            assert not file.is_symlink() and file.resolve().is_relative_to(ROOT)
            assert '..' not in Path(name).parts and not Path(name).is_absolute()
            data=file.read_bytes()
            if file.suffix in {'.md','.html','.json','.js','.cjs','.py','.yml'}:
                assert (b'/' + b'Users/') not in data and (b'/' + b'home/') not in data, name
                assert (b'-----BEGIN ' + b'PRIVATE KEY') not in data, name
            info=zipfile.ZipInfo(name,date_time=(2026,10,14,0,0,0))
            info.compress_type=zipfile.ZIP_STORED
            info.create_system=3
            info.external_attr=0o100644 << 16
            z.writestr(info,data)
    with zipfile.ZipFile(destination) as z:assert z.testzip() is None
    return destination

runtime={name:ROOT/'extension'/name for name in RUNTIME}
install_files={f'extension/{name}':file for name,file in runtime.items()}
install_files.update({'README.md':ROOT/'INSTALL.md','LICENSE':ROOT/'LICENSE','TERMS.md':ROOT/'TERMS.md','CHANGELOG.md':ROOT/'CHANGELOG.md'})
install=archive(OUT/f'pora-domoy-{version}-install.zip',install_files)
latest=DISTR/'pora-domoy-latest.zip'
shutil.copyfile(install,latest)
digest=hashlib.sha256(latest.read_bytes()).hexdigest()
(DISTR/'VERSION.json').write_text(json.dumps({'version':version,'file':latest.name,'sha256':digest},indent=2)+'\n',encoding='utf-8')
(DISTR/'SHA256SUMS.txt').write_text(f'{digest}  {latest.name}\n',encoding='utf-8')
store=archive(OUT/f'pora-domoy-{version}-store.zip',{**runtime,'LICENSE.txt':ROOT/'LICENSE','TERMS.txt':ROOT/'TERMS.md'})
source_files={name:ROOT/name for name in SOURCE_ROOT | SOURCE_EXTRA}
source_files.update({f'extension/{name}':file for name,file in runtime.items()})
source_files.update({f'distr/{name}':DISTR/name for name in ('pora-domoy-latest.zip','VERSION.json','SHA256SUMS.txt')})
source=archive(OUT/f'pora-domoy-{version}-source.zip',source_files)
outputs=[install,store,source]
checksums=''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in outputs)
(OUT/'SHA256SUMS.txt').write_text(checksums,encoding='utf-8')
print(checksums,end='')
