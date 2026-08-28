import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,realpath,rm,writeFile,readFile,readdir,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../database.mjs';
import {AuthService} from '../auth.mjs';
import {ProductionStore} from '../production-store.mjs';
import {createBackup} from '../backup.mjs';
import {ErasureJournal,initializeErasureJournal} from '../erasure-journal.mjs';
import {backupKey,encryptBackup} from '../ops/backup-crypto.mjs';
import {initializeErasurePin,runErasurePullJob,checkErasurePullJob} from '../ops/erasure-pull-job.mjs';

async function fixture(t){
 const dir=await realpath(await mkdtemp(path.join(tmpdir(),'social-erasure-pull-'))),file=name=>path.join(dir,name);
 const db=openDatabase(file('app.sqlite'));new AuthService({db});new ProductionStore({db});
 const baseline=initializeErasureJournal({db,filename:file('journal.sqlite')}),journal=new ErasureJournal(file('journal.sqlite'));
 const key=await backupKey(file('key'),{create:true});await writeFile(file('identity'),'synthetic test identity',{mode:0o600});
 await mkdir(file('status'),{mode:0o700});await mkdir(file('received'),{mode:0o700});
 const config={host:'synthetic.test',identityFile:file('identity'),keyFile:file('key'),remoteDirectory:'/var/backups/synthetic-erasure-only',localDirectory:file('received')};
 await writeFile(file('config.json'),JSON.stringify(config),{mode:0o600});
 const pinFile=file('status/pin.json'),statusFile=file('status/job.json');await initializeErasurePin(pinFile,baseline);
 let now=Date.UTC(2026,7,28,5,0,0),sequence=0;const entries=new Map();
 const transport={async list(){return [...entries.entries()].map(([name,bytes])=>({name,bytes:bytes.length}));},async *read(entry){yield entries.get(entry.name);}};
 async function point({advance=60000,source=file('journal.sqlite')}={}){
  now+=advance;const suffix=String(++sequence),snapshot=file(`source-${suffix}.sqlite`),encrypted=file(`source-${suffix}.tseb`);
  await createBackup(source,snapshot);await encryptBackup(snapshot,encrypted,key);
  const name=`snapshot-${new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z').replaceAll(':','-')}-${randomUUID()}.tseb`;
  entries.set(name,await readFile(encrypted));return name;
 }
 const run=()=>runErasurePullJob(file('config.json'),statusFile,pinFile,{now:()=>now,transport});
 const check=()=>checkErasurePullJob(statusFile,pinFile,{now:()=>now});
 t.after(async()=>{journal.close();db.close();key.fill(0);await rm(dir,{recursive:true,force:true});});
 return {dir,file,db,journal,baseline,pinFile,statusFile,config,entries,point,run,check,advance:ms=>now+=ms};
}
test('a dedicated journal pull authenticates and pins the tip, including an unchanged tip in a fresh snapshot',async t=>{
 const f=await fixture(t);f.journal.append(randomUUID());const name=await f.point();
 assert.equal((await f.run()).ok,true);let checked=await f.check();assert.equal(checked.ok,true);assert.deepEqual(checked.tip,f.journal.tip());assert.equal(checked.completeAfterHostLoss,false);
 assert.equal((await stat(f.pinFile)).mode&0o777,0o600);
 const pin=JSON.parse(await readFile(f.pinFile,'utf8'));assert.equal(pin.point.filename,name);assert.equal(pin.previous,null);
 assert.equal((await f.run()).ok,true); // An existing ciphertext is re-decrypted.
 const next=await f.point();assert.equal((await f.run()).ok,true);
 const fresh=JSON.parse(await readFile(f.pinFile,'utf8'));assert.equal(fresh.point.filename,next);assert.equal(fresh.previous.filename,name);
 assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[name,next].sort());
});
test('retention deletes only the previously pinned oldest point, preserving unrelated canonical archives',async t=>{
 const f=await fixture(t);
 const foreign='snapshot-2026-01-01T00-00-00Z-11111111-1111-4111-8111-111111111111.tseb';
 await writeFile(path.join(f.config.localDirectory,foreign),Buffer.alloc(80,4),{mode:0o600});
 const names=[];
 for(let i=0;i<4;i++){f.journal.append(randomUUID());names.push(await f.point());assert.equal((await f.run()).ok,true);}
 assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[foreign,...names.slice(-2)].sort());
 assert.deepEqual(await readFile(path.join(f.config.localDirectory,foreign)),Buffer.alloc(80,4));
});
test('an older journal in a newer snapshot cannot roll back the off-host pin or green status',async t=>{
 const f=await fixture(t);await createBackup(f.file('journal.sqlite'),f.file('old-journal.sqlite'));
 f.journal.append(randomUUID());await f.point();assert.equal((await f.run()).ok,true);
 const before=await readFile(f.pinFile,'utf8');
 await f.point({source:f.file('old-journal.sqlite')});assert.equal((await f.run()).ok,false);
 assert.equal(await readFile(f.pinFile,'utf8'),before);assert.equal((await f.check()).ok,false);
});
test('ciphertext tampering, missing pin and permissive pin never return success',async t=>{
 for(const kind of ['ciphertext','missing','permissions']){
  const f=await fixture(t),name=await f.point();
  if(kind==='ciphertext'){const bytes=Buffer.from(f.entries.get(name));bytes[bytes.length-1]^=1;f.entries.set(name,bytes);}
  if(kind==='missing')await rm(f.pinFile);
  if(kind==='permissions')await chmod(f.pinFile,0o644);
  assert.equal((await f.run()).ok,false);assert.equal((await f.check()).ok,false);
 }
});
test('journal freshness is two hours and a mismatched pin cannot endorse an old job attestation',async t=>{
 const f=await fixture(t);await f.point();assert.equal((await f.run()).ok,true);assert.equal((await f.check()).ok,true);
 f.advance(7200001);assert.equal((await f.check()).ok,false);assert.equal((await f.run()).ok,false);
 await f.point();assert.equal((await f.run()).ok,true);
 const pin=JSON.parse(await readFile(f.pinFile,'utf8'));pin.point.filename=pin.previous.filename;pin.previous=null;
 await writeFile(f.pinFile,JSON.stringify(pin)+'\n',{mode:0o600});assert.equal((await f.check()).ok,false);
});
test('the genesis pin is explicit, cannot overwrite and cannot use a nonzero or unrelated tip',async t=>{
 const f=await fixture(t);await assert.rejects(initializeErasurePin(f.pinFile,f.baseline));
 for(const tip of [{...f.baseline,seq:1},{...f.baseline,hash:'0'.repeat(64)}])await assert.rejects(initializeErasurePin(f.file('status/new-pin.json'),tip));
 await assert.rejects(stat(f.file('status/new-pin.json')),{code:'ENOENT'});
});

test('a corrupted current point prevents pin advancement and pruning of the older valid point',async t=>{
 const f=await fixture(t);f.journal.append(randomUUID());const first=await f.point();assert.equal((await f.run()).ok,true);
 f.journal.append(randomUUID());const second=await f.point();assert.equal((await f.run()).ok,true);
 const before=await readFile(f.pinFile,'utf8'),firstBytes=await readFile(path.join(f.config.localDirectory,first));
 const damaged=Buffer.from(await readFile(path.join(f.config.localDirectory,second)));damaged[damaged.length-1]^=1;
 await writeFile(path.join(f.config.localDirectory,second),damaged);
 f.journal.append(randomUUID());const third=await f.point();
 assert.equal((await f.run()).ok,false);assert.equal((await f.check()).ok,false);
 assert.equal(await readFile(f.pinFile,'utf8'),before);
 assert.deepEqual(await readFile(path.join(f.config.localDirectory,first)),firstBytes);
 assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[first,second,third].sort());
});

test('a missing current point cannot be retained as if verified or cause the older point to be deleted',async t=>{
 const f=await fixture(t);const first=await f.point();assert.equal((await f.run()).ok,true);
 const second=await f.point();assert.equal((await f.run()).ok,true);
 const before=await readFile(f.pinFile,'utf8'),firstBytes=await readFile(path.join(f.config.localDirectory,first));
 await rm(path.join(f.config.localDirectory,second));const third=await f.point();
 assert.equal((await f.run()).ok,false);assert.equal((await f.check()).ok,false);
 assert.equal(await readFile(f.pinFile,'utf8'),before);
 assert.deepEqual(await readFile(path.join(f.config.localDirectory,first)),firstBytes);
 assert.deepEqual((await readdir(f.config.localDirectory)).sort(),[first,third].sort());
});
