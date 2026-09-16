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

test('Genesis upgrade atomically replaces only the pinned launcher after verification and preserves existing state/config', () => {
  const script = String.raw`
import contextlib,fcntl,io,json,os,pathlib,pwd,stat,subprocess,sys,tarfile,tempfile,traceback,types,unittest.mock as mock
source=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\n",1)[1].rsplit('\nVINOS_INSTALLER',1)[0]
ns={};exec(source.rsplit('\ntry: main',1)[0],ns)
old_sha=ns['UPGRADE_FROM']['artifactSha256'];source_sha='b'*64
old_wrapper=ns['launcher']('/opt/vinos-genesis/'+old_sha).encode()
assert ns['digest'](old_wrapper)==ns['UPGRADE_FROM']['launcherSha256']
binary=b'synthetic executable fixture';binary_sha=ns['digest'](binary)
build_manifest={'kind':'vinos-genesis-build-v1','sourceSha256':source_sha,
 'binary':{'path':'bin/vinos-genesis','sha256':binary_sha,'bytes':len(binary)}}
packed=io.BytesIO()
with tarfile.open(fileobj=packed,mode='w:gz') as archive:
 for name,data in {'bin/vinos-genesis':binary,'build-manifest.json':json.dumps(build_manifest).encode(),
  'genesis-check.config.json':json.dumps(ns['CONFIG']).encode()}.items():
  member=tarfile.TarInfo(name);member.size=len(data);archive.addfile(member,io.BytesIO(data))
archive_data=packed.getvalue();new_sha=ns['digest'](archive_data)
new_wrapper=ns['launcher']('/opt/vinos-genesis/'+new_sha).encode()

def installed(dest,artifact_sha):
 (dest/'bin').mkdir(parents=True,mode=0o755);dest.chmod(0o755)
 (dest/'bin/vinos-genesis').write_bytes(binary);(dest/'bin/vinos-genesis').chmod(0o755)
 for name,value in {
  'installation.json':{'artifactSha256':artifact_sha,'sourceSha256':source_sha,'binarySha256':binary_sha},
  'build-manifest.json':{'kind':'vinos-genesis-build-v1','sourceSha256':source_sha,
    'binary':{'path':'bin/vinos-genesis','sha256':binary_sha,'bytes':len(binary)}},
  'genesis-check.config.json':ns['CONFIG'],
 }.items():
  (dest/name).write_text(json.dumps(value));(dest/name).chmod(0o644)

cases=('upgrade','already-new','different-launcher','old-marker-changed','old-binary-changed',
 'old-config-changed','symlink-launcher','help-fails','launcher-race','install-refuses-upgrade','lock-held','new-binary-changed',
 'fresh-upgrade','fresh-help-fails','bad-download')
for case in cases:
 with tempfile.TemporaryDirectory(prefix='genesis-upgrade-'+case+'-') as directory:
  root=pathlib.Path(directory);base=root/'opt/vinos-genesis';cmd=root/'usr/local/bin/vinos-genesis-check'
  cmd.parent.mkdir(parents=True,mode=0o755);state=root/'var/lib/vinos-genesis';state.mkdir(parents=True,mode=0o700)
  state.chmod(0o700);(state/'saved-factory.json').write_text('{"factory":"0x1111111111111111111111111111111111111111"}\n')
  installed(base/old_sha,old_sha)
  if case not in ('fresh-upgrade','fresh-help-fails','bad-download'):installed(base/new_sha,new_sha)
  cmd.write_bytes(old_wrapper);cmd.chmod(0o755)
  if case=='already-new':cmd.write_bytes(new_wrapper)
  if case=='different-launcher':cmd.write_text('unreviewed launcher\n')
  if case=='old-marker-changed':
   p=base/old_sha/'installation.json';value=json.loads(p.read_text());value['artifactSha256']='d'*64;p.write_text(json.dumps(value))
  if case=='old-binary-changed':(base/old_sha/'bin/vinos-genesis').write_bytes(b'changed old binary')
  if case=='new-binary-changed':(base/new_sha/'bin/vinos-genesis').write_bytes(b'changed new binary')
  if case=='old-config-changed':
   p=base/old_sha/'genesis-check.config.json';value=json.loads(p.read_text());value['quantity']=10;p.write_text(json.dumps(value))
  if case=='symlink-launcher':
   sink=root/'untouched';sink.write_bytes(old_wrapper);cmd.unlink();cmd.symlink_to(sink)
  initial=cmd.read_bytes();initial_inode=cmd.lstat().st_ino
  protected={p:(p.read_bytes(),p.stat().st_mtime_ns) for parent in (base/old_sha,state) for p in parent.rglob('*') if p.is_file()}
  remote=ns['remote_program']('https://example.invalid/artifact',new_sha,source_sha,binary_sha,new_wrapper.decode(),
   None if case=='install-refuses-upgrade' else ns['UPGRADE_FROM'])
  # Execute the generated production program in a temporary filesystem. The
  # current test user's UID/GID represent root; no real /opt,/usr,/var or AWS is touched.
  for absolute in ('/opt/vinos-genesis','/usr/local/bin/vinos-genesis-check','/var/lib/vinos-genesis',
   '/opt','/usr','/usr/local','/usr/local/bin','/var','/var/lib'):
   remote=remote.replace(repr(absolute),repr(str(root/absolute.lstrip('/'))))
  remote=remote.replace('def directory(path,mode,uid=0,gid=0):',f'def directory(path,mode,uid={os.getuid()},gid={os.getgid()}):')
  remote=remote.replace('i.st_uid==0',f'i.st_uid=={os.getuid()}').replace('lock_info.st_uid==0',f'lock_info.st_uid=={os.getuid()}')
  remote=remote.replace('if uid==0:',f'if uid=={os.getuid()} and mode!=0o700:')
  scope={};help_calls=[];replacements=[];downloads=[];promotions=[];real_replace=os.replace;held=None
  if case=='lock-held':
   held=os.open(base/'.install.lock',os.O_RDWR|os.O_CREAT,0o600);fcntl.flock(held,fcntl.LOCK_EX|fcntl.LOCK_NB)
  def run(command,**kwargs):
   if command[0]=='curl':
    assert case in ('fresh-upgrade','fresh-help-fails','bad-download') and not help_calls
    assert cmd.read_bytes()==old_wrapper and command[-1]=='https://example.invalid/artifact'
    assert command[command.index('--retry')+1]=='0' and command[command.index('--proto')+1]=='=https'
    downloads.append(command);pathlib.Path(command[command.index('--output')+1]).write_bytes(archive_data+(b'changed' if case=='bad-download' else b''))
    return subprocess.CompletedProcess(command,0)
   assert command==[str(base/new_sha/'bin/vinos-genesis'),'--help'],command
   assert kwargs['stdin']==subprocess.DEVNULL and kwargs['timeout']==10
   help_calls.append(command);assert cmd.read_bytes()==initial,'Launcher switched before help verification'
   if case in ('help-fails','fresh-help-fails'):raise subprocess.CalledProcessError(1,command)
   if case=='launcher-race':cmd.write_bytes(b'independent root update\n')
   return subprocess.CompletedProcess(command,0)
  def replace(source,target):
   if pathlib.Path(target)==base/new_sha:
    assert case in ('fresh-upgrade','fresh-help-fails') and not help_calls and len(downloads)==1
    promotions.append((source,target));return real_replace(source,target)
   assert pathlib.Path(target)==cmd,'Only launcher should be switched in a pre-staged upgrade'
   assert len(help_calls)==1 and cmd.read_bytes()==old_wrapper
   replacements.append((source,target));return real_replace(source,target)
  error=None;error_trace=None;output=io.StringIO();before_umask=os.umask(0o077)
  try:
   with mock.patch.object(os,'geteuid',lambda:0),mock.patch.object(pwd,'getpwnam',lambda name:types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())),\
    mock.patch.object(subprocess,'run',run),mock.patch.object(os,'replace',replace),contextlib.redirect_stdout(output):
    try:exec(compile(remote,'isolated-remote-installer','exec'),scope)
    except Exception as caught:error=caught;error_trace=traceback.format_exc()
  finally:
   os.umask(before_umask)
   if 'lock_fd' in scope:
    try:os.close(scope['lock_fd'])
    except OSError:pass
   if held is not None:os.close(held)
  for p,(body,mtime) in protected.items():assert p.read_bytes()==body and p.stat().st_mtime_ns==mtime,(case,p)
  assert stat.S_IMODE(state.stat().st_mode)==0o700
  if case in ('upgrade','already-new','fresh-upgrade'):
   assert error is None,(case,error_trace)
   report=json.loads(output.getvalue());assert report['installed'] and report['upgradedFrom']==old_sha
   assert report['transactionsSent']==0 and report['privateKeyRead'] is False
   assert cmd.read_bytes()==new_wrapper and stat.S_IMODE(cmd.stat().st_mode)==0o755
   assert len(help_calls)==1 and len(replacements)==(0 if case=='already-new' else 1)
   assert (cmd.stat().st_ino!=initial_inode)==(case!='already-new')
  else:
   assert error is not None,case
   assert not replacements and '"installed": true' not in output.getvalue(),case
   assert cmd.read_bytes()==(b'independent root update\n' if case=='launcher-race' else initial),case
   if case not in ('help-fails','fresh-help-fails','launcher-race'):assert not help_calls,case
  assert len(downloads)==(1 if case in ('fresh-upgrade','fresh-help-fails','bad-download') else 0)
  assert len(promotions)==(1 if case in ('fresh-upgrade','fresh-help-fails') else 0)
print('15 isolated upgrade cases passed; existing config/state untouched; no AWS or real deployment')
`;
  const result = spawnSync('python3', ['-', INSTALLER], { input: script, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /15 isolated upgrade cases passed/);
});
