import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../database.mjs';
import { AuthService } from '../auth.mjs';
import { ProductionStore } from '../production-store.mjs';
import { RULES } from '../rules.mjs';
import { getLocation } from '../locations.mjs';
import { ErasureJournal, initializeErasureJournal, reconcileErasures } from '../erasure-journal.mjs';
import { EventPlanStore, EVENT_PLAN_LIMITS } from '../event-plans.mjs';

const START = Date.UTC(2026, 7, 28), HOUR = 3600000;
const error = (status, code) => problem => problem.status === status && problem.code === code;
const common = () => ({ attire: 'Tenue noire', equipment: 'Chaussures adaptées', arrival: 'Entrée livraison' });
const need = () => ({ id: randomUUID(), role: 'Serveur', quantity: 4, confirmed: 1, languages: { fr: 'required', en: 'preferred' },
  skills: 'Service au plateau', overrides: { attire: null, equipment: '', arrival: 'Accueil principal' } });
const input = () => ({ id: randomUUID(), title: 'Événement synthétique', cityId: '2988507', timezone: 'Europe/Paris', venue: 'Salle de réception',
  startLocal: '2026-08-29T17:00', endLocal: '2026-08-29T23:00', common: common(), needs: [need()] });
const updateInput = (original, expectedRevision = 1) => { const { id, ...data } = structuredClone(original); return { expectedRevision, ...data }; };
async function fixture(t, { persistent = false, now = START, ...options } = {}) {
  const root = persistent ? await mkdtemp(path.join(tmpdir(), 'social-event-plan-')) : null;
  const filename = root ? path.join(root, 'app.sqlite') : ':memory:', db = openDatabase(filename);
  const auth = new AuthService({ db, clock: () => now, testKdf: async (password, salt) => createHash('sha512').update(password).update(salt).digest() });
  const store = new ProductionStore({ db, clock: () => now });
  const register = async username => (await auth.register({ username, password: 'synthetic event plan fixture password', acceptedRules: true, rulesVersion: RULES.version })).user.id;
  const owner = await register('event_fixture_owner'), other = await register('event_fixture_other');
  const plans = new EventPlanStore({ db, clock: () => now, ...options });
  t.after(async () => { if (db.isOpen) db.close(); if (root) await rm(root, { recursive: true, force: true }); });
  return { root, filename, db, auth, store, plans, owner, other, now: value => { now = value; } };
}

test('complete plans persist privately with stable need IDs, explicit manual counts and common exceptions', async t => {
  const f = await fixture(t, { persistent: true }), data = input(); data.needs.push({ ...need(), role: 'Barman', quantity: 2, confirmed: 0 });
  let events = 0; f.store.subscribe(() => events++);
  const created = f.plans.create(f.owner, data);
  assert.equal(created.replayed, false); assert.equal(created.plan.revision, 1);
  assert.equal(created.plan.visibility, 'private'); assert.equal(created.plan.confirmedMode, 'manual');
  assert.deepEqual(created.plan.totals, { quantity: 6, confirmed: 1, remaining: 5 });
  assert.deepEqual(created.plan.common, data.common); assert.deepEqual(created.plan.needs, data.needs);
  assert.equal(created.plan.startsAt, Date.UTC(2026, 7, 29, 15)); assert.equal(created.plan.endsAt, Date.UTC(2026, 7, 29, 21));
  assert.equal(events, 0); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_posts').get().n, 0);
  assert.equal(JSON.stringify(created).includes(f.owner), false); assert.equal(JSON.stringify(created).includes('event_fixture_owner'), false);
  const secondDb = openDatabase(f.filename);
  try { const secondStore = new EventPlanStore({ db: secondDb }); assert.deepEqual(secondStore.get(f.owner, data.id), { plan: created.plan }); }
  finally { secondDb.close(); }
});

test('all store methods enforce live account ownership and reveal no other owner through an ID', async t => {
  const f = await fixture(t), data = input(); f.plans.create(f.owner, data);
  assert.deepEqual(f.plans.list(f.other), { plans: [] });
  for (const operation of [() => f.plans.get(f.other, data.id), () => f.plans.update(f.other, data.id, updateInput(data)),
    () => f.plans.delete(f.other, data.id, { expectedRevision: 1 }), () => f.plans.create(f.other, data)]) assert.throws(operation, error(404, 'event_plan_not_found'));
  for (const operation of [() => f.plans.list(null), () => f.plans.get(randomUUID(), data.id), () => f.plans.create(randomUUID(), input())]) assert.throws(operation, error(401, 'login_required'));
  assert.equal(f.plans.get(f.owner, data.id).plan.revision, 1);
});

test('create UUID retries compare normalized payloads, never overwrite edits, and replay after the event starts', async t => {
  const f = await fixture(t), data = input(), first = f.plans.create(f.owner, data);
  assert.deepEqual(f.plans.create(f.owner, data), { plan: first.plan, replayed: true });
  assert.throws(() => f.plans.create(f.owner, { ...data, venue: 'Autre salle' }), error(409, 'event_plan_idempotency_conflict'));
  const changed = updateInput(data); changed.needs[0].confirmed = 3;
  f.plans.update(f.owner, data.id, changed);
  const replay = f.plans.create(f.owner, { ...data, title: `  ${data.title} ` });
  assert.equal(replay.replayed, true); assert.equal(replay.plan.revision, 2); assert.equal(replay.plan.needs[0].confirmed, 3);
  f.now(Date.UTC(2026, 8, 1)); assert.equal(f.plans.create(f.owner, data).plan.revision, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n, 1);
});

test('optimistic revisions stop stale edits/deletes while complete updates keep need identity and ordering', async t => {
  const f = await fixture(t), data = input(); data.needs.push(need()); f.plans.create(f.owner, data);
  const changed = updateInput(data); changed.needs.reverse(); changed.needs[0].confirmed = 4;
  const saved = f.plans.update(f.owner, data.id, changed).plan;
  assert.equal(saved.revision, 2); assert.deepEqual(saved.needs.map(row => row.id), changed.needs.map(row => row.id));
  assert.throws(() => f.plans.update(f.owner, data.id, updateInput(data)), error(409, 'event_plan_changed'));
  assert.throws(() => f.plans.delete(f.owner, data.id, { expectedRevision: 1 }), error(409, 'event_plan_changed'));
  assert.throws(() => f.plans.update(f.owner, data.id, { expectedRevision: 2, title: 'Incomplete' }), error(400, 'event_plan_incomplete'));
  assert.equal(f.plans.get(f.owner, data.id).plan.revision, 2);
});

test('delete clears event content, releases active capacity, and leaves a bounded non-resurrecting tombstone', async t => {
  const f = await fixture(t, { maxPlansPerUser: 1, maxRecordsPerUser: 2 }), data = input(); f.plans.create(f.owner, data);
  assert.throws(() => f.plans.create(f.owner, input()), error(429, 'event_plan_capacity_reached'));
  const deleted = f.plans.delete(f.owner, data.id, { expectedRevision: 1 });
  assert.deepEqual(deleted, { deleted: true, id: data.id, revision: 2 });
  assert.deepEqual(f.plans.delete(f.owner, data.id, { expectedRevision: 1 }), deleted);
  const row = f.db.prepare('SELECT * FROM app_event_plans WHERE id=?').get(data.id);
  assert.equal(row.data, null); assert.equal(row.starts_at, 0); assert.equal(row.ends_at, 0);
  assert.equal(JSON.stringify(row).includes(data.title), false);
  assert.throws(() => f.plans.create(f.owner, data), error(410, 'event_plan_deleted'));
  assert.throws(() => f.plans.create(f.owner, { ...data, title: 'Different' }), error(409, 'event_plan_idempotency_conflict'));
  assert.throws(() => f.plans.get(f.owner, data.id), error(404, 'event_plan_not_found')); assert.deepEqual(f.plans.list(f.owner), { plans: [] });
  const second = input(); f.plans.create(f.owner, second); f.plans.delete(f.owner, second.id, { expectedRevision: 1 });
  assert.throws(() => f.plans.create(f.owner, input()), error(429, 'event_plan_idempotency_capacity_reached'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n, 2);
});

test('the twenty-plan limit is per account, retries do not consume capacity, and global record budget never evicts', async t => {
  const f = await fixture(t), data = [];
  for (let i = 0; i < EVENT_PLAN_LIMITS.activePerUser; i++) { const draft = input(); data.push(draft); f.plans.create(f.owner, draft); }
  assert.throws(() => f.plans.create(f.owner, input()), error(429, 'event_plan_capacity_reached'));
  assert.equal(f.plans.create(f.owner, data[0]).replayed, true); f.plans.create(f.other, input());
  assert.equal(f.plans.list(f.owner).plans.length, 20); assert.equal(f.plans.list(f.other).plans.length, 1);
  const limited = new EventPlanStore({ db: f.db, clock: () => START, maxTotalRecords: 21 });
  assert.throws(() => limited.create(f.other, input()), error(429, 'event_plan_idempotency_capacity_reached'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n, 21);
});

test('needs/quantities/languages/text are strict and manual confirmed counts cannot exceed quantity', async t => {
  const f = await fixture(t), cases = [
    data => { data.needs = []; }, data => { data.needs = Array.from({ length: 13 }, need); },
    data => { data.needs.push(structuredClone(data.needs[0])); }, data => { data.needs[0].id = 'not-a-uuid'; },
    data => { data.needs[0].role = 'Invented'; }, data => { data.needs[0].quantity = 0; }, data => { data.needs[0].quantity = 51; },
    data => { data.needs[0].quantity = '4'; }, data => { data.needs[0].confirmed = -1; }, data => { data.needs[0].confirmed = 5; },
    data => { data.needs[0].confirmed = 1.5; }, data => { data.needs[0].languages.fr = true; },
    data => { data.needs[0].languages.en = 'fluent'; }, data => { data.needs[0].skills = 'x'.repeat(181); },
    data => { data.common.arrival = 'x'.repeat(121); }, data => { data.needs[0].overrides.attire = 'x'.repeat(121); },
    data => { data.needs[0].candidateIds = [randomUUID()]; }, data => { data.public = true; },
    data => { data.title = ' '; }, data => { data.venue = ''; }, data => { delete data.common.equipment; },
  ];
  for (const mutate of cases) { const draft = input(); mutate(draft); assert.throws(() => f.plans.create(f.owner, draft), problem => problem.status === 400); }
  assert.deepEqual(f.plans.list(f.owner), { plans: [] });
  const maximum = input(); maximum.needs = Array.from({ length: 12 }, () => ({ ...need(), quantity: 50, confirmed: 50 }));
  assert.deepEqual(f.plans.create(f.owner, maximum).plan.totals, { quantity: 600, confirmed: 600, remaining: 0 });
});

test('detectable synthetic contact/payment details are rejected across common fields and exceptions', async t => {
  const f = await fixture(t), samples = ['synthetic' + '@example.invalid', '+' + '0'.repeat(11), 'ZZ00' + 'A'.repeat(16)];
  for (const value of samples) for (const set of [draft => { draft.venue = value; }, draft => { draft.common.arrival = value; },
    draft => { draft.needs[0].skills = value; }, draft => { draft.needs[0].overrides.equipment = value; }]) {
    const data = input(); set(data); assert.throws(() => f.plans.create(f.owner, data), error(400, 'event_plan_personal_data'));
  }
  const data = input(); data.common.arrival = 'Arriver 30 min avant, porte 2'; assert.equal(f.plans.create(f.owner, data).plan.common.arrival, data.common.arrival);
});

test('validated city timezone is mandatory and never inferred from the host timezone', async t => {
  const f = await fixture(t), data = input(), previous = process.env.TZ;
  try { process.env.TZ = 'Pacific/Honolulu'; assert.equal(f.plans.create(f.owner, data).plan.startsAt, Date.UTC(2026, 7, 29, 15)); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  for (const changes of [{ timezone: 'UTC' }, { timezone: undefined }, { cityId: 'unknown' }]) assert.throws(() => f.plans.create(f.owner, { ...input(), ...changes }), problem => problem.status === 400);
  const kathmandu = getLocation('1283240'), local = input(); local.cityId = kathmandu.id; local.timezone = kathmandu.timezone;
  assert.equal(f.plans.create(f.owner, local).plan.startsAt, Date.UTC(2026, 7, 29, 11, 15));
});

test('impossible calendar dates, DST gaps and folds at either endpoint are rejected rather than converted', async t => {
  const f = await fixture(t, { now: Date.UTC(2026, 1, 1) });
  for (const [startLocal, endLocal, code] of [
    ['2026-02-30T12:00', '2026-03-01T13:00', 'invalid_event_local_time'],
    ['2026-03-29T02:30', '2026-03-29T04:00', 'event_time_nonexistent'],
    ['2026-03-29T01:30', '2026-03-29T02:30', 'event_time_nonexistent'],
    ['2026-03-29T24:00', '2026-03-30T01:00', 'invalid_event_local_time'],
    ['2026-03-29T01:30Z', '2026-03-29T04:00', 'invalid_event_local_time'],
  ]) assert.throws(() => f.plans.create(f.owner, { ...input(), startLocal, endLocal }), error(400, code));
  f.now(START);
  for (const [startLocal, endLocal] of [['2026-10-25T02:30', '2026-10-25T04:00'], ['2026-10-25T01:30', '2026-10-25T02:30']])
    assert.throws(() => f.plans.create(f.owner, { ...input(), startLocal, endLocal }), error(400, 'event_time_ambiguous'));
  const ny = getLocation('5128581');
  assert.throws(() => f.plans.create(f.owner, { ...input(), cityId: ny.id, timezone: ny.timezone, startLocal: '2026-11-01T01:30', endLocal: '2026-11-01T03:00' }), error(400, 'event_time_ambiguous'));
});

test('event duration uses real instants across DST and requires a future start within 180 days', async t => {
  const f = await fixture(t, { now: Date.UTC(2026, 1, 1) });
  const spring = f.plans.create(f.owner, { ...input(), startLocal: '2026-03-29T01:30', endLocal: '2026-03-29T03:30' }).plan;
  assert.equal(spring.endsAt - spring.startsAt, HOUR);
  f.now(START);
  const autumn = f.plans.create(f.owner, { ...input(), startLocal: '2026-10-25T01:30', endLocal: '2026-10-25T03:30' }).plan;
  assert.equal(autumn.endsAt - autumn.startsAt, 3 * HOUR);
  for (const changes of [
    { startLocal: '2026-08-28T02:00', endLocal: '2026-08-28T03:00' },
    { startLocal: '2027-03-01T10:00', endLocal: '2027-03-01T11:00' },
    { startLocal: '2026-08-29T17:00', endLocal: '2026-08-29T17:00' },
    { startLocal: '2026-08-29T17:00', endLocal: '2026-08-29T16:59' },
    { startLocal: '2026-08-29T17:00', endLocal: '2026-08-31T05:01' },
  ]) assert.throws(() => f.plans.create(f.owner, { ...input(), ...changes }), problem => problem.status === 400);
  const exact = f.plans.create(f.owner, { ...input(), startLocal: '2026-08-29T17:00', endLocal: '2026-08-31T05:00' }).plan;
  assert.equal(exact.endsAt - exact.startsAt, 36 * HOUR);
});

test('the 180-day boundary is inclusive in instants and returned objects cannot mutate persisted plans', async t => {
  const f = await fixture(t), data = input();
  f.now(Date.UTC(2026, 7, 29, 15) - 180 * 86400000);
  const saved = f.plans.create(f.owner, data).plan;
  saved.needs[0].confirmed = 99; saved.common.attire = 'Changed only in memory';
  assert.equal(f.plans.get(f.owner, data.id).plan.needs[0].confirmed, 1);
  assert.equal(f.plans.get(f.owner, data.id).plan.common.attire, data.common.attire);
  f.now(Date.UTC(2026, 7, 29, 15) - 180 * 86400000 - 1);
  assert.throws(() => f.plans.create(f.owner, input()), error(400, 'event_start_out_of_range'));
});

test('the owner is checked again inside the write transaction after the operator guard', async t => {
  let erase = false, f;
  f = await fixture(t, { beforeMutation: () => { if (erase) f.auth.deleteAccount(f.owner); } });
  erase = true;
  assert.throws(() => f.plans.create(f.owner, input()), error(401, 'login_required'));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n, 0);
  assert.equal(f.db.isTransaction, false);
});

test('mutation guard and transaction rollback preserve plans and original errors, including SQLITE_FULL', async t => {
  let blocked = false; const refusal = Error('synthetic maintenance');
  const f = await fixture(t, { beforeMutation: () => { if (blocked) throw refusal; } }), data = input(); f.plans.create(f.owner, data); blocked = true;
  for (const operation of [() => f.plans.create(f.owner, input()), () => f.plans.update(f.owner, data.id, updateInput(data)),
    () => f.plans.delete(f.owner, data.id, { expectedRevision: 1 })]) assert.throws(operation, problem => problem === refusal);
  assert.equal(f.plans.get(f.owner, data.id).plan.revision, 1); assert.equal(f.plans.list(f.owner).plans.length, 1); blocked = false;
  f.db.exec("CREATE TRIGGER refuse_plan BEFORE UPDATE ON app_event_plans BEGIN SELECT RAISE(ABORT,'synthetic update failure'); END;");
  assert.throws(() => f.plans.update(f.owner, data.id, updateInput(data)), /synthetic update failure/);
  assert.equal(f.db.isTransaction, false); assert.equal(f.plans.get(f.owner, data.id).plan.revision, 1); f.db.exec('DROP TRIGGER refuse_plan');
  f.db.exec('CREATE TABLE fill_pages (value BLOB);'); const pages = f.db.prepare('PRAGMA page_count').get().page_count;
  f.db.exec(`PRAGMA max_page_count=${pages}`);
  while (true) { try { f.db.prepare('INSERT INTO fill_pages VALUES(zeroblob(1000))').run(); } catch (problem) { assert.equal(problem.errcode & 255, 13); break; } }
  const large = input(); large.needs = Array.from({ length: 12 }, () => ({ ...need(), skills: 'x'.repeat(180), overrides: { attire: 'x'.repeat(120), equipment: 'x'.repeat(120), arrival: 'x'.repeat(120) } }));
  assert.throws(() => f.plans.create(f.owner, large), problem => (problem.errcode & 255) === 13);
  assert.equal(f.db.isTransaction, false); assert.equal(f.plans.get(f.owner, data.id).plan.revision, 1);
});

test('account deletion cascades active plans and tombstones, including journal replay before startup', async t => {
  const f = await fixture(t, { persistent: true }), data = input(); f.plans.create(f.owner, data);
  const deleted = input(); f.plans.create(f.owner, deleted); f.plans.delete(f.owner, deleted.id, { expectedRevision: 1 });
  f.plans.create(f.other, input()); f.auth.deleteAccount(f.owner);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM app_event_plans WHERE owner_id=?').get(f.owner).n, 0);
  assert.equal(f.plans.list(f.other).plans.length, 1);
  // Bootstrap a separate empty application, then record a pending erasure.
  const file = path.join(f.root, 'journal-app.sqlite'), db = openDatabase(file);
  let journal;
  try {
    const auth = new AuthService({ db, testKdf: async (password, salt) => createHash('sha512').update(password).update(salt).digest() }), store = new ProductionStore({ db });
    initializeErasureJournal({ db, filename: path.join(f.root, 'journal.sqlite') }); journal = new ErasureJournal(path.join(f.root, 'journal.sqlite'));
    const owner = (await auth.register({ username: 'event_replay_owner', password: 'synthetic event replay phrase', acceptedRules: true, rulesVersion: RULES.version })).user.id;
    const plans = new EventPlanStore({ db, clock: () => START }); plans.create(owner, input()); journal.append(owner);
    assert.equal(reconcileErasures({ db, auth, store, journal }).applied, 1); assert.equal(db.prepare('SELECT COUNT(*) n FROM app_event_plans').get().n, 0);
  } finally { journal?.close(); db.close(); }
});

test('two concurrent connections cannot both claim the last plan slot or overwrite the same revision', async t => {
  const f = await fixture(t, { persistent: true, maxPlansPerUser: 1 }), gate = new SharedArrayBuffer(4), signal = new Int32Array(gate);
  const code = `const {parentPort,workerData}=require('node:worker_threads');(async()=>{
    const {openDatabase}=await import(workerData.databaseModule),{EventPlanStore}=await import(workerData.planModule);
    const db=openDatabase(workerData.filename),store=new EventPlanStore({db,clock:()=>workerData.now,maxPlansPerUser:1});
    parentPort.postMessage({ready:true});Atomics.wait(new Int32Array(workerData.gate),0,0);
    try{const result=workerData.action==='create'?store.create(workerData.owner,workerData.input):store.update(workerData.owner,workerData.id,workerData.input);parentPort.postMessage({ok:true,revision:result.plan.revision});}
    catch(error){parentPort.postMessage({ok:false,code:error.code});}finally{db.close();}
  })().catch(()=>{process.exitCode=1;});`;
  async function race(action, drafts, planId) {
    Atomics.store(signal, 0, 0); const workers = [];
    try {
      const ready = [], results = [];
      for (const draft of drafts) {
        const worker = new Worker(code, { eval: true, workerData: { databaseModule: new URL('../database.mjs', import.meta.url).href,
          planModule: new URL('../event-plans.mjs', import.meta.url).href, filename: f.filename, owner: f.owner, now: START, gate, action, input: draft, id: planId } }); workers.push(worker);
        ready.push(new Promise((resolve, reject) => { worker.on('message', message => { if (message.ready) resolve(); }); worker.once('error', reject); worker.once('exit', value => { if (value) reject(Error('fixture worker failed')); }); }));
        results.push(new Promise((resolve, reject) => { worker.on('message', message => { if ('ok' in message) resolve(message); }); worker.once('error', reject); worker.once('exit', value => { if (value) reject(Error('fixture worker failed')); }); }));
      }
      await Promise.all(ready); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0, 2); return await Promise.all(results);
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  }
  const created = await race('create', [input(), input()]);
  assert.equal(created.filter(result => result.ok).length, 1); assert.equal(created.find(result => !result.ok).code, 'event_plan_capacity_reached');
  const saved = f.plans.list(f.owner).plans[0], data = input(); data.id = saved.id;
  const edited = await race('update', [updateInput(data), { ...updateInput(data), title: 'Autre version synthétique' }], saved.id);
  assert.equal(edited.filter(result => result.ok).length, 1); assert.equal(edited.find(result => !result.ok).code, 'event_plan_changed');
  assert.equal(f.plans.get(f.owner, saved.id).plan.revision, 2);
});
