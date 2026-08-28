import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {ApiError} from '../domain.mjs';
import {createPresentationWorker,presentationViaWorker} from '../presentation-worker.mjs';

// Transport stubs only; native decoding is tested in processor suites.
const photo=()=>({bytes:Buffer.from([255,216,1,255,217]),contentType:'image/jpeg',width:20,height:10});
const video=()=>({bytes:Buffer.from('0000ftyp0000'),contentType:'video/mp4',width:20,height:10,durationMs:1000});
const code=(status,code)=>error=>error.status===status&&error.code===code;
async function fixture(t,options={},suppliedServer) {
 const directory=await mkdtemp('/tmp/tse-presentation-'),socketPath=path.join(directory,'worker.sock');
 const server=suppliedServer??createPresentationWorker({normalizePhoto:async()=>photo(),normalizeVideo:async()=>video(),...options});
 server.listen(socketPath);await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const call=(kind='photo',options={})=>presentationViaWorker(Buffer.from('synthetic input'),{kind,contentType:kind==='photo'?'image/jpeg':'video/mp4',socketPath,...options});
 return {server,socketPath,call};
}
test('Unix media worker keeps photo and video transport separate and returns bounded metadata',async t=>{
 let observed;const f=await fixture(t,{normalizePhoto:async(bytes,options)=>{observed={bytes,options};return photo();}});
 assert.deepEqual(await f.call(),photo());assert.deepEqual(await f.call('video'),video());
 assert.equal(observed.bytes.toString(),'synthetic input');assert.deepEqual(observed.options,{contentType:'image/jpeg'});
 await assert.rejects(f.call('photo',{contentType:'image/svg+xml'}),code(415,'unsupported_presentation_type'));
 assert.throws(()=>f.call('photo',{socketPath:'relative.sock'}));
});
test('photo and video share one worker slot without queueing; failures release admission',async t=>{
 let entered,release,calls=0;const started=new Promise(resolve=>entered=resolve);
 const f=await fixture(t,{normalizePhoto:async()=>{calls++;entered();await new Promise(resolve=>release=resolve);throw new ApiError(422,'invalid_image');}});
 const pending=f.call();await started;
 try{await assert.rejects(f.call('video'),code(429,'presentation_busy'));assert.equal(calls,1);}finally{release();}
 await assert.rejects(pending,code(422,'invalid_image'));assert.deepEqual(await f.call('video'),video());
});
test('worker rejects unbounded normalized output and hides arbitrary diagnostics',async t=>{
 const bad=await fixture(t,{normalizePhoto:async()=>({...photo(),width:1601})});await assert.rejects(bad.call(),code(500,'presentation_processing_failed'));
 const error=await fixture(t,{normalizeVideo:async()=>{throw new Error('synthetic private diagnostic');}});await assert.rejects(error.call('video'),code(500,'presentation_processing_failed'));
 for(const reason of ['video_color_unsupported','video_frame_rate_exceeded']){
  const rejected=await fixture(t,{normalizeVideo:async()=>{throw new ApiError(422,reason);}});await assert.rejects(rejected.call('video'),code(422,reason));
 }
});
test('client rejects oversized responses and missing video dimensions/duration',async t=>{
 for(const variant of ['oversized','metadata']) {
  const server=http.createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':variant==='oversized'?'image/jpeg':'video/mp4'});res.end(variant==='oversized'?Buffer.alloc(1024**2+1):video().bytes);});});
  const f=await fixture(t,{},server);await assert.rejects(f.call(variant==='oversized'?'photo':'video'),code(502,'presentation_worker_invalid_response'));
 }
});
test('worker client has one overall timeout and never retries a stalled conversion',async t=>{
 let calls=0;const server=http.createServer((req,res)=>{calls++;req.resume();res.writeHead(200,{'Content-Type':'video/mp4'});res.write('partial');});
 const f=await fixture(t,{},server);await assert.rejects(f.call('video',{timeoutMs:100}),code(504,'presentation_processing_timeout'));assert.equal(calls,1);
});
test('slow worker request body times out and releases the shared media slot',async t=>{
 const f=await fixture(t,{bodyTimeoutMs:100});
 const req=http.request({socketPath:f.socketPath,path:'/normalize/photo',method:'POST',headers:{'Content-Type':'image/jpeg','Content-Length':'1000'}});
 const closed=new Promise(resolve=>req.once('error',resolve));req.write('partial');await closed;
 assert.deepEqual(await f.call(),photo());
});
