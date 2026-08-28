import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,stat,chmod,rename,symlink,copyFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {openDatabase} from '../database.mjs';
import {AuthService} from '../auth.mjs';
import {ProductionStore} from '../production-store.mjs';
import {createBackup} from '../backup.mjs';
import {RULES} from '../rules.mjs';
import {ErasureJournal,initializeErasureJournal,reconcileErasures,acknowledgeErasure} from '../erasure-journal.mjs';
import {prepareErasureReconciledCopy} from '../ops/erasure-recovery.mjs';

const testKdf=async(value,salt)=>createHash('sha512').update(value).update(salt).digest();
const PASSWORD='synthetic erasure password long enough';
async function fixture(t) {
  const dir=await mkdtemp(path.join(tmpdir(),'social-erasure-')),file=name=>path.join(dir,name);
  const db=openDatabase(file('app.sqlite'));
  const auth=new AuthService({db,testKdf}),store=new ProductionStore({db,hasAcceptedRules:id=>auth.hasAcceptedRules(id)});
  const tip=initializeErasureJournal({db,filename:file('journal.sqlite')});
  const journal=new ErasureJournal(file('journal.sqlite'));
  t.after(async()=>{journal.close();if(db.isOpen)db.close();await rm(dir,{recursive:true,force:true});});
  const register=username=>auth.register({username,password:PASSWORD,acceptedRules:true,rulesVersion:RULES.version});
  return {dir,file,db,auth,store,tip,journal,register};
}
test('explicit private journal bootstrap binds one empty application and never overwrites or recreates',async t=>{
  const f=await fixture(t);
  assert.equal((await stat(f.file('journal.sqlite'))).mode&0o777,0o600);
  assert.deepEqual(f.journal.verify(),f.tip);
  assert.equal(f.tip.epoch,f.db.prepare('SELECT epoch FROM app_meta').get().epoch);
  assert.throws(()=>initializeErasureJournal({db:f.db,filename:f.file('journal.sqlite')}));
  assert.throws(()=>new ErasureJournal(f.file('missing.sqlite')),{code:'ENOENT'});
  const other=openDatabase(':memory:');
  try {
    const auth=new AuthService({db:other,testKdf});new ProductionStore({db:other});
    await auth.register({username:'bootstrap_nonempty',password:PASSWORD,acceptedRules:true,rulesVersion:RULES.version});
    assert.throws(()=>initializeErasureJournal({db:other,filename:f.file('nonempty.sqlite')}));
    await assert.rejects(stat(f.file('nonempty.sqlite')),{code:'ENOENT'});
  }finally{other.close();}
});
test('durable intent is idempotent, carries no credentials, and survives an app transaction rollback',async t=>{
  const f=await fixture(t),user=await f.register('journal_owner');
  const receipt=f.journal.append(user.user.id,1000);
  assert.equal(receipt.seq,1);assert.equal(receipt.user_id,user.user.id);
  assert.deepEqual(f.journal.append(user.user.id,2000),receipt);
  assert.throws(()=>f.store.transaction(()=>{
    f.store.eraseAccountData(user.user.id);f.auth.deleteAccount(user.user.id);
    acknowledgeErasure(f.db,f.journal,receipt);throw Error('synthetic rollback');
  }),/synthetic rollback/);
  assert.ok(f.auth.session(user.sessionToken));
  assert.equal(f.db.prepare('SELECT seq FROM app_erasure_checkpoint').get().seq,0);
  const reader=new DatabaseSync(f.file('journal.sqlite'),{readOnly:true});
  try {
    assert.deepEqual(reader.prepare('PRAGMA table_info(erasure_requests)').all().map(r=>r.name),['seq','user_id','requested_at','previous_hash','hash']);
    assert.equal(reader.prepare('SELECT COUNT(*) n FROM erasure_requests').get().n,1);
  }finally{reader.close();}
  f.journal.close();const reopened=new ErasureJournal(f.file('journal.sqlite'));
  try {
    assert.equal(reconcileErasures({...f,journal:reopened}).applied,1);
    assert.equal(f.auth.session(user.sessionToken),null);
    assert.equal(reconcileErasures({...f,journal:reopened}).applied,0);
  }finally{reopened.close();}
});
test('reconciliation removes content, private discussions, blocks and reports from an older snapshot',async t=>{
  const f=await fixture(t),owner=await f.register('restored_owner'),guest=await f.register('restored_guest');
  const post=f.store.create(owner.user.id,{kind:'need',role:'Plongeur',cityId:'2988507',english:false,vehicle:false,durationMinutes:60,places:1,note:'Synthetic'},randomUUID()).post;
  const thread=f.store.contact(guest.user.id,post.id,{message:'Synthetic message'},randomUUID());
  f.store.report(guest.user.id,{targetType:'thread',targetId:thread.threadId,reason:'other'},randomUUID());
  f.store.block(guest.user.id,thread.threadId,true);
  await createBackup(f.file('app.sqlite'),f.file('old.sqlite'));
  const receipt=f.journal.append(owner.user.id);
  f.store.transaction(()=>{f.store.eraseAccountData(owner.user.id);f.auth.deleteAccount(owner.user.id);acknowledgeErasure(f.db,f.journal,receipt);});
  const restored=openDatabase(f.file('old.sqlite'));
  try {
    const auth=new AuthService({db:restored,testKdf}),store=new ProductionStore({db:restored});
    assert.ok(auth.session(owner.sessionToken));
    assert.equal(reconcileErasures({db:restored,auth,store,journal:f.journal}).applied,1);
    assert.equal(auth.session(owner.sessionToken),null);assert.ok(auth.session(guest.sessionToken));
    for(const table of ['app_posts','app_threads','app_messages','app_blocks','app_reports','app_report_subjects'])assert.equal(restored.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{restored.close();}
});
test('missing accounts are still replayed, and a skipped checkpoint cannot be acknowledged',async t=>{
  const f=await fixture(t),first=f.journal.append(randomUUID()),second=f.journal.append(randomUUID());
  assert.throws(()=>acknowledgeErasure(f.db,f.journal,first));
  assert.throws(()=>f.store.transaction(()=>acknowledgeErasure(f.db,f.journal,second)));
  assert.equal(reconcileErasures(f).applied,2);
  assert.equal(f.db.prepare('SELECT seq FROM app_erasure_checkpoint').get().seq,2);
});
test('a mismatched epoch, a truncated journal or a modified chain fails closed',async t=>{
  for(const kind of ['epoch','truncated','hash']) {
    const f=await fixture(t);f.journal.append(randomUUID());f.journal.append(randomUUID());
    reconcileErasures(f);f.journal.close();
    const edit=new DatabaseSync(f.file('journal.sqlite'));
    try {
      if(kind==='epoch')edit.prepare('UPDATE erasure_meta SET epoch=?').run(randomUUID());
      if(kind==='truncated')edit.exec('DELETE FROM erasure_requests WHERE seq=2');
      if(kind==='hash')edit.exec('UPDATE erasure_requests SET requested_at=requested_at+1 WHERE seq=1');
    }finally{edit.close();}
    let changed;
    assert.throws(()=>{changed=new ErasureJournal(f.file('journal.sqlite'));reconcileErasures({...f,journal:changed});});
    changed?.close();
  }
});
test('journal disappearance, symlink, permissive mode and inode replacement are rejected',async t=>{
  for(const kind of ['mode','symlink','replacement','missing']) {
    const f=await fixture(t);
    if(kind==='mode')await chmod(f.file('journal.sqlite'),0o644);
    else {
      await rename(f.file('journal.sqlite'),f.file('old-journal.sqlite'));
      if(kind==='symlink')await symlink(f.file('old-journal.sqlite'),f.file('journal.sqlite'));
      if(kind==='replacement')await copyFile(f.file('old-journal.sqlite'),f.file('journal.sqlite'));
    }
    assert.throws(()=>f.journal.append(randomUUID()));
  }
});

test('offline preparation requires the independently supplied tip, creates only a new copy and never authorizes publication',async t=>{
  const f=await fixture(t),user=await f.register('offline_owner');
  await createBackup(f.file('app.sqlite'),f.file('before.sqlite'));
  f.journal.append(user.user.id);const tip=f.journal.tip();
  await assert.rejects(prepareErasureReconciledCopy({source:f.file('before.sqlite'),journalFile:f.file('journal.sqlite'),destination:f.file('refused.sqlite'),expectedTip:{...tip,seq:0}}),/erasure_tip_mismatch/);
  await assert.rejects(stat(f.file('refused.sqlite')),{code:'ENOENT'});
  const result=await prepareErasureReconciledCopy({source:f.file('before.sqlite'),journalFile:f.file('journal.sqlite'),destination:f.file('prepared.sqlite'),expectedTip:tip});
  assert.equal(result.applied,1);assert.equal(result.publicationAuthorized,false);
  assert.ok(f.auth.session(user.sessionToken)); // Live source never touched.
  const before=new DatabaseSync(f.file('before.sqlite'),{readOnly:true}),after=new DatabaseSync(f.file('prepared.sqlite'),{readOnly:true});
  try {assert.equal(before.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);assert.equal(after.prepare('SELECT COUNT(*) n FROM auth_users').get().n,0);}
  finally{before.close();after.close();}
  await assert.rejects(prepareErasureReconciledCopy({source:f.file('before.sqlite'),journalFile:f.file('journal.sqlite'),destination:f.file('prepared.sqlite'),expectedTip:tip}));
});

test('a killed writer after journal commit leaves an intent that startup can reconcile',async t=>{
  const f=await fixture(t),user=await f.register('crash_journal_owner');
  const source=`import {ErasureJournal} from ${JSON.stringify(new URL('../erasure-journal.mjs',import.meta.url).href)};
    const journal=new ErasureJournal(process.argv[1]);journal.append(process.argv[2]);process.send('committed');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--input-type=module','-e',source,f.file('journal.sqlite'),user.user.id],{stdio:['ignore','ignore','ignore','ipc']});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  try {
    await new Promise((resolve,reject)=>{child.once('message',message=>message==='committed'?resolve():reject(Error('unexpected child response')));child.once('error',reject);child.once('exit',()=>reject(Error('writer exited before commit')));});
    child.kill('SIGSTOP');
    assert.equal(f.journal.verify().seq,1);assert.ok(f.auth.session(user.sessionToken));
    child.kill('SIGKILL');await exited;
    assert.equal(reconcileErasures(f).applied,1);assert.equal(f.auth.session(user.sessionToken),null);
  }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;}
});
