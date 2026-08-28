// Private planning. Drafts and retry intents live in this page's memory.
// Public announcements require separate review; no assignments or automatic retries.
import { prepareEventPost } from './event-post-drafts.js';
import { createEventPublishingUI } from './event-publishing.js';
const clone = value => JSON.parse(JSON.stringify(value));
const payloadKeys = ['title', 'cityId', 'timezone', 'venue', 'startLocal', 'endLocal', 'common', 'needs'];
const payload = value => Object.fromEntries(payloadKeys.map(key => [key, clone(value[key])]));
const issue = code => Object.assign(new Error(code), { code });
const uncertain = error => !error.status || error.status >= 500;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const instructionLabels = { attire: 'Tenue', equipment: 'Matériel', arrival: 'Arrivée' };
const languageLabels = { none: 'Non demandé', preferred: 'Souhaité', required: 'Requis' };

// Only public catalogue identifiers and labels are retained here. No plan,
// account, venue, draft or schedule enters this cache.
export class EventCityLabels {
  constructor(api) { this.api = api; this.entries = new Map(); }
  state(id) { return this.entries.get(String(id))?.state || 'loading'; }
  label(id) {
    const entry = this.entries.get(String(id));
    return entry?.state === 'ready' ? entry.label : entry?.state === 'error' ? 'Nom de ville indisponible' : 'Chargement du nom de ville…';
  }
  ensure(id, retry = false) {
    id = String(id);
    const prior = this.entries.get(id);
    if (prior && (!retry || prior.state !== 'error')) return prior.promise;
    const entry = { state: 'loading', label: null, promise: null };
    this.entries.set(id, entry);
    entry.promise = (async () => {
      try {
        if (!/^\d{1,10}$/.test(id)) throw issue('invalid_city_id');
        const result = await this.api(`/api/locations/${id}`), city = result?.location;
        if (String(city?.id) !== id || typeof city?.name !== 'string' || !city.name.trim()) throw issue('invalid_city_response');
        entry.label = typeof city.label === 'string' && city.label.trim() ? city.label : `${city.name}${typeof city.country === 'string' ? ` · ${city.country}` : ''}`;
        entry.state = 'ready';
      } catch { entry.state = 'error'; }
      return this.label(id);
    })();
    return entry.promise;
  }
}

export async function bindEventCityLabels(panel, cities, isCurrent, retry = false) {
  const nodes = [...panel.querySelectorAll('[data-event-city]')];
  function update(id) {
    if (!isCurrent()) return;
    for (const node of nodes) if (node.dataset.eventCity === id && panel.contains(node)) node.textContent = cities.label(id);
    const retryButton = panel.querySelector('#event-city-label-retry');
    if (retryButton) retryButton.hidden = ![...panel.querySelectorAll('[data-event-city]')].some(node => cities.state(node.dataset.eventCity) === 'error');
  }
  await Promise.all([...new Set(nodes.map(node => node.dataset.eventCity))].map(async id => {
    const request = cities.ensure(id, retry); update(id);
    await request; update(id);
  }));
}

export function eventPlanError(error, fallback = () => 'Cette action n’a pas abouti. Réessayez.') {
  const messages = {
    event_plan_changed: 'Cet événement a changé ailleurs. Votre brouillon est conservé. Consultez la version enregistrée avant de continuer.',
    event_plan_idempotency_conflict: 'Cet identifiant a déjà servi avec un autre contenu. Votre brouillon est conservé ; consultez la version enregistrée.',
    event_plan_deleted: 'Cet événement a été supprimé. Il ne sera pas recréé. Votre saisie reste visible ici jusqu’à votre départ.',
    event_plan_not_found: 'Cet événement est introuvable ou n’est plus accessible. Votre saisie reste ici ; aucune recréation automatique.',
    event_plan_capacity_reached: 'Vous avez 20 événements conservés, événements passés compris. Supprimez-en un avant d’en préparer un autre.',
    event_plan_idempotency_capacity_reached: 'La capacité de préparation est atteinte. Aucune nouvelle création confirmée ; réessayez plus tard.',
    event_start_out_of_range: 'Le début doit être futur, dans les 180 jours. Un événement commencé reste consultable et supprimable, mais n’est plus modifiable.',
    event_started: 'L’événement a commencé : lecture et suppression seulement. Les compteurs manuels ne peuvent plus être modifiés.',
    invalid_event_duration: 'La fin doit suivre le début, avec une durée maximale de 36 heures.',
    event_time_nonexistent: 'Cette heure n’existe pas dans le fuseau de la ville au changement d’heure. Choisissez un autre horaire.',
    event_time_ambiguous: 'Cette heure se produit deux fois dans le fuseau de la ville. Choisissez un horaire non ambigu.',
    invalid_event_local_time: 'Renseignez une date et une heure valides pour le début et la fin.',
    event_timezone_mismatch: 'Le fuseau ne correspond plus à la ville. Sélectionnez à nouveau la ville dans le catalogue.',
    invalid_event_timezone: 'Le fuseau de cette ville est indisponible. Choisissez une autre ville.',
    event_plan_personal_data: 'Retirez les coordonnées personnelles ou bancaires. Décrivez le lieu et les besoins sans nom de personne, téléphone ou email.',
    invalid_event_quantity: 'Pour chaque besoin : 1 à 50 personnes, et un nombre confirmé manuellement compris entre 0 et la quantité recherchée.',
    invalid_event_needs: 'Conservez entre 1 et 12 besoins.',
    invalid_event_languages: 'Choisissez Non demandé, Souhaité ou Requis pour chaque langue.',
    invalid_role: 'Choisissez un métier du catalogue.',
    event_plan_too_large: 'Le contenu de cet événement est trop long. Raccourcissez les consignes.',
    event_plan_revision_exhausted: 'Cet événement ne peut plus être modifié. Consultez-le ou contactez le support.',
    login_required: 'Votre session doit être renouvelée. Reconnectez-vous ; aucun enregistrement n’est confirmé.',
    event_retry_pending: 'Vérifiez d’abord la tentative précédente. Elle conservera exactement son contenu initial.',
    event_publication_pending: 'Vérifiez d’abord la publication en cours ou non confirmée. Votre préparation reste conservée.',
  };
  if (messages[error.code]) return messages[error.code];
  if (uncertain(error)) return 'Réponse interrompue : le résultat n’est pas confirmé. Votre saisie est conservée. Vérifiez la tentative avant un nouvel envoi.';
  return fallback(error);
}

export class EventPlansClient {
  constructor({ api, makeId = () => crypto.randomUUID(), now = Date.now, onChange = () => {}, onError = () => {} }) {
    Object.assign(this, { api, makeId, now, onChange, onError }); this.epoch = 0; this.reset();
  }
  reset() { this.epoch++; this.entries = new Map(); this.plans = []; this.currentId = null; this.listBusy = false; this.listLoaded = false; this.listError = null; this.readTicket = 0; this.onChange('reset'); }
  get current() { return this.entries.get(this.currentId); }
  dirty(entry = this.current) { return Boolean(entry && (!entry.saved || JSON.stringify(entry.draft) !== JSON.stringify(payload(entry.saved)))); }
  readonly(entry = this.current) { return Boolean(entry && (entry.gone || entry.saved?.startsAt <= this.now())); }
  preparePost(needId, options) {
    const entry = this.current;
    if (!entry?.saved || entry.busy || entry.intent || entry.conflict || entry.gone || this.dirty(entry))
      return { ok: false, code: 'event_draft_unavailable' };
    // This is a preview only. Publication must still validate the current user
    // and payload; neither this source snapshot nor a manual count reserves work.
    return prepareEventPost(entry.saved, needId, { ...options, now: this.now() });
  }
  async verifyPostSource(source, draft, roles) {
    const entry = this.current, epoch = this.epoch;
    const current = () => epoch === this.epoch && this.current === entry && entry?.saved &&
      !entry.busy && !entry.intent && !entry.conflict && !entry.gone && !this.dirty(entry) &&
      entry.id === source?.planId && entry.saved.revision === source?.revision;
    if (!current()) throw issue('event_draft_unavailable');
    const { plan } = await this.api(`/api/event-plans/${entry.id}`);
    if (!current()) throw issue('event_draft_unavailable');
    this.validateView(plan, entry.id);
    if (plan.revision !== source.revision) {
      entry.conflict = true; entry.server = clone(plan); entry.error = issue('event_plan_changed'); this.changed();
      throw entry.error;
    }
    const checked = prepareEventPost(plan, source.needId, { roles, now: this.now(), places: draft.places, durationMinutes: draft.durationMinutes });
    if (!checked.ok) throw issue(checked.code);
    if (checked.draft.role !== draft.role || checked.draft.cityId !== draft.cityId || checked.draft.notAfter !== draft.notAfter) throw issue('event_draft_unavailable');
    // Preflight only. This read is not a reservation or an atomic event/post link.
    return true;
  }
  changed(reason = 'render') { this.onChange(reason); }
  newNeed() { return { id: this.makeId(), role: '', quantity: 1, confirmed: 0, languages: { fr: 'none', en: 'none' }, skills: '', overrides: { attire: null, equipment: null, arrival: null } }; }
  create(city) {
    if (this.plans.length >= 20) throw issue('event_plan_capacity_reached');
    const id = this.makeId();
    this.entries.set(id, { id, draft: { title: '', cityId: city.id, timezone: city.timezone, venue: '', startLocal: '', endLocal: '', common: { attire: '', equipment: '', arrival: '' }, needs: [this.newNeed()] }, cityLabel: city.label || city.name, saved: null, busy: false, intent: null, conflict: false, server: null, error: null, backup: null });
    this.currentId = id; this.changed(); return this.current;
  }
  edit(mutator) {
    const entry = this.current; if (!entry || entry.busy || this.readonly(entry)) return false;
    const draft = clone(entry.draft); mutator(draft); entry.draft = draft; this.changed('edit'); return true;
  }
  addNeed() { if (this.current?.draft.needs.length >= 12) return; if (this.edit(draft => draft.needs.push(this.newNeed()))) this.changed(); }
  removeNeed(id) { if (this.current?.draft.needs.length <= 1) return; if (this.edit(draft => { draft.needs = draft.needs.filter(need => need.id !== id); })) this.changed(); }
  async list() {
    const epoch = this.epoch, ticket = ++this.readTicket; this.listBusy = true; this.listError = null; this.changed();
    try {
      const result = await this.api('/api/event-plans');
      if (epoch !== this.epoch || ticket !== this.readTicket) return;
      if (!Array.isArray(result.plans)) throw issue('invalid_event_response');
      this.plans = result.plans; this.listLoaded = true;
    } catch (error) { if (epoch === this.epoch && ticket === this.readTicket) { this.listError = error; this.onError(error); } }
    finally { if (epoch === this.epoch && ticket === this.readTicket) { this.listBusy = false; this.changed(); } }
  }
  async open(id) {
    if (this.entries.has(id)) { this.readTicket++; this.listBusy = false; this.currentId = id; this.changed(); return; }
    const epoch = this.epoch, ticket = ++this.readTicket; this.listBusy = true; this.listError = null; this.changed();
    try {
      const { plan } = await this.api(`/api/event-plans/${id}`);
      if (epoch !== this.epoch || ticket !== this.readTicket) return;
      this.validateView(plan, id);
      this.entries.set(id, { id, saved: clone(plan), draft: payload(plan), busy: false, intent: null, conflict: false, server: null, error: null, backup: null });
      this.currentId = id;
    } catch (error) { if (epoch === this.epoch && ticket === this.readTicket) { this.listError = error; this.onError(error); } }
    finally { if (epoch === this.epoch && ticket === this.readTicket) { this.listBusy = false; this.changed(); } }
  }
  validateView(plan, id) { if (!plan || plan.id !== id || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || plan.visibility !== 'private' || !Array.isArray(plan.needs)) throw issue('invalid_event_response'); }
  back() { this.currentId = null; this.readTicket++; this.listBusy = false; this.changed(); }
  async run(entry, intent) {
    if (entry.busy) return; const epoch = this.epoch; this.readTicket++; this.listBusy = false; entry.busy = true; entry.error = null; this.changed();
    try {
      const result = await this.api(intent.path, { method: intent.method, body: JSON.parse(intent.body) });
      if (epoch !== this.epoch || this.entries.get(entry.id) !== entry) return;
      if (intent.method === 'DELETE') {
        if (result.deleted !== true || result.id !== entry.id) throw issue('invalid_event_response');
        this.entries.delete(entry.id); this.plans = this.plans.filter(plan => plan.id !== entry.id); if (this.currentId === entry.id) this.currentId = null;
      } else {
        this.validateView(result.plan, entry.id);
        const untouched = JSON.stringify(entry.draft) === intent.draft;
        entry.saved = clone(result.plan); entry.intent = null; entry.conflict = false; entry.server = null;
        // A create replay can return a newer server revision. Never silently
        // turn the user's older draft into an overwrite of that revision.
        if (JSON.stringify(payload(result.plan)) !== intent.draft && result.replayed) {
          entry.conflict = true; entry.server = clone(result.plan); entry.error = issue('event_plan_changed');
        } else if (untouched) entry.draft = payload(result.plan);
        this.plans = [...this.plans.filter(plan => plan.id !== entry.id), clone(result.plan)].sort((a, b) => a.startsAt - b.startsAt);
      }
    } catch (error) {
      if (epoch !== this.epoch || this.entries.get(entry.id) !== entry) return;
      entry.error = error;
      if (!uncertain(error)) entry.intent = null;
      if (error.status === 409) entry.conflict = true;
      if (error.status === 404 || error.status === 410) entry.gone = true;
      this.onError(error);
    } finally { if (epoch === this.epoch && this.entries.get(entry.id) === entry) entry.busy = false; if (epoch === this.epoch) this.changed(); }
  }
  async save() {
    const entry = this.current; if (!entry || entry.busy || entry.conflict || entry.gone) return;
    // An uncertain request is retried only from the immutable stored intent.
    if (entry.intent) return this.run(entry, entry.intent);
    if (this.readonly(entry)) { entry.error = issue('event_started'); this.changed(); return; }
    const data = payload(entry.draft), method = entry.saved ? 'PATCH' : 'POST';
    const body = entry.saved ? { expectedRevision: entry.saved.revision, ...data } : { id: entry.id, ...data };
    entry.intent = { method, path: `/api/event-plans${entry.saved ? `/${entry.id}` : ''}`, body: JSON.stringify(body), draft: JSON.stringify(data) };
    return this.run(entry, entry.intent);
  }
  async remove() {
    const entry = this.current; if (!entry?.saved || entry.busy || entry.conflict || entry.gone) return;
    if (entry.intent && entry.intent.method !== 'DELETE') { entry.error = issue('event_retry_pending'); this.changed(); return; }
    entry.intent ||= { method: 'DELETE', path: `/api/event-plans/${entry.id}`, body: JSON.stringify({ expectedRevision: entry.saved.revision }) };
    return this.run(entry, entry.intent);
  }
  async inspect() {
    const entry = this.current; if (!entry || entry.busy) return;
    const epoch = this.epoch; entry.busy = true; entry.error = null; this.changed();
    try {
      const { plan } = await this.api(`/api/event-plans/${entry.id}`);
      if (epoch !== this.epoch || this.entries.get(entry.id) !== entry) return;
      this.validateView(plan, entry.id); entry.server = clone(plan);
      // Inspection never changes draft, revision, retry intent or conflict.
    } catch (error) { if (epoch === this.epoch) { entry.error = error; this.onError(error); } }
    finally { if (epoch === this.epoch) { entry.busy = false; this.changed(); } }
  }
  adoptServer() {
    const entry = this.current; if (!entry?.server || entry.busy) return;
    entry.backup = clone(entry.draft); (entry.backups ||= []).push(entry.backup); entry.saved = clone(entry.server); entry.draft = payload(entry.server);
    entry.intent = null; entry.conflict = false; entry.gone = false; entry.error = null; entry.server = null; this.changed();
  }
}

function planSummary(plan, cityName) {
  const instructions = values => Object.entries(instructionLabels).map(([key, label]) => `<dt>${label}</dt><dd>${esc(values[key] || 'Aucune consigne')}</dd>`).join('');
  return `<h3>${esc(plan.title || 'Sans titre')}</h3><p>${esc(plan.startLocal?.replace('T', ' à '))} → ${esc(plan.endLocal?.replace('T', ' à '))}<br>${esc(plan.venue)} · ${cityName} · ${esc(plan.timezone)}</p><dl>${instructions(plan.common)}</dl>${plan.needs.map(need => `<div class="event-read-need"><h4>${esc(need.role || 'Métier à choisir')} : ${esc(need.quantity)} recherchés, ${esc(need.confirmed)} confirmés manuellement</h4><p>Français : ${languageLabels[need.languages.fr]} · Anglais : ${languageLabels[need.languages.en]}</p><p>${esc(need.skills || 'Aucune compétence précisée')}</p><dl>${instructions(Object.fromEntries(Object.keys(instructionLabels).map(key => [key, need.overrides[key] === null ? plan.common[key] : need.overrides[key]])))}</dl></div>`).join('')}`;
}

export function createEventPlansUI({ $, api, openDialog, publishPost, onViewPost, getSession, getCity, requireAccount, requireUGC, onRulesError, onSessionError, errorText, confirm = message => globalThis.confirm(message), now = Date.now }) {
  const panel = $('#event-plans-panel'); let visible = false, owner = null, cityResults = [], cityTicket = 0, roleGroups = [], rolesError = false, rolesBusy = false;
  const cities = new EventCityLabels(api);
  let client;
  const report = error => {
    if (['rules_acceptance_required', 'rules_version_changed'].includes(error.code)) {
      const epoch = client.epoch; onRulesError(error, () => { if (epoch === client.epoch && visible) panel.querySelector('#event-save')?.focus(); });
    }
  };
  client = new EventPlansClient({ api, now, onChange: reason => { if (client && reason !== 'edit') render(); }, onError: report });
  const publicationUI = createEventPublishingUI({ $, client, cities, getSession, getRoles: () => roleGroups.flatMap(group => group.roles), openDialog, requireUGC, onRulesError, onLogin: async () => { await onSessionError(); requireAccount(show); }, publishPost, onViewPost, onChange: () => render() });
  function selectView(active) {
    visible = active; panel.hidden = !active; $('#live-content').hidden = active;
    $('#events-nav').classList.toggle('active', active);
    if (active) { $('#events-nav').setAttribute('aria-current', 'page'); for (const id of ['#live-nav', '#mine-nav']) { $(id).classList.remove('active'); $(id).removeAttribute('aria-current'); } }
    else $('#events-nav').removeAttribute('aria-current');
  }
  async function loadRoles() {
    if (roleGroups.length || rolesBusy) return;
    const epoch = client.epoch; rolesBusy = true; rolesError = false; render();
    try { const groups = await api('/api/roles'); if (epoch === client.epoch) { if (!Array.isArray(groups) || !groups.every(group => Array.isArray(group.roles))) throw issue('invalid_roles'); roleGroups = groups; } }
    catch { if (epoch === client.epoch) rolesError = true; }
    finally { if (epoch === client.epoch) { rolesBusy = false; render(); } }
  }
  function field(label, path, value, { type = 'text', max = 120, required = false, min, upper } = {}) {
    return `<label class="field-label">${label}<input data-event-field="${path}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${type === 'text' ? `maxlength="${max}"` : ''} ${min !== undefined ? `min="${min}"` : ''} ${upper !== undefined ? `max="${upper}"` : ''} ${type === 'number' ? 'step="1"' : ''}></label>`;
  }
  function select(label, path, value, options) { return `<label class="field-label">${label}<select data-event-field="${path}">${Object.entries(options).map(([key, title]) => `<option value="${key}" ${value === key ? 'selected' : ''}>${title}</option>`).join('')}</select></label>`; }
  function needEditor(need, index, count) {
    const prefix = `needs.${index}`;
    return `<details class="event-need" data-need-id="${need.id}" ${index === 0 || !need.role ? 'open' : ''}><summary>${esc(need.role || `Besoin ${index + 1}`)} <span>${need.confirmed}/${need.quantity} confirmés manuellement</span></summary><div class="event-need-body"><label class="field-label">Métier<select data-event-field="${prefix}.role" required><option value="">Choisir un métier</option>${roleGroups.map(group => `<optgroup label="${esc(group.label)}">${group.roles.map(role => `<option ${need.role === role ? 'selected' : ''}>${esc(role)}</option>`).join('')}</optgroup>`).join('')}</select></label><div class="event-columns">${field('Personnes recherchées', `${prefix}.quantity`, need.quantity, { type: 'number', min: 1, upper: 50, required: true })}${field('Confirmées manuellement', `${prefix}.confirmed`, need.confirmed, { type: 'number', min: 0, upper: need.quantity, required: true })}</div><div class="event-columns">${select('Français', `${prefix}.languages.fr`, need.languages.fr, languageLabels)}${select('Anglais', `${prefix}.languages.en`, need.languages.en, languageLabels)}</div>${field('Compétences souhaitées · facultatif', `${prefix}.skills`, need.skills, { max: 180 })}<details class="event-exceptions"><summary>Exceptions aux consignes communes</summary><p class="event-help">Laisser la consigne commune, la remplacer ou la retirer pour ce besoin.</p>${Object.entries(instructionLabels).map(([key, label]) => `<div>${select(label, `${prefix}.overrideMode.${key}`, need.overrides[key] === null ? 'inherit' : need.overrides[key] === '' ? 'none' : 'custom', { inherit: 'Consigne commune', none: 'Aucune consigne', custom: 'Consigne propre à ce besoin' })}${field(`Consigne ${label.toLowerCase()} propre à ce besoin`, `${prefix}.overrides.${key}`, need.overrides[key] || '')}</div>`).join('')}</details><button class="text-button" type="button" data-event-action="remove-need" data-id="${need.id}" ${count <= 1 ? 'disabled' : ''}>Retirer ce besoin</button></div></details>`;
  }
  const cityName = id => `<span data-event-city="${esc(id)}">${esc(cities.label(id))}</span>`;
  function render() {
    if (!visible) return;
    const active = panel.ownerDocument?.activeElement;
    const fieldPath = panel.contains?.(active) ? active?.dataset?.eventField : null;
    const selection = fieldPath && active.selectionStart !== null ? [active.selectionStart, active.selectionEnd] : null;
    renderContent();
    const epoch = client.epoch;
    void bindEventCityLabels(panel, cities, () => visible && epoch === client.epoch && Boolean(getSession().user));
    if (fieldPath) {
      const field = panel.querySelector(`[data-event-field="${fieldPath}"]`);
      if (field && !field.disabled) { field.focus({preventScroll:true}); if (selection && typeof field.setSelectionRange === 'function' && !['number','datetime-local'].includes(field.type)) field.setSelectionRange(...selection); }
    }
  }
  function renderContent() {
    if (!visible) return;
    const entry = client.current;
    const heading = `<header class="event-heading"><div><h1 id="event-title" tabindex="-1">${entry ? (entry.saved ? 'Votre événement' : 'Préparer un événement') : 'Vos événements'}</h1><p>Votre événement reste privé. Chaque annonce se publie séparément, après relecture.</p></div>${entry ? '<button type="button" class="text-button" data-event-action="back">Tous les événements</button>' : ''}</header><button id="event-city-label-retry" class="text-button" type="button" data-event-action="city-label-retry" hidden>Réessayer les noms de ville</button>`;
    if (!getSession().user) { panel.innerHTML = `${heading}<p>Connectez-vous pour préparer un événement privé et le retrouver sur vos appareils.</p><button class="button lime" type="button" data-event-action="login">Se connecter</button>`; return; }
    if (!entry) {
      const unsaved = [...client.entries.values()].filter(item => !item.saved);
      panel.innerHTML = `${heading}<div class="event-toolbar"><button class="button lime" type="button" data-event-action="new" ${client.listBusy || !client.listLoaded || client.plans.length >= 20 ? 'disabled' : ''}>Préparer un événement</button><button class="text-button" type="button" data-event-action="refresh" ${client.listBusy ? 'disabled' : ''}>Actualiser</button></div><p class="event-help">Jusqu’à 20 événements, passés compris. 12 besoins maximum par événement.</p>${client.listError ? `<p class="form-error" role="alert">${esc(eventPlanError(client.listError, errorText))}</p>${client.listError.status === 401 ? '<button class="text-button" data-event-action="login">Renouveler ma session</button>' : ''}` : ''}<p role="status">${client.listBusy ? 'Chargement de vos événements…' : ''}</p>${unsaved.length ? `<h2>Brouillons dans cette page</h2><p class="event-help">Non garantis sur le serveur. Fermer la page ou changer de compte les efface.</p>${unsaved.map(item => `<button class="event-list-item" data-event-action="open" data-id="${item.id}"><strong>${esc(item.draft.title || 'Événement sans titre')}</strong><span>${item.intent ? 'Tentative à vérifier' : 'Continuer la préparation'}</span></button>`).join('')}` : ''}<div class="event-list">${client.plans.map(plan => `<button class="event-list-item" data-event-action="open" data-id="${plan.id}" ${client.listBusy ? 'disabled' : ''}><strong>${esc(plan.title)}</strong><span>${esc(plan.startLocal.replace('T', ' à '))} · ${cityName(plan.cityId)} · ${esc(plan.timezone)}</span><span>${plan.totals.confirmed}/${plan.totals.quantity} confirmés manuellement · ${plan.startsAt <= now() ? 'Lecture seulement' : 'À venir'}${client.dirty(client.entries.get(plan.id)) ? ' · Brouillon non enregistré' : ''}</span></button>`).join('')}</div>${client.listLoaded && !client.plans.length && !unsaved.length ? '<p class="event-empty">Un événement à organiser ? Préparez ses horaires, les renforts nécessaires et les consignes communes ici.</p>' : ''}`;
      return;
    }
    const draft = entry.draft, readonly = client.readonly(), locked = entry.busy || readonly, pending = entry.intent, publicationPending = publicationUI.pending(entry.id);
    const status = entry.busy ? 'Échange avec le serveur…' : pending ? 'Résultat non confirmé. La tentative initiale est conservée.' : entry.conflict ? 'Conflit à examiner. Votre brouillon est conservé.' : entry.saved ? (client.dirty() ? 'Modifications non enregistrées.' : `Enregistré en privé · révision ${entry.saved.revision}.`) : 'Brouillon dans cette page, non enregistré.';
    panel.innerHTML = `${heading}<p class="event-privacy">Sans nom de personne, téléphone, email ou coordonnées bancaires. Les confirmations sont des compteurs manuels, sans affectation ni accord vérifié.</p><p id="event-status" role="status" aria-live="polite" tabindex="-1">${status}</p>${entry.error ? `<p class="form-error" role="alert">${esc(eventPlanError(entry.error, errorText))}</p>${entry.error.status === 401 ? '<button class="text-button" data-event-action="login">Renouveler ma session</button>' : ''}` : ''}${readonly ? `<p class="event-warning">${entry.gone ? 'Événement inaccessible : aucune recréation automatique.' : 'L’événement a commencé : sa préparation et ses compteurs ne sont plus modifiables. Une annonce indépendante reste possible avant la fin, si sa durée le permet.'}</p>` : ''}${rolesError ? '<p class="form-error">Le catalogue des métiers n’a pas pu être chargé.</p><button class="text-button" data-event-action="roles">Réessayer le catalogue</button>' : ''}
      <form id="event-plan-form"><fieldset ${locked ? 'disabled' : ''}><legend class="sr-only">Préparation privée</legend><section class="event-section"><h2>Le cadre</h2>${field('Titre de l’événement', 'title', draft.title, { max: 80, required: true })}<p id="event-city-name"><strong>${cityName(draft.cityId)}</strong> · ${esc(draft.timezone)}</p><details class="event-city"><summary>Changer de ville</summary><label class="field-label">Chercher une ville<input id="event-city-query" type="search" minlength="2" maxlength="80" autocomplete="off"></label><button type="button" class="button outline" data-event-action="city-search">Chercher</button><p id="event-city-status" role="status"></p><div id="event-city-results"></div></details>${field('Lieu · sans coordonnées personnelles', 'venue', draft.venue, { required: true })}<div class="event-columns">${field('Début', 'startLocal', draft.startLocal, { type: 'datetime-local', required: true })}${field('Fin', 'endLocal', draft.endLocal, { type: 'datetime-local', required: true })}</div><p class="event-help">Horaires dans le fuseau de la ville : ${esc(draft.timezone)}. Début dans les 180 jours ; durée maximale de 36 heures. Plus de modification après le début.</p></section><details class="event-section event-common"><summary>Consignes communes · facultatif</summary>${Object.entries(instructionLabels).map(([key, label]) => field(label, `common.${key}`, draft.common[key])).join('')}</details><section class="event-section"><h2>Les renforts</h2><p class="event-help">Renseignez les confirmations vous-même, après accord avec les personnes. Ce total n’affecte personne et ne réserve aucune place dans le fil.</p>${draft.needs.map((need, index) => needEditor(need, index, draft.needs.length)).join('')}<button class="button outline" type="button" data-event-action="add-need" ${draft.needs.length >= 12 ? 'disabled' : ''}>Ajouter un besoin</button><p class="event-help">${draft.needs.length}/12 besoins</p></section></fieldset>
      <div class="event-save"><button id="event-save" class="button lime" type="submit" ${locked || entry.conflict || pending || publicationPending || !roleGroups.length ? 'disabled' : ''}>${entry.saved ? 'Enregistrer les modifications' : 'Enregistrer en privé'}</button><p class="event-help">Enregistrer ne publie aucune annonce. Le brouillon non envoyé reste dans cette page seulement.</p></div></form>${publicationUI.actions(entry)}
      ${pending ? `<div class="event-recovery"><p>La vérification renvoie exactement la demande initiale, même si vous avez retouché le brouillon. Les retouches restent à enregistrer ensuite.</p><button class="button outline" data-event-action="retry" ${entry.busy ? 'disabled' : ''}>${pending.method === 'DELETE' ? 'Vérifier la suppression' : 'Vérifier la tentative initiale'}</button></div>` : ''}
      ${entry.saved || entry.conflict || pending ? `<div class="event-recovery"><button class="text-button" data-event-action="inspect" ${entry.busy ? 'disabled' : ''}>Consulter la version enregistrée</button><p class="event-help">Cette lecture ne remplace pas votre brouillon.</p></div>` : ''}
      ${entry.server ? `<section class="event-server"><h2>Version enregistrée · révision ${entry.server.revision}</h2>${planSummary(entry.server, cityName(entry.server.cityId))}<button class="button outline" data-event-action="adopt" ${entry.busy ? 'disabled' : ''}>Repartir de cette version</button><p class="event-help">Votre brouillon actuel restera consultable ci-dessous, sans renvoi automatique.</p></section>` : ''}
      ${entry.backups?.map((copy, index) => `<details class="event-backup"><summary>Copie du brouillon ${index + 1} · non enregistrée</summary>${planSummary(copy, cityName(copy.cityId))}</details>`).join('') || ''}
      ${entry.saved && !entry.gone ? `<details class="event-delete"><summary>Supprimer cet événement</summary><p>Retire l’événement privé et ses besoins. Aucun participant ni annonce du fil n’est concerné.</p><button class="button danger" data-event-action="delete" ${entry.busy || entry.conflict || pending || publicationPending ? 'disabled' : ''}>Supprimer définitivement</button></details>` : ''}
      ${!entry.saved && !pending && !entry.conflict ? '<button class="text-button" data-event-action="discard">Effacer ce brouillon de la page</button>' : ''}`;
    syncOverrideFields();
    // All data fields are 16px native controls; numeric bounds follow quantities.
  }
  function syncOverrideFields() {
    panel.querySelectorAll('[data-event-field*=".overrideMode."]').forEach(select => {
      const path = select.dataset.eventField.replace('.overrideMode.', '.overrides.');
      const input = panel.querySelector(`[data-event-field="${path}"]`);
      input.closest('label').hidden = select.value !== 'custom'; input.disabled = select.value !== 'custom' || client.readonly() || Boolean(client.current?.busy);
    });
  }
  panel.addEventListener('input', event => {
    const control = event.target, path = control.dataset.eventField; if (!path || !client.current) return;
    const parts = path.split('.'); if (parts.includes('overrideMode')) return;
    client.edit(draft => { let target = draft; for (const part of parts.slice(0, -1)) target = target[part]; target[parts.at(-1)] = control.type === 'number' ? (control.value === '' ? null : Number(control.value)) : control.value; });
    $('#event-status').textContent = client.current.intent ? 'Retouches conservées. Vérifiez la tentative initiale avant de les envoyer.' : 'Modifications non enregistrées.';
    if (parts.at(-1) === 'quantity') panel.querySelector(`[data-event-field="needs.${parts[1]}.confirmed"]`).max = control.value;
  });
  panel.addEventListener('change', event => {
    const path = event.target.dataset.eventField; if (!path?.includes('.overrideMode.')) return;
    const [, index, , key] = path.split('.'), input = panel.querySelector(`[data-event-field="needs.${index}.overrides.${key}"]`);
    client.edit(draft => { draft.needs[index].overrides[key] = event.target.value === 'inherit' ? null : event.target.value === 'none' ? '' : input.value; });
    syncOverrideFields(); if (event.target.value === 'custom') input.focus();
    $('#event-status').textContent = 'Modifications non enregistrées.';
  });
  panel.addEventListener('invalid', event => {
    let details = event.target.closest('details');
    while (details) { details.open = true; details = details.parentElement?.closest('details'); }
  }, true);
  panel.addEventListener('submit', async event => {
    if (event.target.id !== 'event-plan-form') return;
    event.preventDefault(); const entry = client.current, epoch = client.epoch;
    if (publicationUI.pending(entry?.id)) { entry.error = issue('event_publication_pending'); client.changed(); return; }
    if (requireUGC(() => panel.querySelector('#event-save')?.focus())) {
      await client.save();
      if (visible && epoch === client.epoch && client.current === entry) panel.querySelector('#event-status')?.focus();
    }
  });
  panel.addEventListener('click', async event => {
    const button = event.target.closest('[data-event-action]'); if (!button || button.disabled) return;
    const action = button.dataset.eventAction, entry = client.current;
    if (action === 'login') { await onSessionError(); requireAccount(show); return; }
    if (action === 'city-label-retry') { const epoch = client.epoch; return bindEventCityLabels(panel, cities, () => visible && epoch === client.epoch && Boolean(getSession().user), true); }
    if (action === 'refresh') return client.list();
    if (action === 'roles') return loadRoles();
    if (action === 'back') { cityTicket++; client.back(); return; }
    if (action === 'open') { cityTicket++; await client.open(button.dataset.id); void loadRoles(); panel.querySelector('#event-title')?.focus(); return; }
    if (action === 'new') { try { client.create(getCity()); void loadRoles(); panel.querySelector('[data-event-field="title"]')?.focus(); } catch (error) { client.listError = error; render(); } return; }
    if (!entry || entry.busy) return;
    if (action === 'publish') return publicationUI.show(entry, button.dataset.id);
    if (['delete', 'adopt', 'retry'].includes(action) && publicationUI.pending(entry.id)) { entry.error = issue('event_publication_pending'); client.changed(); return; }
    if (action === 'add-need') { client.addNeed(); panel.querySelector('.event-need:last-of-type select')?.focus(); }
    if (action === 'remove-need' && confirm('Retirer ce besoin du brouillon ?')) client.removeNeed(button.dataset.id);
    if (action === 'retry') { if (entry.intent?.method === 'DELETE') void client.remove(); else if (requireUGC(() => panel.querySelector('[data-event-action="retry"]')?.focus())) void client.save(); }
    if (action === 'inspect') await client.inspect();
    if (action === 'adopt' && confirm('Repartir de la version enregistrée ? Le brouillon actuel restera consultable dans cette page, sans être renvoyé.')) client.adoptServer();
    if (action === 'delete' && confirm('Supprimer définitivement cet événement privé et ses besoins ?')) await client.remove();
    if (action === 'discard' && confirm('Effacer ce brouillon non envoyé de cette page ?')) { client.entries.delete(entry.id); client.back(); }
    if (action === 'city-search') {
      const query = panel.querySelector('#event-city-query').value.trim(); if (query.length < 2) { panel.querySelector('#event-city-status').textContent = 'Saisissez au moins deux caractères.'; return; }
      const ticket = ++cityTicket, epoch = client.epoch; button.disabled = true;
      panel.querySelector('#event-city-status').textContent = 'Recherche…'; panel.querySelector('#event-city-results').replaceChildren();
      try {
        const result = await api(`/api/locations?q=${encodeURIComponent(query)}`);
        if (ticket !== cityTicket || epoch !== client.epoch || client.current !== entry || !visible) return;
        cityResults = result.locations; panel.querySelector('#event-city-status').textContent = cityResults.length ? 'Choisissez une ville et son fuseau.' : 'Aucune ville trouvée.';
        panel.querySelector('#event-city-results').innerHTML = cityResults.map((city, index) => `<button type="button" class="location-result" data-event-action="city-pick" data-index="${index}">${esc(city.label || `${city.name} · ${city.country}`)} · ${esc(city.timezone)}</button>`).join('');
      } catch (error) { if (ticket === cityTicket && epoch === client.epoch && client.current === entry) panel.querySelector('#event-city-status').textContent = errorText(error); }
      finally { if (ticket === cityTicket && epoch === client.epoch) button.disabled = false; }
    }
    if (action === 'city-pick') {
      const city = cityResults[Number(button.dataset.index)]; if (!city) return;
      if (client.edit(draft => { draft.cityId = city.id; draft.timezone = city.timezone; })) { entry.cityLabel = city.label || `${city.name} · ${city.country}`; cityTicket++; render(); panel.querySelector('[data-event-field="venue"]')?.focus(); }
    }
  });
  function show() {
    if (!requireAccount(show)) return;
    selectView(true); render(); void loadRoles(); if (!client.current) void client.list(); panel.querySelector('#event-title')?.focus();
  }
  return {
    client, show,
    hide() { cityTicket++; publicationUI.hide(); selectView(false); },
    changed() {
      const session = getSession(), nextOwner = session.user?.id ?? null;
      if (owner !== nextOwner) { owner = nextOwner; cityTicket++; rolesBusy = false; client.reset(); publicationUI.reset(); }
      $('#events-nav').hidden = session.mode !== 'production' || !session.features?.eventPlans;
      render();
    },
    hasDraft() { return publicationUI.hasDraft() || [...client.entries.values()].some(entry => client.dirty(entry) || entry.intent || entry.backup); },
  };
}
