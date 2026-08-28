const TYPES={photo:new Set(['image/jpeg','image/png','image/webp']),video:new Set(['video/mp4','video/webm','video/quicktime'])};
const LIMITS={photo:8*1024**2,video:20*1024**2};
const failure=code=>Object.assign(new Error(code),{code});

// Files and retry identities live in this page only. Never serialize a file,
// biography, source name or upload body into browser storage, URLs or analytics.
export async function uploadPresentation(kind,file,revision,key,{fetcher=fetch,timeoutMs=40000,signal}={}) {
 if(!TYPES[kind]?.has(file?.type))throw failure('unsupported_presentation_type');
 if(!file.size||file.size>LIMITS[kind])throw failure('presentation_input_too_large');
 const controller=new AbortController(),abort=()=>controller.abort();
 if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,timeoutMs);
 try {
  const response=await fetcher(`/api/presentation/${kind}`,{method:'PUT',cache:'no-store',signal:controller.signal,
   headers:{'Content-Type':file.type,'X-Presentation-Revision':String(revision),'Idempotency-Key':key},body:file});
  const data=await response.json();if(!response.ok)throw Object.assign(failure(data.error||'request_failed'),{status:response.status});return data;
 } catch(error) {if(controller.signal.aborted)throw failure('request_timeout');throw error;}
 finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}

export function presentationError(error,fallback) {
 const messages={
  presentation_changed:'La présentation a changé sur un autre appareil. Actualisez, vérifiez la version et réessayez. Rien n’a été remplacé.',
  presentation_empty:'Ajoutez une phrase, une photo ou une courte vidéo.',
  presentation_video_text_required:'Ajoutez le résumé écrit de votre vidéo pour les personnes qui ne peuvent pas l’écouter.',
  presentation_input_too_large:'Choisissez une photo de 8 Mo maximum ou une vidéo de 20 Mo maximum.',
  unsupported_presentation_type:'Photo : JPEG, PNG ou WebP. Vidéo : MP4, MOV ou WebM.',
  invalid_image:'Cette photo ne peut pas être lue. Choisissez un autre fichier.',invalid_video:'Cette vidéo ne peut pas être lue. Choisissez un autre fichier.',
  animated_image_not_supported:'Choisissez une photo fixe, sans animation.',
  image_dimensions_exceeded:'Cette photo dépasse 12 mégapixels. Exportez-en une version plus petite.',
  video_color_unsupported:'Cette vidéo HDR ou à gamme étendue n’est pas prise en charge. Exportez une version SDR.',
  video_frame_rate_exceeded:'Choisissez une vidéo à 30 images par seconde maximum.',
  video_dimensions_exceeded:'Choisissez une vidéo en 1080p maximum.',video_too_long:'La vidéo dépasse 15 secondes. Préparez une version plus courte.',
  presentation_busy:'Un média est en cours de traitement. Attendez un instant puis réessayez.',
  presentation_download_busy:'Les médias sont momentanément occupés. Réessayez dans un instant.',
  presentation_upload_unavailable:'Cette ancienne tentative a été retirée. Choisissez à nouveau le fichier si vous souhaitez le renvoyer.',
  presentation_account_capacity_reached:'Votre espace de présentation est plein. Retirez un ancien média du brouillon avant de réessayer.',
  presentation_total_capacity_reached:'Le stockage des présentations est plein. Votre ancienne version reste intacte. Réessayez plus tard.',
  report_presentation_capacity_reached:'Le stockage des preuves est plein. Aucun signalement enregistré. Vous pouvez bloquer ce compte et réessayer plus tard.',
  presentation_not_found:'Cette présentation n’est plus disponible.',presentation_asset_not_found:'Ce média a été retiré ou remplacé. Actualisez la présentation.',
 };
 if(messages[error.code])return messages[error.code];
 if(/(?:image|video|presentation)_processing_(timeout|unavailable|failed|limit)$/.test(error.code??''))return 'Le média n’a pas pu être préparé. Votre fichier reste sélectionné ; réessayez ou choisissez un fichier plus petit.';
 return fallback(error);
}

export function createPresentationUI({$,api,openDialog,errorText,getGeneration,getSession,requireUGC,onRulesError=()=>{},onPublicChange,onReport,now=Date.now,upload=uploadPresentation}) {
 const dialog=$('#presentation-editor');let current=null,busy=false,readId=0,operationId=0,uploadController=null,busyButton=null;
 const pending=new Map();let visible=null,viewId=0;
 const message=error=>presentationError(error,errorText);
 const active=()=>getSession().mode==='production'&&Boolean(getSession().user)&&getSession().features?.presentation===true;
 const text=()=>({bio:$('#presentation-bio').value.trim(),videoText:$('#presentation-video-text').value.trim()});
 const dirty=()=>current&&(text().bio!==current.draft.bio||text().videoText!==current.draft.videoText);
 function restoreButton(){if(busyButton){busyButton.node.textContent=busyButton.label;busyButton=null;}}
 function stop(root,remove=true) {
  root?.querySelectorAll('video,audio').forEach(media=>{media.pause();if(remove){media.removeAttribute('src');media.load();}});
  if(remove)root?.querySelectorAll('img').forEach(image=>image.removeAttribute('src'));
 }
 function setBusy(value) {
  busy=value;dialog.setAttribute('aria-busy',String(value));
  dialog.querySelectorAll('button:not(.close-dialog),input,textarea').forEach(control=>{control.disabled=value||!current;});
  $('#presentation-refresh').disabled=value;
  for(const kind of ['photo','video'])$(`#presentation-send-${kind}`).disabled=value||!current||!pending.has(kind);
 }
 function render({preserveText=false}={}) {
  if(!current)return;
  if(!preserveText){$('#presentation-bio').value=current.draft.bio;$('#presentation-video-text').value=current.draft.videoText;}
  $('#presentation-status').textContent=current.published?'Une version est publiée sur vos annonces ouvertes. Les changements ci-dessous restent privés jusqu’à publication.':'Votre présentation est privée. Vous choisissez quand la publier.';
  $('#presentation-unpublish').hidden=!current.published;
  for(const kind of ['photo','video']) {
   const preview=$(`#presentation-preview-${kind}`),asset=current.draft[kind];stop(preview);preview.replaceChildren();
   $(`#presentation-remove-${kind}`).hidden=!asset;
   if(asset) {
    const node=dialog.ownerDocument.createElement(kind==='photo'?'img':'video');
    if(kind==='photo'){node.alt='Aperçu de votre photo de présentation';node.width=asset.width;node.height=asset.height;}
    else {node.controls=true;node.preload='none';node.playsInline=true;node.setAttribute('aria-label','Aperçu de votre vidéo de présentation');}
    node.src=`/api/presentation/${kind}?revision=${current.revision}`;preview.append(node);
   }
  }
  setBusy(busy);
 }
 async function load() {
  if(busy||!active())return;const id=++readId,account=getGeneration();
  $('#presentation-error').hidden=true;$('#presentation-feedback').textContent='Chargement de votre présentation…';
  try {
   const data=await api('/api/presentation');if(id!==readId||account!==getGeneration()||!active())return;
   const preserveText=Boolean(dirty());current=data;$('#presentation-consent').checked=false;render({preserveText});$('#presentation-feedback').textContent=preserveText?'Version actualisée. Votre texte non enregistré est conservé : vérifiez-le avant de publier.':'';
  }catch(error){if(id===readId&&account===getGeneration()){$('#presentation-error').textContent=message(error);$('#presentation-error').hidden=false;$('#presentation-feedback').textContent='';}}
 }
 async function run(action,success,{progress='Enregistrement en cours…',feedback=$('#presentation-feedback')}={}) {
  if(busy||!current||!active())return;const id=++operationId,account=getGeneration(),trigger=dialog.ownerDocument.activeElement;
  const buttonLabel=trigger?.tagName==='BUTTON'?trigger.textContent:null;
  ++readId;setBusy(true);$('#presentation-error').hidden=true;$('#presentation-feedback').textContent='';feedback.textContent=progress;
  if(buttonLabel!==null){busyButton={node:trigger,label:buttonLabel};trigger.textContent=progress;}
  try {
   const result=await action();if(id!==operationId||account!==getGeneration()||!active())return;
   current=result.presentation??result;$('#presentation-consent').checked=false;render({preserveText:true});feedback.textContent=success;
  }catch(error){if(id===operationId&&account===getGeneration()){
   $('#presentation-error').textContent=message(error);$('#presentation-error').hidden=false;
   feedback.textContent=message(error);
   if(feedback===$('#presentation-feedback'))$('#presentation-error').scrollIntoView?.({block:'nearest'});
   if(['rules_acceptance_required','rules_version_changed'].includes(error.code)){
    $('#presentation-consent').checked=false;onRulesError(error,()=>{if(account===getGeneration()&&dialog.open)(trigger?.isConnected?trigger:$('#presentation-refresh')).focus();},account);
   }
  }}
  finally {if(id===operationId&&account===getGeneration()){restoreButton();setBusy(false);}}
 }
 function openEditor() {if(!active())return;$('#presentation-erase-confirm').checked=false;openDialog(dialog);setBusy(busy);void load();}
 $('#manage-presentation').addEventListener('click',openEditor);
 $('#presentation-refresh').addEventListener('click',load);
 $('#presentation-save').addEventListener('click',()=>{
  if(!requireUGC(()=>$('#presentation-save').focus()))return;
  void run(()=>api('/api/presentation',{method:'PATCH',body:{expectedRevision:current.revision,...text()}}),'Brouillon enregistré. Rien de nouveau n’est public.');
 });
 for(const kind of ['photo','video']) {
  const file=$(`#presentation-file-${kind}`);
  file.addEventListener('change',()=>{
   const selected=file.files?.[0];pending.delete(kind);$('#presentation-consent').checked=false;
   if(selected)pending.set(kind,{file:selected,intent:null});setBusy(busy);
   $(`#presentation-selection-${kind}`).textContent=selected?'Fichier sélectionné sur cet appareil. Appuyez sur « Enregistrer » pour l’envoyer dans votre brouillon.':'';
  });
  $(`#presentation-send-${kind}`).addEventListener('click',()=>{
   if(!requireUGC(()=>$(`#presentation-send-${kind}`).focus()))return;
   const entry=pending.get(kind);if(!entry)return;
   void run(async()=>{
    entry.intent??={revision:current.revision,key:crypto.randomUUID()};uploadController=new AbortController();
    let result;
    try {result=await upload(kind,entry.file,entry.intent.revision,entry.intent.key,{signal:uploadController.signal});}
    catch(error) {
     // A definitive revision refusal made no write. Keep uncertain network
     // retries identical, but let an explicit refresh+click use the new revision.
     if(error.status===409&&error.code==='presentation_changed'&&pending.get(kind)===entry)entry.intent=null;
     throw error;
    }
    if(pending.get(kind)===entry){pending.delete(kind);file.value='';$(`#presentation-selection-${kind}`).textContent='';}
    return result;
   },'Média enregistré dans votre brouillon privé.',{progress:'Envoi et préparation du média… Cela peut prendre quelques secondes.',feedback:$(`#presentation-selection-${kind}`)});
  });
  $(`#presentation-remove-${kind}`).addEventListener('click',()=>void run(()=>api(`/api/presentation/${kind}`,{method:'DELETE',body:{expectedRevision:current.revision}}),'Média retiré du brouillon. La version publiée reste inchangée jusqu’à votre prochaine publication ou son retrait.',{progress:'Retrait du média en cours…',feedback:$(`#presentation-selection-${kind}`)}));
 }
 $('#presentation-publish-form').addEventListener('submit',event=>{
  event.preventDefault();if(!$('#presentation-consent').checked||!requireUGC(()=>$('#presentation-publish').focus()))return;
  void run(async()=>{
   const account=getGeneration();
   let revision=current.revision;
   if(dirty()){const saved=await api('/api/presentation',{method:'PATCH',body:{expectedRevision:revision,...text()}});if(account!==getGeneration())throw failure('login_required');revision=saved.revision;}
   const result=await api('/api/presentation/publish',{method:'POST',body:{expectedRevision:revision,publicConsent:true}});
   if(account===getGeneration())void onPublicChange();return result;
  },'Présentation publiée sur vos annonces ouvertes. Elle sera aussi visible sur vos prochaines annonces, jusqu’à son retrait.');
 });
 $('#presentation-unpublish').addEventListener('click',()=>void run(async()=>{const result=await api('/api/presentation/unpublish',{method:'POST',body:{expectedRevision:current.revision}});void onPublicChange();return result;},'Présentation retirée de toutes vos annonces. Le brouillon reste privé.'));
 $('#presentation-erase-form').addEventListener('submit',event=>{
  event.preventDefault();if(!$('#presentation-erase-confirm').checked)return;
  void run(async()=>{
   const account=getGeneration();
   const result=await api('/api/presentation',{method:'DELETE',body:{expectedRevision:current.revision}});
   if(account!==getGeneration())throw failure('login_required');
   pending.clear();for(const kind of ['photo','video']){$(`#presentation-file-${kind}`).value='';$(`#presentation-selection-${kind}`).textContent='';}
   $('#presentation-bio').value='';$('#presentation-video-text').value='';$('#presentation-erase-confirm').checked=false;void onPublicChange();return result;
  },'Présentation et brouillon effacés de la base active. Les preuves de signalement et sauvegardes suivent leurs durées indiquées dans la confidentialité.');
 });
 dialog.addEventListener('close',()=>{if(!dialog.open)stop(dialog);});

 async function readPost(post,section) {
  const id=++viewId,account=getGeneration(),content=section.querySelector('[data-presentation-content]');
  stop(content);content.replaceChildren();visible=null;content.textContent='Chargement de la présentation…';
  try {
   const data=await api(`/api/posts/${post.id}/presentation`);
   if(id!==viewId||account!==getGeneration()||!section.isConnected||!section.open)return;
   if(data.publicationId!==post.presentationId)throw failure('presentation_changed');
   content.replaceChildren();const doc=section.ownerDocument;
   if(data.bio){const bio=doc.createElement('p');bio.textContent=data.bio;content.append(bio);}
   for(const kind of ['photo','video'])if(data[kind]) {
    const media=doc.createElement(kind==='photo'?'img':'video');
    if(kind==='photo'){media.alt='Photo de présentation publiée par la personne';media.width=data.photo.width;media.height=data.photo.height;}
    else {media.controls=true;media.preload='none';media.playsInline=true;media.setAttribute('aria-label','Vidéo de présentation');}
    media.src=`/api/posts/${encodeURIComponent(post.id)}/presentation/${kind}?v=${encodeURIComponent(data.publicationId)}`;content.append(media);
   }
   if(data.videoText){const summary=doc.createElement('p');summary.textContent=data.videoText;content.append(summary);}
   const disclaimer=doc.createElement('p');disclaimer.className='field-help';disclaimer.textContent='Présentation facultative. Les compétences et l’identité ne sont pas vérifiées.';content.append(disclaimer);
   const report=doc.createElement('button');report.type='button';report.className='text-button';report.textContent='Signaler cette présentation';report.addEventListener('click',()=>onReport(post.id,data.publicationId));content.append(report);
   visible={postId:post.id,version:data.publicationId,section};
  }catch(error){if(id===viewId&&account===getGeneration()&&section.isConnected){content.textContent=message(error);}}
 }
 function updatePost(post) {
  const section=$('#detail-presentation');if(!section)return;
  const available=Boolean(post?.presentationId&&post.status==='open'&&post.expiresAt>now()&&getSession().features?.presentation);
  const changed=section.dataset.version!==post?.presentationId||section.dataset.post!==post?.id;
  section.hidden=!available;
  if(!available||changed){viewId++;visible=null;stop(section);section.querySelector('[data-presentation-content]').replaceChildren();}
  section.dataset.version=post?.presentationId??'';section.dataset.post=post?.id??'';
  section.onTogglePost=post;
  if(!section.dataset.bound){section.dataset.bound='true';section.addEventListener('toggle',()=>{if(section.open&&!section.hidden)void readPost(section.onTogglePost,section);else{viewId++;visible=null;stop(section);}});}
  if(available&&changed&&section.open)void readPost(post,section);
 }
 return {openEditor,updatePost,
  changed(){ $('#manage-presentation').hidden=!active(); },
  stopView(){viewId++;visible=null;stop($('#detail-presentation'));},
  reset(){readId++;operationId++;viewId++;restoreButton();uploadController?.abort();uploadController=null;pending.clear();current=null;busy=false;visible=null;stop(dialog);dialog.close();$('#presentation-bio').value='';$('#presentation-video-text').value='';$('#presentation-consent').checked=false;$('#presentation-erase-confirm').checked=false;for(const kind of ['photo','video']){$(`#presentation-file-${kind}`).value='';$(`#presentation-preview-${kind}`).replaceChildren();$(`#presentation-selection-${kind}`).textContent='';}$('#presentation-status').textContent='';$('#presentation-feedback').textContent='';$('#presentation-error').hidden=true;setBusy(false);},
 };
}
