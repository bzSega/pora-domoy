const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..'), ext=path.join(root,'extension');
const manifest=JSON.parse(fs.readFileSync(path.join(ext,'manifest.json'),'utf8'));
test('Release version matches package; all manifest resources and HTML assets are local and present',()=>{
  assert.equal(manifest.manifest_version,3);
  assert.equal(manifest.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version);
  const files=[manifest.background.service_worker,manifest.action.default_popup,...Object.values(manifest.icons),...manifest.content_scripts.flatMap(s=>s.js)];
  for(const file of files)assert.ok(fs.existsSync(path.join(ext,file)),file);
  for(const file of ['popup.html','offscreen.html','privacy.html','terms.html']) {
    const html=fs.readFileSync(path.join(ext,file),'utf8');
    assert.doesNotMatch(html,/<script[^>]+src=["']https?:/i);
    assert.doesNotMatch(html,/\son\w+=/i);
    for(const [,asset] of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
      if(!/^(?:https:|mailto:)/.test(asset))assert.ok(fs.existsSync(path.join(ext,asset)),asset);
    }
  }
});
test('Shipping permissions and source stay free of analytics, ads SDKs and dynamic code execution',()=>{
  assert.deepEqual([...manifest.permissions].sort(),['alarms','offscreen','storage']);
  assert.ok(manifest.host_permissions.every(p=>/^https:\/\/(www\.)?yandex\.ru\/(maps|map-widget)\/\*$/.test(p)));
  for(const file of fs.readdirSync(ext).filter(f=>f.endsWith('.js'))) {
    const source=fs.readFileSync(path.join(ext,file),'utf8');
    assert.doesNotMatch(source,/\beval\s*\(|new\s+Function\s*\(|\.innerHTML\s*=/);
    assert.doesNotMatch(source,/mc\.yandex|google-analytics|googlesyndication|api_secret|oauth_token/i);
    const result=spawnSync(process.execPath,['--check',path.join(ext,file)],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
});
test('Popup controls have unique identifiers and static event bindings reference existing elements',()=>{
  const html=fs.readFileSync(path.join(ext,'popup.html'),'utf8');
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(ids.length,new Set(ids).size);
  const js=fs.readFileSync(path.join(ext,'popup.js'),'utf8');
  for(const [,id] of js.matchAll(/(?:\$\(|action\()'([^']+)'/g))assert.ok(ids.includes(id),id);
});
test('Ready-to-install download matches runtime and excludes internal project material',()=>{
  const check=String.raw`
from pathlib import Path
import json,hashlib,zipfile
r=Path.cwd(); d=r/'distr'; meta=json.loads((d/'VERSION.json').read_text())
assert meta['version']==json.loads((r/'extension/manifest.json').read_text())['version']
p=d/meta['file']; assert hashlib.sha256(p.read_bytes()).hexdigest()==meta['sha256']
assert (d/'SHA256SUMS.txt').read_text()==meta['sha256']+'  '+p.name+'\n'
with zipfile.ZipFile(p) as z:
    expected={'extension/'+f.relative_to(r/'extension').as_posix() for f in (r/'extension').rglob('*') if f.is_file()}
    expected|={'README.md','LICENSE','TERMS.md','CHANGELOG.md'}
    assert set(z.namelist())==expected
    for name in expected:
        source=r/('INSTALL.md' if name=='README.md' else name)
        assert z.read(name)==source.read_bytes()
assert not any((r/f).exists() for f in ['docs','store','TODO.md'])
`;
  const result=spawnSync('python3',['-c',check],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
