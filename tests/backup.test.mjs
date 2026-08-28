import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readFile,stat,chmod,readdir } from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../database.mjs';
import {createBackup} from '../backup.mjs';
import {backupKey,encryptBackup,decryptBackup} from '../ops/backup-crypto.mjs';

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
