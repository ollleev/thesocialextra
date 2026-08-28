import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { ApiError } from '../domain.mjs';
import { createVoiceWorker, normalizeViaWorker } from '../voice-worker.mjs';
import { VOICE_LIMITS } from '../audio-processing.mjs';

const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(32)]);
const result = () => ({ bytes: ogg, contentType: 'audio/ogg; codecs=opus', durationMs: 1000 });
const code = (status, name) => error => error.status === status && error.code === name;
async function fixture(t, options = {}, suppliedServer) {
  // Keep Unix paths below the macOS socket pathname limit.
  const dir = await mkdtemp('/tmp/tse-voice-socket-');
  const socketPath = path.join(dir, 'worker.sock');
  const server = suppliedServer || createVoiceWorker(options);
  server.listen(socketPath); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { socketPath, server, call: (bytes = Buffer.from('synthetic'), extra = {}) => normalizeViaWorker(bytes, { socketPath, contentType: 'audio/webm;codecs=opus', ...extra }) };
}
function request(socketPath, { method = 'POST', route = '/normalize', headers = {}, body = Buffer.from('synthetic') } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, agent: false, headers: { 'Content-Type': 'audio/webm', ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('private Unix transport returns only normalized bytes and bounded duration, without cacheability', async t => {
  let observed;
  const f = await fixture(t, { normalize: async (bytes, options) => { observed = { bytes, options }; return result(); } });
  assert.deepEqual(await f.call(), result());
  assert.equal(observed.bytes.toString(), 'synthetic');
  assert.deepEqual(observed.options, { contentType: 'audio/webm;codecs=opus' });
  const response = await request(f.socketPath);
  assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal((await request(f.socketPath, { method: 'GET', route: '/health', body: undefined })).status, 200);
  assert.equal((await request(f.socketPath, { route: '/normalize?url=http://example.invalid' })).status, 404);
});

test('worker rejects unsupported encoding, types and oversized bodies before normalization', async t => {
  let calls = 0; const f = await fixture(t, { normalize: async () => { calls++; return result(); } });
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }]) assert.equal((await request(f.socketPath, { headers })).status, 415);
  assert.equal((await request(f.socketPath, { headers: { 'Content-Length': String(VOICE_LIMITS.inputBytes + 1) }, body: undefined })).status, 413);
  // An unbounded chunked sender can still be writing when the server closes
  // the rejected connection. Native clients may observe EPIPE before 413.
  try { assert.equal((await request(f.socketPath, { body: Buffer.alloc(VOICE_LIMITS.inputBytes + 1) })).status, 413); }
  catch (error) { assert.equal(error.code, 'EPIPE'); }
  assert.equal((await request(f.socketPath, { body: Buffer.alloc(0) })).status, 400);
  assert.equal(calls, 0);
  await assert.rejects(f.call(Buffer.from('synthetic'), { contentType: 'audio/webm\n' }), code(415, 'unsupported_audio_type'));
});

test('a second upload is refused without buffering or queuing and the slot is released', async t => {
  let release, started, calls = 0;
  const entered = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { normalize: async () => { if (++calls === 1) { started(); await new Promise(resolve => { release = resolve; }); } return result(); } });
  const first = f.call(); await entered;
  await assert.rejects(f.call(), code(429, 'audio_busy'));
  release(); assert.deepEqual(await first, result());
  assert.deepEqual(await f.call(), result());
  assert.equal(calls, 2);
});

test('worker errors retain known codes but never forward arbitrary process diagnostics', async t => {
  const invalid = await fixture(t, { normalize: async () => { throw new ApiError(422, 'audio_too_long'); } });
  await assert.rejects(invalid.call(), code(422, 'audio_too_long'));
  const unknown = await fixture(t, { normalize: async () => { throw new Error('synthetic secret diagnostics'); } });
  await assert.rejects(unknown.call(), error => { assert.equal(error.message, 'audio_processing_failed'); return code(500, 'audio_processing_failed')(error); });
});

test('client refuses corrupt, oversized and metadata-free worker responses', async t => {
  for (const variant of ['corrupt', 'oversized', 'duration']) {
    const server = http.createServer((req, res) => {
      req.resume(); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'audio/ogg; codecs=opus', ...(variant === 'duration' ? {} : { 'X-Audio-Duration-Ms': '1000' }) });
        res.end(variant === 'oversized' ? Buffer.alloc(VOICE_LIMITS.outputBytes + 1) : variant === 'corrupt' ? Buffer.from('invalid') : ogg);
      });
    });
    const f = await fixture(t, {}, server);
    await assert.rejects(f.call(), code(502, 'audio_worker_invalid_response'));
  }
});

test('client timeout covers the entire response and never replays an upload', async t => {
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; req.resume(); res.writeHead(200, { 'Content-Type': 'audio/ogg; codecs=opus', 'X-Audio-Duration-Ms': '1000' }); res.write('OggS'); });
  const f = await fixture(t, {}, server);
  await assert.rejects(f.call(Buffer.from('synthetic'), { timeoutMs: 100 }), code(504, 'audio_processing_timeout'));
  assert.equal(calls, 1);
});

test('slow request bodies lose the worker slot after the deadline', async t => {
  const f = await fixture(t, { normalize: async () => result(), bodyTimeoutMs: 100 });
  const req = http.request({ socketPath: f.socketPath, path: '/normalize', method: 'POST', headers: { 'Content-Type': 'audio/webm', 'Content-Length': '999' } });
  const closed = new Promise(resolve => req.once('error', resolve)); req.write('partial'); await closed;
  assert.deepEqual(await f.call(), result());
});
