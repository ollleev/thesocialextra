import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFeedShare, parseFeedLink } from '../public/sharing.js';
import { ROLES } from '../domain.mjs';

const city = { id: '6077243', name: 'Montréal' };
const origin = 'https://extras.test';

test('feed links round-trip every supported role and kind, including accents and punctuation', () => {
  for (const role of ['all', ...ROLES]) for (const kind of ['all', 'available', 'need']) {
    const share = makeFeedShare({ origin, city, role, kind }, ROLES);
    const parsed = parseFeedLink(share.url, ROLES);
    assert.deepEqual(parsed, { postId: null, scope: { cityId: city.id, role, kind }, invalid: false });
    assert.equal(makeFeedShare({ origin, city, ...parsed.scope }, ROLES).url, share.url);
    assert.ok(share.text.includes(city.name));
    assert.ok(share.text.includes(role === 'all' ? 'Tous les métiers' : role));
    assert.ok(share.text.includes('thesocialextra'));
    assert.equal(share.clipboardText, `${share.text}\n${share.url}`);
  }
});

test('serialization never inherits coordinates, private identifiers, tracking or old post links', () => {
  const share = makeFeedShare({
    origin: `${origin}/private/old-path?post=old-post&token=URL_SECRET&utm_campaign=PERSONAL_TRACKER#HASH_SECRET`,
    city: { ...city, lat: 45.50, lng: -73.57, token: 'CITY_SECRET' },
    role: 'Barman', kind: 'need', point: { lat: 45.51, lng: -73.58 },
    mine: true, user: { id: 'USER_SECRET' }, ownerToken: 'OWNER_SECRET', guestToken: 'GUEST_SECRET',
    recoveryCode: 'RECOVERY_SECRET', username: 'USERNAME_SECRET', zoneId: 'PRIVATE_ZONE', english: true, vehicle: true,
  }, ROLES);
  const url = new URL(share.url);
  assert.equal(url.pathname, '/'); assert.equal(url.hash, '');
  assert.deepEqual([...url.searchParams.keys()], ['city', 'role', 'kind']);
  for (const value of ['SECRET', 'PERSONAL_TRACKER', 'PRIVATE_ZONE', '45.5', '-73.5', 'old-post', 'private/old-path']) {
    assert.ok(!JSON.stringify(share).includes(value), value);
  }
});

test('valid post links take priority over feed filters without inheriting any extra state', () => {
  assert.deepEqual(parseFeedLink(`${origin}/?post=existing-post-123&city=6077243&role=Barman&kind=need&token=SECRET`, ROLES),
    { postId: 'existing-post-123', scope: null, invalid: false });
  for (const query of ['post=', 'post=one&post=two', 'post=%3Cscript%3E', 'post=allowed%0A', `post=${'a'.repeat(81)}`]) {
    assert.deepEqual(parseFeedLink(`${origin}/?${query}&city=6077243`, ROLES), { postId: null, scope: null, invalid: true });
  }
});

test('invalid or duplicated city IDs cannot silently select another location', () => {
  for (const query of ['city=', 'city=0', 'city=01', 'city=-1', 'city=12.5', 'city=6077243%0A', 'city=%3Cscript%3E', 'city=1&city=2', `city=${'1'.repeat(13)}`, 'role=Barman&kind=need']) {
    assert.deepEqual(parseFeedLink(`${origin}/?${query}`, ROLES), { postId: null, scope: null, invalid: true });
  }
  // A syntactically valid ID is not asserted to exist: the UI must resolve it
  // against GET /api/locations/:id before applying its scope.
  assert.equal(parseFeedLink(`${origin}/?city=999999999999`, ROLES).scope.cityId, '999999999999');
});

test('unknown roles and kinds are ignored individually with an explicit invalid marker', () => {
  for (const query of ['role=%3Cimg%20src=x%20onerror=alert(1)%3E', 'role=Unknown', 'role=Barman&role=Serveur']) {
    assert.deepEqual(parseFeedLink(`${origin}/?city=${city.id}&kind=need&${query}`, ROLES),
      { postId: null, scope: { cityId: city.id, role: 'all', kind: 'need' }, invalid: true });
  }
  for (const query of ['kind=unknown', 'kind=need%0A', 'kind=need&kind=available']) {
    assert.deepEqual(parseFeedLink(`${origin}/?city=${city.id}&role=Barman&${query}`, ROLES),
      { postId: null, scope: { cityId: city.id, role: 'Barman', kind: 'all' }, invalid: true });
  }
});

test('unrecognized query data is never returned to application state', () => {
  const parsed = parseFeedLink(`${origin}/?city=${city.id}&lat=12.34&lng=56.78&mine=true&user=USER_SECRET&token=TOKEN_SECRET&utm_source=TRACKER`, ROLES);
  assert.deepEqual(parsed, { postId: null, scope: { cityId: city.id, role: 'all', kind: 'all' }, invalid: true });
  assert.deepEqual(parseFeedLink(origin, ROLES), { postId: null, scope: null, invalid: false });
  for (const value of ['not a URL', 'javascript:alert(1)', 'ftp://extras.test/?city=1', `${origin}/?${'x'.repeat(4096)}`]) {
    assert.deepEqual(parseFeedLink(value, ROLES), { postId: null, scope: null, invalid: true });
  }
});

test('serialization rejects invalid scope and credential-bearing origins instead of sharing them', () => {
  for (const changes of [
    { origin: 'javascript:alert(1)' }, { origin: 'https://user:secret@extras.test' },
    { city: { id: '6077243\n', name: 'Montréal' } }, { city: { id: city.id, name: 'Montréal\nSECRET' } },
    { city: { id: city.id, name: '' } }, { city: { id: city.id, name: 'x'.repeat(201) } },
    { role: '<script>' }, { kind: 'mine' },
  ]) assert.throws(() => makeFeedShare({ origin, city, ...changes }, ROLES), TypeError);
});
