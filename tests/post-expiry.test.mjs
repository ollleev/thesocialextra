import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePostDeadline, resolvePostExpiry } from '../post-expiry.mjs';

const MAX = 253402300799999;

test('normalizePostDeadline: undefined accepted without notAfter key', () => {
  assert.deepEqual(normalizePostDeadline(undefined), { ok: true });
});

test('normalizePostDeadline: zero and upper bound accepted', () => {
  assert.deepEqual(normalizePostDeadline(0), { ok: true, notAfter: 0 });
  assert.deepEqual(normalizePostDeadline(MAX), { ok: true, notAfter: MAX });
});

test('normalizePostDeadline: rejects negative, fractional, unsafe, strings, null, booleans, arrays, objects, NaN, Infinity', () => {
  const bad = { ok: false, code: 'invalid_post_deadline' };
  for (const v of [-1, 1.5, MAX + 1, '0', '30', null, true, false, [], {}, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(normalizePostDeadline(v), bad);
  }
});

test('resolvePostExpiry: each supported duration without deadline', () => {
  assert.deepEqual(resolvePostExpiry(30, undefined, 1000), { ok: true, expiresAt: 1000 + 30 * 60000 });
  assert.deepEqual(resolvePostExpiry(60, undefined, 1000), { ok: true, expiresAt: 1000 + 60 * 60000 });
  assert.deepEqual(resolvePostExpiry(120, undefined, 1000), { ok: true, expiresAt: 1000 + 120 * 60000 });
  assert.deepEqual(resolvePostExpiry(240, undefined, 1000), { ok: true, expiresAt: 1000 + 240 * 60000 });
});

test('resolvePostExpiry: invalid durations including numeric strings', () => {
  const bad = { ok: false, code: 'invalid_duration' };
  for (const d of [0, 15, 31, 300, -30, 30.5, '30', '60', null, true, undefined, [], {}]) {
    assert.deepEqual(resolvePostExpiry(d, undefined, 1000), bad);
  }
});

test('resolvePostExpiry: invalid clocks', () => {
  const bad = { ok: false, code: 'invalid_post_time' };
  for (const n of [-1, 1.5, MAX + 1, '1000', null, true, [], {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(resolvePostExpiry(30, undefined, n), bad);
  }
});

test('resolvePostExpiry: invalid deadlines', () => {
  const bad = { ok: false, code: 'invalid_post_deadline' };
  for (const d of [-1, 1.5, MAX + 1, '1000', null, true, [], {}, NaN, Infinity]) {
    assert.deepEqual(resolvePostExpiry(30, d, 1000), bad);
  }
});

test('resolvePostExpiry: deadline equal to now rejected', () => {
  assert.deepEqual(resolvePostExpiry(30, 1000, 1000), { ok: false, code: 'post_deadline_elapsed' });
});

test('resolvePostExpiry: deadline before now rejected', () => {
  assert.deepEqual(resolvePostExpiry(30, 999, 1000), { ok: false, code: 'post_deadline_elapsed' });
});

test('resolvePostExpiry: expiry capped by earlier future deadline', () => {
  assert.deepEqual(resolvePostExpiry(60, 2000, 1000), { ok: true, expiresAt: 2000 });
});

test('resolvePostExpiry: later deadline preserves normal duration', () => {
  assert.deepEqual(resolvePostExpiry(60, 10000000, 1000), { ok: true, expiresAt: 1000 + 60 * 60000 });
});

test('resolvePostExpiry: exact maximum result', () => {
  assert.deepEqual(resolvePostExpiry(30, undefined, MAX - 30 * 60000), { ok: true, expiresAt: MAX });
});

test('resolvePostExpiry: uncapped overflow rejected', () => {
  assert.deepEqual(resolvePostExpiry(30, undefined, MAX - 30 * 60000 + 1), { ok: false, code: 'invalid_post_time' });
});

test('resolvePostExpiry: valid cap rescues otherwise out-of-range expiry', () => {
  assert.deepEqual(resolvePostExpiry(240, MAX, MAX - 240 * 60000 + 1), { ok: true, expiresAt: MAX });
});

test('resolvePostExpiry: validation precedence with combined invalid inputs', () => {
  assert.deepEqual(resolvePostExpiry(15, -1, -1), { ok: false, code: 'invalid_duration' });
  assert.deepEqual(resolvePostExpiry(30, -1, -1), { ok: false, code: 'invalid_post_time' });
  assert.deepEqual(resolvePostExpiry(30, -1, 1000), { ok: false, code: 'invalid_post_deadline' });
  assert.deepEqual(resolvePostExpiry(30, 500, 1000), { ok: false, code: 'post_deadline_elapsed' });
  assert.deepEqual(resolvePostExpiry(240, undefined, MAX), { ok: false, code: 'invalid_post_time' });
});
