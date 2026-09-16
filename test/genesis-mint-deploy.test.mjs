import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageKit, sourceFiles } from '../scripts/package-genesis-mint.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INSTALLER = path.join(ROOT, 'scripts/install-genesis-check.sh');
function python(script) {
  const result = spawnSync('python3', ['-', INSTALLER], { input: script, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test('Public source kit pins both installers and excludes wallet/state/config inputs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'genesis-public-kit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of await sourceFiles()) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'synthetic source\n');
  }
  await mkdir(path.join(root, 'scripts'));
  for (const name of ['install-genesis-check.sh', 'install-genesis-mint.sh']) {
    await writeFile(path.join(root, 'scripts', name), await readFile(path.join(ROOT, 'scripts', name)));
  }
  await writeFile(path.join(root, '.env'), 'UNLISTED_SYNTHETIC_SECRET');
  const output = path.join(root, 'kit');
  const manifest = await packageKit(output, root);
  assert.equal(manifest.launcher, 'vinos-genesis-mint');
  assert.equal(manifest.installRunsTransactions, false);
  assert.deepEqual(Object.keys(manifest.installerHashes).sort(), ['install-genesis-check.sh', 'install-genesis-mint.sh']);
  const listing = spawnSync('tar', ['-tzf', path.join(output, manifest.sourceArchive)], { encoding: 'utf8' });
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /docs\/GENESIS_MINT_SERVER.md/);
  assert.doesNotMatch(listing.stdout, /(?:\.env|config\.json|state\.json|\.state\/|target\/)/);
  const validate = spawnSync('python3', ['-c',
    `import pathlib,sys\ns=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\\n",1)[1].rsplit('\\nVINOS_INSTALLER',1)[0]\nn={};exec(s.rsplit('\\ntry: main',1)[0],n)\nn['archive_members'](pathlib.Path(sys.argv[2]).read_bytes(),source=True,profile=n['PUBLIC'])`,
    INSTALLER, path.join(output, manifest.sourceArchive)], { encoding: 'utf8' });
  assert.equal(validate.status, 0, validate.stderr);
  await assert.rejects(packageKit(output, root), /EEXIST/);
});

test('Public install and verify stay read-only, reject checker artifacts and do not expose presigned URLs', () => {
  python(String.raw`
import io,json,pathlib,shlex,subprocess,sys,tarfile,tempfile,unittest.mock as mock
source=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\n",1)[1].rsplit('\nVINOS_INSTALLER',1)[0]
ns={};exec(source.rsplit('\ntry: main',1)[0],ns);profile=ns['PUBLIC'];approved='a'*64
assert profile['config']['mode']=='public' and profile['config']['quantity']==10 and profile['config']['minQuantity']==1
assert profile['config']['waitTimeoutSecs']==172800 and profile['config']['pollIntervalMs']==250
assert profile['config']['sendRpcUrls']==['https://sequencer.mainnet.chain.robinhood.com']
assert ns['CONFIG']['mode']=='signed' and ns['CONFIG']['quantity']==2
binary=bytearray(64);binary[:6]=b'\x7fELF\x02\x01';binary[18:20]=b'\x3e\x00';binary=bytes(binary)
manifest={'kind':'vinos-genesis-build-v1','sourceSha256':approved,'target':'x86_64-unknown-linux-gnu','rustc':'rustc 1.93.0 synthetic',
 'binary':{'path':'bin/vinos-genesis','sha256':ns['digest'](binary),'bytes':len(binary)}}
with tempfile.TemporaryDirectory() as directory:
 root=pathlib.Path(directory);artifact=root/'public.tgz'
 with tarfile.open(artifact,'w:gz') as packed:
  for name,body in {'bin/vinos-genesis':binary,'build-manifest.json':json.dumps(manifest).encode(),profile['configName']:json.dumps(profile['config']).encode()}.items():
   info=tarfile.TarInfo(name);info.size=len(body);packed.addfile(info,io.BytesIO(body))
 ns['inspect_artifact'](artifact.read_bytes(),approved,profile)
 try:ns['inspect_artifact'](artifact.read_bytes(),approved);raise AssertionError('Public artifact accepted as checker')
 except ValueError:pass
 programs=[];parameters=[]
 def aws(*args):
  if args[:2]==('sts','get-caller-identity'):return {'Account':ns['ACCOUNT']}
  if args[:2]==('ec2','describe-instances'):return {'Reservations':[{'Instances':[{'InstanceId':ns['INSTANCE'],'State':{'Name':'running'},'Architecture':'x86_64'}]}]}
  if args[:2]==('s3api','get-public-access-block'):return {'PublicAccessBlockConfiguration':dict.fromkeys(('BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets'),True)}
  if args[:2]==('s3api','put-object'):assert args[args.index('--key')+1].startswith('genesis-mint/');return {}
  if args[:2]==('ssm','send-command'):
   value=json.loads(args[args.index('--parameters')+1]);program=shlex.split(value['commands'][0])[2]
   compile(program,'remote','exec');programs.append(program);parameters.append(value)
   return {'Command':{'CommandId':'11111111-1111-4111-8111-111111111111'}}
  raise AssertionError(args)
 ns['aws']=aws
 def presign(command,**kwargs):
  assert command[:3]==['aws','s3','presign']
  return subprocess.CompletedProcess(command,0,'https://'+ns['BUCKET']+'.s3.us-east-2.amazonaws.com/genesis-mint/'+ns['digest'](artifact.read_bytes())+'.tgz?signature=SYNTHETIC_SECRET','')
 with mock.patch.object(pathlib.Path,'home',lambda:root),mock.patch.object(subprocess,'run',presign):
  ns['install'](artifact,approved,profile=profile)
  ns['verify'](ns['digest'](artifact.read_bytes()),profile)
 assert parameters[0]['executionTimeout']==['360']
 assert "cmd=pathlib.Path('/usr/local/bin/vinos-genesis-mint')" in programs[0]
 assert "cmd=pathlib.Path('/usr/local/bin/vinos-genesis-check')" not in programs[0]
 assert "'preflight'" in programs[1] and '--send' not in programs[1] and 'check-children' not in programs[1]
 assert 'genesis-mint.config.json' in programs[1] and "'/usr/bin/tmux','-V'" in programs[1]
 for p in root.glob('*.json'):assert 'SYNTHETIC_SECRET' not in p.read_text()
 try:ns['main'](['--public','upgrade',str(artifact),approved]);raise AssertionError('Unreviewed public upgrade accepted')
 except ValueError:pass
print('Public-only installation and read-only verification checked offline')
`);
});

test('Generated public installer preserves the existing checker and saved factory, and publishes only after binary and tmux checks', () => {
  python(String.raw`
import contextlib,io,json,os,pathlib,pwd,stat,subprocess,sys,tarfile,tempfile,traceback,types,unittest.mock as mock
source=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\n",1)[1].rsplit('\nVINOS_INSTALLER',1)[0]
ns={};exec(source.rsplit('\ntry: main',1)[0],ns);profile=ns['PUBLIC'];source_sha='b'*64
binary=b'synthetic binary';binary_sha=ns['digest'](binary)
build={'kind':'vinos-genesis-build-v1','sourceSha256':source_sha,'binary':{'path':'bin/vinos-genesis','sha256':binary_sha,'bytes':len(binary)}}
packed=io.BytesIO()
with tarfile.open(fileobj=packed,mode='w:gz') as tar:
 for name,body in {'bin/vinos-genesis':binary,'build-manifest.json':json.dumps(build).encode(),profile['configName']:json.dumps(profile['config']).encode()}.items():
  info=tarfile.TarInfo(name);info.size=len(body);tar.addfile(info,io.BytesIO(body))
data=packed.getvalue();sha=ns['digest'](data);wrapper=ns['launcher']('/opt/vinos-genesis/'+sha,profile)
for case in ('fresh','tmux-missing','tmux-install-fails','help-fails','bad-download','foreign-launcher','symlink-launcher','tmux-fails'):
 with tempfile.TemporaryDirectory(prefix='public-install-') as directory:
  root=pathlib.Path(directory);base=root/'opt/vinos-genesis';base.mkdir(parents=True)
  cmd=root/'usr/local/bin/vinos-genesis-mint';cmd.parent.mkdir(parents=True)
  checker=cmd.with_name('vinos-genesis-check');checker.write_text('PREEXISTING_CHECKER');checker.chmod(0o755)
  old=base/'old-immutable-checker';old.mkdir();(old/'genesis-check.config.json').write_text('PREEXISTING_CHECKER_CONFIG')
  state=root/'var/lib/vinos-genesis';state.mkdir(parents=True);state.chmod(0o700)
  (state/'state.json').write_text('{"factory":"0x1234","total_gas_cost":"7"}')
  tmux=root/'usr/bin/tmux';tmux.parent.mkdir(parents=True)
  if case not in ('tmux-missing','tmux-install-fails'):tmux.write_text('synthetic tmux');tmux.chmod(0o755)
  if case=='foreign-launcher':cmd.write_text('FOREIGN');cmd.chmod(0o755)
  if case=='symlink-launcher':cmd.symlink_to(checker)
  protected={p:(p.read_bytes(),p.stat().st_mtime_ns) for p in (checker,old/'genesis-check.config.json',state/'state.json')}
  remote=ns['remote_program']('https://example.invalid/public',sha,source_sha,binary_sha,wrapper,profile=profile)
  for absolute in ('/opt/vinos-genesis','/usr/local/bin/vinos-genesis-mint','/var/lib/vinos-genesis','/usr/bin/tmux',
   '/opt','/usr','/usr/local','/usr/local/bin','/var','/var/lib'):
   remote=remote.replace(repr(absolute),repr(str(root/absolute.lstrip('/'))))
  remote=remote.replace('def directory(path,mode,uid=0,gid=0):',f'def directory(path,mode,uid={os.getuid()},gid={os.getgid()}):')
  remote=remote.replace('i.st_uid==0',f'i.st_uid=={os.getuid()}').replace('lock_info.st_uid==0',f'lock_info.st_uid=={os.getuid()}')
  remote=remote.replace('if uid==0:',f'if uid=={os.getuid()} and mode!=0o700:')
  calls=[];scope={};output=io.StringIO();error=None
  def run(command,**kwargs):
   calls.append(command)
   assert not cmd.exists() or case in ('foreign-launcher','symlink-launcher'),'Published before all prerequisite checks'
   if command[0]=='curl':
    pathlib.Path(command[command.index('--output')+1]).write_bytes(data+(b'x' if case=='bad-download' else b''))
   elif command==[str(base/sha/'bin/vinos-genesis'),'--help']:
    if case=='help-fails':raise subprocess.CalledProcessError(1,command)
   elif command==['/usr/bin/dnf','install','--assumeyes','tmux']:
    assert case in ('tmux-missing','tmux-install-fails') and kwargs['timeout']==120
    if case=='tmux-install-fails':raise subprocess.CalledProcessError(1,command)
    tmux.write_text('new synthetic tmux');tmux.chmod(0o755)
   elif command==[str(tmux),'-V']:
    if case=='tmux-fails':raise subprocess.CalledProcessError(1,command)
   else:raise AssertionError(command)
   return subprocess.CompletedProcess(command,0)
  before=os.umask(0o077)
  try:
   with mock.patch.object(os,'geteuid',lambda:0),mock.patch.object(pwd,'getpwnam',lambda _:types.SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid())),mock.patch.object(subprocess,'run',run),contextlib.redirect_stdout(output):
    try:exec(compile(remote,'remote','exec'),scope)
    except Exception as caught:error=caught
  finally:
   os.umask(before)
   if 'lock_fd' in scope:
    try:os.close(scope['lock_fd'])
    except OSError:pass
  for p,(body,mtime) in protected.items():assert p.read_bytes()==body and p.stat().st_mtime_ns==mtime,(case,p)
  assert stat.S_IMODE(state.stat().st_mode)==0o700
  if case in ('fresh','tmux-missing'):
   assert error is None,(case,error)
   assert cmd.read_text()==wrapper and stat.S_IMODE(cmd.stat().st_mode)==0o755
   report=json.loads(output.getvalue());assert report['privateKeyRead'] is False and report['transactionsSent']==0
  else:
   assert error is not None,case
   assert not cmd.exists() or case in ('foreign-launcher','symlink-launcher'),case
print('8 generated public install scenarios checked; checker/state untouched')
`);
});

test('Public launcher validates inputs, sends only setup/start, reattaches existing tmux and never resets a live process', () => {
  python(String.raw`
import errno,json,os,pathlib,pty,select,subprocess,sys,tempfile,time
source=pathlib.Path(sys.argv[1]).read_text().split("<<'VINOS_INSTALLER'\n",1)[1].rsplit('\nVINOS_INSTALLER',1)[0]
ns={};exec(source.rsplit('\ntry: main',1)[0],ns)
with tempfile.TemporaryDirectory(prefix='public-launcher-') as directory:
 root=pathlib.Path(directory);log=root/'calls.jsonl';scenario=root/'scenario';stub=root/'tmux';binary=root/'bin/vinos-genesis';binary.parent.mkdir()
 stub.write_text('#!/usr/bin/python3\n'+'''import json,os,pathlib,subprocess,sys
log=pathlib.Path('''+repr(str(log))+''');scenario=pathlib.Path('''+repr(str(scenario))+''').read_text()
args=sys.argv[1:];args=args[4:] if args[2:3]==['-f'] else args[2:]
with log.open('a') as f:f.write(json.dumps({'tmux':args,'env':dict(os.environ)})+'\\n')
action=args[0]
if action=='has-session':sys.exit(0 if scenario in ('existing','dead','live') else 1)
if action=='list-panes':print('1' if scenario=='dead' else '0')
if action=='new-session' and scenario not in ('existing','dead','live'):sys.exit(subprocess.run(args[-1],shell=True).returncode)
''');stub.chmod(0o755)
 binary.write_text('#!/usr/bin/python3\nimport json,os,pathlib,sys\nwith pathlib.Path('+repr(str(log))+').open("a") as f:f.write(json.dumps({"binary":sys.argv[1:],"env":dict(os.environ)})+"\\n")\n');binary.chmod(0o755)
 wrapper=ns['public_launcher'](str(root))
 wrapper=wrapper.replace('/usr/bin/tmux',str(stub)).replace('$(id -un)','ssm-user')
 wrapper=wrapper.replace('[ -L /var/lib/vinos-genesis ]','[ -L '+str(root/'absent')+' ]').replace('$(stat -c \'%a:%U\' /var/lib/vinos-genesis)','700:ssm-user')
 launcher=root/'launcher';launcher.write_text(wrapper);launcher.chmod(0o755)
 syntax=subprocess.run(['bash','-n',str(launcher)],capture_output=True,text=True);assert syntax.returncode==0,syntax.stderr
 def invoke(args,case='new',terminal=True):
  log.write_text('');scenario.write_text(case);env=dict(os.environ,SYNTHETIC_PRIVATE_KEY='MUST_NOT_INHERIT',BASH_ENV='')
  if not terminal:
   result=subprocess.run(['bash',str(launcher),*args],env=env,capture_output=True,text=True)
   return result.returncode,result.stdout+result.stderr,[]
  master,slave=pty.openpty();process=subprocess.Popen(['bash',str(launcher),*args],env=env,stdin=slave,stdout=slave,stderr=slave);os.close(slave)
  output=b'';deadline=time.monotonic()+5
  try:
   while True:
    if time.monotonic()>deadline:process.kill();raise AssertionError('Launcher timeout')
    ready,_,_=select.select([master],[],[],0.05)
    if ready:
     try:chunk=os.read(master,65536)
     except OSError as e:
      if e.errno==errno.EIO:break
      raise
     if not chunk:break
     output+=chunk
    elif process.poll() is not None:break
   code=process.wait(timeout=1)
  finally:os.close(master)
  calls=[json.loads(line) for line in log.read_text().splitlines()]
  assert all('SYNTHETIC_PRIVATE_KEY' not in c['env'] for c in calls)
  return code,output.decode(),calls
 for args,action,qty in (([],'setup','10'),(['1'],'setup','1'),(['setup','100'],'setup','100'),(['start','7'],'start','7'),(['preflight','4'],'preflight','4'),(['recover'],'recover','10')):
  code,out,calls=invoke(args);assert code==0,(args,out)
  transactions=[c['binary'] for c in calls if 'binary' in c];assert len(transactions)==1,(args,calls)
  command=transactions[0];assert command[0]==action and command[command.index('--quantity')+1]==qty
  assert ('--send' in command)==(action in ('setup','start'))
  assert '--state-dir' in command and command[-1]=='/var/lib/vinos-genesis'
  if action in ('setup','start'):assert any(c.get('tmux',[''])[0]=='set-option' and 'remain-on-exit' in c['tmux'] for c in calls)
 for args in (['0'],['101'],['01'],['setup','0'],['setup','101'],['setup','1;echo bad'],['setup','1','EXTRA'],['attach','2'],['reset','2'],['--private-key','SYNTHETIC_SECRET']):
  code,out,calls=invoke(args);assert code==2 and not calls,(args,out,calls);assert 'SYNTHETIC_SECRET' not in out
 code,out,calls=invoke(['setup','20'],'existing');assert code==0 and 'not applied' in out and not any('binary' in c for c in calls)
 assert any(c.get('tmux',[''])[0]=='new-session' and '-A' in c['tmux'] for c in calls)
 code,out,calls=invoke(['reset'],'live');assert code==1 and not any(c.get('tmux',[''])[0]=='kill-session' for c in calls)
 code,out,calls=invoke(['reset'],'dead');assert code==0 and any(c.get('tmux',[''])[0]=='if-shell' and '-F' in c['tmux'] and '#{pane_dead}' in c['tmux'][4] and c['tmux'][5]=='kill-session -t genesis-mint' for c in calls)
 code,out,calls=invoke(['attach'],'existing');assert code==0 and any(c.get('tmux',[''])[0]=='attach-session' for c in calls) and not any('binary' in c for c in calls)
 code,out,calls=invoke([],terminal=False);assert code==1 and 'interactive terminal' in out
print('Generated Bash launcher executed in PTY with synthetic binary/tmux only')
`);
});
