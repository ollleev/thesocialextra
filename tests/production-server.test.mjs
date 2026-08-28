import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {openDatabase} from '../database.mjs';
import {createProductionServer} from '../production-server.mjs';

const PASSWORD='synthetic password sufficiently long';
const testKdf=async(password,salt)=>createHash('sha512').update(password).update(salt).digest();
const input=(extra={})=>({kind:'need',role:'Barman',cityId:'2988507',english:false,vehicle:false,durationMinutes:30,places:2,note:'Synthétique.',...extra});
const key=()=>randomUUID();
async function fixture(t,options={}) {
  const db=openDatabase(':memory:');let now=1_800_000_000_000;
  const publicOrigin=options.publicOrigin??'https://extras.test';
  const app=createProductionServer({db,publicOrigin,clock:()=>now,authOptions:{testKdf},sweepIntervalMs:20,heartbeatIntervalMs:20,...options});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.close();db.close();});
  const port=app.server.address().port;
  function request(url, {method='GET',body,cookie,headers={},rawBody,origin=true}={}) {
    const payload=rawBody??(body===undefined?undefined:JSON.stringify(body));
    const all={Host:new URL(publicOrigin).host,...(method!=='GET'&&method!=='HEAD'&&origin?{Origin:publicOrigin}:{}),...(cookie?{Cookie:cookie}:{}),...(payload!==undefined?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}:{}),...headers};
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port,path:url,method,headers:all},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>{const bytes=Buffer.concat(chunks),text=bytes.toString();let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,bytes,text,data,cookie:res.headers['set-cookie']?.[0]?.split(';')[0]});});});
      req.on('error',reject);req.end(payload);
    });
  }
  async function register(username) {const r=await request('/api/auth/register',{method:'POST',body:{username,password:PASSWORD}});assert.equal(r.status,201,JSON.stringify(r.data));return r;}
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

test('cookie-only sessions expose no tokens, validate strictly, and enforce origin and host',async t=>{
  const f=await fixture(t),r=await f.register('COOKIE_USER');
  assert.deepEqual(Object.keys(r.data).sort(),['recoveryCode','user']);assert.equal(r.data.user.username,'cookie_user');
  assert.match(r.headers['set-cookie'][0],/^__Host-extra_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  assert.equal(r.headers['strict-transport-security'],'max-age=31536000');
  const session=await f.request('/api/session',{cookie:r.cookie});
  assert.deepEqual(session.data,{mode:'production',user:r.data.user,ownership:[],moderator:false});
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
  const f=await fixture(t),owner=await f.register('slow_owner'),payload=JSON.stringify(input());
  let pending;
  const accepted=new Promise(resolve=>f.app.server.once('request',resolve));
  const response=new Promise((resolve,reject)=>{
    pending=http.request({hostname:'127.0.0.1',port:f.app.server.address().port,path:'/api/posts',method:'POST',headers:{Host:'extras.test',Origin:'https://extras.test',Cookie:owner.cookie,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload),'Idempotency-Key':key()}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});pending.on('error',reject);pending.write(payload.slice(0,1));
  });
  await accepted;
  await f.request('/api/auth/logout',{method:'POST',cookie:owner.cookie,body:{}});
  pending.end(payload.slice(1));assert.equal(await response,401);assert.equal(f.app.store.state().posts.length,0);
});

test('failed account cleanup rolls back business and auth data, and emits no state change',async t=>{
  const f=await fixture(t),owner=await f.register('rollback_owner');
  const post=(await f.request('/api/posts',{method:'POST',cookie:owner.cookie,body:input(),headers:{'Idempotency-Key':key()}})).data.post;
  const before=f.app.store.state().version;let events=0;f.app.store.subscribe(()=>events++);
  f.db.exec("CREATE TRIGGER fail_auth_delete BEFORE DELETE ON auth_users BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;");
  const result=await f.request('/api/account',{method:'DELETE',cookie:owner.cookie,body:{password:PASSWORD}});
  assert.equal(result.status,500);assert.equal(result.data.error,'internal_error');assert.ok(!result.text.includes('synthetic rollback'));
  assert.equal((await f.request('/api/session',{cookie:owner.cookie})).data.user.id,owner.data.user.id);
  assert.equal((await f.request(`/api/posts/${post.id}`)).status,200);assert.equal(f.app.store.state().version,before);assert.equal(events,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_sessions').get().n,1);
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
  assert.equal((await f.request('/api/session')).data.features,undefined);
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

test('voice conversion cannot cross a block, expiry or target removal that happened while waiting',async t=>{
  for(const action of ['block','expiry','remove']) {
    let release,entered;const started=new Promise(resolve=>entered=resolve);
    const f=await voiceFixture(t,{testVoiceProcessor:()=>{entered();return new Promise(resolve=>release=()=>resolve(normalizedVoice()));}});
    const pending=f.send();await started;
    try {
      if(action==='block')f.app.store.block(f.guest.data.user.id,f.chat.threadId);
      else if(action==='expiry')f.advance(8*24*60*60_000);
      else f.app.store.remove(f.owner.data.user.id,f.post.id);
    } finally {release();}
    assert.equal((await pending).status,action==='block'?403:404);
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
