#!/usr/bin/env bash
# CloudShell: build SOURCE.tgz SHA256 | install ARTIFACT.tgz SOURCE_SHA256 | status COMMAND_ID | verify ARTIFACT_SHA256
# Installation never requests a key or executes onchain transactions.
set -euo pipefail
umask 077
exec python3 - "$@" <<'VINOS_INSTALLER'
import datetime, hashlib, io, json, os, pathlib, platform, re, shlex, shutil, stat, subprocess, sys, tarfile, tempfile
from urllib.parse import urlsplit

REGION='us-east-2'
INSTANCE='i-0ef42c1e5475d7edb'
ACCOUNT='543777713568'
BUCKET='vinos-az-543777713568-20260916-ohio-c7i-8d1e6b'
TOOLCHAIN='1.93.0'
CRATES=('rust-genesis-minter','rust-mint-benchmark')
FIXED={*(crate+'/'+name for crate in CRATES for name in ('Cargo.toml','Cargo.lock')),
 'artifacts/GenesisChildFactory.json','contracts/GenesisChildFactory.sol','artifacts/timed-benchmark.json',
 'contracts/TimedBenchmarkNFT.sol','contracts/TimedBenchmarkBatchMinter.sol','docs/RUST_GENESIS_MINT.md','docs/GENESIS_CHECK_SERVER.md'}
CONFIG={'wallet':'0x59Cd658EB1be492c52CcAA2575A90A236F77fAE2','quantity':2,'minQuantity':2,'mode':'signed',
 'waitTimeoutSecs':120,'readRpc':'https://robinhood-rpc.publicnode.com',
 'sendRpcUrls':['https://sequencer.mainnet.chain.robinhood.com'],
 'maxGasCostEth':'0.005','maxTotalGasCostEth':'0.019','reserveEth':'0.001'}
ARTIFACT_FILES={'bin/vinos-genesis','build-manifest.json','genesis-check.config.json'}
def need(ok,message):
 if not ok: raise ValueError(message)
def digest(data): return hashlib.sha256(data).hexdigest()
def regular(path,maximum):
 info=path.lstat(); need(stat.S_ISREG(info.st_mode) and info.st_size<=maximum,'Invalid regular file')
 return path.read_bytes()
def save(path,value):
 with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:
  json.dump(value,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
def source_name(name):
 p=pathlib.PurePosixPath(name)
 return name in FIXED or (len(p.parts)==3 and p.parts[0] in CRATES and p.parts[1]=='src' and re.fullmatch('[a-z_]+[.]rs',p.name))
def archive_members(data,source=False):
 need(len(data)<=(8 if source else 24)*1024*1024,'Archive too large')
 archive=tarfile.open(fileobj=io.BytesIO(data),mode='r:gz');members=archive.getmembers()
 need(0<len(members)<100 and sum(m.size for m in members)<=(8 if source else 24)*1024*1024,'Expanded archive too large')
 seen=set()
 for m in members:
  p=pathlib.PurePosixPath(m.name)
  need(m.isfile() and not p.is_absolute() and '..' not in p.parts and m.name==str(p) and m.name not in seen,'Unsafe archive member')
  need((source_name(m.name) or m.name=='source-manifest.json') if source else m.name in ARTIFACT_FILES,'File outside allowlist')
  need(0<=m.size<=(2 if source else 20)*1024*1024,'Oversized archive member');seen.add(m.name)
 if source:
  need(FIXED|{'source-manifest.json',*(c+'/src/main.rs' for c in CRATES),*(c+'/src/lib.rs' for c in CRATES)}<=seen,'Missing build inputs')
  manifest=json.load(archive.extractfile('source-manifest.json'))
  need(manifest.get('kind')=='vinos-genesis-source-v1' and set(manifest['files'])==seen-{'source-manifest.json'},'Invalid source manifest')
  need(all(digest(archive.extractfile(n).read())==h for n,h in manifest['files'].items()),'Source file checksum mismatch')
 else: need(seen==ARTIFACT_FILES,'Unexpected artifact contents')
 return archive,members
def inspect_artifact(data,approved):
 archive,_=archive_members(data)
 build=json.load(archive.extractfile('build-manifest.json'));binary=archive.extractfile('bin/vinos-genesis').read()
 need(build.get('kind')=='vinos-genesis-build-v1' and build.get('sourceSha256')==approved,'Unreviewed source artifact')
 need(build.get('target')=='x86_64-unknown-linux-gnu' and build.get('rustc','').startswith('rustc '+TOOLCHAIN+' '),'Wrong build target/toolchain')
 need(binary[:6]==b'\x7fELF\x02\x01' and binary[18:20]==b'\x3e\x00','Binary must be Linux x86_64 ELF')
 need(build.get('binary')=={'path':'bin/vinos-genesis','sha256':digest(binary),'bytes':len(binary)},'Binary checksum mismatch')
 need(json.load(archive.extractfile('genesis-check.config.json'))==CONFIG,'Server configuration changed')
 return build
def build(source_path,approved):
 need(platform.system()=='Linux' and platform.machine()=='x86_64','Build in Linux x86_64 CloudShell, not on the Mac')
 data=regular(pathlib.Path(source_path).absolute(),8*1024*1024);need(digest(data)==approved,'Source archive SHA256 mismatch')
 archive,members=archive_members(data,source=True)
 root=pathlib.Path.home()/('vinos-genesis-source-'+approved[:16]);root.mkdir(mode=0o700,exist_ok=False)
 for member in members:
  target=root/member.name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  with archive.extractfile(member) as reader,target.open('xb') as writer: shutil.copyfileobj(reader,writer)
  target.chmod(0o600)
 env=dict(os.environ,CARGO_HOME='/tmp/vinos-cargo',RUSTUP_HOME='/tmp/vinos-rustup',
          CARGO_TARGET_DIR='/tmp/vinos-real-tx-target',RUSTUP_TOOLCHAIN=TOOLCHAIN,CARGO_INCREMENTAL='0')
 cargo=pathlib.Path('/tmp/vinos-cargo/bin/cargo');need(cargo.is_file(),'Existing CloudShell Rust cache is missing; restore reviewed Rust 1.93 toolchain first')
 rustc=subprocess.check_output(['/tmp/vinos-cargo/bin/rustc','--version'],env=env,text=True,timeout=15).strip()
 need(rustc.startswith('rustc '+TOOLCHAIN+' '),'Pinned Rust 1.93.0 is required')
 log=root/'build.log';status=root/'build-exit.json'
 print('BUILD_STARTED '+json.dumps({'directory':str(root),'log':str(log),'status':str(status)}),flush=True)
 try:
  with log.open('x') as stream:
   subprocess.run([str(cargo),'build','--release','--locked','--jobs','1','--manifest-path',str(root/'rust-genesis-minter/Cargo.toml')],
                  env=env,check=True,timeout=1800,stdin=subprocess.DEVNULL,stdout=stream,stderr=subprocess.STDOUT)
  binary=pathlib.Path(env['CARGO_TARGET_DIR'])/'release/vinos-genesis';raw=regular(binary,20*1024*1024)
  subprocess.run([str(binary),'--help'],check=True,timeout=10,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  manifest={'kind':'vinos-genesis-build-v1','sourceSha256':approved,'target':'x86_64-unknown-linux-gnu','rustc':rustc,
            'binary':{'path':'bin/vinos-genesis','sha256':digest(raw),'bytes':len(raw)},'build':{'locked':True,'profile':'release','jobs':1}}
  output=pathlib.Path.home()/('vinos-genesis-linux-'+approved[:16]+'.tgz')
  with output.open('xb') as target,tarfile.open(fileobj=target,mode='w:gz') as packed:
   for name,body in {'bin/vinos-genesis':raw,'build-manifest.json':json.dumps(manifest).encode(),
                    'genesis-check.config.json':json.dumps(CONFIG).encode()}.items():
    info=tarfile.TarInfo(name);info.size=len(body);info.mode=0o755 if name.startswith('bin/') else 0o644
    packed.addfile(info,io.BytesIO(body))
  output.chmod(0o600);built=regular(output,24*1024*1024);inspect_artifact(built,approved)
  report={'success':True,'artifact':str(output),'artifactSha256':digest(built),'sourceSha256':approved,'binarySha256':manifest['binary']['sha256']}
  save(status,report);print('BUILD_COMPLETE '+json.dumps(report),flush=True)
 except Exception as error:
  if not status.exists(): save(status,{'success':False,'sourceSha256':approved,'errorType':type(error).__name__,'log':str(log)})
  raise
def aws(*args):
 result=subprocess.run(['aws','--region',REGION,'--no-cli-pager','--output','json','--cli-connect-timeout','10','--cli-read-timeout','20',*args],
  env=dict(os.environ,AWS_PAGER='',AWS_MAX_ATTEMPTS='1'),capture_output=True,text=True,timeout=40)
 need(result.returncode==0,'AWS operation failed; inspect console/intent without repeating a mutation')
 return json.loads(result.stdout or '{}')
def launcher(destination):
 return '''#!/usr/bin/env bash
set -euo pipefail
umask 077
ulimit -c 0
if [ "$#" -ne 0 ]; then echo 'Usage: vinos-genesis-check (no arguments)' >&2; exit 2; fi
if [ "$(id -un)" != ssm-user ]; then echo 'Run as ssm-user in an interactive SSM session' >&2; exit 1; fi
if [ ! -t 0 ] || [ ! -t 1 ]; then echo 'An interactive terminal is required for hidden key entry' >&2; exit 1; fi
exec env -i PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 '''+shlex.quote(destination+'/bin/vinos-genesis')+''' check-children --send --config '''+shlex.quote(destination+'/genesis-check.config.json')+''' --state-dir /var/lib/vinos-genesis
'''
def remote_program(url,sha,approved,binary_sha,wrapper):
 return f'''import hashlib,io,json,os,pathlib,pwd,shutil,stat,subprocess,tarfile,tempfile
def need(ok,message):
 if not ok: raise RuntimeError(message)
def directory(path,mode,uid=0,gid=0):
 if path.exists() or path.is_symlink():
  i=path.lstat();need(stat.S_ISDIR(i.st_mode) and i.st_uid==uid and i.st_gid==gid and not(i.st_mode&0o022),'Unsafe existing directory')
  if uid==0: need(stat.S_IMODE(i.st_mode)&0o005==0o005,'Root program directory is not traversable by ssm-user')
 else: path.mkdir(mode=mode);os.chown(path,uid,gid)
need(os.geteuid()==0,'Installer requires SSM root')
os.umask(0o022) # SSM may inherit 077: program directories must remain traversable.
user=pwd.getpwnam('ssm-user')
for p in ('/opt','/usr','/usr/local','/usr/local/bin','/var','/var/lib'): directory(pathlib.Path(p),0o755)
base=pathlib.Path('/opt/vinos-genesis');directory(base,0o755)
state=pathlib.Path('/var/lib/vinos-genesis');directory(state,0o700,user.pw_uid,user.pw_gid)
need(stat.S_IMODE(state.stat().st_mode)==0o700,'State directory must remain private')
dest=base/{sha!r};cmd=pathlib.Path('/usr/local/bin/vinos-genesis-check')
wrapper={wrapper!r}.encode()
if cmd.exists() or cmd.is_symlink():
 i=cmd.lstat();need(stat.S_ISREG(i.st_mode) and i.st_uid==0 and not(i.st_mode&0o022),'Unsafe existing launcher')
 need(cmd.read_bytes()==wrapper,'Different existing Genesis launcher; review upgrade explicitly')
if dest.exists() or dest.is_symlink():
 directory(dest,0o755)
 need((dest/'installation.json').is_file(),'Incomplete destination; inspect before retry')
 need(json.loads((dest/'installation.json').read_text())['artifactSha256']=={sha!r},'Installation marker mismatch')
else:
 with tempfile.TemporaryDirectory(prefix='.install-',dir=base) as tmp:
  tmp=pathlib.Path(tmp);archive=tmp/'artifact.tgz'
  result=subprocess.run(['curl','--fail','--silent','--show-error','--retry','0','--proto','=https','--max-time','120','--output',str(archive),{url!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  need(result.returncode==0,'Artifact download failed')
  need(archive.stat().st_size<=24*1024*1024,'Artifact too large')
  data=archive.read_bytes();need(hashlib.sha256(data).hexdigest()=={sha!r},'Artifact checksum mismatch')
  stage=tmp/'files';stage.mkdir(mode=0o755)
  with tarfile.open(fileobj=io.BytesIO(data),mode='r:gz') as tar:
   members=tar.getmembers();need(len(members)==3 and {{m.name for m in members}}=={ARTIFACT_FILES!r},'Unexpected artifact members')
   need(sum(m.size for m in members)<=24*1024*1024,'Expanded artifact too large')
   for m in members:
    need(m.isfile() and 0<=m.size<=20*1024*1024,'Unsafe artifact entry')
    target=stage/m.name;target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
    with tar.extractfile(m) as reader,target.open('xb') as writer: shutil.copyfileobj(reader,writer)
    target.chmod(0o755 if m.name=='bin/vinos-genesis' else 0o644)
  build=json.loads((stage/'build-manifest.json').read_text())
  need(build['sourceSha256']=={approved!r},'Source identity mismatch')
  need(json.loads((stage/'genesis-check.config.json').read_text())=={CONFIG!r},'Fixed config mismatch')
  binary=stage/'bin/vinos-genesis';need(hashlib.sha256(binary.read_bytes()).hexdigest()=={binary_sha!r},'Binary identity mismatch')
  subprocess.run([str(binary),'--help'],check=True,timeout=10,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env={{'PATH':'/usr/bin:/bin','LANG':'C'}})
  (stage/'installation.json').write_text(json.dumps({{'artifactSha256':{sha!r},'sourceSha256':{approved!r},'binarySha256':{binary_sha!r}}}))
  os.replace(stage,dest)
need(hashlib.sha256((dest/'bin/vinos-genesis').read_bytes()).hexdigest()=={binary_sha!r},'Installed binary changed')
need(json.loads((dest/'genesis-check.config.json').read_text())=={CONFIG!r},'Installed config changed')
if not cmd.exists():
 fd,name=tempfile.mkstemp(prefix='.vinos-genesis-check-',dir=cmd.parent)
 try:
  with os.fdopen(fd,'wb') as out: out.write(wrapper);out.flush();os.fsync(out.fileno());os.fchmod(out.fileno(),0o755)
  os.link(name,cmd) # Atomic publication; never clobber an independently created launcher.
 finally: os.unlink(name)
print(json.dumps({{'installed':True,'directory':str(dest),'launcher':str(cmd),'artifactSha256':{sha!r},'sourceSha256':{approved!r},'binarySha256':{binary_sha!r},'launcherSha256':hashlib.sha256(wrapper).hexdigest(),'stateDirectory':str(state),'privateKeyRead':False,'transactionsSent':0}}))
'''
def install(artifact,approved):
 data=regular(pathlib.Path(artifact).absolute(),24*1024*1024);manifest=inspect_artifact(data,approved);sha=digest(data)
 need(aws('sts','get-caller-identity')['Account']==ACCOUNT,'Unexpected AWS account')
 response=aws('ec2','describe-instances','--instance-ids',INSTANCE)
 instances=[x for r in response['Reservations'] for x in r['Instances']]
 need(len(instances)==1 and instances[0]['InstanceId']==INSTANCE and instances[0]['State']['Name']=='running' and instances[0]['Architecture']=='x86_64','Retained instance not ready')
 public=aws('s3api','get-public-access-block','--bucket',BUCKET,'--expected-bucket-owner',ACCOUNT)['PublicAccessBlockConfiguration']
 need(all(public.get(k) is True for k in ('BlockPublicAcls','IgnorePublicAcls','BlockPublicPolicy','RestrictPublicBuckets')),'Artifact bucket must remain private')
 intent=pathlib.Path.home()/('vinos-genesis-install-'+sha[:16]+'.json');need(not intent.exists(),'Installation intent exists; inspect its command before repeating')
 key='genesis-check/'+sha+'.tgz';destination='/opt/vinos-genesis/'+sha
 save(intent,{'kind':'vinos-genesis-install-intent-v1','instanceId':INSTANCE,'region':REGION,'bucket':BUCKET,'key':key,'artifactSha256':sha,'sourceSha256':approved,'directory':destination,'transactionsSent':0})
 aws('s3api','put-object','--bucket',BUCKET,'--key',key,'--body',str(pathlib.Path(artifact).absolute()),'--expected-bucket-owner',ACCOUNT,'--server-side-encryption','AES256','--metadata','sha256='+sha)
 signed=subprocess.run(['aws','s3','presign','s3://'+BUCKET+'/'+key,'--expires-in','600','--region',REGION],capture_output=True,text=True,timeout=30,env=dict(os.environ,AWS_MAX_ATTEMPTS='1'))
 need(signed.returncode==0,'Presign failed; URL not printed');url=signed.stdout.strip();parsed=urlsplit(url)
 need(parsed.scheme=='https' and parsed.hostname in (BUCKET+'.s3.'+REGION+'.amazonaws.com',BUCKET+'.s3.amazonaws.com') and parsed.path=='/'+key and not parsed.username and not parsed.password and not parsed.fragment,'Unexpected presigned object URL')
 program=remote_program(url,sha,approved,manifest['binary']['sha256'],launcher(destination))
 save(pathlib.Path(str(intent)+'.submission.json'),{'submissionIntent':True,'comment':'vinos-genesis-install-'+sha[:16]})
 result=aws('ssm','send-command','--instance-ids',INSTANCE,'--document-name','AWS-RunShellScript','--comment','vinos-genesis-install-'+sha[:16],
            '--timeout-seconds','120','--parameters',json.dumps({'commands':['python3 -c '+shlex.quote(program)],'executionTimeout':['180']}))
 command=result['Command']['CommandId'];save(pathlib.Path(str(intent)+'.command.json'),{'commandId':command,'instanceId':INSTANCE})
 print(json.dumps({'intent':str(intent),'commandId':command,'directory':destination,'launcher':'vinos-genesis-check','transactionsSent':0}))
def status(command):
 need(re.fullmatch('[0-9a-f-]{36}',command),'Invalid command ID')
 v=aws('ssm','get-command-invocation','--command-id',command,'--instance-id',INSTANCE)
 redact=lambda text:re.sub(r'https?://\S+','[URL_REDACTED]',text)
 print(json.dumps({'commandId':command,'status':v['Status'],'responseCode':v.get('ResponseCode'),'output':redact(v.get('StandardOutputContent','')[-4000:]),'error':redact(v.get('StandardErrorContent','')[-1000:])}))
def verify(sha):
 need(re.fullmatch('[0-9a-f]{64}',sha),'Invalid artifact checksum')
 destination='/opt/vinos-genesis/'+sha
 program=f'''import hashlib,json,pathlib,subprocess,time,urllib.request
root=pathlib.Path({destination!r})
manifest=json.loads((root/'installation.json').read_text())
assert manifest['artifactSha256']=={sha!r}
binary=root/'bin/vinos-genesis'
assert hashlib.sha256(binary.read_bytes()).hexdigest()==manifest['binarySha256']
assert json.loads((root/'genesis-check.config.json').read_text())=={CONFIG!r}
assert hashlib.sha256(pathlib.Path('/usr/local/bin/vinos-genesis-check').read_bytes()).hexdigest()=={digest(launcher(destination).encode())!r}
env={{'PATH':'/usr/local/bin:/usr/bin:/bin','LANG':'C.UTF-8'}}
clock=subprocess.check_output(['chronyc','tracking'],env=env,text=True,timeout=10)
result=subprocess.run(['/usr/sbin/runuser','-u','ssm-user','--','env','-i','PATH=/usr/local/bin:/usr/bin:/bin','LANG=C.UTF-8',str(binary),
 'preflight','--config',str(root/'genesis-check.config.json'),'--state-dir','/var/lib/vinos-genesis'],
 env=env,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=120)
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl): return None
health={{'ok':False}};started=time.perf_counter()
try:
 request=urllib.request.Request('https://sequencer.mainnet.chain.robinhood.com',
  data=json.dumps({{'jsonrpc':'2.0','id':1,'method':'arb_checkPublisherHealth','params':[]}}).encode(),
  headers={{'Content-Type':'application/json','Accept':'application/json'}},method='POST')
 with urllib.request.build_opener(NoRedirect()).open(request,timeout=10) as response:
  body=response.read(4097);status=response.status
 value=json.loads(body) if len(body)<=4096 else None
 assert status==200 and isinstance(value,dict) and value.get('jsonrpc')=='2.0' and value.get('id')==1 and 'result' in value and value['result'] is None and 'error' not in value
 health={{'ok':True,'method':'arb_checkPublisherHealth','httpStatus':status}}
except Exception as error: health={{'ok':False,'errorType':type(error).__name__}}
health['roundTripMs']=(time.perf_counter()-started)*1000
print(json.dumps({{'preflightPassed':result.returncode==0 and health['ok'],'exitCode':result.returncode,'sourceSha256':manifest['sourceSha256'],
 'binarySha256':manifest['binarySha256'],'clock':clock,'output':result.stdout[-6000:],'error':result.stderr[-1000:],
 'sequencerHealth':health,'privateKeyRead':False,'transactionsSent':0}}))
raise SystemExit(result.returncode or (0 if health['ok'] else 1))
'''
 need(aws('sts','get-caller-identity')['Account']==ACCOUNT,'Unexpected AWS account')
 stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
 intent=pathlib.Path.home()/('vinos-genesis-verify-'+sha[:16]+'-'+stamp+'.json')
 comment='vinos-genesis-verify-'+sha[:16]
 save(intent,{'instanceId':INSTANCE,'region':REGION,'artifactSha256':sha,'comment':comment,'submissionIntent':True,'transactionsSent':0})
 result=aws('ssm','send-command','--instance-ids',INSTANCE,'--document-name','AWS-RunShellScript','--comment',comment,
            '--timeout-seconds','120','--parameters',json.dumps({'commands':['python3 -c '+shlex.quote(program)],'executionTimeout':['150']}))
 command=result['Command']['CommandId'];save(pathlib.Path(str(intent)+'.command.json'),{'commandId':command,'instanceId':INSTANCE})
 print(json.dumps({'intent':str(intent),'commandId':command,'verificationOnly':True,'transactionsSent':0}))
def main(args):
 if args in ([],['--help']):
  print('bash install-genesis-check.sh build SOURCE.tgz SHA256\nbash install-genesis-check.sh install ARTIFACT.tgz SOURCE_SHA256\nbash install-genesis-check.sh status COMMAND_ID\nbash install-genesis-check.sh verify ARTIFACT_SHA256\nInstall and verify never prompt for a key or start paid preparation.');return
 need(args[0] in ('build','install','status','verify') and len(args)==(2 if args[0] in ('status','verify') else 3),'Invalid command arguments')
 if args[0] in ('build','install'): need(re.fullmatch('[0-9a-f]{64}',args[2]),'Expected SHA256')
 {'build':build,'install':install,'status':status,'verify':verify}[args[0]](*args[1:])
try: main(sys.argv[1:])
except Exception as error: raise SystemExit('GENESIS_HELPER_FAILED_'+type(error).__name__+'; inspect build log or installation intent; do not retry uncertain SSM submissions')
VINOS_INSTALLER
