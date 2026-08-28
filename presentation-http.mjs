import { ApiError } from './domain.mjs';

export const PRESENTATION_INPUT_LIMITS=Object.freeze({photo:8*1024**2,video:20*1024**2});
const TYPES={photo:/^image\/(jpeg|png|webp)$/i,video:/^video\/(mp4|webm|quicktime)$/i};
const fail=(status,code)=>{throw new ApiError(status,code);};

export function presentationHeaders(req,kind) {
  if(!Object.hasOwn(TYPES,kind))fail(400,'invalid_presentation_kind');
  const seen=new Set();
  for(let i=0;i<req.rawHeaders.length;i+=2) {
    const name=req.rawHeaders[i].toLowerCase();
    if(!['content-type','content-length','content-encoding','transfer-encoding','x-presentation-revision'].includes(name))continue;
    if(seen.has(name))fail(400,'invalid_presentation_headers');seen.add(name);
  }
  const type=req.headers['content-type'];
  if(typeof type!=='string'||!TYPES[kind].test(type))fail(415,'unsupported_presentation_type');
  if(req.headers['content-encoding']!==undefined)fail(415,'unsupported_presentation_encoding');
  const length=req.headers['content-length'];
  if(length!==undefined&&(!/^[0-9]+$/.test(length)||Number(length)>PRESENTATION_INPUT_LIMITS[kind]))fail(413,'presentation_input_too_large');
  return type.toLowerCase();
}

// Only called after authenticated admission and current rules checks. No source
// filename, URL, client hash or conversion option is accepted from the browser.
export async function readPresentationBody(req,kind,timeoutMs=20000) {
  const contentType=presentationHeaders(req,kind),chunks=[];let length=0;
  const timer=setTimeout(()=>req.destroy(),timeoutMs);
  try {
    for await(const chunk of req.iterator({destroyOnReturn:false})) {
      length+=chunk.length;if(length>PRESENTATION_INPUT_LIMITS[kind])fail(413,'presentation_input_too_large');chunks.push(chunk);
    }
    if(!length)fail(400,'invalid_presentation_asset');
    return {bytes:Buffer.concat(chunks,length),contentType};
  } finally {clearTimeout(timer);}
}

// Single byte ranges support smartphone video scrubbing. Authorization and the
// exact publication/draft version are checked before every request, even ranges.
export function sendPresentation(req,res,output) {
  const length=output.bytes.length;
  const headers={'Content-Type':output.contentType,'Content-Length':length,'Cache-Control':'no-store',
    'Cross-Origin-Resource-Policy':'same-origin','X-Content-Type-Options':'nosniff',
    'Content-Disposition':`inline; filename="presentation.${output.contentType==='image/jpeg'?'jpg':'mp4'}"`,'Accept-Ranges':'bytes'};
  let start=0,end=length-1,status=200;
  const range=req.headers.range;
  if(range!==undefined&&req.headers['if-range']===undefined) {
    const match=typeof range==='string'&&range.match(/^bytes=(\d*)-(\d*)$/);
    let valid=Boolean(match&&(match[1]||match[2]));
    if(valid) {
      if(match[1]) {start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
      else {const suffix=Number(match[2]);valid=Number.isSafeInteger(suffix)&&suffix>0;start=Math.max(0,length-suffix);}
      valid&&=Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&start<length&&end>=start;
    }
    if(!valid) {res.writeHead(416,{...headers,'Content-Length':0,'Content-Range':`bytes */${length}`});return res.end();}
    status=206;headers['Content-Range']=`bytes ${start}-${end}/${length}`;headers['Content-Length']=end-start+1;
  }
  res.writeHead(status,headers);res.end(req.method==='HEAD'?undefined:output.bytes.subarray(start,end+1));
}
