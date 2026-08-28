import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, backupDatabase } from '../database.mjs';
import { ProductionStore, PRIVATE_RETENTION_MS, REPORT_RETENTION_MS } from '../production-store.mjs';

const input = (overrides={}) => ({kind:'need',role:'Barman',cityId:'2988507',zoneId:'oberkampf',english:false,vehicle:false,durationMinutes:30,places:2,note:'Essai synthétique.',...overrides});
const key = n => `test-production-intent-${n}`;
const error = (status,code) => e => e.status===status && e.code===code;
function fixture(t, options={}) {
  const dir=mkdtempSync(path.join(tmpdir(),'thesocialextra-store-')), filename=path.join(dir,'app.sqlite');
  let now=1_800_000_000_000, db=openDatabase(filename);
  const make=()=>new ProductionStore({db,clock:()=>now,moderators:['moderator'],...options});
  let store=make();
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  return {get db(){return db;},get store(){return store;},filename,dir,advance:ms=>now+=ms,reopen(){db.close();db=openDatabase(filename);store=make();return store;}};
}

test('durable posts, messages and intents survive reopening; backup restores the same authorized state',async t=>{
  const f=fixture(t),{post}=f.store.create('owner',input(),key(1));
  const chat=f.store.contact('guest',post.id,{message:'Bonjour synthétique.'},key(2));
  const sent=f.store.addMessage('owner',chat.threadId,{message:'Réponse synthétique.'},key(3));
  const before=f.store.state();
  f.reopen();
  assert.deepEqual(f.store.create('owner',input(),key(1)).post,post);
  assert.deepEqual(f.store.addMessage('owner',chat.threadId,{message:'Réponse synthétique.'},key(3)),sent);
  assert.equal(f.store.readThread('guest',chat.threadId).thread.messages.length,2);
  assert.equal(f.store.state().epoch,before.epoch);
  assert.equal(f.store.state().version,before.version);
  const backup=path.join(f.dir,'backup.sqlite'); await backupDatabase(f.db,backup);
  const restored=openDatabase(backup);
  try {
    const copy=new ProductionStore({db:restored,clock:()=>before.now});
    assert.deepEqual(copy.readThread('owner',chat.threadId),f.store.readThread('owner',chat.threadId));
    assert.equal(statSync(backup).mode&0o777,0o600);
  } finally { restored.close(); }
});

test('create/contact/message retries are scoped to the account and reject payload conflicts',t=>{
  const {store}=fixture(t),{post}=store.create('owner',input(),key(1));
  assert.throws(()=>store.create('owner',input({role:'Plongeur'}),key(1)),error(409,'idempotency_conflict'));
  assert.notEqual(store.create('another-owner',input(),key(1)).post.id,post.id);
  const a=store.contact('guest',post.id,{message:'Premier contact.'},key(2));
  assert.deepEqual(store.contact('guest',post.id,{message:'Premier contact.'},key(2)),a);
  assert.throws(()=>store.contact('guest',post.id,{message:'Autre texte.'},key(2)),error(409,'idempotency_conflict'));
  assert.equal(store.contact('guest',post.id,{message:'Nouvelle tentative.'},key(3)).threadId,a.threadId);
  const b=store.contact('another-guest',post.id,{message:'Autre visiteur.'},key(2));
  assert.notEqual(a.threadId,b.threadId);
  assert.throws(()=>store.readThread('another-guest',a.threadId),error(403,'thread_access_denied'));
  assert.throws(()=>store.addMessage('another-guest',a.threadId,{message:'Interdit.'},key(4)),error(403,'thread_access_denied'));
  assert.throws(()=>store.create(null,input(),key(5)),error(401,'login_required'));
});

test('public expiry does not erase private discussion; private retention ends at its announced deadline',t=>{
  const f=fixture(t),{post}=f.store.create('owner',input(),key(1));
  const chat=f.store.contact('guest',post.id,{message:'Contact.'},key(2));
  f.advance(30*60_000);
  assert.equal(f.store.state().posts.length,0);
  assert.throws(()=>f.store.getPublicPost(post.id),error(410,'post_expired'));
  assert.throws(()=>f.store.mutate('owner',post.id,{action:'reopen'},key(3)),error(410,'post_expired'));
  f.store.addMessage('owner',chat.threadId,{message:'Le fil privé reste accessible.'},key(4));
  assert.equal(f.store.updates('guest').threads[0].expiresAt,post.expiresAt+PRIVATE_RETENTION_MS);
  assert.equal(f.store.readThread('guest',chat.threadId).thread.messages.length,2);
  f.advance(PRIVATE_RETENTION_MS);
  f.store.sweep();
  assert.throws(()=>f.store.readThread('guest',chat.threadId),error(404,'thread_not_found'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_messages').get().n,0);
});

test('places remain bounded and retries return current post state after reopening',t=>{
  const {store}=fixture(t),{post}=store.create('owner',input(),key(1));
  const version=store.state().version;
  store.mutate('owner',post.id,{action:'fill'},key(2));
  store.mutate('owner',post.id,{action:'fill'},key(3));
  assert.equal(store.state().posts.length,0);
  store.mutate('owner',post.id,{action:'reopen'},key(4));
  assert.equal(store.mutate('owner',post.id,{action:'fill'},key(2)).post.places,1);
  assert.equal(store.state().version,version+3);
  assert.equal(store.getPublicPost(post.id).post.revision,3);
  assert.throws(()=>store.mutate('intruder',post.id,{action:'close'},key(5)),error(403,'owner_required'));
});

test('private writes emit no public events; failed transactions neither commit nor emit',t=>{
  const f=fixture(t),events=[]; f.store.subscribe(()=>events.push(f.store.state().version));
  const {post}=f.store.create('owner',input(),key(1));
  const chat=f.store.contact('guest',post.id,{message:'Secret synthétique.'},key(2));
  f.store.addMessage('owner',chat.threadId,{message:'Réponse privée.'},key(3));
  assert.equal(events.length,1);
  const publicState=JSON.stringify(f.store.state());
  for(const hidden of ['Secret synthétique','Réponse privée','guest','owner_id','recoveryCode']) assert.ok(!publicState.includes(hidden));
  assert.throws(()=>f.store.transaction(()=>{f.store.create('owner',input(),key(4));throw new Error('simulate failed write');}));
  assert.equal(f.store.state().posts.length,1);
  assert.equal(events.length,1);
  f.reopen(); assert.equal(f.store.state().posts.length,1);
});

test('a blocked counterpart cannot contact or send; unblocking only removes the caller’s block',t=>{
  const {store}=fixture(t),{post}=store.create('owner',input(),key(1));
  const chat=store.contact('guest',post.id,{message:'Contact.'},key(2));
  assert.throws(()=>store.block('intruder',chat.threadId),error(403,'thread_access_denied'));
  store.block('owner',chat.threadId);
  assert.throws(()=>store.addMessage('guest',chat.threadId,{message:'Bloqué.'},key(3)),error(403,'contact_blocked'));
  assert.throws(()=>store.contact('guest',post.id,{message:'Bloqué.'},key(4)),error(403,'contact_blocked'));
  assert.equal(store.block('guest',chat.threadId,false).blocked,true);
  assert.equal(store.readThread('guest',chat.threadId).thread.blocked,true);
  assert.equal(store.block('owner',chat.threadId,false).blocked,false);
  store.addMessage('guest',chat.threadId,{message:'Autorisé.'},key(5));
});

test('reports are private, authorization is enforced, and moderator removal actually removes content',t=>{
  const {store}=fixture(t),{post}=store.create('owner',input(),key(1));
  const chat=store.contact('guest',post.id,{message:'Contact.'},key(2));
  assert.throws(()=>store.report('intruder',{targetType:'thread',targetId:chat.threadId,reason:'unsafe'},key(3)),error(403,'thread_access_denied'));
  const report=store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'unsafe',details:'Signalement synthétique.'},key(4));
  assert.throws(()=>store.listReports('guest'),error(403,'moderator_required'));
  assert.throws(()=>store.resolveReport('guest',report.id,'remove'),error(403,'moderator_required'));
  assert.equal(store.listReports('moderator').length,1);
  assert.equal(store.resolveReport('moderator',report.id,'remove').status,'removed');
  assert.throws(()=>store.readThread('guest',chat.threadId),error(404,'thread_not_found'));
  assert.equal(store.listReports('moderator').length,0);
});

test('local feed excludes distant cities and owner view does not leak other accounts',t=>{
  const {store}=fixture(t),paris=store.create('owner',input(),key(1)).post;
  const london=store.create('other',input({cityId:'2643743',zoneId:undefined}),key(2)).post;
  assert.deepEqual(store.state().posts.map(p=>p.id),[paris.id]);
  assert.deepEqual(store.state({cityId:'2643743'}).posts.map(p=>p.id),[london.id]);
  assert.deepEqual(store.state({mine:true},'owner').posts.map(p=>p.id),[paris.id]);
  assert.throws(()=>store.state({mine:true}),error(401,'login_required'));
});

test('account erasure removes its public posts, conversations, access intents and blocks',t=>{
  const f=fixture(t),{post}=f.store.create('owner',input(),key(1));
  const chat=f.store.contact('guest',post.id,{message:'Contact.'},key(2));
  f.store.addMessage('guest',chat.threadId,{message:'Private erase sentinel.'},key(3));
  f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'other'},key(4));
  f.store.block('guest',chat.threadId);
  f.store.eraseAccountData('owner');
  assert.equal(f.store.state().posts.length,0);
  assert.equal(f.store.updates('guest').threads.length,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_messages').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_blocks').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_reports').get().n,0);
  assert.ok(!JSON.stringify(f.db.prepare('SELECT response FROM app_intents').all()).includes('Private erase sentinel'));
});

test('erasure removes attributed reports after moderation or expiry, without erasing unrelated evidence',t=>{
  for(const targetType of ['post','thread']) for(const removedBy of ['moderation','expiry']) {
    const f=fixture(t),post=f.store.create('owner',input(),key('attributed-post')).post;
    const chat=f.store.contact('guest',post.id,{message:'Synthetic report subject.'},key('attributed-contact'));
    const targetId=targetType==='post'?post.id:chat.threadId;
    const report=f.store.report('guest',{targetType,targetId,reason:'other'},key('attributed-report'));
    const other=f.store.create('unrelated-owner',input(),key('unrelated-post')).post;
    const unrelated=f.store.report('unrelated-reporter',{targetType:'post',targetId:other.id,reason:'other'},key('unrelated-report'));
    if(removedBy==='moderation') f.store.resolveReport('moderator',report.id,'remove');
    else {f.advance(PRIVATE_RETENTION_MS+30*60_000);f.store.sweep();}
    assert.ok(f.db.prepare('SELECT id FROM app_reports WHERE id=?').get(report.id));
    f.reopen();
    assert.ok(f.db.prepare('SELECT user_id FROM app_report_subjects WHERE report_id=? AND user_id=?').get(report.id,'owner'));
    assert.throws(()=>f.store.transaction(()=>{f.store.eraseAccountData('owner');throw new Error('rollback erasure');}));
    assert.ok(f.db.prepare('SELECT id FROM app_reports WHERE id=?').get(report.id));
    f.store.eraseAccountData('owner');
    assert.equal(f.db.prepare('SELECT id FROM app_reports WHERE id=?').get(report.id),undefined);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_subjects WHERE report_id=?').get(report.id).n,0);
    assert.ok(f.db.prepare('SELECT id FROM app_reports WHERE id=?').get(unrelated.id));
  }
});

test('report attribution backfills legacy live targets, and refuses to guess after a legacy target was removed',t=>{
  const f=fixture(t),post=f.store.create('owner',input(),key('legacy-attribution-post')).post;
  const chat=f.store.contact('guest',post.id,{message:'Legacy synthetic context.'},key('legacy-attribution-contact'));
  const report=f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'other'},key('legacy-attribution-report'));
  f.db.exec('DROP TABLE app_report_subjects');
  f.reopen();
  assert.deepEqual(f.db.prepare('SELECT user_id FROM app_report_subjects WHERE report_id=? ORDER BY user_id').all(report.id).map(row=>row.user_id),['guest','owner']);
  f.store.resolveReport('moderator',report.id,'remove');
  f.db.exec('DROP TABLE app_report_subjects');
  assert.throws(()=>new ProductionStore({db:f.db}),/legacy_report_attribution_required/);
  assert.ok(f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id));
});

test('intent deadlines match the thread, including late retries and late messages',t=>{
  const f=fixture(t),{post}=f.store.create('owner',input({durationMinutes:240}),key(1));
  const chat=f.store.contact('guest',post.id,{message:'Contact.'},key(2));
  const sent=f.store.addMessage('guest',chat.threadId,{message:'Early private sentinel.'},key(3));
  f.advance(PRIVATE_RETENTION_MS+1);
  assert.deepEqual(f.store.addMessage('guest',chat.threadId,{message:'Early private sentinel.'},key(3)),sent);
  f.store.sweep();
  assert.deepEqual(f.store.addMessage('guest',chat.threadId,{message:'Early private sentinel.'},key(3)),sent);
  assert.equal(f.store.readThread('owner',chat.threadId).thread.messages.length,2);
  f.store.addMessage('guest',chat.threadId,{message:'Late private sentinel.'},key(4));
  f.advance(240*60_000);
  f.store.sweep();
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_messages').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_intents').get().n,0);
});

test('stale creation/contact retries cannot claim success after deletion or moderation',t=>{
  const f=fixture(t),{post}=f.store.create('owner',input(),key(1));
  const chat=f.store.contact('guest',post.id,{message:'Contact.'},key(2));
  const report=f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'other'},key(3));
  f.store.resolveReport('moderator',report.id,'remove');
  assert.throws(()=>f.store.contact('guest',post.id,{message:'Contact.'},key(2)),error(410,'intent_unavailable'));
  f.store.remove('owner',post.id);
  assert.throws(()=>f.store.create('owner',input(),key(1)),error(410,'intent_unavailable'));
  assert.equal(f.store.state().posts.length,0);
  const expiring=f.store.create('owner',input(),key(5));
  f.advance(30*60_000);
  assert.throws(()=>f.store.create('owner',input(),key(5)),error(410,'post_expired'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM app_posts WHERE id=?').get(expiring.post.id).n,1);
});

test('nested account erasure preserves earlier committed public change notification',t=>{
  const {store}=fixture(t),events=[];store.subscribe(()=>events.push(true));
  store.transaction(()=>{store.create('owner',input(),key(1));store.eraseAccountData('empty-user');});
  assert.equal(events.length,1);assert.equal(store.state().version,1);
});

test('conversation pagination never silently hides an active thread and stays stable after replies',t=>{
  const {store}=fixture(t);
  for(let p=0;p<5;p++) {
    const {post}=store.create('owner',input(),key(`post-${p}`));
    for(let g=0;g<(p===4?1:50);g++) store.contact(`guest-${p}-${g}`,post.id,{message:'Synthetic contact.'},key('contact'));
  }
  const first=store.updates('owner');
  assert.equal(first.threads.length,200);assert.ok(first.nextCursor);
  store.addMessage('owner',first.threads[0].id,{message:'New reply changes updatedAt only.'},key('reply'));
  const second=store.updates('owner',{cursor:first.nextCursor});
  assert.equal(second.threads.length,1);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.threads,...second.threads].map(t=>t.id)).size,201);
  assert.throws(()=>store.updates('owner',{cursor:'bad'}),error(400,'invalid_cursor'));
});

test('store safety limits reject non-positive, fractional, unsafe or nonnumeric values',t=>{
  const {db}=fixture(t);
  for(const name of ['maxPosts','maxMessages','maxIntents','maxThreads','maxTotalMessages','maxTotalIntents','maxThreadsPerUser','maxReports','maxReportEvidenceBytes','maxVoicesPerThread','maxVoiceBytesPerUser','maxTotalVoiceBytes','maxReportVoiceBytes']) {
    for(const value of [0,-1,1.5,NaN,Infinity,'1',null,Number.MAX_SAFE_INTEGER+1]) {
      assert.throws(()=>new ProductionStore({db,[name]:value}),new RegExp(`${name} must be a positive safe integer`));
    }
  }
});

test('global thread capacity permits existing contacts and recovers space at exact expiry',t=>{
  const f=fixture(t,{maxThreads:1});
  const {post}=f.store.create('owner',input(),key('thread-post'));
  const chat=f.store.contact('guest',post.id,{message:'First contact.'},key('thread-contact'));
  assert.deepEqual(f.store.contact('guest',post.id,{message:'First contact.'},key('thread-contact')),chat);
  assert.equal(f.store.contact('guest',post.id,{message:'Existing conversation.'},key('thread-existing')).threadId,chat.threadId);
  assert.throws(()=>f.store.contact('other-guest',post.id,{message:'New contact.'},key('thread-overflow')),error(429,'total_thread_capacity_reached'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_threads').get().n,1);
  assert.equal(f.store.readThread('owner',chat.threadId).thread.messages.length,1);
  f.advance(PRIVATE_RETENTION_MS+29*60_000);
  const next=f.store.create('next-owner',input(),key('thread-next-post')).post;
  assert.throws(()=>f.store.contact('next-guest',next.id,{message:'New contact.'},key('thread-next-contact')),error(429,'total_thread_capacity_reached'));
  f.advance(60_000);
  const replacement=f.store.contact('next-guest',next.id,{message:'New contact.'},key('thread-next-contact'));
  assert.notEqual(replacement.threadId,chat.threadId);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_threads').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_messages').get().n,1);
});

test('both contact participants share one per-user quota across owner and guest roles',t=>{
  const {store,db}=fixture(t,{maxThreadsPerUser:2});
  const own=store.create('target',input(),key('user-own-post')).post;
  const other=store.create('other-owner',input(),key('user-other-post')).post;
  const third=store.create('third-owner',input(),key('user-third-post')).post;
  store.contact('first-guest',own.id,{message:'First contact.'},key('user-first-contact'));
  const chat=store.contact('target',other.id,{message:'Second contact.'},key('user-second-contact'));
  assert.throws(()=>store.contact('target',third.id,{message:'Guest would exceed cap.'},key('user-guest-overflow')),error(429,'user_thread_capacity_reached'));
  assert.throws(()=>store.contact('another-guest',own.id,{message:'Owner would exceed cap.'},key('user-owner-overflow')),error(429,'user_thread_capacity_reached'));
  assert.equal(store.contact('target',other.id,{message:'Already connected.'},key('user-existing')).threadId,chat.threadId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_threads').get().n,2);
});

test('global message capacity includes initial contacts while accepted message retries remain available',t=>{
  const {store,db}=fixture(t,{maxTotalMessages:2});
  const {post}=store.create('owner',input(),key('message-post'));
  const chat=store.contact('guest',post.id,{message:'Initial message.'},key('message-contact'));
  const sent=store.addMessage('owner',chat.threadId,{message:'Last available message.'},key('message-last'));
  const intents=db.prepare('SELECT COUNT(*) n FROM app_intents').get().n;
  assert.deepEqual(store.addMessage('owner',chat.threadId,{message:'Last available message.'},key('message-last')),sent);
  assert.throws(()=>store.addMessage('guest',chat.threadId,{message:'One too many.'},key('message-overflow')),error(429,'total_message_capacity_reached'));
  assert.throws(()=>store.contact('another-guest',post.id,{message:'New first message.'},key('message-contact-overflow')),error(429,'total_message_capacity_reached'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,intents);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_threads').get().n,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_messages').get().n,2);
  assert.equal(store.contact('guest',post.id,{message:'Existing contact does not add a message.'},key('message-existing')).threadId,chat.threadId);
});

test('global intent capacity is account-wide, preserves cached retries and never evicts live keys',t=>{
  const {store,db}=fixture(t,{maxTotalIntents:3});
  const {post}=store.create('owner',input(),key('intent-post'));
  const chat=store.contact('guest',post.id,{message:'Contact.'},key('intent-contact'));
  const sent=store.addMessage('owner',chat.threadId,{message:'Accepted reply.'},key('intent-message'));
  assert.equal(store.create('owner',input(),key('intent-post')).post.id,post.id);
  assert.deepEqual(store.contact('guest',post.id,{message:'Contact.'},key('intent-contact')),chat);
  assert.deepEqual(store.addMessage('owner',chat.threadId,{message:'Accepted reply.'},key('intent-message')),sent);
  assert.throws(()=>store.addMessage('owner',chat.threadId,{message:'Changed payload.'},key('intent-message')),error(409,'idempotency_conflict'));
  assert.throws(()=>store.mutate('owner',post.id,{action:'fill'},key('intent-mutation')),error(429,'total_idempotency_capacity_reached'));
  assert.throws(()=>store.create('unrelated-account',input(),key('intent-other-post')),error(429,'total_idempotency_capacity_reached'));
  assert.equal(store.getPublicPost(post.id).post.places,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_messages').get().n,2);
});

test('message writes purge expired rows before measuring limits and keep cleanup inside outer rollback',t=>{
  const f=fixture(t,{maxTotalMessages:2,maxTotalIntents:4});
  const old=f.store.create('old-owner',input(),key('purge-old-post')).post;
  const oldChat=f.store.contact('old-guest',old.id,{message:'Expiring message.'},key('purge-old-contact'));
  f.advance(PRIVATE_RETENTION_MS+29*60_000);
  const current=f.store.create('owner',input(),key('purge-current-post')).post;
  const chat=f.store.contact('guest',current.id,{message:'Current initial message.'},key('purge-current-contact'));
  assert.throws(()=>f.store.addMessage('owner',chat.threadId,{message:'After cleanup.'},key('purge-reply')),error(429,'total_idempotency_capacity_reached'));
  f.advance(60_000);
  assert.throws(()=>f.store.transaction(()=>{
    f.store.addMessage('owner',chat.threadId,{message:'After cleanup.'},key('purge-reply'));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_threads WHERE id=?').get(oldChat.threadId).n,0);
    throw new Error('synthetic outer rollback');
  }),/synthetic outer rollback/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_threads WHERE id=?').get(oldChat.threadId).n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_messages').get().n,2);
  const accepted=f.store.addMessage('owner',chat.threadId,{message:'After cleanup.'},key('purge-reply'));
  assert.equal(accepted.message.text,'After cleanup.');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_threads').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_messages').get().n,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,3);
});

test('global report capacity preserves all retained evidence and accepted retries until the retention deadline',t=>{
  const f=fixture(t,{maxReports:2}),post=f.store.create('owner',input(),key('report-cap-post')).post;
  const payload={targetType:'post',targetId:post.id,reason:'other',details:'Synthetic moderation context.'};
  let notifications=0;f.store.subscribe(()=>notifications++);
  const first=f.store.report('reporter-a',payload,key('report-cap-first'));
  f.store.report('reporter-b',payload,key('report-cap-second'));
  const before=f.db.prepare('SELECT id,evidence,status FROM app_reports ORDER BY id').all();
  assert.throws(()=>f.store.report('reporter-c',payload,key('report-cap-overflow')),error(429,'total_report_capacity_reached'));
  assert.deepEqual(f.store.report('reporter-a',payload,key('report-cap-first')),first);
  assert.deepEqual(f.db.prepare('SELECT id,evidence,status FROM app_reports ORDER BY id').all(),before);
  assert.equal(notifications,0);
  f.store.resolveReport('moderator',first.id,'dismiss');
  assert.throws(()=>f.store.report('reporter-c',payload,key('report-cap-overflow')),error(429,'total_report_capacity_reached'));
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM app_reports WHERE status='open'").get().n,1);
  f.advance(REPORT_RETENTION_MS-60_000);
  const fresh=f.store.create('fresh-owner',input(),key('report-cap-fresh-post')).post;
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_reports').get().n,2);
  f.advance(60_000);
  const accepted=f.store.report('reporter-c',{...payload,targetId:fresh.id},key('report-cap-after-expiry'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_reports').get().n,1);
  assert.equal(f.db.prepare('SELECT id FROM app_reports').get().id,accepted.id);
});

test('a long report keeps the first contact and latest complete messages with explicit omitted counts',t=>{
  const f=fixture(t),post=f.store.create('owner',input(),key('report-excerpt-post')).post;
  const chat=f.store.contact('guest',post.id,{message:'Initial synthetic contact.'},key('report-excerpt-contact'));
  for(let i=1;i<200;i++)f.store.addMessage(i%2?'owner':'guest',chat.threadId,{message:`Synthetic message ${i}.`},key(`report-excerpt-message-${i}`));
  const original=f.store.readThread('guest',chat.threadId).thread;
  const report=f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'harassment'},key('report-excerpt'));
  const row=f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id),evidence=JSON.parse(row.evidence);
  assert.ok(Buffer.byteLength(row.evidence,'utf8')<=f.store.maxReportEvidenceBytes);
  assert.equal(evidence.thread.id,chat.threadId);
  assert.equal(evidence.thread.postId,post.id);
  assert.deepEqual(evidence.thread.messages,[original.messages[0],...original.messages.slice(-19)].map(message=>({...message})));
  assert.deepEqual(evidence.excerpt,{strategy:'first_contact_and_recent_messages',totalMessages:200,includedMessages:20,omittedMessages:180,truncated:true});
  assert.equal(f.store.readThread('guest',chat.threadId).thread.messages.length,200);
  assert.equal(f.store.listReports('moderator')[0].evidence,row.evidence);
  assert.ok(!JSON.stringify(f.store.state()).includes('Synthetic message 199.'));
  const stored=row.evidence;f.reopen();
  assert.equal(f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id).evidence,stored);
});

test('report proof limits count UTF-8 bytes and preserve whole first and last messages',t=>{
  const f=fixture(t,{maxReportEvidenceBytes:4096}),post=f.store.create('owner',input(),key('report-utf-post')).post;
  const firstText='界'.repeat(500),chat=f.store.contact('guest',post.id,{message:firstText},key('report-utf-contact'));
  for(let i=1;i<6;i++)f.store.addMessage('owner',chat.threadId,{message:`${i}${'界'.repeat(499)}`},key(`report-utf-message-${i}`));
  const original=f.store.readThread('guest',chat.threadId).thread.messages;
  const report=f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'unsafe'},key('report-utf'));
  const row=f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id),evidence=JSON.parse(row.evidence);
  assert.ok(Buffer.byteLength(row.evidence,'utf8')<=4096);
  assert.ok(Buffer.byteLength(row.evidence,'utf8')>row.evidence.length);
  assert.deepEqual(evidence.thread.messages,[original[0],original.at(-1)].map(message=>({...message})));
  assert.equal(evidence.excerpt.omittedMessages,4);
  assert.equal(evidence.excerpt.truncated,true);
});

test('small reports keep all context, while an impossible evidence budget rejects without partial writes',t=>{
  const f=fixture(t),post=f.store.create('owner',input(),key('report-small-post')).post;
  const chat=f.store.contact('guest',post.id,{message:'Complete short context.'},key('report-small-contact'));
  const payload={targetType:'thread',targetId:chat.threadId,reason:'other'};
  const report=f.store.report('guest',payload,key('report-small'));
  const evidence=JSON.parse(f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id).evidence);
  assert.equal(evidence.thread.messages[0].text,'Complete short context.');
  assert.equal(evidence.excerpt.truncated,false);
  assert.equal(evidence.excerpt.omittedMessages,0);
  const limited=new ProductionStore({db:f.db,clock:()=>post.createdAt,maxReportEvidenceBytes:1});
  const before=f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n;
  assert.throws(()=>limited.report('guest',payload,key('report-too-large')),error(413,'report_evidence_too_large'));
  assert.throws(()=>limited.report('guest',{targetType:'post',targetId:post.id,reason:'other'},key('report-post-too-large')),error(413,'report_evidence_too_large'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_reports').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,before);
  assert.equal(f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id).evidence,JSON.stringify(evidence));
});

// Store fixtures assert only the trusted-normalizer boundary: actual Ogg decoding
// is exercised by audio-processing.test.mjs. These bytes contain no recording.
const voicePayload=(overrides={})=>{
  const bytes=Buffer.alloc(64,0);bytes.write('OggS');bytes.write('SYNTHETIC_NORMALIZED_BYTES',28);
  return {sourceHash:'a'.repeat(64),contentType:'audio/webm',bytes,durationMs:1000,...overrides};
};
const voiceSource=({sourceHash,contentType})=>({sourceHash,contentType});
function voiceChat(f,{owner='owner',guest='guest',tag='voice'}={}) {
  const post=f.store.create(owner,input(),key(`${tag}-post`)).post;
  return {post,...f.store.contact(guest,post.id,{message:'Synthetic initial contact.'},key(`${tag}-contact`))};
}

test('voice metadata and private blobs survive reopening and backup without changing text messages or public state',async t=>{
  const f=fixture(t),chat=voiceChat(f),payload=voicePayload(),before=f.store.readThread('owner',chat.threadId).thread.messages[0];
  let events=0;f.store.subscribe(()=>events++);
  const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-send'));
  const messages=f.store.readThread('guest',chat.threadId).thread.messages;
  assert.deepEqual(messages[0],before);assert.equal(Object.hasOwn(messages[0],'voice'),false);
  assert.equal(sent.message.text,'');assert.equal(sent.message.voice.id,sent.message.id);
  assert.deepEqual(sent.message.voice,{id:sent.message.id,durationMs:1000,bytes:64,contentType:'audio/ogg; codecs=opus'});
  assert.deepEqual({...messages[1]},sent.message);
  assert.equal(f.store.updates('guest').threads[0].incomingCount,1);
  const report=f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'other'},key('voice-durable-report'));
  for(const serialized of [JSON.stringify(f.store.state()),f.db.prepare('SELECT evidence FROM app_reports WHERE id=?').get(report.id).evidence,
    JSON.stringify(f.db.prepare('SELECT response FROM app_intents').all())]) {
    assert.ok(!serialized.includes(payload.bytes.toString('base64')));
    assert.ok(!serialized.includes('SYNTHETIC_NORMALIZED_BYTES'));
    assert.ok(!serialized.includes(payload.sourceHash));
  }
  assert.equal(events,0);assert.equal(f.db.prepare('SELECT typeof(bytes) kind FROM app_voices').get().kind,'blob');
  const exposed=f.store.getVoice('guest',sent.message.id);exposed.bytes.fill(0);
  assert.deepEqual(f.store.getVoice('guest',sent.message.id).bytes,payload.bytes);
  f.reopen();assert.deepEqual(f.store.getVoice('owner',sent.message.id).bytes,payload.bytes);
  assert.deepEqual(f.store.prepareVoice('owner',chat.threadId,voiceSource(payload),key('voice-send')),sent);
  const backup=path.join(f.dir,'voice-backup.sqlite');await backupDatabase(f.db,backup);
  const restored=openDatabase(backup);
  try {
    const copy=new ProductionStore({db:restored,clock:()=>chat.post.createdAt,moderators:['moderator']});
    assert.deepEqual(copy.getVoice('guest',sent.message.id).bytes,payload.bytes);
    assert.deepEqual(copy.getReportVoice('moderator',report.id,sent.message.id).bytes,payload.bytes);
  } finally {restored.close();}
});

test('voice preflight is read-only for new intents and retries use source identity, account and thread scope',t=>{
  const f=fixture(t),chat=voiceChat(f),payload=voicePayload(),source=voiceSource(payload),intentCount=f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n;
  assert.equal(f.store.prepareVoice('owner',chat.threadId,source,key('voice-retry')),null);
  assert.equal(f.store.prepareVoice('owner',chat.threadId,source,key('voice-retry')),null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,intentCount);
  const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-retry'));
  const otherEncoding=voicePayload({durationMs:1200});otherEncoding.bytes[60]=9;
  assert.deepEqual(f.store.addVoiceMessage('owner',chat.threadId,otherEncoding,key('voice-retry')),sent);
  for(const changed of [{...source,sourceHash:'b'.repeat(64)},{...source,contentType:'audio/mp4'}]) {
    assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,changed,key('voice-retry')),error(409,'idempotency_conflict'));
  }
  assert.throws(()=>f.store.addMessage('owner',chat.threadId,{message:'Text cannot reuse voice key.'},key('voice-retry')),error(409,'idempotency_conflict'));
  f.store.addMessage('owner',chat.threadId,{message:'Text first.'},key('text-before-voice'));
  assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,source,key('text-before-voice')),error(409,'idempotency_conflict'));
  const guest=f.store.addVoiceMessage('guest',chat.threadId,payload,key('voice-retry'));
  assert.notEqual(guest.message.id,sent.message.id);
  const other=voiceChat(f,{tag:'voice-other'});
  assert.notEqual(f.store.addVoiceMessage('owner',other.threadId,payload,key('voice-retry')).message.id,sent.message.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,3);
});

test('voice access, block and suspension are rechecked before replay and after preflight; expiry revokes reads',t=>{
  const f=fixture(t),chat=voiceChat(f),payload=voicePayload(),source=voiceSource(payload);
  const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-access'));
  for(const action of [()=>f.store.getVoice('intruder',sent.message.id),()=>f.store.prepareVoice('intruder',chat.threadId,source,key('voice-access')),
    ()=>f.store.addVoiceMessage('intruder',chat.threadId,payload,key('voice-access'))]) assert.throws(action,error(403,'thread_access_denied'));
  assert.throws(()=>f.store.getVoice(null,sent.message.id),error(401,'login_required'));
  assert.equal(f.store.prepareVoice('guest',chat.threadId,source,key('voice-after-preflight')),null);
  f.store.block('owner',chat.threadId);
  assert.throws(()=>f.store.addVoiceMessage('guest',chat.threadId,payload,key('voice-after-preflight')),error(403,'contact_blocked'));
  assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,source,key('voice-access')),error(403,'contact_blocked'));
  assert.throws(()=>f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-access')),error(403,'contact_blocked'));
  assert.deepEqual(f.store.getVoice('guest',sent.message.id).bytes,payload.bytes); // Existing history stays readable.
  f.store.block('owner',chat.threadId,false);
  f.db.prepare('INSERT INTO app_suspended_users VALUES(?,?)').run('owner',chat.post.createdAt);
  assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,source,key('voice-access')),error(403,'account_suspended'));
  assert.throws(()=>f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-access')),error(403,'account_suspended'));
  f.advance(30*60_000+PRIVATE_RETENTION_MS);
  assert.throws(()=>f.store.getVoice('guest',sent.message.id),error(404,'voice_not_found'));
  assert.throws(()=>f.store.prepareVoice('guest',chat.threadId,source,key('voice-after-preflight')),error(404,'thread_not_found'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,0);
});

test('voice storage validates source identity, normalized size, duration and minimum Ogg signature atomically',t=>{
  const f=fixture(t),chat=voiceChat(f),payload=voicePayload();
  for(const patch of [{sourceHash:'no'},{sourceHash:'A'.repeat(64)},{sourceHash:'a'.repeat(63)+'\n'},{contentType:'audio/ogg; codecs=opus'}]) {
    assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,voiceSource({...payload,...patch}),key('voice-invalid-source')),error(400,'invalid_voice_source'));
  }
  for(const patch of [{bytes:'OggS'},{bytes:Buffer.alloc(26)},{bytes:Buffer.alloc(64)},{durationMs:0},{durationMs:60001},{durationMs:1.5}]) {
    assert.throws(()=>f.store.addVoiceMessage('owner',chat.threadId,{...payload,...patch},key('voice-invalid')),error(400,'invalid_voice'));
  }
  const big=Buffer.alloc(512*1024+1);big.write('OggS');
  assert.throws(()=>f.store.addVoiceMessage('owner',chat.threadId,{...payload,bytes:big},key('voice-big')),error(413,'voice_too_large'));
  assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,voiceSource(payload),'short'),error(400,'invalid_idempotency_key'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,0);
  assert.equal(f.store.messages(chat.threadId).length,1);
});

test('voice per-thread quota preserves accepted retries and does not consume text-only capacity',t=>{
  const f=fixture(t,{maxVoicesPerThread:1}),chat=voiceChat(f),payload=voicePayload();
  const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-thread-cap'));
  for(const user of ['owner','guest']) {
    assert.throws(()=>f.store.prepareVoice(user,chat.threadId,voiceSource(payload),key('voice-thread-overflow')),error(429,'voice_thread_capacity_reached'));
    assert.throws(()=>f.store.addVoiceMessage(user,chat.threadId,payload,key('voice-thread-overflow')),error(429,'voice_thread_capacity_reached'));
  }
  assert.deepEqual(f.store.prepareVoice('owner',chat.threadId,voiceSource(payload),key('voice-thread-cap')),sent);
  assert.deepEqual(f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-thread-cap')),sent);
  f.store.addMessage('guest',chat.threadId,{message:'Text still allowed.'},key('voice-cap-text'));
  assert.equal(f.store.messages(chat.threadId).length,3);
});

test('voice per-user quota counts the sender across both roles and is freed by conversation deletion',t=>{
  const f=fixture(t,{maxVoiceBytesPerUser:64}),first=voiceChat(f),second=voiceChat(f,{owner:'other-owner',guest:'owner',tag:'voice-role-two'}),payload=voicePayload();
  f.store.addVoiceMessage('owner',first.threadId,payload,key('voice-user-cap'));
  assert.throws(()=>f.store.addVoiceMessage('owner',second.threadId,payload,key('voice-user-overflow')),error(429,'voice_user_capacity_reached'));
  f.store.addVoiceMessage('guest',first.threadId,payload,key('voice-user-independent'));
  f.store.remove('owner',first.post.id);
  f.store.addVoiceMessage('owner',second.threadId,payload,key('voice-user-overflow'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,1);
});

test('global voice quota is measured after expiry cleanup and is rechecked after preflight',t=>{
  const f=fixture(t,{maxTotalVoiceBytes:64}),chat=voiceChat(f),payload=voicePayload();
  assert.equal(f.store.prepareVoice('guest',chat.threadId,voiceSource(payload),key('voice-global-pending')),null);
  const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-global-cap'));
  assert.throws(()=>f.store.addVoiceMessage('guest',chat.threadId,payload,key('voice-global-pending')),error(429,'voice_total_capacity_reached'));
  assert.throws(()=>f.store.prepareVoice('guest',chat.threadId,voiceSource(payload),key('voice-global-new')),error(429,'voice_total_capacity_reached'));
  assert.deepEqual(f.store.prepareVoice('owner',chat.threadId,voiceSource(payload),key('voice-global-cap')),sent);
  f.advance(PRIVATE_RETENTION_MS+29*60_000);
  const next=voiceChat(f,{tag:'voice-global-next'});
  f.advance(60_000);
  f.store.addVoiceMessage('guest',next.threadId,payload,key('voice-global-after-expiry'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,1);
});

test('voices share existing total message and idempotency quotas, including accepted replays at capacity',t=>{
  for(const [options,code] of [[{maxMessages:2},'message_capacity_reached'],[{maxTotalMessages:2},'total_message_capacity_reached'],
    [{maxIntents:2},'idempotency_capacity_reached'],[{maxTotalIntents:3},'total_idempotency_capacity_reached']]) {
    const f=fixture(t,options),chat=voiceChat(f),payload=voicePayload();
    const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-shared-cap'));
    assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,voiceSource(payload),key('voice-shared-overflow')),error(429,code));
    assert.throws(()=>f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-shared-overflow')),error(429,code));
    assert.deepEqual(f.store.prepareVoice('owner',chat.threadId,voiceSource(payload),key('voice-shared-cap')),sent);
    assert.equal(f.store.messages(chat.threadId).length,2);
  }
});

test('voice blobs cascade with message, conversation, post, account and private expiry deletion',t=>{
  for(const action of ['message','thread','post','owner','guest','expiry']) {
    const f=fixture(t),chat=voiceChat(f),sent=f.store.addVoiceMessage('owner',chat.threadId,voicePayload(),key('voice-cascade'));
    if(action==='message'){
      f.db.prepare('DELETE FROM app_messages WHERE id=?').run(sent.message.id);
      assert.throws(()=>f.store.prepareVoice('owner',chat.threadId,voiceSource(voicePayload()),key('voice-cascade')),error(410,'intent_unavailable'));
      assert.throws(()=>f.store.addVoiceMessage('owner',chat.threadId,voicePayload(),key('voice-cascade')),error(410,'intent_unavailable'));
    }
    else if(action==='thread')f.store.deleteThread(chat.threadId);
    else if(action==='post')f.store.remove('owner',chat.post.id);
    else if(action==='expiry'){f.advance(PRIVATE_RETENTION_MS+30*60_000);f.store.sweep();}
    else f.store.eraseAccountData(action);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,0,action);
    assert.throws(()=>f.store.getVoice('guest',sent.message.id),error(404,'voice_not_found'));
  }
});

test('reports copy only excerpted voices; moderator evidence survives removal but attribution erases it with the account',t=>{
  const f=fixture(t),chat=voiceChat(f),payload=voicePayload();
  const omitted=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-omitted')).message;
  for(let i=0;i<20;i++)f.store.addMessage('guest',chat.threadId,{message:`Synthetic filler ${i}.`},key(`voice-filler-${i}`));
  const included=f.store.addVoiceMessage('guest',chat.threadId,payload,key('voice-included')).message;
  const report=f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'unsafe'},key('voice-evidence'));
  const later=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-later')).message;
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_voices').get().n,1);
  for(const id of [omitted.id,later.id])assert.throws(()=>f.store.getReportVoice('moderator',report.id,id),error(404,'voice_not_found'));
  assert.throws(()=>f.store.getReportVoice('guest',report.id,included.id),error(403,'moderator_required'));
  assert.throws(()=>f.store.getReportVoice('moderator','another-report',included.id),error(404,'voice_not_found'));
  f.store.resolveReport('moderator',report.id,'remove');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,0);
  assert.deepEqual(f.store.getReportVoice('moderator',report.id,included.id).bytes,payload.bytes);
  f.store.eraseAccountData('owner');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_voices').get().n,0);
  assert.throws(()=>f.store.getReportVoice('moderator',report.id,included.id),error(404,'voice_not_found'));
});

test('report voice budget rejects all copies atomically, preserves retries and existing evidence, and expires at 30 days',t=>{
  const f=fixture(t,{maxReportVoiceBytes:64}),chat=voiceChat(f),payload=voicePayload();
  const sent=f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-proof-cap'));
  const input={targetType:'thread',targetId:chat.threadId,reason:'other'};
  const first=f.store.report('guest',input,key('voice-proof-first'));
  const before=f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n;
  assert.throws(()=>f.store.report('owner',input,key('voice-proof-overflow')),error(429,'report_voice_capacity_reached'));
  assert.deepEqual(f.store.report('guest',input,key('voice-proof-first')),first);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,before);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_reports').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_subjects').get().n,2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_voices').get().n,1);
  f.store.resolveReport('moderator',first.id,'dismiss');
  assert.throws(()=>f.store.report('owner',input,key('voice-proof-overflow')),error(429,'report_voice_capacity_reached'));
  f.advance(PRIVATE_RETENTION_MS+30*60_000);f.store.sweep();
  assert.deepEqual(f.store.getReportVoice('moderator',first.id,sent.message.id).bytes,payload.bytes);
  f.advance(REPORT_RETENTION_MS-PRIVATE_RETENTION_MS-30*60_000);
  assert.throws(()=>f.store.getReportVoice('moderator',first.id,sent.message.id),error(404,'voice_not_found'));
  f.store.sweep();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_voices').get().n,0);
  const next=voiceChat(f,{tag:'voice-proof-next'});
  f.store.addVoiceMessage('guest',next.threadId,payload,key('voice-proof-next-send'));
  f.store.report('owner',{...input,targetId:next.threadId},key('voice-proof-next-report'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_voices').get().n,1);
});

test('outer rollback removes voice, message, intent and report copies together without public events',t=>{
  const f=fixture(t),chat=voiceChat(f),payload=voicePayload(),before=f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n;
  let events=0;f.store.subscribe(()=>events++);
  assert.throws(()=>f.store.transaction(()=>{
    f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-rollback'));
    f.store.report('guest',{targetType:'thread',targetId:chat.threadId,reason:'other'},key('voice-report-rollback'));
    throw new Error('synthetic voice rollback');
  }),/synthetic voice rollback/);
  for(const table of ['app_voices','app_report_voices','app_report_subjects','app_reports'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_intents').get().n,before);
  assert.equal(f.store.messages(chat.threadId).length,1);assert.equal(events,0);
  f.store.addVoiceMessage('owner',chat.threadId,payload,key('voice-rollback'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_voices').get().n,1);
});
