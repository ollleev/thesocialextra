import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readFile,stat,chmod,readdir,mkdir,symlink,realpath } from 'node:fs/promises';
import childProcess,{spawn} from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../database.mjs';
import {createBackup} from '../backup.mjs';
import {backupKey,encryptBackup,decryptBackup} from '../ops/backup-crypto.mjs';
import {runBackup,waitForLiveWal} from '../ops/backup-job.mjs';
import {pullBackup,readPullConfig,createSSHTransport} from '../ops/backup-pull.mjs';

async function fixture(t){const dir=await mkdtemp(path.join(tmpdir(),'thesocialextra-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));return {dir,file:name=>path.join(dir,name)};}
test('online SQLite backup encrypts and restores to an authenticated, intact separate database',async t=>{
  const f=await fixture(t),db=openDatabase(f.file('source.sqlite'));t.after(()=>db.close());
  db.exec('CREATE TABLE synthetic(id INTEGER PRIMARY KEY,value TEXT) STRICT');db.prepare('INSERT INTO synthetic(value) VALUES(?)').run('synthetic backup evidence');
  await createBackup(f.file('source.sqlite'),f.file('snapshot.sqlite'));
  const key=await backupKey(f.file('key'),{create:true});
  await encryptBackup(f.file('snapshot.sqlite'),f.file('snapshot.tseb'),key);
  assert.ok(!(await readFile(f.file('snapshot.tseb'))).includes(Buffer.from('synthetic backup evidence')));
  await decryptBackup(f.file('snapshot.tseb'),f.file('restored.sqlite'),key);
  const restored=openDatabase(f.file('restored.sqlite'));
  try{assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(restored.prepare('SELECT value FROM synthetic').get().value,'synthetic backup evidence');}finally{restored.close();}
  assert.equal((await stat(f.file('snapshot.tseb'))).mode&0o777,0o600);
  assert.equal((await stat(f.file('restored.sqlite'))).mode&0o777,0o600);
  await assert.rejects(()=>createBackup(f.file('source.sqlite'),f.file('snapshot.sqlite')));
});
test('wrong key or tampering never creates a plaintext destination or leaves a partial file',async t=>{
  const f=await fixture(t),key=await backupKey(f.file('key'),{create:true});await writeFile(f.file('input'),'Private synthetic sample');await encryptBackup(f.file('input'),f.file('cipher'),key);
  const original=await readFile(f.file('cipher'));
  for(const offset of [8,20,original.length-1]){
    const corrupt=Buffer.from(original);corrupt[offset]^=1;await writeFile(f.file('tampered'),corrupt);
    await assert.rejects(()=>decryptBackup(f.file('tampered'),f.file('result'),key));
    await assert.rejects(()=>stat(f.file('result')),{code:'ENOENT'});
  }
  await assert.rejects(()=>decryptBackup(f.file('cipher'),f.file('result'),Buffer.alloc(32)));
  assert.ok(!(await readdir(f.dir)).some(name=>name.endsWith('.partial')));
});
test('backup keys are private and output never overwrites an existing recovery point',async t=>{
  const f=await fixture(t),key=await backupKey(f.file('key'),{create:true});assert.deepEqual(await backupKey(f.file('key'),{create:true}),key);
  await chmod(f.file('key'),0o644);await assert.rejects(()=>backupKey(f.file('key')));
  await writeFile(f.file('input'),'one');await writeFile(f.file('output'),'existing');
  await assert.rejects(()=>encryptBackup(f.file('input'),f.file('output'),key),{code:'EEXIST'});
  assert.equal(await readFile(f.file('output'),'utf8'),'existing');
});
test('empty encrypted files authenticate and restore without a stream range error',async t=>{
  const f=await fixture(t),key=Buffer.alloc(32,17);await writeFile(f.file('empty'),'');await encryptBackup(f.file('empty'),f.file('cipher'),key);await decryptBackup(f.file('cipher'),f.file('restored'),key);assert.equal((await stat(f.file('restored'))).size,0);
});

async function jobFixture(t) {
  const f=await fixture(t),database=f.file('source.sqlite'),directory=f.file('snapshots'),keyFile=f.file('key');
  const db=openDatabase(database);t.after(()=>db.close());
  db.exec("CREATE TABLE synthetic(value TEXT) STRICT; INSERT INTO synthetic VALUES('synthetic live WAL evidence')");
  await backupKey(keyFile,{create:true});await mkdir(directory,{mode:0o700});
  const options={database,directory,keyFile,now:Date.UTC(2026,7,28,1),minFreeBytes:0};
  return {...f,db,options,directory};
}
test('backup job publishes only a restored verified ciphertext and removes its plaintext work files',async t=>{
  const f=await jobFixture(t),result=await runBackup(f.options);
  assert.equal(result.restoredIntegrity,'ok');assert.equal(result.removed,0);
  assert.deepEqual(await readdir(f.directory),[result.filename]);
  const file=path.join(f.directory,result.filename);assert.equal((await stat(file)).mode&0o777,0o600);
  await decryptBackup(file,f.file('independent.sqlite'),await backupKey(f.options.keyFile));
  const db=openDatabase(f.file('independent.sqlite'));
  try{assert.equal(db.prepare('SELECT value FROM synthetic').get().value,'synthetic live WAL evidence');}finally{db.close();}
});
test('backup rotation keeps the exact retention boundary, future points, unrelated files and symlinks',async t=>{
  const f=await jobFixture(t),suffix='00000000-0000-4000-8000-000000000000.tseb';
  const old=`snapshot-2026-08-21T00-59-59Z-${suffix}`,boundary=`snapshot-2026-08-21T01-00-00Z-${suffix}`,future=`snapshot-2026-09-01T01-00-00Z-${suffix}`,linked=`snapshot-2026-08-01T01-00-00Z-${suffix}`;
  for(const name of [old,boundary,future,'operator-notes'])await writeFile(path.join(f.directory,name),'synthetic retained file');
  await symlink(f.options.database,path.join(f.directory,linked));
  const result=await runBackup(f.options);assert.equal(result.removed,1);
  assert.deepEqual((await readdir(f.directory)).sort(),[boundary,future,linked,'operator-notes',result.filename].sort());
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM synthetic').get().n,1);
});
test('budget or disk refusal preserves old points and never publishes a partial backup',async t=>{
  const f=await jobFixture(t),old='snapshot-2026-08-01T01-00-00Z-00000000-0000-4000-8000-000000000000.tseb';
  await writeFile(path.join(f.directory,old),'synthetic old point');
  await assert.rejects(runBackup({...f.options,maxStoredBytes:1}),/retention budget/);
  assert.deepEqual(await readdir(f.directory),[old]);
  await assert.rejects(runBackup({...f.options,minFreeBytes:Number.MAX_SAFE_INTEGER}),/free space/);
  assert.deepEqual(await readdir(f.directory),[old]);
});
test('operational backup refuses missing keys, shared directories and an occupied lock',async t=>{
  const f=await jobFixture(t);
  await assert.rejects(runBackup({...f.options,keyFile:f.file('missing-key')}),{code:'ENOENT'});
  await chmod(f.directory,0o755);await assert.rejects(runBackup(f.options),/private/);await chmod(f.directory,0o700);
  await mkdir(path.join(f.directory,'.backup.lock'),{mode:0o700});
  await assert.rejects(runBackup(f.options),{code:'EEXIST'});assert.deepEqual(await readdir(f.directory),['.backup.lock']);
});
test('capacity uses the committed WAL and pins a snapshot before concurrent growth',async t=>{
  const f=await jobFixture(t);f.db.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE payload(bytes BLOB) STRICT; INSERT INTO payload VALUES(zeroblob(8388608))');
  const mainBytes=(await stat(f.options.database)).size,destination=f.file('pinned.sqlite');let estimate;
  await createBackup(f.options.database,destination,{beforeCopy:async({bytes})=>{
    estimate=bytes;assert.ok(bytes>8*1024**2);assert.ok(mainBytes<bytes);
    await assert.rejects(stat(destination),{code:'ENOENT'});
    f.db.exec('INSERT INTO payload VALUES(zeroblob(1048576))');
  }});
  assert.ok((await stat(destination)).size<=estimate);
  const restored=openDatabase(destination);
  try{assert.equal(restored.prepare('SELECT count(*) AS n FROM payload').get().n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM payload').get().n,2);}finally{restored.close();}
  const refused=f.file('refused.sqlite');
  await assert.rejects(createBackup(f.options.database,refused,{beforeCopy:()=>{throw new Error('capacity refused before allocation');}}),/capacity refused/);
  await assert.rejects(stat(refused),{code:'ENOENT'});
});
test('read-only service readiness waits for the live writer and fails closed after a clean stop',async t=>{
  const f=await fixture(t),source=f.file('source.sqlite');let db=openDatabase(source);
  db.exec('CREATE TABLE synthetic(value TEXT) STRICT');db.close();
  await assert.rejects(waitForLiveWal(source,{timeoutMs:60}),/not ready/);
  const ready=waitForLiveWal(source,{timeoutMs:1000});
  db=openDatabase(source);t.after(()=>db.close());db.exec("INSERT INTO synthetic VALUES('synthetic live writer')");
  await ready;
});

async function pullFixture(t) {
  const f=await jobFixture(t),snapshot=await runBackup(f.options),identityFile=f.file('identity');
  await writeFile(identityFile,'synthetic identity fixture',{mode:0o600});
  const config={host:'backup-source.invalid',identityFile,remoteDirectory:await realpath(f.directory),localDirectory:f.file('off-server'),keyFile:f.options.keyFile};
  const ciphertext=await readFile(path.join(f.directory,snapshot.filename));let reads=0;
  const entry={name:snapshot.filename,bytes:ciphertext.length};
  const transport={list:async()=>[entry],async *read(){reads++;for(let offset=0;offset<ciphertext.length;offset+=997)yield ciphertext.subarray(offset,offset+997);}};
  return {...f,config,ciphertext,entry,transport,reads:()=>reads,pull:options=>pullBackup(config,{now:f.options.now,minFreeBytes:0,transport,...options})};
}
const oldPoint='snapshot-2026-08-01T01-00-00Z-00000000-0000-4000-8000-000000000000.tseb';
async function oldLocal(f){await mkdir(f.config.localDirectory,{mode:0o700});await writeFile(path.join(f.config.localDirectory,oldPoint),'synthetic old point',{mode:0o600});}

test('off-server pull publishes an authenticated private archive and retries without a download or rotation',async t=>{
  const f=await pullFixture(t),result=await f.pull({transport:{list:f.transport.list,async *read(...args){
    const work=(await readdir(f.config.localDirectory)).find(name=>name.startsWith('.pull-working-'));assert.ok(work);
    assert.equal((await stat(path.join(f.config.localDirectory,work))).mode&0o777,0o700);
    assert.equal((await stat(path.join(f.config.localDirectory,work,'received.tseb'))).mode&0o777,0o600);
    yield* f.transport.read(...args);
  }}});
  assert.equal(result.restoredIntegrity,'ok');assert.equal(result.alreadyPresent,false);assert.equal(f.reads(),1);
  assert.deepEqual(await readdir(f.config.localDirectory),[f.entry.name]);
  assert.deepEqual(await readFile(path.join(f.config.localDirectory,f.entry.name)),f.ciphertext);
  assert.equal((await stat(f.config.localDirectory)).mode&0o777,0o700);
  assert.equal((await stat(path.join(f.config.localDirectory,f.entry.name))).mode&0o777,0o600);
  await writeFile(path.join(f.config.localDirectory,oldPoint),'synthetic old point',{mode:0o600});
  const retry=await f.pull();assert.equal(retry.alreadyPresent,true);assert.equal(retry.removed,0);assert.equal(f.reads(),1);
  assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[oldPoint,f.entry.name].sort());
  // A damaged existing point is not silently trusted or replaced on retry.
  const damaged=Buffer.from(f.ciphertext);damaged[damaged.length-1]^=1;await writeFile(path.join(f.config.localDirectory,f.entry.name),damaged);
  await assert.rejects(f.pull(),{code:'verification_failed'});assert.equal(f.reads(),1);
  assert.deepEqual(await readFile(path.join(f.directory,f.entry.name)),f.ciphertext);
});

test('pull authentication or SQLite failure preserves all previous points and cleans every plaintext staging file',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  const key=await backupKey(f.options.keyFile),corrupt=Buffer.from(f.ciphertext);corrupt[corrupt.length-1]^=1;
  const invalid=[];
  for(const data of ['synthetic non-SQLite content','']){
    const source=f.file('invalid-source-'+invalid.length),output=source+'.tseb';await writeFile(source,data);await encryptBackup(source,output,key);invalid.push(await readFile(output));
  }
  for(const content of [corrupt,...invalid]){
    const transport={list:async()=>[{...f.entry,bytes:content.length}],async *read(){yield content;}};
    await assert.rejects(f.pull({transport}),{code:'verification_failed'});
    assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
  }
  const otherKey=f.file('other-key');await backupKey(otherKey,{create:true});
  await assert.rejects(pullBackup({...f.config,keyFile:otherKey},{transport:f.transport,now:f.options.now,minFreeBytes:0}),{code:'verification_failed'});
  assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
});

test('pull deadlines and cancellation interrupt stalled listing or streaming without publishing or removing old points',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  for(const transport of [
    {list:()=>new Promise(()=>{}),read:f.transport.read},
    {list:f.transport.list,read:()=>({[Symbol.asyncIterator](){return this;},next:()=>new Promise(()=>{}),return:async()=>({done:true})})},
  ]){
    await assert.rejects(f.pull({transport,timeoutMs:100}),{code:'pull_timeout'});
    assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
  }
  const controller=new AbortController();controller.abort();await assert.rejects(f.pull({signal:controller.signal}),{code:'pull_interrupted'});
  assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
});

test('the verification deadline kills a stopped native process and removes private staging',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  const original=childProcess.fork;let verifier,stopped=false;
  childProcess.fork=(...args)=>{
    verifier=original(...args);
    verifier.once('spawn',()=>{process.kill(verifier.pid,'SIGSTOP');stopped=true;});
    return verifier;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.pull({timeoutMs:1500}),{code:'pull_timeout'});
    assert.equal(stopped,true);assert.equal(verifier.signalCode,'SIGKILL');
    assert.throws(()=>process.kill(verifier.pid,0),{code:'ESRCH'});
    assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
  } finally {
    childProcess.fork=original;syncBuiltinESMExports();
    if(verifier&&verifier.exitCode===null&&verifier.signalCode===null)verifier.kill('SIGKILL');
  }
});

test('pull rejects unsafe manifests and short or overlong streams before any archive publication',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  for(const entries of [[{...f.entry,name:'../escape.tseb'}],[{...f.entry,bytes:2*1024**3+37}],[f.entry,f.entry],[{...f.entry,bytes:35}]]){
    await assert.rejects(f.pull({transport:{list:async()=>entries,read(){assert.fail('unsafe list must not start a read');}}}),{code:'invalid_source_list'});
  }
  for(const content of [f.ciphertext.subarray(0,-1),Buffer.concat([f.ciphertext,Buffer.from('extra')])]){
    await assert.rejects(f.pull({transport:{list:f.transport.list,async *read(){yield content;}}}),{code:'source_size_changed'});
    assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
  }
  await assert.rejects(f.pull({transport:{list:async()=>[{name:oldPoint,bytes:100}]}}),{code:'no_recent_snapshot'});
});

test('pull rotation only removes expired canonical regular points after a newly verified publication',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  const suffix='00000000-0000-4000-8000-000000000000.tseb',boundary=`snapshot-2026-08-21T01-00-00Z-${suffix}`,future=`snapshot-2026-09-01T01-00-00Z-${suffix}`,linked=`snapshot-2026-08-02T01-00-00Z-${suffix}`;
  for(const name of [boundary,future,'foreign-archive.tseb'])await writeFile(path.join(f.config.localDirectory,name),'synthetic retained archive',{mode:0o600});
  await symlink(f.options.database,path.join(f.config.localDirectory,linked));
  const result=await f.pull();assert.equal(result.removed,1);
  assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[boundary,future,linked,'foreign-archive.tseb',f.entry.name].sort());
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM synthetic').get().n,1);
});

test('pull budget and free-space checks run before reception and never evict a young or old point to fit',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  await assert.rejects(f.pull({maxStoredBytes:f.entry.bytes-1}),{code:'retention_budget'});
  await assert.rejects(f.pull({freeSpace:async()=>({bavail:0,bsize:4096})}),{code:'insufficient_space'});
  assert.equal(f.reads(),0);assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
  await writeFile(path.join(f.config.localDirectory,f.entry.name),f.ciphertext,{mode:0o600});
  await assert.rejects(f.pull({maxStoredBytes:f.entry.bytes-1}),{code:'retention_budget'});
  assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[oldPoint,f.entry.name].sort());
});

test('pull requires existing private keys, private config and directory, and rejects symlink destinations',async t=>{
  const f=await pullFixture(t),configFile=f.file('pull.json');await writeFile(configFile,JSON.stringify(f.config),{mode:0o600});
  assert.deepEqual(await readPullConfig(configFile),f.config);
  await chmod(configFile,0o644);await assert.rejects(readPullConfig(configFile),{code:'invalid_pull_config'});await chmod(configFile,0o600);
  await symlink(configFile,f.file('config-link'));await assert.rejects(readPullConfig(f.file('config-link')),{code:'invalid_pull_config'});
  await assert.rejects(pullBackup({...f.config,keyFile:f.file('missing')},{transport:f.transport}),{code:'backup_pull_failed'});
  await assert.rejects(stat(f.file('missing')),{code:'ENOENT'});
  await chmod(f.config.identityFile,0o644);await assert.rejects(f.pull(),{code:'private_file_permissions'});await chmod(f.config.identityFile,0o600);
  await mkdir(f.config.localDirectory,{mode:0o755});await assert.rejects(f.pull(),{code:'local_directory_permissions'});await chmod(f.config.localDirectory,0o700);
  await symlink(f.config.localDirectory,f.file('directory-link'));await assert.rejects(pullBackup({...f.config,localDirectory:f.file('directory-link')},{transport:f.transport}),{code:'local_directory_permissions'});
  const insideSource=path.resolve('synthetic-pull-must-not-create');
  await assert.rejects(pullBackup({...f.config,localDirectory:insideSource},{transport:f.transport}),{code:'private_path_inside_source'});
  await assert.rejects(stat(insideSource),{code:'ENOENT'});
  await symlink(f.options.database,path.join(f.config.localDirectory,f.entry.name));await assert.rejects(f.pull(),{code:'destination_conflict'});
  assert.equal(f.reads(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM synthetic').get().n,1);
});

test('pull lock excludes concurrent jobs and does not remove an abandoned operator lock',async t=>{
  const f=await pullFixture(t);let release,started;const ready=new Promise(resolve=>started=resolve);
  const first=f.pull({transport:{...f.transport,list:()=>{started();return new Promise(resolve=>release=resolve);}}});await ready;
  await assert.rejects(f.pull(),{code:'pull_locked'});release([f.entry]);await first;
  await mkdir(path.join(f.config.localDirectory,'.pull.lock'),{mode:0o700});await assert.rejects(f.pull(),{code:'pull_locked'});
  assert.ok((await readdir(f.config.localDirectory)).includes('.pull.lock'));
});

test('pull exclusive publication never overwrites a destination appearing during reception',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  const transport={list:f.transport.list,async *read(){await writeFile(path.join(f.config.localDirectory,f.entry.name),'synthetic foreign arrival',{mode:0o600});yield f.ciphertext;}};
  await assert.rejects(f.pull({transport}),{code:'backup_pull_failed'});
  assert.equal(await readFile(path.join(f.config.localDirectory,f.entry.name),'utf8'),'synthetic foreign arrival');
  assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[oldPoint,f.entry.name].sort());
});

test('SSH source uses a constant read-only Python script and treats quoted directory text as inert data',async t=>{
  const f=await pullFixture(t),remote=path.join(await realpath(f.dir),"source ' $(synthetic-inert)");await mkdir(remote,{mode:0o700});
  await writeFile(path.join(remote,f.entry.name),f.ciphertext,{mode:0o600});
  const linked=oldPoint.replace('08-01','08-02'),shared=oldPoint.replace('08-01','08-03');
  await symlink(f.options.database,path.join(remote,linked));await writeFile(path.join(remote,shared),f.ciphertext,{mode:0o644});
  const invocations=[];const transport=createSSHTransport({...f.config,remoteDirectory:remote},{spawnProcess(binary,args,options){
    invocations.push({binary,args,options});assert.equal(binary,'/usr/bin/ssh');assert.equal(options.shell,false);
    assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));assert.ok(args.includes('IdentitiesOnly=yes'));
    const encoded=/^python3 -I - '([A-Za-z0-9+/=]+)'$/.exec(args.at(-1));assert.ok(encoded);assert.ok(!args.at(-1).includes(remote));
    return spawn('python3',['-I','-',encoded[1]],options);
  }});
  const signal=new AbortController().signal;assert.deepEqual(await transport.list({signal}),[f.entry]);
  const chunks=[];for await(const chunk of transport.read(f.entry,{signal}))chunks.push(chunk);assert.deepEqual(Buffer.concat(chunks),f.ciphertext);
  await assert.rejects(async()=>{for await(const chunk of transport.read({...f.entry,name:linked},{signal}))void chunk;},{code:'transport_failed'});
  assert.deepEqual((await readdir(remote)).sort(),[f.entry.name,linked,shared].sort());assert.equal(invocations.length,3);
  assert.throws(()=>createSSHTransport({...f.config,host:'-oProxyCommand=synthetic'}),{code:'invalid_pull_config'});
});

test('SSH output bounds, process failures and deadlines expose no arbitrary remote diagnostics',async t=>{
  const f=await pullFixture(t);await oldLocal(f);
  for(const script of ["process.stdout.write('x'.repeat(600000))","process.stderr.write('x'.repeat(70000));setInterval(()=>{},1000)","process.stderr.write('synthetic private diagnostic');process.exit(1)"]){
    const transport=createSSHTransport(f.config,{spawnProcess:(_,args,options)=>spawn(process.execPath,['-e',script],options)});
    await assert.rejects(f.pull({transport}),error=>error.code==='transport_failed'&&!error.message.includes('diagnostic'));
    assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
  }
  let child;const transport=createSSHTransport(f.config,{spawnProcess:(_,args,options)=>(child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],options))});
  await assert.rejects(f.pull({transport,timeoutMs:150}),{code:'pull_timeout'});
  if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>child.once('close',resolve));
  assert.equal(child.signalCode,'SIGKILL');assert.deepEqual(await readdir(f.config.localDirectory),[oldPoint]);
});

test('pull CLI emits a bounded generic error without private config paths or parser diagnostics',async t=>{
  const f=await fixture(t),filename=f.file('private-config.json');await writeFile(filename,'synthetic invalid configuration',{mode:0o600});
  const child=spawn(process.execPath,['ops/backup-pull.mjs',filename],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise(resolve=>child.once('close',resolve));assert.equal(code,1);assert.equal(stdout,'');
  assert.deepEqual(JSON.parse(stderr),{ok:false,error:'invalid_pull_config'});assert.ok(!stderr.includes(f.dir));
});
