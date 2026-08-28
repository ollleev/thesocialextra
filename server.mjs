import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, LiveStore, ZONES, ROLE_GROUPS } from './domain.mjs';
import { searchLocations, nearestLocation, getLocation, LocationError } from './locations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MUTATING = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
const MAX_BODY = 8192;
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
}
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function originGuard(req) {
  const host = req.headers.host;
  let url;
  try { url = new URL(`http://${host}`); } catch { throw new ApiError(403, 'invalid_host'); }
  if (!host || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.host !== host.toLowerCase()) throw new ApiError(403, 'invalid_host');
  if (MUTATING.has(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw new ApiError(403, 'cross_origin_denied');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'cross_origin_denied');
  }
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new ApiError(415, 'json_required');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new ApiError(413, 'body_too_large');
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new ApiError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json'); }
}

export function createLiveServer({ store = new LiveStore(), publicDir = path.join(HERE, 'public'), sweepIntervalMs = 1000, rateLimit = 120, rateWindowMs = 60_000 } = {}) {
  const streams = new Set();
  const rates = new Map();
  const staticRoot = path.resolve(publicDir);
  function checkRate(req) {
    const now = Date.now(), key = req.socket.remoteAddress || 'local';
    for (const [ip, entry] of rates) if (entry.until <= now) rates.delete(ip);
    let entry = rates.get(key);
    if (!entry) {
      if (rates.size >= 1000) throw new ApiError(429, 'rate_limit');
      entry = { count: 0, until: now + rateWindowMs };
      rates.set(key, entry);
    }
    if (++entry.count > rateLimit) throw new ApiError(429, 'rate_limit');
  }
  function sendState(res, state) {
    if (res.destroyed || res.writableEnded) { streams.delete(res); return; }
    if (res.writableLength > 256 * 1024) {
      // A slow consumer must not accumulate unbounded state snapshots.
      streams.delete(res);
      res.destroy();
      return;
    }
    // A snapshot can exceed the stream high-water mark; allow it to drain instead
    // of disconnecting healthy readers merely because a state is large.
    res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  }
  const unsubscribe = store.subscribe(state => { for (const res of streams) sendState(res, state); });
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      originGuard(req);
      if (MUTATING.has(req.method)) checkRate(req);
      const { pathname, searchParams } = new URL(req.url, `http://${req.headers.host}`);
      const ownerToken = req.headers['x-owner-token'];
      const chatToken = req.headers['x-chat-token'];
      if (req.method === 'GET' && pathname === '/api/state') return json(res, 200, store.state());
      if (req.method === 'GET' && pathname === '/api/zones') return json(res, 200, ZONES);
      if (req.method === 'GET' && pathname === '/api/roles') return json(res, 200, ROLE_GROUPS);
      if (req.method === 'GET' && pathname === '/api/locations') {
        checkRate(req);
        return json(res, 200, searchLocations(searchParams.get('q')));
      }
      const locationRoute = pathname.match(/^\/api\/locations\/([0-9]{1,12})$/);
      if (req.method === 'GET' && locationRoute) {
        checkRate(req);
        return json(res, 200, { location: getLocation(locationRoute[1]) });
      }
      if (req.method === 'GET' && pathname === '/api/locations/nearest') {
        checkRate(req);
        const lat = searchParams.get('lat'), lng = searchParams.get('lng');
        if (!lat?.trim() || !lng?.trim()) throw new ApiError(400, 'invalid_coordinates');
        return json(res, 200, nearestLocation({ lat: Number(lat), lng: Number(lng) }));
      }
      if (req.method === 'GET' && pathname === '/api/events') {
        if (streams.size >= 64) throw new ApiError(429, 'stream_capacity_reached');
        const state = store.state();
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        streams.add(res);
        res.on('close', () => streams.delete(res));
        sendState(res, state);
        return;
      }
      if (req.method === 'POST' && pathname === '/api/posts') return json(res, 201, store.create(await body(req)));
      // Private capability batch; POST keeps credentials out of query strings.
      if (req.method === 'POST' && pathname === '/api/updates') return json(res, 200, store.updates(await body(req)));
      const postRoute = pathname.match(/^\/api\/posts\/([a-zA-Z0-9-]+)(?:\/(contact|threads))?$/);
      if (postRoute) {
        const [, id, operation] = postRoute;
        if (req.method === 'PATCH' && !operation) return json(res, 200, store.mutate(id, ownerToken, await body(req), req.headers['idempotency-key']));
        if (req.method === 'DELETE' && !operation) { store.remove(id, ownerToken); res.writeHead(204); return res.end(); }
        if (req.method === 'POST' && operation === 'contact') return json(res, 201, store.contact(id, await body(req)));
        if (req.method === 'GET' && operation === 'threads') return json(res, 200, store.inbox(id, ownerToken));
      }
      const threadRoute = pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]+)(?:\/(messages))?$/);
      if (threadRoute) {
        const [, id, operation] = threadRoute;
        if (req.method === 'GET' && !operation) return json(res, 200, store.readThread(id, chatToken));
        if (req.method === 'POST' && operation === 'messages') return json(res, 201, store.addMessage(id, chatToken, await body(req), req.headers['idempotency-key']));
      }
      if (pathname.startsWith('/api/')) throw new ApiError(404, 'route_not_found');
      if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, 'method_not_allowed');
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { throw new ApiError(400, 'invalid_path'); }
      if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').some(part => part.startsWith('.'))) throw new ApiError(404, 'not_found');
      const relative = decoded === '/' ? 'index.html' : decoded.slice(1);
      const filename = path.resolve(staticRoot, relative);
      if (!filename.startsWith(`${staticRoot}${path.sep}`)) throw new ApiError(404, 'not_found');
      const extension = path.extname(filename);
      if (!MIME[extension]) throw new ApiError(404, 'not_found');
      let bytes;
      try {
        const [realFile, realRoot] = await Promise.all([realpath(filename), realpath(staticRoot)]);
        if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new ApiError(404, 'not_found');
        bytes = await readFile(realFile);
      } catch { throw new ApiError(404, 'not_found'); }
      res.writeHead(200, { 'Content-Type': MIME[extension], 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) { res.destroy(); return; }
      const expected = error instanceof ApiError || error instanceof LocationError;
      const status = expected ? error.status : 500;
      if (status === 429) res.setHeader('Retry-After', String(Math.ceil(rateWindowMs / 1000)));
      json(res, status, { error: expected ? error.code : 'internal_error' });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  server.maxConnections = 128;
  const sweepTimer = setInterval(() => store.sweep(), sweepIntervalMs);
  sweepTimer.unref();
  const heartbeat = setInterval(() => {
    for (const res of streams) {
      if (res.destroyed || res.writableLength > 256 * 1024) { streams.delete(res); res.destroy(); }
      else res.write(': heartbeat\n\n');
    }
  }, 15_000);
  heartbeat.unref();
  function dispose() {
    clearInterval(sweepTimer); clearInterval(heartbeat); unsubscribe();
    for (const res of streams) res.end();
    streams.clear();
  }
  server.once('close', dispose);
  return { server, store, async close() {
    dispose();
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    });
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4178);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const app = createLiveServer();
  app.server.on('error', error => { console.error(`Server startup failed: ${error.code || 'unknown_error'}`); process.exitCode = 1; });
  app.server.listen(port, '127.0.0.1', () => console.log(`Extras local demo: http://127.0.0.1:${port} — volatile synthetic data`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().catch(() => { process.exitCode = 1; }); });
}
