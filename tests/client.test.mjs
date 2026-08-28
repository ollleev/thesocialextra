import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MessageOutbox, requestJSON } from '../public/requests.js';
import { preserveLiveFocus, captureLiveOpener, restoreLiveOpener } from '../public/live-focus.js';
import { LocalMap } from '../public/map.js';

function focusFixture() {
  const document={body:{isConnected:true},activeElement:null,querySelector(){return this.openDialog??null;}};document.activeElement=document.body;
  const node=key=>({dataset:key?{focusKey:key}:{},isConnected:true,disabled:false,style:{},offsetWidth:70,offsetHeight:32,
    setAttribute(){},addEventListener(){},getClientRects(){return this.hidden?[]:[{}];},focus(options){this.focusOptions=options;document.activeElement=this;},remove(){this.isConnected=false;},
  });
  const fallback=node(),container={ownerDocument:document,children:[],
    contains(value){return this.children.includes(value);},querySelectorAll(){return this.children.filter(child=>child.isConnected&&child.dataset.focusKey);},
    replaceChildren(...children){for(const child of this.children){child.isConnected=false;if(document.activeElement===child)document.activeElement=document.body;}this.children=children;},
    append(...children){this.children.push(...children);},prepend(...children){this.children.unshift(...children);},
  };
  document.createElement=()=>node();
  return {document,node,container,fallback};
}

test('live redraw restores the same action by key, never by its changed list position',()=>{
  const f=focusFixture(),old=f.node('post-older'),replacement=f.node('post-older'),newer=f.node('post-newer');
  f.container.append(old);f.document.activeElement=old;
  const result=preserveLiveFocus(f.container,()=>{f.container.replaceChildren(newer,replacement);return 7;},f.fallback);
  assert.equal(result,7);assert.equal(f.document.activeElement,replacement);assert.deepEqual(replacement.focusOptions,{preventScroll:true});
  preserveLiveFocus(f.container,()=>f.container.replaceChildren(newer),f.fallback);
  assert.equal(f.document.activeElement,f.fallback);
});

test('live redraw never steals focus from an unrelated input or a newly opened dialog',()=>{
  const f=focusFixture(),old=f.node('post-a'),input=f.node(),dialog=f.node();f.container.append(old);f.document.activeElement=input;
  preserveLiveFocus(f.container,()=>f.container.replaceChildren(f.node('post-a')),f.fallback);assert.equal(f.document.activeElement,input);
  f.document.activeElement=f.container.children[0];
  preserveLiveFocus(f.container,()=>{f.container.replaceChildren(f.node('post-a'));dialog.focus();},f.fallback);
  assert.equal(f.document.activeElement,dialog);
  const current=f.container.children[0];current.focus();
  preserveLiveFocus(f.container,()=>{},f.fallback);assert.equal(f.document.activeElement,current);assert.equal(current.focusOptions,undefined);
});

test('disabled replacement falls back and arbitrary key text is compared as data, not a CSS selector',()=>{
  const f=focusFixture(),key='post-\"] #private-input',old=f.node(key),replacement=f.node(key);
  f.container.append(old);old.focus();preserveLiveFocus(f.container,()=>f.container.replaceChildren(replacement),f.fallback);
  assert.equal(f.document.activeElement,replacement);
  const disabled=f.node(key);disabled.disabled=true;
  preserveLiveFocus(f.container,()=>f.container.replaceChildren(disabled),f.fallback);assert.equal(f.document.activeElement,f.fallback);
});

test('actual map pin redraw preserves its focused post and falls back to map after removal',t=>{
  const f=focusFixture(),oldDocument=globalThis.document;globalThis.document=f.document;t.after(()=>{globalThis.document=oldDocument;});
  const element=Object.assign(f.fallback,{clientWidth:400,clientHeight:400});
  const map={element,pins:f.container,center:{lat:48.86,lng:2.35},zoom:13,fresh:new Map(),selected:null,pinHTML:()=>'',
    posts:[{id:'synthetic-post',lat:48.86,lng:2.35,role:'Plongeur',zoneLabel:'Zone synthétique',status:'open',kind:'available'}]};
  LocalMap.prototype.renderPins.call(map);const first=f.container.children.find(node=>node.dataset.post);first.focus();
  LocalMap.prototype.renderPins.call(map);const second=f.container.children.find(node=>node.dataset.post);
  assert.notEqual(first,second);assert.equal(f.document.activeElement,second);assert.equal(second.dataset.focusKey,'post-synthetic-post');
  map.posts=[];LocalMap.prototype.renderPins.call(map);assert.equal(f.document.activeElement,element);
});

test('a detail opener survives several background redraws as an action key rather than a detached DOM node',()=>{
  for(const key of ['post-synthetic','detail-synthetic']){
    const f=focusFixture(),button=f.node(key);f.container.append(button);button.focus();
    const opener=captureLiveOpener([f.container]);f.document.openDialog={};f.document.activeElement=f.node();
    for(let i=0;i<3;i++)preserveLiveFocus(f.container,()=>f.container.replaceChildren(f.node(key)),f.fallback);
    assert.equal(button.isConnected,false);assert.equal(f.document.activeElement.dataset.focusKey,undefined);
    f.document.openDialog=null;f.document.activeElement=f.document.body;
    restoreLiveOpener(opener,[f.fallback]);assert.equal(f.document.activeElement,f.container.children[0]);
    assert.deepEqual(f.document.activeElement.focusOptions,{preventScroll:true});
  }
});

test('return from a removed or hidden announcement chooses a visible fallback without focusing another post',()=>{
  const f=focusFixture(),button=f.node('post-a');f.container.append(button);button.focus();const opener=captureLiveOpener([f.container]);
  const hidden=f.node('post-a');hidden.hidden=true;f.container.replaceChildren(hidden,f.node('post-b'));
  const hiddenMap=f.node();hiddenMap.hidden=true;restoreLiveOpener(opener,[hiddenMap,f.fallback]);
  assert.equal(f.document.activeElement,f.fallback);
});

test('a late detail close cannot steal focus from a reopened dialog, another dialog or a chosen page control',()=>{
  const f=focusFixture(),button=f.node('post-a');f.container.append(button);button.focus();const opener=captureLiveOpener([f.container]);
  f.container.replaceChildren(f.node('post-a'));
  for(const dialog of [{id:'chat'},{id:'account'},{id:'detail'}]){
    f.document.openDialog=dialog;f.document.activeElement=f.document.body;restoreLiveOpener(opener,[f.fallback]);
    assert.equal(f.document.activeElement,f.document.body);
  }
  f.document.openDialog=null;const chosen=f.node();chosen.focus();restoreLiveOpener(opener,[f.fallback]);assert.equal(f.document.activeElement,chosen);
  assert.equal(captureLiveOpener([f.container]),null);
});

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

function feedFixture() {
  const calls=[],streams=[],received=[];let renders=0;
  class Events {constructor(url){this.url=url;this.listeners={};streams.push(this);}addEventListener(name,fn){this.listeners[name]=fn;}close(){this.closed=true;}}
  const context=vm.createContext({URLSearchParams,EventSource:Events,document:{hidden:false},feedGeneration:0,lastSnapshot:null,events:null,liveReady:true,
    state:{production:true,city:{id:'2988507'},mine:false,kind:'need',role:'Plongeur',zone:'oberkampf',english:true,vehicle:true,sort:'oldest',point:{lat:48.85,lng:2.35}},
    api(url){return new Promise((resolve,reject)=>calls.push({url,resolve,reject}));},receive(value){received.push(value);context.lastSnapshot=value;context.state.feedPending=false;context.state.feedError=false;},
    setConnection(){},render(){renders++;},accounts:{refresh:async()=>{}},
  });
  vm.runInContext(appSource.slice(appSource.indexOf('function feedQuery('),appSource.indexOf('function openDetail(')),context);
  return {context,calls,streams,received,renders:()=>renders};
}

test('changing job filters scopes both reads and streams and discards previous-search replies',async()=>{
  const f=feedFixture(),first=f.context.changeFeed();
  const params=new URL(f.calls[0].url,'https://extras.test').searchParams;
  for(const [key,value] of Object.entries({kind:'need',role:'Plongeur',zone:'oberkampf',english:'true',vehicle:'true',sort:'oldest',lat:'48.85',lng:'2.35'}))assert.equal(params.get(key),value);
  assert.equal(f.streams[0].url.replace('/api/events','/api/state'),f.calls[0].url);
  f.context.state.role='Barman';const second=f.context.changeFeed();assert.equal(f.streams[0].closed,true);
  f.streams[0].listeners.state({data:JSON.stringify({id:'old stream'})});f.calls[0].resolve({id:'old request'});await first;
  assert.deepEqual(f.received,[]);assert.equal(f.context.state.feedPending,true);
  f.calls[1].resolve({id:'new search'});await second;assert.deepEqual(f.received,[{id:'new search'}]);
  assert.equal(f.context.state.feedPending,false);
});

test('a failed search has a retry state but an older failed read cannot erase a newer live result',async()=>{
  const f=feedFixture(),failed=f.context.changeFeed();f.calls[0].reject(new Error('offline'));await failed;
  assert.equal(f.context.state.feedPending,false);assert.equal(f.context.state.feedError,true);
  const retried=f.context.changeFeed();assert.equal(f.context.state.feedError,false);
  f.streams[1].listeners.state({data:JSON.stringify({id:'live result'})});f.calls[1].reject(new Error('old read failed'));await retried;
  assert.equal(f.context.state.feedError,false);assert.equal(f.received[0].id,'live result');
});

test('public results do not append off-page owned posts and hide previous results while a new search loads',()=>{
  const post=id=>({id,expiresAt:100,status:'open',kind:'need',role:'Barman',createdAt:1});
  const context=vm.createContext({state:{posts:[post('shown'),post('off-page-own')],feedIds:new Set(['shown']),mine:false,kind:'all',zone:'all',role:'all'},owners:{'off-page-own':true},inCity:()=>true,now:()=>0});
  const start=appSource.indexOf('function visiblePosts(');
  vm.runInContext(appSource.slice(start,appSource.indexOf('const map =',start)),context);
  assert.deepEqual(Array.from(context.visiblePosts(),p=>p.id),['shown']);
  context.state.feedPending=true;assert.equal(context.visiblePosts().length,0);
  context.state.feedPending=false;context.state.feedError=true;assert.equal(context.visiblePosts().length,0);
});

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

test('publishing resets the server search and stream as well as visible filters',async()=>{
const nodes = new Map(), $ = id => {
  if (!nodes.has(id)) nodes.set(id, { disabled: false, open: id === '#composer', addEventListener(name, fn) { this[name] = fn; }, close() { this.open = false; }, focus() {} });
  return nodes.get(id);
};
const old = { id: 'old-visible', kind: 'need', role: 'Plongeur', zoneId: 'oberkampf', english: true, vehicle: true, createdAt: 1, expiresAt: 999, status: 'open' };
const post = { ...old, id: 'new-published', role: 'Barman', createdAt: 2 }, calls = [], streams = [];
class Events { constructor(url) { this.url = url; streams.push(this); } addEventListener() {} close() { this.closed = true; } }
class Data { get(key) { return ({ role: 'Barman', durationMinutes: '30', note: 'synthetic', zoneId: 'oberkampf', places: '1' })[key]; } has() { return false; } }
const context = vm.createContext({ $, state: { production: true, posts: [old], feedIds: new Set([old.id]), mine: false, kind: 'need', role: 'Plongeur', zone: 'oberkampf', english: true, vehicle: true, sort: 'oldest', formKind: 'need', city: { id: '2988507' } },
  owners: {}, now: () => 0, inCity: () => true, FormData: Data, accountGeneration: 1, composerGeneration: 1, publishing: false, requireUGC: () => true,
  writeKey: () => 'synthetic-key', writeIntents: new Map(), saveSession() {}, freshPost: (a, b) => b, syncFilters() {}, map: { recenter() {} }, render() {}, toast() {}, openDetail() {}, rulesError() {}, errorText: e => String(e),
  api: async url => { calls.push(url); return url === '/api/posts' ? { post } : { posts: [old, post] }; }, URLSearchParams, EventSource: Events, document: { hidden: false }, feedGeneration: 1, lastSnapshot: {}, events: null, liveReady: true,
  setConnection() {}, receive(data) { context.state.feedPending = false; context.state.posts = data.posts; context.state.feedIds = new Set(data.posts.map(p => p.id)); }, accounts: { refresh: async () => {} },
});
let start = appSource.indexOf('function visiblePosts(');
vm.runInContext(appSource.slice(start, appSource.indexOf('const map =', start)), context);
vm.runInContext(appSource.slice(appSource.indexOf('function feedQuery('), appSource.indexOf('function openDetail(')), context);
start = appSource.indexOf('function filtersChanged(');
vm.runInContext(appSource.slice(start, appSource.indexOf('\n', start)), context);
context.syncLiveConnection();
vm.runInContext(appSource.slice(appSource.indexOf("$('#post-form').addEventListener('submit'"), appSource.indexOf('function syncFilters(')), context);
await $('#post-form').submit({ preventDefault() {}, currentTarget: {} });
await Promise.resolve();
assert.equal(context.state.role, 'all');
assert.equal(context.state.sort, 'recent');
assert.equal(streams[0].closed, true);
assert.equal(streams.at(-1).url, '/api/events?cityId=2988507&mine=false');
assert.ok(calls.includes('/api/state?cityId=2988507&mine=false'));
assert.ok(Array.from(context.visiblePosts(), p => p.id).includes(post.id));
});

test('a valid off-page detail can contact and retry, but removed or switched details cannot send',async()=>{
  const id='off-page',post={id,role:'Barman',zoneLabel:'Zone synthétique',expiresAt:100,status:'open'};
  const button={disabled:false},textarea={value:'Contact synthétique.'},dialog={open:true},calls=[],errors=[],opened=[];
  const form={dataset:{},querySelector:selector=>selector==='textarea'?textarea:button,addEventListener(_event,handler){this.submit=handler;}};
  const context=vm.createContext({id,post,state:{production:true,posts:[],detailId:id,detailPost:post,detailUnavailable:false},
    $:selector=>selector==='#contact-form'?form:selector==='#detail'?dialog:{hidden:false},now:()=>0,requireUGC:()=>true,
    accountGeneration:1,privateRevision:0,writeIntents:new Map(),writeKey:()=> 'synthetic-stable-contact',threads:{},saveSession(){},
    async api(url,options){calls.push({url,options});if(calls.length===1)throw new Error('synthetic network failure');return {threadId:'thread'};},
    updateDetail(value){button.disabled=value.status!=='open'||context.state.detailUnavailable||form.dataset.submitting==='true';},render(){},
    rulesError(){},detailError(_id,error){errors.push(error);},openChat:async thread=>opened.push(thread),toast(){},outbox:{edit(){}},
  });
  const start=appSource.indexOf("  const form = $('#contact-form'); if (form) form.addEventListener",appSource.indexOf('function openDetail('));
  vm.runInContext(appSource.slice(start,appSource.indexOf("\n}\n$('#detail-content')",start)),context);
  const event={preventDefault(){}};await form.submit(event);
  assert.equal(calls[0].url,'/api/posts/off-page/contact');assert.equal(errors.length,1);assert.equal(button.disabled,false);
  await form.submit(event);assert.equal(calls.length,2);assert.deepEqual(opened,['thread']);
  context.state.detailUnavailable=true;await form.submit(event);assert.equal(calls.length,2);assert.equal(button.disabled,true);
  button.disabled=false;context.state.detailUnavailable=false;context.state.detailId='another';await form.submit(event);assert.equal(calls.length,2);
});
