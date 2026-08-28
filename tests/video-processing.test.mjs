import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createVideoNormalizer, VIDEO_LIMITS } from '../video-processing.mjs';

const execute = promisify(execFile);
const available = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { timeout: 3000, stdio: 'ignore' }).status === 0);
const hevcAvailable = available && (spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 3000, encoding: 'utf8' }).stdout ?? '').includes('libx265');
const real = { skip: available ? false : 'Existing FFmpeg/ffprobe unavailable; no installation attempted' };
const error = (status, code) => e => e.status === status && e.code === code;
async function temp(t) { const root = await mkdtemp(path.join(tmpdir(), 'extra-video-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function synthetic(t, { format = 'mp4', duration = 0.4, audio = false, fps = 30, width = 80, height = 40, metadata = false, rotation = 0, videoCodec, subtitle = false, colorTransfer } = {}) {
  const root = await temp(t), filename = path.join(root, `synthetic.${format}`);
  const picture = `color=c=black:s=${width}x${height}:r=${fps}:d=${duration},drawbox=x=0:y=0:w=iw/2:h=ih/2:color=red:t=fill,drawbox=x=iw/2:y=0:w=iw/2:h=ih/2:color=green:t=fill,drawbox=x=0:y=ih/2:w=iw/2:h=ih/2:color=blue:t=fill,drawbox=x=iw/2:y=ih/2:w=iw/2:h=ih/2:color=white:t=fill`;
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', picture];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`);
  if (subtitle) { const file = path.join(root, 'synthetic.srt'); await writeFile(file, '1\n00:00:00,000 --> 00:00:00,100\nSYNTHETIC_SUBTITLE\n', { mode: 0o600 }); args.push('-i', file); }
  args.push('-map', '0:v:0'); if (audio) args.push('-map', '1:a:0'); if (subtitle) args.push('-map', `${audio ? 2 : 1}:s:0`, '-c:s', 'mov_text');
  args.push('-threads', '1', '-filter_threads', '1', '-c:v', videoCodec ?? (format === 'webm' ? 'libvpx-vp9' : 'libx264'), '-pix_fmt', 'yuv420p');
  if (format === 'webm') args.push('-deadline', 'realtime', '-cpu-used', '8'); else if (videoCodec === 'libx265') args.push('-preset', 'ultrafast', '-x265-params', 'pools=none:frame-threads=1:wpp=0:log-level=error', '-tag:v', 'hvc1'); else if (!videoCodec || videoCodec === 'libx264') args.push('-preset', 'ultrafast', '-bf', '0');
  if (audio) args.push('-c:a', format === 'webm' ? 'libopus' : 'aac', '-b:a', '64k');
  if (colorTransfer) args.push('-color_trc', colorTransfer, '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-x264-params', `colorprim=bt2020:transfer=${colorTransfer}:colormatrix=bt2020nc`);
  if (metadata) args.push('-metadata', 'title=SYNTHETIC_PRIVATE_TITLE', '-metadata', 'comment=SYNTHETIC_PRIVATE_COMMENT', '-metadata', 'location=SYNTHETIC_PRIVATE_LOCATION', '-metadata:s:v', 'title=SYNTHETIC_PRIVATE_TRACK');
  args.push(filename); await execute('ffmpeg', args, { timeout: 15000, maxBuffer: 32768 });
  if (!rotation) return readFile(filename);
  const rotated = path.join(root, 'rotated.mp4'); await execute('ffmpeg', ['-v', 'error', '-nostdin', '-display_rotation:v:0', String(rotation), '-i', filename, '-c', 'copy', rotated], { timeout: 5000, maxBuffer: 32768 });
  return readFile(rotated);
}
async function info(t, bytes, decode = false) {
  const root = await temp(t), filename = path.join(root, 'result.mp4'); await writeFile(filename, bytes, { mode: 0o600 });
  const { stdout } = await execute('ffprobe', ['-v', 'error', ...(decode ? ['-count_frames'] : []), '-show_streams', '-show_format', '-of', 'json', filename], { timeout: 5000, maxBuffer: 32768 });
  return JSON.parse(stdout);
}
async function firstFrame(t, bytes) {
  const root = await temp(t), filename = path.join(root, 'pixels.mp4'); await writeFile(filename, bytes, { mode: 0o600 });
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-i', filename, '-frames:v', '1', '-threads', '1', '-filter_threads', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'buffer' });
  return stdout;
}

// Marker-only containers below belong to process models, not real decode proof.
const box = (name, payload = Buffer.alloc(0)) => { const header = Buffer.alloc(8); header.writeUInt32BE(8 + payload.length); header.write(name, 4); return Buffer.concat([header, payload]); };
const modelMP4 = () => Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), box('moov'), box('mdat')]);
const video = { index: 0, codec_type: 'video', codec_name: 'h264', width: 80, height: 40, pix_fmt: 'yuv420p', sample_aspect_ratio: '1:1', r_frame_rate: '30/1', avg_frame_rate: '30/1' };
const modelProbe = () => ({ streams: [{ ...video }], format: { duration: '0.4' } });
function frames(count = 12, change = {}) {
  return Array.from({ length: count }, (_, i) => `frame|media_type=video|stream_index=0|width=${change.width ?? 80}|height=${change.height ?? 40}|best_effort_timestamp_time=${((change.step ?? 1 / 30) * i).toFixed(6)}|duration_time=0.033333\n`).join('');
}
function fakeSpawn(onStart = () => {}) {
  const calls = [];
  const fn = (binary, args, options) => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { child.killedWith = signal; queueMicrotask(() => child.emit('close', null)); return true; };
    const call = { binary, args, options, child }; calls.push(call); queueMicrotask(() => onStart(call, calls.length)); return child; };
  return { fn, calls };
}
function stage(call, index) {
  if (index === 1 || index === 4) call.child.stdout.write(JSON.stringify(modelProbe()));
  if (index === 2 || index === 5) call.child.stdout.write(frames());
  if (index === 3) writeFileSync(call.args.at(-1), modelMP4());
  call.child.emit('close', 0);
}

test('real silent MP4 and WebM become decoded H264 MP4 with bounded geometry and no source metadata', real, async t => {
  for (const format of ['mp4', 'webm']) {
    const root = await temp(t), source = await synthetic(t, { format, metadata: true });
    assert.equal(source.includes(Buffer.from('SYNTHETIC_PRIVATE')), true);
    const result = await createVideoNormalizer({ tempRoot: root })(source, { contentType: `video/${format}` });
    assert.equal(result.contentType, 'video/mp4'); assert.equal(result.width, 80); assert.equal(result.height, 40);
    assert.ok(result.durationMs >= 390 && result.durationMs <= 440); assert.ok(result.bytes.length <= VIDEO_LIMITS.outputBytes);
    assert.equal(result.bytes.includes(Buffer.from('SYNTHETIC_PRIVATE')), false);
    const inspected = await info(t, result.bytes, true); assert.equal(inspected.streams.length, 1); assert.equal(inspected.streams[0].codec_name, 'h264'); assert.equal(inspected.streams[0].pix_fmt, 'yuv420p'); assert.equal(Number(inspected.streams[0].nb_read_frames), 12);
    assert.deepEqual(await readdir(root), []);
  }
});

test('real optional MP4 AAC and WebM Opus audio remain audible AAC mono after conversion', real, async t => {
  for (const format of ['mp4', 'webm']) {
    const root = await temp(t), result = await createVideoNormalizer({ tempRoot: root })(await synthetic(t, { format, audio: true }), { contentType: `video/${format}` });
    const inspected = await info(t, result.bytes, true), track = inspected.streams.find(s => s.codec_type === 'audio');
    assert.equal(track.codec_name, 'aac'); assert.equal(track.channels, 1); assert.equal(track.sample_rate, '48000'); assert.ok(Number(track.nb_read_frames) > 0);
    const filename = path.join(await temp(t), 'audible.mp4'); await writeFile(filename, result.bytes, { mode: 0o600 });
    const { stdout: pcm } = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-i', filename, '-map', '0:a:0', '-vn', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], { timeout: 5000, maxBuffer: 128 * 1024, encoding: 'buffer' });
    let peak = 0; for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i))); assert.ok(peak > 100);
    assert.ok(result.durationMs >= 390 && result.durationMs < 500); assert.deepEqual(await readdir(root), []);
  }
});

test('real QuickTime H264 and MP4/QuickTime HEVC normalize to H264 without widening limits', real, async t => {
  const root = await temp(t), normalize = createVideoNormalizer({ tempRoot: root });
  const mov = await synthetic(t, { format: 'mov', audio: true });
  assert.equal((await normalize(mov, { contentType: 'video/quicktime' })).contentType, 'video/mp4');
  await assert.rejects(normalize(mov, { contentType: 'video/mp4' }), error(422, 'invalid_video'));
  if (!hevcAvailable) t.diagnostic('Existing libx265 encoder unavailable: native HEVC fixture was not verified; no installation attempted.');
  else for (const format of ['mp4', 'mov']) {
    const result = await normalize(await synthetic(t, { format, videoCodec: 'libx265' }), { contentType: format === 'mov' ? 'video/quicktime' : 'video/mp4' });
    const inspected = await info(t, result.bytes, true); assert.equal(inspected.streams[0].codec_name, 'h264'); assert.equal(result.width, 80); assert.equal(result.height, 40);
  }
  assert.deepEqual(await readdir(root), []);
});

test('real cardinal rotation is applied to pixels and not left as a display matrix', real, async t => {
  for (const rotation of [90, -90, 180]) {
    const source = await synthetic(t, { rotation }), root = await temp(t), result = await createVideoNormalizer({ tempRoot: root })(source, { contentType: 'video/mp4' });
    assert.equal(result.width, Math.abs(rotation) === 90 ? 40 : 80); assert.equal(result.height, Math.abs(rotation) === 90 ? 80 : 40);
    const original = await firstFrame(t, source), normalized = await firstFrame(t, result.bytes);
    assert.equal(original.length, normalized.length);
    for (const [x, y] of [[.25, .25], [.75, .25], [.25, .75], [.75, .75]]) {
      const start = (Math.floor(y * result.height) * result.width + Math.floor(x * result.width)) * 3;
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(original[start + c] - normalized[start + c]) < 25);
    }
    assert.deepEqual(await readdir(root), []);
  }
});

test('real 15-second video is accepted and longer content is refused rather than shortened', real, async t => {
  const root = await temp(t), normalize = createVideoNormalizer({ tempRoot: root });
  const exact = await normalize(await synthetic(t, { duration: 15, width: 32, height: 16 }), { contentType: 'video/mp4' });
  assert.equal(exact.durationMs, 15000); assert.equal(Number((await info(t, exact.bytes, true)).streams[0].nb_read_frames), 450);
  await assert.rejects(normalize(await synthetic(t, { duration: 15.1, width: 32, height: 16 }), { contentType: 'video/mp4' }), error(422, 'video_too_long'));
  assert.deepEqual(await readdir(root), []);
});

test('real source 60fps, subtitle tracks and codecs outside the allowlist are refused', real, async t => {
  const root = await temp(t), normalize = createVideoNormalizer({ tempRoot: root });
  await assert.rejects(normalize(await synthetic(t, { fps: 60 }), { contentType: 'video/mp4' }), e => e.status === 422);
  await assert.rejects(normalize(await synthetic(t, { subtitle: true }), { contentType: 'video/mp4' }), e => e.status === 422);
  await assert.rejects(normalize(await synthetic(t, { videoCodec: 'mpeg4' }), { contentType: 'video/mp4' }), e => e.status === 422);
  assert.deepEqual(await readdir(root), []);
});

test('real PQ and HLG tagged sources are refused explicitly without an unimplemented tone mapping promise', real, async t => {
  const root=await temp(t),normalize=createVideoNormalizer({tempRoot:root});
  for(const colorTransfer of ['smpte2084','arib-std-b67']) {
    const bytes=await synthetic(t,{colorTransfer});
    assert.equal((await info(t,bytes)).streams[0].color_transfer,colorTransfer);
    await assert.rejects(normalize(bytes,{contentType:'video/mp4'}),error(422,'video_color_unsupported'));
  }
  assert.deepEqual(await readdir(root),[]);
});

test('HDR or wide-gamut colors cannot appear only in decoded frames behind ordinary stream metadata', async t => {
  for(const field of ['color_transfer=smpte2084','color_transfer=arib-std-b67','color_primaries=bt2020','color_space=bt2020nc','color_space=bt2020c']) {
    const root=await temp(t),process=fakeSpawn((call,index)=>{if(index===2)call.child.stdout.write(frames(1).replace('\n',`|${field}\n`));else stage(call,index);});
    await assert.rejects(createVideoNormalizer({tempRoot:root,testSpawn:process.fn})(modelMP4(),{contentType:'video/mp4'}),error(422,'video_color_unsupported'));
    assert.equal(process.calls.length,2);assert.equal(process.calls[1].child.killedWith,'SIGKILL');assert.deepEqual(await readdir(root),[]);
  }
});

test('real output reduces a larger input to an even, at-most-720px long side', real, async t => {
  const root = await temp(t), result = await createVideoNormalizer({ tempRoot: root })(await synthetic(t, { width: 800, height: 400, duration: 0.1 }), { contentType: 'video/mp4' });
  assert.equal(result.width, 720); assert.equal(result.height, 360); assert.deepEqual(await readdir(root), []);
});

test('one real 1920x1080 frame stays within the declared source geometry and decoder budget', real, async t => {
  const root = await temp(t), result = await createVideoNormalizer({ tempRoot: root })(await synthetic(t, { width: 1920, height: 1080, duration: 1 / 30 }), { contentType: 'video/mp4' });
  assert.equal(result.width, 720); assert.equal(result.height, 404); assert.ok(result.durationMs <= 34); assert.deepEqual(await readdir(root), []);
});

test('invalid MIME, containers, lengths and operator options fail before native processes', async t => {
  const root = await temp(t), process = fakeSpawn(), normalize = createVideoNormalizer({ tempRoot: root, testSpawn: process.fn });
  for (const timeoutMs of [0, -1, 1.5, 60001, Infinity, '15000']) assert.throws(() => createVideoNormalizer({ timeoutMs }), TypeError);
  for (const ffmpegPath of ['', '../ffmpeg', 'ffmpeg -i', 'ffmpeg\n']) assert.throws(() => createVideoNormalizer({ ffmpegPath }), TypeError);
  assert.throws(() => createVideoNormalizer({ tempRoot: 'relative' }), TypeError);
  await assert.rejects(normalize('not bytes', { contentType: 'video/mp4' }), error(400, 'invalid_video'));
  await assert.rejects(normalize(Buffer.alloc(VIDEO_LIMITS.inputBytes + 1), { contentType: 'video/mp4' }), error(413, 'video_too_large'));
  for (const contentType of ['video/avi', 'text/plain', 'video/mp4\n', 'video/mp4;filename=x', 'image/gif']) await assert.rejects(normalize(modelMP4(), { contentType }), error(415, 'unsupported_video_type'));
  for (const bytes of [Buffer.from('#EXTM3U\nhttps://example.invalid/'), modelMP4().subarray(0, -1), Buffer.from('ffconcat version 1.0'), Buffer.concat([modelMP4(), Buffer.from('trailing')])]) await assert.rejects(normalize(bytes, { contentType: 'video/mp4' }), error(422, 'invalid_video'));
  await assert.rejects(normalize(modelMP4(), { contentType: 'video/webm' }), error(422, 'invalid_video'));
  await assert.rejects(normalize(modelMP4(), { contentType: 'video/quicktime' }), error(422, 'invalid_video'));
  assert.equal(process.calls.length, 0); assert.deepEqual(await readdir(root), []);
});

test('header geometry, cadence, extra streams, cover art and malformed probe output fail closed', async t => {
  const probes = ['invalid JSON', '{}', { streams: [] }, { streams: [{ ...video, width: 3840, height: 2160 }] }, { streams: [{ ...video, r_frame_rate: '60/1' }] },
    { streams: [{ ...video, disposition: { attached_pic: 1 } }] }, { streams: [video, { index: 1, codec_type: 'subtitle' }] }, { streams: [video, { ...video, index: 1 }] }, { streams: [{ ...video, codec_name: 'mpeg4' }] }, { streams: [{ ...video, tags: { alpha_mode: '1' } }] }];
  for (const value of probes) {
    const root = await temp(t), process = fakeSpawn(({ child }) => { child.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); child.emit('close', 0); });
    await assert.rejects(createVideoNormalizer({ tempRoot: root, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' }), e => e.status === 422);
    assert.equal(process.calls.length, 1); assert.deepEqual(await readdir(root), []);
  }
});

test('decoded geometry, frame count, cadence and duration stop a lying stream immediately', async t => {
  const variants = [frames(2, { width: 3840, height: 2160 }), frames(451), frames(2, { step: 0.001 }), frames(1).replace('duration_time=0.033333', 'duration_time=16')];
  for (const value of variants) {
    const root = await temp(t), process = fakeSpawn((call, index) => { if (index === 2) call.child.stdout.write(value); else stage(call, index); });
    await assert.rejects(createVideoNormalizer({ tempRoot: root, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' }), e => e.status === 422);
    assert.equal(process.calls.length, 2); assert.equal(process.calls[1].child.killedWith, 'SIGKILL'); assert.deepEqual(await readdir(root), []);
  }
});

test('decoded audio samples and the independent PCM byte limit cannot be hidden by short metadata', async t => {
  for (const kind of ['frames', 'pcm']) {
    const root = await temp(t), process = fakeSpawn((call, index) => {
      if (index === 1) {
        const info = modelProbe(); info.streams.push({ index: 1, codec_type: 'audio', codec_name: 'aac', channels: 1, sample_rate: '48000' });
        call.child.stdout.write(JSON.stringify(info)); call.child.emit('close', 0);
      } else if (index === 2) {
        call.child.stdout.write(frames());
        for (let i = 0; i < (kind === 'frames' ? 704 : 19); i++) call.child.stdout.write(`frame|media_type=audio|stream_index=1|best_effort_timestamp_time=${(i * 1024 / 48000).toFixed(6)}|duration_time=0.021333|nb_samples=1024\n`);
        if (kind === 'pcm') call.child.emit('close', 0);
      } else {
        assert.equal(index, 3); writeFileSync(call.args.at(-1), Buffer.alloc(VIDEO_LIMITS.sampleRate * 2 * 15 + 2)); call.child.emit('close', 0);
      }
    });
    await assert.rejects(createVideoNormalizer({ tempRoot: root, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' }), error(422, 'video_too_long'));
    assert.equal(process.calls.length, kind === 'frames' ? 2 : 3);
    if (kind === 'frames') assert.equal(process.calls[1].child.killedWith, 'SIGKILL');
    assert.deepEqual(await readdir(root), []);
  }
});

test('all children use private files, fixed allowed protocols, reduced env and one shared deadline', async t => {
  const root = await temp(t), process = fakeSpawn((call, index) => {
    assert.equal(call.options.shell, false); assert.deepEqual(Object.keys(call.options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
    assert.equal(statSync(call.options.cwd).mode & 0o777, 0o700);
    for (const file of ['input', 'decoded.pcm', 'video.mp4']) assert.equal(statSync(path.join(call.options.cwd, file)).mode & 0o777, 0o600);
    for (const [flag, value] of [['-protocol_whitelist', 'file'], ['-threads', '1'], ['-max_alloc', String(VIDEO_LIMITS.allocationBytes)], ['-max_pixels', String(VIDEO_LIMITS.inputPixels)], ['-enable_drefs', '0'], ['-use_absolute_path', '0']]) assert.equal(call.args[call.args.indexOf(flag) + 1], value);
    if (index === 3) { assert.equal(call.args.includes('-t'), false); assert.equal(call.args[call.args.indexOf('-frames:v') + 1], '451'); assert.ok(call.args.includes('filter_units=remove_types=6')); }
    stage(call, index);
  });
  const result = await createVideoNormalizer({ tempRoot: root, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' });
  assert.equal(result.durationMs, 400); assert.equal(process.calls.length, 5); assert.deepEqual(await readdir(root), []);
});

test('concurrency has one slot across factories, no queued conversion and releases after an error', async t => {
  const root = await temp(t), process = fakeSpawn(), a = createVideoNormalizer({ tempRoot: root, testSpawn: process.fn }), b = createVideoNormalizer({ tempRoot: root, testSpawn: process.fn });
  const first = a(modelMP4(), { contentType: 'video/mp4' }); await assert.rejects(b(modelMP4(), { contentType: 'video/mp4' }), error(429, 'video_busy'));
  while (!process.calls.length) await new Promise(resolve => setImmediate(resolve));
  process.calls[0].child.emit('close', 1); await assert.rejects(first, error(422, 'invalid_video'));
  assert.equal((await createVideoNormalizer({ tempRoot: root, testSpawn: fakeSpawn(stage).fn })(modelMP4(), { contentType: 'video/mp4' })).contentType, 'video/mp4');
  assert.deepEqual(await readdir(root), []);
});

test('timeout and bounded stdout/stderr kill before cleanup without exposing diagnostics', async t => {
  for (const kind of ['timeout', 'stdout', 'stderr']) {
    const root = await temp(t), process = fakeSpawn(({ child }) => { if (kind !== 'timeout') child[kind].write(Buffer.alloc(VIDEO_LIMITS[`${kind}Bytes`] + 1, 120)); });
    await assert.rejects(createVideoNormalizer({ tempRoot: root, timeoutMs: 100, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' }), error(kind === 'timeout' ? 504 : 422, kind === 'timeout' ? 'video_processing_timeout' : 'video_processing_limit'));
    assert.equal(process.calls[0].child.killedWith, 'SIGKILL'); assert.deepEqual(await readdir(root), []);
  }
  const root = await temp(t), process = fakeSpawn((call, index) => { if (index === 1) setTimeout(() => stage(call, index), 60); });
  await assert.rejects(createVideoNormalizer({ tempRoot: root, timeoutMs: 110, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' }), error(504, 'video_processing_timeout'));
  assert.equal(process.calls.length, 2); assert.equal(process.calls[1].child.killedWith, 'SIGKILL'); assert.deepEqual(await readdir(root), []);
});

test('input snapshot survives caller mutation; missing tools return only sanitized errors', async t => {
  const root = await temp(t), source = modelMP4(), process = fakeSpawn((call, index) => { assert.deepEqual(readFileSync(path.join(call.options.cwd, 'input')), modelMP4()); stage(call, index); });
  const pending = createVideoNormalizer({ tempRoot: root, testSpawn: process.fn })(source, { contentType: 'video/mp4' }); source.fill(0); await pending;
  const missing = fakeSpawn(({ child }) => { child.emit('error', new Error('SYNTHETIC_PRIVATE_PATH')); child.emit('close', -2); });
  await assert.rejects(createVideoNormalizer({ tempRoot: root, testSpawn: missing.fn })(modelMP4(), { contentType: 'video/mp4' }), e => { assert.equal(e.message, 'video_processing_unavailable'); return error(503, 'video_processing_unavailable')(e); });
  assert.deepEqual(await readdir(root), []);
});

test('encoder success cannot hide oversized, truncated, tagged or shortened output', async t => {
  for (const kind of ['size', 'container', 'tags', 'short', 'one-frame-short']) {
    const root = await temp(t), process = fakeSpawn((call, index) => {
      if (index === 3 && ['size', 'container'].includes(kind)) { writeFileSync(call.args.at(-1), kind === 'size' ? Buffer.alloc(VIDEO_LIMITS.outputBytes + 1) : modelMP4().subarray(0, -1)); call.child.emit('close', 0); }
      else if (index === 4 && kind === 'tags') { const info = modelProbe(); info.format.tags = { location: 'SYNTHETIC_PRIVATE' }; call.child.stdout.write(JSON.stringify(info)); call.child.emit('close', 0); }
      else if (index === 5 && ['short', 'one-frame-short'].includes(kind)) { call.child.stdout.write(frames(kind === 'short' ? 1 : 11)); call.child.emit('close', 0); }
      else stage(call, index);
    });
    await assert.rejects(createVideoNormalizer({ tempRoot: root, testSpawn: process.fn })(modelMP4(), { contentType: 'video/mp4' }), error(kind === 'size' ? 422 : 500, kind === 'size' ? 'video_processing_limit' : 'video_processing_failed'));
    assert.deepEqual(await readdir(root), []);
  }
});

test('real truncated MP4 payload never returns a usable normalized video', real, async t => {
  const bytes = await synthetic(t), root = await temp(t);
  await assert.rejects(createVideoNormalizer({ tempRoot: root })(bytes.subarray(0, bytes.length - 20), { contentType: 'video/mp4' }), e => e.status === 422);
  assert.deepEqual(await readdir(root), []);
});
