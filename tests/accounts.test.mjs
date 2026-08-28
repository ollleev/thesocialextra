import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUI } from '../public/accounts.js';

const PASSWORD = 'synthetic phrase secret for tests';
const USER = Object.freeze({ id: 'synthetic-account', username: 'synthetic_user' });
const OTHER = Object.freeze({ id: 'other-account', username: 'other_user' });
const RULES=Object.freeze({version:'2026-08-28.1',sha256:'a'.repeat(64),url:'/rules/2026-08-28.1.html',accepted:true});
const session = user => ({ mode: 'production', user, ownership: [], moderator: false,rules:{...RULES,accepted:Boolean(user)} });

// Only the DOM surfaces used by createAccountUI are simulated. Tests import and
// execute the real module and its real requestJSON wrapper; there is no copied
// application logic, browser automation, or HTML/constraint-validation emulator.
class Element {
  constructor(id) {
    this.id = id; this.value = ''; this.hidden = false; this.disabled = false;
    this.checked = false; this.open = false; this.textContent = ''; this.dataset = {};
    this.listeners = new Map(); this.attributes = new Map(); this.classes = new Set();
    this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  async fire(type) {
    const event = { target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    for (const listener of this.listeners.get(type) || []) await listener(event);
    return event;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  close() { this.open = false; for (const listener of this.listeners.get('close') || []) listener({ target: this }); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}

function fixture(t, { onChange } = {}) {
  const ids = ['account', 'account-signed-in', 'account-auth', 'account-recovery', 'account-error', 'account-title', 'account-description',
    'account-username-field', 'account-username', 'account-code-field', 'account-code', 'account-password', 'account-password-label',
    'account-password-help', 'account-submit', 'account-consent', 'account-terms', 'account-form', 'recovery-code', 'delete-password',
    'recovery-saved', 'account-close', 'copy-recovery', 'recovery-copy-status', 'recovery-form', 'logout', 'delete-account-form',
    'delete-account-details', 'delete-confirm', 'cancel-delete-account','account-rules-link','account-rules-version'];
  const nodes = new Map(ids.map(id => [id, new Element(id)]));
  const get = id => { assert.ok(nodes.has(id), `Unexpected DOM lookup: ${id}`); return nodes.get(id); };
  const modes = ['register', 'login', 'recover'].map(mode => { const button = new Element(`mode-${mode}`); button.dataset.authMode = mode; return button; });
  const buttons = [...modes, ...['account-close', 'account-submit', 'copy-recovery', 'logout', 'cancel-delete-account'].map(get), new Element('recovery-submit'), new Element('delete-submit')];
  const dialog = get('account');
  dialog.querySelector = selector => get(selector.slice(1));
  dialog.querySelectorAll = selector => {
    if (selector === '[data-auth-mode]') return modes;
    if (selector === 'button') return buttons;
    assert.fail(`Unexpected DOM collection: ${selector}`);
  };
  get('account-recovery').hidden = true;
  get('account-form').reset = () => {
    for (const id of ['account-username', 'account-code', 'account-password']) get(id).value = '';
    get('account-terms').checked = false;
  };
  get('delete-account-form').reset = () => { get('delete-password').value = ''; get('delete-confirm').checked = false; };
  const descriptors = new Map(['document', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const calls = [], queued = [], waiters = [], unsettled = new Set();
  let failReads = false;
  globalThis.document = { querySelector: selector => { assert.equal(selector, '#account'); return dialog; } };
  globalThis.fetch = (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (failReads && url === '/api/session') return Promise.reject(new TypeError('synthetic read outage'));
    return new Promise((resolve, reject) => {
      let done = false;
      const settle = (fn, value) => { if (done) return; done = true; options.signal.removeEventListener('abort', abort); unsettled.delete(call); fn(value); };
      const abort = () => settle(reject, new Error('synthetic abort'));
      const call = { url, options,
        respond(data, status = 200) { settle(resolve, { status, ok: status >= 200 && status < 300, json: async () => data }); },
        reject(error = new TypeError('synthetic network failure')) { settle(reject, error); } };
      unsettled.add(call); options.signal.addEventListener('abort', abort, { once: true });
      const waiter = waiters.shift(); if (waiter) waiter(call); else queued.push(call);
    });
  };
  const applied = [];
  const ui = createAccountUI({ openDialog: element => { element.open = true; },
    onChange: async next => { applied.push(structuredClone(next)); await onChange?.(next, get); },
    onError: error => error.message });
  async function next(url) {
    const call = queued.length ? queued.shift() : await new Promise(resolve => waiters.push(resolve));
    assert.equal(call.url, url); return call;
  }
  async function initialize(user) { const pending = ui.refresh(); (await next('/api/session')).respond(session(user)); await pending; }
  function fill(mode, continuation) {
    ui.show(mode, continuation);
    get('account-username').value = USER.username;
    get('account-password').value = PASSWORD;
    get('account-code').value = 'a'.repeat(64);
    get('account-terms').checked=mode==='register';
  }
  t.after(() => {
    for (const call of unsettled) call.reject();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  });
  return { ui, get, calls, applied, buttons, modes, next, initialize, fill, failReads: () => { failReads = true; } };
}

test('concurrent session reads resolved in reverse order apply only the newest result', async t => {
  const f = fixture(t);
  const older = f.ui.refresh(), oldRequest = await f.next('/api/session');
  const newer = f.ui.refresh(), newRequest = await f.next('/api/session');
  newRequest.respond(session(OTHER)); await newer;
  oldRequest.respond(session(USER)); await older;
  assert.deepEqual(f.applied.map(next => next.user), [OTHER]);
  assert.deepEqual(f.ui.session.user, OTHER);
});

for (const action of ['logout', 'delete']) test(`${action} confirmation clears identity even when subsequent session reads are unavailable`, async t => {
  const f = fixture(t); await f.initialize(USER); f.ui.show();
  f.get('delete-password').value = PASSWORD; f.get('delete-confirm').checked = true;
  f.failReads();
  const operation = f.get(action === 'logout' ? 'logout' : 'delete-account-form').fire(action === 'logout' ? 'click' : 'submit');
  const request = await f.next(action === 'logout' ? '/api/auth/logout' : '/api/account');
  request.respond(action === 'logout' ? { user: null } : {}, action === 'logout' ? 200 : 204);
  await operation;
  assert.equal(f.ui.session.user, null);
  assert.equal(f.applied.at(-1).user, null);
  assert.equal(f.get('account').open, false);
  assert.equal(f.get('delete-password').value, '');
  await assert.rejects(f.ui.refresh(), /synthetic read outage/);
  assert.equal(f.ui.session.user, null);
  assert.equal(f.applied.at(-1).user, null);
});

for (const mode of ['register', 'recover']) test(`${mode} preserves the one-time code and confirmed identity when its follow-up read fails`, async t => {
  const code = 'b'.repeat(64); let visibleDuringChange = false;
  const f = fixture(t, { onChange(next, get) {
    if (next.user) visibleDuringChange = !get('account-recovery').hidden && get('recovery-code').value === code;
  } });
  await f.initialize(null); let continued = 0; f.fill(mode, () => continued++); f.failReads();
  const operation = f.get('account-form').fire('submit');
  const request = await f.next(`/api/auth/${mode}`);
  assert.deepEqual(JSON.parse(request.options.body), mode === 'register'
    ? { username: USER.username, password: PASSWORD,acceptedRules:true,rulesVersion:RULES.version } : { recoveryCode: 'a'.repeat(64), password: PASSWORD });
  request.respond({ user: USER, recoveryCode: code,rules:RULES }, mode === 'register' ? 201 : 200); await operation;
  assert.equal(visibleDuringChange, true);
  assert.deepEqual(f.ui.session.user, USER);
  assert.equal(f.get('account-recovery').hidden, false);
  assert.deepEqual(f.ui.session.rules,RULES);
  assert.equal(f.get('recovery-code').value, code);
  assert.equal(f.get('account-close').hidden, true);
  assert.equal(f.get('account').open, true);
  assert.equal(f.get('account-password').value, '');
  assert.equal(f.get('account-code').value, '');
  assert.equal((await f.get('account').fire('cancel')).defaultPrevented, true);
  assert.equal(continued, 0);
  // Native form constraint validation is a browser responsibility; the fixture
  // submits only after representing the user's required acknowledgement.
  f.get('recovery-saved').checked = true;
  await f.get('recovery-form').fire('submit');
  assert.equal(f.get('recovery-code').value, '');
  assert.equal(f.get('account').open, false);
  assert.equal(continued, 1);
});

test('a session read begun before a successful login cannot overwrite the confirmed identity', async t => {
  const f = fixture(t); await f.initialize(null);
  const old = f.ui.refresh(), oldRequest = await f.next('/api/session');
  f.fill('login');
  const login = f.get('account-form').fire('submit');
  (await f.next('/api/auth/login')).respond({ user: USER });
  (await f.next('/api/session')).respond(session(USER)); await login;
  oldRequest.respond(session(OTHER)); await old;
  assert.deepEqual(f.ui.session.user, USER);
  assert.ok(f.applied.every(next => next.user?.id !== OTHER.id));
});

for (const action of ['login', 'delete']) test(`a late session read does not apply while ${action} is still busy`, async t => {
  const f = fixture(t); await f.initialize(action === 'login' ? null : USER);
  const old = f.ui.refresh(), oldRequest = await f.next('/api/session');
  if (action === 'login') f.fill('login'); else { f.ui.show(); f.get('delete-password').value = PASSWORD; f.get('delete-confirm').checked = true; }
  const target = f.get(action === 'login' ? 'account-form' : 'delete-account-form');
  const operation = target.fire('submit');
  const request = await f.next(action === 'login' ? '/api/auth/login' : '/api/account');
  assert.ok(f.buttons.every(button => button.disabled));
  const appliedBefore = f.applied.length;
  oldRequest.respond(session(OTHER)); await old;
  const during = f.applied.slice(appliedBefore);
  // Finish the outstanding operation before asserting, so a failed regression
  // never leaves the real request timeout running in the test process.
  if (action === 'login') { request.respond({ user: USER }); (await f.next('/api/session')).respond(session(USER)); }
  else request.respond({}, 204);
  await operation;
  assert.deepEqual(during, []);
  assert.deepEqual(f.ui.session.user, action === 'login' ? USER : null);
  assert.ok(f.buttons.every(button => !button.disabled));
});

test('anonymous deletion access opens login, never registration, and never sends a deletion',async t=>{
  const f=fixture(t);await f.initialize(null);f.ui.showDeletion();
  assert.equal(f.get('account').open,true);assert.equal(f.get('account-submit').textContent,'Se connecter');
  assert.equal(f.get('account-username').focused,true);assert.equal(f.get('account-signed-in').hidden,true);
  assert.equal(f.modes.find(button=>button.dataset.authMode==='register').hidden,true);
  f.get('delete-password').value=PASSWORD;f.get('delete-confirm').checked=true;
  await f.get('delete-account-form').fire('submit');
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  f.get('account').close();assert.equal(f.get('delete-confirm').checked,false);
  f.ui.show('register');assert.equal(f.get('account-submit').textContent,'Créer mon compte gratuit');
  assert.equal(f.modes.find(button=>button.dataset.authMode==='register').hidden,false);
});

for(const readFails of [false,true])test(`login continues to explicit deletion even when the follow-up read ${readFails?'fails':'succeeds'}`,async t=>{
  const f=fixture(t);await f.initialize(null);f.ui.showDeletion();if(readFails)f.failReads();
  f.get('account-username').value=USER.username;f.get('account-password').value=PASSWORD;
  const operation=f.get('account-form').fire('submit');
  (await f.next('/api/auth/login')).respond({user:USER});
  if(!readFails)(await f.next('/api/session')).respond(session(USER));
  await operation;
  assert.equal(f.get('account').open,true);assert.equal(f.get('account-auth').hidden,true);
  assert.equal(f.get('delete-account-details').open,true);assert.equal(f.get('delete-password').focused,true);
  assert.equal(f.get('delete-password').value,'');assert.equal(f.get('delete-confirm').checked,false);
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  // A queued native close event from the login dialog must not erase the
  // newly opened deletion form or its explicit input.
  f.get('delete-password').value=PASSWORD;await f.get('account').fire('close');
  assert.equal(f.get('delete-password').value,PASSWORD);
});

test('recovery preserves the new one-time code before continuing to the deletion form',async t=>{
  const f=fixture(t);await f.initialize(null);f.ui.showDeletion();
  await f.modes.find(button=>button.dataset.authMode==='recover').fire('click');
  f.get('account-code').value='a'.repeat(64);f.get('account-password').value=PASSWORD;
  const operation=f.get('account-form').fire('submit');
  (await f.next('/api/auth/recover')).respond({user:USER,recoveryCode:'b'.repeat(64)});
  (await f.next('/api/session')).respond(session(USER));await operation;
  assert.equal(f.get('account-recovery').hidden,false);assert.equal(f.get('delete-account-details').open,false);
  assert.equal(f.get('recovery-code').value,'b'.repeat(64));assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  f.get('recovery-saved').checked=true;await f.get('recovery-form').fire('submit');
  assert.equal(f.get('recovery-code').value,'');assert.equal(f.get('delete-account-details').open,true);
  assert.equal(f.get('delete-password').focused,true);assert.equal(f.get('delete-password').value,'');
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
});

test('cancelling deletion clears confirmation; only a new explicit password and confirmation can delete',async t=>{
  const f=fixture(t);await f.initialize(USER);f.ui.showDeletion();
  f.get('delete-password').value=PASSWORD;f.get('delete-confirm').checked=true;
  await f.get('cancel-delete-account').fire('click');
  assert.equal(f.get('account').open,false);assert.equal(f.get('delete-password').value,'');assert.equal(f.get('delete-confirm').checked,false);
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  f.ui.showDeletion();await f.get('delete-account-form').fire('submit');
  f.get('delete-password').value=PASSWORD;await f.get('delete-account-form').fire('submit');
  assert.equal(f.calls.some(call=>call.method==='DELETE'),false);
  f.get('delete-confirm').checked=true;const operation=f.get('delete-account-form').fire('submit');
  const request=await f.next('/api/account');assert.equal(request.options.method,'DELETE');assert.deepEqual(JSON.parse(request.options.body),{password:PASSWORD});
  request.respond({},204);await operation;
  assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);assert.equal(f.ui.session.user,null);
});

test('registration requires explicit agreement and a changed version unchecks it without discarding the form',async t=>{
  const f=fixture(t);await f.initialize(null);f.fill('register');f.get('account-terms').checked=false;
  const before=f.calls.length;await f.get('account-form').fire('submit');assert.equal(f.calls.length,before);
  f.get('account-terms').checked=true;
  const read=f.ui.refresh();const updated={...RULES,version:'2026-08-29.1',url:'/rules/2026-08-29.1.html',accepted:false};
  (await f.next('/api/session')).respond({...session(null),rules:updated});await read;
  assert.equal(f.get('account-terms').checked,false);assert.equal(f.get('account-password').value,PASSWORD);
  assert.equal(f.get('account-rules-link').attributes.get('href'),updated.url);
  f.get('account-terms').checked=true;const operation=f.get('account-form').fire('submit');
  const request=await f.next('/api/auth/register');assert.equal(JSON.parse(request.options.body).rulesVersion,updated.version);
  request.respond({error:'rules_version_changed'},409);
  const latest={...updated,version:'2026-08-30.1',url:'/rules/2026-08-30.1.html'};
  (await f.next('/api/session')).respond({...session(null),rules:latest});await operation;
  assert.equal(f.get('account-terms').checked,false);assert.equal(f.get('account-password').value,PASSWORD);
  assert.equal(f.get('account-username').value,USER.username);assert.equal(f.ui.session.user,null);
});

test('acceptance updates only rules and invalidates an older pending session read',async t=>{
  const f=fixture(t);const initial=f.ui.refresh();const original={...session(USER),ownership:['synthetic-post'],features:{voice:true},moderator:true};
  (await f.next('/api/session')).respond(original);await initial;
  const old=f.ui.refresh(),request=await f.next('/api/session');
  const accepted={...RULES,version:'2026-08-29.1',url:'/rules/2026-08-29.1.html'};f.ui.updateRules(accepted);
  request.respond({...original,rules:{...RULES,accepted:false}});await old;
  assert.deepEqual(f.ui.session,{...original,rules:accepted});
});

test('mode transitions recompute submit disabled from busy and rules availability', async t => {
  const f = fixture(t); await f.initialize(null);
  f.ui.show('register');
  assert.equal(f.get('account-submit').disabled, false);
  const read = f.ui.refresh();
  (await f.next('/api/session')).respond({ mode: 'production', user: null, ownership: [], moderator: false });
  await read;
  assert.equal(f.get('account-submit').disabled, true);
  await f.modes.find(button => button.dataset.authMode === 'login').fire('click');
  assert.equal(f.get('account-submit').disabled, false);
  await f.modes.find(button => button.dataset.authMode === 'recover').fire('click');
  assert.equal(f.get('account-submit').disabled, false);
  await f.modes.find(button => button.dataset.authMode === 'register').fire('click');
  assert.equal(f.get('account-submit').disabled, true);
});

test('logout clears identity immediately and retains valid public rules metadata with accepted false', async t => {
  const f = fixture(t); await f.initialize(USER); f.ui.show();
  f.failReads();
  const logout = f.get('logout').fire('click');
  (await f.next('/api/auth/logout')).respond({ user: null });
  await logout;
  assert.equal(f.ui.session.user, null);
  assert.deepEqual(f.ui.session, { mode: 'production', user: null, ownership: [], moderator: false, rules: { ...RULES, accepted: false } });
  f.ui.show('register');
  assert.equal(f.get('account-submit').disabled, false);
  assert.equal(f.get('account-terms').disabled, false);
  assert.equal(f.get('account-rules-link').hidden, false);
  assert.equal(f.get('account-terms').checked, false);
});

test('deletion clears identity immediately and retains valid public rules metadata with accepted false', async t => {
  const f = fixture(t); await f.initialize(USER); f.ui.show();
  f.get('delete-password').value = PASSWORD; f.get('delete-confirm').checked = true;
  f.failReads();
  const deletion = f.get('delete-account-form').fire('submit');
  (await f.next('/api/account')).respond({}, 204);
  await deletion;
  assert.equal(f.ui.session.user, null);
  assert.deepEqual(f.ui.session, { mode: 'production', user: null, ownership: [], moderator: false, rules: { ...RULES, accepted: false } });
  f.ui.show('register');
  assert.equal(f.get('account-submit').disabled, false);
  assert.equal(f.get('account-terms').checked, false);
});

test('new login missing rules exercises actual auth submit with failed follow-up read and asserts session rules null', async t => {
  const f = fixture(t); await f.initialize(null);
  f.fill('login');
  f.failReads();
  const operation = f.get('account-form').fire('submit');
  (await f.next('/api/auth/login')).respond({ user: USER });
  await operation;
  assert.deepEqual(f.ui.session.user, USER);
  assert.equal(f.ui.session.rules, null);
});

test('logout drops enriched account state and a late read cannot restore it', async t => {
  const f = fixture(t), enriched = { ...session(USER), ownership: ['synthetic-owned-post'], moderator: true,
    features: { voice: true, presentation: true }, privateSelection: { id: 'synthetic-selection' } };
  const initial = f.ui.refresh(); (await f.next('/api/session')).respond(enriched); await initial;
  const older = f.ui.refresh(), stale = await f.next('/api/session');
  f.ui.show(); const logout = f.get('logout').fire('click');
  (await f.next('/api/auth/logout')).respond({ user: null }); await logout;
  const anonymous = { mode: 'production', user: null, ownership: [], moderator: false, rules: { ...RULES, accepted: false } };
  assert.deepEqual(f.ui.session, anonymous);
  assert.deepEqual(f.applied.at(-1), anonymous);
  assert.ok(f.buttons.every(button => button.disabled === false), 'all dialog buttons unlock after confirmed logout');
  stale.respond(enriched); await older;
  assert.deepEqual(f.ui.session, anonymous);
  assert.deepEqual(f.applied.at(-1), anonymous);
  f.ui.show('register');
  assert.equal(f.get('account-terms').checked, false);
  const before = f.calls.length;
  await f.get('account-form').fire('submit');
  assert.equal(f.calls.length, before, 'public metadata never substitutes for explicit agreement');
});

test('logout discards malformed rule metadata and registration remains closed', async t => {
  const cases = [
    ['external URL', { ...RULES, url: 'https://example.invalid/rules' }],
    ['invalid digest', { ...RULES, sha256: 'invalid' }],
    ['invalid version', { ...RULES, version: '../invalid' }],
    ['missing metadata', undefined],
  ];
  for (const [name, rules] of cases) await t.test(name, async t => {
    const f = fixture(t), initial = f.ui.refresh();
    (await f.next('/api/session')).respond({ ...session(USER), rules }); await initial;
    f.ui.show(); const logout = f.get('logout').fire('click');
    (await f.next('/api/auth/logout')).respond({ user: null }); await logout;
    assert.equal(f.ui.session.rules, null);
    f.ui.show('register');
    assert.equal(f.get('account-submit').disabled, true);
    assert.equal(f.get('account-terms').disabled, true);
    assert.equal(f.get('account-rules-link').hidden, true);
    assert.equal(f.get('account-rules-link').attributes.has('href'), false);
    f.get('account-terms').checked = true;
    const before = f.calls.length; await f.get('account-form').fire('submit');
    assert.equal(f.calls.length, before);
  });
});

test('busy auth stays locked through rule updates and duplicate actions, then recomputes the mode gate', async t => {
  const f = fixture(t); await f.initialize(null); f.fill('login');
  const operation = f.get('account-form').fire('submit'), request = await f.next('/api/auth/login');
  f.ui.updateRules(null);
  assert.ok(f.buttons.every(button => button.disabled));
  await f.modes.find(button => button.dataset.authMode === 'register').fire('click');
  await f.get('account-form').fire('submit');
  await f.get('logout').fire('click');
  assert.equal(f.get('account-submit').textContent, 'Se connecter');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  request.respond({ error: 'invalid_credentials' }, 401); await operation;
  assert.equal(f.get('account-submit').disabled, false);
  assert.ok(f.buttons.every(button => button.disabled === false), 'all dialog buttons unlock after a failed login');
  await f.modes.find(button => button.dataset.authMode === 'register').fire('click');
  assert.equal(f.get('account-submit').disabled, true);
  await f.modes.find(button => button.dataset.authMode === 'recover').fire('click');
  assert.equal(f.get('account-submit').disabled, false);
});
