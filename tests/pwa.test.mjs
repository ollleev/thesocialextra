import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setupInstall } from '../public/install.js';

const origin = 'https://extras.test';
const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8');
const offlineHTML = await readFile(new URL('../public/offline.html', import.meta.url), 'utf8');
const html = (body = offlineHTML, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Execute the actual worker. This harness models only the worker events, network,
// and Cache Storage API; browser installation criteria are tested separately on-device.
function worker() {
  const handlers = new Map(), stores = new Map(), writes = [], fetches = [], removed = [];
  let network = async () => html(), claimed = 0;
  const normalize = value => new URL(typeof value === 'string' ? value : value.url, origin).href;
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        async put(request, response) { const url = normalize(request); writes.push({ name, url }); store.set(url, response.clone()); },
        async match(request) { return store.get(normalize(request))?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { removed.push(name); return stores.delete(name); },
  };
  vm.runInNewContext(source, {
    self: { location: { origin }, clients: { async claim() { claimed++; } },
      addEventListener(type, listener) { assert.ok(!handlers.has(type)); handlers.set(type, listener); } },
    caches, URL, Request, Response,
    fetch: async (request, options) => { fetches.push({ request, options }); return network(request, options); },
  }, { filename: 'service-worker.js' });
  return {
    stores, writes, fetches, removed, caches,
    get claimed() { return claimed; },
    network(fn) { network = fn; },
    async lifecycle(type) {
      let work;
      handlers.get(type)({ waitUntil(promise) { work = promise; } });
      assert.ok(work); await work;
    },
    fetch(path = '/', { method = 'GET', mode = 'navigate' } = {}) {
      const request = { url: new URL(path, origin).href, method, mode };
      let response = null;
      handlers.get('fetch')({ request, respondWith(promise) { assert.equal(response, null); response = promise; } });
      return response;
    },
  };
}

test('manifest uses a stable root identity without account data; raster icons match their declared dimensions', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url)));
  assert.equal(manifest.name, 'thesocialextra');
  for (const key of ['id', 'start_url', 'scope']) assert.equal(manifest[key], '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.prefer_related_applications, false);
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  for (const icon of [...manifest.icons, { src: '/assets/pwa-icon-180.png', sizes: '180x180' }]) {
    const dimensions = icon.sizes.split('x').map(Number);
    const png = await readFile(new URL(`../public${icon.src}`, import.meta.url));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], dimensions);
  }
});

test('installation caches only the credential-free static fallback, never the application document', async () => {
  const f = worker(); await f.lifecycle('install');
  assert.deepEqual(f.writes.map(write => write.url), [`${origin}/offline.html`]);
  const { request } = f.fetches[0];
  assert.equal(request.url, `${origin}/offline.html`);
  assert.equal(request.credentials, 'omit');
  assert.equal(request.redirect, 'error');
  assert.equal(request.cache, 'no-store');
  assert.equal(await (await f.caches.open(f.writes[0].name)).match('/'), undefined);
});

test('failed or non-HTML offline responses reject installation without writing an error or auth response', async () => {
  for (const response of [html('denied', 401), html('outage', 500), new Response('{"private":true}', { headers: { 'Content-Type': 'application/json' } })]) {
    const f = worker(); f.network(async () => response);
    await assert.rejects(f.lifecycle('install'), /Static offline page unavailable/);
    assert.deepEqual(f.writes, []);
  }
  const f = worker(); f.network(async () => { throw new TypeError('network rejected'); });
  await assert.rejects(f.lifecycle('install'), /network rejected/);
  assert.deepEqual(f.writes, []);
});

test('private navigation responses always use the network and never enter Cache Storage', async () => {
  const f = worker(); await f.lifecycle('install');
  for (const secret of ['FIRST_ACCOUNT_PRIVATE', 'SECOND_ACCOUNT_PRIVATE']) {
    f.network(async (request, options) => {
      assert.equal(options.cache, 'no-store');
      assert.equal(request.url, `${origin}/?city=2988507&token=SYNTHETIC_SECRET`);
      return html(secret);
    });
    assert.equal(await (await f.fetch('/?city=2988507&token=SYNTHETIC_SECRET')).text(), secret);
  }
  assert.equal(f.writes.length, 1);
  const cache = await f.caches.open(f.writes[0].name);
  assert.equal(await (await cache.match('/offline.html')).text(), offlineHTML);
  assert.equal(await cache.match('/?city=2988507&token=SYNTHETIC_SECRET'), undefined);
});

test('network rejection returns only the static fallback without reflecting the requested path or query', async () => {
  const f = worker(); await f.lifecycle('install');
  f.network(async () => { throw new TypeError('synthetic offline'); });
  for (const path of ['/?post=PRIVATE_ID&token=SECRET', '/index.html', '/privacy.html', '/offline.html']) {
    const response = await f.fetch(path);
    assert.equal(await response.text(), offlineHTML);
  }
  assert.equal(f.writes.length, 1);
});

test('real HTTP error responses including server 500 and access 401 are not replaced with an offline success', async () => {
  const f = worker(); await f.lifecycle('install');
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const response = html(`network error ${status}`, status);
    f.network(async () => response);
    assert.equal(await f.fetch('/'), response);
  }
  assert.equal(f.writes.length, 1);
});

test('APIs, private mutations, SSE, map tiles, assets and foreign navigations are never intercepted', async () => {
  const f = worker(); await f.lifecycle('install'); const calls = f.fetches.length;
  for (const path of ['/api/state', '/api/session', '/api/events', '/api/threads/private', '/api/posts/private', '/api/updates', '/api/auth/login']) {
    for (const mode of ['navigate', 'cors', 'same-origin']) assert.equal(f.fetch(path, { mode }), null, path);
  }
  for (const path of ['/app.js', '/style.css', '/assets/pwa-icon-192.png', '/manifest.webmanifest', 'https://tile.openstreetmap.org/1/0/0.png', 'https://other.test/']) {
    assert.equal(f.fetch(path), null, path);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal(f.fetch('/', { method }), null);
  assert.equal(f.fetch('/', { mode: 'cors' }), null);
  assert.equal(f.fetches.length, calls); assert.equal(f.writes.length, 1);
});

test('activation removes only older caches owned by this offline worker and claims clients without forced waiting', async () => {
  const f = worker(); await f.lifecycle('install');
  await f.caches.open('another-app'); await f.caches.open('thesocialextra-offline-v0');
  await f.lifecycle('activate');
  assert.deepEqual(f.removed, ['thesocialextra-offline-v0']);
  assert.equal(f.claimed, 1);
  assert.ok(f.stores.has('another-app')); assert.ok(f.stores.has(f.writes[0].name));
  // self.skipWaiting is intentionally absent from the VM; invoking it would fail.
});

test('cache eviction or denied storage still produces an honest 503 with no cached account state', async () => {
  for (const denyStorage of [false, true]) {
    const f = worker(); await f.lifecycle('install'); f.stores.clear();
    if (denyStorage) f.caches.open = async () => { throw new Error('storage denied'); };
    f.network(async () => { throw new TypeError('offline'); });
    const response = await f.fetch('/');
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.text()).includes('Connexion nécessaire.'));
  }
});

class Events {
  constructor() { this.listeners = new Map(); this.hidden = false; this.disabled = false; this.textContent = ''; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  async fire(type, event = {}) { for (const fn of this.listeners.get(type) || []) await fn(event); }
}
function installFixture(options = {}) {
  const win = new Events(), button = new Events(), status = new Events(), registrations = [];
  win.isSecureContext = true; win.matchMedia = () => ({ matches: Boolean(options.standalone) });
  const nav = { serviceWorker: { async register(...args) {
    registrations.push(args); if (options.registrationFailure) throw new Error('registration denied'); return {};
  } } };
  if (options.insecure) win.isSecureContext = false;
  if (options.unsupported) delete nav.serviceWorker;
  const control = setupInstall({ button: options.noButton ? undefined : button, status, window: win, navigator: nav });
  return { win, nav, button, status, control, registrations };
}
function installPrompt({ outcome = 'dismissed', fail = false, choice } = {}) {
  return { prevented: false, calls: 0, userChoice: choice || Promise.resolve({ outcome }),
    preventDefault() { this.prevented = true; },
    async prompt() { this.calls++; if (fail) throw new Error('prompt unavailable'); },
  };
}

test('install module registers one static script and keeps the button hidden without a browser invitation', async () => {
  const f = installFixture(); assert.equal(await f.control.ready, true);
  assert.deepEqual(f.registrations, [['/service-worker.js', { scope: '/', updateViaCache: 'none' }]]);
  assert.equal(f.button.hidden, true);
  await f.button.fire('click'); assert.equal(f.status.textContent, '');
  const event = installPrompt(); await f.win.fire('beforeinstallprompt', event);
  assert.equal(event.prevented, true); assert.equal(event.calls, 0); assert.equal(f.button.hidden, false);
});

test('accepted installation is requested only by a click; actual completion requires appinstalled', async () => {
  const f = installFixture(), event = installPrompt({ outcome: 'accepted' });
  await f.win.fire('beforeinstallprompt', event); await f.button.fire('click');
  assert.equal(event.calls, 1); assert.equal(f.button.hidden, true);
  assert.equal(f.status.textContent, 'Demande d’installation acceptée.');
  await f.button.fire('click'); assert.equal(event.calls, 1);
  await f.win.fire('appinstalled'); assert.equal(f.status.textContent, 'Application installée.');
});

test('cancelling or failing an install never claims success and the used prompt cannot be replayed', async () => {
  for (const fail of [false, true]) {
    const f = installFixture(), event = installPrompt({ fail });
    await f.win.fire('beforeinstallprompt', event); await f.button.fire('click');
    assert.equal(f.status.textContent, fail ? 'Installation indisponible. Vous pouvez continuer dans le navigateur.' : 'Installation annulée.');
    await f.button.fire('click'); assert.equal(event.calls, 1); assert.equal(f.button.hidden, true);
    const next = installPrompt(); await f.win.fire('beforeinstallprompt', next);
    assert.equal(f.button.hidden, false); assert.equal(next.calls, 0);
  }
});

test('late userChoice cannot undo appinstalled or mutate a destroyed controller', async () => {
  for (const finish of ['installed', 'destroyed']) {
    let resolve;
    const choice = new Promise(done => { resolve = done; });
    const f = installFixture(), event = installPrompt({ choice });
    await f.win.fire('beforeinstallprompt', event);
    const pending = f.button.fire('click');
    if (finish === 'installed') await f.win.fire('appinstalled'); else f.control.destroy();
    resolve({ outcome: 'dismissed' }); await pending;
    assert.equal(f.button.hidden, true);
    assert.equal(f.status.textContent, finish === 'installed' ? 'Application installée.' : '');
  }
});

test('unsupported/insecure browsers and standalone apps never get a misleading install button', async () => {
  for (const options of [{ insecure: true }, { unsupported: true }, { standalone: true }, { noButton: true }]) {
    const f = installFixture(options), event = installPrompt();
    await f.control.ready; await f.win.fire('beforeinstallprompt', event); await f.button.fire('click');
    assert.equal(event.prevented, false); assert.equal(event.calls, 0);
    if (!options.noButton) assert.equal(f.button.hidden, true);
    if (options.insecure || options.unsupported) assert.deepEqual(f.registrations, []);
  }
  const f = installFixture({ registrationFailure: true });
  assert.equal(await f.control.ready, false); assert.equal(f.status.textContent, '');
});
