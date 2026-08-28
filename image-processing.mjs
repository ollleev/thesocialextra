import { spawn as nativeSpawn } from 'node:child_process';
import { mkdtemp, chmod, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from './domain.mjs';

// Pilot guards, not measured service capacity. An isolated worker with a total
// memory/CPU/disk budget is still required: max_alloc only limits ONE allocation.
export const IMAGE_LIMITS = Object.freeze({
  inputBytes: 8 * 1024 * 1024, inputPixels: 12_000_000, outputDimension: 1600,
  outputBytes: 1024 * 1024, concurrency: 1, timeoutMs: 15_000,
  stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024, allocationBytes: 64 * 1024 * 1024,
});
const FORMATS = {
  'image/jpeg': { demuxer: 'jpeg_pipe', codec: 'mjpeg' },
  'image/png': { demuxer: 'png_pipe', codec: 'png' },
  'image/webp': { demuxer: 'webp_pipe', codec: 'webp' },
};
const fail = (status, code) => { throw new ApiError(status, code); };
const invalid = () => fail(422, 'invalid_image');
let active = 0;

function dimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width * height > IMAGE_LIMITS.inputPixels) fail(422, 'image_dimensions_exceeded');
  return { width, height };
}

// Only IFD0 orientation is read. Never follow GPS, thumbnail or arbitrary IFD
// links. All source metadata is removed BEFORE the decoder sees the container.
function exifOrientation(bytes) {
  if (bytes.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) bytes = bytes.subarray(6);
  if (bytes.length < 8) invalid();
  const order = bytes.toString('ascii', 0, 2);
  if (!['II', 'MM'].includes(order)) invalid();
  const u16 = offset => order === 'II' ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset);
  const u32 = offset => order === 'II' ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
  if (u16(2) !== 42) invalid();
  const offset = u32(4);
  if (offset < 8 || offset + 2 > bytes.length) invalid();
  const count = u16(offset);
  if (count > 4096 || offset + 2 + count * 12 + 4 > bytes.length) invalid();
  let orientation;
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    if (u16(entry) !== 0x112) continue;
    if (orientation !== undefined || u16(entry + 2) !== 3 || u32(entry + 4) !== 1) invalid();
    orientation = u16(entry + 8);
    if (orientation < 1 || orientation > 8) invalid();
  }
  return orientation ?? 1;
}

function jpeg(bytes, output = false) {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) invalid();
  let offset = 2, size, scan = false, orientation = 1, exif = false;
  const parts = [bytes.subarray(0, 2)];
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!size || !scan || offset !== bytes.length) invalid();
      parts.push(bytes.subarray(start, offset));
      return { ...size, orientation, bytes: output ? bytes : Buffer.concat(parts) };
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) invalid();
    const length = bytes.readUInt16BE(offset), end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    const payload = bytes.subarray(offset + 2, end);
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (metadata && output) {
      // JPEG output permits only the fixed, thumbnail-free JFIF header; no APP1
      // EXIF/XMP, APP2 ICC/MPF, other application segments, or comments survive.
      const fixedJFIF = ['4a46494600010100000100010000', '4a46494600010200000100010000'];
      if (marker !== 0xe0 || !fixedJFIF.includes(payload.toString('hex'))) fail(500, 'image_processing_failed');
    }
    if (marker === 0xe1 && payload.subarray(0, 6).equals(Buffer.from('Exif\0\0'))) {
      if (exif) invalid();
      exif = true; orientation = exifOrientation(payload);
    }
    if (marker === 0xe2 && payload.toString('ascii', 0, 4) === 'MPF\0') fail(422, 'animated_image_not_supported');
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (![0xc0, 0xc1, 0xc2].includes(marker) || size || payload.length < 6) invalid();
      size = dimensions(payload.readUInt16BE(3), payload.readUInt16BE(1));
    }
    if (marker === 0xdc) invalid(); // Do not permit a later dimension change.
    // Adobe's fixed transform header affects CMYK pixels; it is not copied to
    // output. Everything else in APP/comment metadata is discarded here.
    const adobe = marker === 0xee && payload.length === 12 && payload.toString('ascii', 0, 5) === 'Adobe';
    if (!metadata || adobe || output) parts.push(bytes.subarray(start, end));
    offset = end;
    if (marker === 0xda) {
      if (!size) invalid();
      scan = true;
      const entropy = offset;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (bytes[next] === 0xff) next++;
        if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) { offset = next + 1; continue; }
        break;
      }
      parts.push(bytes.subarray(entropy, offset));
    }
  }
  invalid();
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function png(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid();
  let offset = 8, size, data = false, endedData = false, orientation = 1, exif = false;
  const parts = [bytes.subarray(0, 8)], unique = new Set();
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const name = bytes.toString('ascii', offset + 4, offset + 8), payload = bytes.subarray(offset + 8, end - 4);
    if (!/^[A-Za-z]{4}$/.test(name) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(name)) fail(422, 'animated_image_not_supported');
    if (!size && name !== 'IHDR') invalid();
    if (['IHDR', 'PLTE', 'tRNS', 'eXIf'].includes(name)) {
      if (unique.has(name)) invalid(); unique.add(name);
    }
    if (name === 'IHDR') {
      if (length !== 13) invalid(); size = dimensions(payload.readUInt32BE(0), payload.readUInt32BE(4));
    }
    if (name === 'eXIf') { exif = true; orientation = exifOrientation(payload); }
    if (name === 'IDAT') { if (endedData) invalid(); data = true; }
    else if (data) endedData = true;
    // Unknown critical chunks are not safely ignorable. Text, compressed ICC,
    // EXIF and other ancillary metadata never reach native image parsers.
    if (/^[A-Z]/.test(name) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(name)) invalid();
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(name)) parts.push(bytes.subarray(offset, end));
    if (name === 'IEND') {
      if (length || !data || end !== bytes.length) invalid();
      return { ...size, orientation: exif ? orientation : 1, bytes: Buffer.concat(parts) };
    }
    offset = end;
  }
  invalid();
}

function webp(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
  let offset = 12, canvas, size, orientation = 1;
  const parts = [], seen = new Set();
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), end = offset + 8 + length + (length & 1);
    if (end > bytes.length || (length & 1 && bytes[end - 1] !== 0) || seen.has(name)) invalid();
    seen.add(name);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    if (['ANIM', 'ANMF'].includes(name)) fail(422, 'animated_image_not_supported');
    if (!['VP8X', 'VP8 ', 'VP8L', 'ALPH', 'EXIF', 'XMP ', 'ICCP'].includes(name)) invalid();
    if (name === 'VP8X') {
      if (offset !== 12 || length !== 10 || payload[0] & 0xc1 || payload[1] || payload[2] || payload[3]) invalid();
      if (payload[0] & 2) fail(422, 'animated_image_not_supported');
      canvas = dimensions(payload.readUIntLE(4, 3) + 1, payload.readUIntLE(7, 3) + 1);
      const clean = Buffer.from(bytes.subarray(offset, end)); clean[8] &= ~0x2c; parts.push(clean);
    }
    if (name === 'VP8 ' || name === 'VP8L') {
      if (size) fail(422, 'animated_image_not_supported');
      if (name === 'VP8 ') {
        if (length < 10 || payload[0] & 1 || payload.toString('hex', 3, 6) !== '9d012a') invalid();
        size = dimensions(payload.readUInt16LE(6) & 0x3fff, payload.readUInt16LE(8) & 0x3fff);
      } else {
        if (length < 5 || payload[0] !== 0x2f || payload[4] & 0xe0) invalid();
        const bits = payload.readUInt32LE(1); size = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
    }
    if (name === 'EXIF') orientation = exifOrientation(payload);
    if (['VP8 ', 'VP8L', 'ALPH'].includes(name)) parts.push(bytes.subarray(offset, end));
    offset = end;
  }
  if (offset !== bytes.length || !size || (canvas && (canvas.width !== size.width || canvas.height !== size.height))) invalid();
  const header = Buffer.from('524946460000000057454250', 'hex');
  header.writeUInt32LE(4 + parts.reduce((n, part) => n + part.length, 0), 4);
  return { ...size, orientation, bytes: Buffer.concat([header, ...parts]) };
}

function inputOptions(format) {
  return ['-protocol_whitelist', 'file', '-format_whitelist', format.demuxer, '-codec_whitelist', format.codec,
    '-f', format.demuxer, '-probesize', String(IMAGE_LIMITS.inputBytes), '-analyzeduration', '1000000', '-max_streams', '1', '-threads', '1'];
}
const COMMON = ['-hide_banner', '-v', 'error', '-max_alloc', String(IMAGE_LIMITS.allocationBytes)];
function run(binary, args, { directory, deadline, spawn, failureCode }) {
  return new Promise((resolve, reject) => {
    let child, timer, error, stdoutLength = 0, stderrLength = 0;
    const stdout = [];
    const stop = code => { if (!error) { error = new ApiError(code === 'image_processing_timeout' ? 504 : 422, code); child?.kill('SIGKILL'); } };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new ApiError(504, 'image_processing_timeout')); return; }
    try {
      child = spawn(binary, args, { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
    } catch { reject(new ApiError(503, 'image_processing_unavailable')); return; }
    timer = setTimeout(() => stop('image_processing_timeout'), remaining);
    child.stdout.on('data', chunk => { stdoutLength += chunk.length; if (stdoutLength > IMAGE_LIMITS.stdoutBytes) stop('image_processing_limit'); else if (!error) stdout.push(chunk); });
    child.stderr.on('data', chunk => { stderrLength += chunk.length; if (stderrLength > IMAGE_LIMITS.stderrBytes) stop('image_processing_limit'); });
    child.once('error', () => { error ??= new ApiError(503, 'image_processing_unavailable'); });
    child.once('close', code => { clearTimeout(timer); if (error) reject(error); else if (code !== 0) reject(new ApiError(failureCode === 'invalid_image' ? 422 : 500, failureCode)); else resolve(Buffer.concat(stdout)); });
  });
}
function probe(bytes, format, expected, output = false) {
  let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
  const streams = data?.streams, stream = streams?.[0];
  if (!Array.isArray(streams) || streams.length !== 1 || stream.codec_type !== 'video' || stream.codec_name !== format.codec ||
    stream.width !== expected.width || stream.height !== expected.height) invalid();
  if (output && (stream.nb_read_frames !== '1' || Object.keys(stream.tags ?? {}).length || Object.keys(data.format?.tags ?? {}).length)) fail(500, 'image_processing_failed');
}

/** No HTTP, DB or worker is added here. Operator-only paths/options, patched
 * binaries and OS isolation are prerequisites for public uploads. RGB working
 * data holds at most two 1600px frames (~15.4 MB); it is never published.
 * Source colour-profile metadata is removed; this is not an ICC colour workflow.
 * Transparency is composited onto black, never exposed as hidden RGB colours.
 */
export function createImageNormalizer({ ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', tempRoot = tmpdir(), timeoutMs = IMAGE_LIMITS.timeoutMs, testSpawn } = {}) {
  for (const binary of [ffmpegPath, ffprobePath]) if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary) || (!path.isAbsolute(binary) && !/^[a-zA-Z0-9_-]+$/.test(binary))) throw new TypeError('Binary must be a trusted path or executable name');
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot) || /[\0\r\n]/.test(tempRoot)) throw new TypeError('tempRoot must be absolute');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 1..60000');
  if (testSpawn !== undefined && (!process.env.NODE_TEST_CONTEXT || typeof testSpawn !== 'function')) throw new TypeError('Process injection is only available to the native test runner');
  const spawn = testSpawn ?? nativeSpawn;
  return async function normalizeImage(buffer, { contentType } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) fail(400, 'invalid_image');
    if (buffer.length > IMAGE_LIMITS.inputBytes) fail(413, 'image_too_large');
    if (typeof contentType !== 'string' || !/^image\/(jpeg|png|webp)$/i.test(contentType)) fail(415, 'unsupported_image_type');
    if (active >= IMAGE_LIMITS.concurrency) fail(429, 'image_busy');
    active++;
    let directory;
    try {
      const deadline = Date.now() + timeoutMs, type = contentType.toLowerCase(), format = FORMATS[type];
      const source = ({ 'image/jpeg': jpeg, 'image/png': png, 'image/webp': webp })[type](Buffer.from(buffer));
      const swapped = source.orientation >= 5, width = swapped ? source.height : source.width, height = swapped ? source.width : source.height;
      const scale = Math.min(1, IMAGE_LIMITS.outputDimension / Math.max(width, height));
      const expected = { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
      const frameBytes = expected.width * expected.height * 3;
      directory = await mkdtemp(path.join(tempRoot, 'thesocialextra-image-')); await chmod(directory, 0o700);
      const input = path.join(directory, 'input'), pixels = path.join(directory, 'decoded.rgb'), output = path.join(directory, 'image.jpg');
      for (const [filename, bytes] of [[input, source.bytes], [pixels, Buffer.alloc(0)], [output, Buffer.alloc(0)]]) await writeFile(filename, bytes, { mode: 0o600, flag: 'wx' });
      const context = { directory, deadline, spawn }, probeArgs = (filename, fmt, count = false) => [...COMMON, ...inputOptions(fmt),
        ...(count ? ['-count_frames'] : []), '-show_entries', `stream=codec_name,codec_type,width,height${count ? ',nb_read_frames:stream_tags:format_tags' : ''}`, '-of', 'json', filename];
      probe(await run(ffprobePath, probeArgs(input, format), { ...context, failureCode: 'invalid_image' }), format, source);
      const orientation = ['', '', 'hflip', 'hflip,vflip', 'vflip', 'transpose=0', 'transpose=1', 'transpose=3', 'transpose=2'][source.orientation];
      const filters = [orientation, 'format=gbrap', 'premultiply=inplace=1',
        `scale=${expected.width}:${expected.height}:flags=lanczos`, 'setsar=1', 'format=rgb24'].filter(Boolean).join(',');
      await run(ffmpegPath, [...COMMON, '-nostdin', '-y', '-xerror', '-err_detect', 'explode', '-noautorotate', '-filter_threads', '1', '-filter_complex_threads', '1',
        ...inputOptions(format), '-i', input, '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        '-vf', filters, '-fps_mode', 'passthrough', '-frames:v', '2', '-threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-fs', String(frameBytes * 2), pixels], { ...context, failureCode: 'invalid_image' });
      const decodedSize = (await stat(pixels)).size;
      if (decodedSize > frameBytes) fail(422, 'animated_image_not_supported');
      if (decodedSize !== frameBytes) invalid();
      await run(ffmpegPath, [...COMMON, '-nostdin', '-y', '-xerror', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-protocol_whitelist', 'file', '-format_whitelist', 'rawvideo', '-codec_whitelist', 'rawvideo', '-f', 'rawvideo', '-pixel_format', 'rgb24',
        '-video_size', `${expected.width}x${expected.height}`, '-framerate', '1', '-threads', '1', '-i', pixels,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_chapters', '-1',
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj444p', '-threads', '1', '-f', 'mjpeg', '-fs', String(IMAGE_LIMITS.outputBytes), output], { ...context, failureCode: 'image_processing_failed' });
      const length = (await stat(output)).size;
      if (!length || length > IMAGE_LIMITS.outputBytes) fail(422, 'image_processing_limit');
      const bytes = await readFile(output);
      let verified; try { verified = jpeg(bytes, true); } catch { fail(500, 'image_processing_failed'); }
      if (verified.width !== expected.width || verified.height !== expected.height) fail(500, 'image_processing_failed');
      probe(await run(ffprobePath, probeArgs(output, FORMATS['image/jpeg'], true), { ...context, failureCode: 'image_processing_failed' }), FORMATS['image/jpeg'], expected, true);
      return { bytes, contentType: 'image/jpeg', ...expected };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'image_processing_failed');
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2 }); }
      catch { throw new ApiError(500, 'image_cleanup_failed'); }
      finally { active--; }
    }
  };
}
