import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageOutbox, requestJSON } from '../public/requests.js';

test('drafts and delayed send results are isolated by conversation and edit version', () => {
  const box = new MessageOutbox(() => 'intent-key');
  box.edit('a', 'Premier message'); const first = box.begin('a');
  assert.equal(box.begin('a'), null);
  box.edit('b', 'Brouillon ailleurs');
  box.edit('a', 'Message suivant');
  box.finish('a', first);
  assert.equal(box.get('a').draft, 'Message suivant');
  assert.equal(box.get('b').draft, 'Brouillon ailleurs');
  const next = box.begin('a'); box.finish('a', next);
  assert.equal(box.get('a').draft, '');
  box.retain(new Set(['b']));
  assert.equal(box.entries.has('a'), false);
  assert.equal(box.finish('a', first), false);
});

test('uncertain message retry retains its key; a new intentional message gets another', () => {
  let n = 0; const box = new MessageOutbox(() => `key-${++n}`);
  box.edit('a', ' Bonjour '); const first = box.begin('a');
  const failure = new Error('lost response'); box.finish('a', first, failure);
  assert.equal(box.get('a').draft, ' Bonjour ');
  assert.equal(box.get('a').error, failure);
  const retry = box.begin('a');
  assert.equal(retry.key, first.key); assert.equal(retry.text, 'Bonjour');
  box.finish('a', retry);
  box.edit('a', 'Bonjour');
  assert.notEqual(box.begin('a').key, retry.key);
});

test('editing back to the same text during a send does not silently clear the new draft', () => {
  const box = new MessageOutbox();
  box.edit('a', 'Texte'); const intent = box.begin('a');
  box.edit('a', 'Autre'); box.edit('a', 'Texte');
  box.finish('a', intent);
  assert.equal(box.get('a').draft, 'Texte');
});

test('request timeout aborts a hung request once, without automatic retry', async () => {
  let calls = 0;
  await assert.rejects(requestJSON('/local', { method: 'POST', body: { message: 'Essai' } }, {
    timeoutMs: 10,
    fetcher: (_path, { signal }) => new Promise((_resolve, reject) => {
      calls++; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  }), { code: 'request_timeout' });
  assert.equal(calls, 1);
});

test('request timeout also covers a stalled response body', async () => {
  await assert.rejects(requestJSON('/local', {}, { timeoutMs: 10, fetcher: async (_path, { signal }) => ({
    status: 200, ok: true, json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
  }) }), { code: 'request_timeout' });
});

test('JSON requests carry private authorization and intent only in headers, preserving HTTP errors', async () => {
  await assert.rejects(requestJSON('/api/threads/local/messages', { method: 'POST', chat: 'test-capability', idempotencyKey: 'test-intent', body: { message: 'Essai' } }, {
    fetcher: async (path, options) => {
      assert.equal(path, '/api/threads/local/messages');
      assert.equal(options.headers['X-Chat-Token'], 'test-capability');
      assert.equal(options.headers['Idempotency-Key'], 'test-intent');
      assert.equal(options.body, '{"message":"Essai"}');
      return { status: 409, ok: false, json: async () => ({ error: 'idempotency_conflict' }) };
    },
  }), { code: 'idempotency_conflict', status: 409 });
});
