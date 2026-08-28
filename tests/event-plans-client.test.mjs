import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { EventPlansClient, EventCityLabels, bindEventCityLabels, eventPlanError } from '../public/event-plans.js';
import { openDatabase } from '../database.mjs';
import { createProductionServer } from '../production-server.mjs';
import { RULES } from '../rules.mjs';
import { prepareEventPost } from '../public/event-post-drafts.js';
import { ROLES, validatePost } from '../domain.mjs';
import vm from 'node:vm';
import { EventPostPreviewState, renderEventPostPreview } from '../public/event-post-preview.js';
import { createEventPublishingUI } from '../public/event-publishing.js';

test('public preview retains its original intent after a refused uncertain retry', async () => {
  for (const refusal of [{status:403,code:'rules_version_changed'},{definitive:true,code:'login_required'}]) {
    const plan=base(), sent=[]; plan.needs[0].quantity=3; let keys=0, derives=0;
    const state=new EventPostPreviewState({role:'driver',cityLabel:'Paris',remaining:3,
      derive:options=>{derives++;return prepareEventPost(plan,plan.needs[0].id,opts(options));},
      makeKey:()=>`intent-${++keys}`,
      send:async args=>{sent.push(structuredClone(args));args.draft.note='mutated transport';args.source.revision=99;
        if(sent.length===1)throw problem('request_timeout');
        if(sent.length===2)throw refusal;
        return {post:{id:'confirmed-original'}};},
    });
    state.edit({places:2});
    const original=state.snapshot().result.draft;
    assert.equal(await state.publish(),false);
    const originalDerives=derives;
    assert.equal(await state.publish(),false);
    assert.equal(state.snapshot().phase,'uncertain');
    assert.equal(state.edit({places:1}),false);
    assert.equal(await state.publish(),true);
    assert.equal(state.snapshot().errorCode,null);
    assert.equal(await state.publish(),false,'confirmed success cannot be sent again');
    assert.equal(keys,1);assert.equal(derives,originalDerives);
    assert.deepEqual(sent.map(a=>a.retry),[false,true,true]);
    for(const args of sent){assert.equal(args.key,'intent-1');assert.deepEqual(args.draft,original);assert.equal(args.source.revision,plan.revision);}
    assert.deepEqual(state.snapshot().result.draft,original);
  }
});

test('public preview shows initial actionable errors, safe unknown errors and actual sending status', async () => {
  const plan=base();plan.needs[0].quantity=10;plan.needs[0].confirmed=0;
  const pause=deferred();
  const state=new EventPostPreviewState({role:'driver',cityLabel:'Paris',remaining:10,derive:o=>prepareEventPost(plan,plan.needs[0].id,opts(o)),send:()=>pause.promise,makeKey:()=> 'one'});
  const initial=renderEventPostPreview(state.snapshot());
  assert.match(initial,/Indiquez le nombre de places/);
  assert.match(initial,/<button type="submit"[^>]*disabled/);
  state.edit({places:3});
  const valid=state.snapshot();
  for(const errorCode of ['untrusted_server_detail','constructor','__proto__']) {
    const html=renderEventPostPreview({...valid,errorCode});
    assert.match(html,/role="alert"/);assert.match(html,/Votre saisie est conservée/);assert.ok(!html.includes(errorCode));
  }
  const publishing=state.publish();
  assert.equal(state.edit({places:2}),false);
  assert.match(renderEventPostPreview(state.snapshot()),/<p role="status">Publication en cours/);
  pause.resolve({post:{id:'ok'}});await publishing;
  const success=renderEventPostPreview(state.snapshot());
  assert.match(success,/<p role="status">Annonce publiée/);
  assert.equal((success.match(/role="status"/g)||[]).length,1);
  assert.equal(state.edit({places:2}),false);
});

test('external derive results and malformed results cannot change a public preview after derivation', () => {
  const derived=makeDerive()({places:2});
  const state=new EventPostPreviewState(baseConfig({derive:()=>derived}));
  derived.draft.note='changed outside';derived.allowedDurations.length=0;
  assert.equal(state.snapshot().result.draft.note,'');
  assert.deepEqual(state.snapshot().result.allowedDurations,[30,60,120]);
  for(const malformed of [null,undefined,{},'not a draft']) {
    const invalid=new EventPostPreviewState(baseConfig({derive:()=>malformed}));
    assert.deepEqual(invalid.snapshot().result,{ok:false,code:'event_draft_invalid'});
  }
});

const START = Date.UTC(2026, 7, 28), city = { id: '2988507', name: 'Paris', timezone: 'Europe/Paris' };
const problem = (code, status) => Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
const view = (entry, revision = 1, changes = {}) => ({ id: entry.id, ...structuredClone(entry.draft), revision,
  visibility: 'private', confirmedMode: 'manual', startsAt: START + 86400000, endsAt: START + 108000000,
  totals: { quantity: 3, confirmed: 1, remaining: 2 }, ...changes });
function fill(client) {
  client.edit(draft => Object.assign(draft, { title: 'Événement synthétique', venue: 'Salle de réception', startLocal: '2026-08-29T17:00', endLocal: '2026-08-29T23:00',
    common: { attire: 'Tenue noire', equipment: 'Chaussures adaptées', arrival: 'Entrée principale' }, needs: [{ ...draft.needs[0], role: 'Serveur', quantity: 3, confirmed: 1,
      languages: { fr: 'required', en: 'preferred' }, skills: 'Service au plateau', overrides: { attire: null, equipment: '', arrival: 'Entrée livraison' } }] }));
}
function fixture() {
  const calls = [], errors = []; let clock = START;
  const client = new EventPlansClient({ now: () => clock, onError: error => errors.push(error), api: (path, options = {}) => new Promise((resolve, reject) => calls.push({ path, options, resolve, reject })) });
  client.create(city); fill(client);
  return { client, calls, errors, advance: amount => { clock += amount; } };
}

async function publishingFixture({ cityReady = Promise.resolve(), publishPost = async () => ({ post: { id: 'public-test' } }) } = {}) {
  const f = fixture(), saved = f.client.save();
  f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  const contentListeners = new Map(), dialogListeners = new Map();
  const document = { activeElement: null, querySelector: () => null };
  const content = {
    ownerDocument: document, innerHTML: '', contains: () => false,
    addEventListener: (name, handler) => contentListeners.set(name, handler),
    querySelector: () => null, querySelectorAll: () => [],
    replaceChildren() { this.innerHTML = ''; },
  };
  const dialog = {
    open: false,
    addEventListener: (name, handler) => dialogListeners.set(name, handler),
    close() { this.open = false; dialogListeners.get('close')?.(); },
  };
  let openings = 0;
  const ui = createEventPublishingUI({
    $: id => id === '#event-post-preview' ? dialog : content,
    client: f.client, cities: { ensure: () => cityReady, label: () => 'Paris' },
    getSession: () => ({ user: { id: 'synthetic-account' } }), getRoles: () => ROLES,
    openDialog: () => { openings++; dialog.open = true; },
    requireUGC: () => true, onRulesError: () => {}, onLogin: () => {},
    publishPost, onViewPost: () => {}, onChange: () => {},
  });
  return {
    ...f, ui, content, dialog, openings: () => openings,
    submit: () => contentListeners.get('submit')({ target: { id: 'event-post-preview-form' }, preventDefault() {} }),
    retry: () => contentListeners.get('click')({ target: { closest: () => ({ dataset: { previewAction: 'retry' }, disabled: false }) } }),
    newPreview: () => contentListeners.get('click')({ target: { closest: () => ({ dataset: { previewAction: 'new' }, disabled: false }) } }),
  };
}

test('publication navigation hide cancels a late preview opening without changing the selected plan', async () => {
  const cityReady = deferred(), f = await publishingFixture({ cityReady: cityReady.promise });
  const entry = f.client.current, pending = f.ui.show(entry, entry.saved.needs[0].id);
  f.ui.hide(); cityReady.resolve(); await pending;
  assert.equal(f.openings(), 0);
  assert.equal(f.dialog.open, false);
  assert.equal(f.client.current, entry);
  await f.ui.show(entry, entry.saved.needs[0].id);
  assert.equal(f.openings(), 1, 'an explicit return can open a new preview');
});

test('publication navigation hide and reopen preserve an uncertain attempt until explicit retry', async () => {
  const sent = [], f = await publishingFixture({ publishPost: async args => {
    sent.push(structuredClone(args));
    if (sent.length === 1) throw problem('request_timeout');
    return { post: { id: 'public-confirmed' } };
  } });
  const entry = f.client.current, needId = entry.saved.needs[0].id;
  await f.ui.show(entry, needId); f.submit();
  assert.equal(f.calls.length, 2, 'initial publication verifies the saved plan');
  f.calls[1].resolve({ plan: structuredClone(entry.saved) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(f.ui.pending(entry.id), true);
  f.ui.hide();
  assert.equal(f.dialog.open, false);
  assert.equal(f.ui.pending(entry.id), true);
  await f.ui.show(entry, needId);
  assert.match(f.content.innerHTML, /Vérifier la publication/);
  assert.equal(sent.length, 1, 'reopening never submits the retained attempt');
  f.retry(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0], 'explicit retry retains both public payload and key');
  assert.equal(f.calls.length, 2, 'retry does not derive or verify a replacement request');
  assert.equal(f.ui.pending(entry.id), false);
  assert.match(f.content.innerHTML, /Annonce publiée/);
});

test('expired publication is terminal but an explicit new preview uses the current event', async t => {
  for (const finished of [false, true]) await t.test(finished ? 'finished event' : 'future event', async () => {
    const sent = [], f = await publishingFixture({ publishPost: async args => {
      sent.push(structuredClone(args));
      if (sent.length === 1) throw problem('request_timeout');
      if (sent.length === 2) throw problem('post_expired', 410);
      return { post: { id: 'new-publication' } };
    } });
    const entry = f.client.current, needId = entry.saved.needs[0].id;
    const before = structuredClone(entry.saved);
    await f.ui.show(entry, needId); f.submit();
    f.calls[1].resolve({ plan: structuredClone(entry.saved) });
    await new Promise(resolve => setImmediate(resolve));
    f.advance(finished ? 108000000 : 61 * 60_000);
    f.retry(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2); assert.deepEqual(sent[1], sent[0]);
    assert.match(f.content.innerHTML, /Cette tentative est terminée/);
    assert.doesNotMatch(f.content.innerHTML, /data-preview-action="retry"|type="submit"/);
    f.retry(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(sent.length, 2, 'the expired attempt cannot be sent again');
    assert.match(f.content.innerHTML, /data-preview-action="new">Préparer une autre annonce/);
    f.newPreview();
    assert.equal(sent.length, 2, 'new preview does not publish automatically');
    assert.equal(f.calls.length, 2, 'new preview does not perform a publication preflight');
    if (finished) {
      assert.match(f.content.innerHTML, /L’événement est terminé/);
      assert.match(f.content.innerHTML, /<button type="submit"[^>]*disabled/);
      f.submit(); await new Promise(resolve => setImmediate(resolve));
      assert.equal(sent.length, 2); assert.equal(f.calls.length, 2);
    } else {
      assert.match(f.content.innerHTML, /id="event-post-preview-form"/);
      f.submit(); assert.equal(f.calls.length, 3);
      f.calls[2].resolve({ plan: structuredClone(entry.saved) });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(sent.length, 3); assert.notEqual(sent[2].key, sent[0].key);
      assert.equal(sent[2].draft.notAfter, entry.saved.endsAt);
      assert.match(f.content.innerHTML, /Annonce publiée/);
    }
    assert.deepEqual(entry.saved, before, 'manual confirmations remain unchanged');
  });
});

test('create retry preserves UUID and exact original payload despite subsequent edits', async () => {
  const f = fixture(), original = view(f.client.current); const first = f.client.save();
  f.calls[0].reject(problem('request_timeout')); await first;
  assert.ok(f.client.current.intent); assert.equal(f.client.current.saved, null);
  f.client.edit(draft => { draft.title = 'Retouche non envoyée'; draft.needs[0].quantity = 5; });
  const retry = f.client.save(); assert.deepEqual(f.calls[1].options.body, f.calls[0].options.body);
  f.calls[1].resolve({ plan: original, replayed: true }); await retry;
  assert.equal(f.client.current.draft.title, 'Retouche non envoyée'); assert.equal(f.client.current.saved.title, original.title);
  assert.equal(f.client.current.saved.revision, 1); assert.equal(f.calls.length, 2);
  const next = f.client.save(); assert.equal(f.calls[2].options.method, 'PATCH'); assert.equal(f.calls[2].options.body.expectedRevision, 1);
  f.calls[2].resolve({ plan: view(f.client.current, 2) }); await next; assert.equal(f.client.dirty(), false);
});

test('uncertain create replay of a newer revision never silently rebases an older draft', async () => {
  const f = fixture(), initial = view(f.client.current), first = f.client.save();
  f.calls[0].reject(problem('request_timeout')); await first; const retry = f.client.save();
  f.calls[1].resolve({ plan: { ...initial, title: 'Version d’un autre onglet', revision: 3 }, replayed: true }); await retry;
  assert.equal(f.client.current.conflict, true); assert.equal(f.client.current.draft.title, initial.title);
  await f.client.save(); assert.equal(f.calls.length, 2);
});

test('revision conflict and explicit inspection retain draft and original revision until accepted', async () => {
  const f = fixture(); let saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  f.client.edit(draft => { draft.venue = 'Brouillon local'; });
  saved = f.client.save(); f.calls[1].reject(problem('event_plan_changed', 409)); await saved;
  assert.equal(f.client.current.conflict, true); assert.equal(f.client.current.draft.venue, 'Brouillon local');
  await f.client.save(); assert.equal(f.calls.length, 2);
  const inspect = f.client.inspect(); f.calls[2].resolve({ plan: view(f.client.current, 4, { venue: 'Version enregistrée ailleurs' }) }); await inspect;
  assert.equal(f.client.current.saved.revision, 1); assert.equal(f.client.current.draft.venue, 'Brouillon local'); assert.equal(f.calls.length, 3);
  f.client.adoptServer(); assert.equal(f.client.current.saved.revision, 4); assert.equal(f.client.current.draft.venue, 'Version enregistrée ailleurs');
  assert.equal(f.client.current.backup.venue, 'Brouillon local'); assert.equal(f.calls.length, 3);
});

test('uncertain PATCH never changes revision or resends a later edited draft', async () => {
  const f = fixture(); let saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  f.client.edit(draft => { draft.needs[0].confirmed = 2; }); saved = f.client.save(); f.calls[1].reject(problem('request_timeout')); await saved;
  f.client.edit(draft => { draft.needs[0].confirmed = 3; }); const retry = f.client.save();
  assert.deepEqual(f.calls[2].options, f.calls[1].options); f.calls[2].reject(problem('event_plan_changed', 409)); await retry;
  assert.equal(f.client.current.saved.revision, 1); assert.equal(f.client.current.draft.needs[0].confirmed, 3); assert.ok(f.client.current.conflict);
});

test('deleted and foreign plans are never recreated automatically', async () => {
  for (const [status, code] of [[410, 'event_plan_deleted'], [404, 'event_plan_not_found']]) {
    const f = fixture(), saved = f.client.save(); f.calls[0].reject(problem(code, status)); await saved;
    await f.client.save(); assert.equal(f.calls.length, 1); assert.ok(f.client.current.gone); assert.equal(f.client.current.draft.title, 'Événement synthétique');
  }
});

test('rules and session errors retain current draft without automatic mutation', async () => {
  for (const [status, code] of [[403, 'rules_acceptance_required'], [403, 'rules_version_changed'], [401, 'login_required']]) {
    const f = fixture(), saved = f.client.save(); f.calls[0].reject(problem(code, status)); await saved;
    assert.equal(f.calls.length, 1); assert.equal(f.client.current.draft.title, 'Événement synthétique'); assert.equal(f.client.current.intent, null); assert.equal(f.errors[0].code, code);
  }
});

test('reset clears private drafts and ignores late results from the previous account', async () => {
  const f = fixture(), prior = view(f.client.current), saved = f.client.save(); f.client.reset();
  f.client.create(city); const next = f.client.current.id; f.calls[0].resolve({ plan: prior }); await saved;
  assert.equal(f.client.current.id, next); assert.equal(f.client.current.saved, null); assert.equal(f.client.plans.length, 0); assert.equal(f.client.entries.size, 1);
});

test('native form model enforces 12 needs and 20 retained plans without losing existing content', () => {
  const f = fixture(); for (let i = 0; i < 15; i++) f.client.addNeed(); assert.equal(f.client.current.draft.needs.length, 12);
  const ids = f.client.current.draft.needs.map(need => need.id); assert.equal(new Set(ids).size, 12);
  for (const id of ids) f.client.removeNeed(id); assert.equal(f.client.current.draft.needs.length, 1);
  f.client.plans = Array.from({ length: 20 }, () => ({})); assert.throws(() => f.client.create(city), { code: 'event_plan_capacity_reached' });
});

test('started plans retain read/delete access but refuse counters or date edits', async () => {
  const f = fixture(); const saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  f.advance(86400001); assert.ok(f.client.readonly()); assert.equal(f.client.edit(draft => { draft.needs[0].confirmed = 3; }), false);
  await f.client.save(); assert.equal(f.client.current.error.code, 'event_started'); assert.equal(f.calls.length, 1);
  const removal = f.client.remove(); assert.equal(f.calls[1].options.method, 'DELETE'); f.calls[1].resolve({ deleted: true, id: f.client.current.id }); await removal;
  assert.equal(f.client.current, undefined); assert.equal(f.client.plans.length, 0);
});

test('ambiguous deletion reuses its revision and does not report success prematurely', async () => {
  const f = fixture(); const saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  const id = f.client.current.id, deletion = f.client.remove(); f.calls[1].reject(problem('request_timeout')); await deletion;
  assert.ok(f.client.entries.has(id)); assert.equal(f.client.current.intent.method, 'DELETE');
  const retry = f.client.remove(); assert.deepEqual(f.calls[2].options, f.calls[1].options); f.calls[2].resolve({ deleted: true, id }); await retry;
  assert.equal(f.client.entries.has(id), false);
});

test('list and back preserve each unsaved draft; a late open cannot replace a later selection', async () => {
  const f = fixture(), id = f.client.current.id; f.client.back(); const listed = f.client.list(); f.calls[0].resolve({ plans: [] }); await listed;
  await f.client.open(id); assert.equal(f.client.current.draft.title, 'Événement synthétique');
  const remoteId = randomUUID(), opened = f.client.open(remoteId); f.client.back();
  f.calls[1].resolve({ plan: view({ id: remoteId, draft: f.client.entries.get(id).draft }) }); await opened; assert.equal(f.client.currentId, null);
  const reopened = f.client.open(remoteId);
  await f.client.open(id);
  assert.equal(f.client.currentId, id);
  assert.equal(f.client.listBusy, false);
  f.calls[2].resolve({ plan: view({ id: remoteId, draft: f.client.entries.get(id).draft }) }); await reopened;
  assert.equal(f.client.currentId, id);
  assert.equal(f.client.current.draft.title, 'Événement synthétique');
});

test('time errors distinguish unsupported DST hours and do not invent a timezone choice', () => {
  assert.match(eventPlanError(problem('event_time_start_of_event', 400)), /action/);
  assert.match(eventPlanError(problem('event_time_ambiguous', 400)), /non ambigu/);
  assert.match(eventPlanError(problem('event_time_nonexistent', 400)), /autre horaire/);
  assert.match(eventPlanError(problem('event_plan_personal_data', 400)), /coordonnées/);
});

test('city catalogue cache deduplicates reads and retains only public labels', async () => {
  const calls = [], cities = new EventCityLabels(path => new Promise(resolve => calls.push({ path, resolve })));
  assert.equal(cities.label('2988507'), 'Chargement du nom de ville…');
  const first = cities.ensure('2988507'), duplicate = cities.ensure('2988507');
  assert.equal(first, duplicate); assert.equal(calls.length, 1); assert.equal(calls[0].path, '/api/locations/2988507');
  calls[0].resolve({ location: { id: '2988507', name: 'Paris', country: 'FR', label: 'Paris · FR', ignoredExtra: 'not retained' } });
  await first; assert.equal(cities.label('2988507'), 'Paris · FR');
  await cities.ensure('2988507'); assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(cities.entries.get('2988507')).sort(), ['label', 'promise', 'state']);
});

test('late city labels cannot change a replaced city node or a previous account view', async () => {
  const calls = [], cities = new EventCityLabels(path => new Promise(resolve => calls.push({ path, resolve })));
  const oldNode = { dataset: { eventCity: '2988507' }, textContent: '' }, nextNode = { dataset: { eventCity: '2996944' }, textContent: '' };
  let currentNodes = [oldNode], epoch = 1;
  const panel = { querySelectorAll: () => currentNodes, contains: node => currentNodes.includes(node), querySelector: () => null };
  const oldRead = bindEventCityLabels(panel, cities, () => epoch === 1);
  currentNodes = [nextNode]; const nextRead = bindEventCityLabels(panel, cities, () => epoch === 1);
  calls[1].resolve({ location: { id: '2996944', name: 'Lyon', country: 'FR' } }); await nextRead;
  calls[0].resolve({ location: { id: '2988507', name: 'Paris', country: 'FR' } }); await oldRead;
  assert.equal(nextNode.textContent, 'Lyon · FR'); assert.equal(oldNode.textContent, 'Chargement du nom de ville…');
  const otherNode = { dataset: { eventCity: '6455259' }, textContent: '' }; currentNodes = [otherNode];
  const otherRead = bindEventCityLabels(panel, cities, () => epoch === 1); epoch = 2;
  calls[2].resolve({ location: { id: '6455259', name: 'Montpellier', country: 'FR' } }); await otherRead;
  assert.equal(otherNode.textContent, 'Chargement du nom de ville…');
});

test('city lookup failure keeps an explicit label and allows an explicit bounded retry', async () => {
  let attempts = 0;
  const cities = new EventCityLabels(async () => { if (++attempts === 1) throw problem('request_timeout'); return { location: { id: '2988507', name: 'Paris', country: 'FR' } }; });
  const node = { dataset: { eventCity: '2988507' }, textContent: '' }, retry = { hidden: true };
  const panel = { querySelectorAll: () => [node], contains: candidate => candidate === node, querySelector: () => retry };
  await bindEventCityLabels(panel, cities, () => true);
  assert.equal(node.textContent, 'Nom de ville indisponible'); assert.equal(retry.hidden, false);
  await bindEventCityLabels(panel, cities, () => true); assert.equal(attempts, 1);
  await bindEventCityLabels(panel, cities, () => true, true);
  assert.equal(attempts, 2); assert.equal(node.textContent, 'Paris · FR'); assert.equal(retry.hidden, true);
  const invalid = new EventCityLabels(async () => ({ location: { id: '2996944', name: 'Lyon' } }));
  await invalid.ensure('2988507'); assert.equal(invalid.label('2988507'), 'Nom de ville indisponible');
});

test('a late list from before a save cannot erase the newly saved list entry', async () => {
  const f = fixture(), reading = f.client.list(), saved = f.client.save();
  f.calls[1].resolve({ plan: view(f.client.current) }); await saved;
  f.calls[0].resolve({ plans: [] }); await reading;
  assert.equal(f.client.plans.length, 1);
  assert.equal(f.client.listBusy, false);
});

test('client works against real authenticated HTTP persistence, manual needs, owner isolation and deletion', async t => {
  const db = openDatabase(':memory:'), origin = 'https://event-client.test';
  const app = createProductionServer({ db, publicOrigin: origin, clock: () => START,
    authOptions: { testKdf: async (password, salt) => createHash('sha512').update(password).update(salt).digest() } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); db.close(); });
  let cookie;
  const api = (path, { method = 'GET', body, idempotencyKey } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const request = http.request({ hostname: '127.0.0.1', port: app.server.address().port, path, method,
      headers: { Host: new URL(origin).host, ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}), ...(method !== 'GET' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; }); response.on('end', () => {
        if (response.headers['set-cookie']) cookie = response.headers['set-cookie'][0].split(';')[0];
        try { const result = JSON.parse(text); if (response.statusCode >= 400) reject(problem(result.error, response.statusCode)); else resolve(result); } catch (error) { reject(error); }
      });
    }); request.on('error', reject); request.end(data);
  });
  await api('/api/auth/register', { method: 'POST', body: { username: 'event_client_fixture', password: 'synthetic event client password', acceptedRules: true, rulesVersion: RULES.version } });
  const ownerCookie = cookie, client = new EventPlansClient({ api, now: () => START }); await client.list(); client.create(city); fill(client);
  client.addNeed(); client.edit(draft => { draft.needs[1].role = 'Barman'; draft.needs[1].quantity = 2; });
  await client.save(); assert.equal(client.current.error, null); const id = client.current.id;
  assert.equal(client.current.saved.visibility, 'private'); assert.equal(client.current.saved.totals.quantity, 5); assert.equal(client.current.saved.totals.confirmed, 1);
  assert.equal(client.current.saved.needs[0].overrides.equipment, ''); assert.equal(client.current.saved.needs[0].overrides.attire, null);
  client.edit(draft => { draft.needs[1].confirmed = 1; }); await client.save(); assert.equal(client.current.saved.revision, 2);
  const restored = new EventPlansClient({ api, now: () => START }); await restored.list(); await restored.open(id);
  assert.equal(restored.current.saved.totals.confirmed, 2); assert.equal(restored.current.saved.timezone, 'Europe/Paris');
  const cities = new EventCityLabels(api); await cities.ensure(restored.current.draft.cityId);
  assert.match(cities.label(restored.current.draft.cityId), /Paris/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_posts').get().n, 0);
  const prepared = restored.preparePost(restored.current.saved.needs[0].id, { roles: ROLES, extraNote: 'Service au plateau.' });
  assert.equal(await restored.verifyPostSource(prepared.source, prepared.draft, ROLES), true);
  const postKey = randomUUID(), published = await api('/api/posts', { method: 'POST', body: prepared.draft, idempotencyKey: postKey });
  const retried = await api('/api/posts', { method: 'POST', body: prepared.draft, idempotencyKey: postKey });
  assert.equal(retried.post.id, published.post.id); assert.equal(db.prepare('SELECT COUNT(*) n FROM app_posts').get().n, 1);
  const publicText = JSON.stringify(published.post);
  for (const value of [restored.current.saved.title, restored.current.saved.venue, restored.current.saved.common.attire, restored.current.saved.common.arrival, prepared.source.planId, prepared.source.needId]) assert.equal(publicText.includes(value), false, value);
  assert.equal((await api(`/api/event-plans/${id}`)).plan.totals.confirmed, 2);
  cookie = undefined; await api('/api/auth/register', { method: 'POST', body: { username: 'event_other_fixture', password: 'synthetic other event password', acceptedRules: true, rulesVersion: RULES.version } });
  await assert.rejects(api(`/api/event-plans/${id}`), { status: 404 }); assert.deepEqual((await api('/api/event-plans')).plans, []);
  cookie = ownerCookie; await restored.remove(); assert.equal(restored.current, undefined); assert.deepEqual((await api('/api/event-plans')).plans, []);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM app_posts').get().n, 1, 'independent announcement is not removed with a private plan');
});

test('source keeps event data out of browser storage and preserves the Notice footer', async () => {
  const js = await readFile(new URL('../public/event-plans.js', import.meta.url), 'utf8'), html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /localStorage|sessionStorage|document\.cookie|\/api\/posts/);
  assert.match(html, /id="events-nav"/); assert.match(html, /id="event-plans-panel"/);
  assert.match(html, /href="https:\/\/thenotice\.io\/" target="_blank" rel="noopener"[^>]*>Powered by TheNotice\.io<\/a>/);
  assert.match(js, /type="datetime-local"|type: 'datetime-local'/); assert.match(js, /Confirme|Confirmées manuellement/);
});

// Provider-authored synthetic contract tests; source hashes in DELEGATED-BUILD.md.
const base = () => ({
  id: 'event-1', revision: 2, cityId: 'paris', timezone: 'Europe/Paris',
  startLocal: '2026-08-29T09:00', endLocal: '2026-08-30T11:30',
  startsAt: Date.UTC(2026, 7, 29, 7), endsAt: Date.UTC(2026, 7, 30, 9, 30),
  title: 'private', venue: { address: 'secret' },
  needs: [{ id: 'need-1', role: 'driver', quantity: 2, confirmed: 1,
    languages: { fr: 'preferred', en: 'required' }, pay: 99 }]
});
const opts = (extra = {}) => ({ now: Date.UTC(2026, 7, 28), roles: ['driver'], ...extra });

 test('derives an immutable public draft and excludes private fields', () => {
  const plan = base(); const before = structuredClone(plan);
  const result = prepareEventPost(plan, 'need-1', opts());
  assert.equal(result.ok, true);
  assert.deepEqual(result.draft, {
    kind: 'need', role: 'driver', cityId: 'paris', english: true, vehicle: false,
    durationMinutes: 60, notAfter: plan.endsAt, places: 1,
    note: 'Mission : 29/08/2026 09:00 → 30/08/2026 11:30 (Europe/Paris). Français souhaité. Anglais requis.'
  });
  assert.deepEqual(result.source, { planId: 'event-1', revision: 2, needId: 'need-1' });
  assert.equal(result.remaining, 1); assert.deepEqual(result.allowedDurations, [30, 60, 120, 240]);
  assert.deepEqual(plan, before); assert.deepEqual(Object.keys(result.draft).sort(), ['cityId','durationMinutes','english','kind','notAfter','note','places','role','vehicle']);
 });

test('rejects full, invalid, duplicate, and unknown needs', () => {
  const full = base(); full.needs[0].confirmed = 2;
  assert.deepEqual(prepareEventPost(full, 'need-1', opts()), { ok: false, code: 'event_need_full' });
  const bad = base(); bad.needs[0].quantity = 0;
  assert.deepEqual(prepareEventPost(bad, 'need-1', opts()), { ok: false, code: 'event_draft_invalid' });
  const dup = base(); dup.needs.push({ ...dup.needs[0] });
  assert.deepEqual(prepareEventPost(dup, 'need-1', opts()), { ok: false, code: 'event_draft_invalid' });
  assert.deepEqual(prepareEventPost(base(), 'missing', opts()), { ok: false, code: 'event_draft_invalid' });
});

test('requires explicit places above eight and never splits', () => {
  const plan = base(); plan.needs[0].quantity = 9; plan.needs[0].confirmed = 0;
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts()), { ok: false, code: 'event_places_required' });
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ places: 8 })).ok, true);
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ places: 9 })), { ok: false, code: 'event_places_invalid' });
});

test('handles language states, roles, durations, and expiry', () => {
  const plan = base(); plan.needs[0].languages = { fr: 'none', en: 'preferred' };
  const r = prepareEventPost(plan, 'need-1', opts({ durationMinutes: 30 }));
  assert.equal(r.draft.english, false); assert.match(r.draft.note, /Anglais souhaité/);
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ roles: ['other'] })), { ok: false, code: 'event_draft_invalid' });
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ durationMinutes: 120 })).ok, true);
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ durationMinutes: 60, now: plan.endsAt - 30 * 60000 })), { ok: false, code: 'event_duration_invalid' });
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ now: plan.endsAt })), { ok: false, code: 'event_finished' });
});

test('allows ongoing events but blocks short windows', () => {
  const p = base(); assert.equal(prepareEventPost(p, 'need-1', opts({ now: p.startsAt + 60000 })).ok, true);
  assert.deepEqual(prepareEventPost(p, 'need-1', opts({ now: p.endsAt - 1000 })), { ok: false, code: 'event_window_too_short' });
});

test('rejects malformed dates, timezone, epochs, options, and notes', () => {
  for (const mutate of [p => p.startLocal = '2026-02-29T09:00', p => p.timezone = 'Not/AZone', p => p.startsAt = -1, p => p.endsAt = 1]) {
    const p = base(); mutate(p); assert.deepEqual(prepareEventPost(p, 'need-1', opts()), { ok: false, code: 'event_draft_invalid' });
  }
  assert.deepEqual(prepareEventPost(base(), 'need-1', { roles: ['driver'] }), { ok: false, code: 'event_draft_invalid' });
  for (const extraNote of ['bad\u0001note', 'bad\u202Etext', 'x'.repeat(181)]) {
    assert.deepEqual(prepareEventPost(base(), 'need-1', opts({ extraNote })), { ok: false, code: extraNote.length > 180 ? 'event_note_too_long' : 'event_note_invalid' });
  }
  const p = base(); p.endLocal = '2026-08-29T11:30';
  assert.match(prepareEventPost(p, 'need-1', opts()).draft.note, /29\/08\/2026 09:00 → 29\/08\/2026 11:30/);
});

test('validates proleptic Gregorian civil dates, including low years', () => {
  const leap = base(); leap.startLocal = '0000-02-29T09:00';
  assert.equal(prepareEventPost(leap, 'need-1', opts()).ok, true);
  const nonLeap = base(); nonLeap.startLocal = '0001-02-29T09:00';
  assert.deepEqual(prepareEventPost(nonLeap, 'need-1', opts()), { ok: false, code: 'event_draft_invalid' });
  const low = base(); low.startLocal = '0099-02-28T09:00';
  assert.equal(prepareEventPost(low, 'need-1', opts()).ok, true);
});

// Independent integration checks, beyond the provider's synthetic contract.
test('event drafts match the real post validator for every current profession', () => {
  for (const role of ROLES) {
    const plan = base(); plan.cityId = city.id; plan.needs[0].role = role;
    const result = prepareEventPost(plan, 'need-1', opts({ roles: ROLES }));
    assert.equal(result.ok, true, role);
    const accepted = validatePost(result.draft);
    assert.equal(accepted.role, role); assert.equal(accepted.cityId, city.id);
    assert.equal(accepted.note, result.draft.note); assert.equal(accepted.places, 1);
    assert.equal(accepted.english, true); assert.equal(accepted.pay, null);
    assert.throws(() => validatePost({ ...result.draft, source: result.source }));
  }
});

test('draft boundaries preserve exact UTF16 text and reject controls and non-IANA offsets', () => {
  const plan = base(), prefix = prepareEventPost(plan, 'need-1', opts()).draft.note;
  const fits = 'x'.repeat(180 - prefix.length - 1);
  assert.equal(prepareEventPost(plan, 'need-1', opts({ extraNote: fits })).draft.note.length, 180);
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ extraNote: fits + 'x' })), { ok: false, code: 'event_note_too_long' });
  for (const code of [...Array.from({ length: 32 }, (_, i) => i).filter(i => ![9, 10].includes(i)), 127, 0x202a, 0x202e, 0x2066, 0x2069]) {
    assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ extraNote: `a${String.fromCharCode(code)}b` })), { ok: false, code: 'event_note_invalid' }, String(code));
  }
  assert.equal(prepareEventPost(plan, 'need-1', opts({ extraNote: ' \nbon\t service ' })).draft.note, prefix + ' bon service');
  for (const timezone of ['+01:00', '-0500', '+00']) {
    assert.deepEqual(prepareEventPost({ ...plan, timezone }, 'need-1', opts()), { ok: false, code: 'event_draft_invalid' });
  }
  const thirty = prepareEventPost(plan, 'need-1', opts({ now: plan.endsAt - 30 * 60000 }));
  assert.equal(thirty.draft.durationMinutes, 30); assert.deepEqual(thirty.allowedDurations, [30]);
  assert.deepEqual(prepareEventPost(plan, 'need-1', opts({ now: plan.endsAt - 30 * 60000 + 1 })), { ok: false, code: 'event_window_too_short' });
  for (const invalid of [null, [], false, '1', {}, Number.MAX_SAFE_INTEGER, -1, 1.5]) {
    assert.equal(prepareEventPost(plan, 'need-1', opts({ places: invalid })).ok, false);
    assert.equal(prepareEventPost(plan, 'need-1', opts({ durationMinutes: invalid })).ok, false);
  }
});

test('draft preparation is clock-free, non-mutating and handles malformed JSON-like input', async () => {
  const source = await readFile(new URL('../public/event-post-drafts.js', import.meta.url), 'utf8');
  let zoneChecks = 0;
  const context = vm.createContext({ Intl: { DateTimeFormat: function (...args) {
    zoneChecks++; const value = new Intl.DateTimeFormat(...args);
    return new Proxy(value, { get() { throw Error('Formatting is not needed for zone validation'); } });
  } }, Date: new Proxy(Date, { construct() { throw Error('Clock access'); }, get() { throw Error('Date API access'); } }) });
  vm.runInContext(source.replace('export function prepareEventPost', 'function prepareEventPost'), context);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const plan = freeze(base()), options = freeze(opts());
  assert.equal(context.prepareEventPost(plan, 'need-1', options).ok, true); assert.equal(zoneChecks, 1);
  for (const invalid of [undefined, null, [], {}, false, 0, 'event']) {
    assert.equal(prepareEventPost(invalid, 'need-1', opts()).ok, false);
    assert.equal(prepareEventPost(plan, 'need-1', invalid).ok, false);
  }
  assert.equal(prepareEventPost({ ...plan, revision: Number.MAX_SAFE_INTEGER + 1 }, 'need-1', opts()).ok, false);
  assert.equal(prepareEventPost({ ...plan, endsAt: 253402300800000 }, 'need-1', opts()).ok, false);
  const privateFields = { ...base(), owner: { hidden: true }, common: { attire: 'PRIVATE-MARKER' } };
  privateFields.needs.push({ unrelated: 'PRIVATE-MARKER' });
  assert.equal(JSON.stringify(prepareEventPost(privateFields, 'need-1', opts())).includes('PRIVATE-MARKER'), false);
});

test('event client derives only from a clean saved plan, never writes or uses a caller clock', async () => {
  const f = fixture(), needId = f.client.current.draft.needs[0].id;
  assert.deepEqual(f.client.preparePost(needId, { roles: ROLES }), { ok: false, code: 'event_draft_unavailable' });
  const saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  const original = structuredClone(f.client.current.saved);
  const result = f.client.preparePost(needId, { roles: ROLES, now: Number.MAX_SAFE_INTEGER });
  assert.equal(result.ok, true); assert.equal(result.remaining, 2); assert.equal(result.draft.places, 2);
  assert.equal(result.draft.english, false); assert.match(result.draft.note, /Anglais souhaité/);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.client.current.saved, original);
  for (const key of ['busy', 'intent', 'conflict', 'gone']) {
    f.client.current[key] = true;
    assert.deepEqual(f.client.preparePost(needId, { roles: ROLES }), { ok: false, code: 'event_draft_unavailable' });
    f.client.current[key] = null;
  }
  f.client.edit(draft => { draft.needs[0].quantity = 5; });
  assert.equal(f.client.preparePost(needId, { roles: ROLES }).ok, false);
  f.client.current.draft.needs[0].quantity = 3;
  f.advance(86400000 + 60000); assert.equal(f.client.readonly(), true);
  assert.equal(f.client.preparePost(needId, { roles: ROLES }).ok, true);
  f.advance(108000000); assert.deepEqual(f.client.preparePost(needId, { roles: ROLES }), { ok: false, code: 'event_finished' });
  f.client.reset(); assert.equal(f.client.preparePost(needId, { roles: ROLES }).ok, false); assert.equal(f.calls.length, 1);
});

test('event publication preflight reads current ownership/revision without changing manual counts', async () => {
  const f = fixture(), saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
  const prepared = f.client.preparePost(f.client.current.saved.needs[0].id, { roles: ROLES });
  const before = structuredClone(f.client.current.saved), check = f.client.verifyPostSource(prepared.source, prepared.draft, ROLES);
  assert.equal(f.calls[1].options.method, undefined); assert.equal(f.calls[1].path, `/api/event-plans/${before.id}`);
  f.calls[1].resolve({ plan: before }); assert.equal(await check, true);
  assert.deepEqual(f.client.current.saved, before); assert.equal(f.calls.length, 2);
  const stale = f.client.verifyPostSource(prepared.source, prepared.draft, ROLES);
  f.calls[2].resolve({ plan: { ...before, revision: before.revision + 1 } });
  await assert.rejects(stale, { code: 'event_plan_changed' });
  assert.equal(f.client.current.saved.revision, before.revision); assert.equal(f.client.current.conflict, true);
});

test('event publication preflight rejects a missing or changed immutable deadline', async t => {
  for (const scenario of ['missing', 'longer', 'shorter', 'string', 'server-changed']) await t.test(scenario, async () => {
    const f = fixture(), saved = f.client.save();
    f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
    const before = structuredClone(f.client.current.saved);
    const prepared = f.client.preparePost(before.needs[0].id, { roles: ROLES });
    const draft = { ...prepared.draft }, server = structuredClone(before);
    if (scenario === 'missing') delete draft.notAfter;
    if (scenario === 'longer') draft.notAfter += 60_000;
    if (scenario === 'shorter') draft.notAfter -= 60_000;
    if (scenario === 'string') draft.notAfter = String(draft.notAfter);
    if (scenario === 'server-changed') server.endsAt += 60_000;
    const pending = f.client.verifyPostSource(prepared.source, draft, ROLES);
    f.calls[1].resolve({ plan: server });
    await assert.rejects(pending, { code: 'event_draft_unavailable' });
    assert.deepEqual(f.client.current.saved, before);
    assert.equal(f.calls.length, 2);
  });
});

test('preflight aborts when the account or draft changes during its read and rechecks remaining time', async () => {
  for (const scenario of ['account', 'draft', 'finished', 'foreign']) {
    const f = fixture(), saved = f.client.save(); f.calls[0].resolve({ plan: view(f.client.current) }); await saved;
    const snapshot = structuredClone(f.client.current.saved), prepared = f.client.preparePost(snapshot.needs[0].id, { roles: ROLES });
    const pending = f.client.verifyPostSource(prepared.source, prepared.draft, ROLES);
    if (scenario === 'account') f.client.reset();
    if (scenario === 'draft') f.client.edit(draft => { draft.needs[0].quantity = 6; });
    if (scenario === 'finished') f.advance(108000000);
    if (scenario === 'foreign') f.calls[1].reject(problem('event_plan_not_found', 404)); else f.calls[1].resolve({ plan: snapshot });
    await assert.rejects(pending, { code: scenario === 'finished' ? 'event_finished' : scenario === 'foreign' ? 'event_plan_not_found' : 'event_draft_unavailable' });
    assert.equal(f.calls.length, 2);
  }
});

// Ollama Cloud glm-5.2: selected generated state/renderer cases; provenance in DELEGATED-BUILD.md.
function makeDerive(overrides = {}) {
  return (options) => {
    const places = options.places;
    const durationMinutes = options.durationMinutes;
    const extraNote = options.extraNote;
    if (places === undefined) return { ok: false, code: 'event_places_required' };
    if (typeof places !== 'number' || places < 1) return { ok: false, code: 'event_places_invalid' };
    if (durationMinutes !== undefined && ![30, 60, 120, 240].includes(durationMinutes)) {
      return { ok: false, code: 'event_duration_invalid' };
    }
    if (extraNote !== undefined && typeof extraNote !== 'string') {
      return { ok: false, code: 'event_note_invalid' };
    }
    if (extraNote && extraNote.length > 180) return { ok: false, code: 'event_note_too_long' };
    return {
      ok: true,
      draft: {
        kind: 'need',
        role: 'driver',
        cityId: 'city-1',
        english: false,
        vehicle: false,
        durationMinutes: durationMinutes || 60,
        places,
        note: extraNote || ''
      },
      source: { planId: 'plan-1', revision: 3, needId: 'need-1' },
      remaining: 5,
      allowedDurations: [30, 60, 120]
    };
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function baseConfig(overrides = {}) {
  return {
    derive: makeDerive(),
    send: async () => ({ post: { id: 'post-1' } }),
    makeKey: () => 'key-1',
    onChange: () => {},
    role: 'driver',
    cityLabel: 'Lyon',
    remaining: 5,
    ...overrides
  };
}

test('initialization derives synchronously and does not call send or makeKey', () => {
  let sendCalls = 0;
  let keyCalls = 0;
  const state = new EventPostPreviewState(baseConfig({
    send: async () => { sendCalls++; return { post: { id: 'x' } }; },
    makeKey: () => { keyCalls++; return 'k'; }
  }));
  const snap = state.snapshot();
  assert.equal(sendCalls, 0);
  assert.equal(keyCalls, 0);
  assert.equal(snap.phase, 'editing');
  assert.equal(snap.busy, false);
  assert.equal(snap.postId, null);
  assert.equal(snap.errorCode, null);
  assert.deepEqual(snap.result, { ok: false, code: 'event_places_required' });
  assert.deepEqual(snap.options, {});
});

test('snapshot is detached and cannot mutate internal state', () => {
  const state = new EventPostPreviewState(baseConfig());
  state.edit({ places: 2, durationMinutes: 60, extraNote: 'hello' });
  const snap = state.snapshot();
  snap.options.places = 99;
  snap.options.extraNote = 'mutated';
  if (snap.result) { snap.result.draft.places = 999; snap.result.remaining = 0; }
  const snap2 = state.snapshot();
  assert.equal(snap2.options.places, 2);
  assert.equal(snap2.options.extraNote, 'hello');
  assert.equal(snap2.result.draft.places, 2);
  assert.equal(snap2.result.remaining, 5);
});

test('edit merges only allowed keys and removes undefined optionals', () => {
  const state = new EventPostPreviewState(baseConfig());
  state.edit({ places: 3, extraNote: 'note' });
  assert.equal(state.snapshot().options.places, 3);
  assert.equal(state.snapshot().options.extraNote, 'note');
  state.edit({ extraNote: undefined });
  const opts = state.snapshot().options;
  assert.equal(Object.prototype.hasOwnProperty.call(opts, 'extraNote'), false);
  assert.equal(opts.places, 3);
});

test('publish derives again at click time and blocks expired draft', async () => {
  let finished = false;
  const derive = (options) => {
    if (finished) return { ok: false, code: 'event_finished' };
    return makeDerive()(options);
  };
  const state = new EventPostPreviewState(baseConfig({ derive }));
  state.edit({ places: 2 });
  const snap1 = state.snapshot();
  assert.equal(snap1.result.ok, true);
  finished = true;
  const ok = await state.publish();
  assert.equal(ok, false);
  assert.equal(state.snapshot().phase, 'editing');
  assert.equal(state.snapshot().errorCode, 'event_finished');
});

test('duplicate concurrent publish returns false and sends only once', async () => {
  let sendCalls = 0;
  const d = deferred();
  const state = new EventPostPreviewState(baseConfig({
    send: async () => { sendCalls++; return d.promise; }
  }));
  state.edit({ places: 2 });
  const p1 = state.publish();
  const second = await state.publish();
  assert.equal(second, false);
  d.resolve({ post: { id: 'post-1' } });
  await p1;
  assert.equal(sendCalls, 1);
});

test('network/5xx error retains intent and blocks edit; retry uses same key with retry=true', async () => {
  let sendCalls = 0;
  const sentArgs = [];
  const d = deferred();
  const state = new EventPostPreviewState(baseConfig({
    send: async (args) => { sendCalls++; sentArgs.push(args); return d.promise; }
  }));
  state.edit({ places: 2, extraNote: 'note' });
  const p1 = state.publish();
  d.reject({ code: 'timeout', status: 504 });
  await p1;
  const snap = state.snapshot();
  assert.equal(snap.phase, 'uncertain');
  assert.equal(snap.busy, false);
  assert.equal(state.edit({ places: 3 }), false);
  const d2 = deferred();
  state._send = async (args) => { sendCalls++; sentArgs.push(args); return d2.promise; };
  const p2 = state.publish();
  assert.equal(state.snapshot().phase, 'sending');
  assert.equal(state.snapshot().busy, true);
  d2.resolve({ post: { id: 'post-2' } });
  const ok = await p2;
  assert.equal(ok, true);
  assert.equal(sendCalls, 2);
  assert.equal(sentArgs[0].retry, false);
  assert.equal(sentArgs[1].retry, true);
  assert.equal(sentArgs[0].key, sentArgs[1].key);
  assert.deepEqual(sentArgs[0].draft, sentArgs[1].draft);
  assert.deepEqual(sentArgs[0].source, sentArgs[1].source);
});

test('definite 4xx error clears intent and allows new edits and new key', async () => {
  let keyCalls = 0;
  const keys = ['key-1', 'key-2'];
  const d = deferred();
  const state = new EventPostPreviewState(baseConfig({
    send: async () => d.promise,
    makeKey: () => keys[keyCalls++]
  }));
  state.edit({ places: 2 });
  const p1 = state.publish();
  d.reject({ code: 'event_need_full', status: 409 });
  await p1;
  const snap = state.snapshot();
  assert.equal(snap.phase, 'editing');
  assert.equal(snap.errorCode, 'event_need_full');
  assert.equal(snap.busy, false);
  assert.equal(state.edit({ places: 4 }), true);
  const d2 = deferred();
  state._send = async () => d2.promise;
  const p2 = state.publish();
  d2.resolve({ post: { id: 'post-3' } });
  const ok = await p2;
  assert.equal(ok, true);
  assert.equal(keyCalls, 2);
});

test('definitive flag without 4xx clears intent', async () => {
  const d = deferred();
  const state = new EventPostPreviewState(baseConfig({ send: async () => d.promise }));
  state.edit({ places: 2 });
  const p = state.publish();
  d.reject({ code: 'login_required', definitive: true });
  await p;
  assert.equal(state.snapshot().phase, 'editing');
  assert.equal(state.snapshot().errorCode, 'login_required');
});

test('non-integer HTTP status like 400.5 remains uncertain', async () => {
  const d = deferred();
  const state = new EventPostPreviewState(baseConfig({ send: async () => d.promise }));
  state.edit({ places: 2 });
  const p = state.publish();
  d.reject({ code: 'weird_status', status: 400.5 });
  await p;
  assert.equal(state.snapshot().phase, 'uncertain');
  assert.equal(state.snapshot().errorCode, 'weird_status');
});

test('malformed success result is uncertain', async () => {
  const d = deferred();
  const state = new EventPostPreviewState(baseConfig({ send: async () => d.promise }));
  state.edit({ places: 2 });
  const p = state.publish();
  d.resolve({ post: {} });
  await p;
  const snap = state.snapshot();
  assert.equal(snap.phase, 'uncertain');
  assert.equal(snap.errorCode, 'invalid_post_response');
});

test('reset during pending request ignores resolve and preserves new operation', async () => {
  let sendCalls = 0;
  const d1 = deferred();
  const d2 = deferred();
  const sends = [d1.promise, d2.promise];
  const state = new EventPostPreviewState(baseConfig({
    send: async () => { const p = sends[sendCalls++]; return p; }
  }));
  state.edit({ places: 2 });
  const p1 = state.publish();
  state.reset();
  assert.equal(state.snapshot().phase, 'editing');
  assert.equal(state.snapshot().busy, false);
  state.edit({ places: 3 });
  const p2 = state.publish();
  d1.resolve({ post: { id: 'stale' } });
  d2.resolve({ post: { id: 'fresh' } });
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1, false);
  assert.equal(r2, true);
  assert.equal(state.snapshot().postId, 'fresh');
});

test('reset during pending request ignores reject and preserves new operation', async () => {
  let sendCalls = 0;
  const d1 = deferred();
  const d2 = deferred();
  const sends = [d1.promise, d2.promise];
  const state = new EventPostPreviewState(baseConfig({
    send: async () => { const p = sends[sendCalls++]; return p; }
  }));
  state.edit({ places: 2 });
  const p1 = state.publish();
  state.reset();
  state.edit({ places: 3 });
  const p2 = state.publish();
  d1.reject({ code: 'timeout', status: 503 });
  d2.resolve({ post: { id: 'fresh2' } });
  const r1 = await p1;
  const r2 = await p2;
  assert.equal(r1, false);
  assert.equal(r2, true);
  assert.equal(state.snapshot().postId, 'fresh2');
});

test('renderer escapes hostile role, city, note and extraNote', () => {
  const html = renderEventPostPreview({
    role: '<script>alert(1)</script>',
    cityLabel: '<img src=x onerror=alert(2)>',
    remaining: 5,
    options: { places: 2, extraNote: '<b>note</b> & "quote"' },
    result: {
      ok: true,
      draft: {
        kind: 'need', role: '<script>', cityId: 'c', english: false, vehicle: false,
        durationMinutes: 60, places: 2, note: '<i>hostile</i> note'
      },
      remaining: 5,
      allowedDurations: [30, 60]
    },
    phase: 'editing',
    errorCode: null,
    postId: null,
    busy: false
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('<img src=x onerror=alert(2)>'), false);
  assert.equal(html.includes('<b>note</b>'), false);
  assert.equal(html.includes('<i>hostile</i>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;b&gt;note&lt;/b&gt;'));
  assert.ok(html.includes('&lt;i&gt;hostile&lt;/i&gt; note'));
});

test('renderer does not expose source IDs or plan IDs', () => {
  const html = renderEventPostPreview({
    role: 'driver',
    cityLabel: 'Lyon',
    remaining: 5,
    options: { places: 2 },
    result: {
      ok: true,
      draft: { kind: 'need', role: 'driver', cityId: 'secret-city', english: false, vehicle: false, durationMinutes: 60, places: 2, note: 'note' },
      remaining: 5,
      allowedDurations: [60]
    },
    phase: 'editing',
    errorCode: null,
    postId: null,
    busy: false
  });
  assert.equal(html.includes('secret-city'), false);
  assert.equal(html.includes('plan-'), false);
  assert.equal(html.includes('need-'), false);
});

test('renderer select limits places to min(8, remaining) and ignores durations', () => {
  const html = renderEventPostPreview({
    role: 'driver', cityLabel: 'Lyon', remaining: 3, options: {}, result: null,
    phase: 'editing', errorCode: null, postId: null, busy: false
  });
  const matches = html.match(/<select id="event-post-preview-places"[\s\S]*?<\/select>/);
  assert.ok(matches);
  const optionMatches = matches[0].match(/<option value="(\d+)"/g);
  assert.ok(optionMatches);
  assert.equal(optionMatches.length, 3);
});

test('renderer disables submit when invalid', () => {
  const html = renderEventPostPreview({
    role: 'driver', cityLabel: 'Lyon', remaining: 5, options: {}, result: null,
    phase: 'editing', errorCode: 'event_places_required', postId: null, busy: false
  });
  assert.ok(html.includes('disabled'));
  assert.ok(html.includes('Indiquez le nombre de places.'));
});

test('renderer shows sending state with disabled controls', () => {
  const html = renderEventPostPreview({
    role: 'driver', cityLabel: 'Lyon', remaining: 5, options: { places: 2 },
    result: { ok: true, draft: { kind: 'need', role: 'driver', cityId: 'c', english: false, vehicle: false, durationMinutes: 60, places: 2, note: '' }, remaining: 5, allowedDurations: [60] },
    phase: 'sending', errorCode: null, postId: null, busy: true
  });
  assert.ok(html.includes('Publication en cours…'));
  assert.ok(html.includes('disabled'));
});

test('renderer uncertain state shows retry button and no new-publish form', () => {
  const html = renderEventPostPreview({
    role: 'driver', cityLabel: 'Lyon', remaining: 5, options: { places: 2 },
    result: { ok: true, draft: { kind: 'need', role: 'driver', cityId: 'c', english: false, vehicle: false, durationMinutes: 60, places: 2, note: 'exact intent' }, remaining: 5, allowedDurations: [60] },
    phase: 'uncertain', errorCode: 'timeout', postId: null, busy: false
  });
  assert.ok(html.includes('data-preview-action="retry"'));
  assert.ok(html.includes('Vérifier la publication'));
  assert.equal(html.includes('<form'), false);
  assert.ok(html.includes('role="status"'));
  assert.ok(html.includes('exact intent'));
  assert.ok(html.includes('Résumé : 2 places, visible jusqu’à 60 minutes, sans dépasser la fin de l’événement.'));
});

test('renderer success state shows view and new buttons, no form', () => {
  const html = renderEventPostPreview({
    role: 'driver', cityLabel: 'Lyon', remaining: 5, options: {}, result: null,
    phase: 'success', errorCode: null, postId: 'post-1', busy: false
  });
  assert.ok(html.includes('data-preview-action="view"'));
  assert.ok(html.includes('data-preview-action="new"'));
  assert.equal(html.includes('<form'), false);
  assert.equal(html.includes('post-1'), false);
});

test('renderer maps known error codes to French text', () => {
  const codes = [
    'event_draft_invalid', 'event_draft_unavailable', 'event_finished', 'event_need_full',
    'event_places_required', 'event_places_invalid', 'event_window_too_short',
    'event_duration_invalid', 'event_note_invalid', 'event_note_too_long',
    'event_plan_changed', 'login_required', 'rules_acceptance_required',
    'rules_version_changed', 'own_post_capacity_reached'
  ];
  for (const code of codes) {
    const html = renderEventPostPreview({
      role: 'r', cityLabel: 'c', remaining: 5, options: {}, result: null,
      phase: 'editing', errorCode: code, postId: null, busy: false
    });
    assert.ok(html.includes('role="alert"'), code);
    assert.equal(html.includes(code), false, 'raw code should not appear: ' + code);
  }
});

test('renderer uses allowedDurations filter when valid', () => {
  const html = renderEventPostPreview({
    role: 'r', cityLabel: 'c', remaining: 5, options: { places: 2 },
    result: { ok: true, draft: { kind: 'need', role: 'r', cityId: 'c', english: false, vehicle: false, durationMinutes: 30, places: 2, note: '' }, remaining: 5, allowedDurations: [30, 120] },
    phase: 'editing', errorCode: null, postId: null, busy: false
  });
  assert.ok(html.includes('value="30"'));
  assert.ok(html.includes('value="120"'));
  assert.equal(html.includes('value="60"'), false);
  assert.equal(html.includes('value="240"'), false);
});
