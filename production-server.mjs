import http from 'node:http';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError, ZONES, ROLE_GROUPS, fields, validateIdempotencyKey } from './domain.mjs';
import { searchLocations, nearestLocation, getLocation, LocationError } from './locations.mjs';
import { AuthService } from './auth.mjs';
import { ProductionStore } from './production-store.mjs';
import { openDatabase } from './database.mjs';
import { readVoiceBody, sendVoice } from './voice-http.mjs';
import { normalizeViaWorker } from './voice-worker.mjs';
import { RULES, rulesDocument } from './rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MUTATING = new Set(['POST', 'PATCH', 'DELETE', 'PUT']);
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.txt':'text/plain; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.ico':'image/x-icon', '.woff2':'font/woff2', '.ttf':'font/ttf', '.webmanifest':'application/manifest+json' };
const fail = (status, code) => { throw new ApiError(status, code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const normalizeIp = address => address?.startsWith('::ffff:') ? address.slice(7) : address;
function configuredOrigin(value, allowLocalHttp) {
  let url; try { url = new URL(value); } catch { throw new TypeError('A canonical PUBLIC_ORIGIN is required'); }
  if (url.origin !== value || url.username || url.password) throw new TypeError('PUBLIC_ORIGIN must be a canonical origin without a path');
  const local = url.protocol === 'http:' && allowLocalHttp && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new TypeError('HTTPS required outside explicit local HTTP mode');
  return { url, secure: !local };
}
function securityHeaders(res, secure, voiceEnabled) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', `geolocation=(self), camera=(), microphone=(${voiceEnabled ? 'self' : ''})`);
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415,'json_required');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415,'unsupported_encoding');
  if (Number(req.headers['content-length']) > 8192) fail(413,'body_too_large');
  const chunks=[]; let length=0;
  // Do not destroy the request iterator on rejection: allow the error response,
  // then close this connection without buffering the remaining body.
  for await (const chunk of req.iterator({ destroyOnReturn:false })) {
    length+=chunk.length;
    if(length>8192) fail(413,'body_too_large');
    chunks.push(chunk);
  }
  let value; try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); } catch { fail(400,'invalid_json'); }
  if (!value || typeof value!=='object' || Array.isArray(value)) fail(400,'invalid_body');
  return value;
}
function cookieToken(req, name) {
  const raw=req.headers.cookie;
  if(raw===undefined) return null;
  if(typeof raw!=='string' || raw.length>4096) fail(400,'invalid_cookie');
  const values=new Map();
  for(const part of raw.split(';')) {
    const item=part.trim(), index=item.indexOf('=');
    if(index<1) fail(400,'invalid_cookie');
    const key=item.slice(0,index), value=item.slice(index+1);
    if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[^\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]/.test(value) || values.has(key)) fail(400,'invalid_cookie');
    values.set(key,value);
  }
  const token=values.get(name);
  if(token===undefined) return null;
  if(token.length!==64 || /[^a-f0-9]/.test(token)) fail(400,'invalid_cookie');
  return token;
}
function scopeFrom(params) {
  const allowed=new Set(['cityId','lat','lng','mine']);
  for(const key of params.keys()) if(!allowed.has(key) || params.getAll(key).length!==1) fail(400,'invalid_scope');
  const cityId=params.get('cityId')??'2988507', mine=params.get('mine')??'false';
  if(!['true','false','1','0'].includes(mine)) fail(400,'invalid_scope');
  let point;
  if(params.has('lat')||params.has('lng')) {
    if(!params.get('lat')?.trim() || !params.get('lng')?.trim()) fail(400,'invalid_coordinates');
    point={lat:Number(params.get('lat')),lng:Number(params.get('lng'))};
  }
  return {cityId,point,mine:mine==='true'||mine==='1'};
}

/** HTTPS terminates at the configured reverse proxy; never expose this listener directly. */
export function createProductionServer({ db, publicOrigin, publicDir=path.join(HERE,'public'), clock=Date.now,
  authOptions={}, moderators=[], allowLocalHttp=false, trustedProxyAddresses=[], voiceSocketPath=null, testVoiceProcessor,
  rateLimit=240, mutationRateLimit=60, accountRateLimit=120, authRateLimit=15, authAccountRateLimit=10,
  rateWindowMs=60_000, authWindowMs=15*60_000, rateMaxEntries=10000,
  maxBlocksPerUser=500, maxTotalBlocks=100000,
  maxStreams=256, maxStreamsPerIp=8, sweepIntervalMs=1000, heartbeatIntervalMs=15_000 }={}) {
  const {url:origin,secure}=configuredOrigin(publicOrigin,allowLocalHttp);
  if(authOptions.testRules!==undefined)throw new TypeError('The HTTP server always uses the verified rules document');
  const verifiedRulesBytes=rulesDocument();
  if(voiceSocketPath!==null && (typeof voiceSocketPath!=='string'||!path.isAbsolute(voiceSocketPath)||voiceSocketPath.length>100||/[\0\r\n]/.test(voiceSocketPath))) throw new TypeError('A trusted absolute voice socket is required');
  if(testVoiceProcessor!==undefined && (!process.env.NODE_TEST_CONTEXT || typeof testVoiceProcessor!=='function')) throw new TypeError('Voice injection is for the native test runner only');
  const processVoice=testVoiceProcessor??((bytes,options)=>normalizeViaWorker(bytes,{...options,socketPath:voiceSocketPath}));
  let voiceAdmitted=false;
  for(const value of [rateLimit,mutationRateLimit,accountRateLimit,authRateLimit,authAccountRateLimit,rateWindowMs,authWindowMs,rateMaxEntries,maxStreams,maxStreamsPerIp,sweepIntervalMs,heartbeatIntervalMs])
    if(!Number.isSafeInteger(value)||value<1) throw new TypeError('Limits and intervals must be positive integers');
  const trusted=new Set(trustedProxyAddresses.map(normalizeIp));
  if([...trusted].some(ip=>!isIP(ip))) throw new TypeError('Trusted proxies must be exact IP addresses');
  const auth=new AuthService({...authOptions,db,clock}), store=new ProductionStore({db,clock,moderators,maxBlocksPerUser,maxTotalBlocks,hasAcceptedRules:userId=>auth.hasAcceptedRules(userId)});
  const moderatorIds=new Set(moderators), cookieName=secure?'__Host-extra_session':'extra_session';
  const staticRoot=path.resolve(publicDir), rates=new Map(), streams=new Set();
  let disposed=false, scheduled=false, broadcasting=false, privateScheduled=false;
  const privateReaders=new Set();
  function rate(key, limit, windowMs=rateWindowMs) {
    const now=clock();
    // A bounded map also bounds random-username attacks on the authentication limiter.
    for(const [id,entry] of rates) if(entry.until<=now) rates.delete(id);
    let entry=rates.get(key);
    if(!entry) { if(rates.size>=rateMaxEntries) fail(429,'rate_limit'); entry={count:0,until:now+windowMs}; rates.set(key,entry); }
    if(++entry.count>limit) {const error=new ApiError(429,'rate_limit');error.retryAfter=Math.max(1,Math.ceil((entry.until-now)/1000));throw error;}
  }
  function clientIp(req) {
    const remote=normalizeIp(req.socket.remoteAddress)||'unknown';
    const forwarded=req.headers['x-forwarded-for'];
    if(trusted.has(remote)&&forwarded!==undefined) {
      // The proxy must replace XFF with exactly one validated client IP.
      if(typeof forwarded!=='string'||!isIP(forwarded.trim())) fail(400,'invalid_forwarded_address');
      return normalizeIp(forwarded.trim());
    }
    return remote;
  }
  function setSession(res,token) {
    res.setHeader('Set-Cookie',`${cookieName}=${token??''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token?30*24*60*60:0}${secure?'; Secure':''}`);
  }
  function requireUser(user) { if(!user) fail(401,'login_required'); return user.id; }
  function intentKey(req) {
    const key=req.headers['idempotency-key'];
    if(typeof key!=='string'||key.length<16||key.length>128||/[^a-zA-Z0-9_-]/.test(key)) fail(400,'invalid_idempotency_key');
    validateIdempotencyKey(key);return key;
  }
  function validStream(stream) {
    if(stream.res.destroyed||stream.res.writableEnded) { streams.delete(stream);return false; }
    if(stream.res.writableLength>256*1024) { streams.delete(stream);stream.res.destroy();return false; }
    let current;try{current=stream.userId?auth.session(stream.token):null;}catch{stream.res.end('event: unavailable\ndata: {}\n\n');streams.delete(stream);return false;}
    if(stream.userId && current?.id!==stream.userId) {
      stream.res.end('event: session-expired\ndata: {}\n\n');streams.delete(stream);return false;
    }
    return true;
  }
  function sendState(stream) {
    if(!validStream(stream)) return;
    try { const snapshot=store.state(stream.scope,stream.userId);stream.res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`); }
    catch { stream.res.end('event: unavailable\ndata: {}\n\n');streams.delete(stream); }
  }
  function scheduleState() {
    if(disposed||scheduled||broadcasting) return;
    scheduled=true;
    queueMicrotask(()=>{
      scheduled=false;if(disposed)return;
      broadcasting=true;
      try { for(const stream of streams) sendState(stream); }
      finally { broadcasting=false; }
    });
  }
  const unsubscribe=store.subscribe(scheduleState);
  const unsubscribePrivate=store.subscribePrivate(userId=>{
    if(disposed)return;
    privateReaders.add(userId);
    if(privateScheduled)return;
    privateScheduled=true;
    queueMicrotask(()=>{
      privateScheduled=false;
      const readers=new Set(privateReaders);privateReaders.clear();
      if(disposed)return;
      // A reader's block must refresh all of their sessions, but reveal neither
      // its occurrence nor a version change to anonymous or unrelated streams.
      for(const stream of streams)if(readers.has(stream.userId))sendState(stream);
    });
  });
  const server=http.createServer(async(req,res)=>{
    securityHeaders(res,secure,Boolean(voiceSocketPath));
    try {
      const singletonHeaders=new Set(['host','origin','cookie','idempotency-key','content-type','content-length','content-encoding','transfer-encoding']),seenHeaders=new Set();
      for(let i=0;i<req.rawHeaders.length;i+=2){const name=req.rawHeaders[i].toLowerCase();if(singletonHeaders.has(name)&&seenHeaders.has(name))fail(400,'duplicate_header');seenHeaders.add(name);}
      if(req.headers.host!==origin.host) fail(403,'invalid_host');
      if(!req.url?.startsWith('/')||req.url.startsWith('//')||req.url.length>4096) fail(400,'invalid_path');
      if(MUTATING.has(req.method)) {
        if(req.headers.origin!==publicOrigin) fail(403,'cross_origin_denied');
        const site=req.headers['sec-fetch-site'];
        if(site!==undefined&&site!=='same-origin'&&site!=='none') fail(403,'cross_origin_denied');
      } else if(req.headers['sec-fetch-site']==='cross-site' && req.url.startsWith('/api/')) fail(403,'cross_origin_denied');
      const ip=clientIp(req);rate(`ip:${ip}`,rateLimit);
      if(MUTATING.has(req.method)) rate(`mutation:${ip}`,mutationRateLimit);
      const {pathname,searchParams}=new URL(req.url,publicOrigin);
      const token=cookieToken(req,cookieName),user=auth.session(token);
      // Recheck after awaiting a body: logout/recovery/expiry may have happened
      // while a slow request was uploading. Never authorize writes from stale user data.
      const currentUserId=()=>requireUser(auth.session(token));
      if(user&&pathname.startsWith('/api/')) rate(`account:${user.id}`,accountRateLimit);
      if(req.method==='GET'&&pathname==='/api/session') return json(res,200,{mode:'production',user,ownership:user?store.ownership(user.id):[],moderator:Boolean(user&&moderatorIds.has(user.id)),rules:auth.rulesStatus(user?.id),...(voiceSocketPath?{features:{voice:true}}:{})});
      if(req.method==='POST'&&pathname==='/api/account/rules-acceptance') {
        requireUser(user);const input=await body(req);
        return json(res,200,auth.acceptRules(currentUserId(),input));
      }
      if(req.method==='GET'&&pathname==='/api/blocks') {
        const actor=requireUser(user);
        for(const name of searchParams.keys())if(name!=='cursor'||searchParams.getAll(name).length!==1)fail(400,'invalid_cursor');
        return json(res,200,store.listBlocks(actor,{cursor:searchParams.get('cursor')}));
      }
      const blockRoute=pathname.match(/^\/api\/blocks\/([a-f0-9-]{36})$/);
      if(req.method==='DELETE'&&blockRoute)return json(res,200,store.unblock(requireUser(user),blockRoute[1]));
      const authRoute=pathname.match(/^\/api\/auth\/(register|login|recover|logout)$/);
      if(req.method==='POST'&&authRoute) {
        const action=authRoute[1];if(action!=='logout')rate(`auth-ip:${ip}`,authRateLimit,authWindowMs);
        const input=await body(req);
        if(action==='logout') { fields(input,[]);auth.logout(token);setSession(res,null);return json(res,200,{user:null}); }
        if(typeof input.username==='string') rate(`auth-name:${hash(input.username.toLowerCase())}`,authAccountRateLimit,authWindowMs);
        else if(action==='recover') rate(`auth-recovery:${hash(typeof input.recoveryCode==='string'?input.recoveryCode:'invalid-recovery-code')}`,authAccountRateLimit,authWindowMs);
        const result=await auth[action](input);
        auth.logout(token);setSession(res,result.sessionToken);
        return json(res,action==='register'?201:200,{user:result.user,rules:result.rules,...(result.recoveryCode?{recoveryCode:result.recoveryCode}:{})});
      }
      if(req.method==='DELETE'&&pathname==='/api/account') {
        requireUser(user);rate(`auth-ip:${ip}`,authRateLimit,authWindowMs);rate(`auth-name:${hash(user.username)}`,authAccountRateLimit,authWindowMs);
        const input=await body(req);fields(input,['password']);currentUserId();
        const verification=await auth.login({username:user.username,password:input.password});
        try { store.transaction(()=>{store.eraseAccountData(user.id);auth.deleteAccount(user.id);}); }
        catch(error) { auth.logout(verification.sessionToken);throw error; }
        setSession(res,null);res.writeHead(204);return res.end();
      }
      if(req.method==='GET'&&(pathname==='/api/state'||pathname==='/api/events')) {
        const scope=scopeFrom(searchParams);if(scope.mine)requireUser(user);
        if(pathname==='/api/state') return json(res,200,store.state(scope,user?.id));
        if(streams.size>=maxStreams||[...streams].filter(s=>s.ip===ip).length>=maxStreamsPerIp) fail(429,'stream_capacity_reached');
        const snapshot=store.state(scope,user?.id);
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8',Connection:'keep-alive','X-Accel-Buffering':'no'});
        const stream={res,scope,token,userId:user?.id,ip};streams.add(stream);res.on('close',()=>streams.delete(stream));
        res.write(`event: state\ndata: ${JSON.stringify(snapshot)}\n\n`);return;
      }
      if(req.method==='GET'&&pathname==='/api/roles') return json(res,200,ROLE_GROUPS);
      if(req.method==='GET'&&pathname==='/api/zones') return json(res,200,ZONES);
      if(req.method==='GET'&&pathname==='/api/locations') return json(res,200,searchLocations(searchParams.get('q')));
      const locationRoute=pathname.match(/^\/api\/locations\/([0-9]{1,12})$/);
      if(req.method==='GET'&&locationRoute) return json(res,200,{location:getLocation(locationRoute[1])});
      if(req.method==='GET'&&pathname==='/api/locations/nearest') {
        const lat=searchParams.get('lat'),lng=searchParams.get('lng');if(!lat?.trim()||!lng?.trim())fail(400,'invalid_coordinates');
        return json(res,200,nearestLocation({lat:Number(lat),lng:Number(lng)}));
      }
      if(req.method==='POST'&&pathname==='/api/posts') { requireUser(user);const key=intentKey(req),input=await body(req);return json(res,201,store.create(currentUserId(),input,key)); }
      if(req.method==='POST'&&pathname==='/api/updates') {
        requireUser(user);const input=await body(req);fields(input,['cursor']);
        if(input.cursor!==undefined&&input.cursor!==null&&(typeof input.cursor!=='string'||input.cursor.length>180))fail(400,'invalid_cursor');
        return json(res,200,store.updates(currentUserId(),input));
      }
      const postRoute=pathname.match(/^\/api\/posts\/([a-zA-Z0-9-]{1,80})(?:\/(contact|threads|block))?$/);
      if(postRoute) {
        const [,id,operation]=postRoute;
        if(req.method==='GET'&&!operation)return json(res,200,store.getPublicPost(id,user?.id));
        const actor=requireUser(user);
        if(req.method==='PATCH'&&!operation) { const key=intentKey(req),input=await body(req);return json(res,200,store.mutate(currentUserId(),id,input,key)); }
        if(req.method==='DELETE'&&!operation) { store.remove(actor,id);res.writeHead(204);return res.end(); }
        if(req.method==='POST'&&operation==='contact') { const key=intentKey(req),input=await body(req);return json(res,201,store.contact(currentUserId(),id,input,key)); }
        if(req.method==='POST'&&operation==='block') { const input=await body(req);fields(input,[]);return json(res,200,store.blockPost(currentUserId(),id)); }
        if(req.method==='GET'&&operation==='threads') {
          const row=store.postRow(id);if(row.owner_id!==actor)fail(403,'owner_required');
          const post=JSON.parse(row.data);
          const rows=db.prepare('SELECT id FROM app_threads WHERE post_id=? AND expires_at>? ORDER BY updated_at DESC,id LIMIT 50').all(id,clock());
          return json(res,200,{threads:rows.map(({id:threadId})=>{const {messages,...thread}=store.readThread(actor,threadId).thread;return {...thread,messageCount:messages.length,role:post.role,zoneLabel:post.zoneLabel,timezone:post.timezone};})});
        }
      }
      const voiceRoute=pathname.match(/^\/api\/voice\/([a-zA-Z0-9-]{1,80})$/);
      if(req.method==='GET'&&voiceRoute) return sendVoice(res,store.getVoice(requireUser(user),voiceRoute[1]));
      const reportVoiceRoute=pathname.match(/^\/api\/moderation\/reports\/([a-zA-Z0-9-]{1,80})\/voice\/([a-zA-Z0-9-]{1,80})$/);
      if(req.method==='GET'&&reportVoiceRoute) return sendVoice(res,store.getReportVoice(requireUser(user),reportVoiceRoute[1],reportVoiceRoute[2]));
      const threadRoute=pathname.match(/^\/api\/threads\/([a-zA-Z0-9-]{1,80})(?:\/(messages|block|voice))?$/);
      if(threadRoute) {
        const [,id,operation]=threadRoute,actor=requireUser(user);
        if(req.method==='GET'&&!operation)return json(res,200,store.readThread(actor,id));
        if(req.method==='POST'&&operation==='voice') {
          if(!voiceSocketPath)fail(404,'route_not_found');
          const key=intentKey(req);
          store.ugcWriter(actor);
          const thread=store.threadAccess(actor,id);
          if(store.blocked(thread.owner_id,thread.guest_id))fail(403,'contact_blocked');
          if(voiceAdmitted)fail(429,'audio_busy');
          voiceAdmitted=true;
          try {
            const source=await readVoiceBody(req), metadata={sourceHash:hash(source.bytes),contentType:source.contentType};
            const replay=store.prepareVoice(currentUserId(),id,metadata,key);
            if(replay)return json(res,201,replay);
            const normalized=await processVoice(source.bytes,{contentType:source.contentType});
            if(req.aborted||res.destroyed)return;
            return json(res,201,store.addVoiceMessage(currentUserId(),id,{...metadata,bytes:normalized.bytes,durationMs:normalized.durationMs},key));
          } finally {voiceAdmitted=false;}
        }
        if(req.method==='POST'&&operation==='messages') { const key=intentKey(req),input=await body(req);return json(res,201,store.addMessage(currentUserId(),id,input,key)); }
        if(req.method==='POST'&&operation==='block') { const input=await body(req);fields(input,['blocked']);if(typeof input.blocked!=='boolean')fail(400,'invalid_block');return json(res,200,store.block(currentUserId(),id,input.blocked)); }
      }
      if(req.method==='POST'&&pathname==='/api/reports') { requireUser(user);const key=intentKey(req),input=await body(req);return json(res,201,store.report(currentUserId(),input,key)); }
      if(req.method==='GET'&&pathname==='/api/moderation/reports')return json(res,200,{reports:store.listReports(requireUser(user))});
      const moderationRoute=pathname.match(/^\/api\/moderation\/reports\/([a-zA-Z0-9-]{1,80})$/);
      if(req.method==='POST'&&moderationRoute) { const actor=requireUser(user),input=await body(req);fields(input,['action']);return json(res,200,store.resolveReport(currentUserId(),moderationRoute[1],input.action)); }
      if(pathname.startsWith('/api/'))fail(404,'route_not_found');
      if(!['GET','HEAD'].includes(req.method))fail(405,'method_not_allowed');
      let decoded;try{decoded=decodeURIComponent(pathname);}catch{fail(400,'invalid_path');}
      if(decoded.includes('\0')||decoded.includes('\\')||decoded.split('/').some(part=>part.startsWith('.')))fail(404,'not_found');
      if(path.posix.normalize(decoded)===RULES.url) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Length':verifiedRulesBytes.length});
        return res.end(req.method==='HEAD'?undefined:verifiedRulesBytes);
      }
      const filename=path.resolve(staticRoot,decoded==='/'?'index.html':decoded.slice(1)),mime=MIME[path.extname(filename)];
      if(!filename.startsWith(`${staticRoot}${path.sep}`)||!mime)fail(404,'not_found');
      let bytes;try{const [file,root]=await Promise.all([realpath(filename),realpath(staticRoot)]);if(!file.startsWith(`${root}${path.sep}`))fail(404,'not_found');bytes=await readFile(file);}catch{fail(404,'not_found');}
      res.writeHead(200,{'Content-Type':mime,'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
    } catch(error) {
      if(res.destroyed||res.writableEnded)return;
      if(res.headersSent){res.destroy();return;}
      const expected=error instanceof ApiError||error instanceof LocationError,status=expected?error.status:500;
      if(status===429)res.setHeader('Retry-After',String(error.retryAfter??(error.code==='auth_busy'?1:Math.ceil(rateWindowMs/1000))));
      if(!req.complete){res.setHeader('Connection','close');req.resume();}
      json(res,status,{error:expected?error.code:'internal_error'});
    }
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;server.maxHeadersCount=40;server.maxConnections=512;
  function failStreams() { for(const stream of streams)stream.res.end('event: unavailable\ndata: {}\n\n');streams.clear(); }
  const sweepTimer=setInterval(()=>{try{store.sweep();}catch{failStreams();}},sweepIntervalMs);sweepTimer.unref();
  const heartbeat=setInterval(()=>{for(const stream of streams)if(validStream(stream))stream.res.write(': heartbeat\n\n');},heartbeatIntervalMs);heartbeat.unref();
  function dispose(){disposed=true;clearInterval(sweepTimer);clearInterval(heartbeat);unsubscribe();unsubscribePrivate();privateReaders.clear();for(const stream of streams)stream.res.end();streams.clear();}
  server.once('close',dispose);
  return {server,store,auth,async close(){dispose();if(!server.listening)return;await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const publicOrigin=process.env.PUBLIC_ORIGIN,allowLocalHttp=process.env.ALLOW_LOCAL_HTTP==='true';
  configuredOrigin(publicOrigin,allowLocalHttp);
  const port=Number(process.env.PORT||4178),host=process.env.HOST||'127.0.0.1';
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be between 1 and 65535');
  if(allowLocalHttp&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('Local HTTP must bind loopback');
  if(!process.env.DATABASE_PATH||!path.isAbsolute(process.env.DATABASE_PATH))throw new Error('An absolute DATABASE_PATH is required');
  const db=openDatabase(process.env.DATABASE_PATH);
  let app;try{app=createProductionServer({db,publicOrigin,allowLocalHttp,voiceSocketPath:process.env.VOICE_SOCKET||null,moderators:(process.env.MODERATOR_IDS||'').split(',').filter(Boolean),trustedProxyAddresses:(process.env.TRUSTED_PROXY_IPS||'').split(',').filter(Boolean)});}catch(error){db.close();throw error;}
  app.server.on('error',error=>{console.error(`Production server startup failed: ${error.code||'unknown_error'}`);app.close().finally(()=>db.close());process.exitCode=1;});
  app.server.listen(port,host,()=>console.log('Production listener ready; use the configured public origin.'));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{app.close().then(()=>db.close()).catch(()=>{process.exitCode=1;});});
}
