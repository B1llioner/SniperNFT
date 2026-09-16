import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageKit, sourceFiles } from '../scripts/package-genesis-check.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INSTALLER = path.join(ROOT, 'scripts/install-genesis-check.sh');
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vinos-genesis-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await sourceFiles(ROOT);
  for (const name of files) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'synthetic fixture\n');
  }
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts/install-genesis-check.sh'), await readFile(INSTALLER));
  await writeFile(path.join(root, '.env'), 'DO_NOT_PACKAGE_THIS_SYNTHETIC_SECRET');
  return root;
}

test('Genesis source packager excludes unlisted config and refuses overwrite', async t => {
  const root = await fixture(t);
  const output = path.join(root, 'kit');
  const manifest = await packageKit(output, root);
  const listing = spawnSync('tar', ['-tzf', path.join(output, manifest.sourceArchive)], { encoding: 'utf8' });
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /rust-genesis-minter\/src\/main.rs/);
  assert.match(listing.stdout, /rust-mint-benchmark\/src\/lib.rs/);
  assert.doesNotMatch(listing.stdout, /(?:\.env|config\.json|target\/|node_modules\/)/);
  const validate = spawnSync('python3', ['-c',
    `import pathlib,sys\ns=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\\n",1)[1].rsplit('\\nVINOS_INSTALLER',1)[0]\nn={};exec(s.rsplit('\\ntry: main',1)[0],n)\nn['archive_members'](pathlib.Path(sys.argv[2]).read_bytes(),source=True)`,
    INSTALLER, path.join(output, manifest.sourceArchive)], { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stderr);
  await assert.rejects(packageKit(output, root), /EEXIST/);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);
});

test('Genesis source packager rejects source symlinks', async t => {
  const root = await fixture(t);
  const source = path.join(root, 'rust-genesis-minter/src/main.rs');
  await rm(source);
  await symlink(path.join(root, '.env'), source);
  await assert.rejects(sourceFiles(root), /Unexpected Rust source entry/);
});

test('Genesis installer validates provenance and captures one safe SSM install plus read-only verify', () => {
  const script = String.raw`
import io,json,pathlib,shlex,stat,subprocess,sys,tarfile,tempfile,unittest.mock as mock
source=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\n",1)[1].rsplit('\nVINOS_INSTALLER',1)[0]
compile(source,'installer','exec');ns={};exec(source.rsplit('\ntry: main',1)[0],ns)
with tempfile.TemporaryDirectory(prefix='genesis-install-fixture-') as directory:
 root=pathlib.Path(directory);binary=bytearray(64);binary[:6]=b'\x7fELF\x02\x01';binary[18:20]=b'\x3e\x00';binary=bytes(binary)
 approved='a'*64
 manifest={'kind':'vinos-genesis-build-v1','sourceSha256':approved,'target':'x86_64-unknown-linux-gnu','rustc':'rustc 1.93.0 fixture',
  'binary':{'path':'bin/vinos-genesis','sha256':ns['digest'](binary),'bytes':len(binary)}}
 artifact=root/'artifact.tgz'
 with tarfile.open(artifact,'w:gz') as archive:
  for name,data in {'bin/vinos-genesis':binary,'build-manifest.json':json.dumps(manifest).encode(),'genesis-check.config.json':json.dumps(ns['CONFIG']).encode()}.items():
   member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
 ns['inspect_artifact'](artifact.read_bytes(),approved)
 try: ns['inspect_artifact'](artifact.read_bytes(),'b'*64);raise AssertionError('Unreviewed source accepted')
 except ValueError: pass
 evil=io.BytesIO()
 with tarfile.open(fileobj=evil,mode='w:gz') as archive:
  member=tarfile.TarInfo('../escape');member.size=1;archive.addfile(member,io.BytesIO(b'x'))
 try: ns['archive_members'](evil.getvalue());raise AssertionError('Traversal accepted')
 except ValueError: pass
 for invalid_kind in ('symlink','duplicate','unlisted'):
  bad=io.BytesIO()
  with tarfile.open(fileobj=bad,mode='w:gz') as archive:
   member=tarfile.TarInfo('bin/vinos-genesis' if invalid_kind!='unlisted' else 'private.key')
   if invalid_kind=='symlink': member.type=tarfile.SYMTYPE;member.linkname='/synthetic/secret'
   archive.addfile(member)
   if invalid_kind=='duplicate':archive.addfile(member)
  try:ns['archive_members'](bad.getvalue());raise AssertionError('Unsafe archive accepted: '+invalid_kind)
  except ValueError:pass
 changed=io.BytesIO();wrong_config=dict(ns['CONFIG'],quantity=3)
 with tarfile.open(fileobj=changed,mode='w:gz') as archive:
  for name,data in {'bin/vinos-genesis':binary,'build-manifest.json':json.dumps(manifest).encode(),'genesis-check.config.json':json.dumps(wrong_config).encode()}.items():
   member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
 try:ns['inspect_artifact'](changed.getvalue(),approved);raise AssertionError('Changed fixed config accepted')
 except ValueError:pass
 with mock.patch.object(ns['platform'],'system',lambda:'Darwin'),mock.patch.object(ns['platform'],'machine',lambda:'arm64'):
  try:ns['build']('/synthetic/absent-source.tgz',approved);raise AssertionError('Mac build accepted')
  except ValueError as error:assert 'Linux x86_64 CloudShell' in str(error)
 calls=[];programs=[]
 def aws(*args):
  calls.append(args)
  if args[:2]==('sts','get-caller-identity'):return {'Account':ns['ACCOUNT']}
  if args[:2]==('ec2','describe-instances'):return {'Reservations':[{'Instances':[{'InstanceId':ns['INSTANCE'],'State':{'Name':'running'},'Architecture':'x86_64'}]}]}
  if args[:2]==('s3api','get-public-access-block'):return {'PublicAccessBlockConfiguration':dict.fromkeys(('BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'),True)}
  if args[:2]==('s3api','put-object'):return {}
  if args[:2]==('ssm','send-command'):
   parameters=json.loads(args[args.index('--parameters')+1]);program=shlex.split(parameters['commands'][0])[2];compile(program,'remote','exec');programs.append(program)
   assert args[args.index('--instance-ids')+1]==ns['INSTANCE']
   return {'Command':{'CommandId':'11111111-1111-4111-8111-111111111111'}}
  raise AssertionError(args)
 ns['aws']=aws
 def run(command,**kwargs):
  assert command[:3]==['aws','s3','presign'];return subprocess.CompletedProcess(command,0,'https://'+ns['BUCKET']+'.s3.us-east-2.amazonaws.com/genesis-check/'+ns['digest'](artifact.read_bytes())+'.tgz?signature=SYNTHETIC_SECRET','')
 with mock.patch.object(pathlib.Path,'home',lambda:root),mock.patch.object(subprocess,'run',run):
  ns['install'](artifact,approved)
  assert len(programs)==1 and "[str(binary),'--help']" in programs[0]
  for path in root.glob('vinos-genesis-install-*.json'):
   assert 'SYNTHETIC_SECRET' not in path.read_text();assert stat.S_IMODE(path.stat().st_mode)==0o600
  try:ns['install'](artifact,approved);raise AssertionError('Duplicate install accepted')
  except ValueError:pass
  assert len(programs)==1
  ns['verify'](ns['digest'](artifact.read_bytes()))
  assert len(programs)==2 and "'preflight'" in programs[1] and '--send' not in programs[1] and 'check-children' not in programs[1]
  assert "'/usr/sbin/runuser'" in programs[1]
 wrapper=ns['launcher']('/opt/vinos-genesis/'+'a'*64)
 assert 'check-children --send --config' in wrapper and '--state-dir /var/lib/vinos-genesis' in wrapper
 assert 'env -i' in wrapper and 'ulimit -c 0' in wrapper and '[ ! -t 0 ]' in wrapper
 real=subprocess.run(['bash','-n'],input=wrapper,text=True,capture_output=True);assert real.returncode==0,real.stderr
print('offline fixture checks passed; AWS was mocked')
`;
  const result = spawnSync('python3', ['-', INSTALLER], { input: script, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /offline fixture checks passed/);
});

test('Genesis remote installer resets inherited umask 077 and keeps state private', () => {
  const script = String.raw`
import os,pathlib,stat,sys,tempfile,unittest.mock as mock
source=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\n",1)[1].rsplit('\nVINOS_INSTALLER',1)[0]
ns={};exec(source.rsplit('\ntry: main',1)[0],ns)
remote=ns['remote_program']('https://example.invalid/object','a'*64,'b'*64,'c'*64,ns['launcher']('/opt/vinos-genesis/'+'a'*64))
prefix=remote.split("user=pwd.getpwnam('ssm-user')",1)[0]
before=os.umask(0o077)
try:
 with tempfile.TemporaryDirectory(prefix='genesis-modes-') as tmp, mock.patch.object(os,'geteuid',lambda:0):
  scope={};exec(prefix,scope)
  base=pathlib.Path(tmp)/'program';scope['directory'](base,0o755,os.getuid(),os.getgid())
  stage=base/'stage';stage.mkdir(mode=0o755)
  binary=stage/'bin'/'vinos-genesis';binary.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
  binary.write_text('synthetic fixture');binary.chmod(0o755)
  state=pathlib.Path(tmp)/'state';scope['directory'](state,0o700,os.getuid(),os.getgid())
  for p in (base,stage,binary.parent,binary): assert stat.S_IMODE(p.stat().st_mode)==0o755,(p,p.stat().st_mode)
  assert stat.S_IMODE(state.stat().st_mode)==0o700
finally:os.umask(before)
print('program 0755; state 0700 despite inherited umask 077')
`;
  const result = spawnSync('python3', ['-', INSTALLER], { input: script, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /despite inherited umask 077/);
});
