import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createPresentationUI,uploadPresentation} from '../public/presentation.js';

class Element {
 constructor(id,tag='div'){Object.assign(this,{id,tag,value:'',textContent:'',checked:false,hidden:false,disabled:false,open:false,files:[],dataset:{},children:[],listeners:new Map(),attributes:{}});}
 addEventListener(type,fn){const list=this.listeners.get(type)??[];list.push(fn);this.listeners.set(type,list);}
 fire(type){for(const fn of this.listeners.get(type)??[])fn({target:this,currentTarget:this,preventDefault(){}});}
 setAttribute(name,value){this.attributes[name]=value;}removeAttribute(name){delete this.attributes[name];}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;this.textContent='';}
 querySelectorAll(selector){const all=this.children.flatMap(node=>[node,...node.querySelectorAll(selector)]);return all.filter(node=>selector.split(',').includes(node.tag));}
 close(){this.open=false;this.fire('close');}focus(){this.focused=true;}pause(){}load(){}
}
const data=(revision=0,bio='')=>({revision,publicationId:null,published:null,draft:{bio,videoText:'',photo:null,video:null}});
function fixture(t){
 const ids=['presentation-editor','presentation-bio','presentation-video-text','presentation-status','presentation-feedback','presentation-error',
  'presentation-refresh','presentation-save','presentation-consent','presentation-publish','presentation-publish-form','presentation-unpublish',
  'presentation-erase-form','presentation-erase-confirm','manage-presentation',...['photo','video'].flatMap(kind=>['file','send','remove','preview','selection'].map(part=>`presentation-${part}-${kind}`))];
 const nodes=new Map(ids.map(id=>[id,new Element(id)])),$=selector=>nodes.get(selector.slice(1));
 const dialog=$('#presentation-editor');dialog.ownerDocument={createElement:tag=>new Element('',tag)};
 const mediaQuery=dialog.querySelectorAll.bind(dialog);dialog.querySelectorAll=selector=>selector==='button:not(.close-dialog),input,textarea'?[...nodes.values()]:mediaQuery(selector);
 let generation=0,session={mode:'production',user:{id:'synthetic-account'},features:{presentation:true}},refreshes=0;
 const calls=[],uploads=[],rulesErrors=[],unsettled=new Set();
 function deferred(list,record){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const call={...record,resolve:value=>{unsettled.delete(call);resolve(value);},reject:error=>{unsettled.delete(call);reject(error);}};unsettled.add(call);list.push(call);return promise;}
 const ui=createPresentationUI({$,api:(url,options={})=>deferred(calls,{url,options}),openDialog:node=>node.open=true,errorText:error=>error.code??error.message,
  getGeneration:()=>generation,getSession:()=>session,requireUGC:()=>true,onRulesError:(...args)=>rulesErrors.push(args),onPublicChange:()=>refreshes++,onReport:()=>{},upload:(...args)=>deferred(uploads,{args})});
 t.after(()=>{for(const call of unsettled)call.reject(new Error('fixture closed'));});
 async function open(value=data()){ui.openEditor();const call=calls.at(-1);assert.equal(call.url,'/api/presentation');call.resolve(value);await tick();}
 function switchAccount(){generation++;session={...session,user:{id:'different-synthetic-account'}};ui.reset();}
 return {ui,$,calls,uploads,rulesErrors,open,switchAccount,refreshes:()=>refreshes};
}

test('choosing a file never sends or publishes; an uncertain upload reuses its exact intent',async t=>{
 const f=fixture(t);await f.open();const file=new Blob(['synthetic'],{type:'image/jpeg'});
 f.$('#presentation-file-photo').files=[file];f.$('#presentation-file-photo').fire('change');assert.equal(f.uploads.length,0);
 f.$('#presentation-send-photo').fire('click');assert.equal(f.uploads.length,1);const first=f.uploads[0];
 assert.match(f.$('#presentation-selection-photo').textContent,/Envoi et préparation/);assert.equal(f.$('#presentation-feedback').textContent,'');
 first.reject(Object.assign(new Error('timeout'),{code:'request_timeout'}));await tick();
 assert.equal(f.$('#presentation-selection-photo').textContent,'request_timeout');
 assert.equal(f.$('#presentation-error').hidden,false);f.$('#presentation-send-photo').fire('click');
 assert.equal(f.uploads[1].args[1],file);assert.equal(f.uploads[1].args[2],first.args[2]);assert.equal(f.uploads[1].args[3],first.args[3]);
 f.uploads[1].resolve({presentation:data(1)});await tick();assert.equal(f.$('#presentation-send-photo').disabled,true);
 assert.equal(f.$('#presentation-selection-photo').textContent,'Média enregistré dans votre brouillon privé.');
 assert.equal(f.calls.length,1);assert.equal(f.refreshes(),0);
});

test('a private save never publishes, and publication needs a fresh explicit checkbox',async t=>{
 const f=fixture(t);await f.open();f.$('#presentation-bio').value='Texte synthétique.';
 f.$('#presentation-publish-form').fire('submit');assert.equal(f.calls.length,1);
 f.$('#presentation-save').fire('click');assert.equal(f.calls[1].options.method,'PATCH');assert.equal(f.calls[1].options.body.bio,'Texte synthétique.');
 f.calls[1].resolve(data(1,'Texte synthétique.'));await tick();assert.equal(f.calls.length,2);assert.equal(f.refreshes(),0);
 f.$('#presentation-consent').checked=true;f.$('#presentation-publish-form').fire('submit');assert.equal(f.calls[2].url,'/api/presentation/publish');
 f.calls[2].resolve({...data(2,'Texte synthétique.'),published:{bio:'Texte synthétique.',videoText:'',photo:null,video:null},publicationId:'synthetic-version'});await tick();
 assert.equal(f.$('#presentation-consent').checked,false);assert.equal(f.refreshes(),1);
});

test('an authoritative revision refusal permits a new intent after explicit refresh, without automatic retry',async t=>{
 const f=fixture(t);await f.open();f.$('#presentation-file-photo').files=[new Blob(['synthetic'],{type:'image/jpeg'})];f.$('#presentation-file-photo').fire('change');
 f.$('#presentation-send-photo').fire('click');const first=f.uploads[0];first.reject(Object.assign(new Error('changed'),{status:409,code:'presentation_changed'}));await tick();
 f.$('#presentation-refresh').fire('click');f.calls.at(-1).resolve(data(1));await tick();assert.equal(f.uploads.length,1);
 f.$('#presentation-send-photo').fire('click');assert.equal(f.uploads[1].args[2],1);assert.notEqual(f.uploads[1].args[3],first.args[3]);
 f.uploads[1].resolve({presentation:data(2)});await tick();
});

test('server rules refusal opens renewal without resending the saved draft, and late focus cannot cross accounts',async t=>{
 const f=fixture(t);await f.open();f.$('#presentation-bio').value='Brouillon à conserver.';f.$('#presentation-consent').checked=true;
 f.$('#presentation-save').fire('click');f.calls.at(-1).reject(Object.assign(new Error('rules'),{code:'rules_acceptance_required',status:403}));await tick();
 assert.equal(f.rulesErrors.length,1);assert.equal(f.$('#presentation-consent').checked,false);assert.equal(f.$('#presentation-bio').value,'Brouillon à conserver.');
 f.rulesErrors[0][1]();assert.equal(f.calls.length,2);assert.equal(f.$('#presentation-refresh').focused,true);
 f.$('#presentation-refresh').focused=false;f.switchAccount();f.rulesErrors[0][1]();assert.equal(f.$('#presentation-refresh').focused,false);
});

test('changing account between the private save and publication prevents the second write',async t=>{
 const f=fixture(t);await f.open();f.$('#presentation-bio').value='Ancien compte.';f.$('#presentation-consent').checked=true;
 f.$('#presentation-publish-form').fire('submit');assert.equal(f.calls[1].options.method,'PATCH');
 f.switchAccount();f.calls[1].resolve(data(1,'Ancien compte.'));await tick();
 assert.equal(f.calls.length,2);assert.equal(f.$('#presentation-bio').value,'');assert.equal(f.refreshes(),0);
});

test('a late refresh cannot overwrite a newer completed save or discard typing while loading',async t=>{
 const f=fixture(t);await f.open(data(1,'Initial.'));
 f.$('#presentation-refresh').fire('click');const old=f.calls.at(-1);f.$('#presentation-bio').value='En cours de saisie.';
 old.resolve(data(2,'Autre appareil.'));await tick();assert.equal(f.$('#presentation-bio').value,'En cours de saisie.');
 f.$('#presentation-refresh').fire('click');const stale=f.calls.at(-1);
 f.$('#presentation-save').fire('click');const saved=f.calls.at(-1);assert.equal(saved.options.body.expectedRevision,2);
 saved.resolve(data(3,'En cours de saisie.'));await tick();stale.resolve(data(2,'Ancien résultat.'));await tick();
 f.$('#presentation-save').fire('click');assert.equal(f.calls.at(-1).options.body.expectedRevision,3);f.calls.at(-1).resolve(data(4,'En cours de saisie.'));await tick();
});

test('an old erasure response cannot clear the next account form; reset clears destructive consent',async t=>{
 const f=fixture(t);await f.open(data(1,'Ancien.'));f.$('#presentation-erase-confirm').checked=true;f.$('#presentation-erase-form').fire('submit');const deletion=f.calls.at(-1);
 f.switchAccount();assert.equal(f.$('#presentation-erase-confirm').checked,false);await f.open(data(0,'Nouveau.'));
 deletion.resolve(data(2));await tick();assert.equal(f.$('#presentation-bio').value,'Nouveau.');assert.equal(f.refreshes(),0);
});

test('busy button feedback resets on account switch and a late result cannot change the next operation',async t=>{
 const f=fixture(t);await f.open();const button=f.$('#presentation-save');button.tagName='BUTTON';button.textContent='Garder en brouillon privé';f.$('#presentation-editor').ownerDocument.activeElement=button;
 button.fire('click');const old=f.calls.at(-1);assert.equal(button.textContent,'Enregistrement en cours…');
 f.switchAccount();assert.equal(button.textContent,'Garder en brouillon privé');await f.open();button.fire('click');const next=f.calls.at(-1);
 old.resolve(data(1));await tick();assert.equal(button.textContent,'Enregistrement en cours…');
 next.resolve(data(1));await tick();assert.equal(button.textContent,'Garder en brouillon privé');
});

test('upload wrapper sends binary data once, with revision and retry key, and has a total timeout',async()=>{
 const file=new Blob(['synthetic'],{type:'video/quicktime'}),calls=[];
 const result=await uploadPresentation('video',file,3,'synthetic-retry-key',{fetcher:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({accepted:true})};}});
 assert.deepEqual(result,{accepted:true});assert.equal(calls.length,1);assert.equal(calls[0].options.body,file);assert.equal(calls[0].options.headers['X-Presentation-Revision'],'3');assert.equal(calls[0].options.cache,'no-store');
 await assert.rejects(uploadPresentation('photo',file,0,'key'),error=>error.code==='unsupported_presentation_type');
 let attempts=0;await assert.rejects(uploadPresentation('video',file,3,'same-key',{timeoutMs:20,fetcher:async(url,{signal})=>{attempts++;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));}}),error=>error.code==='request_timeout');assert.equal(attempts,1);
});
