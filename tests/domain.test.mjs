import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveStore, ApiError, ZONES, ROLES } from '../domain.mjs';
import { searchLocations, nearestLocation, getLocation, LocationError } from '../locations.mjs';

const input = (overrides = {}) => ({ kind: 'need', role: 'Serveur', zoneId: 'bastille', english: true, vehicle: false, durationMinutes: 30, places: 2, pay: 18, note: 'Renfort en salle.', ...overrides });
const error = (status, code) => e => e instanceof ApiError && e.status === status && e.code === code;
const fixture = (options = {}) => {
  let now = 1_800_000_000_000;
  const store = new LiveStore({ seed: false, clock: () => now, ...options });
  return { store, advance: ms => { now += ms; } };
};

test('six synthetic posts expose only approximate known zones', () => {
  const store = new LiveStore();
  const { posts, mode } = store.state();
  assert.equal(mode, 'local-demo');
  assert.equal(posts.length, 6);
  assert.ok(posts.every(p => p.demo && ZONES.some(z => z.id === p.zoneId && z.lat === p.lat && z.lng === p.lng)));
  assert.equal(posts.filter(p => p.kind === 'need').length, 3);
  assert.ok(posts.some(p => p.role === 'Barman' && p.kind === 'available' && p.english && p.vehicle));
});

test('public snapshot and emitted changes never contain owner tokens or private messages', () => {
  const { store } = fixture();
  const emitted = [];
  const unsubscribe = store.subscribe(state => emitted.push(state));
  const { post, ownerToken } = store.create(input());
  const { guestToken } = store.contact(post.id, { message: 'Message uniquement privé.' });
  assert.equal(post.demo, false);
  assert.equal(post.status, 'open');
  for (const snapshot of [store.state(), ...emitted]) {
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(ownerToken));
    assert.ok(!serialized.includes(guestToken));
    assert.ok(!serialized.includes('Message uniquement privé.'));
    assert.ok(!serialized.includes('ownerToken'));
  }
  unsubscribe();
  store.mutate(post.id, ownerToken, { action: 'fill' });
  assert.equal(emitted.length, 1);
});

test('expired posts and their conversations disappear at the exact deadline', () => {
  const { store, advance } = fixture();
  const { post, ownerToken } = store.create(input());
  const { threadId, guestToken } = store.contact(post.id, { message: 'Encore disponible ?' });
  advance(30 * 60_000 - 1);
  assert.equal(store.state().posts.length, 1);
  advance(1);
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'fill' }), error(404, 'post_not_found'));
  assert.equal(store.state().posts.length, 0);
  assert.throws(() => store.readThread(threadId, guestToken), error(404, 'thread_not_found'));
  assert.equal(store.threads.size, 0);
});

test('sweep emits one state event on expiry, without repeated empty events', () => {
  const { store, advance } = fixture();
  store.create(input());
  const events = [];
  store.subscribe(state => events.push(state));
  advance(30 * 60_000);
  assert.equal(store.sweep(), true);
  assert.equal(store.sweep(), false);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].posts, []);
});

test('owner is required and concurrent fills cannot oversubscribe a mission', async () => {
  const { store } = fixture();
  const { post, ownerToken } = store.create(input({ places: 1 }));
  assert.throws(() => store.mutate(post.id, undefined, { action: 'fill' }), error(403, 'owner_required'));
  assert.throws(() => store.remove(post.id, 'incorrect'), error(403, 'owner_required'));
  const fills = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => store.mutate(post.id, ownerToken, { action: 'fill' }))));
  assert.equal(fills.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(fills.filter(result => result.status === 'rejected').every(result => result.reason.code === 'post_already_full'));
  const final = store.state().posts[0];
  assert.equal(final.places, 0);
  assert.equal(final.totalPlaces, 1);
  assert.equal(final.status, 'full');
  assert.throws(() => store.contact(post.id, { message: 'Une place ?' }), error(409, 'post_already_full'));
});

test('close marks the publication full, delete removes it and its private threads', () => {
  const { store } = fixture();
  const { post, ownerToken } = store.create(input({ kind: 'available' }));
  const chat = store.contact(post.id, { message: 'Disponible ?' });
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'fill' }), error(400, 'fill_requires_need'));
  assert.equal(store.mutate(post.id, ownerToken, { action: 'close' }).post.status, 'full');
  // Existing contacts may finish their exchange after the place is filled.
  store.addMessage(chat.threadId, ownerToken, { message: 'La place est prise.' });
  store.remove(post.id, ownerToken);
  assert.equal(store.state().posts.length, 0);
  assert.throws(() => store.readThread(chat.threadId, chat.guestToken), error(404, 'thread_not_found'));
});

test('an idempotent fill retry cannot consume another place, even after a complete fill', () => {
  const { store, advance } = fixture();
  const { post, ownerToken } = store.create(input());
  const key = 'fill-intention-one-1234';
  assert.equal(store.mutate(post.id, ownerToken, { action: 'fill' }, key).post.places, 1);
  assert.equal(store.mutate(post.id, ownerToken, { action: 'fill' }, key).post.places, 1);
  assert.throws(() => store.mutate(post.id, 'wrong-owner', { action: 'fill' }, key), error(403, 'owner_required'));
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'close' }, key), error(409, 'idempotency_conflict'));
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'fill' }, 'short'), error(400, 'invalid_idempotency_key'));
  assert.equal(store.mutate(post.id, ownerToken, { action: 'fill' }, 'fill-intention-two-5678').post.places, 0);
  assert.equal(store.mutate(post.id, ownerToken, { action: 'fill' }, key).post.status, 'full');
  assert.ok(!JSON.stringify(store.state()).includes(key));
  advance(30 * 60_000);
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'fill' }, key), error(404, 'post_not_found'));
});

test('reopen restores one place or an availability without extending expiry', () => {
  const { store, advance } = fixture();
  const need = store.create(input());
  assert.equal(need.post.revision, 0);
  assert.throws(() => store.mutate(need.post.id, need.ownerToken, { action: 'reopen' }), error(409, 'no_place_to_reopen'));
  store.mutate(need.post.id, need.ownerToken, { action: 'close' });
  advance(1000);
  assert.throws(() => store.mutate(need.post.id, 'wrong-owner', { action: 'reopen' }), error(403, 'owner_required'));
  const reopened = store.mutate(need.post.id, need.ownerToken, { action: 'reopen' }).post;
  assert.equal(reopened.places, 1);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.totalPlaces, 2);
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.expiresAt, need.post.expiresAt);
  assert.equal(store.mutate(need.post.id, need.ownerToken, { action: 'reopen' }).post.places, 2);
  assert.throws(() => store.mutate(need.post.id, need.ownerToken, { action: 'reopen' }), error(409, 'no_place_to_reopen'));
  const available = store.create(input({ kind: 'available' }));
  store.mutate(available.post.id, available.ownerToken, { action: 'close' });
  const restored = store.mutate(available.post.id, available.ownerToken, { action: 'reopen' }).post;
  assert.equal(restored.places, 1);
  assert.equal(restored.status, 'open');
  assert.equal(restored.expiresAt, available.post.expiresAt);
  assert.throws(() => store.mutate(available.post.id, available.ownerToken, { action: 'reopen' }), error(409, 'no_place_to_reopen'));
  advance(30 * 60_000);
  assert.throws(() => store.mutate(need.post.id, need.ownerToken, { action: 'reopen' }), error(404, 'post_not_found'));
});

test('concurrent reopens stay within original capacity and revisions order same-millisecond changes', async () => {
  const { store } = fixture();
  const { post, ownerToken } = store.create(input());
  const revisions = [];
  store.subscribe(state => revisions.push(state.posts[0].revision));
  const closed = store.mutate(post.id, ownerToken, { action: 'close' }).post;
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => store.mutate(post.id, ownerToken, { action: 'reopen' }))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 2);
  assert.ok(attempts.filter(result => result.status === 'rejected').every(result => result.reason.code === 'no_place_to_reopen'));
  const current = store.state().posts[0];
  assert.equal(current.places, 2);
  assert.equal(current.updatedAt, closed.updatedAt);
  assert.equal(current.revision, 3);
  assert.deepEqual(revisions, [1, 2, 3]);
});

test('old idempotency keys never replay after fill/reopen cycles and the cache cannot evict them', () => {
  const { store } = fixture();
  const { post, ownerToken } = store.create(input({ places: 1 }));
  const keys = Array.from({ length: 128 }, (_, i) => `cycle-intention-${String(i).padStart(4, '0')}`);
  for (let i = 0; i < keys.length; i++) store.mutate(post.id, ownerToken, { action: i % 2 ? 'reopen' : 'fill' }, keys[i]);
  const current = store.state().posts[0];
  assert.equal(current.places, 1);
  assert.equal(current.revision, 128);
  assert.equal(current.expiresAt, post.expiresAt);
  const replay = store.mutate(post.id, ownerToken, { action: 'fill' }, keys[0]).post;
  assert.equal(replay.places, 1);
  assert.equal(replay.revision, 128);
  assert.equal(store.mutate(post.id, ownerToken, { action: 'reopen' }, keys[1]).post.revision, 128);
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'close' }, keys[0]), error(409, 'idempotency_conflict'));
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'fill' }, 'new-intention-over-capacity'), error(429, 'idempotency_capacity_reached'));
  assert.throws(() => store.mutate(post.id, ownerToken, { action: 'fill' }), error(429, 'idempotency_capacity_reached'));
  assert.equal(store.posts.get(post.id).completedActions.size, 128);
  assert.ok(store.posts.get(post.id).completedActions.has(keys[0]));
  assert.ok(!JSON.stringify(store.state()).includes(keys[0]));
});

test('demo contacts explicitly fail rather than simulating a sent message', () => {
  const store = new LiveStore();
  const id = store.state().posts[0].id;
  assert.throws(() => store.contact(id, { message: 'Test' }), error(409, 'demo_contact_unavailable'));
  assert.equal(store.threads.size, 0);
});

test('private threads isolate guests, owners, and messages', () => {
  const { store } = fixture();
  const first = store.create(input());
  const second = store.create(input());
  const a = store.contact(first.post.id, { message: 'Disponible pour cette mission.' });
  const b = store.contact(first.post.id, { message: 'À quelle heure ?' });
  assert.throws(() => store.readThread(a.threadId, b.guestToken), error(403, 'thread_access_denied'));
  assert.throws(() => store.readThread(a.threadId, second.ownerToken), error(403, 'thread_access_denied'));
  assert.throws(() => store.inbox(first.post.id, a.guestToken), error(403, 'owner_required'));
  assert.throws(() => store.addMessage(a.threadId, b.guestToken, { message: 'Intrusion' }), error(403, 'thread_access_denied'));
  store.addMessage(a.threadId, first.ownerToken, { message: 'Début du service à 19 h.' });
  const thread = store.readThread(a.threadId, a.guestToken).thread;
  assert.equal(thread.messages.length, 2);
  assert.deepEqual(thread.messages.map(m => m.sender), ['guest', 'owner']);
  assert.equal(store.readThread(b.threadId, b.guestToken).thread.messages.length, 1);
  assert.equal(store.inbox(first.post.id, first.ownerToken).threads.length, 2);
  assert.ok(!JSON.stringify(thread).includes(a.guestToken));
  assert.ok(!JSON.stringify(store.inbox(first.post.id, first.ownerToken)).includes(b.guestToken));
  // Callers cannot mutate stored messages through a returned object.
  thread.messages[0].text = 'Changed';
  assert.notEqual(store.readThread(a.threadId, a.guestToken).thread.messages[0].text, 'Changed');
});

test('message retries return the original message without duplicating it or its incoming count', () => {
  const { store, advance } = fixture();
  const { post, ownerToken } = store.create(input());
  const chat = store.contact(post.id, { message: 'Premier contact.' });
  const key = 'message-intention-123456';
  const events = [];
  store.subscribe(state => events.push(state));
  const original = store.addMessage(chat.threadId, chat.guestToken, { message: 'Je suis disponible.' }, key);
  const timestamp = original.message.createdAt;
  advance(1000);
  const retry = store.addMessage(chat.threadId, chat.guestToken, { message: 'Je suis disponible.' }, key);
  assert.deepEqual(retry, original);
  assert.equal(store.readThread(chat.threadId, ownerToken).thread.messages.length, 2);
  assert.equal(store.readThread(chat.threadId, ownerToken).thread.incomingCount, 2);
  assert.equal(store.readThread(chat.threadId, ownerToken).thread.updatedAt, timestamp);
  retry.message.text = 'Mutation externe';
  assert.equal(store.addMessage(chat.threadId, chat.guestToken, { message: 'Je suis disponible.' }, key).message.text, 'Je suis disponible.');
  assert.throws(() => store.addMessage(chat.threadId, chat.guestToken, { message: 'Autre intention.' }, key), error(409, 'idempotency_conflict'));
  assert.equal(events.length, 0);
  for (const value of [store.state(), store.readThread(chat.threadId, ownerToken), store.readThread(chat.threadId, chat.guestToken), store.updates({ access: [{ kind: 'thread', id: chat.threadId, token: ownerToken }] })]) {
    assert.ok(!JSON.stringify(value).includes(key));
    assert.ok(!JSON.stringify(value).includes('completedMessages'));
  }
});

test('message idempotency is scoped by thread and authenticated side, never by an untrusted sender field', () => {
  const { store } = fixture();
  const first = store.create(input());
  const other = store.create(input());
  const chat = store.contact(first.post.id, { message: 'Contact.' });
  const secondChat = store.contact(first.post.id, { message: 'Autre contact.' });
  const key = 'shared-message-intention';
  const guest = store.addMessage(chat.threadId, chat.guestToken, { message: 'Texte visiteur.' }, key).message;
  assert.throws(() => store.addMessage(chat.threadId, other.ownerToken, { message: guest.text }, key), error(403, 'thread_access_denied'));
  assert.throws(() => store.addMessage(chat.threadId, secondChat.guestToken, { message: guest.text }, key), error(403, 'thread_access_denied'));
  const owner = store.addMessage(chat.threadId, first.ownerToken, { message: 'Texte propriétaire.' }, key).message;
  assert.notEqual(owner.id, guest.id);
  assert.equal(owner.sender, 'owner');
  assert.equal(store.addMessage(chat.threadId, chat.guestToken, { message: guest.text }, key).message.id, guest.id);
  assert.equal(store.addMessage(chat.threadId, first.ownerToken, { message: owner.text }, key).message.id, owner.id);
  const otherThread = store.addMessage(secondChat.threadId, first.ownerToken, { message: 'Texte du second échange.' }, key).message;
  assert.notEqual(otherThread.id, owner.id);
  assert.throws(() => store.addMessage(chat.threadId, chat.guestToken, { message: owner.text, sender: 'owner' }, key), e => e instanceof ApiError && e.status === 400);
  assert.equal(store.readThread(chat.threadId, first.ownerToken).thread.messages.length, 3);
});

test('accepted message retries work at the 100-message quota without cache eviction, but not after expiry', () => {
  const { store, advance } = fixture();
  const { post, ownerToken } = store.create(input());
  const chat = store.contact(post.id, { message: 'Contact initial.' });
  let original;
  for (let i = 0; i < 99; i++) {
    const result = store.addMessage(chat.threadId, ownerToken, { message: `Réponse ${i}.` }, `message-quota-intention-${i}`);
    if (i === 0) original = result;
  }
  assert.equal(store.readThread(chat.threadId, ownerToken).thread.messages.length, 100);
  assert.equal(store.threads.get(chat.threadId).completedMessages.size, 99);
  assert.deepEqual(store.addMessage(chat.threadId, ownerToken, { message: 'Réponse 0.' }, 'message-quota-intention-0'), original);
  assert.throws(() => store.addMessage(chat.threadId, ownerToken, { message: 'Nouveau.' }, 'message-quota-intention-100'), error(429, 'message_capacity_reached'));
  assert.throws(() => store.addMessage(chat.threadId, ownerToken, { message: 'Texte changé.' }, 'message-quota-intention-0'), error(409, 'idempotency_conflict'));
  // The other side must not receive the owner's cached reply with the same key.
  assert.throws(() => store.addMessage(chat.threadId, chat.guestToken, { message: 'Réponse 0.' }, 'message-quota-intention-0'), error(429, 'message_capacity_reached'));
  assert.throws(() => store.addMessage(chat.threadId, 'wrong-token', { message: 'Réponse 0.' }, 'message-quota-intention-0'), error(403, 'thread_access_denied'));
  advance(30 * 60_000);
  assert.throws(() => store.addMessage(chat.threadId, ownerToken, { message: 'Réponse 0.' }, 'message-quota-intention-0'), error(404, 'thread_not_found'));
  assert.equal(store.threads.size, 0);
});

test('message key validation preserves keyless compatibility and never reserves invalid intents', () => {
  const { store } = fixture();
  const { post, ownerToken } = store.create(input());
  const chat = store.contact(post.id, { message: 'Contact.' });
  for (const key of [null, '', 'short', 'x'.repeat(129), 'spaces are invalid', 'é'.repeat(16), 12]) {
    assert.throws(() => store.addMessage(chat.threadId, ownerToken, { message: 'Réponse.' }, key), error(400, 'invalid_idempotency_key'));
  }
  assert.equal(store.readThread(chat.threadId, ownerToken).thread.messages.length, 1);
  const first = store.addMessage(chat.threadId, ownerToken, { message: 'Réponse.' }).message;
  const second = store.addMessage(chat.threadId, ownerToken, { message: 'Réponse.' }).message;
  assert.notEqual(first.id, second.id);
  assert.equal(store.threads.get(chat.threadId).completedMessages, undefined);
});

test('private update batches enforce capability scope, deduplicate threads and expose no message text', () => {
  const { store } = fixture();
  const first = store.create(input());
  const other = store.create(input());
  const a = store.contact(first.post.id, { message: 'Premier contenu privé.' });
  const b = store.contact(first.post.id, { message: 'Second contenu privé.' });
  const ownerAccess = { kind: 'post', id: first.post.id, token: first.ownerToken };
  const guestAccess = { kind: 'thread', id: a.threadId, token: a.guestToken };
  const guestOnly = store.updates({ access: [guestAccess] });
  assert.equal(guestOnly.threads.length, 1);
  assert.equal(guestOnly.threads[0].side, 'guest');
  assert.equal(guestOnly.threads[0].incomingCount, 0);
  assert.equal(guestOnly.threads[0].lastIncomingId, null);
  const combined = store.updates({ access: [guestAccess, ownerAccess, { kind: 'thread', id: a.threadId, token: first.ownerToken }, ownerAccess] });
  assert.equal(combined.threads.length, 2);
  assert.ok(combined.threads.every(thread => thread.side === 'owner' && thread.incomingCount === 1));
  assert.deepEqual(combined.unavailable, []);
  for (const value of [first.ownerToken, a.guestToken, b.guestToken, 'Premier contenu privé.', 'Second contenu privé.']) assert.ok(!JSON.stringify(combined).includes(value));
  const rejected = [
    { kind: 'post', id: first.post.id, token: a.guestToken },
    { kind: 'post', id: other.post.id, token: first.ownerToken },
    { kind: 'thread', id: b.threadId, token: a.guestToken },
    { kind: 'thread', id: a.threadId, token: other.ownerToken },
    { kind: 'thread', id: 'absent-thread', token: a.guestToken },
  ];
  const denied = store.updates({ access: rejected });
  assert.deepEqual(denied.threads, []);
  assert.deepEqual(denied.unavailable, rejected.map(({ kind, id }) => ({ kind, id })));
  const duplicate = store.updates({ access: [{ ...guestAccess, token: '' }, guestAccess] });
  assert.deepEqual(duplicate.unavailable, []);
  assert.equal(duplicate.threads.length, 1);
});

test('incoming counters and IDs distinguish same-millisecond messages without server-side read state', () => {
  const { store, advance } = fixture();
  const { post, ownerToken } = store.create(input());
  const chat = store.contact(post.id, { message: 'Disponible.' });
  const ownerAccess = { kind: 'post', id: post.id, token: ownerToken };
  const guestAccess = { kind: 'thread', id: chat.threadId, token: chat.guestToken };
  const first = store.updates({ access: [ownerAccess] }).threads[0];
  const secondMessage = store.addMessage(chat.threadId, chat.guestToken, { message: 'Je peux venir.' }).message;
  store.addMessage(chat.threadId, ownerToken, { message: 'Merci.' });
  const ownerSnapshot = store.readThread(chat.threadId, ownerToken).thread;
  assert.equal(ownerSnapshot.side, 'owner');
  assert.equal(ownerSnapshot.incomingCount, 2);
  assert.equal(ownerSnapshot.lastIncomingId, secondMessage.id);
  const second = store.updates({ access: [ownerAccess] }).threads[0];
  assert.equal(second.updatedAt, first.updatedAt);
  assert.equal(second.incomingCount, 2);
  assert.notEqual(second.lastIncomingId, first.lastIncomingId);
  assert.equal(second.messageCount, 3);
  const guest = store.updates({ access: [guestAccess] }).threads[0];
  assert.equal(guest.incomingCount, 1);
  assert.equal(store.readThread(chat.threadId, chat.guestToken).thread.incomingCount, 1);
  store.addMessage(chat.threadId, chat.guestToken, { message: 'À tout de suite.' });
  assert.equal(ownerSnapshot.incomingCount, 2);
  assert.equal(ownerSnapshot.messages.length, 3);
  assert.equal(store.updates({ access: [ownerAccess] }).threads[0].incomingCount, 3);
  assert.deepEqual(store.updates({ access: [ownerAccess] }), store.updates({ access: [ownerAccess] }));
  advance(30 * 60_000);
  assert.deepEqual(store.updates({ access: [ownerAccess, guestAccess] }), { threads: [], unavailable: [{ kind: 'post', id: post.id }, { kind: 'thread', id: chat.threadId }] });
});

test('update batch shape, capabilities and length are strictly bounded', () => {
  const { store } = fixture();
  const capability = { kind: 'post', id: 'missing', token: 'wrong-token' };
  const invalid = [null, [], {}, { access: null }, { access: {} }, { access: Array(33).fill(capability) },
    { access: [null] }, { access: [{ ...capability, kind: 'admin' }] }, { access: [{ ...capability, id: {} }] },
    { access: [{ ...capability, id: 'x'.repeat(81) }] }, { access: [{ ...capability, token: 'x'.repeat(129) }] },
    { access: [{ ...capability, token: null }] }, { access: [{ kind: 'post', id: 'missing' }] },
    { access: [{ ...capability, side: 'owner' }] }, { access: [], seenIncomingCount: 1 }];
  for (const body of invalid) assert.throws(() => store.updates(body), e => e instanceof ApiError && e.status === 400);
  assert.deepEqual(store.updates({ access: [] }), { threads: [], unavailable: [] });
  assert.deepEqual(store.updates({ access: Array(32).fill(capability) }), { threads: [], unavailable: [{ kind: 'post', id: 'missing' }] });
});

test('validation rejects untrusted types, unsupported values, and oversized messages', () => {
  const { store } = fixture();
  const invalid = [null, [], input({ kind: 'admin' }), input({ role: 'Autre' }), input({ zoneId: 'gps' }),
    input({ durationMinutes: 10 }), input({ durationMinutes: '30' }), input({ english: 1 }), input({ vehicle: 'true' }),
    input({ places: 0 }), input({ places: 1.2 }), input({ places: 9 }), input({ pay: '18' }), input({ pay: Infinity }),
    input({ pay: 7 }), input({ pay: 101 }), input({ note: 'x'.repeat(181) }), input({ note: '<\u0000>' }), input({ ownerToken: 'injected' })];
  for (const payload of invalid) assert.throws(() => store.create(payload), e => e instanceof ApiError && e.status === 400);
  const { post } = store.create(input());
  for (const message of ['', '   ', 'x'.repeat(501), 123]) assert.throws(() => store.contact(post.id, { message }), e => e instanceof ApiError && e.status === 400);
  assert.equal(store.state().posts.length, 1);
});

test('all published hospitality roles accept both availability and need posts', () => {
  const { store } = fixture();
  for (const role of ROLES) {
    assert.equal(store.create(input({ kind: 'available', role })).post.role, role);
    assert.equal(store.create(input({ kind: 'need', role })).post.role, role);
  }
});

test('world location search matches accents, aliases, and non-Latin names with bounded results', () => {
  assert.deepEqual(searchLocations('São Paulo'), searchLocations('Sao Paulo'));
  assert.equal(searchLocations('Sao Paulo').locations[0].country, 'BR');
  assert.equal(searchLocations('München').locations[0].id, searchLocations('Munich').locations[0].id);
  assert.equal(searchLocations('東京').locations[0].country, 'JP');
  assert.equal(searchLocations('Paris').locations[0].id, '2988507');
  assert.ok(searchLocations('San').locations.length <= 12);
  for (const query of [undefined, null, '', 'x', '  ', 'x'.repeat(81)]) {
    assert.throws(() => searchLocations(query), e => e instanceof LocationError && e.code === 'invalid_location_query');
  }
});

test('world posts store only approximate points and validated city metadata', () => {
  const { store } = fixture();
  const city = getLocation('3448439');
  const payload = input({ cityId: city.id }); delete payload.zoneId;
  const center = store.create(payload).post;
  assert.equal(center.cityName, 'São Paulo');
  assert.equal(center.country, 'BR');
  assert.equal(center.timezone, 'America/Sao_Paulo');
  assert.equal(center.zoneId, `city-${city.id}`);
  assert.equal(center.zoneLabel, city.label);
  assert.equal(center.lat, -23.55);
  assert.equal(center.lng, -46.64);
  const point = { lat: -23.56, lng: -46.65 };
  const positioned = store.create({ ...payload, point }).post;
  point.lat = 12;
  assert.equal(positioned.lat, -23.56);
  assert.equal('point' in positioned, false);
  assert.equal(store.create(input()).post.cityId, '2988507');
  assert.equal(store.create(input()).post.country, 'FR');
});

test('precise coordinates, far-away pins and inconsistent city/zone inputs are rejected before storage', () => {
  const { store } = fixture();
  const payload = input({ cityId: '2988507' }); delete payload.zoneId;
  const cases = [
    [{ ...payload, point: { lat: 48.8566, lng: 2.35 } }, 'coordinates_too_precise'],
    [{ ...payload, point: { lat: 91, lng: 2.35 } }, 'invalid_coordinates'],
    [{ ...payload, point: { lat: 48.86, lng: 181 } }, 'invalid_coordinates'],
    [{ ...payload, point: { lat: '48.86', lng: 2.35 } }, 'invalid_coordinates'],
    [{ ...payload, point: { lat: 48.86, lng: 2.35, accuracy: 12 } }, 'invalid_location_point'],
    [{ ...payload, point: { lat: 40.71, lng: -74.01 } }, 'point_too_far_from_city'],
    [{ ...payload, cityId: '0' }, 'invalid_city'],
    [input({ point: { lat: 48.86, lng: 2.35 } }), 'city_required_for_point'],
    [input({ cityId: '3448439' }), 'invalid_zone'],
  ];
  for (const [value, code] of cases) assert.throws(() => store.create(value), error(400, code));
  assert.equal(store.state().posts.length, 0);
  assert.throws(() => nearestLocation({ lat: 48.8566, lng: 2.35 }), e => e instanceof LocationError && e.code === 'coordinates_too_precise');
  const nearest = nearestLocation({ lat: 48.86, lng: 2.35 }).location;
  assert.equal(nearest.country, 'FR');
  assert.equal(nearest.lat, Number(nearest.lat.toFixed(2)));
  assert.equal(nearest.lng, Number(nearest.lng.toFixed(2)));
});

test('memory caps reject additions and expiry frees capacity', () => {
  const { store, advance } = fixture({ maxPosts: 1, maxThreads: 1, maxMessages: 2 });
  const { post, ownerToken } = store.create(input());
  assert.throws(() => store.create(input()), error(429, 'post_capacity_reached'));
  const chat = store.contact(post.id, { message: 'Premier message.' });
  assert.throws(() => store.contact(post.id, { message: 'Autre contact.' }), error(429, 'thread_capacity_reached'));
  store.addMessage(chat.threadId, ownerToken, { message: 'Réponse.' });
  assert.throws(() => store.addMessage(chat.threadId, chat.guestToken, { message: 'Encore.' }), error(429, 'message_capacity_reached'));
  advance(30 * 60_000);
  assert.equal(store.create(input()).post.status, 'open');
  assert.equal(store.threads.size, 0);
});
