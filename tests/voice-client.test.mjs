import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { VoiceComposer, uploadVoice } from '../public/voice.js';
import { mergeSummary, freshPost, markRead } from '../public/updates.js';

function fixture(options = {}) {
  let requests = 0, stopped = 0, time = 0, tick, instance, keys = 0;
  const revoked = [], snapshots = [];
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    constructor(_, config) { this.mimeType = config.mimeType; this.state = 'inactive'; instance = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.onstop?.(); }
    data(bytes = 'synthetic') { this.ondataavailable({ data: new Blob([bytes]) }); }
  }
  const composer = new VoiceComposer({ Recorder, getUserMedia: async config => { assert.deepEqual(config,{audio:{channelCount:1},video:false}); requests++; return stream; },
    url: { createObjectURL: () => 'blob:synthetic-preview', revokeObjectURL: url => revoked.push(url) },
    makeKey: () => `synthetic-intent-${++keys}`, now: () => time, interval: fn => { tick = fn; return 1; }, clear: () => {}, onChange: state => snapshots.push(state), ...options });
  return { composer, stream, revoked, snapshots, requests: () => requests, stopped: () => stopped, recorder: () => instance, advance(ms) { time += ms; tick?.(); } };
}

test('voice asks for microphone only after start, creates a preview and waits for explicit send',async()=>{
  const f=fixture();assert.equal(f.requests(),0);assert.equal(f.composer.snapshot().phase,'idle');
  await f.composer.start();assert.equal(f.requests(),1);assert.equal(f.composer.phase,'recording');
  f.recorder().data();f.advance(1200);f.composer.stop();
  assert.equal(f.composer.phase,'ready');assert.equal(f.stopped(),1);assert.equal(f.composer.snapshot().previewUrl,'blob:synthetic-preview');
  const intent=f.composer.beginSend();assert.equal(intent.contentType,'audio/webm;codecs=opus');
  assert.equal(await intent.blob.text(),'synthetic');assert.equal(f.composer.beginSend(),null);
  f.composer.finishSend(intent);assert.equal(f.composer.phase,'idle');assert.equal(f.composer.blob,null);assert.deepEqual(f.revoked,['blob:synthetic-preview']);
});

test('an uncertain voice retry reuses bytes and key; a late result cannot clear a newer draft',async()=>{
  const f=fixture();await f.composer.start();f.recorder().data();f.composer.stop();
  const first=f.composer.beginSend();f.composer.finishSend(first,Object.assign(new Error('timeout'),{code:'request_timeout'}));
  const retry=f.composer.beginSend();assert.equal(retry.key,first.key);assert.equal(retry.blob,first.blob);
  f.composer.discard();await f.composer.start();f.recorder().data('new synthetic');f.composer.stop();
  assert.equal(f.composer.finishSend(retry),false);assert.equal(f.composer.phase,'ready');assert.equal(await f.composer.blob.text(),'new synthetic');
  f.composer.discard();
});

test('closing while permission is pending stops a late stream without recording',async()=>{
  let resolve;const f=fixture({getUserMedia:()=>new Promise(ok=>resolve=ok)});
  const pending=f.composer.start();assert.equal(f.composer.phase,'requesting');f.composer.discard();
  resolve(f.stream);await pending;assert.equal(f.stopped(),1);assert.equal(f.recorder(),undefined);assert.equal(f.composer.phase,'idle');
});

test('default browser timers keep their global receiver when called by the composer',()=>{
  const original=globalThis.clearInterval;let called=false;
  try {
    globalThis.clearInterval=function(){assert.equal(this,globalThis);called=true;};
    new VoiceComposer().discard();assert.equal(called,true);
  }finally{globalThis.clearInterval=original;}
});

test('denied permission and unavailable recorders leave text use possible and retain no media',async()=>{
  const f=fixture({getUserMedia:async()=>{throw Object.assign(new Error('device detail'),{name:'NotAllowedError'});}});
  await f.composer.start();assert.equal(f.composer.snapshot().error.code,'microphone_denied');assert.equal(f.composer.phase,'idle');assert.equal(f.composer.blob,null);
  const unsupported=fixture({Recorder:undefined});await unsupported.composer.start();assert.equal(unsupported.requests(),0);assert.equal(unsupported.composer.supported,false);
});

test('capture stops before the server duration limit, and oversized recording is discarded',async()=>{
  const f=fixture();await f.composer.start();f.recorder().data();f.advance(59000);
  assert.equal(f.composer.phase,'ready');assert.equal(f.composer.seconds,59);assert.equal(f.stopped(),1);f.composer.discard();
  await f.composer.start();f.recorder().data(new Uint8Array(5*1024*1024+1));
  assert.equal(f.composer.phase,'idle');assert.equal(f.composer.blob,null);assert.equal(f.composer.error.code,'audio_too_large');assert.equal(f.stopped(),2);
});

test('empty and failed recordings stop tracks without producing an uploadable draft',async()=>{
  const f=fixture();await f.composer.start();f.composer.stop();assert.equal(f.composer.error.code,'recording_empty');assert.equal(f.composer.beginSend(),null);
  await f.composer.start();f.recorder().onerror();assert.equal(f.composer.error.code,'recording_failed');assert.equal(f.stopped(),2);assert.equal(f.composer.previewUrl,'');
});

test('upload carries the original blob and intent only to the same-origin private route',async()=>{
  const blob=new Blob(['synthetic'],{type:'audio/webm'}),intent={blob,contentType:blob.type,key:'synthetic-voice-key'};
  let calls=0;
  const result=await uploadVoice('thread-123',intent,{fetcher:async(path,options)=>{calls++;assert.equal(path,'/api/threads/thread-123/voice');assert.equal(options.body,blob);assert.equal(options.credentials,'same-origin');assert.equal(options.headers['Idempotency-Key'],intent.key);assert.equal(options.cache,'no-store');return {ok:true,json:async()=>({message:{id:'synthetic'}})};}});
  assert.equal(calls,1);assert.equal(result.message.id,'synthetic');
  await assert.rejects(uploadVoice('../foreign',intent),error=>error.code==='thread_not_found');
});

test('upload timeout covers a stalled response body and never retries automatically',async()=>{
  let calls=0;
  await assert.rejects(uploadVoice('thread-123',{blob:new Blob(['synthetic']),contentType:'audio/webm',key:'synthetic-key'},{timeoutMs:20,fetcher:async(_,options)=>{calls++;return {ok:true,json:()=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))))};}}),error=>error.code==='request_timeout');
  assert.equal(calls,1);
});

// Exercise the actual app wiring without a browser, network, or microphone.
const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function appFunction(start,end) {
  const from=appSource.indexOf(start),to=appSource.indexOf(end,from);
  assert.ok(from>=0&&to>from,`App function boundaries: ${start}`);
  return appSource.slice(from,to);
}
function chatFixture(options={}) {
  const nodes=new Map();let context,mediaPauses=0,mediaLoads=0,messageRenders=0;
  const $=id=>{
    if(!nodes.has(id))nodes.set(id,{
      hidden:false,disabled:false,open:false,textContent:'',value:'synthetic text draft',attributes:{},
      getAttribute(name){return this.attributes[name]??null;},removeAttribute(name){delete this.attributes[name];},
      set src(value){this.attributes.src=value;},get src(){return this.attributes.src;},
      canPlayType:()=> 'probably',pause(){},load(){},querySelectorAll:()=>[],replaceChildren(){this.cleared=true;},
      addEventListener(name,fn){this[name]=fn;},
    });
    return nodes.get(id);
  };
  const media={pause(){mediaPauses++;},load(){mediaLoads++;},removeAttribute(){}};
  $('#chat').open=true;$('#chat').querySelectorAll=()=>[media,$('#voice-preview')];
  const f=fixture({...options,onChange:()=>context.renderVoice()});
  context=vm.createContext({voice:f.composer,$,state:{production:true,user:{id:'synthetic-user'},chat:'synthetic-thread',voiceEnabled:true,posts:[]},
    threads:{'synthetic-thread':{id:'synthetic-thread',postId:'synthetic-post',expiresAt:2000}},document:{hidden:false},
    accountGeneration:1,privateRevision:1,updatesRequest:null,updatesError:false,updatesCheckedAt:0,chatRequest:0,chatReads:new Map(),chatTimer:1,
    clearInterval(){},api:async()=>({threads:[]}),outbox:{retain(){},get:()=>({error:null,busy:false})},now:()=>1000,
    saveSession(){},renderUpdates(){},renderInbox(){},render(){},setConnection(){},errorText:error=>error.code,
    renderChatMessages(){messageRenders++;},mergeSummary,freshPost,markRead,lastSnapshot:null,owners:{},mutationKeys:new Map(),
  });
  vm.runInContext([
    appFunction('function applyFeedRevision(','function receive('),
    appFunction('function receive(data)','function openDialog('),
    appFunction('async function pollUpdates()','async function openInbox()'),
    appFunction('function stopAudio(','function reportVoiceMarkup('),
    appFunction('function renderVoice()','function renderChatMessages('),
    appFunction('function refreshChat()','async function openChat('),
    appFunction("$('#voice-record').addEventListener(","$('#voice-stop').addEventListener("),
  ].join('\n'),context);
  return {...f,$,context,mediaPauses:()=>mediaPauses,mediaLoads:()=>mediaLoads,messageRenders:()=>messageRenders};
}
function assertUnavailable(f) {
  assert.equal(f.context.state.chat,null);assert.equal(f.composer.phase,'idle');assert.equal(f.composer.blob,null);
  assert.equal(f.$('#voice-composer').hidden,true);assert.equal(f.$('#chat-form').hidden,true);
  assert.equal(f.$('#chat-safety').hidden,true);assert.equal(f.$('#chat-messages').cleared,true);
  assert.equal(f.$('#chat-input').disabled,true);assert.equal(f.$('#chat-form button').disabled,true);
  assert.equal(f.$('#chat-error').hidden,false);assert.match(f.$('#chat-error').textContent,/plus disponible/);
  assert.equal(f.mediaPauses(),1);assert.equal(f.mediaLoads(),1);
}

test('private summary removal, private expiry and definitive read errors stop the current capture',async t=>{
  const routes=[
    ['private summary removal',f=>f.context.pollUpdates()],
    ['private expiry in a public snapshot',f=>{f.context.threads['synthetic-thread'].expiresAt=999;f.context.receive({posts:[],now:1000,epoch:'synthetic-epoch',scope:'synthetic-scope',version:1});}],
    ...[403,404].map(status=>[`read ${status}`,f=>{f.context.api=async()=>{throw Object.assign(new Error('unavailable'),{status,code:'thread_not_found'});};return f.context.refreshChat();}]),
  ];
  for(const [name,remove] of routes)await t.test(name,async()=>{
    const f=chatFixture();await f.composer.start();assert.equal(f.composer.phase,'recording');
    await remove(f);assertUnavailable(f);assert.equal(f.stopped(),1);
    f.advance(1000);assert.equal(f.composer.phase,'idle');
  });
});

test('removal cancels pending permission and a late chat read cannot revive the unavailable composer',async()=>{
  let permission,read;const f=chatFixture({getUserMedia:()=>new Promise(resolve=>permission=resolve)});
  f.context.api=path=>path==='/api/updates'?Promise.resolve({threads:[]}):new Promise(resolve=>read=resolve);
  const capture=f.composer.start(),chat=f.context.refreshChat();
  await f.context.pollUpdates();assertUnavailable(f);
  permission(f.stream);read({thread:{messages:[]}});await Promise.all([capture,chat]);
  assert.equal(f.stopped(),1);assert.equal(f.recorder(),undefined);assert.equal(f.messageRenders(),0);
  assert.equal(f.composer.phase,'idle');assert.equal(f.$('#chat-form').hidden,true);
});

test('removal erases ready or sending voice drafts and ignores late send results',async t=>{
  for(const phase of ['ready','sending'])await t.test(phase,async()=>{
    const f=chatFixture();await f.composer.start();f.recorder().data();f.composer.stop();
    const intent=phase==='sending'?f.composer.beginSend():null;
    await f.context.pollUpdates();assertUnavailable(f);assert.deepEqual(f.revoked,['blob:synthetic-preview']);
    if(intent)assert.equal(f.composer.finishSend(intent,new Error('late response')),false);
    assert.equal(f.composer.phase,'idle');
  });
});

test('public announcement expiry does not discard a still-valid private conversation or its drafts',async()=>{
  const f=chatFixture();await f.composer.start();
  f.context.state.posts=[{id:'synthetic-post',expiresAt:999}];
  f.context.receive({posts:[],now:1000,epoch:'synthetic-epoch',scope:'synthetic-scope',version:1});
  f.context.api=async()=>({threads:[{id:'synthetic-thread',postId:'synthetic-post',expiresAt:2000}]});
  await f.context.pollUpdates();
  assert.equal(f.context.state.chat,'synthetic-thread');assert.equal(f.composer.phase,'recording');assert.equal(f.stopped(),0);
  assert.equal(f.$('#voice-composer').hidden,false);assert.equal(f.$('#chat-form').hidden,false);
  assert.equal(f.$('#chat-input').value,'synthetic text draft');assert.equal(f.mediaPauses(),0);
  f.composer.discard();
});

test('privacy revision stops capture and prevents restarting the real microphone handler until checked',async()=>{
  const f=chatFixture();await f.composer.start();f.context.applyFeedRevision({feedRevision:1});
  assert.equal(f.composer.phase,'idle');assert.equal(f.stopped(),1);assert.equal(f.$('#voice-record').disabled,true);
  f.$('#voice-record').click();await Promise.resolve();assert.equal(f.composer.phase,'idle');
  assert.equal(f.context.state.chatPrivacyPending,true);
  f.context.api=async()=>({thread:{blocked:true,blockedByMe:true,incomingCount:0,messages:[],updatedAt:1000}});
  await f.context.refreshChat();assert.equal(f.context.state.chatPrivacyPending,false);assert.equal(f.$('#voice-record').disabled,true);
  f.$('#voice-record').click();await Promise.resolve();assert.equal(f.composer.phase,'idle');
});

test('a ready voice survives an unrelated block revision but is erased if its conversation is blocked',async t=>{
  for(const blocked of [false,true])await t.test(String(blocked),async()=>{
    const f=chatFixture();await f.composer.start();f.recorder().data();f.composer.stop();const blob=f.composer.blob;
    assert.equal(f.composer.phase,'ready');f.context.applyFeedRevision({feedRevision:1});
    assert.equal(f.composer.blob,blob);assert.equal(f.$('#voice-send').disabled,true);
    f.context.api=async()=>({thread:{blocked,blockedByMe:blocked,incomingCount:0,messages:[],updatedAt:1000}});
    await f.context.refreshChat();
    assert.equal(f.composer.phase,blocked?'idle':'ready');assert.equal(f.composer.blob,blocked?null:blob);
    if(!blocked)assert.equal(f.$('#voice-send').disabled,false);f.composer.discard();
  });
});
