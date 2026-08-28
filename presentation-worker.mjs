import http from 'node:http';
import path from 'node:path';
import {chmod,lstat,unlink} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ApiError} from './domain.mjs';
import {presentationHeaders,readPresentationBody,PRESENTATION_INPUT_LIMITS} from './presentation-http.mjs';

const fail=(status,code)=>{throw new ApiError(status,code);};
const OUTPUT={photo:{bytes:1024**2,type:'image/jpeg',dimension:1600},video:{bytes:8*1024**2,type:'video/mp4',dimension:720}};
function validOutput(kind,output) {
 const limit=OUTPUT[kind];
 return limit&&Buffer.isBuffer(output.bytes)&&output.bytes.length>0&&output.bytes.length<=limit.bytes&&output.contentType===limit.type&&
  Number.isSafeInteger(output.width)&&Number.isSafeInteger(output.height)&&output.width>0&&output.height>0&&output.width<=limit.dimension&&output.height<=limit.dimension&&
  (kind==='photo'?(output.durationMs===undefined||output.durationMs===null):Number.isSafeInteger(output.durationMs)&&output.durationMs>0&&output.durationMs<=15000);
}
function socket(value) {
 if(typeof value!=='string'||!path.isAbsolute(value)||value.length>100||/[\0\r\n]/.test(value))throw new TypeError('A trusted absolute Unix socket is required');
 return value;
}

/** Internal HTTP over an ACL-protected Unix socket, never a public listener.
 * One slot covers both media kinds, including body reads; there is no queue.
 * The OS unit must bound memory, CPU and temporary disk and deny app data.
 */
export function createPresentationWorker({normalizePhoto,normalizeVideo,bodyTimeoutMs=5000}={}) {
 if(typeof normalizePhoto!=='function'||typeof normalizeVideo!=='function'||!Number.isSafeInteger(bodyTimeoutMs)||bodyTimeoutMs<1||bodyTimeoutMs>20000)throw new TypeError('Media normalizers and a bounded timeout required');
 let admitted=false;
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Connection','close');
  res.once('finish',()=>{if(!req.complete)req.socket.destroy();});
  let ownsSlot=false;
  try {
   if(req.method==='GET'&&req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{"ok":true}');}
   const route=req.url?.match(/^\/normalize\/(photo|video)$/);
   if(req.method!=='POST'||!route)fail(404,'not_found');
   const kind=route[1];presentationHeaders(req,kind);
   if(admitted)fail(429,'presentation_busy');admitted=true;ownsSlot=true;
   const source=await readPresentationBody(req,kind,bodyTimeoutMs);
   const output=await(kind==='photo'?normalizePhoto:normalizeVideo)(source.bytes,{contentType:source.contentType});
   if(!validOutput(kind,output))fail(500,'presentation_processing_failed');
   res.writeHead(200,{'Content-Type':output.contentType,'Content-Length':output.bytes.length,'X-Media-Width':output.width,'X-Media-Height':output.height,
    ...(kind==='video'?{'X-Media-Duration-Ms':output.durationMs}:{})});res.end(output.bytes);
  } catch(error) {
   if(!res.destroyed&&!res.writableEnded){res.writeHead(error instanceof ApiError?error.status:500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error instanceof ApiError?error.code:'presentation_processing_failed'}));}
  } finally {if(ownsSlot)admitted=false;}
 });
 server.headersTimeout=5000;server.requestTimeout=10000;server.keepAliveTimeout=1;server.maxConnections=4;
 return server;
}

/** This client never spawns native decoders in the web process. */
export function presentationViaWorker(bytes,{kind,contentType,socketPath,timeoutMs=25000}={}) {
 socket(socketPath);
 if(!Object.hasOwn(OUTPUT,kind))throw new TypeError('Unknown media kind');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new TypeError('Bounded worker timeout required');
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>PRESENTATION_INPUT_LIMITS[kind])return Promise.reject(new ApiError(413,'presentation_input_too_large'));
 try{presentationHeaders({headers:{'content-type':contentType},rawHeaders:['content-type',contentType]},kind);}catch(error){return Promise.reject(error);}
 return new Promise((resolve,reject)=>{
  let done=false,timer;
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);};
  const req=http.request({socketPath,path:`/normalize/${kind}`,method:'POST',agent:false,headers:{'Content-Type':contentType,'Content-Length':bytes.length}},res=>{
   const chunks=[];let length=0;
   res.on('data',chunk=>{length+=chunk.length;if(length>(res.statusCode===200?OUTPUT[kind].bytes:2048)){finish(new ApiError(502,'presentation_worker_invalid_response'));res.destroy();}else chunks.push(chunk);});
   res.on('error',()=>finish(new ApiError(503,'presentation_processing_unavailable')));
   res.on('end',()=>{
    if(done)return;const bytes=Buffer.concat(chunks,length);
    if(res.statusCode!==200) {
     let code;try{code=JSON.parse(bytes.toString('utf8')).error;}catch{/* Diagnostics never cross this boundary. */}
     const allowed=new Set(['presentation_busy','presentation_input_too_large','invalid_presentation_asset','unsupported_presentation_type',
      ...['image','video'].flatMap(prefix=>[`invalid_${prefix}`,`${prefix}_too_large`,`${prefix}_too_long`,`${prefix}_busy`,`${prefix}_dimensions_exceeded`,
       `${prefix}_processing_timeout`,`${prefix}_processing_unavailable`,`${prefix}_processing_limit`,`${prefix}_processing_failed`,`${prefix}_cleanup_failed`]),
      'animated_image_not_supported','unsupported_image_type','unsupported_video_type','video_color_unsupported','video_frame_rate_exceeded']);
     const status=Number.isInteger(res.statusCode)&&res.statusCode>=400&&res.statusCode<=599?res.statusCode:502;
     return finish(new ApiError(status,allowed.has(code)?code:'presentation_processing_failed'));
    }
    const output={bytes,contentType:res.headers['content-type'],width:Number(res.headers['x-media-width']),height:Number(res.headers['x-media-height']),
     ...(kind==='video'?{durationMs:Number(res.headers['x-media-duration-ms'])}:{})};
    if(!validOutput(kind,output))return finish(new ApiError(502,'presentation_worker_invalid_response'));
    finish(null,output);
   });
  });
  timer=setTimeout(()=>{finish(new ApiError(504,'presentation_processing_timeout'));req.destroy();},timeoutMs);
  req.on('error',()=>finish(new ApiError(503,'presentation_processing_unavailable')));req.end(bytes);
 });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const socketPath=socket(process.env.PRESENTATION_SOCKET||'/run/thesocialextra-presentation/worker.sock');
 const directory=await lstat(path.dirname(socketPath));
 if(!directory.isDirectory()||directory.isSymbolicLink()||directory.mode&0o007)throw new Error('Private runtime directory required');
 try{await lstat(socketPath);throw new Error('Socket already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 // Load both processors before advertising readiness. They receive no user paths.
 const [{createImageNormalizer},{createVideoNormalizer}]=await Promise.all([import('./image-processing.mjs'),import('./video-processing.mjs')]);
 const server=createPresentationWorker({normalizePhoto:createImageNormalizer(),normalizeVideo:createVideoNormalizer()});
 server.listen(socketPath,async()=>{await chmod(socketPath,0o660);console.log('Private presentation worker ready.');});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
  server.close(async()=>{await unlink(socketPath).catch(()=>{});process.exit(0);});setTimeout(()=>process.exit(0),30000).unref();
 });
}
