import { prepareEventPost } from '../public/event-post-drafts.js';
import { EventPostPreviewState, renderEventPostPreview } from '../public/event-post-preview.js';
import { ROLES } from '../domain.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,symlink,rm,mkdir} from 'node:fs/promises';
import {spawnSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../database.mjs';
import {createProductionServer} from '../production-server.mjs';
import {RULES,RULE_DOCUMENTS} from '../rules.mjs';
import {createPresentationWorker} from '../presentation-worker.mjs';
import {createImageNormalizer} from '../image-processing.mjs';
import {createVideoNormalizer} from '../video-processing.mjs';
import {createBackup} from '../backup.mjs';
import {backupKey,encryptBackup,decryptBackup} from '../ops/backup-crypto.mjs';
import {AuthService} from '../auth.mjs';
import {ProductionStore} from '../production-store.mjs';
import {PresentationStore} from '../presentation-store.mjs';
import {ErasureJournal,initializeErasureJournal} from '../erasure-journal.mjs';

const AGREEMENT={acceptedRules:true,rulesVersion:RULES.version};

const PASSWORD='synthetic password sufficiently long';
const testKdf=async(password,salt)=>createHash('sha512').update(password).update(salt).digest();
const input=(extra={})=>({kind:'need',role:'Barman',cityId:'2988507',english:false,vehicle:false,durationMinutes:30,places:2,note:'Synthétique.',...extra});
const key=()=>randomUUID();
const eventPlanInput=()=>({id:key(),title:'Événement synthétique',cityId:'2988507',timezone:'Europe/Paris',venue:'Salle de réception',
  startLocal:'2026-08-29T17:00',endLocal:'2026-08-29T23:00',common:{attire:'Tenue noire',equipment:'',arrival:'Entrée principale'},
  needs:[{id:key(),role:'Serveur',quantity:3,confirmed:1,languages:{fr:'required',en:'preferred'},skills:'Service au plateau',
    overrides:{attire:null,equipment:'',arrival:null}}]});
// Processor boundary stub, never claimed as decodable media. Real decoder
// fixtures are covered separately in image/video-processing tests.
const presentationPhoto=()=>({bytes:Buffer.from([255,216,1,2,3,4,255,217]),contentType:'image/jpeg',width:20,height:10});
async function fixture(t,options={}) {
  const db=openDatabase(options.databasePath??':memory:');let now=1_800_000_000_000;
  const publicOrigin=options.publicOrigin??'https://extras.test';
  const app=createProductionServer({db,publicOrigin,clock:()=>now,authOptions:{testKdf},sweepIntervalMs:20,heartbeatIntervalMs:20,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();if(db.isOpen)db.close();});
  const port=app.server.address().port;
  function request(url, {method='GET',body,cookie,headers={},rawBody,origin=true}={}) {
    const payload=rawBody??(body===undefined?undefined:JSON.stringify(body));
    const all={Host:new URL(publicOrigin).host,...(method!=='GET'&&method!=='HEAD'&&origin?{Origin:publicOrigin}:{}),...(cookie?{Cookie:cookie}:{}),...(payload!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers};
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers:all},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,bytes,text,data,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]});});});
      req.on('error',reject);req.end(payload);
    });
  }
  async function register(username) {const r=await request('/api/auth/register',{method:'POST',body:{username,password:PASSWORD,...AGREEMENT}});assert.equal(r.status,201,JSON.stringify(r.data));return r;}
  function stream(url='/api/events',cookie) {
    return new Promise((resolve,reject)=>{
      const req=http.get({hostname:'127.0.0.1',port,path:url,headers:{Host:new URL(publicOrigin).host,...(cookie?{Cookie:cookie}:{})}},res=>{
        let buffer='';const frames=[],waiters=[];
        res.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);if(!frame.startsWith('event:'))continue;const parsed={event:frame.split('\n')[0].slice(7),data:JSON.parse(frame.split('\ndata: ')[1])};const waiter=waiters.shift();if(waiter)waiter(parsed);else frames.push(parsed);}});
        const result={status:res.statusCode,frames,close:()=>req.destroy(),next(){if(frames.length)return Promise.resolve(frames.shift());return new Promise((ok,no)=>{const timeout=setTimeout(()=>no(new Error('SSE timeout')),2000);waiters.push(frame=>{clearTimeout(timeout);ok(frame);});});}};
        t.after(()=>req.destroy());resolve(result);
      });req.on('error',reject);
    });
  }
  return {app,db,request,register,stream,advance:ms=>now+=ms};
}

test('production requires canonical HTTPS and local HTTP requires explicit loopback mode',async t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  for(const origin of [undefined,'http://extras.test','https://extras.test/','https://name:pass@extras.test'])assert.throws(()=>createProductionServer({db,publicOrigin:origin}));
  assert.throws(()=>createProductionServer({db,publicOrigin:'http://extras.test',allowLocalHttp:true}));
  const f=await fixture(t,{publicOrigin:'http://localhost:4178',allowLocalHttp:true});
  const r=await f.register('local_user');assert.match(r.cookie,/^extra_session=/);assert.doesNotMatch(r.headers['set-cookie'][0],/; Secure/);
});

test('the public deletion page and account link are readable without authentication and never delete on GET',async t=>{
  const f=await fixture(t),registered=await f.register('deletion_page_user');
  const page=await f.request('/delete-account.html');
  assert.equal(page.status,200);assert.match(page.headers['content-type'],/^text\/html/);
  assert.match(page.text,/<title>Supprimer votre compte — thesocialextra<\/title>/);
  assert.match(page.text,/href="\/\?account=delete"/);assert.doesNotMatch(page.text,/<script\b|<form\b/i);
  assert.match(page.text,/base active/);assert.match(page.text,/sauvegardes/);assert.match(page.text,/restent à valider/);
  const privacy=await f.request('/privacy.html');assert.match(privacy.text,/href="\/delete-account\.html"/);
  for(const cookie of [undefined,registered.cookie]) {
    const form=await f.request('/?account=delete',{cookie});assert.equal(form.status,200);
    assert.match(form.text,/<input id="delete-confirm" type="checkbox" required>/);
    assert.match(form.text,/id="delete-password"[^>]+required/);
    assert.match(form.text,/id="cancel-delete-account" type="button"/);
  }
  assert.equal((await f.request('/api/session',{cookie:registered.cookie})).data.user.id,registered.data.user.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);
});

test('cookie-only sessions expose no tokens, validate strictly, and enforce origin and host',async t=>{
  const f=await fixture(t),r=await f.register('COOKIE_USER');
  assert.deepEqual(Object.keys(r.data).sort(),['recoveryCode','rules','user']);assert.equal(r.data.user.username,'cookie_user');
  assert.match(r.headers['set-cookie'][0],/^__Host-extra_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.equal(r.headers['strict-transport-security'],'max-age=31536000');
  const session=await f.request('/api/session',{cookie:r.cookie});
  assert.deepEqual(session.data,{mode:'production',user:r.data.user,ownership:[],moderator:false,rules:{...RULES,accepted:true},features:{eventPlans:true}});
  const token=r.cookie.split('=')[1];
  assert.equal((await f.request('/api/session',{headers:{'X-Owner-Token':token,Authorization:`Bearer ${token}`}})).data.user,null);
  for(const cookie of [`${r.cookie}; ${r.cookie}`,`${r.cookie}x`,'broken',`${r.cookie}; __Host-extra_session=anything`])assert.equal((await f.request('/api/session',{cookie})).status,400);
  assert.equal((await f.request('/api/state',{headers:{Host:'attacker.test'}})).status,403);
  for(const headers of [{Origin:'null'},{Origin:'https://attacker.test'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}])
    assert.equal((await f.request('/api/posts',{method:'POST',cookie:r.cookie,body:input(),headers})).status,403);
  assert.equal((await f.request('/api/auth/login',{method:'POST',body:{username:'cookie_user',password:PASSWORD},origin:false})).status,403);
  assert.equal((await f.request('/api/posts',{method:'POST',body:input(),headers:{'X-Owner-Token':token,'Idempotency-Key':key()}})).status,401);
  assert.equal((await f.request('/api/auth/logout',{method:'POST',cookie:r.cookie,body:{}})).status,200);
  assert.equal((await f.request('/api/session',{cookie:r.cookie})).data.user,null);
});

test('HTTP accounts isolate posts and threads; idempotent retries do not duplicate content',async t=>{
  const f=await fixture(t),owner=await f.register('owner_one'),guest=await f.register('guest_one'),other=await f.register('other_one');
  assert.equal((await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input()})).status,400);
  const createKey=key(),create=()=>f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':createKey}});
  const first=await create(),again=await create();assert.equal(first.status,201);assert.equal(first.data.post.id,again.data.post.id);
  const post=first.data.post,p=`/api/posts/${post.id}`;
  assert.equal((await f.request(p)).data.post.id,post.id);
  assert.deepEqual((await f.request('/api/session',{cookie:owner.cookie})).data.ownership,[post.id]);
  assert.equal((await f.request(p,{method:'PATCH',cookie:other.cookie,body:{action:'fill'},headers:{'Idempotency-Key':key()}})).status,403);
  assert.equal((await f.request(p,{method:'DELETE',cookie:other.cookie})).status,403);
  assert.equal((await f.request('/api/posts',{method:'POST',cookie:other.cookie,body:input({userId:owner.data.user.id}),headers:{'Idempotency-Key':key()}})).status,400);
  const contactKey=key(),contact=()=>f.request(p+'/contact',{method:'POST',cookie:guest.cookie,body:{message:'Contact synthétique privé.'},headers:{'Idempotency-Key':contactKey}});
  const chat=await contact();assert.equal(chat.status,201);assert.deepEqual((await contact()).data,chat.data);
  const thread=`/api/threads/${chat.data.threadId}`;
  assert.equal((await f.request(thread,{cookie:other.cookie})).status,403);
  assert.equal((await f.request(p+'/threads',{cookie:guest.cookie})).status,403);
  const inbox=await f.request(p+'/threads',{cookie:owner.cookie});assert.equal(inbox.data.threads.length,1);assert.ok(!inbox.text.includes('Contact synthétique privé.'));
  const messageKey=key(),send=()=>f.request(thread+'/messages',{method:'POST',cookie:owner.cookie,body:{message:'Réponse privée.'},headers:{'Idempotency-Key':messageKey}});
  const replies=await Promise.all([send(),send(),send()]);assert.ok(replies.every(x=>x.status===201));assert.equal(new Set(replies.map(x=>x.data.message.id)).size,1);
  assert.equal((await f.request(thread+'/messages',{method:'POST',cookie:owner.cookie,body:{message:'Autre réponse.'},headers:{'Idempotency-Key':messageKey}})).status,409);
  assert.equal((await f.request(thread,{cookie:guest.cookie})).data.thread.messages.length,2);
  const updates=await f.request('/api/updates',{method:'POST',cookie:guest.cookie,body:{}});assert.equal(updates.data.threads[0].incomingCount,1);assert.equal(updates.data.nextCursor,null);assert.equal((await f.request('/api/updates',{method:'POST',cookie:guest.cookie,body:{cursor:null}})).status,200);assert.equal((await f.request('/api/updates',{method:'POST',cookie:guest.cookie,body:{cursor:'not-a-valid-cursor'}})).status,400);assert.ok(!updates.text.includes('Réponse privée.'));
  assert.equal((await f.request('/api/updates',{method:'POST',cookie:other.cookie,body:{access:[{kind:'thread',id:chat.data.threadId,token:owner.cookie}]}})).status,400);
  const fillKey=key();for(let i=0;i<2;i++)assert.equal((await f.request(p,{method:'PATCH',cookie:owner.cookie,body:{action:'fill'},headers:{'Idempotency-Key':fillKey}})).data.post.places,1);
  assert.equal((await f.request(p,{method:'PATCH',cookie:owner.cookie,body:{action:'reopen'},headers:{'Idempotency-Key':key()}})).data.post.places,2);
  assert.equal((await f.request(thread+'/block',{method:'POST',cookie:owner.cookie,body:{}})).status,400);
  assert.equal((await f.request(thread+'/block',{method:'POST',cookie:owner.cookie,body:{blocked:true}})).data.blocked,true);
  assert.equal((await f.request(thread+'/messages',{method:'POST',cookie:guest.cookie,body:{message:'Interdit.'},headers:{'Idempotency-Key':key()}})).status,403);
});

test('recovery revokes old sessions and account deletion requires password and removes business data',async t=>{
  const f=await fixture(t),owner=await f.register('erase_owner'),guest=await f.register('erase_guest');
  const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
  const chat=(await f.request(`/api/posts/${post.id}/contact`,{method:'POST',cookie:guest.cookie,body:{message:'Private synthetic.'},headers:{'Idempotency-Key':key()}})).data;
  assert.equal((await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:'incorrect password long enough'}})).status,401);
  assert.equal((await f.request(`/api/posts/${post.id}`)).status,200);
  const password='another synthetic password for recovery';
  const recovery=await f.request('/api/auth/recover',{method:'POST',body:{recoveryCode:owner.data.recoveryCode,password}});
  assert.equal(recovery.status,200);assert.ok(recovery.data.recoveryCode);assert.ok(!recovery.data.sessionToken);
  assert.equal((await f.request('/api/session',{cookie:owner.cookie})).data.user,null);
  const deleted=await f.request('/api/account',{method:'DELETE',cookie:recovery.cookie,body:{password}});assert.equal(deleted.status,204);assert.match(deleted.headers['set-cookie'][0],/Max-Age=0/);
  assert.equal((await f.request('/api/session',{cookie:recovery.cookie})).data.user,null);
  assert.equal((await f.request(`/api/posts/${post.id}`)).status,404);
  assert.equal((await f.request(`/api/threads/${chat.threadId}`,{cookie:guest.cookie})).status,404);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);
});

test('HTTP and live streams apply job filters and reject ambiguous search parameters',async t=>{
  const f=await fixture(t),owner=await f.register('filtered_owner');
  const barman=f.app.store.create(owner.data.user.id,input(),key()).post;
  const query='?kind=need&role=Plongeur&english=true&vehicle=1&sort=oldest';
  const stream=await f.stream('/api/events'+query);
  const before=(await stream.next()).data;assert.deepEqual(before.posts,[]);assert.equal(before.counts.need,1);
  f.app.store.create(owner.data.user.id,input({role:'Plongeur',english:true,vehicle:false}),key());
  assert.deepEqual((await stream.next()).data.posts,[]);
  const match=f.app.store.create(owner.data.user.id,input({role:'Plongeur',english:true,vehicle:true}),key()).post;
  const live=(await stream.next()).data;assert.deepEqual(live.posts.map(p=>p.id),[match.id]);assert.equal(live.total,1);
  const state=await f.request('/api/state'+query);assert.equal(state.status,200);assert.deepEqual(state.data,live);
  assert.equal((await f.request('/api/state?sort=oldest')).data.posts[0].createdAt,barman.createdAt);
  for(const bad of ['?role=unknown','?role=Barman&role=Plongeur','?english=yes','?vehicle=','?sort=unknown','?kind=other','?zone=unknown']) {
    assert.equal((await f.request('/api/state'+bad)).status,400);
    assert.equal((await f.request('/api/events'+bad)).status,400);
  }
});

test('SSE is scoped, private changes remain private, and revoked/expired sessions close streams',async t=>{
  const f=await fixture(t),owner=await f.register('sse_owner'),guest=await f.register('sse_guest');
  const publicStream=await f.stream(),mine=await f.stream('/api/events?mine=true',owner.cookie),london=await f.stream('/api/events?cityId=2643743');
  assert.equal((await publicStream.next()).data.posts.length,0);await mine.next();await london.next();
  assert.equal((await f.request('/api/state?mine=true')).status,401);
  const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
  const published=await publicStream.next();assert.equal(published.data.posts[0].id,post.id);assert.equal((await mine.next()).data.posts.length,1);assert.equal((await london.next()).data.posts.length,0);
  await f.request(`/api/posts/${post.id}/contact`,{method:'POST',cookie:guest.cookie,body:{message:'Hidden text.'},headers:{'Idempotency-Key':key()}});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(publicStream.frames.length,0);assert.ok(!JSON.stringify(published).includes('owner_id'));
  await f.request('/api/auth/logout',{method:'POST',cookie:owner.cookie,body:{}});assert.equal((await mine.next()).event,'session-expired');
  f.advance(30*60_000);assert.equal((await publicStream.next()).data.posts.length,0);
  const guestStream=await f.stream('/api/events',guest.cookie);await guestStream.next();f.advance(30*24*3600_000);assert.equal((await guestStream.next()).event,'session-expired');
});

test('one SSE batch sweeps once and shares serialized frames only for an exact reader and complete scope',async t=>{
  const f=await fixture(t,{sweepIntervalMs:60000,heartbeatIntervalMs:60000,maxStreamsPerIp:12});
  const owner=await f.register('batch_owner'),reader=await f.register('batch_reader'),other=await f.register('batch_other');
  const login=await f.request('/api/auth/login',{method:'POST',body:{username:'batch_reader',password:PASSWORD}});assert.equal(login.status,200);
  const publicPost=f.app.store.create(owner.data.user.id,input(),key()).post;
  const own=f.app.store.create(reader.data.user.id,input({role:'Plongeur',english:true,vehicle:true}),key()).post;
  const otherPost=f.app.store.create(other.data.user.id,input(),key()).post;
  f.app.store.blockPost(reader.data.user.id,publicPost.id);
  const specifications=[['',null],['',null],['',reader.cookie],['',login.cookie],['',other.cookie],
    ['?kind=need&role=Plongeur&english=true&vehicle=true&sort=oldest',reader.cookie],['?mine=true',reader.cookie],
    ['?cityId=2643743',null],['?lat=48.87&lng=2.36',reader.cookie]];
  const streams=[];for(const [query,cookie] of specifications){const stream=await f.stream('/api/events'+query,cookie);await stream.next();streams.push(stream);}
  let sweeps=0,readers=0,calculations=0,serializations=0;
  const originalSweep=f.app.store.sweep.bind(f.app.store),originalReader=f.app.store.snapshotReader.bind(f.app.store);
  f.app.store.sweep=now=>{sweeps++;return originalSweep(now);};
  f.app.store.snapshotReader=()=>{readers++;const read=originalReader();return (...args)=>{
    calculations++;const snapshot=read(...args);Object.defineProperty(snapshot,'toJSON',{value:()=>{serializations++;return snapshot;}});return snapshot;
  };};
  f.app.store.mutate(owner.data.user.id,publicPost.id,{action:'fill'},key());
  const first=await Promise.all(streams.map(stream=>stream.next()));
  assert.deepEqual({sweeps,readers,calculations,serializations},{sweeps:1,readers:1,calculations:7,serializations:7});
  assert.deepEqual(first[0].data,first[1].data);assert.deepEqual(first[2].data,first[3].data);
  assert.ok(first[0].data.posts.some(p=>p.id===publicPost.id));assert.equal('ownedPosts' in first[0].data,false);
  assert.ok(first[2].data.posts.every(p=>p.id!==publicPost.id));assert.deepEqual(first[2].data.ownedPostIds,[own.id]);
  assert.deepEqual(first[4].data.ownedPostIds,[otherPost.id]);assert.ok(first[4].data.posts.some(p=>p.id===publicPost.id));
  assert.deepEqual(first[5].data.posts.map(p=>p.id),[own.id]);assert.deepEqual(first[6].data.posts.map(p=>p.id),[own.id]);
  assert.equal(first[7].data.posts.length,0);assert.notEqual(first[8].data.scope,first[2].data.scope);
  sweeps=readers=calculations=serializations=0;
  f.app.store.mutate(owner.data.user.id,publicPost.id,{action:'close'},key());
  const second=await Promise.all(streams.map(stream=>stream.next()));
  assert.deepEqual({sweeps,readers,calculations,serializations},{sweeps:1,readers:1,calculations:7,serializations:7});
  assert.equal(second[0].data.version,first[0].data.version+1);assert.ok(second[0].data.posts.every(p=>p.id!==publicPost.id));
});

test('an SSE frame cached for one session is not sent to another session revoked before its turn',async t=>{
  const f=await fixture(t,{sweepIntervalMs:60000,heartbeatIntervalMs:60000}),reader=await f.register('batch_revoke');
  const login=await f.request('/api/auth/login',{method:'POST',body:{username:'batch_revoke',password:PASSWORD}});assert.equal(login.status,200);
  const post=f.app.store.create(reader.data.user.id,input(),key()).post;
  const first=await f.stream('/api/events',reader.cookie),second=await f.stream('/api/events',login.cookie);await first.next();await second.next();
  let calculations=0;const original=f.app.store.snapshotReader.bind(f.app.store);
  f.app.store.snapshotReader=()=>{const read=original();return (...args)=>{calculations++;const snapshot=read(...args);f.app.auth.logout(login.cookie.split('=')[1]);return snapshot;};};
  f.app.store.mutate(reader.data.user.id,post.id,{action:'fill'},key());
  assert.equal((await first.next()).event,'state');assert.equal((await second.next()).event,'session-expired');assert.equal(calculations,1);
});

test('a session that expires during snapshot calculation receives no computed state',async t=>{
  const f=await fixture(t,{sweepIntervalMs:60000,heartbeatIntervalMs:60000}),reader=await f.register('batch_expiring');
  const login=await f.request('/api/auth/login',{method:'POST',body:{username:'batch_expiring',password:PASSWORD}});assert.equal(login.status,200);
  const post=f.app.store.create(reader.data.user.id,input(),key()).post,stream=await f.stream('/api/events',reader.cookie);await stream.next();
  const cached=await f.stream('/api/events',login.cookie);await cached.next();
  let calculations=0;const original=f.app.store.snapshotReader.bind(f.app.store);
  f.app.store.snapshotReader=()=>{const read=original();return (...args)=>{calculations++;const snapshot=read(...args);f.advance(30*24*3600_000);return snapshot;};};
  f.app.store.mutate(reader.data.user.id,post.id,{action:'fill'},key());
  assert.equal((await stream.next()).event,'session-expired');assert.equal(stream.frames.length,0);
  assert.equal((await cached.next()).event,'session-expired');assert.equal(cached.frames.length,0);assert.equal(calculations,1);
});

test('public-author block HTTP contracts expose no account identity and remain manageable after expiry',async t=>{
  const f=await fixture(t),owner=await f.register('public_block_owner'),reader=await f.register('public_block_reader'),other=await f.register('public_block_other');
  const post=f.app.store.create(owner.data.user.id,input(),key()).post,route=`/api/posts/${post.id}/block`;
  assert.equal((await f.request(route,{method:'POST',body:{}})).status,401);
  assert.equal((await f.request(route,{method:'POST',cookie:reader.cookie,body:{},origin:false})).status,403);
  assert.equal((await f.request(route,{method:'POST',cookie:reader.cookie,body:{userId:owner.data.user.id}})).status,400);
  assert.equal((await f.request(route,{method:'POST',cookie:owner.cookie,body:{}})).data.error,'cannot_block_self');
  const blocked=await f.request(route,{method:'POST',cookie:reader.cookie,body:{}});
  assert.equal(blocked.status,200);assert.deepEqual(Object.keys(blocked.data).sort(),['blockId','feedRevision']);assert.equal(blocked.data.feedRevision,1);
  assert.deepEqual((await f.request(route,{method:'POST',cookie:reader.cookie,body:{}})).data,blocked.data);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_threads').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_messages').get().n,0);
  assert.equal((await f.request(`/api/posts/${post.id}`,{cookie:reader.cookie})).status,404);
  assert.deepEqual(Object.keys((await f.request(`/api/posts/${post.id}`)).data),['post']);
  assert.equal((await f.request(`/api/posts/${post.id}`,{cookie:other.cookie})).data.feedRevision,0);
  const state=await f.request('/api/state',{cookie:reader.cookie});assert.equal(state.data.posts.length,0);assert.equal(state.data.feedRevision,1);assert.equal(state.headers['cache-control'],'no-store');
  assert.equal((await f.request('/api/state')).data.posts.length,1);
  assert.equal((await f.request('/api/blocks')).status,401);
  const listed=await f.request('/api/blocks',{cookie:reader.cookie});
  assert.deepEqual(listed.data,{blocks:[{id:blocked.data.blockId,createdAt:1_800_000_000_000}],nextCursor:null,feedRevision:1});
  assert.equal(listed.headers['cache-control'],'no-store');
  for(const value of [owner.data.user.id,reader.data.user.id,'public_block_owner','blocked_id','blocker_id'])assert.ok(!listed.text.includes(value));
  for(const query of ['?cursor=bad','?cursor=a&cursor=b','?userId=other'])assert.equal((await f.request('/api/blocks'+query,{cookie:reader.cookie})).status,400);
  const unblock=`/api/blocks/${blocked.data.blockId}`;
  assert.equal((await f.request(unblock,{method:'DELETE'})).status,401);
  assert.deepEqual((await f.request(unblock,{method:'DELETE',cookie:other.cookie})).data,{feedRevision:0});
  assert.equal((await f.request('/api/blocks',{cookie:reader.cookie})).data.blocks.length,1);
  f.advance(30*60_000);assert.equal((await f.request(route,{method:'POST',cookie:reader.cookie,body:{}})).status,410);
  f.advance(7*24*60*60_000);f.app.store.sweep();
  const future=f.app.store.create(owner.data.user.id,input(),key()).post;
  assert.equal((await f.request(`/api/posts/${future.id}`,{cookie:reader.cookie})).status,404);
  assert.deepEqual((await f.request(unblock,{method:'DELETE',cookie:reader.cookie})).data,{feedRevision:2});
  assert.deepEqual((await f.request(unblock,{method:'DELETE',cookie:reader.cookie})).data,{feedRevision:2});
  const visible=await f.request(`/api/posts/${future.id}`,{cookie:reader.cookie});assert.equal(visible.status,200);assert.equal(visible.data.feedRevision,2);
});

test('private block invalidation reaches both reader sessions but neither anonymous nor other accounts',async t=>{
  const f=await fixture(t),owner=await f.register('block_sse_owner'),reader=await f.register('block_sse_reader');
  const second=await f.request('/api/auth/login',{method:'POST',body:{username:'block_sse_reader',password:PASSWORD}});assert.equal(second.status,200);
  const post=f.app.store.create(owner.data.user.id,input(),key()).post;
  const one=await f.stream('/api/events',reader.cookie),two=await f.stream('/api/events',second.cookie),anonymous=await f.stream(),unrelated=await f.stream('/api/events',owner.cookie);
  for(const stream of [one,two,anonymous,unrelated])assert.equal((await stream.next()).data.posts.length,1);
  const before=f.app.store.state().version;
  let batchReads=0,batchSnapshots=0;const originalReader=f.app.store.snapshotReader.bind(f.app.store);
  f.app.store.snapshotReader=()=>{batchReads++;const read=originalReader();return (...args)=>{batchSnapshots++;return read(...args);};};
  const block=await f.request(`/api/posts/${post.id}/block`,{method:'POST',cookie:reader.cookie,body:{}});
  for(const stream of [one,two]) {const snapshot=(await stream.next()).data;assert.equal(snapshot.posts.length,0);assert.equal(snapshot.feedRevision,1);assert.equal(snapshot.version,before);}
  assert.equal(batchReads,1);assert.equal(batchSnapshots,1);
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(anonymous.frames.length,0);assert.equal(unrelated.frames.length,0);assert.equal(f.app.store.state().version,before);
  await f.request(`/api/posts/${post.id}/block`,{method:'POST',cookie:reader.cookie,body:{}});
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(one.frames.length,0);assert.equal(two.frames.length,0);
  f.app.store.create(owner.data.user.id,input(),key());
  for(const stream of [one,two])assert.equal((await stream.next()).data.posts.length,0);
  assert.equal((await anonymous.next()).data.posts.length,2);await unrelated.next();
  await f.request(`/api/blocks/${block.data.blockId}`,{method:'DELETE',cookie:second.cookie});
  for(const stream of [one,two]) {const snapshot=(await stream.next()).data;assert.equal(snapshot.posts.length,2);assert.equal(snapshot.feedRevision,2);}
  await new Promise(resolve=>setTimeout(resolve,50));assert.equal(anonymous.frames.length,0);assert.equal(unrelated.frames.length,0);
});

test('HTTP block capacities are configurable, preserve existing entries and permit idempotent retries',async t=>{
  const f=await fixture(t,{maxBlocksPerUser:1,maxTotalBlocks:2}),a=await f.register('block_cap_a'),b=await f.register('block_cap_b'),c=await f.register('block_cap_c');
  const postA=f.app.store.create(a.data.user.id,input(),key()).post,postB=f.app.store.create(b.data.user.id,input(),key()).post;
  const block=(user,post)=>f.request(`/api/posts/${post.id}/block`,{method:'POST',cookie:user.cookie,body:{}});
  const first=await block(c,postA);assert.equal(first.status,200);assert.deepEqual((await block(c,postA)).data,first.data);
  const ownCap=await block(c,postB);assert.equal(ownCap.status,429);assert.equal(ownCap.data.error,'block_capacity_reached');
  const second=await block(a,postB);assert.equal(second.status,200);
  const total=await block(b,postA);assert.equal(total.status,429);assert.equal(total.data.error,'total_block_capacity_reached');
  assert.equal((await f.request('/api/blocks',{cookie:c.cookie})).data.blocks[0].id,first.data.blockId);
  await f.request(`/api/blocks/${second.data.blockId}`,{method:'DELETE',cookie:a.cookie});assert.equal((await block(b,postA)).status,200);
});

test('IP/auth/account quotas are bounded and untrusted XFF cannot bypass them',async t=>{
  const f=await fixture(t,{authRateLimit:2});
  for(let i=0;i<2;i++)assert.equal((await f.request('/api/auth/login',{method:'POST',body:{username:'unknown',password:PASSWORD},headers:{'X-Forwarded-For':`192.0.2.${i+1}`}})).status,401);
  const limited=await f.request('/api/auth/login',{method:'POST',body:{username:'unknown',password:PASSWORD},headers:{'X-Forwarded-For':'198.51.100.4'}});assert.equal(limited.status,429);assert.ok(limited.headers['retry-after']);
  const g=await fixture(t,{accountRateLimit:1});const user=await g.register('limited_account');
  assert.equal((await g.request('/api/session',{cookie:user.cookie})).status,200);assert.equal((await g.request('/api/session',{cookie:user.cookie})).status,429);
  const h=await fixture(t,{trustedProxyAddresses:['127.0.0.1']});assert.equal((await h.request('/api/session',{headers:{'X-Forwarded-For':'192.0.2.1, 192.0.2.2'}})).status,400);
});

test('SSE limits apply per IP and globally, and closed streams free capacity',async t=>{
  const f=await fixture(t,{maxStreams:2,maxStreamsPerIp:1});const a=await f.stream();await a.next();
  assert.equal((await f.request('/api/events')).status,429);a.close();await new Promise(resolve=>setTimeout(resolve,20));
  const b=await f.stream();assert.equal(b.status,200);await b.next();
  const g=await fixture(t,{maxStreams:1,maxStreamsPerIp:2});const c=await g.stream();await c.next();assert.equal((await g.request('/api/events')).status,429);
});

test('HTTP validates JSON, discovery coordinates, roles, and protected static files',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'extra-production-static-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const pub=path.join(root,'public');const {mkdir}=await import('node:fs/promises');await mkdir(pub);
  await writeFile(path.join(pub,'index.html'),'<!doctype html><title>Synthetic fixture</title>');await writeFile(path.join(pub,'font.ttf'),'synthetic');
  await writeFile(path.join(root,'private.txt'),'private synthetic');await symlink(path.join(root,'private.txt'),path.join(pub,'escape.txt'));await writeFile(path.join(pub,'.hidden.txt'),'hidden');
  const f=await fixture(t,{publicDir:pub});
  for(const [rawBody,status] of [['{',400],[JSON.stringify({password:'x'.repeat(9000)}),413],['[]',400]])assert.equal((await f.request('/api/auth/login',{method:'POST',rawBody})).status,status);
  assert.equal((await f.request('/api/auth/login',{method:'POST',rawBody:'text',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await f.request('/api/auth/recover',{method:'POST',body:{recoveryCode:{toString:null},password:PASSWORD}})).status,401);
  const roles=await f.request('/api/roles');assert.equal(roles.data.flatMap(x=>x.roles).length,12);assert.equal((await f.request('/api/zones')).data.length,8);
  const discovered=await f.request('/api/locations?q=Tokyo');assert.equal(discovered.status,200);
  assert.deepEqual((await f.request(`/api/locations/${discovered.data.locations[0].id}`)).data.location,discovered.data.locations[0]);
  assert.equal((await f.request('/api/locations/999999999999')).status,400);
  assert.equal((await f.request('/api/locations/nearest?lat=48.8566&lng=2.35')).status,400);
  for(const query of ['?lat=48.8566&lng=2.35','?mine=wrong','?mine=true&mine=false','?lat=48.85'])assert.equal((await f.request('/api/state'+query)).status,400);
  const page=await f.request('/');assert.equal(page.status,200);assert.equal(page.headers['x-content-type-options'],'nosniff');assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);assert.match(page.text,/Synthetic fixture/);
  assert.equal((await f.request('/font.ttf')).headers['content-type'],'font/ttf');assert.equal((await f.request('/',{method:'HEAD'})).text,'');
  for(const url of ['/escape.txt','/.hidden.txt','/%2e%2e%2fprivate.txt','/production-server.mjs'])assert.equal((await f.request(url)).status,404);
});

test('moderation routes enforce moderator identity and removal',async t=>{
  const f=await fixture(t),owner=await f.register('report_owner'),guest=await f.register('report_guest');
  const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
  const report=await f.request('/api/reports',{method:'POST',cookie:guest.cookie,body:{targetType:'post',targetId:post.id,reason:'spam'},headers:{'Idempotency-Key':key()}});assert.equal(report.status,201);
  assert.equal((await f.request('/api/moderation/reports',{cookie:guest.cookie})).status,403);
  assert.equal((await f.request(`/api/moderation/reports/${report.data.id}`,{method:'POST',cookie:guest.cookie,body:{action:'remove'}})).status,403);
  // Same DB reopened behind a second listener with explicit moderator IDs.
  const app=createProductionServer({db:f.db,publicOrigin:'https://moderation.test',moderators:[guest.data.user.id],authOptions:{testKdf},sweepIntervalMs:1000});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const result=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:app.server.address().port,path:`/api/moderation/reports/${report.data.id}`,method:'POST',headers:{Host:'moderation.test',Origin:'https://moderation.test',Cookie:guest.cookie,'Content-Type':'application/json'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end(JSON.stringify({action:'remove'}));});
  assert.equal(result,200);assert.equal((await f.request(`/api/posts/${post.id}`)).status,404);
});

test('a slow request cannot mutate after its session is revoked during body upload',async t=>{
  for(const operation of ['create','block','acceptance','event-plan']) {
  const f=await fixture(t),owner=await f.register('slow_owner'),payload=JSON.stringify(operation==='event-plan'?eventPlanInput():operation==='create'?input():operation==='acceptance'?AGREEMENT:{});
  if(operation==='acceptance')f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(owner.data.user.id);
  const target=operation==='block'?await f.register('synthetic_target'):null;
  const post=target?f.app.store.create(target.data.user.id,input(),key()).post:null;
  const route=post?`/api/posts/${post.id}/block`:operation==='acceptance'?'/api/account/rules-acceptance':operation==='event-plan'?'/api/event-plans':'/api/posts';
  let pending;
  const accepted=new Promise(resolve=>f.app.server.once('request',resolve));
  const response=new Promise((resolve,reject)=>{
    pending=http.request({hostname:'127.0.0.1',port:f.app.server.address().port,path:route,method:'POST',headers:{Host:'extras.test',Origin:'https://extras.test',Cookie:owner.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'Idempotency-Key':key()}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});pending.on('error',reject);pending.write(payload.slice(0,1));
  });
  await accepted;
  await f.request('/api/auth/logout',{method:'POST',cookie:owner.cookie,body:{}});
  pending.end(payload.slice(1));assert.equal(await response,401);assert.equal(f.app.store.state().posts.length,post?1:0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_blocks').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n,0);
  if(operation==='acceptance')assert.equal(f.app.auth.hasAcceptedRules(owner.data.user.id),false);
  }
});

test('failed account cleanup rolls back business and auth data, and emits no state change',async t=>{
  const f=await fixture(t),owner=await f.register('rollback_owner'),reader=await f.register('rollback_reader');
  const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
  const blocked=f.app.store.blockPost(reader.data.user.id,post.id),privateEvents=[];f.app.store.subscribePrivate(userId=>privateEvents.push(userId));
  const before=f.app.store.state().version;let events=0;f.app.store.subscribe(()=>events++);
  f.db.exec("CREATE TRIGGER fail_auth_delete BEFORE DELETE ON auth_users BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;");
  const result=await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}});
  assert.equal(result.status,500);assert.equal(result.data.error,'internal_error');assert.ok(!result.text.includes('synthetic rollback'));
  assert.equal((await f.request('/api/session',{cookie:owner.cookie})).data.user.id,owner.data.user.id);
  assert.equal((await f.request(`/api/posts/${post.id}`)).status,200);assert.equal(f.app.store.state().version,before);assert.equal(events,0);
  assert.deepEqual(privateEvents,[]);assert.equal(f.app.store.listBlocks(reader.data.user.id).blocks[0].id,blocked.blockId);assert.equal(f.app.store.feedRevision(reader.data.user.id),1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,2);
});

test('HTTP session expires exactly at its deadline and duplicate sensitive headers are rejected',async t=>{
  const f=await fixture(t),owner=await f.register('expiry_owner');f.advance(30*24*3600_000);
  assert.equal((await f.request('/api/session',{cookie:owner.cookie})).data.user,null);
  assert.equal((await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).status,401);
  const result=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port:f.app.server.address().port,path:'/api/state',headers:['Host','extras.test','Host','attacker.test']},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});assert.equal(result,400);
});

// Transport/authorization fixtures only. The codec is exercised with real files
// in audio-processing.test.mjs; this stub must never be enabled outside node:test.
const normalizedVoice=()=>({bytes:Buffer.concat([Buffer.from('OggS'),Buffer.alloc(40)]),durationMs:1000,contentType:'audio/ogg; codecs=opus'});
async function voiceFixture(t,options={}) {
  let calls=0;
  const f=await fixture(t,{voiceSocketPath:'/tmp/test-private-voice.sock',testVoiceProcessor:async()=>{calls++;return normalizedVoice();},...options});
  const owner=await f.register('voice_owner'),guest=await f.register('voice_guest'),other=await f.register('voice_other');
  const post=f.app.store.create(owner.data.user.id,input(),key()).post;
  const chat=f.app.store.contact(guest.data.user.id,post.id,{message:'Synthetic initial contact.'},key());
  const route=`/api/threads/${chat.threadId}/voice`;
  const send=(extra={})=>f.request(route,{method:'POST',cookie:owner.cookie,rawBody:Buffer.from('synthetic browser bytes'),headers:{'Content-Type':'audio/webm; codecs=opus','Idempotency-Key':key()},...extra});
  return {...f,owner,guest,other,post,chat,route,send,calls:()=>calls};
}

test('voice is disabled without an operator socket and cannot be switched on through request data',async t=>{
  const f=await fixture(t),user=await f.register('voice_disabled');
  assert.deepEqual((await f.request('/api/session')).data.features,{eventPlans:true});
  const r=await f.request('/api/threads/unknown/voice',{method:'POST',cookie:user.cookie,rawBody:'synthetic',headers:{'Content-Type':'audio/webm','Idempotency-Key':key(),'X-Voice-Socket':'/tmp/attacker.sock'}});
  assert.equal(r.status,404);assert.match(r.headers['permissions-policy'],/microphone=\(\)/);
});

test('voice HTTP stores once, serves only participants and never returns bytes in JSON',async t=>{
  const f=await voiceFixture(t),intent=key(),headers={'Content-Type':'audio/webm ; codecs=opus','Idempotency-Key':intent};
  assert.equal((await f.request('/api/session',{cookie:f.owner.cookie})).data.features.voice,true);
  const first=await f.send({headers});assert.equal(first.status,201,first.text);
  const again=await f.send({headers});assert.deepEqual(again.data,first.data);assert.equal(f.calls(),1);
  assert.equal((await f.send({headers,rawBody:Buffer.from('different source')})).status,409);assert.equal(f.calls(),1);
  const id=first.data.message.id;assert.equal(first.data.message.voice.id,id);assert.ok(!first.text.includes('OggS'));
  const audio=await f.request(`/api/voice/${id}`,{cookie:f.guest.cookie});
  assert.equal(audio.status,200);assert.deepEqual(audio.bytes,normalizedVoice().bytes);
  assert.equal(audio.headers['content-type'],'audio/ogg; codecs=opus');assert.equal(audio.headers['cache-control'],'no-store');
  assert.equal(audio.headers['cross-origin-resource-policy'],'same-origin');assert.equal(audio.headers['x-content-type-options'],'nosniff');
  assert.equal((await f.request(`/api/voice/${id}`)).status,401);
  assert.equal((await f.request(`/api/voice/${id}`,{cookie:f.other.cookie})).status,403);
  assert.equal((await f.request(`/api/voice/${id}`,{cookie:f.guest.cookie,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.ok(!(await f.request('/api/state')).text.includes(id));
});

test('voice upload checks identity, origin, block, encoding and size before calling the worker',async t=>{
  const f=await voiceFixture(t);
  assert.equal((await f.send({cookie:undefined})).status,401);
  assert.equal((await f.send({origin:false})).status,403);
  assert.equal((await f.send({cookie:f.other.cookie})).status,403);
  assert.equal((await f.send({headers:{'Content-Type':'text/plain','Idempotency-Key':key()}})).status,415);
  assert.equal((await f.send({headers:{'Content-Type':'audio/webm','Content-Encoding':'gzip','Idempotency-Key':key()}})).status,415);
  // The connection may close before a native client finishes writing its
  // oversized body. Either the 413 or the write reset is a refusal, never a
  // successful upload; the worker counter and next request verify this below.
  try {assert.equal((await f.send({rawBody:Buffer.alloc(5*1024*1024+1)})).status,413);}
  catch(error){assert.ok(['EPIPE','ECONNRESET'].includes(error.code),String(error));}
  assert.equal((await f.send({rawBody:Buffer.alloc(0)})).status,400);
  f.app.store.block(f.guest.data.user.id,f.chat.threadId);
  assert.equal((await f.send()).status,403);assert.equal(f.calls(),0);
});

test('voice upload rechecks the cookie after conversion instead of storing under a revoked session',async t=>{
  let release,entered;
  const started=new Promise(resolve=>entered=resolve);
  const f=await voiceFixture(t,{testVoiceProcessor:()=>{entered();return new Promise(resolve=>release=()=>resolve(normalizedVoice()));}});
  const pending=f.send();await started;
  try {assert.equal((await f.request('/api/auth/logout',{method:'POST',cookie:f.owner.cookie,body:{}})).status,200);}
  finally {release();}
  assert.equal((await pending).status,401);
  assert.equal(f.app.store.readThread(f.guest.data.user.id,f.chat.threadId).thread.messages.length,1);
});

test('voice conversion cannot cross a block, missing rules agreement, expiry or target removal while waiting',async t=>{
  for(const action of ['block','rules','expiry','remove']) {
    let release,entered;const started=new Promise(resolve=>entered=resolve);
    const f=await voiceFixture(t,{testVoiceProcessor:()=>{entered();return new Promise(resolve=>release=()=>resolve(normalizedVoice()));}});
    const pending=f.send();await started;
    try {
      if(action==='block')f.app.store.block(f.guest.data.user.id,f.chat.threadId);
      else if(action==='rules')f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(f.owner.data.user.id);
      else if(action==='expiry')f.advance(8*24*60*60_000);
      else f.app.store.remove(f.owner.data.user.id,f.post.id);
    } finally {release();}
    const response=await pending;
    assert.equal(response.status,['block','rules'].includes(action)?403:404);
    if(action==='rules')assert.equal(response.data.error,'rules_acceptance_required');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_messages WHERE text=\'\'').get().n,0);
  }
});

test('voice admits only one upload and releases the slot after a failed worker',async t=>{
  let release,entered,calls=0;const started=new Promise(resolve=>entered=resolve);
  const f=await voiceFixture(t,{testVoiceProcessor:async()=>{if(++calls===1){entered();await new Promise(resolve=>release=resolve);throw new Error('private worker diagnostics');}return normalizedVoice();}});
  const pending=f.send();await started;
  try {assert.equal((await f.send()).status,429);assert.equal(calls,1);}finally{release();}
  const failed=await pending;assert.equal(failed.status,500);assert.equal(failed.data.error,'internal_error');assert.ok(!failed.text.includes('diagnostics'));
  assert.equal((await f.send()).status,201);assert.equal(calls,2);
});

test('report voice playback stays moderator-only after removal and vanishes on account erasure',async t=>{
  const f=await voiceFixture(t),sent=await f.send();assert.equal(sent.status,201);
  const id=sent.data.message.id;f.app.store.moderators.add(f.owner.data.user.id);
  const report=f.app.store.report(f.guest.data.user.id,{targetType:'thread',targetId:f.chat.threadId,reason:'unsafe'},key());
  f.app.store.resolveReport(f.owner.data.user.id,report.id,'remove');
  const route=`/api/moderation/reports/${report.id}/voice/${id}`;
  assert.equal((await f.request(`/api/voice/${id}`,{cookie:f.guest.cookie})).status,404);
  assert.equal((await f.request(route,{cookie:f.guest.cookie})).status,403);
  const proof=await f.request(route,{cookie:f.owner.cookie});assert.equal(proof.status,200);assert.deepEqual(proof.bytes,normalizedVoice().bytes);
  assert.equal((await f.request('/api/account',{method:'DELETE',cookie:f.guest.cookie,body:{password:PASSWORD}})).status,204);
  assert.equal((await f.request(route,{cookie:f.owner.cookie})).status,404);
});

test('rules HTTP metadata identifies the exact served document and registration cannot bypass explicit agreement',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.request('/api/session')).data.rules,{...RULES,accepted:false});
  const document=await f.request(RULES.url);assert.equal(document.status,200);
  assert.equal(createHash('sha256').update(document.bytes).digest('hex'),RULES.sha256);
  assert.match(document.text,/Version 2026-08-28.2/);assert.match(document.text,/mentions de l’opérateur/);
  const head=await f.request(RULES.url,{method:'HEAD'});assert.equal(head.text,'');assert.equal(Number(head.headers['content-length']),document.bytes.length);
  for(const fields of [{},{acceptedRules:false,rulesVersion:RULES.version},{acceptedRules:'true',rulesVersion:RULES.version}]) {
    const denied=await f.request('/api/auth/register',{method:'POST',body:{username:'rules_register',password:PASSWORD,...fields}});
    assert.equal(denied.status,403);assert.equal(denied.data.error,'rules_acceptance_required');
  }
  assert.equal((await f.request('/api/auth/register',{method:'POST',body:{username:'rules_register',password:PASSWORD,acceptedRules:true,rulesVersion:'old'}})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,0);
  const registered=await f.register('rules_register');assert.deepEqual(registered.data.rules,{...RULES,accepted:true});
  assert.equal((await f.request('/api/account/rules-acceptance',{method:'POST',body:AGREEMENT})).status,401);
  assert.equal((await f.request('/api/account/rules-acceptance',{method:'POST',cookie:registered.cookie,body:AGREEMENT,origin:false})).status,403);
  assert.equal((await f.request('/api/account/rules-acceptance',{method:'POST',cookie:registered.cookie,body:{...AGREEMENT,userId:'other'}})).status,400);
});

test('encoded and repeated-slash rules paths serve the verified bytes, never a replaced disk document',async t=>{
  const publicDir=await mkdtemp(path.join(tmpdir(),'extras-rules-static-'));t.after(()=>rm(publicDir,{recursive:true,force:true}));
  await mkdir(path.join(publicDir,'rules'));
  for(const rule of RULE_DOCUMENTS)await writeFile(path.join(publicDir,rule.url.slice(1)),'Synthetic modified document, not approved.');
  const f=await fixture(t,{publicDir});
  for(const rule of RULE_DOCUMENTS)for(const pathname of [rule.url,rule.url.replace('/2026','/%32026'),rule.url.replace('/rules/','/rules//')]) {
    const response=await f.request(pathname);assert.equal(response.status,200);
    assert.equal(createHash('sha256').update(response.bytes).digest('hex'),rule.sha256);
  }
});

test('an unaccepted account keeps account, reading and safety access but cannot write UGC until agreement',async t=>{
  const f=await voiceFixture(t),voiceKey=key(),sent=await f.send({headers:{'Content-Type':'audio/webm','Idempotency-Key':voiceKey}});
  assert.equal(sent.status,201);
  f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id IN (?,?)').run(f.owner.data.user.id,f.guest.data.user.id);
  assert.equal((await f.request('/api/session',{cookie:f.owner.cookie})).data.rules.accepted,false);
  const login=await f.request('/api/auth/login',{method:'POST',body:{username:'voice_owner',password:PASSWORD}});assert.equal(login.status,200);assert.equal(login.data.rules.accepted,false);
  const recovery=await f.request('/api/auth/recover',{method:'POST',body:{recoveryCode:f.guest.data.recoveryCode,password:PASSWORD}});assert.equal(recovery.status,200);assert.equal(recovery.data.rules.accepted,false);f.guest.cookie=recovery.cookie;
  const post=`/api/posts/${f.post.id}`,thread=`/api/threads/${f.chat.threadId}`;
  for(const route of ['/api/state',post,thread,`/api/voice/${sent.data.message.id}`,'/api/blocks'])assert.equal((await f.request(route,{cookie:f.owner.cookie})).status,200);
  const denied=[
    await f.request('/api/posts',{method:'POST',cookie:f.owner.cookie,body:input(),headers:{'Idempotency-Key':key()}}),
    await f.request(post+'/contact',{method:'POST',cookie:f.guest.cookie,body:{message:'New synthetic contact.'},headers:{'Idempotency-Key':key()}}),
    await f.request(thread+'/messages',{method:'POST',cookie:f.owner.cookie,body:{message:'New synthetic message.'},headers:{'Idempotency-Key':key()}}),
    await f.send({headers:{'Content-Type':'audio/webm','Idempotency-Key':voiceKey}}),await f.send(),
  ];
  for(const response of denied){assert.equal(response.status,403);assert.equal(response.data.error,'rules_acceptance_required');}
  assert.equal(f.calls(),1);
  const report=await f.request('/api/reports',{method:'POST',cookie:f.guest.cookie,body:{targetType:'thread',targetId:f.chat.threadId,reason:'other'},headers:{'Idempotency-Key':key()}});assert.equal(report.status,201);
  const block=await f.request(post+'/block',{method:'POST',cookie:f.guest.cookie,body:{}});assert.equal(block.status,200);
  assert.equal((await f.request(`/api/blocks/${block.data.blockId}`,{method:'DELETE',cookie:f.guest.cookie})).status,200);
  for(const action of ['fill','close'])assert.equal((await f.request(post,{method:'PATCH',cookie:f.owner.cookie,body:{action},headers:{'Idempotency-Key':key()}})).status,200);
  assert.equal((await f.request(post,{method:'PATCH',cookie:f.owner.cookie,body:{action:'reopen'},headers:{'Idempotency-Key':key()}})).data.error,'rules_acceptance_required');
  const publicBefore=f.app.store.state().version,privateBefore=f.app.store.feedRevision(f.owner.data.user.id),events=[];
  f.app.store.subscribe(()=>events.push('public'));f.app.store.subscribePrivate(()=>events.push('private'));
  const accepted=await f.request('/api/account/rules-acceptance',{method:'POST',cookie:f.owner.cookie,body:AGREEMENT});assert.deepEqual(accepted.data,{rules:{...RULES,accepted:true}});
  const first=f.db.prepare('SELECT accepted_at FROM auth_rule_acceptances WHERE user_id=?').get(f.owner.data.user.id).accepted_at;
  f.advance(1000);assert.equal((await f.request('/api/account/rules-acceptance',{method:'POST',cookie:f.owner.cookie,body:AGREEMENT})).status,200);
  assert.equal(f.db.prepare('SELECT accepted_at FROM auth_rule_acceptances WHERE user_id=?').get(f.owner.data.user.id).accepted_at,first);
  assert.equal(f.app.store.state().version,publicBefore);assert.equal(f.app.store.feedRevision(f.owner.data.user.id),privateBefore);assert.deepEqual(events,[]);
  assert.equal((await f.request(post,{method:'PATCH',cookie:f.owner.cookie,body:{action:'reopen'},headers:{'Idempotency-Key':key()}})).status,200);
  assert.equal((await f.request(thread+'/messages',{method:'POST',cookie:f.owner.cookie,body:{message:'Explicitly sent after agreement.'},headers:{'Idempotency-Key':key()}})).status,201);
  f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(f.owner.data.user.id);
  assert.equal((await f.request(post,{method:'DELETE',cookie:f.owner.cookie})).status,204);
  assert.equal((await f.request('/api/account',{method:'DELETE',cookie:f.guest.cookie,body:{password:PASSWORD}})).status,204);
});

async function presentationFixture(t,options={}) {
 let calls=0;
 const f=await fixture(t,{presentationSocketPath:'/tmp/test-presentation.sock',testPresentationProcessor:async()=>{calls++;return presentationPhoto();},...options});
 const owner=await f.register('presentation_owner'),reader=await f.register('presentation_reader');
 const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
 const send=(extra={})=>f.request('/api/presentation/photo',{method:'PUT',cookie:owner.cookie,rawBody:'synthetic image source',headers:{'Content-Type':'image/jpeg','X-Presentation-Revision':'0','Idempotency-Key':key()},...extra});
 return {...f,owner,reader,post,send,calls:()=>calls};
}

test('presentation feature is absent by default and requires an operator socket, not a client flag',async t=>{
 const f=await fixture(t),owner=await f.register('presentation_disabled');
 assert.deepEqual((await f.request('/api/session')).data.features,{eventPlans:true});
 for(const method of ['GET','PUT','DELETE'])assert.equal((await f.request('/api/presentation',{method,cookie:owner.cookie,headers:{'X-Presentation-Socket':'/tmp/untrusted'}})).status,404);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='app_presentations'").get().n,0);
});

test('presentation HTTP keeps drafts private, publishes deliberately, serves versioned ranges and hides closed posts',async t=>{
 const f=await presentationFixture(t),route=`/api/posts/${f.post.id}/presentation`;
 assert.equal((await f.request('/api/session',{cookie:f.owner.cookie})).data.features.presentation,true);
 assert.equal((await f.request('/api/presentation')).status,401);
 const intent=key(),headers={'Content-Type':'image/jpeg','X-Presentation-Revision':'0','Idempotency-Key':intent};
 const uploaded=await f.send({headers});assert.equal(uploaded.status,201,uploaded.text);assert.equal(f.calls(),1);
 assert.deepEqual((await f.send({headers})).data,uploaded.data);assert.equal(f.calls(),1);
 assert.equal((await f.request(route)).status,404);assert.equal((await f.request('/api/state')).data.posts[0].presentationId,undefined);
 assert.equal((await f.request('/api/presentation/photo?revision=1',{cookie:f.reader.cookie})).status,404);
 const own=await f.request('/api/presentation/photo?revision=1',{cookie:f.owner.cookie});assert.deepEqual(own.bytes,presentationPhoto().bytes);
 assert.equal((await f.request('/api/presentation/publish',{method:'POST',cookie:f.owner.cookie,body:{expectedRevision:1}})).status,400);
 const published=await f.request('/api/presentation/publish',{method:'POST',cookie:f.owner.cookie,body:{expectedRevision:1,publicConsent:true}});assert.equal(published.status,200);
 const version=published.data.publicationId;assert.equal((await f.request('/api/state')).data.posts[0].presentationId,version);
 const publicData=(await f.request(route)).data;assert.equal(publicData.publicationId,version);assert.ok(!JSON.stringify(publicData).includes(f.owner.data.user.id));
 const media=`${route}/photo?v=${version}`,range=await f.request(media,{headers:{Range:'bytes=2-4'}});assert.equal(range.status,206);assert.deepEqual(range.bytes,presentationPhoto().bytes.subarray(2,5));assert.equal(range.headers['cache-control'],'no-store');
 assert.equal((await f.request(media,{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await f.request(`${route}/photo?v=old`)).status,404);
 assert.equal((await f.request('/api/presentation/photo?revision=1',{cookie:f.owner.cookie})).status,404);
 await f.request(`/api/posts/${f.post.id}/block`,{method:'POST',cookie:f.reader.cookie,body:{}});
 assert.equal((await f.request(media,{cookie:f.reader.cookie})).status,404);assert.equal((await f.request(media)).status,200);
 await f.request(`/api/posts/${f.post.id}`,{method:'PATCH',cookie:f.owner.cookie,body:{action:'close'},headers:{'Idempotency-Key':key()}});
 assert.equal((await f.request(media)).status,404);assert.equal((await f.request(route)).status,404);
});

test('presentation conversion cannot store after logout, erasure, rules withdrawal or account deletion',async t=>{
 for(const action of ['logout','erase','rules','delete']) {
  let entered,release;const started=new Promise(resolve=>entered=resolve);
  const f=await presentationFixture(t,{testPresentationProcessor:()=>{entered();return new Promise(resolve=>release=()=>resolve(presentationPhoto()));}});
  const pending=f.send();await started;
  try {
   if(action==='logout')await f.request('/api/auth/logout',{method:'POST',cookie:f.owner.cookie,body:{}});
   if(action==='erase')await f.request('/api/presentation',{method:'DELETE',cookie:f.owner.cookie,body:{expectedRevision:0}});
   if(action==='rules')f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(f.owner.data.user.id);
   if(action==='delete')await f.request('/api/account',{method:'DELETE',cookie:f.owner.cookie,body:{password:PASSWORD}});
  }finally{release();}
  assert.equal((await pending).status,action==='erase'?409:action==='rules'?403:401);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,0);
 }
});

test('presentation admission and early authorization reject extra uploads without calling the processor',async t=>{
 let entered,release,calls=0;const started=new Promise(resolve=>entered=resolve);
 const f=await presentationFixture(t,{testPresentationProcessor:async()=>{if(++calls===1){entered();await new Promise(resolve=>release=resolve);}return presentationPhoto();}});
 assert.equal((await f.send({cookie:undefined})).status,401);assert.equal((await f.send({origin:false})).status,403);
 assert.equal((await f.send({headers:{'Content-Type':'image/jpeg','X-Presentation-Revision':'-1','Idempotency-Key':key()}})).status,400);assert.equal(calls,0);
 const pending=f.send();await started;try{assert.equal((await f.send()).status,429);assert.equal(calls,1);}finally{release();}
 assert.equal((await pending).status,201);
});

test('database overflow rolls back media and its retry record, reports capacity, and preserves existing accounts',async t=>{
 const bytes=Buffer.alloc(1024**2,1);bytes.writeUInt16BE(0xffd8,0);bytes.writeUInt16BE(0xffd9,bytes.length-2);
 const f=await presentationFixture(t,{testPresentationProcessor:async()=>({...presentationPhoto(),bytes})});
 const pages=f.db.prepare('PRAGMA page_count').get().page_count;f.db.exec(`PRAGMA max_page_count=${pages+4}`);
 const refused=await f.send();assert.equal(refused.status,503);assert.equal(refused.data.error,'storage_capacity_reached');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_presentation_intents').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,2);assert.equal(f.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.equal((await f.request(`/api/posts/${f.post.id}`,{cookie:f.owner.cookie})).status,200);
});

test('presentation report media stay moderator-only, and account deletion erases their retained copies',async t=>{
 const f=await presentationFixture(t);await f.send();
 const publicationId=(await f.request('/api/presentation/publish',{method:'POST',cookie:f.owner.cookie,body:{expectedRevision:1,publicConsent:true}})).data.publicationId;
 const report=await f.request('/api/reports',{method:'POST',cookie:f.reader.cookie,body:{targetType:'post',targetId:f.post.id,reason:'unsafe',presentationId:publicationId},headers:{'Idempotency-Key':key()}});assert.equal(report.status,201);
 const route=`/api/moderation/reports/${report.data.id}/presentation/photo`;
 assert.equal((await f.request(route,{cookie:f.reader.cookie})).status,403);f.app.store.moderators.add(f.reader.data.user.id);
 assert.equal((await f.request(route,{cookie:f.reader.cookie})).status,200);
 const resolved=await f.request(`/api/moderation/reports/${report.data.id}`,{method:'POST',cookie:f.reader.cookie,body:{action:'remove-presentation'}});assert.equal(resolved.status,200);
 assert.equal((await f.request(`/api/posts/${f.post.id}/presentation`)).status,404);
 assert.equal((await f.request(route,{cookie:f.reader.cookie})).status,200);
 await f.request('/api/account',{method:'DELETE',cookie:f.owner.cookie,body:{password:PASSWORD}});
 assert.equal((await f.request(route,{cookie:f.reader.cookie})).status,404);
});

test('real photo/video cross HTTP and the Unix worker, then encrypted backup restores published, draft and report media',async t=>{
 if(!['ffmpeg','ffprobe'].every(binary=>spawnSync(binary,['-version'],{timeout:3000,stdio:'ignore'}).status===0)){t.skip('Existing FFmpeg unavailable; no installation attempted');return;}
 const directory=await mkdtemp('/tmp/tse-media-e2e-'),socketPath=path.join(directory,'worker.sock'),databasePath=path.join(directory,'source.sqlite');
 const execute=promisify(execFile),photoPath=path.join(directory,'source.png'),videoPath=path.join(directory,'source.mp4');
 const worker=createPresentationWorker({normalizePhoto:createImageNormalizer({tempRoot:directory}),normalizeVideo:createVideoNormalizer({tempRoot:directory})});
 await new Promise(resolve=>worker.listen(socketPath,resolve));
 const f=await fixture(t,{databasePath,presentationSocketPath:socketPath,sweepIntervalMs:60000,heartbeatIntervalMs:60000});
 // Close the application before removing its private directory, independently
 // of native test hook ordering; fixture.close is deliberately idempotent.
 t.after(async()=>{await f.app.close();worker.closeAllConnections();await new Promise(resolve=>worker.close(resolve));if(f.db.isOpen)f.db.close();await rm(directory,{recursive:true,force:true});});
 await execute('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=lime:s=80x40','-frames:v','1','-threads','1','-metadata','comment=SYNTHETIC_PRIVATE_SOURCE',photoPath],{timeout:10000,maxBuffer:32768});
 await execute('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','testsrc2=size=80x40:rate=30:duration=0.4','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.4','-c:v','libx264','-threads','1','-preset','ultrafast','-bf','0','-pix_fmt','yuv420p','-c:a','aac','-metadata','comment=SYNTHETIC_PRIVATE_SOURCE',videoPath],{timeout:10000,maxBuffer:32768});
 const owner=await f.register('real_media_owner'),reader=await f.register('real_media_reader'),sourcePhoto=await readFile(photoPath),sourceVideo=await readFile(videoPath);
 const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
 async function send(kind,bytes,type,revision){const r=await f.request(`/api/presentation/${kind}`,{method:'PUT',cookie:owner.cookie,rawBody:bytes,headers:{'Content-Type':type,'X-Presentation-Revision':String(revision),'Idempotency-Key':key()}});assert.equal(r.status,201,r.text);return r.data.presentation;}
 await send('photo',sourcePhoto,'image/png',0);await send('video',sourceVideo,'video/mp4',1);
 const saved=await f.request('/api/presentation',{method:'PATCH',cookie:owner.cookie,body:{expectedRevision:2,bio:'Présentation synthétique.',videoText:'Motif abstrait et son synthétique.'}});assert.equal(saved.status,200);
 const publication=await f.request('/api/presentation/publish',{method:'POST',cookie:owner.cookie,body:{expectedRevision:3,publicConsent:true}});assert.equal(publication.status,200);
 const publicVideo=await f.request(`/api/posts/${post.id}/presentation/video?v=${publication.data.publicationId}`);assert.equal(publicVideo.status,200);assert.ok(!publicVideo.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE_SOURCE')));
 const publicPhoto=await f.request(`/api/posts/${post.id}/presentation/photo?v=${publication.data.publicationId}`);assert.equal(publicPhoto.headers['content-type'],'image/jpeg');
 await send('photo',sourcePhoto,'image/png',4); // Distinct private replacement; published references remain intact.
 const reported=await f.request('/api/reports',{method:'POST',cookie:reader.cookie,body:{targetType:'post',targetId:post.id,reason:'other',presentationId:publication.data.publicationId},headers:{'Idempotency-Key':key()}});assert.equal(reported.status,201);
 const snapshot=path.join(directory,'snapshot.sqlite'),encrypted=path.join(directory,'snapshot.tseb'),restoredPath=path.join(directory,'restored.sqlite');
 await createBackup(databasePath,snapshot);const encryptionKey=await backupKey(path.join(directory,'key'),{create:true});
 try{await encryptBackup(snapshot,encrypted,encryptionKey);await decryptBackup(encrypted,restoredPath,encryptionKey);}finally{encryptionKey.fill(0);}
 // Erase only the synthetic live account, then prove the isolated point still
 // contains its older version and explicitly replay its post-snapshot erasure.
 assert.equal((await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}})).status,204);
 const restored=openDatabase(restoredPath);
 try {
  const auth=new AuthService({db:restored}),store=new ProductionStore({db:restored,clock:()=>1800000000000,moderators:[reader.data.user.id],hasAcceptedRules:id=>auth.hasAcceptedRules(id)}),presentations=new PresentationStore({db:restored,store,clock:()=>1800000000000});
  assert.equal(presentations.own(owner.data.user.id).revision,5);assert.equal(restored.prepare('SELECT COUNT(*) n FROM app_presentation_assets').get().n,3);
  assert.deepEqual(presentations.assetForPost(post.id,'video').bytes,publicVideo.bytes);assert.deepEqual(presentations.assetForPost(post.id,'photo').bytes,publicPhoto.bytes);
  assert.deepEqual(presentations.reportAsset(reader.data.user.id,reported.data.id,'video').bytes,publicVideo.bytes);
  store.transaction(()=>{store.eraseAccountData(owner.data.user.id);auth.deleteAccount(owner.data.user.id);});
  for(const table of ['app_presentations','app_presentation_assets','app_presentation_intents','app_report_presentations','app_report_presentation_assets'])assert.equal(restored.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{restored.close();}
});

async function journalFixture(t,options={}) {
 const dir=await mkdtemp(path.join(tmpdir(),'social-http-erasure-')),databasePath=path.join(dir,'app.sqlite'),journalFile=path.join(dir,'journal.sqlite');
 const bootstrap=openDatabase(databasePath);
 try{new AuthService({db:bootstrap,testKdf});new ProductionStore({db:bootstrap});initializeErasureJournal({db:bootstrap,filename:journalFile});}finally{bootstrap.close();}
 const journal=new ErasureJournal(journalFile);
 const f=await fixture(t,{databasePath,erasureJournal:journal,...options});
 t.after(async()=>{journal.close();await rm(dir,{recursive:true,force:true});});
 return {...f,journal,journalFile};
}

test('HTTP account deletion records the independent intent before acknowledging the app checkpoint',async t=>{
 const f=await journalFixture(t),owner=await f.register('journal_http_owner');
 await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}});
 const result=await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}});
 assert.equal(result.status,204);assert.equal(f.journal.tip().seq,1);
 const checkpoint=f.db.prepare('SELECT seq,hash FROM app_erasure_checkpoint').get();
 assert.equal(checkpoint.seq,1);assert.equal(checkpoint.hash,f.journal.tip().hash);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_posts').get().n,0);
 assert.throws(()=>createProductionServer({db:f.db,publicOrigin:'https://extras.test',authOptions:{testKdf}}),/erasure_journal_required/);
});

test('an app failure after durable erasure intent closes feeds and APIs, then startup replays before listening',async t=>{
 const f=await journalFixture(t),owner=await f.register('pending_erasure_owner');
 await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}});
 const stream=await f.stream();assert.equal((await stream.next()).event,'state');
 f.db.exec("CREATE TRIGGER fail_erasure BEFORE DELETE ON auth_users BEGIN SELECT RAISE(ABORT,'synthetic erasure failure'); END;");
 const failed=await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}});
 assert.equal(failed.status,503);assert.equal(failed.data.error,'account_erasure_pending');
 assert.equal((await stream.next()).event,'unavailable');
 assert.equal(f.journal.tip().seq,1);assert.equal(f.db.prepare('SELECT seq FROM app_erasure_checkpoint').get().seq,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);
 for(const url of ['/api/session','/api/state','/api/roles'])assert.equal((await f.request(url,{cookie:owner.cookie})).status,503);
 assert.equal((await f.request('/api/auth/register',{method:'POST',body:{username:'forbidden_pending',password:PASSWORD,...AGREEMENT}})).status,503);
 await f.app.close();f.db.exec('DROP TRIGGER fail_erasure');
 const restarted=createProductionServer({db:f.db,publicOrigin:'https://extras.test',authOptions:{testKdf},erasureJournal:f.journal});
 try{assert.equal(restarted.server.listening,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_posts').get().n,0);assert.equal(f.db.prepare('SELECT seq FROM app_erasure_checkpoint').get().seq,1);}
 finally{await restarted.close();}
});

test('HTTP KDF already in flight cannot create a new account after the erasure guard closes',async t=>{
 let release,started;
 const waiting=new Promise(resolve=>started=resolve);
 const held='synthetic registration blocked in KDF';
 const f=await journalFixture(t,{authOptions:{testKdf:async(password,salt)=>{
  if(password===held){started();await new Promise(resolve=>release=resolve);}return testKdf(password,salt);
 }}}),owner=await f.register('parallel_erasure_owner');
 const pending=f.request('/api/auth/register',{method:'POST',body:{username:'parallel_new_user',password:held,...AGREEMENT}});
 await waiting;
 try {
  f.db.exec("CREATE TRIGGER fail_erasure BEFORE DELETE ON auth_users BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  assert.equal((await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}})).status,503);
 }finally{release();}
 assert.equal((await pending).status,503);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,1);
});

test('logout during deletion password verification prevents both the journal intent and erasure',async t=>{
 let hold=false,release,started;
 const waiting=new Promise(resolve=>started=resolve);
 const f=await journalFixture(t,{authOptions:{testKdf:async(password,salt)=>{
  if(hold){started();await new Promise(resolve=>release=resolve);}return testKdf(password,salt);
 }}}),owner=await f.register('logout_erasure_owner');hold=true;
 const pending=f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}});
 await waiting;
 try{assert.equal((await f.request('/api/auth/logout',{method:'POST',cookie:owner.cookie,body:{}})).status,200);}finally{release();}
 assert.equal((await pending).status,401);assert.equal(f.journal.tip().seq,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);
});

test('ambiguous journal return and checkpoint failure both preserve the intent and fail closed',async t=>{
 for(const kind of ['journal-return','checkpoint']) {
  const f=await journalFixture(t),owner=await f.register('ambiguous_'+kind.replace('-','_'));
  await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}});
  const append=f.journal.append.bind(f.journal);
  if(kind==='journal-return')f.journal.append=(...args)=>{append(...args);throw Error('synthetic after durable commit');};
  else f.db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON app_erasure_checkpoint BEGIN SELECT RAISE(ABORT,'synthetic checkpoint failure'); END;");
  const failed=await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}});
  assert.equal(failed.status,503);assert.equal(f.journal.tip().seq,1);
  assert.equal(f.db.prepare('SELECT seq FROM app_erasure_checkpoint').get().seq,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_posts').get().n,1);
  assert.equal((await f.request('/api/state')).status,503);
  await f.app.close();f.journal.append=append;
  if(kind==='checkpoint')f.db.exec('DROP TRIGGER fail_checkpoint');
  const restarted=createProductionServer({db:f.db,publicOrigin:'https://extras.test',authOptions:{testKdf},erasureJournal:f.journal});
  try{assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_users').get().n,0);assert.equal(f.db.prepare('SELECT seq FROM app_erasure_checkpoint').get().seq,1);}finally{await restarted.close();}
 }
});

test('a slow HTTP body cannot write after a concurrent erasure failure places the service in maintenance',async t=>{
 for(const route of ['/api/posts','/api/event-plans']) {
 const f=await journalFixture(t),owner=await f.register('slow_erasure_owner'),writer=await f.register('slow_erasure_writer');
 const payload=JSON.stringify(route==='/api/posts'?input():eventPlanInput());let pending;
 const response=new Promise((resolve,reject)=>{
  pending=http.request({hostname:'127.0.0.1',port:f.app.server.address().port,path:route,method:'POST',headers:{Host:'extras.test',Origin:'https://extras.test',Cookie:writer.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'Idempotency-Key':key()}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});pending.on('error',reject);pending.write(payload.slice(0,1));
 });
 // An ordinary round trip leaves the partial body pending in the same listener.
 assert.equal((await f.request('/api/session',{cookie:writer.cookie})).status,200);
 f.db.exec("CREATE TRIGGER fail_erasure BEFORE DELETE ON auth_users BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
 assert.equal((await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}})).status,503);
 pending.end(payload.slice(1));assert.equal(await response,503);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_posts').get().n,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n,0);
 }
});

test('event plan HTTP routes remain private, preserve revisions and do not publish into the live feed',async t=>{
 const f=await fixture(t,{clock:()=>Date.UTC(2026,7,28)}),owner=await f.register('plan_owner'),other=await f.register('plan_other'),draft=eventPlanInput();
 const create=()=>f.request('/api/event-plans',{method:'POST',cookie:owner.cookie,body:draft});
 assert.equal((await f.request('/api/event-plans')).status,401);
 assert.equal((await f.request('/api/event-plans',{method:'POST',body:draft})).status,401);
 const first=await create();assert.equal(first.status,201,JSON.stringify(first.data));
 assert.equal(first.headers['cache-control'],'no-store');assert.equal(first.data.plan.visibility,'private');
 assert.deepEqual(first.data.plan.totals,{quantity:3,confirmed:1,remaining:2});
 const replay=await create();assert.equal(replay.status,200);assert.equal(replay.data.replayed,true);
 const url=`/api/event-plans/${draft.id}`,{id,...values}=draft;
 assert.deepEqual((await f.request('/api/event-plans',{cookie:other.cookie})).data,{plans:[]});
 for(const method of ['GET','PATCH','DELETE']) {
  const r=await f.request(url,{method,cookie:other.cookie,...(method==='PATCH'?{body:{expectedRevision:1,...values}}:method==='DELETE'?{body:{expectedRevision:1}}:{})});
  assert.equal(r.status,404,JSON.stringify(r.data));
 }
 const update=await f.request(url,{method:'PATCH',cookie:owner.cookie,body:{expectedRevision:1,...values,needs:[{...draft.needs[0],confirmed:3}]}});
 assert.equal(update.status,200);assert.equal(update.data.plan.revision,2);assert.equal(update.data.plan.totals.remaining,0);
 assert.equal((await f.request(url,{method:'PATCH',cookie:owner.cookie,body:{expectedRevision:1,...values}})).status,409);
 assert.equal((await f.request(url+'?owner=anything',{cookie:owner.cookie})).status,400);
 assert.equal((await f.request(url,{method:'POST',cookie:owner.cookie,body:{}})).status,405);
 assert.equal((await f.request('/api/state')).data.posts.length,0);
 assert.equal((await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}})).status,204);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n,0);
});

test('event plan rules guard applies to saves, never to reading or erasing, and deletion cannot be replayed into creation',async t=>{
 const f=await fixture(t,{clock:()=>Date.UTC(2026,7,28)}),owner=await f.register('plan_rules'),draft=eventPlanInput(),cookie=owner.cookie;
 assert.equal((await f.request('/api/event-plans',{method:'POST',cookie,body:draft})).status,201);
 const url=`/api/event-plans/${draft.id}`,{id,...values}=draft;
 f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(owner.data.user.id);
 for(const [route,method,body] of [['/api/event-plans','POST',eventPlanInput()],[url,'PATCH',{expectedRevision:1,...values}]]) {
  const denied=await f.request(route,{method,cookie,body});assert.equal(denied.status,403);assert.equal(denied.data.error,'rules_acceptance_required');
 }
 assert.equal((await f.request(url,{cookie})).status,200);
 assert.equal((await f.request(url,{method:'DELETE',cookie,body:{expectedRevision:1}})).status,200);
 assert.equal((await f.request(url,{method:'DELETE',cookie,body:{expectedRevision:1}})).status,200);
 assert.deepEqual((await f.request('/api/event-plans',{cookie})).data,{plans:[]});
 await f.request('/api/account/rules-acceptance',{method:'POST',cookie,body:AGREEMENT});
 assert.equal((await f.request('/api/event-plans',{method:'POST',cookie,body:draft})).status,410);
 assert.equal(f.db.prepare('SELECT data FROM app_event_plans').get().data,null);
});

test('only structured event saves accept the bounded 64 KiB envelope; normal routes retain 8 KiB',async t=>{
 const f=await fixture(t,{clock:()=>Date.UTC(2026,7,28)}),owner=await f.register('plan_bytes'),draft=eventPlanInput(),cookie=owner.cookie;
 draft.needs=Array.from({length:12},()=>({...draft.needs[0],id:key(),skills:'é'.repeat(180),overrides:{attire:'é'.repeat(120),equipment:'é'.repeat(120),arrival:'é'.repeat(120)}}));
 const bytes=Buffer.byteLength(JSON.stringify(draft));assert.ok(bytes>8192&&bytes<32768);
 assert.equal((await f.request('/api/event-plans',{method:'POST',cookie,body:draft})).status,201);
 assert.equal((await f.request('/api/event-plans',{method:'POST',cookie,rawBody:JSON.stringify(draft)+' '.repeat(65536)})).status,413);
 assert.equal((await f.request('/api/auth/logout',{method:'POST',cookie,rawBody:'{}'+' '.repeat(8192)})).status,413);
 const {id,...values}=draft;
 assert.equal((await f.request(`/api/event-plans/${id}`,{method:'PATCH',cookie,body:{expectedRevision:1,...values}})).status,200);
});

test('event plan save rechecks rules after a partial request body',async t=>{
 const f=await fixture(t,{clock:()=>Date.UTC(2026,7,28)}),owner=await f.register('plan_slow_rules'),payload=JSON.stringify(eventPlanInput());let pending;
 const accepted=new Promise(resolve=>f.app.server.once('request',resolve));
 const response=new Promise((resolve,reject)=>{
  pending=http.request({hostname:'127.0.0.1',port:f.app.server.address().port,path:'/api/event-plans',method:'POST',headers:{Host:'extras.test',Origin:'https://extras.test',Cookie:owner.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});pending.on('error',reject);pending.write(payload.slice(0,1));
 });
 await accepted;f.db.prepare('DELETE FROM auth_rule_acceptances WHERE user_id=?').run(owner.data.user.id);
 pending.end(payload.slice(1));assert.equal(await response,403);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n,0);
});


test('event publication retries honor the original deadline over real authenticated HTTP', async t => {
  for(const scenario of ['never-sent','already-committed','delayed-before-deadline']) await t.test(scenario,async t=>{
    let now=Date.UTC(2026,7,28);
    const f=await fixture(t,{clock:()=>now}), account=await f.register('deadline_fixture');
    const planResponse=await f.request('/api/event-plans',{method:'POST',cookie:account.cookie,body:eventPlanInput()});
    assert.equal(planResponse.status,201);
    const plan=planResponse.data.plan, originalEnd=plan.endsAt, calls=[];
    let firstPost=null, keys=0;
    const state=new EventPostPreviewState({role:'Serveur',cityLabel:'Paris',remaining:2,
      derive:options=>prepareEventPost(plan,plan.needs[0].id,{...options,now,roles:ROLES}),
      makeKey:()=>{keys++;return key();},
      send:async args=>{
        calls.push(structuredClone(args));
        if(calls.length===1&&scenario!=='already-committed')throw Error('synthetic network interruption');
        const response=await f.request('/api/posts',{method:'POST',cookie:account.cookie,body:args.draft,headers:{'Idempotency-Key':args.key}});
        if(response.status>=400)throw Object.assign(Error(response.data.error),{status:response.status,code:response.data.error});
        if(calls.length===1){firstPost=response.data.post;throw Error('synthetic lost success response');}
        return response.data;
      },
    });
    assert.equal(await state.publish(),false);assert.equal(state.snapshot().phase,'uncertain');
    now=scenario==='delayed-before-deadline'?originalEnd-10*60_000:originalEnd;
    plan.endsAt+=24*60*60_000;
    const result=await state.publish();
    assert.equal(calls.length,2);assert.equal(keys,1);
    assert.equal(calls[1].key,calls[0].key);assert.deepEqual(calls[1].draft,calls[0].draft);
    assert.equal(calls[1].draft.notAfter,originalEnd);
    assert.equal(calls[1].retry,true);
    assert.equal(await state.publish(),false);assert.equal(calls.length,2);
    if(scenario==='delayed-before-deadline'){
      assert.equal(result,true);assert.equal(state.snapshot().phase,'success');
      const post=(await f.request('/api/posts/'+state.snapshot().postId)).data.post;
      assert.equal(post.expiresAt,originalEnd);assert.equal(Object.hasOwn(post,'notAfter'),false);
    }else{
      assert.equal(result,false);assert.equal(state.snapshot().phase,'expired');
      assert.equal(state.snapshot().errorCode,scenario==='never-sent'?'post_deadline_elapsed':'post_expired');
      const html=renderEventPostPreview(state.snapshot());
      assert.match(html,/Cette tentative est terminée/);assert.doesNotMatch(html,/data-preview-action="retry"|type="submit"/);
      assert.equal(state.edit({places:1}),false);
      const rows=f.db.prepare('SELECT id FROM app_posts').all();
      assert.deepEqual(rows.map(row=>row.id),firstPost?[firstPost.id]:[]);
      assert.equal((await f.request('/api/state')).data.posts.length,0);
    }
    assert.equal((await f.request('/api/event-plans/'+plan.id,{cookie:account.cookie})).data.plan.totals.confirmed,1);
  });
});
