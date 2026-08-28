import { EventPostPreviewState, renderEventPostPreview } from './event-post-preview.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const problem = code => Object.assign(new Error(code), {code, definitive:true});

// UI bridge only: private plan reads stay with EventPlansClient. The injected
// publication callback receives only the public draft and its idempotency key.
export function createEventPublishingUI({$, client, cities, getSession, getRoles, openDialog, requireUGC, onRulesError, onLogin, publishPost, onViewPost, onChange}) {
  const dialog=$('#event-post-preview'), content=$('#event-post-preview-content'), records=new Map();
  let active=null, ticket=0;
  const keyFor=(entry,needId)=>`${entry.id}:${needId}`;
  const pending=id=>[...records.values()].some(r=>r.entry.id===id && ['sending','uncertain'].includes(r.flow.snapshot().phase));
  function render() {
    if(!active)return;
    const focused=content.ownerDocument.activeElement;
    const name=content.contains(focused)?focused.name:null;
    const selection=name&&typeof focused.selectionStart==='number'?[focused.selectionStart,focused.selectionEnd]:null;
    const snapshot=active.flow.snapshot();
    content.innerHTML=renderEventPostPreview(snapshot);
    if(snapshot.errorCode==='login_required')content.insertAdjacentHTML('beforeend','<button type="button" class="button outline" data-preview-action="login">Renouveler ma session</button>');
    if(name){const field=[...content.querySelectorAll('[name]')].find(n=>n.name===name);if(field&&!field.disabled){field.focus({preventScroll:true});if(selection&&field.setSelectionRange)field.setSelectionRange(...selection);}}
  }
  function build(entry,need) {
    const epoch=client.epoch, record={entry,needId:need.id,revision:entry.saved.revision,flow:null};
    record.flow=new EventPostPreviewState({
      role:need.role,cityLabel:cities.label(entry.saved.cityId),remaining:need.quantity-need.confirmed,
      makeKey:()=>crypto.randomUUID(),
      derive:options=>epoch===client.epoch&&client.current===entry?client.preparePost(need.id,{...options,roles:getRoles()}):{ok:false,code:'event_draft_unavailable'},
      send:async({draft,source,key,retry})=>{
        if(epoch!==client.epoch||!getSession().user)throw problem('login_required');
        if(!retry){
          try{await client.verifyPostSource(source,draft,getRoles());}
          catch(error){error.definitive=true;throw error;}
        }
        if(epoch!==client.epoch||!getSession().user)throw problem('login_required');
        try{return await publishPost({draft,key});}
        catch(error){
          if(epoch===client.epoch&&['rules_acceptance_required','rules_version_changed'].includes(error.code))onRulesError(error,()=>{if(epoch===client.epoch&&active===record){render();openDialog(dialog);}});
          throw error;
        }
      },
      onChange:()=>{if(epoch!==client.epoch)return;onChange();if(active===record)render();},
    });
    return record;
  }
  async function show(entry,needId) {
    if(!entry?.saved||!getSession().user)return;
    const request=++ticket,epoch=client.epoch;
    await cities.ensure(entry.saved.cityId);
    if(request!==ticket||epoch!==client.epoch||client.current!==entry)return;
    const need=entry.saved.needs.find(n=>n.id===needId);if(!need)return;
    const key=keyFor(entry,needId);let record=records.get(key);
    if(!record){record=build(entry,need);records.set(key,record);}
    else if(record.revision!==entry.saved.revision&&record.flow.snapshot().phase==='editing'){
      const options=record.flow.snapshot().options;record.flow.reset();record=build(entry,need);record.flow.edit(options);records.set(key,record);
    }
    active=record;render();openDialog(dialog);content.querySelector('h2')?.setAttribute('tabindex','-1');content.querySelector('h2')?.focus();
  }
  async function publish() {
    const record=active,epoch=client.epoch;if(!record)return;
    if(!requireUGC(()=>{if(active===record&&epoch===client.epoch){render();openDialog(dialog);content.querySelector('button[type=submit], [data-preview-action=retry]')?.focus();}}))return;
    const success=await record.flow.publish();
    if(success&&active===record&&dialog.open){content.querySelector('[role=status]')?.setAttribute('tabindex','-1');content.querySelector('[role=status]')?.focus();}
  }
  content.addEventListener('input',event=>{
    if(!active||!['places','durationMinutes','extraNote'].includes(event.target.name))return;
    const {name,value}=event.target;active.flow.edit({[name]:name==='extraNote'?value:value===''?undefined:Number(value)});
  });
  content.addEventListener('submit',event=>{if(event.target.id==='event-post-preview-form'){event.preventDefault();void publish();}});
  content.addEventListener('click',event=>{
    const button=event.target.closest('[data-preview-action]');if(!button||button.disabled||!active)return;
    const action=button.dataset.previewAction;
    if(action==='retry')void publish();
    if(action==='view'){const id=active.flow.snapshot().postId;if(id){dialog.close();onViewPost(id);}}
    if(action==='login')void onLogin();
    if(action==='new'){
      const record=active,entry=record.entry,need=entry.saved?.needs.find(n=>n.id===record.needId);
      if(!need||client.current!==entry||record.flow.snapshot().phase!=='success')return;
      active=build(entry,need);records.set(keyFor(entry,need.id),active);render();onChange();content.querySelector('select')?.focus();
    }
  });
  dialog.addEventListener('close',()=>{
    if(content.ownerDocument.querySelector('dialog[open]'))return;
    const record=active;if(!record||client.current!==record.entry)return;
    const opener=[...$('#event-plans-panel').querySelectorAll('[data-event-action=publish]')].find(n=>n.dataset.id===record.needId);
    (opener||$('#event-title'))?.focus({preventScroll:true});
  });
  function actions(entry) {
    if(!entry?.saved)return '<p class="event-help">Enregistrez l’événement pour préparer une annonce publique à partir de ses besoins.</p>';
    const blocked=entry.busy||entry.intent||entry.conflict||entry.gone||client.dirty(entry)||!getRoles().length;
    return `<section class="event-publish-needs"><h2>Publier un besoin</h2><p class="event-help">Relisez chaque annonce avant de la publier. L’événement et ses consignes restent privés. Chaque annonce couvre jusqu’à 8 places ; aucun découpage automatique.</p>${client.dirty(entry)?'<p class="event-help">Enregistrez vos modifications avant de préparer une nouvelle annonce.</p>':''}${entry.saved.needs.map(need=>{
      const record=records.get(keyFor(entry,need.id)),phase=record?.flow.snapshot().phase;
      const resume=phase==='uncertain'||phase==='success'||phase==='sending';
      const label=phase==='uncertain'?'Vérifier la publication':phase==='sending'?'Publication en cours…':phase==='success'?'Voir la publication':'Préparer une annonce';
      return `<div class="event-publish-need"><div><strong>${esc(need.role)}</strong><span>${need.quantity-need.confirmed} personne${need.quantity-need.confirmed>1?'s':''} restante${need.quantity-need.confirmed>1?'s':''} selon vos confirmations</span></div><button type="button" class="button outline" data-event-action="publish" data-id="${esc(need.id)}" ${!resume&&(blocked||need.quantity===need.confirmed)?'disabled':''}>${label}</button></div>`;
    }).join('')}</section>`;
  }
  return {show,actions,pending,
    hide(){ticket++;active=null;dialog.close();},
    reset(){ticket++;active=null;dialog.close();content.replaceChildren();const old=[...records.values()];records.clear();for(const r of old)r.flow.reset();},
    hasDraft(){return [...records.values()].some(r=>{const s=r.flow.snapshot();return s.busy||s.phase==='uncertain'||s.phase==='editing'&&Object.keys(s.options).length>0;});},
  };
}
