import test from 'node:test';
import assert from 'node:assert/strict';
import { createRulesUI,rulesMetadata } from '../public/rule-consent.js';

const rules=(version='2026-08-28.1',accepted=false)=>({version,url:`/rules/${version}.html`,sha256:'a'.repeat(64),accepted});
function fixture() {
  const nodes=new Map(),$=id=>{
    if(!nodes.has(id))nodes.set(id,{open:false,checked:false,disabled:false,hidden:false,attributes:{},events:new Map(),
      addEventListener(name,fn){this.events.set(name,fn);},async fire(name){return this.events.get(name)?.({preventDefault(){}});},
      setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},
      showModal(){this.open=true;},close(){this.open=false;void this.fire('close');}});
    return nodes.get(id);
  };
  let generation=1,session={mode:'production',user:{id:'synthetic-reader'},rules:rules()};
  const calls=[],applied=[];let refreshed=0,opened=0;
  const api=(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}));
  const ui=createRulesUI({$,api,getSession:()=>session,getGeneration:()=>generation,
    refreshSession:async()=>{refreshed++;},applyRules:next=>{applied.push(next);session={...session,rules:next};},errorText:error=>error.code||error.message,beforeOpen:()=>opened++});
  $('#chat').open=true;
  return {$,ui,calls,applied,refreshed:()=>refreshed,opened:()=>opened,setRules(next){session={...session,rules:next};ui.changed();},
    logout(){generation++;session={...session,user:null};ui.reset();},setDemo(){session={mode:'demo',user:null};}};
}

test('rule metadata only accepts a version-bound same-origin document and a full digest',()=>{
  assert.deepEqual(rulesMetadata(rules()),rules());
  for(const value of [null,{}, {...rules(),url:'https://elsewhere.test/'},{...rules(),url:'/rules/other.html'},{...rules(),sha256:'bad'},{...rules(),version:'../escape'}])assert.equal(rulesMetadata(value),null);
  assert.equal(rulesMetadata({...rules(),accepted:'true'}).accepted,false);
});

test('rules require explicit checkbox and submit; underlying conversation stays open and nothing auto-sends',async()=>{
  const f=fixture();let resumed=0;assert.equal(f.ui.require(()=>resumed++),false);
  assert.equal(f.$('#rules-consent').open,true);assert.equal(f.$('#chat').open,true);assert.equal(f.calls.length,0);
  await f.$('#rules-form').fire('submit');assert.equal(f.calls.length,0);
  f.$('#rules-agree').checked=true;const operation=f.$('#rules-form').fire('submit');
  await f.$('#rules-form').fire('submit');assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].url,'/api/account/rules-acceptance');
  assert.deepEqual(f.calls[0].options,{method:'POST',body:{acceptedRules:true,rulesVersion:'2026-08-28.1'}});
  f.calls[0].resolve({rules:rules('2026-08-28.1',true)});await operation;
  assert.equal(f.applied.length,1);assert.equal(resumed,1);assert.equal(f.$('#rules-consent').open,false);assert.equal(f.$('#chat').open,true);
  assert.equal(f.ui.require(()=>resumed++),true);assert.equal(resumed,1);
});

test('cancel and logout discard continuations, not the underlying form',async()=>{
  const f=fixture();let resumed=0;f.ui.require(()=>resumed++);await f.$('#rules-cancel').fire('click');
  assert.equal(f.calls.length,0);assert.equal(resumed,0);assert.equal(f.$('#chat').open,true);
  f.ui.require(()=>resumed++);f.$('#rules-agree').checked=true;const operation=f.$('#rules-form').fire('submit');
  f.logout();f.calls[0].resolve({rules:rules('2026-08-28.1',true)});await operation;
  assert.equal(f.applied.length,0);assert.equal(resumed,0);assert.equal(f.$('#rules-agree').checked,false);
});

test('a changed version unchecks agreement and a late old response cannot unlock or close a new submission',async()=>{
  const f=fixture();let resumed=0;f.ui.require(()=>resumed++);f.$('#rules-agree').checked=true;
  const old=f.$('#rules-form').fire('submit');f.setRules(rules('2026-08-29.1'));
  assert.equal(f.$('#rules-agree').checked,false);assert.equal(f.$('#rules-document').attributes.href,'/rules/2026-08-29.1.html');
  f.$('#rules-agree').checked=true;const next=f.$('#rules-form').fire('submit');
  f.calls[0].resolve({rules:rules('2026-08-28.1',true)});await old;
  assert.equal(f.$('#rules-accept').disabled,true);assert.equal(f.$('#rules-consent').open,true);assert.equal(f.applied.length,0);
  f.calls[1].resolve({rules:rules('2026-08-29.1',true)});await next;
  assert.equal(resumed,1);assert.deepEqual(f.applied,[rules('2026-08-29.1',true)]);
});

test('invalid or failed acceptance preserves the visible form and never pretends the rules were accepted',async()=>{
  for(const response of [{rules:rules()}, {rules:{...rules('2026-08-28.1',true),sha256:'b'.repeat(64)}}]) {
    const f=fixture();let resumed=0;f.ui.require(()=>resumed++);f.$('#rules-agree').checked=true;
    const operation=f.$('#rules-form').fire('submit');f.calls[0].resolve(response);await operation;
    assert.equal(f.$('#rules-error').hidden,false);assert.equal(f.$('#rules-consent').open,true);assert.equal(f.applied.length,0);assert.equal(resumed,0);
  }
});

test('demo requires no account agreement; unavailable rules disable acceptance',async()=>{
  const f=fixture();f.setRules(null);f.ui.require(()=>{});await Promise.resolve();
  assert.equal(f.$('#rules-document').hidden,true);assert.equal(f.$('#rules-accept').disabled,true);assert.equal(f.refreshed(),1);
  f.ui.reset();f.setDemo();assert.equal(f.ui.require(()=>{}),true);assert.equal(f.$('#rules-consent').open,false);
});
