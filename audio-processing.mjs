import { spawn as nativeSpawn } from 'node:child_process';
import { mkdtemp, chmod, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiError } from './domain.mjs';

export const VOICE_LIMITS = Object.freeze({
  inputBytes: 5 * 1024 * 1024, outputBytes: 512 * 1024, durationMs: 60_000,
  concurrency: 1, timeoutMs: 15_000, stdoutBytes: 64 * 1024, stderrBytes: 32 * 1024,
  allocationBytes: 32 * 1024 * 1024, sampleRate: 48_000,
});
const PCM_MAX = VOICE_LIMITS.sampleRate * 2 * VOICE_LIMITS.durationMs / 1000;
const FORMATS = Object.freeze({
  'audio/webm': { demuxer: 'matroska', formats: 'matroska,webm', codecs: ['opus', 'vorbis'] },
  'audio/ogg': { demuxer: 'ogg', formats: 'ogg', codecs: ['opus', 'vorbis'] },
  'audio/mp4': { demuxer: 'mov', formats: 'mov,mp4,m4a,3gp,3g2,mj2', codecs: ['aac', 'opus'] },
});
let active = 0; // Shared across factories: creating another instance cannot bypass admission.
const fail = (status, code) => { throw new ApiError(status, code); };

function inputFormat(bytes, contentType) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) fail(400, 'invalid_audio');
  if (bytes.length > VOICE_LIMITS.inputBytes) fail(413, 'audio_too_large');
  if (typeof contentType !== 'string' || contentType.length > 120 || /[\0\r\n]/.test(contentType) ||
    !/^audio\/(webm|ogg|mp4)(?:\s*;\s*codecs=(?:"[a-zA-Z0-9., -]+"|[a-zA-Z0-9.,-]+))?$/i.test(contentType)) fail(415, 'unsupported_audio_type');
  const type = contentType.split(';')[0].trim().toLowerCase(), format = FORMATS[type];
  const valid = type === 'audio/webm' ? bytes.length >= 8 && bytes.readUInt32BE(0) === 0x1a45dfa3
    : type === 'audio/ogg' ? bytes.length >= 27 && bytes.toString('ascii', 0, 4) === 'OggS' && bytes[4] === 0
      : bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp' && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= bytes.length;
  if (!valid) fail(422, 'invalid_audio');
  return format;
}

function inputOptions(format) {
  return ['-protocol_whitelist', 'file', '-format_whitelist', format.formats,
    '-codec_whitelist', format.codecs.join(','), '-f', format.demuxer,
    '-probesize', String(VOICE_LIMITS.inputBytes), '-analyzeduration', '3000000', '-max_streams', '2', '-threads', '1',
    ...(format.demuxer === 'mov' ? ['-enable_drefs', '0', '-use_absolute_path', '0', '-ignore_chapters', '1', '-export_all', '0', '-export_xmp', '0'] : [])];
}
const COMMON = ['-hide_banner', '-v', 'error', '-max_alloc', String(VOICE_LIMITS.allocationBytes)];

function run(binary, args, { directory, deadline, spawn, failureCode }) {
  return new Promise((resolve, reject) => {
    let processHandle, timer, error, stdoutLength = 0, stderrLength = 0;
    const stdout = [];
    const stop = code => {
      if (error) return;
      error = new ApiError(code === 'audio_processing_timeout' ? 504 : 422, code);
      processHandle?.kill('SIGKILL');
    };
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new ApiError(504, 'audio_processing_timeout')); return; }
    try {
      processHandle = spawn(binary, args, {
        cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        // Do not inherit server secrets, proxy settings, FFREPORT, or linker overrides.
        env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
    } catch { reject(new ApiError(503, 'audio_processing_unavailable')); return; }
    timer = setTimeout(() => stop('audio_processing_timeout'), remaining);
    processHandle.stdout.on('data', chunk => {
      stdoutLength += chunk.length;
      if (stdoutLength > VOICE_LIMITS.stdoutBytes) stop('audio_processing_limit');
      else if (!error) stdout.push(chunk);
    });
    // Count diagnostics without retaining or logging user-supplied metadata/paths.
    processHandle.stderr.on('data', chunk => {
      stderrLength += chunk.length;
      if (stderrLength > VOICE_LIMITS.stderrBytes) stop('audio_processing_limit');
    });
    processHandle.once('error', () => { error ??= new ApiError(503, 'audio_processing_unavailable'); });
    processHandle.once('close', code => {
      clearTimeout(timer);
      if (error) reject(error);
      else if (code !== 0) reject(new ApiError(failureCode === 'invalid_audio' ? 422 : 500, failureCode));
      else resolve(Buffer.concat(stdout));
    });
  });
}

function parseProbe(bytes, format, output = false) {
  let info;
  try { info = JSON.parse(bytes.toString('utf8')); } catch { fail(422, 'invalid_audio'); }
  const streams = info?.streams;
  if (!Array.isArray(streams) || streams.length !== 1) fail(422, 'invalid_audio');
  const stream = streams[0], rate = Number(stream.sample_rate);
  if (stream.codec_type !== 'audio' || !format.codecs.includes(stream.codec_name) ||
      !Number.isInteger(stream.channels) || stream.channels < 1 || stream.channels > 2 ||
      !Number.isInteger(rate) || rate < 8000 || rate > 96000) fail(422, 'invalid_audio');
  const safeTags = tags => Object.entries(tags ?? {}).every(([key, value]) => key === 'encoder' && value === 'thesocialextra');
  if (output && (stream.codec_name !== 'opus' || stream.channels !== 1 || rate !== VOICE_LIMITS.sampleRate ||
      !safeTags(stream.tags) || !safeTags(info.format?.tags))) fail(500, 'audio_processing_failed');
  return info;
}

// Validate final Ogg granule duration against decoded PCM, including Opus pre-skip.
// This catches premature output termination even if an encoder exits successfully.
function verifyOgg(bytes, samples) {
  let offset = 0, sequence = 0, serial, preSkip, finalGranule;
  while (offset < bytes.length) {
    if (offset + 27 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'OggS' || bytes[offset + 4] !== 0) fail(500, 'audio_processing_failed');
    const count = bytes[offset + 26], tableEnd = offset + 27 + count;
    if (tableEnd > bytes.length) fail(500, 'audio_processing_failed');
    let length = 0; for (let i = offset + 27; i < tableEnd; i++) length += bytes[i];
    const next = tableEnd + length, pageSerial = bytes.readUInt32LE(offset + 14);
    if (next > bytes.length || bytes.readUInt32LE(offset + 18) !== sequence++ || (serial !== undefined && pageSerial !== serial)) fail(500, 'audio_processing_failed');
    serial = pageSerial;
    if (preSkip === undefined) {
      if (!(bytes[offset + 5] & 2) || length < 19 || bytes.toString('ascii', tableEnd, tableEnd + 8) !== 'OpusHead' || bytes[tableEnd + 9] !== 1) fail(500, 'audio_processing_failed');
      preSkip = bytes.readUInt16LE(tableEnd + 10);
    }
    if (bytes[offset + 5] & 4) {
      if (next !== bytes.length) fail(500, 'audio_processing_failed');
      finalGranule = bytes.readBigUInt64LE(offset + 6);
    }
    offset = next;
  }
  if (preSkip === undefined || finalGranule === undefined || finalGranule - BigInt(preSkip) !== BigInt(samples)) fail(500, 'audio_processing_failed');
}

/** Trusted operator configuration only. Never pass upload fields as these options.
 * max_alloc bounds individual allocations, NOT total RSS. Host sandbox/cgroup,
 * patched binaries, an unprivileged worker account, and no sensitive filesystem
 * access remain required before accepting hostile public uploads. This module
 * adds no upload route, persistent storage, transcription, or microphone access.
 */
export function createVoiceNormalizer({ ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', tempRoot = tmpdir(),
  timeoutMs = VOICE_LIMITS.timeoutMs, testSpawn } = {}) {
  for (const binary of [ffmpegPath, ffprobePath]) {
    if (typeof binary !== 'string' || !binary || /[\0\r\n]/.test(binary) || (!path.isAbsolute(binary) && !/^[a-zA-Z0-9_-]+$/.test(binary))) throw new TypeError('Binary must be a trusted absolute path or executable name');
  }
  if (typeof tempRoot !== 'string' || !path.isAbsolute(tempRoot)) throw new TypeError('tempRoot must be absolute');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError('timeoutMs must be 1..60000');
  if (testSpawn !== undefined && (!process.env.NODE_TEST_CONTEXT || typeof testSpawn !== 'function')) throw new TypeError('Process injection is only available to the native test runner');
  const spawn = testSpawn ?? nativeSpawn;
  return async function normalizeVoice(buffer, { contentType } = {}) {
    const format = inputFormat(buffer, contentType);
    if (active >= VOICE_LIMITS.concurrency) fail(429, 'audio_busy');
    active++;
    let directory;
    try {
      const bytes = Buffer.from(buffer); // Snapshot before the first await.
      const deadline = Date.now() + timeoutMs;
      directory = await mkdtemp(path.join(tempRoot, 'thesocialextra-voice-'));
      await chmod(directory, 0o700);
      const input = path.join(directory, 'input'), pcm = path.join(directory, 'decoded.pcm'), output = path.join(directory, 'voice.ogg');
      for (const [filename, content] of [[input, bytes], [pcm, Buffer.alloc(0)], [output, Buffer.alloc(0)]]) {
        await writeFile(filename, content, { mode: 0o600, flag: 'wx' });
      }
      const context = { directory, deadline, spawn };
      const probeArgs = (filename, options, checkTags = false) => [...COMMON, ...options, '-show_entries',
        `stream=codec_name,codec_type,sample_rate,channels${checkTags ? ':stream_tags:format_tags' : ''}`, '-of', 'json', filename];
      parseProbe(await run(ffprobePath, probeArgs(input, inputOptions(format)), { ...context, failureCode: 'invalid_audio' }), format);

      // Decode into metadata-free PCM. The safety stop is one sample ABOVE the
      // acceptance limit; hitting it can never turn a long input into an accepted
      // shortened voice. Actual PCM length, not attacker-controlled duration,
      // decides whether this recording is within 60 seconds.
      await run(ffmpegPath, [...COMMON, '-nostdin', '-y', '-xerror', '-err_detect', 'explode',
        '-filter_threads', '1', '-filter_complex_threads', '1', ...inputOptions(format), '-i', input,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        // No timestamp-driven async trimming: every decoded audio sample counts,
        // even if hostile input timestamps overlap or claim a shorter recording.
        '-af', 'aresample=48000,asetpts=N/SR/TB', '-ac', '1', '-ar', '48000', '-threads', '1',
        '-c:a', 'pcm_s16le', '-f', 's16le', '-fs', String(PCM_MAX + 2), pcm], { ...context, failureCode: 'invalid_audio' });
      const pcmSize = (await stat(pcm)).size;
      if (pcmSize > PCM_MAX) fail(422, 'audio_too_long');
      if (pcmSize === 0 || pcmSize % 2) fail(422, 'invalid_audio');
      await run(ffmpegPath, [...COMMON, '-nostdin', '-y', '-xerror', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-protocol_whitelist', 'file', '-format_whitelist', 's16le', '-codec_whitelist', 'pcm_s16le',
        '-f', 's16le', '-ar', '48000', '-ac', '1', '-threads', '1', '-i', pcm,
        '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
        // FFmpeg6 reinserts a codec tag when encoder is empty. A fixed public
        // value works on versions6 and9 without retaining source metadata.
        '-metadata', 'encoder=thesocialextra', '-metadata:s:a', 'encoder=thesocialextra', '-fflags', '+bitexact', '-flags:a', '+bitexact',
        '-c:a', 'libopus', '-application', 'voip', '-b:a', '32k', '-vbr', 'off', '-compression_level', '5',
        '-ac', '1', '-ar', '48000', '-threads', '1', '-f', 'ogg', '-fs', String(VOICE_LIMITS.outputBytes), output], { ...context, failureCode: 'audio_processing_failed' });
      const outputSize = (await stat(output)).size;
      if (!outputSize || outputSize > VOICE_LIMITS.outputBytes) fail(422, 'audio_processing_limit');
      const normalized = await readFile(output);
      verifyOgg(normalized, pcmSize / 2);
      parseProbe(await run(ffprobePath, probeArgs(output, inputOptions(FORMATS['audio/ogg']), true), { ...context, failureCode: 'audio_processing_failed' }), FORMATS['audio/ogg'], true);
      return { bytes: normalized, contentType: 'audio/ogg; codecs=opus', durationMs: Math.ceil(pcmSize * 1000 / 2 / VOICE_LIMITS.sampleRate) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'audio_processing_failed');
    } finally {
      try {
        if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 2 });
      } catch { throw new ApiError(500, 'audio_cleanup_failed'); }
      finally { active--; }
    }
  };
}

export const normalizeVoice = createVoiceNormalizer();
