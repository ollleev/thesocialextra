import { spawn as nativeSpawn } from 'node:child_process';
import { mkdtemp, chmod, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from './domain.mjs';

// Pilot guards, not measured throughput or an OS sandbox. No video-sized raw
// intermediary is written: the only decoded file is <=15s of mono 48kHz PCM.
export const VIDEO_LIMITS = Object.freeze({
  inputBytes: 20 * 1024 * 1024, outputBytes: 8 * 1024 * 1024, durationMs: 15_000,
  inputLongSide: 1920, inputShortSide: 1080, inputPixels: 1920 * 1080,
  outputDimension: 720, fps: 30, frames: 450, sampleRate: 48000,
  concurrency: 1, timeoutMs: 15_000, allocationBytes: 64 * 1024 * 1024,
  stdoutBytes: 64 * 1024, frameBytes: 512 * 1024, stderrBytes: 32 * 1024,
});
const PCM_MAX = VIDEO_LIMITS.sampleRate * 2 * VIDEO_LIMITS.durationMs / 1000;
const FORMATS = {
  'video/mp4': { demuxer: 'mov', formats: 'mov,mp4,m4a,3gp,3g2,mj2', video: ['h264', 'hevc'], audio: ['aac'] },
  'video/quicktime': { demuxer: 'mov', formats: 'mov,mp4,m4a,3gp,3g2,mj2', video: ['h264', 'hevc'], audio: ['aac'] },
  'video/webm': { demuxer: 'matroska', formats: 'matroska,webm', video: ['vp8', 'vp9'], audio: ['opus', 'vorbis'] },
};
const fail = (status, code) => { throw new ApiError(status, code); };
const invalid = () => fail(422, 'invalid_video');
let active = 0;

function mp4(bytes, { output = false, quicktime = false } = {}) {
  let offset = 0, count = 0; const seen = new Set();
  while (offset + 8 <= bytes.length) {
    if (++count > 4096) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8); let size = bytes.readUInt32BE(offset), header = 8;
    if (size === 1) { if (offset + 16 > bytes.length) invalid(); const wide = bytes.readBigUInt64BE(offset + 8); if (wide > BigInt(bytes.length)) invalid(); size = Number(wide); header = 16; }
    if (size === 0) size = bytes.length - offset;
    if (size < header || offset + size > bytes.length || (!offset && type !== 'ftyp')) invalid();
    if (type === 'ftyp') {
      if (offset || size < header + 8 || (size - header) % 4) invalid();
      const brands = []; for (let i = offset + header; i < offset + size; i += 4) if (i !== offset + header + 4) brands.push(bytes.toString('ascii', i, i + 4));
      if (quicktime ? !brands.includes('qt  ') : !brands.some(brand => ['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand))) invalid();
    }
    if (output && !['ftyp', 'moov', 'mdat', 'free'].includes(type)) fail(500, 'video_processing_failed');
    seen.add(type); offset += size;
  }
  if (offset !== bytes.length || !seen.has('ftyp') || !seen.has('moov') || !seen.has('mdat')) invalid();
}
function webm(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x1a45dfa3) invalid();
  const vint = (offset, identifier = false) => {
    const first = bytes[offset]; if (!first) invalid();
    let width = 1, mask = 0x80; while (!(first & mask)) { width++; mask >>= 1; }
    if (width > (identifier ? 4 : 8) || offset + width > bytes.length) invalid();
    let value = BigInt(identifier ? first : first & (mask - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[offset + i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return { value: Number(value), width };
  };
  const header = vint(4), end = 4 + header.width + header.value;
  if (header.value > 4096 || end > bytes.length) invalid();
  let at = 4 + header.width, found = false, count = 0;
  while (at < end) {
    if (++count > 32) invalid();
    const id = vint(at, true); at += id.width; const length = vint(at); at += length.width;
    if (at + length.value > end) invalid();
    if (id.value === 0x4282) { if (found || !bytes.subarray(at, at + length.value).equals(Buffer.from('webm'))) invalid(); found = true; }
    at += length.value;
  }
  if (!found || at !== end) invalid();
}
function inputOptions(format) {
  return ['-protocol_whitelist', 'file', '-format_whitelist', format.formats, '-codec_whitelist', [...format.video, ...format.audio].join(','),
    '-f', format.demuxer, '-probesize', String(VIDEO_LIMITS.inputBytes), '-analyzeduration', '2000000', '-max_streams', '2', '-threads', '1', '-max_pixels', String(VIDEO_LIMITS.inputPixels),
    ...(format.demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0', '-ignore_chapters', '1', '-export_all', '0', '-export_xmp', '0'] : [])];
}
const COMMON = ['-hide_banner', '-v', 'error', '-max_alloc', String(VIDEO_LIMITS.allocationBytes)];
function run(binary, args, { directory, deadline, spawn, failureCode, receive }) {
  return new Promise((resolve, reject) => {
    let child, timer, error, stdoutLength = 0, stderrLength = 0; const stdout = [];
    const stop = value => { if (!error) { error = value instanceof ApiError ? value : new ApiError(value === 'video_processing_timeout' ? 504 : 422, value); child?.kill('SIGKILL'); } };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new ApiError(504, 'video_processing_timeout')); return; }
    try { child = spawn(binary, args, { cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } }); }
    catch { reject(new ApiError(503, 'video_processing_unavailable')); return; }
    timer = setTimeout(() => stop('video_processing_timeout'), remaining);
    child.stdout.on('data', chunk => {
      stdoutLength += chunk.length;
      if (stdoutLength > (receive ? VIDEO_LIMITS.frameBytes : VIDEO_LIMITS.stdoutBytes)) { stop('video_processing_limit'); return; }
      if (error) return;
      try { if (receive) receive(chunk); else stdout.push(chunk); } catch (e) { stop(e instanceof ApiError ? e : new ApiError(422, 'invalid_video')); }
    });
    // Diagnostics are counted, not retained or exposed to callers.
    child.stderr.on('data', chunk => { stderrLength += chunk.length; if (stderrLength > VIDEO_LIMITS.stderrBytes) stop('video_processing_limit'); });
    child.once('error', () => { error ??= new ApiError(503, 'video_processing_unavailable'); });
    child.once('close', code => { clearTimeout(timer); if (error) reject(error); else if (code !== 0) reject(new ApiError(failureCode === 'invalid_video' ? 422 : 500, failureCode)); else resolve(Buffer.concat(stdout)); });
  });
}
function number(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?\d+(?:\.\d+)?$/.test(String(value)) || !Number.isFinite(Number(value))) invalid();
  return Number(value);
}
function rate(value) {
  if (typeof value !== 'string' || !/^\d+\/[1-9]\d*$/.test(value)) invalid();
  const [n, d] = value.split('/').map(Number), result = n / d;
  if (!Number.isFinite(result) || result <= 0 || result > VIDEO_LIMITS.fps) fail(422, 'video_frame_rate_exceeded');
  return result;
}
function dimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || Math.max(width, height) > VIDEO_LIMITS.inputLongSide || Math.min(width, height) > VIDEO_LIMITS.inputShortSide || width * height > VIDEO_LIMITS.inputPixels) fail(422, 'video_dimensions_exceeded');
}
function standardColor(fields) {
  // No tone mapping or wide-gamut conversion is implemented. Reject explicit
  // PQ/HLG/BT.2020 instead of silently presenting them as ordinary SDR.
  if (['smpte2084', 'arib-std-b67'].includes(fields.color_transfer) || fields.color_primaries === 'bt2020' || ['bt2020nc', 'bt2020c'].includes(fields.color_space)) fail(422, 'video_color_unsupported');
}
function rotation(stream, output) {
  let angle = 0, seen = false;
  for (const item of stream.side_data_list ?? []) {
    if (item.side_data_type !== 'Display Matrix' || seen) invalid(); seen = true;
    angle = number(item.rotation);
    if (![0, 90, -90, 180, -180].includes(angle)) invalid();
    // Do not silently interpret arbitrary scaling/shear/perspective as a rotation.
    const rows = String(item.displaymatrix).trim().split('\n').map(row => row.split(':')[1]?.trim().split(/\s+/).map(Number));
    if (rows.length !== 3 || rows.some(row => !row || row.length !== 3)) invalid();
    const m = rows.flat(), unit = 65536;
    if (m[2] || m[5] || m[6] || m[7] || m[8] !== 1073741824 || ![m[0], m[1], m[3], m[4]].every(v => [-unit, 0, unit].includes(v)) || m[0] * m[4] - m[1] * m[3] !== unit * unit) invalid();
  }
  if (output && angle !== 0) fail(500, 'video_processing_failed');
  return angle;
}
function parseProbe(bytes, format, expected) {
  let info; try { info = JSON.parse(bytes.toString('utf8')); } catch { invalid(); }
  if (!Array.isArray(info.streams) || info.streams.length < 1 || info.streams.length > 2) invalid();
  const video = info.streams.filter(s => s.codec_type === 'video'), audio = info.streams.filter(s => s.codec_type === 'audio');
  if (video.length !== 1 || audio.length > 1 || video.length + audio.length !== info.streams.length) invalid();
  const v = video[0], a = audio[0];
  standardColor(v);
  if (!format.video.includes(v.codec_name) || v.disposition?.attached_pic || v.disposition?.timed_thumbnails || !Number.isInteger(v.index)) invalid();
  // Opaque H264 output must not reveal RGB hidden by WebM transparency.
  if ((v.tags?.alpha_mode !== undefined && v.tags.alpha_mode !== '0') || /^(?:yuva|gbrap|rgba|bgra|argb|abgr)/.test(v.pix_fmt ?? '')) invalid();
  dimensions(v.width, v.height); rate(v.r_frame_rate); rate(v.avg_frame_rate);
  if (v.sample_aspect_ratio && !['1:1', '0:1'].includes(v.sample_aspect_ratio)) invalid();
  if (v.nb_frames !== undefined && v.nb_frames !== 'N/A' && number(v.nb_frames) > VIDEO_LIMITS.frames) fail(422, 'video_too_long');
  const angle = rotation(v, Boolean(expected));
  if (a && (!format.audio.includes(a.codec_name) || !Number.isInteger(a.index) || a.index === v.index || !Number.isInteger(a.channels) || a.channels < 1 || a.channels > 2 || number(a.sample_rate) < 8000 || number(a.sample_rate) > 96000)) invalid();
  for (const item of [v, a, info.format]) if (item?.duration !== undefined && item.duration !== 'N/A' && number(item.duration) > VIDEO_LIMITS.durationMs / 1000 + 0.000001) fail(422, 'video_too_long');
  if (expected) {
    if (v.codec_name !== 'h264' || v.width !== expected.width || v.height !== expected.height || v.pix_fmt !== 'yuv420p' || rate(v.r_frame_rate) !== 30 || Boolean(a) !== expected.audio || (a && (a.channels !== 1 || Number(a.sample_rate) !== VIDEO_LIMITS.sampleRate))) fail(500, 'video_processing_failed');
    const allowed = {
      major_brand: ['isom'], minor_version: ['512'], compatible_brands: ['isomiso2avc1mp41'],
      encoder: ['thesocialextra'], handler_name: ['Video', 'Audio'], language: ['und'], vendor_id: ['[0][0][0][0]'],
    };
    for (const item of [v, a, info.format]) for (const [key, value] of Object.entries(item?.tags ?? {})) if (!allowed[key]?.includes(value)) fail(500, 'video_processing_failed');
    if (a?.side_data_list?.length) fail(500, 'video_processing_failed');
  }
  return { video: v, audio: a, angle };
}
const FRAME_KEYS = new Set(['media_type', 'stream_index', 'best_effort_timestamp_time', 'pkt_duration_time', 'duration_time', 'width', 'height', 'nb_samples', 'sample_rate', 'color_transfer', 'color_primaries', 'color_space']);
function frameReader(info) {
  let pending = '';
  const tracks = new Map([[info.video.index, { type: 'video', count: 0 }], ...(info.audio ? [[info.audio.index, { type: 'audio', count: 0, samples: 0 }]] : [])]);
  function line(value) {
    if (!value) return;
    const [kind, ...parts] = value.split('|'); if (kind !== 'frame') invalid();
    const fields = {};
    for (const part of parts.filter(Boolean)) { const [key, value, extra] = part.split('='); if (!FRAME_KEYS.has(key) || value === undefined || extra !== undefined || key in fields) invalid(); fields[key] = value; }
    const track = tracks.get(number(fields.stream_index)); if (!track || fields.media_type !== track.type) invalid();
    const pts = number(fields.best_effort_timestamp_time), duration = number(fields.duration_time ?? fields.pkt_duration_time);
    if (Math.abs(pts) > 86400 || duration <= 0) invalid();
    if (duration > 15) fail(422, 'video_too_long');
    track.count++;
    if (track.type === 'video') {
      standardColor(fields);
      dimensions(number(fields.width), number(fields.height));
      if (Number(fields.width) !== info.video.width || Number(fields.height) !== info.video.height) invalid();
      if (track.count > VIDEO_LIMITS.frames) fail(422, 'video_too_long');
      // 1.1ms allows WebM's millisecond timestamp quantization, not a sustained
      // higher frame rate. The cumulative check also covers forged average FPS.
      if (track.last !== undefined && (pts <= track.last || pts - track.last + 0.0011 < 1 / 30 || pts - track.first + 0.0011 < (track.count - 1) / 30)) fail(422, 'video_frame_rate_exceeded');
    } else {
      const samples = number(fields.nb_samples), sampleRate = Number(info.audio.sample_rate);
      if (!Number.isInteger(samples) || samples < 1 || samples > 96000 || (fields.sample_rate !== undefined && number(fields.sample_rate) !== sampleRate)) invalid();
      if (track.count > 2048) fail(422, 'video_processing_limit');
      if (track.last !== undefined && Math.abs(pts - track.last - track.lastSamples / sampleRate) > 0.0011) invalid();
      track.samples += samples; track.lastSamples = samples;
      if (track.samples / sampleRate > 15 + 0.000001) fail(422, 'video_too_long');
    }
    track.first ??= pts; track.last = pts; track.end = pts + duration;
    if (track.end - track.first > 15 + 0.000001) fail(422, 'video_too_long');
  }
  return {
    receive(chunk) {
      pending += chunk.toString('utf8'); let end;
      while ((end = pending.indexOf('\n')) >= 0) { if (end > 1024) invalid(); line(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 1024) invalid();
    },
    finish() {
      if (pending) line(pending);
      for (const track of tracks.values()) if (!track.count) invalid();
      const start = Math.min(...[...tracks.values()].map(t => t.first)), end = Math.max(...[...tracks.values()].map(t => t.end));
      if (end - start > 15 + 0.000001) fail(422, 'video_too_long');
      return { start, end, video: tracks.get(info.video.index), audio: info.audio ? tracks.get(info.audio.index) : null };
    },
  };
}

/** Operator-only paths and injected test processes. Host isolation, patched
 * decoders, total RSS/CPU/disk limits must be proved separately before uploads.
 * Source is limited to H264/HEVC + AAC MP4/QuickTime (ftyp required), or
 * VP8/VP9 + Opus/Vorbis WebM, square pixels,
 * cardinal rotations, <=1080p and <=30fps. Unprovable timestamps and video side
 * data other than a pure display rotation are rejected. Explicit HDR/BT.2020
 * color tags are rejected at stream and decoded-frame level; no tone mapping.
 * Transparent video is refused rather than losing its alpha mask on publication.
 * AAC padding near 15s may cause conservative rejection, never silent trimming.
 */
export function createVideoNormalizer({ ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', tempRoot = tmpdir(), timeoutMs = VIDEO_LIMITS.timeoutMs, testSpawn } = {}) {
  for (const binary of [ffmpegPath, ffprobePath]) if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary) || (!path.isAbsolute(binary) && !/^[a-zA-Z0-9_-]+$/.test(binary))) throw new TypeError('Binary must be a trusted path or executable name');
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot) || /[\0\r\n]/.test(tempRoot)) throw new TypeError('tempRoot must be absolute');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 1..60000');
  if (testSpawn !== undefined && (!process.env.NODE_TEST_CONTEXT || typeof testSpawn !== 'function')) throw new TypeError('Process injection is only available to the native test runner');
  const spawn = testSpawn ?? nativeSpawn;
  return async function normalizeVideo(buffer, { contentType } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) fail(400, 'invalid_video');
    if (buffer.length > VIDEO_LIMITS.inputBytes) fail(413, 'video_too_large');
    if (typeof contentType !== 'string' || !/^video\/(mp4|webm|quicktime)(?:\s*;\s*codecs=(?:"[a-zA-Z0-9., -]+"|[a-zA-Z0-9.,-]+))?$/i.test(contentType) || contentType.length > 120 || /[\0\r\n]/.test(contentType)) fail(415, 'unsupported_video_type');
    if (active >= VIDEO_LIMITS.concurrency) fail(429, 'video_busy'); active++;
    let directory;
    try {
      const bytes = Buffer.from(buffer), deadline = Date.now() + timeoutMs, type = contentType.split(';')[0].trim().toLowerCase(), format = FORMATS[type];
      if (type === 'video/webm') webm(bytes); else mp4(bytes, { quicktime: type === 'video/quicktime' });
      directory = await mkdtemp(path.join(tempRoot, 'thesocialextra-video-')); await chmod(directory, 0o700);
      const input = path.join(directory, 'input'), pcm = path.join(directory, 'decoded.pcm'), output = path.join(directory, 'video.mp4');
      for (const [filename, data] of [[input, bytes], [pcm, Buffer.alloc(0)], [output, Buffer.alloc(0)]]) await writeFile(filename, data, { mode: 0o600, flag: 'wx' });
      const context = { directory, deadline, spawn };
      const probeArgs = (filename, fmt, tags = false) => [...COMMON, ...inputOptions(fmt), '-show_entries',
        `stream=index,codec_type,codec_name,width,height,pix_fmt,color_transfer,color_primaries,color_space,sample_aspect_ratio,r_frame_rate,avg_frame_rate,nb_frames,duration,sample_rate,channels:stream_disposition=attached_pic,timed_thumbnails:stream_side_data=side_data_type,rotation,displaymatrix:format=duration${tags ? ':stream_tags:format_tags' : ':stream_tags=alpha_mode'}`, '-of', 'json', filename];
      const info = parseProbe(await run(ffprobePath, probeArgs(input, format), { ...context, failureCode: 'invalid_video' }), format);
      async function decoded(filename, fmt, metadata, failureCode) {
        const frames = frameReader(metadata);
        await run(ffprobePath, [...COMMON, ...inputOptions(fmt), '-err_detect', 'explode', '-show_frames', '-show_entries',
          'frame=media_type,stream_index,width,height,color_transfer,color_primaries,color_space,best_effort_timestamp_time,pkt_duration_time,duration_time,nb_samples,sample_rate:frame_side_data=', '-of', 'compact=p=1:nk=0', filename], { ...context, failureCode, receive: frames.receive });
        return frames.finish();
      }
      const source = await decoded(input, format, info, 'invalid_video');
      if (info.audio) {
        await run(ffmpegPath, [...COMMON, '-nostdin', '-y', '-xerror', '-err_detect', 'explode', ...inputOptions(format), '-i', input,
          '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1', '-filter_threads', '1',
          '-af', 'aresample=48000,asetpts=N/SR/TB', '-ac', '1', '-ar', '48000', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', '-fs', String(PCM_MAX + 2), pcm], { ...context, failureCode: 'invalid_video' });
        const pcmSize = (await stat(pcm)).size;
        if (pcmSize > PCM_MAX) fail(422, 'video_too_long'); if (!pcmSize || pcmSize % 2) invalid();
        if (Math.abs(pcmSize / 2 / 48000 - source.audio.samples / Number(info.audio.sample_rate)) > 0.003) invalid();
      }
      const swap = Math.abs(info.angle) === 90, w = swap ? info.video.height : info.video.width, h = swap ? info.video.width : info.video.height;
      const ratio = Math.min(1, 720 / Math.max(w, h)), expected = { width: Math.max(2, Math.floor(w * ratio / 2) * 2), height: Math.max(2, Math.floor(h * ratio / 2) * 2), audio: Boolean(info.audio) };
      const turn = info.angle === 90 ? 'transpose=2' : info.angle === -90 ? 'transpose=1' : Math.abs(info.angle) === 180 ? 'hflip,vflip' : '';
      const filter = [turn, 'sidedata=mode=delete', `setpts=PTS-STARTPTS+${source.video.first - source.start}/TB`, `scale=${expected.width}:${expected.height}:flags=lanczos`, 'fps=30', 'setsar=1', 'format=yuv420p'].filter(Boolean).join(',');
      const args = [...COMMON, '-nostdin', '-y', '-xerror', '-err_detect', 'explode', '-hwaccel', 'none', '-noautorotate', '-display_rotation:v:0', '0',
        ...inputOptions(format), '-i', input,
        ...(info.audio ? ['-protocol_whitelist', 'file', '-format_whitelist', 's16le', '-codec_whitelist', 'pcm_s16le', '-f', 's16le', '-ar', '48000', '-ac', '1', '-threads', '1', '-i', pcm] : []),
        '-map', '0:v:0', ...(info.audio ? ['-map', '1:a:0'] : ['-an']), '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_chapters', '-1',
        '-metadata', 'encoder=thesocialextra', '-metadata:s:v:0', 'encoder=thesocialextra', '-metadata:s:v:0', 'handler_name=Video', '-metadata:s:v:0', 'language=und', '-metadata:s:v:0', 'rotate=0',
        '-filter_threads', '1', '-filter_complex_threads', '1', '-vf', filter, '-frames:v', String(VIDEO_LIMITS.frames + 1), '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '26', '-maxrate', '2M', '-bufsize', '2M',
        '-x264-params', 'threads=1:lookahead_threads=1:sync-lookahead=0', '-threads', '1', '-pix_fmt', 'yuv420p', '-bsf:v', 'filter_units=remove_types=6',
        ...(info.audio ? ['-map_metadata:s:a', '-1', '-metadata:s:a:0', 'handler_name=Audio', '-metadata:s:a:0', 'language=und', '-af', `asetpts=PTS+${source.audio.first - source.start}/TB`, '-c:a', 'aac', '-b:a', '64k', '-ar', '48000', '-ac', '1', '-flags:a', '+bitexact'] : []),
        '-fflags', '+bitexact', '-flags:v', '+bitexact', '-movflags', '+faststart', '-f', 'mp4', '-fs', String(VIDEO_LIMITS.outputBytes), output];
      await run(ffmpegPath, args, { ...context, failureCode: 'video_processing_failed' });
      const length = (await stat(output)).size;
      if (!length || length > VIDEO_LIMITS.outputBytes) fail(422, 'video_processing_limit');
      const normalized = await readFile(output); try { mp4(normalized, { output: true }); } catch { fail(500, 'video_processing_failed'); }
      const finalInfo = parseProbe(await run(ffprobePath, probeArgs(output, FORMATS['video/mp4'], true), { ...context, failureCode: 'video_processing_failed' }), FORMATS['video/mp4'], expected);
      const final = await decoded(output, FORMATS['video/mp4'], finalInfo, 'video_processing_failed');
      // A safety frame/file cap must never turn a longer video into an accepted
      // excerpt. Only one output-frame rounding interval is allowed for VFR.
      const expectedFrames = Math.round((source.video.end - source.start) * 30) - Math.round((source.video.first - source.start) * 30);
      if (final.video.count !== expectedFrames || Math.abs(final.video.end - final.start - (source.video.end - source.start)) > 1 / 30 + 0.002 || Math.abs(final.video.first - final.start - (source.video.first - source.start)) > 1 / 30 + 0.002 ||
        (source.audio && (Math.abs(final.audio.samples / 48000 - source.audio.samples / Number(info.audio.sample_rate)) > 1024 / 48000 + 0.003 ||
          Math.abs(final.audio.first - final.start - (source.audio.first - source.start)) > 1024 / 48000 + 0.003))) fail(500, 'video_processing_failed');
      // ffprobe prints timestamps to microseconds. Clamp only that sub-ms
      // rounding allowance, after both complete decodes proved the 15s bound.
      const durationMs = Math.min(VIDEO_LIMITS.durationMs, Math.ceil((final.end - final.start) * 1000));
      return { bytes: normalized, contentType: 'video/mp4', width: expected.width, height: expected.height, durationMs };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'video_processing_failed');
    } finally {
      try { if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2 }); }
      catch { throw new ApiError(500, 'video_cleanup_failed'); }
      finally { active--; }
    }
  };
}
