import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createVoiceNormalizer, VOICE_LIMITS } from '../audio-processing.mjs';

const execute = promisify(execFile);
const binariesAvailable = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { timeout: 3000, stdio: 'ignore' }).status === 0);
const realOptions = { skip: binariesAvailable ? false : 'Installed ffmpeg/ffprobe unavailable; no install attempted' };
const error = (status, code) => e => e.status === status && e.code === code;
const webmHeader = Buffer.from('1a45dfa301020304', 'hex');
const probeJSON = JSON.stringify({ streams: [{ codec_type: 'audio', codec_name: 'opus', channels: 1, sample_rate: '48000' }] });

async function temp(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'extra-voice-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function fakeSpawn(onStart = () => {}) {
  const calls = [];
  const fn = (binary, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.killedWith = null; child.kill = signal => { child.killedWith = signal; queueMicrotask(() => child.emit('close', null)); return true; };
    const call = { binary, args, options, child }; calls.push(call);
    queueMicrotask(() => onStart(call));
    return child;
  };
  return { fn, calls };
}
async function synthetic(t, { format = 'webm', duration = 1, channels = 1, metadata = false, compressedTimeline = false } = {}) {
  const directory = await temp(t), filename = path.join(directory, `synthetic.${format}`);
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`, '-ac', String(channels)];
  if (metadata) args.push('-metadata', 'title=SYNTHETIC_PRIVATE_TITLE', '-metadata:s:a', 'comment=SYNTHETIC_PRIVATE_COMMENT');
  if (compressedTimeline) args.push('-af', 'asetpts=PTS/100');
  args.push('-c:a', format === 'mp4' ? 'aac' : 'libopus', '-b:a', '32k', '-threads', '1', filename);
  await execute('ffmpeg', args, { timeout: 10_000, maxBuffer: 32 * 1024 });
  return readFile(filename);
}

test('invalid, oversized, mismatched and manifest-like inputs are rejected before any child process or temp file', async t => {
  const root = await temp(t), process = fakeSpawn(), normalize = createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn });
  await assert.rejects(normalize('not bytes', { contentType: 'audio/webm' }), error(400, 'invalid_audio'));
  await assert.rejects(normalize(Buffer.alloc(0), { contentType: 'audio/webm' }), error(400, 'invalid_audio'));
  await assert.rejects(normalize(Buffer.alloc(VOICE_LIMITS.inputBytes + 1), { contentType: 'audio/webm' }), error(413, 'audio_too_large'));
  for (const contentType of ['video/webm', 'application/octet-stream', 'audio/wav', 'audio/webm; codecs=opus\n', 'audio/webm;filename=/private/file']) {
    await assert.rejects(normalize(webmHeader, { contentType }), error(415, 'unsupported_audio_type'));
  }
  for (const bytes of [Buffer.from('#EXTM3U\nhttp://127.0.0.1/private'), Buffer.from("ffconcat version 1.0\nfile '/private/file'"), Buffer.from('lavfi:sine=duration=999')]) {
    await assert.rejects(normalize(bytes, { contentType: 'audio/webm' }), error(422, 'invalid_audio'));
  }
  await assert.rejects(normalize(webmHeader, { contentType: 'audio/mp4' }), error(422, 'invalid_audio'));
  assert.equal(process.calls.length, 0); assert.deepEqual(await readdir(root), []);
});

test('one global admission slot applies across factories, has no waiting queue, and releases after failure', async t => {
  const root = await temp(t), process = fakeSpawn();
  const a = createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn }), b = createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn });
  const first = a(webmHeader, { contentType: 'audio/webm' });
  await assert.rejects(b(webmHeader, { contentType: 'audio/webm' }), error(429, 'audio_busy'));
  while (!process.calls.length) await new Promise(resolve => setImmediate(resolve));
  process.calls[0].child.emit('close', 1);
  await assert.rejects(first, error(422, 'invalid_audio'));
  const failing = fakeSpawn(({ child }) => child.emit('close', 1));
  await assert.rejects(createVoiceNormalizer({ tempRoot: root, testSpawn: failing.fn })(webmHeader, { contentType: 'audio/webm' }), error(422, 'invalid_audio'));
  assert.deepEqual(await readdir(root), []);
});

test('timeout kills the child before cleanup and returns no raw diagnostics or filesystem path', async t => {
  const root = await temp(t), process = fakeSpawn();
  const normalize = createVoiceNormalizer({ tempRoot: root, timeoutMs: 100, testSpawn: process.fn });
  await assert.rejects(normalize(webmHeader, { contentType: 'audio/webm' }), e => {
    assert.equal(e.message, 'audio_processing_timeout'); return error(504, 'audio_processing_timeout')(e);
  });
  assert.equal(process.calls[0].child.killedWith, 'SIGKILL');
  assert.deepEqual(await readdir(root), []);
});

test('stdout and stderr overflow kill processing with bounded retention and private cleanup', async t => {
  for (const stream of ['stdout', 'stderr']) {
    const root = await temp(t), limit = VOICE_LIMITS[`${stream}Bytes`];
    const process = fakeSpawn(({ child }) => child[stream].write(Buffer.alloc(limit + 1, 120)));
    await assert.rejects(createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn })(webmHeader, { contentType: 'audio/webm' }), error(422, 'audio_processing_limit'));
    assert.equal(process.calls[0].child.killedWith, 'SIGKILL'); assert.deepEqual(await readdir(root), []);
  }
});

test('missing tools, malformed probe results and non-audio tracks fail closed and clean their work directories', async t => {
  const valid = JSON.parse(probeJSON).streams[0];
  const invalidStreams = [[], [valid, valid], [{ ...valid, codec_type: 'video' }], [{ ...valid, codec_name: 'flac' }],
    [{ ...valid, channels: 64 }], [{ ...valid, sample_rate: '384000' }]];
  for (const output of ['not JSON', '{}', ...invalidStreams.map(streams => JSON.stringify({ streams }))]) {
    const root = await temp(t), process = fakeSpawn(({ child }) => { child.stdout.write(output); child.emit('close', 0); });
    await assert.rejects(createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn })(webmHeader, { contentType: 'audio/webm' }), error(422, 'invalid_audio'));
    assert.deepEqual(await readdir(root), []);
  }
  const root = await temp(t), process = fakeSpawn(({ child }) => { child.emit('error', new Error('/private/path/tool absent')); child.emit('close', -2); });
  await assert.rejects(createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn })(webmHeader, { contentType: 'audio/webm' }), error(503, 'audio_processing_unavailable'));
  assert.deepEqual(await readdir(root), []);
});

test('probe and decode arguments force the container, disable MP4 external references, and never inherit environment secrets', async t => {
  const root = await temp(t), bytes = Buffer.alloc(32); bytes.writeUInt32BE(32); bytes.write('ftyp', 4);
  const process = fakeSpawn(({ args, options, child }) => {
    assert.equal(options.shell, false); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.deepEqual(Object.keys(options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
    assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
    for (const name of ['input', 'decoded.pcm', 'voice.ogg']) assert.equal(statSync(path.join(options.cwd, name)).mode & 0o777, 0o600);
    for (const [flag, value] of [['-f', 'mov'], ['-protocol_whitelist', 'file'], ['-enable_drefs', '0'], ['-use_absolute_path', '0'], ['-threads', '1'], ['-max_alloc', String(VOICE_LIMITS.allocationBytes)]]) {
      assert.equal(args[args.indexOf(flag) + 1], value, flag);
    }
    assert.equal(args.some(arg => arg.includes('lavfi') || arg.startsWith('http:') || arg.startsWith('concat:')), false);
    if (process.calls.length === 1) { child.stdout.write(probeJSON.replace('opus', 'aac')); child.emit('close', 0); }
    else child.emit('close', 1);
  });
  await assert.rejects(createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn })(bytes, { contentType: 'audio/mp4;codecs=mp4a.40.2' }), error(422, 'invalid_audio'));
  assert.equal(process.calls.length, 2); assert.deepEqual(await readdir(root), []);
});

test('input bytes are copied before awaits, so callers cannot swap content after admission', async t => {
  const root = await temp(t), bytes = Buffer.from(webmHeader), expected = Buffer.from(bytes);
  const process = fakeSpawn(({ options, child }) => {
    assert.deepEqual(readFileSync(path.join(options.cwd, 'input')), expected); child.emit('close', 1);
  });
  const pending = createVoiceNormalizer({ tempRoot: root, testSpawn: process.fn })(bytes, { contentType: 'audio/webm' });
  bytes.fill(0);
  await assert.rejects(pending, error(422, 'invalid_audio'));
});

test('operator options reject invalid timeouts and untrusted binary-shaped strings', () => {
  for (const timeoutMs of [0, -1, 1.5, 60001, Infinity, '15000']) assert.throws(() => createVoiceNormalizer({ timeoutMs }), TypeError);
  for (const ffmpegPath of ['', '../ffmpeg', 'ffmpeg\n', 'ffmpeg -i']) assert.throws(() => createVoiceNormalizer({ ffmpegPath }), TypeError);
  assert.throws(() => createVoiceNormalizer({ tempRoot: 'relative' }), TypeError);
});

test('real WebM, Ogg and MP4 recordings become mono Opus with user metadata removed', realOptions, async t => {
  for (const format of ['webm', 'ogg', 'mp4']) {
    const bytes = await synthetic(t, { format, channels: 2, metadata: true }), root = await temp(t);
    const normalize = createVoiceNormalizer({ tempRoot: root });
    const result = await normalize(bytes, { contentType: `audio/${format}` });
    assert.equal(result.contentType, 'audio/ogg; codecs=opus');
    assert.ok(result.durationMs >= 950 && result.durationMs <= 1100, `${format}: ${result.durationMs}`);
    assert.ok(result.bytes.length > 0 && result.bytes.length <= VOICE_LIMITS.outputBytes);
    assert.equal(result.bytes.subarray(0, 4).toString(), 'OggS');
    assert.equal(result.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE')), false);
    assert.deepEqual(await readdir(root), []);
    const output = path.join(root, 'validated-output.ogg'); writeFileSync(output, result.bytes, { mode: 0o600 });
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'stream_tags:format_tags', '-of', 'json', output], { timeout: 3000, maxBuffer: 4096 });
    const tags = JSON.parse(stdout);
    assert.deepEqual(tags.streams[0].tags, { encoder: 'thesocialextra' });
    assert.deepEqual(tags.format.tags ?? {}, {});
  }
});

test('real 60-second voice is accepted; overlong audio is rejected rather than silently truncated', realOptions, async t => {
  const root = await temp(t), normalize = createVoiceNormalizer({ tempRoot: root });
  const exact = await normalize(await synthetic(t, { format: 'ogg', duration: 60 }), { contentType: 'audio/ogg; codecs="opus"' });
  assert.equal(exact.durationMs, 60_000); assert.ok(exact.bytes.length <= VOICE_LIMITS.outputBytes);
  for (const duration of [60.01, 75]) {
    await assert.rejects(normalize(await synthetic(t, { format: 'ogg', duration }), { contentType: 'audio/ogg' }), error(422, 'audio_too_long'));
    assert.deepEqual(await readdir(root), []);
  }
});

test('real decoding refuses corrupt containers and cleans files on ffmpeg failure', realOptions, async t => {
  const root = await temp(t), normalize = createVoiceNormalizer({ tempRoot: root });
  await assert.rejects(normalize(webmHeader, { contentType: 'audio/webm' }), error(422, 'invalid_audio'));
  assert.deepEqual(await readdir(root), []);
});

test('compressed input timestamps cannot disguise 75 seconds of decoded audio as a short voice', realOptions, async t => {
  const bytes = await synthetic(t, { duration: 75, compressedTimeline: true }), directory = await temp(t);
  const filename = path.join(directory, 'short-timestamps.webm'); writeFileSync(filename, bytes, { mode: 0o600 });
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filename], { timeout: 3000, maxBuffer: 4096 });
  assert.ok(Number(JSON.parse(stdout).format.duration) < 5);
  const root = await temp(t);
  await assert.rejects(createVoiceNormalizer({ tempRoot: root })(bytes, { contentType: 'audio/webm' }), error(422, 'audio_too_long'));
  assert.deepEqual(await readdir(root), []);
});

test('real subprocess execution uses only private generated paths and clears them after success', realOptions, async t => {
  const root = await temp(t), bytes = await synthetic(t), calls = [];
  const normalize = createVoiceNormalizer({ tempRoot: root, testSpawn(binary, args, options) {
    calls.push({ binary, args, options });
    assert.equal(statSync(options.cwd).mode & 0o777, 0o700);
    for (const name of ['input', 'decoded.pcm', 'voice.ogg']) assert.equal(statSync(path.join(options.cwd, name)).mode & 0o777, 0o600);
    return spawn(binary, args, options);
  } });
  await normalize(bytes, { contentType: 'audio/webm' });
  assert.equal(calls.length, 4); assert.deepEqual(await readdir(root), []);
  assert.equal(new Set(calls.map(call => call.options.cwd)).size, 1);
});

test('a successful encoder exit cannot smuggle a truncated or oversized output through final validation', realOptions, async t => {
  const bytes = await synthetic(t);
  for (const oversized of [false, true]) {
    const root = await temp(t);
    const normalize = createVoiceNormalizer({ tempRoot: root, testSpawn(binary, args, options) {
      const child = spawn(binary, args, options), output = args.at(-1);
      if (binary === 'ffmpeg' && output.endsWith('voice.ogg')) child.once('close', code => {
        if (code !== 0) return;
        const original = readFileSync(output);
        writeFileSync(output, oversized ? Buffer.alloc(VOICE_LIMITS.outputBytes + 1) : original.subarray(0, original.length - 40));
      });
      return child;
    } });
    await assert.rejects(normalize(bytes, { contentType: 'audio/webm' }),
      oversized ? error(422, 'audio_processing_limit') : error(500, 'audio_processing_failed'));
    assert.deepEqual(await readdir(root), []);
  }
});
