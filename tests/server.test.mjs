import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveStore } from '../domain.mjs';
import { createLiveServer } from '../server.mjs';

const input = (overrides = {}) => ({ kind: 'need', role: 'Serveur', zoneId: 'bastille', english: true, vehicle: false, durationMinutes: 30, places: 2, pay: 18, ...overrides });
async function fixture(t, options = {}) {
  const app = createLiveServer({ store: new LiveStore({ seed: false }), ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => app.close());
  const request = async (route, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + route, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = res.status === 204 ? null : await res.json();
    return { status: res.status, data, headers: res.headers };
  };
  return { ...app, base, request };
}

test('HTTP API publishes, atomically fills, protects owner actions, and deletes', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/api/zones')).data.length, 8);
  const created = await request('/api/posts', { method: 'POST', body: input({ places: 1 }) });
  assert.equal(created.status, 201);
  const { post, ownerToken } = created.data;
  const publicState = await request('/api/state');
  assert.equal(publicState.status, 200);
  assert.equal(publicState.data.posts[0].id, post.id);
  assert.ok(!JSON.stringify(publicState.data).includes(ownerToken));
  assert.equal((await request(`/api/posts/${post.id}`, { method: 'PATCH', body: { action: 'fill' } })).status, 403);
  const attempts = await Promise.all(Array.from({ length: 6 }, () => request(`/api/posts/${post.id}`, { method: 'PATCH', body: { action: 'fill' }, headers: { 'X-Owner-Token': ownerToken } })));
  assert.equal(attempts.filter(result => result.status === 200).length, 1);
  assert.equal(attempts.filter(result => result.status === 409).length, 5);
  assert.equal((await request('/api/state')).data.posts[0].places, 0);
  assert.equal((await request(`/api/posts/${post.id}`, { method: 'DELETE', headers: { 'X-Owner-Token': ownerToken } })).status, 204);
  assert.equal((await request('/api/state')).data.posts.length, 0);
});

test('role discovery provides grouped options usable directly for publication', async t => {
  const { request } = await fixture(t);
  const groups = await request('/api/roles');
  assert.equal(groups.status, 200);
  assert.equal(groups.data.length, 3);
  const roles = groups.data.flatMap(group => group.roles);
  assert.equal(new Set(roles).size, 12);
  for (const role of ['Manager', 'Cuisinier', 'Pizzaiolo', 'Pâtissier', 'Traiteur', 'Maître d’hôtel', 'Hôte / Hôtesse']) {
    assert.ok(roles.includes(role));
    const created = await request('/api/posts', { method: 'POST', body: input({ role }) });
    assert.equal(created.status, 201);
    assert.equal(created.data.post.role, role);
  }
});

test('world location HTTP endpoints support rounded discovery and international publication', async t => {
  const { request } = await fixture(t);
  const search = await request(`/api/locations?q=${encodeURIComponent('São Paulo')}`);
  assert.equal(search.status, 200);
  const city = search.data.locations[0];
  assert.deepEqual((await request(`/api/locations/${city.id}`)).data.location, city);
  assert.equal((await request('/api/locations/999999999999')).status, 400);
  assert.equal(city.country, 'BR');
  const payload = input({ cityId: city.id, point: { lat: city.lat, lng: city.lng } }); delete payload.zoneId;
  const created = await request('/api/posts', { method: 'POST', body: payload });
  assert.equal(created.status, 201);
  assert.equal(created.data.post.cityId, city.id);
  assert.equal(created.data.post.timezone, city.timezone);
  const nearest = await request(`/api/locations/nearest?lat=${city.lat}&lng=${city.lng}`);
  assert.equal(nearest.status, 200);
  assert.equal(nearest.data.location.country, 'BR');
  const precise = await request('/api/locations/nearest?lat=48.8566&lng=2.35');
  assert.equal(precise.status, 400);
  assert.equal(precise.data.error, 'coordinates_too_precise');
  assert.equal((await request('/api/locations/nearest?lat=&lng=2.35')).status, 400);
  assert.equal((await request('/api/locations?q=a')).status, 400);
  assert.match(search.headers.get('permissions-policy'), /geolocation=\(self\)/);
});

test('location discovery has a request quota to bound catalog search work', async t => {
  const { request } = await fixture(t, { rateLimit: 1 });
  assert.equal((await request('/api/locations?q=Tokyo')).status, 200);
  assert.equal((await request('/api/locations/nearest?lat=35.69&lng=139.69')).status, 429);
  assert.equal((await request('/api/state')).status, 200);
});

test('HTTP contact and inbox never grant another visitor access', async t => {
  const { request } = await fixture(t);
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const a = (await request(`/api/posts/${post.id}/contact`, { method: 'POST', body: { message: 'Disponible maintenant.' } })).data;
  const b = (await request(`/api/posts/${post.id}/contact`, { method: 'POST', body: { message: 'Encore une place ?' } })).data;
  assert.equal((await request(`/api/threads/${a.threadId}`, { headers: { 'X-Chat-Token': b.guestToken } })).status, 403);
  assert.equal((await request(`/api/posts/${post.id}/threads`)).status, 403);
  const reply = await request(`/api/threads/${a.threadId}/messages`, { method: 'POST', headers: { 'X-Chat-Token': ownerToken }, body: { message: 'Oui, échangeons ici.' } });
  assert.equal(reply.status, 201);
  const thread = await request(`/api/threads/${a.threadId}`, { headers: { 'X-Chat-Token': a.guestToken } });
  assert.equal(thread.data.thread.messages.length, 2);
  const inbox = await request(`/api/posts/${post.id}/threads`, { headers: { 'X-Owner-Token': ownerToken } });
  assert.equal(inbox.data.threads.length, 2);
  assert.ok(!JSON.stringify(inbox.data).includes(a.guestToken));
});

test('HTTP concurrent message retries create one message and isolate same keys between sides', async t => {
  const { request } = await fixture(t);
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const chat = (await request(`/api/posts/${post.id}/contact`, { method: 'POST', body: { message: 'Contact initial.' } })).data;
  const path = `/api/threads/${chat.threadId}/messages`;
  const key = 'http-message-intention-1234';
  const guestHeaders = { 'X-Chat-Token': chat.guestToken, 'Idempotency-Key': key };
  const attempts = await Promise.all(Array.from({ length: 6 }, () => request(path, { method: 'POST', headers: guestHeaders, body: { message: 'Disponible maintenant.' } })));
  assert.ok(attempts.every(result => result.status === 201));
  assert.equal(new Set(attempts.map(result => result.data.message.id)).size, 1);
  const before = (await request(`/api/threads/${chat.threadId}`, { headers: { 'X-Chat-Token': ownerToken } })).data.thread;
  assert.equal(before.messages.length, 2);
  assert.equal(before.incomingCount, 2);
  assert.equal((await request(path, { method: 'POST', headers: guestHeaders, body: { message: 'Texte modifié.' } })).status, 409);
  const owner = await request(path, { method: 'POST', headers: { 'X-Chat-Token': ownerToken, 'Idempotency-Key': key }, body: { message: 'Réponse propriétaire.' } });
  assert.equal(owner.status, 201);
  assert.equal(owner.data.message.sender, 'owner');
  assert.notEqual(owner.data.message.id, attempts[0].data.message.id);
  const retry = await request(path, { method: 'POST', headers: guestHeaders, body: { message: 'Disponible maintenant.' } });
  assert.deepEqual(retry.data, attempts[0].data);
  assert.ok(!JSON.stringify(retry.data).includes(key));
  assert.equal((await request(`/api/threads/${chat.threadId}`, { headers: { 'X-Chat-Token': ownerToken } })).data.thread.messages.length, 3);
});

test('HTTP message retries recheck authorization and expiry before cached results and ignore the reached quota', async t => {
  let now = 1_800_000_000_000;
  const { request } = await fixture(t, { store: new LiveStore({ seed: false, clock: () => now, maxMessages: 2 }) });
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const chat = (await request(`/api/posts/${post.id}/contact`, { method: 'POST', body: { message: 'Contact initial.' } })).data;
  const path = `/api/threads/${chat.threadId}/messages`;
  const headers = { 'X-Chat-Token': ownerToken, 'Idempotency-Key': 'http-message-quota-intention' };
  const body = { message: 'Dernière place dans cet échange.' };
  const first = await request(path, { method: 'POST', headers, body });
  assert.equal(first.status, 201);
  assert.deepEqual((await request(path, { method: 'POST', headers, body })).data, first.data);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, 'X-Chat-Token': 'wrong-token' }, body })).status, 403);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, 'X-Chat-Token': chat.guestToken }, body })).status, 429);
  assert.equal((await request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'new-http-message-intention' }, body })).status, 429);
  const conflict = await request(path, { method: 'POST', headers, body: { message: 'Autre texte.' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, 'idempotency_conflict');
  const invalid = await request(path, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'short' }, body });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error, 'invalid_idempotency_key');
  now += 30 * 60_000;
  assert.equal((await request(path, { method: 'POST', headers, body })).status, 404);
});

test('HTTP accepts an idempotency key for safe fill retries', async t => {
  const { request } = await fixture(t);
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const headers = { 'X-Owner-Token': ownerToken, 'Idempotency-Key': 'http-fill-intention-1234' };
  const responses = await Promise.all(Array.from({ length: 4 }, () => request(`/api/posts/${post.id}`, { method: 'PATCH', body: { action: 'fill' }, headers })));
  assert.ok(responses.every(result => result.status === 200 && result.data.post.places === 1));
  assert.equal((await request('/api/state')).data.posts[0].places, 1);
});

test('HTTP reopen is owner-only, bounded, revisioned and safe to retry', async t => {
  let now = 1_800_000_000_000;
  const { request } = await fixture(t, { store: new LiveStore({ seed: false, clock: () => now }) });
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const headers = { 'X-Owner-Token': ownerToken };
  const path = `/api/posts/${post.id}`;
  assert.equal(post.revision, 0);
  const closed = await request(path, { method: 'PATCH', body: { action: 'close' }, headers });
  assert.equal(closed.data.post.revision, 1);
  assert.equal((await request(path, { method: 'PATCH', body: { action: 'reopen' } })).status, 403);
  const retryHeaders = { ...headers, 'Idempotency-Key': 'http-reopen-intention-1234' };
  const repeated = await Promise.all(Array.from({ length: 4 }, () => request(path, { method: 'PATCH', body: { action: 'reopen' }, headers: retryHeaders })));
  assert.ok(repeated.every(result => result.status === 200 && result.data.post.places === 1 && result.data.post.revision === 2));
  assert.ok(repeated.every(result => result.data.post.expiresAt === post.expiresAt && result.data.post.updatedAt === closed.data.post.updatedAt));
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => request(path, { method: 'PATCH', body: { action: 'reopen' }, headers })));
  assert.equal(concurrent.filter(result => result.status === 200).length, 1);
  assert.ok(concurrent.filter(result => result.status === 409).every(result => result.data.error === 'no_place_to_reopen'));
  assert.equal((await request('/api/state')).data.posts[0].revision, 3);
  now += 30 * 60_000;
  assert.equal((await request(path, { method: 'PATCH', body: { action: 'reopen' }, headers: retryHeaders })).status, 404);
});

test('HTTP update batches hide unauthorized data and count incoming messages in exact read snapshots', async t => {
  let now = 1_800_000_000_000;
  const { request } = await fixture(t, { store: new LiveStore({ seed: false, clock: () => now }) });
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const chat = (await request(`/api/posts/${post.id}/contact`, { method: 'POST', body: { message: 'Premier message privé.' } })).data;
  const postAccess = { kind: 'post', id: post.id, token: ownerToken };
  const guestAccess = { kind: 'thread', id: chat.threadId, token: chat.guestToken };
  const first = await request('/api/updates', { method: 'POST', body: { access: [postAccess] } });
  assert.equal(first.status, 200);
  assert.equal(first.data.threads[0].incomingCount, 1);
  assert.equal(first.data.threads[0].side, 'owner');
  assert.ok(!JSON.stringify(first.data).includes('Premier message privé.'));
  assert.ok(!JSON.stringify(first.data).includes(ownerToken));
  await request(`/api/threads/${chat.threadId}/messages`, { method: 'POST', headers: { 'X-Chat-Token': chat.guestToken }, body: { message: 'Autre message.' } });
  const second = await request('/api/updates', { method: 'POST', body: { access: [postAccess, postAccess] } });
  assert.equal(second.data.threads.length, 1);
  assert.equal(second.data.threads[0].incomingCount, 2);
  assert.equal(second.data.threads[0].updatedAt, first.data.threads[0].updatedAt);
  assert.notEqual(second.data.threads[0].lastIncomingId, first.data.threads[0].lastIncomingId);
  const thread = (await request(`/api/threads/${chat.threadId}`, { headers: { 'X-Chat-Token': ownerToken } })).data.thread;
  assert.equal(thread.side, 'owner');
  assert.equal(thread.incomingCount, 2);
  const guest = await request('/api/updates', { method: 'POST', body: { access: [guestAccess] } });
  assert.equal(guest.data.threads[0].incomingCount, 0);
  const wrong = { ...postAccess, token: chat.guestToken };
  const missing = { ...guestAccess, id: 'absent-thread' };
  const denied = await request('/api/updates', { method: 'POST', body: { access: [wrong, missing] } });
  assert.deepEqual(denied.data, { threads: [], unavailable: [{ kind: 'post', id: post.id }, { kind: 'thread', id: 'absent-thread' }] });
  assert.equal((await request('/api/updates', { method: 'POST', body: { access: Array(33).fill(guestAccess) } })).status, 400);
  assert.equal((await request('/api/updates', { method: 'POST', body: { access: [guestAccess] }, headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  now += 30 * 60_000;
  const expired = await request('/api/updates', { method: 'POST', body: { access: [postAccess, guestAccess] } });
  assert.deepEqual(expired.data, { threads: [], unavailable: [{ kind: 'post', id: post.id }, { kind: 'thread', id: chat.threadId }] });
});

test('SSE sends initial state, creation, fill, and server-side expiry', async t => {
  let now = 1_800_000_000_000;
  const { request, base } = await fixture(t, { store: new LiveStore({ seed: false, clock: () => now }), sweepIntervalMs: 20 });
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  t.after(async () => { controller.abort(); await reader.cancel().catch(() => {}); });
  let buffered = '';
  async function event() {
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      while (!buffered.includes('\n\n')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        buffered += new TextDecoder().decode(value);
      }
      const boundary = buffered.indexOf('\n\n');
      const entry = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      assert.match(entry, /^event: state\ndata: /);
      return JSON.parse(entry.split('\ndata: ')[1]);
    } finally { clearTimeout(timeout); }
  }
  assert.equal((await event()).posts.length, 0);
  const { post, ownerToken } = (await request('/api/posts', { method: 'POST', body: input() })).data;
  const created = (await event()).posts[0];
  assert.equal(created.places, 2);
  assert.equal(created.revision, 0);
  await request(`/api/posts/${post.id}`, { method: 'PATCH', body: { action: 'fill' }, headers: { 'X-Owner-Token': ownerToken } });
  const filled = (await event()).posts[0];
  assert.equal(filled.places, 1);
  assert.equal(filled.revision, 1);
  await request(`/api/posts/${post.id}`, { method: 'PATCH', body: { action: 'reopen' }, headers: { 'X-Owner-Token': ownerToken } });
  const reopened = (await event()).posts[0];
  assert.equal(reopened.places, 2);
  assert.equal(reopened.revision, 2);
  now += 30 * 60_000;
  assert.equal((await event()).posts.length, 0);
  controller.abort();
});

test('SSE can deliver a full-capacity snapshot larger than the stream high-water mark', async t => {
  const store = new LiveStore({ seed: false });
  for (let index = 0; index < 200; index++) store.create(input({ note: 'x'.repeat(180) }));
  const { base } = await fixture(t, { store });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  const reader = response.body.getReader();
  t.after(async () => { clearTimeout(timeout); controller.abort(); await reader.cancel().catch(() => {}); });
  let data = '';
  while (!data.includes('\n\n')) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    data += new TextDecoder().decode(value);
  }
  assert.ok(data.length > 65_536);
  const state = JSON.parse(data.slice(data.indexOf('data: ') + 6, data.indexOf('\n\n')));
  assert.equal(state.posts.length, 200);
  clearTimeout(timeout);
  controller.abort();
});

test('HTTP rejects demo contacts, foreign origins, DNS rebinding, and invalid input', async t => {
  const { request, base } = await fixture(t, { store: new LiveStore() });
  const demo = (await request('/api/state')).data.posts[0];
  const blockedDemo = await request(`/api/posts/${demo.id}/contact`, { method: 'POST', body: { message: 'Test.' } });
  assert.equal(blockedDemo.status, 409);
  assert.equal(blockedDemo.data.error, 'demo_contact_unavailable');
  assert.equal((await request('/api/posts', { method: 'POST', body: input(), headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal((await request('/api/posts', { method: 'POST', body: input(), headers: { Origin: 'null' } })).status, 403);
  assert.equal((await request('/api/posts', { method: 'POST', body: input(), headers: { Origin: base } })).status, 201);
  assert.equal((await request('/api/posts', { method: 'POST', body: input({ places: -1 }) })).status, 400);
  const rebindingStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/state', { headers: { Host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(rebindingStatus, 403);
});

test('HTTP enforces bounded JSON bodies and request rate', async t => {
  const { base, request } = await fixture(t, { rateLimit: 3 });
  assert.equal((await fetch(base + '/api/posts', { method: 'POST', body: 'plain text' })).status, 415);
  assert.equal((await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(base + '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'x'.repeat(9000) }) })).status, 413);
  const limited = await request('/api/posts', { method: 'POST', body: input() });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error, 'rate_limit');
  assert.equal((await request('/api/state')).data.posts.length, 0);
});

test('static serving includes security headers and rejects hidden files and escaped symlinks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extras-static-test-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'extras-outside-test-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Local fixture</title>');
  await writeFile(path.join(root, 'font.ttf'), 'synthetic font fixture');
  await writeFile(path.join(root, 'license.txt'), 'synthetic text fixture');
  await writeFile(path.join(root, '.hidden.html'), 'hidden');
  await writeFile(path.join(outside, 'outside.html'), 'outside');
  await symlink(path.join(outside, 'outside.html'), path.join(root, 'escape.html'));
  const { base } = await fixture(t, { publicDir: root });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Local fixture/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data: https:\/\/tile\.openstreetmap\.org;/);
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal((await fetch(base + '/font.ttf')).headers.get('content-type'), 'font/ttf');
  assert.equal((await fetch(base + '/license.txt')).headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal((await fetch(base + '/.hidden.html')).status, 404);
  assert.equal((await fetch(base + '/escape.html')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2fserver.mjs')).status, 404);
  assert.equal((await fetch(base + '/', { method: 'HEAD' })).status, 200);
});
