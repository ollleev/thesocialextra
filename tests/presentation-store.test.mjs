import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {openDatabase} from '../database.mjs';
import {AuthService} from '../auth.mjs';
import {RULES} from '../rules.mjs';
import {ProductionStore} from '../production-store.mjs';
import {PresentationStore} from '../presentation-store.mjs';

const error=code=>value=>value.code===code;
const key=()=>randomUUID();
// Trusted-normalizer stubs for storage tests; these are NOT decodable media and
// are never sent to an HTTP endpoint. Real decoding belongs to processor tests.
const photo=(expectedRevision,sourceHash='a'.repeat(64))=>({expectedRevision,sourceHash,contentType:'image/jpeg',width:20,height:10,bytes:Buffer.from([255,216,1,2,255,217])});
const video=expectedRevision=>({expectedRevision,sourceHash:'b'.repeat(64),contentType:'video/mp4',width:20,height:10,durationMs:1000,bytes:Buffer.from('0000ftyp0000')});
async function fixture(t,options={}) {
 const db=openDatabase(':memory:');let now=1800000000000;t.after(()=>db.close());
 const auth=new AuthService({db,clock:()=>now,testKdf:async(password,salt)=>createHash('sha512').update(password).update(salt).digest()});
 const owner=(await auth.register({username:'presentation_owner',password:'synthetic sufficiently long phrase',acceptedRules:true,rulesVersion:RULES.version})).user.id;
 const reader=(await auth.register({username:'presentation_reader',password:'another synthetic long phrase',acceptedRules:true,rulesVersion:RULES.version})).user.id;
 const store=new ProductionStore({db,clock:()=>now,hasAcceptedRules:id=>auth.hasAcceptedRules(id)});
 const presentations=new PresentationStore({db,store,clock:()=>now,...options});
 const createPost=()=>store.create(owner,{kind:'available',role:'Barman',cityId:'2988507',durationMinutes:30,english:true,vehicle:false,note:'Fixture synthétique.'},key()).post;
 return {db,auth,owner,reader,store,presentations,createPost,advance:ms=>now+=ms};
}

test('presentation reads do not create rows; text stays private until explicit publication through an active post',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();let events=0;f.store.subscribe(()=>events++);
 assert.equal(p.own(f.owner).revision,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentations').get().n,0);
 const saved=p.saveText(f.owner,{expectedRevision:0,bio:'Barman disponible.',videoText:''});assert.equal(saved.revision,1);assert.equal(events,0);
 assert.throws(()=>p.forPost(post.id),error('presentation_not_found'));assert.equal(p.own(f.reader).draft.bio,'');
 assert.throws(()=>p.publish(f.owner,{expectedRevision:1}),error('presentation_public_consent_required'));
 const published=p.publish(f.owner,{expectedRevision:1,publicConsent:true});assert.equal(published.revision,2);assert.equal(events,1);
 assert.deepEqual(p.forPost(post.id),{publicationId:published.publicationId,bio:'Barman disponible.',videoText:'',photo:null,video:null});
 const json=JSON.stringify(p.forPost(post.id));assert.ok(!json.includes(f.owner));assert.ok(!json.includes('presentation_owner'));
});

test('private edits preserve the published version and stale devices cannot overwrite either snapshot',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();
 p.saveText(f.owner,{expectedRevision:0,bio:'Version publiée.'});p.publish(f.owner,{expectedRevision:1,publicConsent:true});
 let events=0;f.store.subscribe(()=>events++);
 p.saveText(f.owner,{expectedRevision:2,bio:'Brouillon privé.'});assert.equal(events,0);
 assert.equal(p.forPost(post.id).bio,'Version publiée.');assert.equal(p.own(f.owner).draft.bio,'Brouillon privé.');
 for(const operation of [()=>p.saveText(f.owner,{expectedRevision:2,bio:'Perdu.'}),()=>p.publish(f.owner,{expectedRevision:2,publicConsent:true}),()=>p.erase(f.owner,{expectedRevision:2})])assert.throws(operation,error('presentation_changed'));
 assert.equal(p.own(f.owner).revision,3);p.publish(f.owner,{expectedRevision:3,publicConsent:true});assert.equal(p.forPost(post.id).bio,'Brouillon privé.');assert.equal(events,1);
});

test('presentation assets share references until republish and upload retries never duplicate or resurrect removed bytes',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost(),firstKey=key(),first=photo(0);
 const saved=p.addAsset(f.owner,'photo',first,firstKey);assert.equal(saved.acceptedRevision,1);
 assert.deepEqual(p.prepareAsset(f.owner,'photo',first,firstKey),saved);assert.deepEqual(p.addAsset(f.owner,'photo',first,firstKey),saved);
 assert.throws(()=>p.addAsset(f.owner,'photo',{...first,sourceHash:'c'.repeat(64)},firstKey),error('idempotency_conflict'));
 assert.throws(()=>p.assetForPost(post.id,'photo'),error('presentation_asset_not_found'));
 const firstPublication=p.publish(f.owner,{expectedRevision:1,publicConsent:true}).publicationId;assert.deepEqual(p.assetForPost(post.id,'photo',null,firstPublication).bytes,first.bytes);
 const next=photo(2,'d'.repeat(64));next.bytes=Buffer.from([255,216,9,9,9,255,217]);p.addAsset(f.owner,'photo',next,key());
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,2);
 assert.deepEqual(p.assetForPost(post.id,'photo',null,firstPublication).bytes,first.bytes);assert.deepEqual(p.ownAsset(f.owner,'photo').bytes,next.bytes);
 assert.equal(p.forPost(post.id).publicationId,firstPublication);
 const secondPublication=p.publish(f.owner,{expectedRevision:3,publicConsent:true}).publicationId;assert.notEqual(secondPublication,firstPublication);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,1);
 assert.throws(()=>p.assetForPost(post.id,'photo',null,firstPublication),error('presentation_asset_not_found'));
 assert.deepEqual(p.assetForPost(post.id,'photo').bytes,next.bytes);
 assert.throws(()=>p.addAsset(f.owner,'photo',first,firstKey),error('presentation_upload_unavailable'));
});

test('video publication requires a readable summary and a private media removal does not remove its published version',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();
 p.addAsset(f.owner,'video',video(0),key());assert.throws(()=>p.publish(f.owner,{expectedRevision:1,publicConsent:true}),error('presentation_video_text_required'));
 p.saveText(f.owner,{expectedRevision:1,bio:'Présentation.',videoText:'Je présente mon expérience au bar.'});
 p.publish(f.owner,{expectedRevision:2,publicConsent:true});assert.equal(p.forPost(post.id).video.durationMs,1000);
 p.removeDraftAsset(f.owner,'video',{expectedRevision:3});assert.equal(p.own(f.owner).draft.video,null);assert.equal(p.forPost(post.id).video.durationMs,1000);
 p.publish(f.owner,{expectedRevision:4,publicConsent:true});assert.equal(p.forPost(post.id).video,null);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,0);
});

test('withdrawal and full erasure remain available without rules agreement; erasure advances the tombstone',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();p.addAsset(f.owner,'photo',photo(0),key());p.publish(f.owner,{expectedRevision:1,publicConsent:true});
 f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(f.owner);
 for(const operation of [()=>p.saveText(f.owner,{expectedRevision:2,bio:'No.'}),()=>p.publish(f.owner,{expectedRevision:2,publicConsent:true}),()=>p.addAsset(f.owner,'photo',photo(2),key())])assert.throws(operation,error('rules_acceptance_required'));
 const withdrawn=p.unpublish(f.owner,{expectedRevision:2});assert.equal(withdrawn.revision,3);assert.equal(withdrawn.published,null);
 assert.throws(()=>p.forPost(post.id),error('presentation_not_found'));assert.ok(p.ownAsset(f.owner,'photo').bytes.length);
 const erased=p.erase(f.owner,{expectedRevision:3});assert.equal(erased.revision,4);assert.equal(erased.draft.photo,null);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,0);
 f.auth.acceptRules(f.owner,{acceptedRules:true,rulesVersion:RULES.version});
 assert.throws(()=>p.addAsset(f.owner,'photo',photo(3),key()),error('presentation_changed'));
});

test('erasure on a never-edited presentation prevents a pending first upload from recreating it',async t=>{
 const f=await fixture(t),p=f.presentations,pending=photo(0),intent=key();assert.equal(p.prepareAsset(f.owner,'photo',pending,intent),null);
 assert.equal(p.erase(f.owner,{expectedRevision:0}).revision,1);
 assert.throws(()=>p.addAsset(f.owner,'photo',pending,intent),error('presentation_changed'));assert.equal(p.own(f.owner).draft.photo,null);
});

test('the periodic store sweep removes expired presentation retry metadata without requiring a new upload',async t=>{
 const f=await fixture(t);f.presentations.addAsset(f.owner,'photo',photo(0),key());
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_intents').get().n,1);
 f.advance(7*86400000);f.store.sweep();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_intents').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,1);
});

test('public presentation reads honor post closure, expiry and outgoing blocks but do not create an account directory',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();p.saveText(f.owner,{expectedRevision:0,bio:'Public volontaire.'});p.publish(f.owner,{expectedRevision:1,publicConsent:true});
 f.store.blockPost(f.reader,post.id);assert.throws(()=>p.forPost(post.id,f.reader),error('presentation_not_found'));assert.equal(p.forPost(post.id).bio,'Public volontaire.');
 f.store.mutate(f.owner,post.id,{action:'close'},key());assert.throws(()=>p.forPost(post.id),error('presentation_not_found'));
 f.store.mutate(f.owner,post.id,{action:'reopen'},key());assert.ok(p.forPost(post.id));f.advance(30*60000);
 assert.throws(()=>p.forPost(post.id),error('presentation_not_found'));assert.equal(p.own(f.owner).published.bio,'Public volontaire.');
});

test('publication without active announcements emits no public update; account deletion cascades drafts and assets',async t=>{
 const f=await fixture(t),p=f.presentations;let events=0;f.store.subscribe(()=>events++);
 p.addAsset(f.owner,'photo',photo(0),key());p.publish(f.owner,{expectedRevision:1,publicConsent:true});assert.equal(events,0);
 f.store.transaction(()=>{f.store.eraseAccountData(f.owner);f.auth.deleteAccount(f.owner);});
 for(const table of ['app_presentations','app_presentation_assets','app_presentation_intents'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.throws(()=>p.own(f.owner),error('login_required'));assert.throws(()=>p.addAsset(f.owner,'photo',photo(2),key()),error('login_required'));
 assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});

test('account/global quotas and intent caps preserve accepted data and retry semantics',async t=>{
 for(const [options,expected] of [[{maxAccountBytes:6},'presentation_account_capacity_reached'],[{maxTotalBytes:6},'presentation_total_capacity_reached'],[{maxIntents:1},'presentation_intent_capacity_reached'],[{maxTotalIntents:1},'presentation_total_intent_capacity_reached']]) {
  const f=await fixture(t,options),p=f.presentations,first=photo(0),intent=key();p.addAsset(f.owner,'photo',first,intent);
  assert.throws(()=>p.addAsset(f.owner,'photo',photo(1,'e'.repeat(64)),key()),error(expected));assert.equal(p.own(f.owner).revision,1);
  assert.deepEqual(p.ownAsset(f.owner,'photo').bytes,first.bytes);assert.equal(p.prepareAsset(f.owner,'photo',first,intent).acceptedRevision,1);
 }
});

test('invalid normalized assets and fields are refused without writes; an outer rollback preserves both snapshots',async t=>{
 const f=await fixture(t),p=f.presentations;
 for(const patch of [{contentType:'image/png'},{width:1601},{height:0},{durationMs:1},{bytes:Buffer.from('bad')},{sourceHash:'bad'}])assert.throws(()=>p.addAsset(f.owner,'photo',{...photo(0),...patch},key()));
 assert.throws(()=>p.saveText(f.owner,{expectedRevision:0,bio:'test',userId:f.reader}),error('unknown_field'));
 assert.throws(()=>p.publish(f.owner,{expectedRevision:0,publicConsent:'true'}),error('presentation_public_consent_required'));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentations').get().n,0);
 assert.throws(()=>f.store.transaction(()=>{p.addAsset(f.owner,'photo',photo(0),key());p.publish(f.owner,{expectedRevision:1,publicConsent:true});throw new Error('synthetic rollback');}),/synthetic rollback/);
 for(const table of ['app_presentations','app_presentation_assets','app_presentation_intents'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});

test('reports retain the viewed published version, never private edits, and copied media remain moderator-only',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();f.store.moderators.add(f.reader);
 const original=photo(0);p.addAsset(f.owner,'photo',original,key());const publicationId=p.publish(f.owner,{expectedRevision:1,publicConsent:true}).publicationId;
 p.saveText(f.owner,{expectedRevision:2,bio:'Brouillon non public.'});
 const input={targetType:'post',targetId:post.id,reason:'other',presentationId:publicationId},intent=key();
 const report=f.store.report(f.reader,input,intent);assert.deepEqual(f.store.report(f.reader,input,intent),report);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_presentation_assets').get().n,1);
 const evidence=JSON.parse(f.store.listReports(f.reader)[0].evidence);assert.equal(evidence.presentation.publicationId,publicationId);assert.equal(evidence.presentation.bio,'');
 assert.throws(()=>p.reportAsset(f.owner,report.id,'photo'),error('moderator_required'));
 p.erase(f.owner,{expectedRevision:3});assert.deepEqual(p.reportAsset(f.reader,report.id,'photo').bytes,original.bytes);
 f.advance(30*86400000);assert.throws(()=>p.reportAsset(f.reader,report.id,'photo'),error('presentation_asset_not_found'));
 f.store.sweep();assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_report_presentation_assets').get().n,0);
});

test('a changed presentation or full evidence budget rolls back the report and its retry record',async t=>{
 const f=await fixture(t,{maxReportBytes:5}),p=f.presentations,post=f.createPost();p.addAsset(f.owner,'photo',photo(0),key());
 const publicationId=p.publish(f.owner,{expectedRevision:1,publicConsent:true}).publicationId;
 const input={targetType:'post',targetId:post.id,reason:'unsafe',presentationId:publicationId};
 assert.throws(()=>f.store.report(f.reader,input,key()),error('report_presentation_capacity_reached'));
 assert.throws(()=>f.store.report(f.reader,{...input,presentationId:key()},key()),error('presentation_changed'));
 for(const table of ['app_reports','app_report_subjects','app_report_presentations','app_report_presentation_assets'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM app_intents WHERE scope='report'").get().n,0);
 // A post-only report is explicit and remains available when no media is copied.
 assert.ok(f.store.report(f.reader,{targetType:'post',targetId:post.id,reason:'unsafe'},key()).id);
});

test('moderation withdraws a reported presentation from every post while preserving unrelated private edits and proof',async t=>{
 const f=await fixture(t),p=f.presentations,first=f.createPost(),second=f.createPost();f.store.moderators.add(f.reader);
 p.addAsset(f.owner,'photo',photo(0),key());p.saveText(f.owner,{expectedRevision:1,bio:'Ancien texte.'});
 const publicationId=p.publish(f.owner,{expectedRevision:2,publicConsent:true}).publicationId;
 assert.equal(p.forPost(second.id).publicationId,publicationId);
 const report=f.store.report(f.reader,{targetType:'post',targetId:first.id,reason:'other',presentationId:publicationId},key());
 p.saveText(f.owner,{expectedRevision:3,bio:'Nouveau brouillon.'});
 assert.throws(()=>f.store.resolveReport(f.owner,report.id,'remove-presentation'),error('moderator_required'));
 let events=0;f.store.subscribe(()=>events++);
 assert.deepEqual(f.store.resolveReport(f.reader,report.id,'remove-presentation'),{id:report.id,status:'removed'});
 assert.equal(events,1);assert.throws(()=>p.forPost(first.id),error('presentation_not_found'));
 assert.throws(()=>p.forPost(second.id),error('presentation_not_found'));
 assert.equal(p.own(f.owner).draft.bio,'Nouveau brouillon.');assert.equal(p.own(f.owner).draft.photo,null);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,0);assert.ok(p.reportAsset(f.reader,report.id,'photo').bytes.length);
 f.store.eraseAccountData(f.owner);f.auth.deleteAccount(f.owner);
 for(const table of ['app_report_presentations','app_report_presentation_assets','app_presentations'])assert.equal(f.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
});

test('moderation never removes a newer publication based on an older report',async t=>{
 const f=await fixture(t),p=f.presentations,post=f.createPost();f.store.moderators.add(f.reader);
 p.saveText(f.owner,{expectedRevision:0,bio:'Version initiale.'});const publicationId=p.publish(f.owner,{expectedRevision:1,publicConsent:true}).publicationId;
 const report=f.store.report(f.reader,{targetType:'post',targetId:post.id,reason:'other',presentationId:publicationId},key());
 p.saveText(f.owner,{expectedRevision:2,bio:'Nouvelle version.'});p.publish(f.owner,{expectedRevision:3,publicConsent:true});
 assert.throws(()=>f.store.resolveReport(f.reader,report.id,'remove-presentation'),error('presentation_changed'));
 assert.equal(p.forPost(post.id).bio,'Nouvelle version.');assert.equal(f.store.listReports(f.reader)[0].status,'open');
});
