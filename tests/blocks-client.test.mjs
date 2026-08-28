import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlockUI } from '../public/blocks.js';

class Element {
  constructor(){this.open=false;this.hidden=false;this.disabled=false;this.textContent='';this.children=[];this.events=new Map();}
  addEventListener(name,fn){const entries=this.events.get(name)||[];entries.push(fn);this.events.set(name,entries);}
  async fire(name){for(const fn of this.events.get(name)||[])await fn();}
  append(...entries){this.children.push(...entries);}
  replaceChildren(...entries){this.children=entries;}
  setAttribute(name,value){this[name]=value;}
  close(){this.open=false;void this.fire('close');}
}
function fixture(t) {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  globalThis.document={createElement:()=>new Element(),createDocumentFragment:()=>new Element()};
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete globalThis.document;});
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  let account=1,loggedIn=true,continuation=null,floor=0;const calls=[],toasts=[],revisions=[],refreshes=[];
  const api=(url,options={})=>new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}));
  const ui=createBlockUI({$,api,requireAccount:next=>{if(loggedIn)return true;continuation=next;return false;},getGeneration:()=>account,
    openDialog:dialog=>{for(const node of nodes.values())if(node.open)node.close();dialog.open=true;},
    errorText:error=>error.message,toast:text=>toasts.push(text),refreshFeed:()=>refreshes.push(true),
    onRevision:data=>{if(data.feedRevision<floor)return false;floor=data.feedRevision;revisions.push(floor);return true;}});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  return {$,ui,calls,toasts,revisions,refreshes,tick,logout(){account++;loggedIn=false;ui.reset();$('#blocks').close();$('#block-author').close();},
    anonymous(){loggedIn=false;},login(){loggedIn=true;continuation?.();},floor(value){floor=value;}};
}
const block=(id='opaque-block-0001')=>({id,createdAt:1787880000000});

test('blocking an author requires account then explicit confirmation, and opens no conversation',async t=>{
  const f=fixture(t);f.anonymous();f.ui.showAuthor('synthetic-post');assert.equal(f.calls.length,0);
  f.login();assert.equal(f.$('#block-author').open,true);assert.equal(f.calls.length,0);
  const done=f.$('#confirm-block-author').fire('click');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'/api/posts/synthetic-post/block');assert.deepEqual(f.calls[0].options,{method:'POST',body:{}});
  await f.$('#confirm-block-author').fire('click');assert.equal(f.calls.length,1);
  f.calls[0].resolve({blockId:'opaque-block-0001',feedRevision:1});await done;
  assert.deepEqual(f.revisions,[1]);assert.equal(f.refreshes.length,1);assert.equal(f.$('#block-author').open,false);
});

test('author errors retain confirmation for retry; closing or changing account prevents stale UI',async t=>{
  const f=fixture(t);f.ui.showAuthor('synthetic-post');const first=f.$('#confirm-block-author').fire('click');
  f.calls[0].reject(new Error('Expired'));await first;assert.equal(f.$('#block-author-error').textContent,'Expired');assert.equal(f.$('#confirm-block-author').disabled,false);
  const second=f.$('#confirm-block-author').fire('click');f.logout();f.calls[1].resolve({feedRevision:1});await second;
  assert.equal(f.toasts.length,0);assert.equal(f.revisions.length,0);assert.equal(f.$('#block-author').open,false);
});

test('block list paginates by opaque cursor and can unblock without the source post',async t=>{
  const f=fixture(t);f.ui.showList();assert.equal(f.calls[0].url,'/api/blocks');
  f.calls[0].resolve({blocks:[block()],nextCursor:'opaque/cursor',feedRevision:1});await f.tick();
  assert.equal(f.$('#blocks-more').hidden,false);const more=f.$('#blocks-more').fire('click');
  assert.equal(f.calls[1].url,'/api/blocks?cursor=opaque%2Fcursor');
  f.calls[1].resolve({blocks:[block(),block('opaque-block-0002')],nextCursor:null,feedRevision:1});await more;
  assert.equal(f.$('#blocked-list').children[0].children.length,2);assert.equal(f.$('#blocks-more').hidden,true);
  const button=f.$('#blocked-list').children[0].children[0].children[1],done=button.fire('click');
  assert.equal(f.calls[2].url,'/api/blocks/opaque-block-0001');assert.equal(f.calls[2].options.method,'DELETE');
  f.calls[2].resolve({feedRevision:2});await done;
  assert.equal(f.$('#blocked-list').children[0].children.length,1);assert.equal(f.refreshes.length,1);
});

test('late lists cannot refill a closed or signed-out sheet; older revisions do not replace the list',async t=>{
  const f=fixture(t);f.ui.showList();f.$('#blocks').close();f.calls[0].resolve({blocks:[block()],feedRevision:1});await f.tick();
  assert.equal(f.$('#blocked-list').children.length,0);
  f.ui.showList();f.floor(2);f.calls[1].resolve({blocks:[block()],feedRevision:1});await f.tick();
  assert.equal(f.$('#blocked-list').children.length,0);assert.match(f.$('#blocks-status').textContent,/Actualisez/);
  const refresh=f.$('#blocks-refresh').fire('click');f.logout();f.calls[2].resolve({blocks:[block()],feedRevision:3});await refresh;
  assert.equal(f.$('#blocked-list').children.length,0);assert.equal(f.revisions.length,0);
});

test('list read failure exposes retry and does not pretend that no accounts are blocked',async t=>{
  const f=fixture(t);f.ui.showList();f.calls[0].reject(new Error('Network unavailable'));await f.tick();
  assert.equal(f.$('#blocks-error').hidden,false);assert.match(f.$('#blocks-status').textContent,/non actualisée/);
  assert.equal(f.$('#blocks-refresh').disabled,false);
});

test('pagination restarts at page one when another session changes the block list',async t=>{
  const f=fixture(t);f.ui.showList();f.calls[0].resolve({blocks:[block('removed'),block('retained')],nextCursor:'page-two',feedRevision:1});await f.tick();
  const more=f.$('#blocks-more').fire('click');f.ui.refreshIfOpen();f.floor(2);
  f.calls[1].resolve({blocks:[block('new')],nextCursor:null,feedRevision:2});await f.tick();
  assert.equal(f.calls[2].url,'/api/blocks');
  f.calls[2].resolve({blocks:[block('retained'),block('new')],nextCursor:null,feedRevision:2});await more;await f.tick();
  // A queued invalidation can cause one additional page-one read, never a merge
  // with the obsolete first page. Resolve it too before asserting the result.
  if(f.calls[3]){assert.equal(f.calls[3].url,'/api/blocks');f.calls[3].resolve({blocks:[block('retained'),block('new')],nextCursor:null,feedRevision:2});await f.tick();}
  assert.equal(f.$('#blocked-list').children[0].children.length,2);
  assert.ok(f.$('#blocked-list').children[0].children.every(row=>!row.children[0].children[0].textContent.includes('removed')));
});
