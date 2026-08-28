import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthService, SCRYPT_CONFIG } from '../auth.mjs';
import { ApiError } from '../domain.mjs';
import { RULES, rulesDocument, verifyRulesDocument } from '../rules.mjs';

const AGREEMENT = { acceptedRules: true, rulesVersion: RULES.version };

const PASSWORD = 'test-only password phrase 123';
const NEW_PASSWORD = 'another test-only phrase 456';
// Deterministic, intentionally cheap test seam. Never used outside node:test.
const fastKdf = (password, salt) => createHmac('sha512', salt).update(password).digest();
const hash = token => createHash('sha256').update(Buffer.from(token, 'hex')).digest('hex');
const error = (status, code) => value => value instanceof ApiError && value.status === status && value.code === code;
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  let now = 1_800_000_000_000;
  const service = new AuthService({ db, clock: () => now, testKdf: fastKdf, ...options });
  t.after(() => db.close());
  return { db, service, advance: ms => { now += ms; } };
}
function controlledKdf() {
  let blocked = false;
  const pending = [];
  return {
    kdf(password, salt) {
      if (!blocked) return fastKdf(password, salt);
      return new Promise(resolve => pending.push(() => resolve(fastKdf(password, salt))));
    },
    block() { blocked = true; },
    pending,
  };
}

test('auth persists across SQLite reopening and stores no plaintext credential', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'extras-auth-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'auth.sqlite');
  let db = new DatabaseSync(filename);
  let service = new AuthService({ db, testKdf: fastKdf });
  const registered = await service.register({ ...AGREEMENT, username: 'WORKER_01', password: PASSWORD });
  assert.equal(registered.user.username, 'worker_01');
  assert.match(registered.sessionToken, /^[a-f0-9]{64}$/);
  assert.match(registered.recoveryCode, /^[a-f0-9]{64}$/);
  const userRow = db.prepare('SELECT * FROM auth_users').get();
  const sessionRow = db.prepare('SELECT * FROM auth_sessions').get();
  assert.equal(userRow.password_salt.length, 32);
  assert.equal(userRow.password_hash.length, 128);
  assert.match(userRow.password_kdf, /N131072-r8-p1-key64/);
  assert.equal(userRow.recovery_hash, hash(registered.recoveryCode));
  assert.equal(sessionRow.token_hash, hash(registered.sessionToken));
  for (const clear of [PASSWORD, registered.sessionToken, registered.recoveryCode]) {
    assert.ok(!JSON.stringify([userRow, sessionRow]).includes(clear));
  }
  assert.deepEqual(service.session(registered.sessionToken), registered.user);
  db.close();
  db = new DatabaseSync(filename);
  t.after(() => db.close());
  service = new AuthService({ db, testKdf: fastKdf });
  assert.deepEqual(service.session(registered.sessionToken), registered.user);
  const login = await service.login({ username: 'Worker_01', password: PASSWORD });
  assert.deepEqual(login.user, registered.user);
  assert.notEqual(login.sessionToken, registered.sessionToken);
  assert.deepEqual(Object.keys(service.session(login.sessionToken)).sort(), ['id', 'username']);
});

test('auth validates usernames/passwords and enforces case-insensitive uniqueness', async t => {
  const { service } = fixture(t);
  const invalidNames = ['', 'ab', 'x'.repeat(33), 'with space', 'worker\n', 'worker\r', 'a@b', '../name', 'été', 1, null];
  for (const username of invalidNames) await assert.rejects(service.register({ ...AGREEMENT, username, password: PASSWORD }), error(400, 'invalid_username'));
  const invalidPasswords = ['', 'x'.repeat(14), 'x'.repeat(129), '\u{1f680}'.repeat(129), '\ud800'.repeat(15), 123, null];
  for (const password of invalidPasswords) await assert.rejects(service.register({ ...AGREEMENT, username: 'worker_02', password }), error(400, 'invalid_password'));
  for (const input of [null, [], {}, { username: 'worker_02', password: PASSWORD, admin: true }]) {
    await assert.rejects(service.register(input), e => e instanceof ApiError && e.status === 400);
  }
  const unicode = await service.register({ ...AGREEMENT, username: 'Worker-02', password: '\u{1f680}'.repeat(128) });
  assert.equal(unicode.user.username, 'worker-02');
  await assert.rejects(service.register({ ...AGREEMENT, username: 'WORKER-02', password: PASSWORD }), error(409, 'username_unavailable'));
  assert.deepEqual((await service.login({ username: 'WORKER-02', password: '\u{1f680}'.repeat(128) })).user, unicode.user);
});

test('unknown usernames and wrong passwords perform the same KDF and return generic credentials errors', async t => {
  const calls = [];
  const { service } = fixture(t, { testKdf: (password, salt, config) => { calls.push({ saltLength: salt.length, config }); return fastKdf(password, salt); } });
  await service.register({ ...AGREEMENT, username: 'worker_03', password: PASSWORD });
  calls.length = 0;
  await assert.rejects(service.login({ username: 'worker_03', password: NEW_PASSWORD }), error(401, 'invalid_credentials'));
  await assert.rejects(service.login({ username: 'nonexistent_03', password: NEW_PASSWORD }), error(401, 'invalid_credentials'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].saltLength, 16);
  assert.deepEqual(calls[0], calls[1]);
  for (const value of [undefined, null, '', 'not-a-token', 'a'.repeat(64), {}, '0'.repeat(1000)]) assert.equal(service.session(value), null);
});

test('sessions expire at 30 days, logout revokes them, and only the five newest survive', async t => {
  const { db, service, advance } = fixture(t);
  const registered = await service.register({ ...AGREEMENT, username: 'worker_04', password: PASSWORD });
  const tokens = [registered.sessionToken];
  // A frozen clock exercises rowid tie breaking rather than timestamp ordering.
  for (let i = 0; i < 6; i++) tokens.push((await service.login({ username: 'worker_04', password: PASSWORD })).sessionToken);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 5);
  assert.equal(service.session(tokens[0]), null);
  assert.equal(service.session(tokens[1]), null);
  for (const token of tokens.slice(2)) assert.deepEqual(service.session(token), registered.user);
  service.logout(tokens[2]); service.logout('invalid');
  assert.equal(service.session(tokens[2]), null);
  advance(30 * 24 * 60 * 60 * 1000 - 1);
  assert.deepEqual(service.session(tokens[3]), registered.user);
  advance(1);
  assert.equal(service.session(tokens[3]), null);
  const fresh = await service.login({ username: 'worker_04', password: PASSWORD });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
  assert.deepEqual(service.session(fresh.sessionToken), registered.user);
});

test('recovery rotates its code/password and revokes every old session', async t => {
  const { service } = fixture(t);
  const registered = await service.register({ ...AGREEMENT, username: 'worker_05', password: PASSWORD });
  const oldLogin = await service.login({ username: 'worker_05', password: PASSWORD });
  for (const recoveryCode of ['', 'invalid', '0'.repeat(64)]) {
    await assert.rejects(service.recover({ recoveryCode, password: NEW_PASSWORD }), error(401, 'invalid_credentials'));
  }
  const recovered = await service.recover({ recoveryCode: registered.recoveryCode, password: NEW_PASSWORD });
  assert.deepEqual(recovered.user, registered.user);
  assert.notEqual(recovered.recoveryCode, registered.recoveryCode);
  assert.equal(service.session(registered.sessionToken), null);
  assert.equal(service.session(oldLogin.sessionToken), null);
  assert.deepEqual(service.session(recovered.sessionToken), registered.user);
  assert.equal(service.session(`${recovered.sessionToken}\n`), null);
  await assert.rejects(service.recover({ recoveryCode: `${recovered.recoveryCode}\n`, password: PASSWORD }), error(401, 'invalid_credentials'));
  await assert.rejects(service.login({ username: 'worker_05', password: PASSWORD }), error(401, 'invalid_credentials'));
  await assert.rejects(service.recover({ recoveryCode: registered.recoveryCode, password: PASSWORD }), error(401, 'invalid_credentials'));
  assert.deepEqual((await service.login({ username: 'worker_05', password: NEW_PASSWORD })).user, registered.user);
  assert.deepEqual((await service.recover({ recoveryCode: recovered.recoveryCode, password: PASSWORD })).user, registered.user);
});

test('two concurrent recoveries cannot consume the same code twice', async t => {
  const control = controlledKdf();
  const { db, service } = fixture(t, { testKdf: control.kdf });
  const registered = await service.register({ ...AGREEMENT, username: 'worker_06', password: PASSWORD });
  control.block();
  const a = service.recover({ recoveryCode: registered.recoveryCode, password: NEW_PASSWORD });
  const b = service.recover({ recoveryCode: registered.recoveryCode, password: 'third test-only phrase 789' });
  assert.equal(control.pending.length, 2);
  control.pending[0](); control.pending[1]();
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(error(401, 'invalid_credentials')(results.find(result => result.status === 'rejected').reason));
  assert.equal(service.session(registered.sessionToken), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.deepEqual(service.session(winner.sessionToken), registered.user);
});

test('a password login awaiting KDF cannot recreate a session after recovery', async t => {
  const control = controlledKdf();
  const { service } = fixture(t, { testKdf: control.kdf });
  const registered = await service.register({ ...AGREEMENT, username: 'worker_07', password: PASSWORD });
  control.block();
  const login = service.login({ username: 'worker_07', password: PASSWORD });
  const recovery = service.recover({ recoveryCode: registered.recoveryCode, password: NEW_PASSWORD });
  control.pending[1]();
  const recovered = await recovery;
  control.pending[0]();
  await assert.rejects(login, error(401, 'invalid_credentials'));
  assert.deepEqual(service.session(recovered.sessionToken), registered.user);
});

test('the process-wide KDF gate rejects a third calculation and releases slots afterward', async t => {
  const control = controlledKdf();
  const first = fixture(t, { testKdf: control.kdf }).service;
  const second = fixture(t, { testKdf: control.kdf }).service;
  control.block();
  const a = first.register({ ...AGREEMENT, username: 'worker_08', password: PASSWORD });
  const b = second.register({ ...AGREEMENT, username: 'worker_09', password: PASSWORD });
  await assert.rejects(first.login({ username: 'unknown_worker', password: PASSWORD }), error(429, 'auth_busy'));
  assert.equal(control.pending.length, 2);
  control.pending[0](); control.pending[1]();
  await Promise.all([a, b]);
  const login = first.login({ username: 'worker_08', password: PASSWORD });
  assert.equal(control.pending.length, 3);
  control.pending[2]();
  assert.equal((await login).user.username, 'worker_08');
});

test('registration uniqueness is rechecked after concurrent KDF work', async t => {
  const control = controlledKdf();
  const { db, service } = fixture(t, { testKdf: control.kdf });
  control.block();
  const a = service.register({ ...AGREEMENT, username: 'Worker_10', password: PASSWORD });
  const b = service.register({ ...AGREEMENT, username: 'WORKER_10', password: NEW_PASSWORD });
  control.pending[0](); control.pending[1]();
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(error(409, 'username_unavailable')(results.find(result => result.status === 'rejected').reason));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
});

test('account deletion removes auth state, composes with a caller transaction, and keeps other users', async t => {
  const { db, service } = fixture(t);
  const first = await service.register({ ...AGREEMENT, username: 'worker_11', password: PASSWORD });
  const second = await service.register({ ...AGREEMENT, username: 'worker_12', password: PASSWORD });
  db.exec('BEGIN');
  service.deleteAccount(first.user.id);
  assert.equal(service.session(first.sessionToken), null);
  db.exec('ROLLBACK');
  assert.deepEqual(service.session(first.sessionToken), first.user);
  assert.equal(service.rulesStatus(first.user.id).accepted,true);
  service.deleteAccount(first.user.id);
  assert.equal(service.session(first.sessionToken), null);
  assert.deepEqual(service.session(second.sessionToken), second.user);
  await assert.rejects(service.login({ username: 'worker_11', password: PASSWORD }), error(401, 'invalid_credentials'));
  await assert.rejects(service.recover({ recoveryCode: first.recoveryCode, password: NEW_PASSWORD }), error(401, 'invalid_credentials'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_rule_acceptances').get().n,1);
  assert.equal(service.rulesStatus(second.user.id).accepted,true);
});

test('rules document bytes match the pinned digest and returned buffers cannot change the served text',()=>{
  const bytes=rulesDocument();
  assert.equal(createHash('sha256').update(bytes).digest('hex'),RULES.sha256);
  assert.match(bytes.toString(),/pilote est réservé aux essais/);
  bytes[0]^=1;assert.throws(()=>verifyRulesDocument(bytes),/rules_document_hash_mismatch/);
  assert.equal(createHash('sha256').update(rulesDocument()).digest('hex'),RULES.sha256);
});

test('registration requires explicit current rules before KDF and acceptance failure rolls back the account',async t=>{
  let calculations=0;
  const {db,service}=fixture(t,{testKdf:(password,salt)=>{calculations++;return fastKdf(password,salt);}});
  for(const consent of [{},{acceptedRules:false,rulesVersion:RULES.version},{acceptedRules:'true',rulesVersion:RULES.version}]) {
    await assert.rejects(service.register({username:'rules_new',password:PASSWORD,...consent}),error(403,'rules_acceptance_required'));
  }
  await assert.rejects(service.register({username:'rules_new',password:PASSWORD,acceptedRules:true,rulesVersion:'old'}),error(409,'rules_version_changed'));
  assert.equal(calculations,0);
  db.exec("CREATE TRIGGER fail_rules BEFORE INSERT ON auth_rule_acceptances BEGIN SELECT RAISE(ABORT,'synthetic acceptance failure'); END;");
  await assert.rejects(service.register({username:'rules_new',password:PASSWORD,...AGREEMENT}),/synthetic acceptance failure/);
  for(const table of ['auth_users','auth_sessions','auth_rule_acceptances'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  db.exec('DROP TRIGGER fail_rules');
  const result=await service.register({username:'rules_new',password:PASSWORD,...AGREEMENT});
  assert.deepEqual(result.rules,{...RULES,accepted:true});
});

test('legacy accounts are not backfilled and may login or recover before explicitly accepting',async t=>{
  const f=fixture(t),registered=await f.service.register({username:'legacy_rules',password:PASSWORD,...AGREEMENT});
  // Reproduce the old schema, retaining the original credentials and sessions.
  f.db.exec('DROP TABLE auth_rule_acceptances; DROP TABLE auth_rule_versions');
  const service=new AuthService({db:f.db,clock:()=>1_800_000_000_000,testKdf:fastKdf});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_rule_acceptances').get().n,0);
  assert.deepEqual(service.rulesStatus(registered.user.id),{...RULES,accepted:false});
  assert.equal((await service.login({username:'legacy_rules',password:PASSWORD})).rules.accepted,false);
  const recovered=await service.recover({recoveryCode:registered.recoveryCode,password:NEW_PASSWORD});
  assert.equal(recovered.rules.accepted,false);
  const result=service.acceptRules(registered.user.id,AGREEMENT);
  assert.deepEqual(result,{rules:{...RULES,accepted:true}});
  assert.throws(()=>service.acceptRules(registered.user.id,{...AGREEMENT,userId:'other'}),error(400,'invalid_auth_input'));
  assert.throws(()=>service.acceptRules('missing',AGREEMENT),error(401,'login_required'));
});

test('acceptance preserves its first timestamp and new versions require a separate explicit agreement',async t=>{
  const f=fixture(t),registered=await f.service.register({username:'versioned_rules',password:PASSWORD,...AGREEMENT});
  const first=f.db.prepare('SELECT accepted_at FROM auth_rule_acceptances WHERE user_id=?').get(registered.user.id).accepted_at;
  f.advance(1000);f.service.acceptRules(registered.user.id,AGREEMENT);
  assert.equal(f.db.prepare('SELECT accepted_at FROM auth_rule_acceptances WHERE user_id=?').get(registered.user.id).accepted_at,first);
  const next={version:'2026-08-29.1',sha256:'c'.repeat(64),url:'/rules/2026-08-29.1.html'};
  const upgraded=new AuthService({db:f.db,testKdf:fastKdf,testRules:next});
  assert.equal(upgraded.rulesStatus(registered.user.id).accepted,false);
  assert.throws(()=>upgraded.acceptRules(registered.user.id,AGREEMENT),error(409,'rules_version_changed'));
  assert.equal(upgraded.acceptRules(registered.user.id,{acceptedRules:true,rulesVersion:next.version}).rules.accepted,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_rule_acceptances WHERE user_id=?').get(registered.user.id).n,2);
  upgraded.deleteAccount(registered.user.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM auth_rule_acceptances').get().n,0);
  assert.throws(()=>new AuthService({db:f.db,testRules:{...RULES,sha256:'d'.repeat(64)}}),/rules_version_content_conflict/);
  assert.equal(f.db.prepare('SELECT content_sha256 FROM auth_rule_versions WHERE version=?').get(RULES.version).content_sha256,RULES.sha256);
  const nativeContext=process.env.NODE_TEST_CONTEXT;
  try {delete process.env.NODE_TEST_CONTEXT;assert.throws(()=>new AuthService({db:f.db,testRules:next}),/Alternate rules/);}
  finally {if(nativeContext!==undefined)process.env.NODE_TEST_CONTEXT=nativeContext;}
});

test('production scrypt really registers and verifies at N=131072 r=8 p=1 without an override', async t => {
  assert.deepEqual(SCRYPT_CONFIG, { N: 131072, r: 8, p: 1, maxmem: 268435456, keyLength: 64 });
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const service = new AuthService({ db });
  const registered = await service.register({ ...AGREEMENT, username: 'real_kdf_test', password: PASSWORD });
  const login = await service.login({ username: 'REAL_KDF_TEST', password: PASSWORD });
  assert.deepEqual(login.user, registered.user);
  assert.deepEqual(service.session(login.sessionToken), registered.user);
});

test('the validated user cap rejects new registrations before KDF but keeps login and recovery available', async t => {
  let calculations = 0;
  const { db, service } = fixture(t, { maxUsers: 1, testKdf: (password, salt) => { calculations++; return fastKdf(password, salt); } });
  for (const maxUsers of [0, -1, 1.5, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new AuthService({ db, maxUsers }), /maxUsers must be a positive safe integer/);
  }
  const first = await service.register({ ...AGREEMENT, username: 'capacity_worker', password: PASSWORD });
  const before = calculations;
  await assert.rejects(service.register({ ...AGREEMENT, username: 'capacity_other', password: PASSWORD }), error(429, 'user_capacity_reached'));
  assert.equal(calculations, before);
  assert.deepEqual((await service.login({ username: 'capacity_worker', password: PASSWORD })).user, first.user);
  assert.deepEqual((await service.recover({ recoveryCode: first.recoveryCode, password: NEW_PASSWORD })).user, first.user);
  service.deleteAccount(first.user.id);
  assert.equal((await service.register({ ...AGREEMENT, username: 'capacity_other', password: PASSWORD })).user.username, 'capacity_other');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n, 1);
});

test('concurrent registrations recheck the final user slot after their KDF work', async t => {
  const control = controlledKdf();
  const { db, service } = fixture(t, { maxUsers: 1, testKdf: control.kdf });
  control.block();
  const a = service.register({ ...AGREEMENT, username: 'last_slot_a', password: PASSWORD });
  const b = service.register({ ...AGREEMENT, username: 'last_slot_b', password: PASSWORD });
  assert.equal(control.pending.length, 2);
  control.pending[0](); control.pending[1]();
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(error(429, 'user_capacity_reached')(results.find(result => result.status === 'rejected').reason));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_users').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n, 1);
});
