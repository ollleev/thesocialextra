import http from 'node:http';
import path from 'node:path';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ApiError } from './domain.mjs';
import { normalizeVoice, VOICE_LIMITS } from './audio-processing.mjs';

const fail = (status, code) => { throw new ApiError(status, code); };
const TYPES = /^audio\/(webm|ogg|mp4)(?:\s*;\s*codecs=(?:"[a-zA-Z0-9., -]+"|[a-zA-Z0-9.,-]+))?$/i;

function validateHeaders(req) {
  const seen = new Set();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i].toLowerCase();
    if (['content-type', 'content-length', 'content-encoding', 'transfer-encoding'].includes(key)) {
      if (seen.has(key)) fail(400, 'invalid_audio_headers');
      seen.add(key);
    }
  }
  const type = req.headers['content-type'];
  if (typeof type !== 'string' || type.length > 120 || /[\0\r\n]/.test(type) || !TYPES.test(type)) fail(415, 'unsupported_audio_type');
  if (req.headers['content-encoding'] !== undefined) fail(415, 'unsupported_audio_encoding');
  if (req.headers['content-length'] !== undefined) {
    const value = req.headers['content-length'];
    if (!/^[0-9]+$/.test(value)) fail(400, 'invalid_audio_headers');
    if (Number(value) > VOICE_LIMITS.inputBytes) fail(413, 'audio_too_large');
  }
  return type;
}

/** Internal Unix-socket service only. The socket ACL and OS service sandbox are
 * the trust boundary; never expose this unauthenticated worker as a public API.
 */
export function createVoiceWorker({ normalize = normalizeVoice, bodyTimeoutMs = 5000 } = {}) {
  if (typeof normalize !== 'function' || !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1) throw new TypeError('Invalid worker configuration');
  let admitted = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Connection', 'close');
    let timer, ownsSlot = false;
    // A rejected oversized body is not drained into memory; close after its
    // response has flushed. The caller must open a fresh socket for a retry.
    res.once('finish', () => { if (!req.complete) req.socket.destroy(); });
    try {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
      }
      if (req.method !== 'POST' || req.url !== '/normalize') fail(404, 'not_found');
      const contentType = validateHeaders(req);
      if (admitted) fail(429, 'audio_busy');
      admitted = true; ownsSlot = true;
      // No unbounded queue of upload buffers or decoder processes.
      timer = setTimeout(() => req.destroy(), bodyTimeoutMs);
      const chunks = []; let length = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > VOICE_LIMITS.inputBytes) fail(413, 'audio_too_large');
        chunks.push(chunk);
      }
      clearTimeout(timer);
      if (!length) fail(400, 'invalid_audio');
      const output = await normalize(Buffer.concat(chunks, length), { contentType });
      if (!Buffer.isBuffer(output.bytes) || !output.bytes.length || output.bytes.length > VOICE_LIMITS.outputBytes ||
          output.contentType !== 'audio/ogg; codecs=opus' || !Number.isSafeInteger(output.durationMs) || output.durationMs < 1 || output.durationMs > VOICE_LIMITS.durationMs) fail(500, 'audio_processing_failed');
      res.writeHead(200, { 'Content-Type': output.contentType, 'Content-Length': output.bytes.length, 'X-Audio-Duration-Ms': output.durationMs });
      res.end(output.bytes);
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const status = error instanceof ApiError ? error.status : 500;
        const code = error instanceof ApiError ? error.code : 'audio_processing_failed';
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: code }));
      }
    } finally {
      clearTimeout(timer);
      if (ownsSlot) admitted = false;
    }
  });
  server.headersTimeout = 5000; server.requestTimeout = 10_000; server.keepAliveTimeout = 1;
  server.maxConnections = 4;
  return server;
}

/** The web process calls this client; it never starts an FFmpeg child itself. */
export function normalizeViaWorker(bytes, { contentType, socketPath, timeoutMs = 20_000 } = {}) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > VOICE_LIMITS.inputBytes) return Promise.reject(new ApiError(413, 'audio_too_large'));
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.length > 100 || /[\0\r\n]/.test(socketPath)) throw new TypeError('A trusted absolute Unix socket path is required');
  if (typeof contentType !== 'string' || contentType.length > 120 || /[\0\r\n]/.test(contentType) || !TYPES.test(contentType)) return Promise.reject(new ApiError(415, 'unsupported_audio_type'));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('Invalid worker timeout');
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (!done) { done = true; clearTimeout(timer); error ? reject(error) : resolve(value); } };
    const req = http.request({ socketPath, path: '/normalize', method: 'POST', agent: false,
      headers: { 'Content-Type': contentType, 'Content-Length': bytes.length } }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        const limit = res.statusCode === 200 ? VOICE_LIMITS.outputBytes : 2048;
        if (length > limit) { finish(new ApiError(502, 'audio_worker_invalid_response')); res.destroy(); }
        else chunks.push(chunk);
      });
      res.on('error', () => finish(new ApiError(503, 'audio_processing_unavailable')));
      res.on('end', () => {
        if (done) return;
        const body = Buffer.concat(chunks, length);
        if (res.statusCode !== 200) {
          let error;
          try { error = JSON.parse(body.toString('utf8')).error; } catch { /* Never expose worker diagnostics. */ }
          const allowed = new Set(['audio_too_large', 'audio_too_long', 'invalid_audio', 'unsupported_audio_type', 'audio_busy', 'audio_processing_timeout', 'audio_processing_unavailable', 'audio_processing_limit', 'audio_processing_failed', 'audio_cleanup_failed']);
          const status = Number.isInteger(res.statusCode) && res.statusCode >= 400 && res.statusCode <= 599 ? res.statusCode : 502;
          finish(new ApiError(status, allowed.has(error) ? error : 'audio_processing_failed')); return;
        }
        const durationMs = Number(res.headers['x-audio-duration-ms']);
        if (res.headers['content-type'] !== 'audio/ogg; codecs=opus' || !Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > VOICE_LIMITS.durationMs || body.length < 27 || body.toString('ascii', 0, 4) !== 'OggS') {
          finish(new ApiError(502, 'audio_worker_invalid_response')); return;
        }
        finish(null, { bytes: body, contentType: 'audio/ogg; codecs=opus', durationMs });
      });
    });
    const timer = setTimeout(() => { finish(new ApiError(504, 'audio_processing_timeout')); req.destroy(); }, timeoutMs);
    req.on('error', () => finish(new ApiError(503, 'audio_processing_unavailable')));
    req.end(bytes);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const socketPath = process.env.VOICE_SOCKET || '/run/thesocialextra-voice/worker.sock';
  if (!path.isAbsolute(socketPath) || socketPath.length > 100 || /[\0\r\n]/.test(socketPath)) throw new Error('Invalid Unix socket path');
  const directory = await lstat(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o007) throw new Error('Private runtime directory required');
  // Do not unlink an unknown/live socket. systemd owns the runtime directory.
  try { await lstat(socketPath); throw new Error('Socket already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = createVoiceWorker();
  server.listen(socketPath, async () => { await chmod(socketPath, 0o660); console.log('Private voice worker ready.'); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    server.close(async () => { await unlink(socketPath).catch(() => {}); process.exit(0); });
    setTimeout(() => process.exit(0), 20_000).unref();
  });
}
