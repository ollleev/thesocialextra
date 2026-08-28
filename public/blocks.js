// Blocking never needs a conversation or discloses the blocked account's identity.
export function createBlockUI({ $, api, requireAccount, getGeneration, openDialog, errorText, toast, onRevision, refreshFeed }) {
  let target=null, generation=0, entries=[], nextCursor=null, pending=false, listRevision=null, reloadRequested=false;
  const current=(request,account,dialog)=>request===generation&&account===getGeneration()&&$(dialog).open;
  function reset() {
    generation++;target=null;entries=[];nextCursor=null;pending=false;listRevision=null;reloadRequested=false;
    $('#blocked-list').replaceChildren();$('#blocks-status').textContent='';
    $('#blocks-error').hidden=true;$('#block-author-error').hidden=true;
    $('#blocks-more').hidden=true;$('#blocks-refresh').disabled=false;$('#confirm-block-author').disabled=false;
  }
  function render() {
    const fragment=document.createDocumentFragment();
    for(const entry of entries) {
      const row=document.createElement('div');row.className='blocked-row';
      const label=document.createElement('p');
      label.textContent=`Blocage du ${new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short'}).format(entry.createdAt)}`;
      const ref=document.createElement('small');ref.textContent=`Repère ${entry.id.slice(-8)}`;label.append(ref);
      const button=document.createElement('button');button.className='button outline';button.textContent='Débloquer';
      button.setAttribute('aria-label',`Débloquer le repère ${entry.id.slice(-8)}`);
      button.addEventListener('click',()=>unblock(entry.id,button));row.append(label,button);fragment.append(row);
    }
    $('#blocked-list').replaceChildren(fragment);
    $('#blocks-status').textContent=entries.length?`${entries.length} blocage${entries.length>1?'s':''} affiché${entries.length>1?'s':''}.`:'Aucun compte bloqué.';
    $('#blocks-more').hidden=!nextCursor;
  }
  async function load(more=false) {
    if(pending||!$('#blocks').open)return;
    const request=++generation,account=getGeneration(),cursor=more?nextCursor:null;
    if(more&&!cursor)return;
    pending=true;$('#blocks-error').hidden=true;$('#blocks-refresh').disabled=true;$('#blocks-more').disabled=true;
    if(!more)$('#blocks-status').textContent='Chargement des blocages…';
    try {
      const data=await api(`/api/blocks${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`);
      if(!current(request,account,'#blocks'))return;
      if(!onRevision(data)){$('#blocks-status').textContent='Les blocages ont changé. Actualisez la liste.';return;}
      if(more&&data.feedRevision!==listRevision){pending=false;return load();}
      const merged=new Map((more?entries:[]).map(entry=>[entry.id,entry]));
      for(const entry of data.blocks)merged.set(entry.id,entry);
      entries=[...merged.values()];nextCursor=data.nextCursor;listRevision=data.feedRevision;render();
    }catch(error){if(current(request,account,'#blocks')){$('#blocks-error').textContent=errorText(error);$('#blocks-error').hidden=false;$('#blocks-status').textContent='Liste non actualisée. Réessayez.';}}
    finally{if(request===generation){pending=false;$('#blocks-refresh').disabled=false;$('#blocks-more').disabled=false;if(reloadRequested){reloadRequested=false;void load();}}}
  }
  async function unblock(id,button) {
    if(button.disabled)return;const account=getGeneration(),request=generation;button.disabled=true;$('#blocks-error').hidden=true;
    try {
      const data=await api(`/api/blocks/${encodeURIComponent(id)}`,{method:'DELETE'});
      if(account!==getGeneration())return;
      onRevision(data);void refreshFeed();
      if(current(request,account,'#blocks')){entries=entries.filter(entry=>entry.id!==id);render();toast('Compte débloqué. Ses annonces peuvent réapparaître.');}
    }catch(error){if(current(request,account,'#blocks')){$('#blocks-error').textContent=errorText(error);$('#blocks-error').hidden=false;}}
    finally{if(current(request,account,'#blocks'))button.disabled=false;}
  }
  function showAuthor(postId) {
    if(!postId||!requireAccount(()=>showAuthor(postId)))return;
    reset();target=postId;openDialog($('#block-author'));
  }
  function showList() {
    if(!requireAccount(showList))return;
    reset();openDialog($('#blocks'));void load();
  }
  $('#confirm-block-author').addEventListener('click',async()=>{
    const id=target,request=generation,account=getGeneration(),button=$('#confirm-block-author');
    if(!id||button.disabled)return;button.disabled=true;$('#block-author-error').hidden=true;
    try {
      const data=await api(`/api/posts/${encodeURIComponent(id)}/block`,{method:'POST',body:{}});
      if(account!==getGeneration())return;
      onRevision(data);void refreshFeed();
      if(current(request,account,'#block-author')){$('#block-author').close();toast('Compte bloqué. Ses annonces sont masquées pour vous.');}
    }catch(error){if(current(request,account,'#block-author')){$('#block-author-error').textContent=errorText(error);$('#block-author-error').hidden=false;}}
    finally{if(request===generation)button.disabled=false;}
  });
  $('#manage-blocks').addEventListener('click',showList);
  $('#blocks-refresh').addEventListener('click',()=>load());
  $('#blocks-more').addEventListener('click',()=>load(true));
  for(const id of ['#blocks','#block-author'])$(id).addEventListener('close',()=>{if(!$('#blocks').open&&!$('#block-author').open)reset();});
  return {reset,showAuthor,showList,refreshIfOpen(){if(!$('#blocks').open)return;if(pending)reloadRequested=true;else void load();}};
}
