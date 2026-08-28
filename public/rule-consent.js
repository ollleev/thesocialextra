export function rulesMetadata(value) {
  if(!value||typeof value.version!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,79}$/.test(value.version)
    ||value.url!==`/rules/${value.version}.html`||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256))return null;
  return {version:value.version,url:value.url,sha256:value.sha256,accepted:value.accepted===true};
}

// This dialog is stacked above the current form. Closing a conversation just to
// renew its rules would destroy a ready voice draft through the chat close hook.
export function createRulesUI({$,api,getSession,getGeneration,refreshSession,applyRules,errorText,beforeOpen=()=>{}}) {
  const dialog=$('#rules-consent');let shown=null,resume=null,revision=0,busy=false;
  function reset() {
    revision++;shown=null;resume=null;busy=false;$('#rules-agree').checked=false;
    $('#rules-error').hidden=true;$('#rules-accept').disabled=true;$('#rules-retry').disabled=false;
  }
  function render() {
    const next=rulesMetadata(getSession().rules);
    if(next?.version!==shown?.version||next?.sha256!==shown?.sha256){revision++;$('#rules-agree').checked=false;busy=false;}
    shown=next;
    $('#rules-document').hidden=!shown;$('#rules-agree').disabled=!shown;$('#rules-accept').disabled=!shown||busy;
    $('#rules-version').textContent=shown?`Version ${shown.version}`:'Les règles doivent être chargées avant de continuer.';
    if(shown)$('#rules-document').setAttribute('href',shown.url);else $('#rules-document').removeAttribute('href');
  }
  function current(ticket,account){return ticket===revision&&account===getGeneration()&&dialog.open;}
  async function reload() {
    const account=getGeneration(),ticket=revision;$('#rules-retry').disabled=true;
    try {await refreshSession();if(current(ticket,account)){render();$('#rules-error').hidden=true;}}
    catch(error){if(current(ticket,account)){$('#rules-error').textContent=errorText(error);$('#rules-error').hidden=false;}}
    finally{if(account===getGeneration())$('#rules-retry').disabled=false;}
  }
  function show(next) {
    reset();resume=next;beforeOpen();render();if(!dialog.open)dialog.showModal();
    if(!shown)void reload();
  }
  $('#rules-form').addEventListener('submit',async event=>{
    event.preventDefault();if(busy||!shown||!$('#rules-agree').checked||!getSession().user)return;
    const account=getGeneration(),ticket=revision,agreed=shown;busy=true;$('#rules-accept').disabled=true;$('#rules-error').hidden=true;
    try {
      const data=await api('/api/account/rules-acceptance',{method:'POST',body:{acceptedRules:true,rulesVersion:agreed.version}});
      if(!current(ticket,account))return;
      const accepted=rulesMetadata(data.rules);
      if(!accepted?.accepted||accepted.version!==agreed.version||accepted.sha256!==agreed.sha256)throw new Error('invalid_rules_response');
      applyRules(accepted);const next=resume;resume=null;dialog.close();next?.();
    }catch(error){
      if(!current(ticket,account))return;
      if(error.code==='rules_version_changed') {try{await refreshSession();if(account===getGeneration()&&dialog.open)render();}catch{/* Keep the prior version visible and require an explicit retry. */}}
      if(account===getGeneration()&&dialog.open){$('#rules-error').textContent=errorText(error);$('#rules-error').hidden=false;}
    }finally{if(current(ticket,account)){busy=false;$('#rules-accept').disabled=!shown;}}
  });
  $('#rules-retry').addEventListener('click',reload);
  $('#rules-cancel').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{if(!dialog.open)reset();});
  return {
    reset(){dialog.close();reset();},
    changed(){if(dialog.open)render();},
    require(next){if(getSession().mode!=='production'||rulesMetadata(getSession().rules)?.accepted)return true;show(next);return false;},
    async renew(next){const account=getGeneration();try{await refreshSession();}catch{/* Display retry without discarding the original form. */}if(account===getGeneration()&&getSession().user)show(next);},
  };
}
