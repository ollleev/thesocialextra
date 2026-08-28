import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MessageOutbox, requestJSON } from '../public/requests.js';

test('drafts and delayed send results are isolated by conversation and edit version', () => {
  const box = new MessageOutbox(() => 'intent-key');
  box.edit('a', 'Premier message'); const first = box.begin('a');
  assert.equal(box.begin('a'), null);
  box.edit('b', 'Brouillon ailleurs');
  box.edit('a', 'Message suivant');
  box.finish('a', first);
  assert.equal(box.get('a').draft, 'Message suivant');
  assert.equal(box.get('b').draft, 'Brouillon ailleurs');
  const next = box.begin('a'); box.finish('a', next);
  assert.equal(box.get('a').draft, '');
  box.retain(new Set(['b']));
  assert.equal(box.entries.has('a'), false);
  assert.equal(box.finish('a', first), false);
});

test('uncertain message retry retains its key; a new intentional message gets another', () => {
  let n = 0; const box = new MessageOutbox(() => `key-${++n}`);
  box.edit('a', ' Bonjour '); const first = box.begin('a');
  const failure = new Error('lost response'); box.finish('a', first, failure);
  assert.equal(box.get('a').draft, ' Bonjour ');
  assert.equal(box.get('a').error, failure);
  const retry = box.begin('a');
  assert.equal(retry.key, first.key); assert.equal(retry.text, 'Bonjour');
  box.finish('a', retry);
  box.edit('a', 'Bonjour');
  assert.notEqual(box.begin('a').key, retry.key);
});

test('editing back to the same text during a send does not silently clear the new draft', () => {
  const box = new MessageOutbox();
  box.edit('a', 'Texte'); const intent = box.begin('a');
  box.edit('a', 'Autre'); box.edit('a', 'Texte');
  box.finish('a', intent);
  assert.equal(box.get('a').draft, 'Texte');
});

test('request timeout aborts a hung request once, without automatic retry', async () => {
  let calls = 0;
  await assert.rejects(requestJSON('/local', { method: 'POST', body: { message: 'Essai' } }, {
    timeoutMs: 10,
    fetcher: (_path, { signal }) => new Promise((_resolve, reject) => {
      calls++; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), { code: 'request_timeout' });
  assert.equal(calls, 1);
});

test('request timeout also covers a stalled response body', async () => {
  await assert.rejects(requestJSON('/local', {}, { timeoutMs: 10, fetcher: async (_path, { signal }) => ({
    status: 200, ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  }) }), { code: 'request_timeout' });
});

test('JSON requests carry private authorization and intent only in headers, preserving HTTP errors', async () => {
  await assert.rejects(requestJSON('/api/threads/local/messages', { method: 'POST', chat: 'test-capability', idempotencyKey: 'test-intent', body: { message: 'Essai' } }, {
    fetcher: async (path, options) => {
      assert.equal(path, '/api/threads/local/messages');
      assert.equal(options.headers['X-Chat-Token'], 'test-capability');
      assert.equal(options.headers['Idempotency-Key'], 'test-intent');
      assert.equal(options.body, '{"message":"Essai"}');
      return { status: 409, ok: false, json: async () => ({ error: 'idempotency_conflict' }) };
    },
  }), { code: 'idempotency_conflict', status: 409 });
});

const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const accountStartup=appSource.slice(appSource.indexOf('function openAccountLink()'),appSource.lastIndexOf('\nstart();'));
function accountStartupFixture(query,{sessionFails=false,feedFails=false}={}) {
  const calls=[],nodes=new Map();let parsedURL;
  const context=vm.createContext({URL,location:{href:`https://extras.test/${query}`},state:{},
    accounts:{async refresh(){calls.push('session');if(sessionFails)throw new Error('session unavailable');},showDeletion(){calls.push('deletion form');}},
    async api(path){calls.push(path);if(feedFails)throw new Error('feed unavailable');return [];},
    $:id=>{if(!nodes.has(id))nodes.set(id,{insertAdjacentHTML(){},addEventListener(){}});return nodes.get(id);},
    parseFeedLink(url){parsedURL=url;throw new Error('stop after routing');},
    setConnection(){},icon:()=>'',esc:value=>value,errorText:()=> 'Unavailable',
  });
  vm.runInContext(accountStartup,context);
  return {context,calls,parsedURL:()=>parsedURL};
}

test('only one exact account=delete value opens a deletion form; other URL values have no effect',()=>{
  for(const query of ['','?account=DELETE','?account=delete%20','?account=register','?account=delete&account=delete','?account=other&account=delete']) {
    const f=accountStartupFixture(query);assert.equal(f.context.openAccountLink(),false);assert.deepEqual(f.calls,[]);
  }
  const f=accountStartupFixture('?account=delete');assert.equal(f.context.openAccountLink(),true);assert.deepEqual(f.calls,['deletion form']);
});

test('account deletion access precedes the feed, survives outages, and takes precedence over a post link',async()=>{
  for(const options of [{sessionFails:true},{feedFails:true},{}]) {
    const f=accountStartupFixture('?account=delete&post=synthetic-post',options);await f.context.start();
    assert.deepEqual(f.calls.slice(0,2),['session','deletion form']);
    if(options.sessionFails)assert.equal(f.calls.length,2);
    if(!options.sessionFails&&!options.feedFails)assert.equal(f.parsedURL(),'https://extras.test/');
  }
});

function privacyFixture() {
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{open:false,close(){this.open=false;},replaceChildren(){this.cleared=true;}});return nodes.get(id);};
  $('#detail').open=true;
  let discards=0,renders=0,detailUpdates=0;
  const context=vm.createContext({$,state:{production:true,user:{id:'reader'},feedRevision:0,posts:[{id:'mine'},{id:'other'}],detailId:'other',detailPost:{id:'other'},chat:null},
    accountGeneration:1,privateRevision:0,chatRequest:0,owners:{mine:true},voice:{phase:'recording',discard(){discards++;}},render(){renders++;},renderVoice(){},
    lastSnapshot:null,threads:{},mutationKeys:new Map(),freshPost:(_old,next)=>next,setConnection(){},now:()=>0,
    invalidateUnavailableChat(){},outbox:{retain(){}},saveSession(){},renderUpdates(){},renderInbox(){},
    blockUI:{refreshIfOpen(){}},pollUpdates(){},refreshChat(){},updateDetail(){detailUpdates++;},detailError(){},
  });
  vm.runInContext(appSource.slice(appSource.indexOf('function applyFeedRevision('),appSource.indexOf('function openDialog(')),context);
  vm.runInContext(appSource.slice(appSource.indexOf('let detailRead='),appSource.indexOf('function detailError(')),context);
  return {context,$,discards:()=>discards,renders:()=>renders,detailUpdates:()=>detailUpdates};
}

test('private feed revision invalidates public detail and refuses delayed pre-block snapshots across feed changes',()=>{
  const f=privacyFixture();assert.equal(f.context.applyFeedRevision({feedRevision:2}),true);
  assert.deepEqual(Array.from(f.context.state.posts,post=>post.id),['mine']);
  assert.equal(f.$('#detail').open,false);assert.equal(f.$('#detail-content').cleared,true);assert.equal(f.discards(),1);
  f.context.lastSnapshot=null; // Changing city must not reset the private revision floor.
  f.context.receive({feedRevision:1,posts:[{id:'blocked'}],version:100,epoch:'e',scope:'new',now:0});
  assert.deepEqual(Array.from(f.context.state.posts,post=>post.id),['mine']);
  f.context.receive({posts:[{id:'old anonymous response'}],version:100,epoch:'e',scope:'new',now:0});
  assert.deepEqual(Array.from(f.context.state.posts,post=>post.id),['mine']);
  f.context.receive({feedRevision:2,posts:[{id:'allowed'}],ownedPostIds:['mine'],ownedPosts:[{id:'mine'}],version:101,epoch:'e',scope:'new',now:0});
  assert.deepEqual(Array.from(f.context.state.posts,post=>post.id),['allowed','mine']);
});

test('a detail read started before a block cannot restore its content afterwards',async()=>{
  const f=privacyFixture();let resolve;f.context.api=()=>new Promise(done=>resolve=done);
  const read=f.context.refreshDetail();f.context.applyFeedRevision({feedRevision:1});
  // The same detail ID could be selected again after navigation; privacy must still win.
  f.context.state.detailId='other';f.$('#detail').open=true;
  resolve({post:{id:'other'},feedRevision:0});await read;
  assert.equal(f.detailUpdates(),0);assert.equal(f.context.state.detailPost,null);
});
