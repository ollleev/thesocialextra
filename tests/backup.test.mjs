import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readFile,stat,chmod,readdir,mkdir,symlink } from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../database.mjs';
import {createBackup} from '../backup.mjs';
import {backupKey,encryptBackup,decryptBackup} from '../ops/backup-crypto.mjs';
import {runBackup,waitForLiveWal} from '../ops/backup-job.mjs';

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
