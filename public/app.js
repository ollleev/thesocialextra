import { icons } from './icons.js';
import { LocalMap } from './map.js';
import { mergeSummary, markRead, unreadCount, freshPost, suggestedDraft } from './updates.js';
import { MessageOutbox, requestJSON as api } from './requests.js';
import { createAccountUI } from './accounts.js';
import { makeFeedShare, parseFeedLink } from './sharing.js';
import { VoiceComposer, uploadVoice } from './voice.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function icon(name, extra = '') {
  const nodes = icons[name] || icons['radio'];
  return `<svg ${extra} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${nodes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== 'key').map(([key, val]) => `${key}="${esc(val)}"`).join(' ')} />`).join('')}</svg>`;
}
function hydrate(root = document) { root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); }); }
hydrate();

// Per-tab ownership: no permanent account or cross-user contact identity.
function readSession(key) { try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; } }
const owners = readSession('extras-owner');
const threads = readSession('extras-threads');
function saveSession() { try {
  if (state.production) { if (state.user) sessionStorage.setItem(`thesocialextra-read:${state.user.id}`, JSON.stringify(Object.fromEntries(Object.entries(threads).map(([id,t])=>[id,{readIncomingCount:t.readIncomingCount||0}])))); }
  else { sessionStorage.setItem('extras-owner', JSON.stringify(owners)); sessionStorage.setItem('extras-threads', JSON.stringify(threads)); }
} catch { toast('Stockage de session indisponible : gardez cette fenêtre ouverte.'); } }
const state = { posts: [], zones: [], kind: 'all', zone: 'all', role: 'all', sort: 'recent', english: false, vehicle: false, mine: false, selected: null, connected: false, offset: 0, formKind: 'available', detailId: null, chat: null };
state.city = { id: '2988507', name: 'Paris', label: 'Paris · FR', country: 'FR', lat: 48.85, lng: 2.35, timezone: 'Europe/Paris' };
state.point = null;
const mutationKeys = new Map();
const mutationsInFlight = new Set();
const outbox = new MessageOutbox();
const voice = new VoiceComposer({ onChange: renderVoice });
const writeIntents = new Map();
function writeKey(scope,payload) {
  const text=JSON.stringify(payload),previous=writeIntents.get(scope);
  if(previous?.text===text) return previous.key;
  const entry={text,key:crypto.randomUUID()};writeIntents.set(scope,entry);return entry.key;
}
let accountGeneration=0,privateRevision=0,feedGeneration=0,events=null,liveReady=false,lastSnapshot=null;
const accounts = createAccountUI({openDialog,onError:errorText,onChange:async session=>{
  const changed=state.user?.id!==session.user?.id || state.production!==(session.mode==='production');
  const hadUser=Boolean(state.user);
  state.production=session.mode==='production';state.user=session.user;state.moderator=session.moderator;state.voiceEnabled=Boolean(session.features?.voice);
  $('#account-button').hidden=!state.production;
  $('#account-button').textContent=state.user?'Mon compte':'Connexion';
  $('#moderation-button').hidden=!session.moderator;
  if(state.production) {
    if(changed) {
      accountGeneration++; for(const id of Object.keys(threads)) delete threads[id];
      voice.discard();stopAudio($('#chat'),true);stopAudio($('#moderation'),true);
      outbox.retain(new Set());writeIntents.clear();mutationKeys.clear();state.chat=null;
      state.mine=false;state.posts=[];state.readMarkers=state.user?readSession(`thesocialextra-read:${state.user.id}`):{};
      $('#chat').close();$('#inbox').close();
      $('#chat-messages').replaceChildren();$('#chat-input').value='';$('#inbox-list').replaceChildren();
      $('#moderation').close();$('#moderation-list').replaceChildren();
      if(hadUser) {$('#detail').close();$('#detail-content').replaceChildren();state.detailId=null;$('#composer').close();$('#post-form').reset();++composerGeneration;}
    }
    for(const id of Object.keys(owners)) delete owners[id];
    for(const id of session.ownership||[]) owners[id]=true;
    $('#service-status').textContent='Gratuit · Annonces locales et échanges privés. Aucun paiement sur la plateforme.';
    $('#privacy-link').hidden=false;
    $('#inbox .sheet-subtitle').textContent='Vos conversations restent accessibles 7 jours après l’expiration de l’annonce.';
    $('#post-form .fine-print').textContent='Gratuit · Conditions et paiement à convenir entre vous. L’annonce quitte le fil à expiration.';
    $('#help .help-copy').innerHTML='<p><strong>Vous êtes dispo ?</strong><br>Choisissez votre métier, une ville et une durée. Votre point apparaît en vert.</p><p><strong>Il manque quelqu’un ?</strong><br>Publiez votre besoin. Parlez-vous, puis confirmez chaque place vous-même. Un message ne réserve rien.</p><p><strong>Le fil reste frais.</strong><br>Les annonces pourvues quittent le fil public. Vous pouvez rouvrir une place jusqu’à l’expiration initiale. Les conversations privées restent disponibles sept jours après cette expiration, sauf suppression ou modération.</p><p><strong>Vous gardez la main.</strong><br>La localisation est approximative, à votre demande. Signalez un contenu ou bloquez un interlocuteur depuis l’échange. Les réponses sont actualisées quand l’application est visible ; pas de notification quand elle est fermée.</p><p><strong>Gratuit des deux côtés.</strong><br>Ni paiement ni contrat ne sont gérés ici. Les identités, compétences et autorisations de travail ne sont pas vérifiées. Convenez des conditions et effectuez les vérifications nécessaires avant toute mission.</p><p><a href="/privacy.html">Confidentialité et règles d’utilisation</a></p>';
  }
  renderVoice();
  if(liveReady) { void changeFeed();void pollUpdates(); }
}});
$('#account-button').addEventListener('click',()=>accounts.show());
let composerGeneration = 0, publishing = false;
const now = () => Date.now() + state.offset;
let toastTimer, chatTimer;
let updatesRequest, updatesCursor = 0, updatesError = false, updatesCheckedAt = 0;
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, 4500); }
function errorText(error) {

  const voiceErrors={microphone_denied:'Le micro n’a pas été autorisé. Vous pouvez toujours écrire.',recording_unavailable:'Le micro est indisponible. Vérifiez les permissions ou écrivez votre message.',recording_failed:'L’enregistrement a été interrompu. Réessayez ou utilisez le texte.',recording_empty:'Aucun son enregistré. Réessayez ou utilisez le texte.',recording_interrupted:'Enregistrement effacé lorsque l’application a été masquée.',audio_busy:'Un vocal est en cours de traitement. Attendez un instant puis réessayez.',audio_too_large:'Ce vocal est trop volumineux. Enregistrez un message plus court.',audio_too_long:'Le vocal dépasse une minute. Enregistrez un message plus court.',invalid_audio:'Ce vocal ne peut pas être lu. Effacez-le puis réessayez.',unsupported_audio_type:'Ce format audio n’est pas accepté. Utilisez un autre navigateur ou le texte.',audio_processing_unavailable:'Le service vocal est indisponible. Votre enregistrement reste ici ; vous pouvez aussi écrire.',audio_processing_timeout:'Le traitement a pris trop de temps. Réessayez le même enregistrement.',voice_thread_capacity_reached:'La limite de 20 vocaux de cet échange est atteinte. Le texte reste disponible.',voice_user_capacity_reached:'Votre espace vocal est plein. Le texte reste disponible.',voice_total_capacity_reached:'Le service vocal a atteint sa capacité. Le texte reste disponible.',report_voice_capacity_reached:'Le stockage des preuves vocales est plein. Aucun signalement enregistré ; bloquez l’interlocuteur si nécessaire et réessayez plus tard.'};
  if(voiceErrors[error.code])return voiceErrors[error.code];
  if (error.code === 'request_timeout') return 'Le serveur ne répond pas. Résultat non confirmé ; votre saisie est conservée.';
  if (error.code === 'no_place_to_reopen') return 'Toutes les places sont déjà ouvertes.';
  if (error.code === 'idempotency_capacity_reached') return 'La limite de changements de cet essai est atteinte.';
  const authErrors={login_required:'Connectez-vous pour continuer.',invalid_credentials:'Pseudo ou phrase secrète incorrecte.',username_unavailable:'Ce pseudo est déjà pris. Choisissez-en un autre.',invalid_username:'Choisissez un pseudo de 3 à 32 lettres, chiffres ou tirets.',invalid_password:'La phrase secrète doit contenir entre 15 et 128 caractères.',invalid_recovery_code:'Ce code de secours est invalide ou a déjà été utilisé.',auth_busy:'Le service reçoit beaucoup de connexions. Réessayez dans un instant.',contact_blocked:'Cet échange est bloqué. Aucun nouveau message ne peut être envoyé.',account_suspended:'Ce compte ne peut plus publier ni contacter.',own_post_capacity_reached:'Vous avez déjà 10 annonces actives. Attendez une expiration ou supprimez une annonce.',intent_unavailable:'Ce contenu a été supprimé. La tentative précédente ne peut pas être reprise.',post_expired:'Cette annonce a expiré.',invalid_cursor:'Actualisation interrompue. Réessayez.',total_report_capacity_reached:'Le service de signalement est temporairement saturé. Bloquez l’interlocuteur si nécessaire et réessayez plus tard.',report_capacity_reached:'Vous avez atteint la limite de 10 signalements sur 24 heures.',report_evidence_too_large:'Le contexte de cette conversation est trop volumineux pour ce signalement. Aucun signalement n’a été enregistré.'};
  if(authErrors[error.code]) return authErrors[error.code];
  const map = { owner_required: 'Cette annonce appartient à une autre session.', post_not_found: 'Cette annonce a expiré ou n’est plus disponible.', post_already_full: 'Cette annonce est déjà clôturée.', demo_contact_unavailable: 'C’est un exemple : aucune personne n’est à contacter.', thread_not_found: 'Cet échange a expiré ou a été supprimé.', thread_access_denied: 'Cet échange appartient à une autre session.', chat_access_denied: 'Cet échange appartient à une autre session.', rate_limit: 'Trop de demandes. Attendez une minute puis réessayez.', invalid_pay: 'Indiquez un tarif entre 8 et 100 €/h, ou laissez ce champ vide.', message_required: 'Écrivez un message avant de l’envoyer.', invalid_text: 'Le texte est trop long ou contient un caractère non accepté.', message_capacity_reached: 'La limite de messages de cet essai est atteinte.', post_capacity_reached: 'Le fil est plein. Réessayez après expiration de quelques annonces.' };
  return map[error.code] || (error instanceof TypeError ? 'Connexion interrompue. Votre saisie est conservée : réessayez.' : 'Cette action n’a pas abouti. Vérifiez votre saisie et réessayez.');
}
function relative(timestamp) { const minutes = Math.max(0, Math.floor((now() - timestamp) / 60000)); return minutes < 1 ? 'à l’instant' : minutes < 60 ? `il y a ${minutes} min` : `il y a ${Math.floor(minutes / 60)} h`; }
function remaining(post) { const m = Math.max(0, Math.ceil((post.expiresAt - now()) / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}` : `${m} min`; }
function time(timestamp, timezone) { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}) }).format(timestamp); }
function dateTime(timestamp,timezone) {return new Intl.DateTimeFormat('fr-FR',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',...(timezone?{timeZone:timezone}:{})}).format(timestamp);}
const roleIcon = role => role === 'Barman' ? 'wine' : role === 'Commis' ? 'chef-hat' : 'utensils';
function statusLabel(post) { if (post.status === 'full') return post.kind === 'need' ? 'COMPLET' : 'INDISPONIBLE'; return post.kind === 'available' ? 'DISPO MAINTENANT' : 'RENFORT RECHERCHÉ'; }
function title(post) { return post.kind === 'need' ? `${post.places || post.totalPlaces} ${post.role.toLowerCase()}${(post.places || post.totalPlaces) > 1 ? 's' : ''} recherché${(post.places || post.totalPlaces) > 1 ? 's' : ''}` : post.role; }
function tags(post) { return `${post.english ? `<span>${icon('languages')}Anglais</span>` : ''}${post.vehicle ? `<span>${icon('car')}Véhiculé</span>` : ''}${post.kind === 'need' && post.status === 'open' ? `<span class="places-label">${post.places} place${post.places > 1 ? 's' : ''}</span>` : ''}${post.pay ? `<span class="pay-label">${esc(post.pay)} €/h</span>` : ''}`; }
function inCity(post) { if (state.mine) return true; const origin = state.point || state.city, rad = Math.PI / 180; const a = Math.sin((post.lat-origin.lat)*rad/2)**2 + Math.cos(origin.lat*rad)*Math.cos(post.lat*rad)*Math.sin((post.lng-origin.lng)*rad/2)**2; return 6371*2*Math.atan2(Math.sqrt(Math.min(1,a)), Math.sqrt(Math.max(0,1-a))) <= 25; }
function visiblePosts() { return state.posts.filter(post => inCity(post) && post.expiresAt > now() && (state.mine || post.status === 'open') && (!state.mine || owners[post.id]) && (state.kind === 'all' || post.kind === state.kind) && (state.zone === 'all' || post.zoneId === state.zone) && (state.role === 'all' || post.role === state.role) && (!state.english || post.english) && (!state.vehicle || post.vehicle)).sort((a, b) => state.kind === 'need' && state.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt); }
const map = new LocalMap($('#map'), { pinHTML: post => `<span class="status-dot"></span>${esc(post.role)}${post.kind === 'need' ? `<small>${post.places}</small>` : ''}`, onSelect: id => selectPost(id), onOverflow: () => { setView('feed'); $('#feed-title').scrollIntoView({block:'center'}); } });
function render() {
  const active = state.posts.filter(p => inCity(p) && p.expiresAt > now() && p.status === 'open' && (!state.mine || owners[p.id]));
  $('#all-count').textContent = active.length; $('#available-count').textContent = active.filter(p => p.kind === 'available').length; $('#need-count').textContent = active.filter(p => p.kind === 'need').length;
  const owned = state.posts.filter(p => owners[p.id] && p.expiresAt > now()); $('#mine-count').hidden = !owned.length; $('#mine-count').textContent = owned.length;
  $('#full-legend').hidden = !state.mine;
  $('#feed-expiry').textContent = state.mine ? 'Vos annonces clôturées restent ici jusqu’à expiration.' : 'Les annonces expirent. Le fil reste frais.';
  const visible = visiblePosts();
  $('#feed-title').textContent = state.mine ? 'Mes annonces' : state.zone === 'all' ? state.city.name : state.zones.find(z => z.id === state.zone)?.label || 'Dans le coin';
  $('#result-count').textContent = `${visible.length} annonce${visible.length !== 1 ? 's' : ''} ${state.mine ? (state.production?'sur votre compte':'dans cette session') : 'en ce moment'}`;
  if (!visible.length) {
    $('#post-list').innerHTML = `<div class="empty-state">${icon(state.mine ? 'radio' : 'map-pin')}<h3>${state.mine ? 'À vous d’apparaître.' : 'Le coin est calme.'}</h3><p>${state.mine ? 'Une dispo ou un besoin ? Quelques cases suffisent.' : 'Aucune annonce ne correspond à ces filtres. Élargissez la recherche ou lancez la première.'}</p><button class="button lime" data-empty-action>${state.mine ? 'Je suis dispo' : 'Publier une annonce'}${icon('plus')}</button></div>`;
  } else {
    $('#post-list').innerHTML = visible.map(post => `<button class="post-row ${post.kind} ${state.selected === post.id ? 'selected' : ''}" data-post="${esc(post.id)}" aria-label="${esc(title(post))}, ${esc(post.zoneLabel)}, ${esc(statusLabel(post))}${post.demo ? ', exemple' : ''}"><div class="row-top"><span class="state-label ${post.kind === 'need' ? 'need' : ''} ${post.status === 'full' ? 'full' : ''}"><span class="status-dot"></span>${statusLabel(post)}</span><span class="row-age">${relative(post.updatedAt)}</span></div><div class="row-main"><span class="role-symbol">${icon(roleIcon(post.role))}</span><div class="row-text"><h3>${esc(title(post))}</h3><p>${icon('map-pin')}${esc(post.zoneLabel)} <span aria-hidden="true">·</span> ${post.status === 'full' ? 'Clôturé' : `Encore ${remaining(post)}`}</p></div>${icon('arrow-up-right', 'class="row-arrow"')}</div><div class="row-tags">${tags(post)}<span class="demo-label">${post.demo ? 'Exemple' : owners[post.id] ? 'Votre annonce' : state.production ? 'Annonce locale' : 'Essai local'}</span></div></button>`).join('');
  }
  if (state.selected && !visible.some(p => p.id === state.selected)) state.selected = null;
  map.update(visible, state.selected); renderSelection();
  const extra = Number(state.english) + Number(state.vehicle); $('#filter-count').hidden = !extra; $('#filter-count').textContent = extra;
  if (state.detailId && $('#detail').open) {
    const p = state.posts.find(p => p.id === state.detailId && p.expiresAt > now());
    if (!p && state.production && state.detailPost?.id===state.detailId) {updateDetail(state.detailPost);if(!state.detailUnavailable)void refreshDetail();}
    else if (!p) { $('#detail').close(); state.detailId = null; toast('Cette annonce a expiré.'); }
    else {state.detailPost=p;state.detailUnavailable=false;updateDetail(p);}
  }
}
function selectPost(id) { state.selected = id; render(); }
function renderSelection() {
  const post = state.posts.find(p => p.id === state.selected);
  $('#map-selection').hidden = !post;
  if (!post) return;
  $('#map-selection').innerHTML = `<button class="icon-button selection-close" aria-label="Fermer l’aperçu" data-clear-selection>${icon('x')}</button><span class="state-label ${post.status === 'full' ? 'full' : post.kind === 'need' ? 'need' : ''}"><span class="status-dot"></span>${statusLabel(post)}</span><h3>${esc(title(post))}</h3><p>${esc(post.zoneLabel)} · ${relative(post.updatedAt)}</p><div class="selection-tags">${tags(post)}</div><div class="selection-bottom"><span class="row-age">${post.demo ? 'Exemple fictif' : `Expire à ${time(post.expiresAt, post.timezone)}`}</span><button class="button lime" data-detail="${esc(post.id)}">Voir l’annonce${icon('arrow-up-right')}</button></div>`;
}
function setConnection(connected) { state.connected = connected; $('#connection').classList.toggle('offline', !connected); $('#connection').innerHTML = `<span class="status-dot"></span><span>${connected ? 'En direct' : 'Reconnexion…'}</span>`; }
function receive(data) {
  if(state.production && lastSnapshot?.epoch===data.epoch && lastSnapshot?.scope===data.scope && lastSnapshot.version>data.version) return;
  lastSnapshot={epoch:data.epoch,scope:data.scope,version:data.version};
  if(state.production && !state.mine) {
    for(const id of Object.keys(owners))delete owners[id];for(const id of data.ownedPostIds||[])owners[id]=true;
    const incoming=new Set(data.posts.map(p=>p.id));
    data={...data,posts:[...data.posts,...(data.ownedPosts||[]).filter(p=>!incoming.has(p.id))]};
  }
  state.posts = data.posts.map(post => { const previous = state.posts.find(p => p.id === post.id); return previous ? freshPost(previous, post) : post; }); state.offset = data.now - Date.now(); setConnection(true);
  if(!state.production) for (const id of Object.keys(owners)) if (!state.posts.some(p => p.id === id)) delete owners[id];
  for (const key of mutationKeys.keys()) if (!state.posts.some(p => key.startsWith(`${p.id}:`))) mutationKeys.delete(key);
  for (const id of Object.keys(threads)) if (threads[id].expiresAt < now()) delete threads[id];
  invalidateUnavailableChat();
  outbox.retain(new Set(Object.keys(threads)));
  saveSession(); render(); renderUpdates(); if ($('#inbox').open) renderInbox();
}
function openDialog(dialog) { $$('dialog[open]').forEach(d => d.close()); dialog.showModal(); }
$$('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$$('dialog').forEach(dialog => {
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right) dialog.close(); } });
  dialog.addEventListener('close', () => { if (dialog.id === 'chat' && !dialog.open) { clearInterval(chatTimer); state.chat = null; voice.discard();stopAudio(dialog); } if(dialog.id==='moderation')stopAudio(dialog); });
});
function openComposer(kind) {
  if(!accounts.require(()=>openComposer(kind))) return;
  if (publishing) { openDialog($('#composer')); toast('Publication en cours. Attendez sa confirmation.'); return; }
  ++composerGeneration;
  state.formKind = kind; $('#post-form').reset(); $('#need-fields').hidden = kind !== 'need';
  $('#compose-title').textContent = kind === 'available' ? 'Dispo, maintenant.' : 'Un renfort, maintenant.';
  $('#compose-description').textContent = kind === 'available' ? 'Quelques cases. Et vous êtes dans le coin.' : 'Dites ce qu’il vous manque. Parlez-vous directement.';
  $('#role-legend').textContent = kind === 'available' ? 'Je suis…' : 'Je cherche…';
  $('#publish-button').innerHTML = `${kind === 'available' ? 'Apparaître en direct' : 'Publier mon besoin'}${icon('arrow-up-right')}`;
  $('#form-error').hidden = true; $('#form-city').textContent = `${state.city.label}${state.point ? ' · votre zone approximative' : ''}`; $('#form-zone-control').hidden = state.city.id !== '2988507' || Boolean(state.point); $('#form-zone').disabled = $('#form-zone-control').hidden; if (state.zone !== 'all') $('#form-zone').value = state.zone;
  openDialog($('#composer'));
}
$('#available-button').addEventListener('click', () => openComposer('available')); $('#need-button').addEventListener('click', () => openComposer('need'));
$('#post-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#publish-button'); if (button.disabled) return; const data = new FormData(event.currentTarget);
  const payload = { kind: state.formKind, role: data.get('role'), cityId: state.city.id, english: data.has('english'), vehicle: data.has('vehicle'), durationMinutes: Number(data.get('durationMinutes')), note: data.get('note').trim() };
  if (state.point) payload.point = state.point;
  else if (state.city.id === '2988507') payload.zoneId = data.get('zoneId');
  if (payload.kind === 'need') payload.places = Number(data.get('places'));
  const generation = composerGeneration;
  publishing = true; button.disabled = true; $('#form-error').hidden = true;
  try {
    const generationAtWrite=accountGeneration;
    const result = await api('/api/posts', { method: 'POST', body: payload,idempotencyKey:state.production?writeKey('create',payload):undefined });
    if(generationAtWrite!==accountGeneration) return;
    writeIntents.delete('create'); owners[result.post.id] = state.production?true:result.ownerToken; saveSession();
    // A successful write must not turn into a failed publication because a
    // subsequent read fails. SSE will continue to refresh the public feed.
    const index = state.posts.findIndex(p => p.id === result.post.id);
    if (index < 0) state.posts.push(result.post);
    else state.posts[index] = freshPost(state.posts[index], result.post);
    if (generation !== composerGeneration || !$('#composer').open) { render(); toast('Votre annonce a été publiée. Retrouvez-la dans Mes annonces.'); return; }
    state.kind = 'all'; state.zone = 'all'; state.role = 'all'; state.english = false; state.vehicle = false; syncFilters();
    state.selected = result.post.id; map.recenter(result.post); render(); $('#composer').close();
    toast(state.production?'Votre annonce est en direct.':'Votre annonce est en direct dans cet essai local.'); openDetail(result.post.id);
  } catch (error) {
    const message = errorText(error) + (!error.status ? state.production?' Réessayez avec le même texte : une seule annonce sera créée.':' Vérifiez le fil avant de republier : l’annonce a peut-être été créée.' : '');
    if (generation === composerGeneration && $('#composer').open) { $('#form-error').textContent = message; $('#form-error').hidden = false; }
    else toast(message);
  } finally { publishing = false; button.disabled = false; }
});
function syncFilters() {
  $('#zone-filter').value = state.zone; $('#role-filter').value = state.role; $('#english-filter').checked = state.english; $('#vehicle-filter').checked = state.vehicle; $('#sort-filter').value = state.sort; $('#sort-control').hidden = state.kind !== 'need';
  $$('[data-kind]').forEach(button => { button.classList.toggle('active', button.dataset.kind === state.kind); button.setAttribute('aria-pressed', String(button.dataset.kind === state.kind)); });
}
$$('[data-kind]').forEach(button => button.addEventListener('click', () => { state.kind = button.dataset.kind; if (state.kind !== 'need') state.sort = 'recent'; syncFilters(); render(); }));
$('#zone-filter').addEventListener('change', event => { state.zone = event.target.value; map.recenter(state.zones.find(z => z.id === state.zone) || state.city); $('#map-area').textContent = state.zone === 'all' ? `${state.city.name} · rayon 25 km` : state.zones.find(z => z.id === state.zone).label; render(); });
$('#role-filter').addEventListener('change', e => { state.role = e.target.value; render(); });
$('#sort-filter').addEventListener('change', e => { state.sort = e.target.value; render(); });
for (const [selector, key] of [['#english-filter', 'english'], ['#vehicle-filter', 'vehicle']]) $(selector).addEventListener('change', e => { state[key] = e.target.checked; render(); });
$('#more-filters').addEventListener('click', () => { const hidden = !$('#extra-filters').hidden; $('#extra-filters').hidden = hidden; $('#more-filters').setAttribute('aria-expanded', String(!hidden)); });
$('#reset-filters').addEventListener('click', () => { Object.assign(state, { kind: 'all', zone: 'all', role: 'all', sort: 'recent', english: false, vehicle: false }); syncFilters(); map.recenter(state.city); render(); });
function setMine(mine) { if(mine&&!accounts.require(()=>setMine(true))) return; state.mine = mine; $('#mine-nav').classList.toggle('active', mine); $('#live-nav').classList.toggle('active', !mine); (mine ? $('#mine-nav') : $('#live-nav')).setAttribute('aria-current', 'page'); (mine ? $('#live-nav') : $('#mine-nav')).removeAttribute('aria-current'); syncFilters(); if (mine) setView('feed'); if(state.production) void changeFeed();render(); }
$('#mine-nav').addEventListener('click', () => setMine(true)); $('#live-nav').addEventListener('click', () => setMine(false));
function setView(view) { $('.workspace').dataset.mobileView = view; $$('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-pressed', String(b.dataset.view === view)); }); if (view === 'map') requestAnimationFrame(() => map.render()); }
$$('[data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
$('#zoom-in').addEventListener('click', () => map.changeZoom(1)); $('#zoom-out').addEventListener('click', () => map.changeZoom(-1)); $('#recenter').addEventListener('click', () => map.recenter(state.zones.find(z => z.id === state.zone) || state.point || state.city));
$('#post-list').addEventListener('click', event => { const post = event.target.closest('[data-post]'); if (post) { state.selected = post.dataset.post; render(); openDetail(post.dataset.post); } if (event.target.closest('[data-empty-action]')) openComposer('available'); });
$('#map-selection').addEventListener('click', e => { if (e.target.closest('[data-clear-selection]')) { state.selected = null; render(); } const button = e.target.closest('[data-detail]'); if (button) openDetail(button.dataset.detail); });
$('#how-button').addEventListener('click', () => openDialog($('#help')));
$('#share-feed').addEventListener('click', async () => {
  const button = $('#share-feed'); if (button.disabled) return;
  button.disabled = true; $('#feed-share-fallback').hidden = true;
  try {
    const cityName = state.city.name;
    const share = makeFeedShare({ origin: location.origin, city: state.city, role: state.role, kind: state.kind }, state.roles);
    $('#feed-share-copy').value = share.clipboardText;
    try {
      await navigator.clipboard.writeText(share.clipboardText);
      $('#feed-share-status').textContent = `Texte et lien copiés pour ${cityName}. Partagez-les où vous voulez. Aucun partage automatique.`;
    } catch {
      $('#feed-share-fallback').hidden = false;
      $('#feed-share-status').textContent = 'La copie automatique est indisponible. Sélectionnez et copiez le texte ci-dessous.';
      $('#feed-share-copy').focus(); $('#feed-share-copy').select();
    }
  } catch {
    $('#feed-share-status').textContent = 'Le fil ne peut pas être partagé pour le moment. Choisissez une ville et un métier valides.';
  } finally { $('#feed-share-status').hidden = false; button.disabled = false; }
});


// Update live fields in place: an SSE event must never replace a visitor's draft.
function updateDetail(post) {
  const closed = post.status !== 'open'||post.expiresAt<=now()||state.detailUnavailable;
  $('#detail-title').textContent = closed && post.kind === 'need' ? `${post.role} · mission pourvue.` : `${title(post)}.`;
  $('#detail-status').className = `state-label ${closed ? 'full' : post.kind === 'need' ? 'need' : ''}`;
  $('#detail-status-text').textContent = statusLabel(post);
  $('#detail-expiration').textContent = `Visible jusqu’à ${time(post.expiresAt, post.timezone)} (heure de la ville) · encore ${remaining(post)}`;
  const places = $('#detail-places');
  if (places) places.textContent = `${post.places} place${post.places > 1 ? 's' : ''} restante${post.places > 1 ? 's' : ''} sur ${post.totalPlaces}`;
  const form = $('#contact-form');
  const closure = $('#detail-closed');
  closure.hidden = !closed;
  closure.textContent = form ? 'Cette annonce est clôturée. Votre message est conservé ci-dessous, mais ne peut plus être envoyé.' : 'Cette annonce est clôturée. Retrouvez les places ouvertes dans le fil.';
  if(state.detailUnavailable||post.expiresAt<=now())closure.textContent='Cette annonce a expiré ou a été supprimée. Votre brouillon reste dans cette fenêtre.';
  if (form) form.querySelector('button[type="submit"]').disabled = closed || form.dataset.submitting === 'true';
  $$('#detail-content [data-mutate]').forEach(button => {
    const reopening = button.dataset.mutate === 'reopen';
    button.hidden = reopening ? post.places >= post.totalPlaces : closed;
    button.disabled = mutationsInFlight.has(post.id) || (reopening ? post.places >= post.totalPlaces : closed);
  });
}
let detailRead=null;
function refreshDetail() {
  if(detailRead)return detailRead;
  const id=state.detailId,generation=accountGeneration;
  detailRead=(async()=>{
    try {
      const {post}=await api(`/api/posts/${id}`);
      if(generation!==accountGeneration||id!==state.detailId||!$('#detail').open)return;
      state.detailPost=post;state.detailUnavailable=false;updateDetail(post);
    }catch(error){
      if(generation!==accountGeneration||id!==state.detailId||!$('#detail').open)return;
      if(error.status===404||error.status===410) {state.detailUnavailable=true;updateDetail(state.detailPost);}
      else detailError(id,error);
    }finally{detailRead=null;}
  })();return detailRead;
}
function detailError(id, error) {
  if (state.detailId === id && $('#detail').open) { $('#detail-error').textContent = errorText(error); $('#detail-error').hidden = false; }
  else toast(errorText(error));
}
function feedQuery() { const q=new URLSearchParams({cityId:state.city.id,mine:String(state.mine)});if(state.point){q.set('lat',state.point.lat);q.set('lng',state.point.lng);}return state.production?`?${q}`:''; }
function refreshPublicState() { const generation=feedGeneration; return api(`/api/state${feedQuery()}`).then(data=>{if(generation===feedGeneration)receive(data);}).catch(()=>{if(generation===feedGeneration)setConnection(false);}); }
function syncLiveConnection() {
  if(document.hidden) { events?.close();events=null;return; }
  if(events||!liveReady) return;
  const generation=feedGeneration;
  events=new EventSource(`/api/events${feedQuery()}`);
  events.addEventListener('state',event=>{if(generation!==feedGeneration)return;try{receive(JSON.parse(event.data));}catch{setConnection(false);}});
  events.addEventListener('session-expired',()=>{events?.close();events=null;void accounts.refresh().catch(()=>setConnection(false));});
  events.onerror=()=>{if(generation===feedGeneration)setConnection(false);};
}
function changeFeed() { feedGeneration++;lastSnapshot=null;events?.close();events=null;syncLiveConnection();return refreshPublicState(); }
function openDetail(id) {
  const post = state.posts.find(p => p.id === id && p.expiresAt > now()); if (!post) { toast('Cette annonce a expiré.'); return; }
  state.detailId = id;state.detailPost=post;state.detailUnavailable=false; const own = Boolean(owners[id]);
  $('#detail-content').innerHTML = `<div class="detail-role">${icon(roleIcon(post.role))}</div><div class="detail-state" aria-live="polite"><span id="detail-status" class="state-label"><span class="status-dot"></span><span id="detail-status-text"></span></span></div><h2 id="detail-title">${esc(title(post))}.</h2><p class="sheet-subtitle">${esc(post.zoneLabel)} · ${post.demo ? 'Exemple fictif' : own ? 'Votre annonce' : state.production ? 'Annonce locale' : 'Essai local'}</p><div class="detail-facts"><div>${icon('clock')}<span id="detail-expiration"></span></div>${post.english ? `<div>${icon('languages')}${post.kind === 'need' ? 'Anglais demandé' : 'Parle anglais'}</div>` : ''}${post.vehicle ? `<div>${icon('car')}${post.kind === 'need' ? 'Véhicule demandé' : 'Véhiculé'}</div>` : ''}${post.kind === 'need' ? `<div>${icon('briefcase-business')}<strong id="detail-places" aria-live="polite"></strong></div>` : ''}${post.pay ? `<div>${icon('check')}${esc(post.pay)} €/h annoncé · à confirmer ensemble</div>` : ''}</div>${post.note ? `<p class="detail-note">${esc(post.note)}</p>` : ''}<p id="detail-closed" class="detail-disclaimer" role="status" hidden></p>
  ${post.demo ? `<p class="detail-disclaimer">Cette annonce illustre le service. Aucune personne réelle n’est derrière cet exemple. Publiez un essai et ouvrez-le dans une autre fenêtre pour tester le contact.</p><button class="button lime" data-try>Créer mon essai${icon('plus')}</button>` : own ? `<div class="detail-actions">${post.kind === 'need' ? `<button class="button lime" data-mutate="fill">Une place confirmée${icon('check')}</button>` : ''}<button class="button outline" data-mutate="close">${post.kind === 'need' ? 'Tout est pourvu' : 'Je ne suis plus dispo'}</button><button class="button lime" data-mutate="reopen">${post.kind === 'need' ? 'Rouvrir une place' : 'Je suis de nouveau dispo'}${icon('plus')}</button><button class="button outline" data-owner-inbox>Voir les réponses${icon('message-circle')}</button></div><p class="detail-disclaimer">${post.kind === 'need' ? 'Confirmez une place seulement après accord avec la personne. Un message ne réserve rien.' : 'Votre disponibilité expire automatiquement.'}</p>` : `<form id="contact-form" class="contact-form"><label class="field-label" for="contact-message">Votre premier message</label><p class="quick-reply-help">Un clic préremplit le message. À vous de l’envoyer.</p><div class="quick-replies" role="group" aria-label="Suggestions de premier message">${(post.kind === 'need' ? ['Bonjour, votre besoin est-il toujours d’actualité ?', 'Bonjour, quels sont les horaires ?'] : ['Bonjour, êtes-vous toujours disponible ?', 'Bonjour, pour quels horaires êtes-vous disponible ?']).map(text => `<button type="button" data-suggestion="${esc(text)}">${esc(text)}</button>`).join('')}</div><textarea id="contact-message" maxlength="500" required placeholder="Bonjour, toujours disponible ?"></textarea><button class="button lime" type="submit">Contacter directement${icon('send')}</button><p class="detail-disclaimer">${state.production?'Échange privé. Convenez des horaires et conditions ensemble.':'Échange dans ce prototype, sans coordonnées personnelles.'} Une réponse ne réserve aucune place.</p></form>`}${state.production?`<div class="safety-actions">${own?'<button class="text-button" data-delete-post>Supprimer l’annonce</button>':'<button class="text-button" data-report-post>Signaler cette annonce</button>'}</div>`:''}<p id="detail-error" class="form-error" role="alert" hidden></p><button class="text-button" data-share>${icon('share-2')}Copier le lien de cette annonce</button><p class="fine-print">${state.production?'Lien partageable · L’annonce disparaît à expiration.':'Lien de test local · Ne fonctionne pas sur un autre appareil.'}</p>`;
  updateDetail(post); openDialog($('#detail'));
  const form = $('#contact-form'); if (form) form.addEventListener('submit', async e => {
    e.preventDefault(); const button = form.querySelector('button[type="submit"]'); if (button.disabled) return;
    if(!accounts.require(()=>{openDialog($('#detail'));form.querySelector('textarea').focus();})) return;
    const current = state.posts.find(p => p.id === id && p.expiresAt > now());
    if (!current || current.status !== 'open') { if (current) updateDetail(current); else render(); return; }
    button.disabled = true; form.dataset.submitting = 'true'; $('#detail-error').hidden = true;
    try {
      const payload={message:form.querySelector('textarea').value.trim()},generationAtWrite=accountGeneration;
      const result = await api(`/api/posts/${id}/contact`, { method: 'POST', body:payload,idempotencyKey:state.production?writeKey(`contact:${id}`,payload):undefined });
      if(generationAtWrite!==accountGeneration)return;
      ++privateRevision;
      writeIntents.delete(`contact:${id}`);
      threads[result.threadId] = { ...threads[result.threadId],token: state.production?undefined:result.guestToken, postId: id, role: post.role, zoneLabel: post.zoneLabel, expiresAt: post.expiresAt+(state.production?7*86400000:0), timezone: post.timezone, side: 'guest', incomingCount: threads[result.threadId]?.incomingCount||0, readIncomingCount:threads[result.threadId]?.readIncomingCount||0 }; saveSession();
      if(result.existing) {outbox.edit(result.threadId,payload.message);toast('Vous avez déjà un échange. Votre texte est prêt, à vous de l’envoyer.');}
      if (state.detailId === id && $('#detail').open && form === $('#contact-form')) await openChat(result.threadId);
      else toast('Contact envoyé. Retrouvez la conversation dans Mes échanges.');
    }
    catch (error) { if (error.status === 409) void refreshPublicState(); detailError(id, error); }
    finally { form.dataset.submitting = 'false'; const latest = state.posts.find(p => p.id === id); if (state.detailId === id && $('#detail').open && latest) updateDetail(latest); }
  });
}
$('#detail-content').addEventListener('click', async e => {
  if(e.target.closest('[data-report-post]'))return openReport('post',state.detailId);
  if(e.target.closest('[data-delete-post]')) {deletePostId=state.detailId;$('#delete-post-error').hidden=true;openDialog($('#delete-post'));return;}
  const suggestion = e.target.closest('[data-suggestion]');
  if (suggestion) {
    const input = $('#contact-message');
    const draft = suggestedDraft(input.value, input.dataset.suggestion, suggestion.dataset.suggestion);
    if (draft === input.value && input.value !== suggestion.dataset.suggestion) toast('Votre brouillon est conservé. Effacez-le pour choisir une suggestion.');
    else { input.value = draft; input.dataset.suggestion = draft; }
    input.focus(); return;
  }
  if (e.target.closest('[data-try]')) return openComposer('available');
  if (e.target.closest('[data-owner-inbox]')) return openInbox();
  const share = e.target.closest('[data-share]'); if (share) { const link = `${location.origin}/?post=${encodeURIComponent(state.detailId)}`; try { await navigator.clipboard.writeText(link); toast(state.production?'Lien copié. Partagez-le avec vos contacts ou un groupe.':'Lien local copié. Testez-le dans une autre fenêtre de ce Mac.'); } catch { share.textContent = link; } return; }
  const button = e.target.closest('[data-mutate]'); if (!button || button.disabled) return;
  const id = state.detailId, action = button.dataset.mutate, intent = `${id}:${action}`;
  if (mutationsInFlight.has(id)) return;
  if (!mutationKeys.has(intent)) mutationKeys.set(intent, crypto.randomUUID());
  mutationsInFlight.add(id); button.disabled = true; $('#detail-error').hidden = true;
  const current = state.posts.find(p => p.id === id); if (current) updateDetail(current);
  try {
    const result = await api(`/api/posts/${id}`, { method: 'PATCH', owner: state.production?undefined:owners[id], body: { action }, idempotencyKey: mutationKeys.get(intent) });
    mutationKeys.delete(intent);
    // The mutation succeeded even if a later refresh would fail. Apply its reply
    // without overwriting a newer state already received through SSE.
    const index = state.posts.findIndex(p => p.id === id);
    if (index >= 0) state.posts[index] = freshPost(state.posts[index], result.post);
    render();
    const latest = state.posts.find(p => p.id === id) || result.post;
    toast(latest.status === 'full' ? 'Annonce clôturée. Elle quitte le fil public.' : action === 'reopen' ? 'Annonce rouverte. L’heure d’expiration reste la même.' : `${latest.places} place${latest.places > 1 ? 's' : ''} restante${latest.places > 1 ? 's' : ''}.`);
  } catch (error) {
    if (error.status === 409) mutationKeys.delete(intent);
    if (error.status === 409) void refreshPublicState();
    detailError(id, error);
  } finally {
    mutationsInFlight.delete(id);
    const latest = state.posts.find(p => p.id === id);
    if (latest && state.detailId === id && $('#detail').open) updateDetail(latest);
  }
});

let reportTarget=null,deletePostId=null;
function openReport(targetType,targetId) {
  if(!accounts.require(()=>openReport(targetType,targetId)))return;
  reportTarget={targetType,targetId};$('#report-form').reset();$('#report-error').hidden=true;openDialog($('#report'));
}
$('#chat-report').addEventListener('click',()=>openReport('thread',state.chat));
$('#report-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');if(button.disabled||!reportTarget)return;
  const payload={...reportTarget,reason:$('#report-reason').value,details:$('#report-details').value.trim()};
  button.disabled=true;$('#report-error').hidden=true;
  try {await api('/api/reports',{method:'POST',body:payload,idempotencyKey:writeKey('report',payload)});writeIntents.delete('report');$('#report').close();toast('Signalement reçu. Merci de nous avoir prévenus.');}
  catch(error){$('#report-error').textContent=errorText(error);$('#report-error').hidden=false;}
  finally{button.disabled=false;}
});
$('#chat-block').addEventListener('click',async()=>{
  const id=state.chat;if(!id||!threads[id])return;const button=$('#chat-block');button.disabled=true;
  try {await api(`/api/threads/${id}/block`,{method:'POST',body:{blocked:!threads[id].blockedByMe}});await refreshChat();}
  catch(error){if(state.chat===id){$('#chat-error').textContent=errorText(error);$('#chat-error').hidden=false;}}
  finally{button.disabled=false;}
});
$('#confirm-delete-post').addEventListener('click',async()=>{
  const id=deletePostId,button=$('#confirm-delete-post');if(!id||button.disabled)return;button.disabled=true;
  try {await api(`/api/posts/${id}`,{method:'DELETE'});delete owners[id];state.posts=state.posts.filter(p=>p.id!==id);$('#delete-post').close();render();await pollUpdates();toast('Annonce et échanges supprimés.');}
  catch(error){$('#delete-post-error').textContent=errorText(error);$('#delete-post-error').hidden=false;}
  finally{button.disabled=false;}
});
async function refreshModeration() {
  const generation=accountGeneration;
  $('#moderation-error').hidden=true;
  try {
    const data=await api('/api/moderation/reports'),reports=Array.isArray(data)?data:data.reports;
    if(generation!==accountGeneration||!state.moderator||!$('#moderation').open)return;
    stopAudio($('#moderation'),true);
    $('#moderation-list').innerHTML=reports.length?reports.map(report=>`<article class="moderation-report"><h3>${esc(report.reason)}</h3><p>${esc(report.details)}</p><details><summary>Voir le contenu signalé</summary><pre>${esc(report.evidence)}</pre>${reportVoiceMarkup(report)}</details><div class="safety-actions"><button class="button danger" data-resolve-report="${esc(report.id)}" data-action="remove">Retirer le contenu</button><button class="button outline" data-resolve-report="${esc(report.id)}" data-action="dismiss">Classer sans suite</button></div></article>`).join(''):'<p>Aucun signalement en attente.</p>';
  }catch(error){if(generation===accountGeneration&&state.moderator){$('#moderation-error').textContent=errorText(error);$('#moderation-error').hidden=false;}}
}
$('#moderation-button').addEventListener('click',()=>{openDialog($('#moderation'));void refreshModeration();});
$('#moderation-refresh').addEventListener('click',refreshModeration);
$('#moderation-list').addEventListener('click',async event=>{
  const button=event.target.closest('[data-resolve-report]');if(!button||button.disabled)return;button.disabled=true;
  try {await api(`/api/moderation/reports/${button.dataset.resolveReport}`,{method:'POST',body:{action:button.dataset.action}});await refreshModeration();}
  catch(error){$('#moderation-error').textContent=errorText(error);$('#moderation-error').hidden=false;button.disabled=false;}
});
function renderUpdates() {
  const unread = Object.values(threads).reduce((sum, thread) => sum + unreadCount(thread, now()), 0);
  const label = `${unread} nouvelle${unread > 1 ? 's' : ''} réponse${unread > 1 ? 's' : ''}`;
  $('#inbox-badge').hidden = !unread; $('#inbox-badge').textContent = unread > 99 ? '99+' : unread;
  $('#inbox-button').setAttribute('aria-label', unread ? `Mes échanges, ${label}` : 'Mes échanges');
  $('#inbox-button').title = unread ? `Mes échanges, ${label}` : 'Mes échanges';
  $('#reply-notice').hidden = !unread && !updatesError;
  $('#reply-notice').classList.toggle('updates-error', updatesError);
  $('#reply-notice-text').textContent = updatesError ? 'Actualisation des réponses interrompue' : label;
  $('#reply-notice-action').textContent = updatesError ? 'Réessayer' : 'Voir les échanges';
  $('#inbox-status').textContent = updatesError ? 'Connexion interrompue. Les compteurs peuvent être anciens. Réessayez.' : updatesCheckedAt ? `Vérifié à ${time(updatesCheckedAt)} · actualisation pendant que l’application est visible.` : 'Les réponses sont vérifiées pendant que l’application est visible.';
}
function renderInbox() {
  const list = Object.entries(threads).filter(([, t]) => t.expiresAt > now()).sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  $('#inbox-list').innerHTML = list.length ? list.map(([id, t]) => {
    const unread = unreadCount(t, now());
    return `<button class="inbox-item" data-thread="${esc(id)}"><strong>${esc(t.role)} · ${esc(t.zoneLabel)}</strong><p class="${unread ? 'unread-copy' : ''}">${unread ? `${unread} nouvelle${unread > 1 ? 's' : ''} réponse${unread > 1 ? 's' : ''}` : 'Ouvrir l’échange'}</p><small>Disponible jusqu’à ${(state.production?dateTime(t.expiresAt,t.timezone):time(t.expiresAt,t.timezone))} ${icon('arrow-up-right')}</small></button>`;
  }).join('') : `<div class="empty-state">${icon('inbox')}<h3>Ça commence par un bonjour.</h3><p>Les réponses à vos annonces et vos prises de contact apparaîtront ici.${state.production?'':' Les exemples ne reçoivent pas de messages.'}</p></div>`;
}
async function pollUpdates() {
  if (document.hidden) return;
  if (updatesRequest) return updatesRequest;
  if(state.production) {
    if(!state.user) {updatesError=false;renderUpdates();return;}
    const generation=accountGeneration,revision=privateRevision,readMarkers=state.readMarkers||{};
    updatesRequest=(async()=>{
      try {
        const summaries=[];let cursor;
        do {
          const data=await api('/api/updates',{method:'POST',body:cursor?{cursor}:{}});
          if(generation!==accountGeneration||revision!==privateRevision)return;
          summaries.push(...data.threads);cursor=data.nextCursor;
        } while(cursor);
        const active=new Set(summaries.map(t=>t.id));
        for(const id of Object.keys(threads)) if(!active.has(id)) delete threads[id];
        for(const summary of summaries) threads[summary.id]=mergeSummary(threads[summary.id]||readMarkers[summary.id],summary);
        invalidateUnavailableChat();
        outbox.retain(active);updatesError=false;updatesCheckedAt=now();saveSession();
      } catch(error) {
        if(generation===accountGeneration) {updatesError=true;if(error.status===401) void accounts.refresh().catch(()=>{});}
      } finally {updatesRequest=null;renderUpdates();if($('#inbox').open)renderInbox();}
    })();
    return updatesRequest;
  }
  const access = [
    ...Object.entries(owners).map(([id, token]) => ({ kind: 'post', id, token })),
    ...Object.entries(threads).filter(([, t]) => t.side === 'guest' || !owners[t.postId]).map(([id, t]) => ({ kind: 'thread', id, token: t.token })),
  ];
  if (!access.length) { updatesError = false; renderUpdates(); return; }
  updatesCursor %= access.length;
  const batch = access.slice(updatesCursor, updatesCursor + 32);
  updatesCursor = (updatesCursor + batch.length) % access.length;
  updatesRequest = (async () => {
    try {
      const data = await api('/api/updates', { method: 'POST', body: { access: batch } });
      for (const summary of data.threads) {
        const token = summary.side === 'owner' ? owners[summary.postId] : threads[summary.id]?.token;
        if (!token || summary.expiresAt <= now()) continue;
        threads[summary.id] = mergeSummary(threads[summary.id], { ...summary, token });
      }
      for (const item of data.unavailable) {
        const sent = batch.find(cap => cap.kind === item.kind && cap.id === item.id);
        if (item.kind === 'post' && owners[item.id] === sent?.token) {
          delete owners[item.id];
          for (const [id, thread] of Object.entries(threads)) if (thread.postId === item.id && thread.side === 'owner') delete threads[id];
        } else if (item.kind === 'thread' && threads[item.id]?.token === sent?.token) delete threads[item.id];
      }
      for (const [id, thread] of Object.entries(threads)) if (thread.expiresAt <= now()) delete threads[id];
      invalidateUnavailableChat();
      updatesError = false; updatesCheckedAt = now(); saveSession();
    } catch { updatesError = true; }
    finally { updatesRequest = null; renderUpdates(); if ($('#inbox').open) renderInbox(); }
  })();
  return updatesRequest;
}
async function openInbox() { if(!accounts.require(openInbox))return;openDialog($('#inbox')); renderInbox(); renderUpdates(); await pollUpdates(); }
$('#inbox-button').addEventListener('click', openInbox);
$('#reply-notice').addEventListener('click', () => updatesError ? pollUpdates() : openInbox());
$('#refresh-inbox').addEventListener('click', pollUpdates);
$('#inbox-list').addEventListener('click', e => { const button = e.target.closest('[data-thread]'); if (button) openChat(button.dataset.thread); });
let chatRequest = 0;
const chatReads = new Map();
function stopAudio(root,forget=false) {
  root.querySelectorAll('audio').forEach(audio=>{audio.pause?.();if(forget){audio.removeAttribute('src');audio.load?.();}});
}
function invalidateUnavailableChat() {
  if(!state.chat||threads[state.chat])return;
  clearInterval(chatTimer);++chatRequest;state.chat=null;
  voice.discard();stopAudio($('#chat'),true);$('#chat-messages').replaceChildren();
  $('#chat-form').hidden=true;$('#chat-input').disabled=true;$('#chat-form button').disabled=true;
  $('#chat-safety').hidden=true;$('#chat-block-status').textContent='';
  $('#chat-error').textContent='Cette conversation n’est plus disponible.';$('#chat-error').hidden=false;
}
function reportVoiceMarkup(report) {
  try {
    const messages=JSON.parse(report.evidence).thread?.messages||[];
    return messages.filter(message=>message.voice&&/^[a-zA-Z0-9-]{1,80}$/.test(message.id)).map(message=>`<p class="voice-message-label">Vocal signalé · ${Math.ceil(message.voice.durationMs/1000)} s</p><audio controls preload="none" aria-label="Écouter le vocal signalé" src="/api/moderation/reports/${encodeURIComponent(report.id)}/voice/${encodeURIComponent(message.id)}"></audio>`).join('');
  }catch{return '';}
}
function renderVoice() {
  const panel=$('#voice-composer'),snapshot=voice.snapshot(),blocked=Boolean(threads[state.chat]?.blocked);
  panel.hidden=!state.production||!state.voiceEnabled||!state.chat||!threads[state.chat];
  const playable=Boolean($('#voice-preview').canPlayType?.('audio/ogg; codecs=opus'));
  $('#voice-record').hidden=snapshot.phase!=='idle'||!snapshot.supported||!playable;
  $('#voice-record').disabled=blocked;
  $('#voice-help').textContent=blocked?'Cet échange est bloqué.':!snapshot.supported||!playable?'Les vocaux ne sont pas disponibles dans ce navigateur. Le texte reste disponible.':'1 minute maximum. Vous écoutez, puis vous choisissez d’envoyer.';
  $('#voice-active').hidden=snapshot.phase==='idle';
  const labels={requesting:'Autorisez le micro pour enregistrer.',recording:`Enregistrement · 0:${String(snapshot.seconds).padStart(2,'0')} / 1:00`,finishing:'Préparation de votre écoute…',ready:'Votre vocal est prêt. Rien n’est encore envoyé.',sending:'Envoi et vérification du vocal…'};
  $('#voice-status').textContent=snapshot.error&&snapshot.phase==='ready'?'Envoi non confirmé. Réessayez ce même vocal ou effacez le brouillon.':labels[snapshot.phase]||'';
  $('#voice-stop').hidden=snapshot.phase!=='recording';
  $('#voice-send').hidden=!['ready','sending'].includes(snapshot.phase);
  $('#voice-send').disabled=snapshot.phase==='sending'||blocked;
  $('#voice-send').textContent=snapshot.error?'Réessayer l’envoi':snapshot.phase==='sending'?'Envoi en cours…':'Envoyer le vocal';
  $('#voice-discard').disabled=snapshot.phase==='sending';
  const preview=$('#voice-preview');preview.hidden=!snapshot.previewUrl;
  if(preview.getAttribute('src')!==snapshot.previewUrl){preview.pause?.();if(snapshot.previewUrl)preview.src=snapshot.previewUrl;else preview.removeAttribute('src');preview.load?.();}
  $('#voice-error').hidden=!snapshot.error;if(snapshot.error)$('#voice-error').textContent=errorText(snapshot.error);
}
function renderChatMessages(thread,id) {
  const container=$('#chat-messages'),existing=new Map([...container.children].map(node=>[node.dataset.messageId,node]));
  const beforeBottom=$('#chat').scrollTop+$('#chat').clientHeight>=$('#chat').scrollHeight-120;
  let changed=false;
  thread.messages.forEach((message,index)=>{
    const signature=JSON.stringify([message,thread.side,threads[id].timezone]);let node=existing.get(message.id);
    if(!node||node.dataset.signature!==signature) {
      if(node){stopAudio(node,true);node.remove();}
      node=document.createElement('div');node.className=`chat-bubble ${message.sender===thread.side?'mine':''}`;node.dataset.messageId=message.id;node.dataset.signature=signature;
      if(message.voice) {
        const label=document.createElement('p');label.className='voice-message-label';label.textContent=`Message vocal · ${Math.ceil(message.voice.durationMs/1000)} s`;node.append(label);
        const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=`/api/voice/${encodeURIComponent(message.id)}`;audio.setAttribute('aria-label',`Écouter le vocal ${message.sender===thread.side?'envoyé':'reçu'}`);
        const unavailable=document.createElement('p');unavailable.className='field-help';unavailable.hidden=true;unavailable.textContent='Lecture indisponible. Le vocal peut avoir expiré, ou ce navigateur ne lit pas ce format.';
        audio.addEventListener('error',()=>{unavailable.hidden=false;});node.append(audio,unavailable);
      }else node.append(document.createTextNode(message.text));
      const meta=document.createElement('small');meta.textContent=`${message.sender===thread.side?'Vous':'Votre interlocuteur'} · ${time(message.createdAt,threads[id].timezone)}`;node.append(meta);
      changed=true;
    }
    if(container.children[index]!==node)container.insertBefore(node,container.children[index]||null);
    existing.delete(message.id);
  });
  for(const node of existing.values()){stopAudio(node,true);node.remove();changed=true;}
  // Stable nodes keep their playback position when a new text reply arrives.
  if(changed&&beforeBottom)$('#chat-form').scrollIntoView({block:'end'});
}
$('#voice-record').addEventListener('click',()=>{if(state.voiceEnabled&&state.chat&&threads[state.chat]&&!threads[state.chat].blocked)void voice.start();});
$('#voice-stop').addEventListener('click',()=>voice.stop());
$('#voice-discard').addEventListener('click',()=>voice.discard());
$('#voice-send').addEventListener('click',async()=>{
  const id=state.chat,generation=accountGeneration;if(!id||!threads[id]||threads[id].blocked||!state.voiceEnabled)return;
  const intent=voice.beginSend();if(!intent)return;
  try {await uploadVoice(id,intent);if(voice.finishSend(intent)&&state.chat===id&&generation===accountGeneration){toast('Vocal envoyé.');void refreshChat();}}
  catch(error){voice.finishSend(intent,error);}
});
document.addEventListener('play',event=>{if(event.target.tagName==='AUDIO')$$('audio').forEach(audio=>{if(audio!==event.target)audio.pause?.();});},true);
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopAudio(document);if(['requesting','recording','finishing'].includes(voice.phase))voice.fail('recording_interrupted');}});
window.addEventListener('pagehide',()=>{voice.discard();stopAudio(document,true);});
function refreshChat() {
  const id = state.chat; if (!id || !threads[id] || document.hidden || !$('#chat').open) return;
  if (chatReads.has(id)) return chatReads.get(id);
  const request = ++chatRequest;
  const pending = (async () => {
  try {
    const { thread } = await api(`/api/threads/${id}`, { chat: state.production?undefined:threads[id].token });
    if (state.chat !== id || request !== chatRequest || !threads[id] || !$('#chat').open || document.hidden) return;
    renderChatMessages(thread,id);
    threads[id] = markRead(threads[id], { incomingCount: thread.incomingCount, messageCount: thread.messages.length, updatedAt: thread.updatedAt });
    threads[id].blocked=thread.blocked;threads[id].blockedByMe=thread.blockedByMe;
    if(thread.blocked&&voice.phase!=='idle')voice.discard();renderVoice();
    $('#chat-input').disabled=Boolean(thread.blocked);
    $('#chat-form button').disabled=Boolean(thread.blocked)||outbox.get(id).busy;
    if(state.production) {
      $('#chat-block').textContent=thread.blockedByMe?'Débloquer':'Bloquer';
      $('#chat-block-status').textContent=thread.blocked?'Cet échange est bloqué. Les anciens messages restent lisibles.':'';
    }
    saveSession(); renderUpdates();
    // Reading successfully must not erase an unresolved sending error.
    const sendingError = outbox.get(id).error;
    $('#chat-error').hidden = !sendingError;
    if (sendingError) $('#chat-error').textContent = errorText(sendingError);
  } catch (error) {
    if (state.chat !== id || request !== chatRequest) return;
    $('#chat-error').textContent = errorText(error); $('#chat-error').hidden = false;
    if (error.status === 404 || error.status === 403) { delete threads[id];invalidateUnavailableChat(); outbox.retain(new Set(Object.keys(threads))); saveSession(); renderUpdates(); }
  } finally { chatReads.delete(id); }
  })();
  chatReads.set(id, pending);
  return pending;
}
async function openChat(id) {
  if (!threads[id]) return;
  clearInterval(chatTimer);
  voice.discard();stopAudio($('#chat'),true);
  openDialog($('#chat')); state.chat = id; ++chatRequest;
  $('#chat-title').textContent = 'En direct, à deux.';
  $('#chat-subtitle').textContent = `${threads[id].role} · ${threads[id].zoneLabel} · ${state.production?`privé jusqu’au ${dateTime(threads[id].expiresAt,threads[id].timezone)}`:'échange local'}`;
  $('#chat-safety').hidden=!state.production;$('#chat-block-status').textContent='';$('#chat-input').disabled=false;
  $('#chat-messages').innerHTML = '<p class="loading-copy">Ouverture de la conversation…</p>';
  const entry = outbox.get(id);
  $('#chat-error').hidden = !entry.error;
  if (entry.error) $('#chat-error').textContent = errorText(entry.error);
  $('#chat-form').hidden = false; $('#chat-input').value = entry.draft;
  $('#chat-form button').disabled = entry.busy;
  renderVoice();
  await refreshChat(); if (state.chat === id && $('#chat').open) chatTimer = setInterval(refreshChat, 1800);
}
$('#chat-input').addEventListener('input', () => { if (state.chat) outbox.edit(state.chat, $('#chat-input').value); });
$('#chat-form').addEventListener('submit', async e => {
  e.preventDefault(); const id = state.chat, token = threads[id]?.token;
  if (!id || (!state.production&&!token) || threads[id]?.blocked) return;
  outbox.edit(id, $('#chat-input').value);
  const intent = outbox.begin(id); if (!intent) return;
  $('#chat-form button').disabled = true; $('#chat-error').hidden = true;
  try {
    await api(`/api/threads/${id}/messages`, { method: 'POST', chat: state.production?undefined:token, body: { message: intent.text }, idempotencyKey: intent.key });
    outbox.finish(id, intent);
    if (state.chat === id && $('#chat').open && threads[id]) {
      $('#chat-input').value = outbox.get(id).draft;
      void refreshChat();
    }
  } catch (error) {
    outbox.finish(id, intent, error);
    if (state.chat === id && $('#chat').open) { $('#chat-error').textContent = errorText(error); $('#chat-error').hidden = false; }
  } finally {
    if (state.chat === id && $('#chat').open) $('#chat-form button').disabled = !threads[id] || threads[id]?.blocked || outbox.get(id).busy;
  }
});

let cityResults = [], cityRequest = 0;
function setCity(city, point = null) {
  state.city = city; state.point = point; state.zone = 'all'; state.selected = null;
  $('#city-name').textContent = city.name;
  $('#city-button').setAttribute('aria-label', `Choisir une ville, actuellement ${city.name}`);
  $('#zone-control').hidden = city.id !== '2988507';
  $('#map-area').textContent = `${city.name} · rayon 25 km`;
  $('#map').setAttribute('aria-label', `Carte de ${city.name}. Flèches pour déplacer, plus et moins pour zoomer.`);
  $('#recenter').setAttribute('aria-label', `Recentrer sur ${city.name}`);
  syncFilters(); map.recenter(point || city); render();
  if(state.production&&liveReady) void changeFeed();
}
$('#city-button').addEventListener('click', () => { openDialog($('#location-picker')); $('#location-query').focus(); });
$('#location-search').addEventListener('submit', async e => {
  e.preventDefault(); const request = ++cityRequest; $('#location-status').textContent = 'Recherche des villes…'; $('#location-results').replaceChildren();
  try {
    const result = await api(`/api/locations?q=${encodeURIComponent($('#location-query').value.trim())}`);
    if (request !== cityRequest) return;
    cityResults = result.locations;
    $('#location-status').textContent = cityResults.length ? `${cityResults.length} ville${cityResults.length > 1 ? 's' : ''} trouvée${cityResults.length > 1 ? 's' : ''}.` : 'Pas de ville trouvée. Essayez une grande ville voisine.';
    $('#location-results').innerHTML = cityResults.map((city, i) => `<button class="location-result" data-city="${i}"><span>${esc(city.name)}<small>${esc(city.country)}</small></span>${icon('arrow-up-right')}</button>`).join('');
  } catch (error) { if (request === cityRequest) $('#location-status').textContent = errorText(error); }
});
$('#location-results').addEventListener('click', e => { const b = e.target.closest('[data-city]'); if (!b) return; const city = cityResults[Number(b.dataset.city)]; if (city) { setCity(city); $('#location-picker').close(); } });
$('#use-location').addEventListener('click', () => {
  if (!navigator.geolocation) { $('#location-status').textContent = 'Localisation indisponible. Choisissez une ville.'; return; }
  const button = $('#use-location'); button.disabled = true; const request = ++cityRequest;
  $('#location-status').textContent = 'Votre navigateur va demander votre autorisation.';
  navigator.geolocation.getCurrentPosition(async position => {
    // Never send or store raw device coordinates. Round before building the request.
    const point = { lat: Number(position.coords.latitude.toFixed(2)), lng: Number(position.coords.longitude.toFixed(2)) };
    try {
      const { location: city } = await api(`/api/locations/nearest?lat=${point.lat}&lng=${point.lng}`);
      if (request !== cityRequest) return;
      setCity(city, point); $('#location-picker').close(); toast('Zone approximative sélectionnée. Aucun suivi continu.');
    } catch (error) { if (request === cityRequest) $('#location-status').textContent = ['location_too_far', 'point_too_far_from_city', 'no_nearby_location'].includes(error.code) ? 'Aucune ville assez proche. Choisissez une ville manuellement.' : errorText(error); }
    finally { button.disabled = false; }
  }, () => { button.disabled = false; if (request === cityRequest) $('#location-status').textContent = 'Localisation refusée ou indisponible. La recherche par ville reste accessible.'; }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
});

function openAccountLink() {
  const values = new URL(location.href).searchParams.getAll('account');
  if (values.length !== 1 || values[0] !== 'delete') return false;
  accounts.showDeletion();
  return true;
}
async function start() {
  let deletionLink = false;
  try {
    try { await accounts.refresh(); }
    finally { deletionLink = openAccountLink(); }
    const [zones, roleGroups] = await Promise.all([api('/api/zones'), api('/api/roles')]); state.zones = zones;
    state.roles = roleGroups.flatMap(group => group.roles);
    const options = zones.map(zone => `<option value="${esc(zone.id)}">${esc(zone.label)}</option>`).join(''); $('#zone-filter').insertAdjacentHTML('beforeend', options); $('#form-zone').innerHTML = options;
    const roleOptions = roleGroups.map(group => `<optgroup label="${esc(group.label)}">${group.roles.map(role => `<option value="${esc(role)}">${esc(role)}</option>`).join('')}</optgroup>`).join('');
    $('#role-filter').insertAdjacentHTML('beforeend', roleOptions); $('#form-role').insertAdjacentHTML('beforeend', roleOptions);
    const shared = parseFeedLink(deletionLink ? new URL('/', location.href).href : location.href, state.roles), requested = shared.postId;
    function linkNotice(message) { $('#feed-link-notice').textContent = message; $('#feed-link-notice').hidden = false; }
    if (shared.invalid) linkNotice('Certains filtres de ce lien sont invalides et ont été ignorés.');
    let linkedPost;
    if (requested && state.production) {
      try { linkedPost = (await api(`/api/posts/${requested}`)).post; }
      catch { linkNotice('Cette annonce a expiré ou n’existe plus. Voici le fil actuel.'); }
    } else if (shared.scope) {
      try {
        const { location: city } = await api(`/api/locations/${shared.scope.cityId}`);
        if (city.id !== shared.scope.cityId) throw new Error('invalid_shared_city');
        state.city = city; state.point = null; state.role = shared.scope.role; state.kind = shared.scope.kind;
      } catch { linkNotice('Impossible de vérifier la ville de ce lien. Le fil par défaut est affiché.'); }
    }
    const cityOfPost = post => ({ id: String(post.cityId || '2988507'), name: post.cityName || 'Paris', label: post.cityName ? `${post.cityName} · ${post.country}` : 'Paris · FR', lat: post.lat, lng: post.lng, country: post.country || 'FR', timezone: post.timezone || 'Europe/Paris' });
    if (linkedPost) state.city = cityOfPost(linkedPost);
    setCity(state.city);
    // Resolve the destination before the first snapshot and before opening SSE.
    // A login/logout during startup also invalidates the pending private snapshot.
    while (true) {
      const generation = accountGeneration;
      const initial = await api(`/api/state${feedQuery()}`);
      if (generation !== accountGeneration) continue;
      receive(initial); break;
    }
    if (linkedPost && !state.posts.some(post => post.id === linkedPost.id)) state.posts.push(linkedPost);
    if (requested) {
      const post = state.posts.find(post => post.id === requested);
      if (post) { if (!state.production) setCity(cityOfPost(post)); selectPost(requested); openDetail(requested); }
      else if (!$('#feed-link-notice').textContent) linkNotice('Cette annonce a expiré ou n’existe plus. Voici le fil actuel.');
    }
  } catch (error) { setConnection(false); $('#post-list').innerHTML = `<div class="empty-state">${icon('radio')}<h3>Le fil est indisponible.</h3><p>${esc(errorText(error))}</p><button class="button outline" id="retry">Réessayer</button></div>`; $('#retry')?.addEventListener('click', () => location.reload()); return; }
  // Hidden tabs must not occupy the browser's limited HTTP/1 connections with
  // permanent streams while a foreground tab is trying to publish or send.
  liveReady=true;
  for(const id of ['available-button','need-button','mine-nav','inbox-button','city-button','share-feed'])$('#'+id).disabled=false;
  syncLiveConnection();
  setInterval(() => { render(); renderUpdates(); }, 15000);
  void pollUpdates(); setInterval(pollUpdates, 6000);
  window.addEventListener('online', () => { void refreshPublicState(); void pollUpdates(); });
  window.addEventListener('offline', () => { setConnection(false); updatesError = Object.keys(owners).length + Object.keys(threads).length > 0; renderUpdates(); });
  document.addEventListener('visibilitychange', () => { syncLiveConnection(); if (!document.hidden) { if(state.production)void accounts.refresh().catch(()=>setConnection(false));else void refreshPublicState();void pollUpdates(); void refreshChat(); } });
}
start();
