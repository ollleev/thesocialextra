const MAX_BYTES = 5 * 1024 * 1024;
// Leave one second for recorder scheduling/codec frames; the server checks the
// actual decoded samples and never accepts a truncated overlong recording.
const RECORD_MS = 59_000;
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
const error = code => Object.assign(new Error(code), { code });

/** A single in-memory draft. Closing a chat or changing account must discard it.
 * No permission request, recording, upload or playback starts in the constructor.
 */
export class VoiceComposer {
  constructor({ onChange = () => {}, Recorder = globalThis.MediaRecorder,
    getUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices),
    url = globalThis.URL, makeKey = () => crypto.randomUUID(), now = () => performance.now(),
    interval = (fn, ms) => globalThis.setInterval(fn, ms), clear = id => globalThis.clearInterval(id) } = {}) {
    Object.assign(this, { onChange, Recorder, getUserMedia, url, makeKey, now, interval, clear });
    this.mimeType = TYPES.find(type => Recorder?.isTypeSupported?.(type));
    this.generation = 0; this.phase = 'idle'; this.seconds = 0; this.error = null;
  }
  get supported() { return Boolean(this.mimeType && this.getUserMedia); }
  snapshot() { return { phase: this.phase, seconds: this.seconds, error: this.error, previewUrl: this.previewUrl || '', supported: this.supported }; }
  emit() { this.onChange(this.snapshot()); }
  releaseCapture() {
    this.clear(this.timer); this.timer = undefined;
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.stream = null;
  }
  discard() {
    ++this.generation;
    try { if (this.recorder?.state !== 'inactive') this.recorder?.stop(); } catch { /* Already stopped. */ }
    this.recorder = null; this.releaseCapture();
    if (this.previewUrl) this.url.revokeObjectURL(this.previewUrl);
    this.previewUrl = ''; this.blob = null; this.key = null; this.phase = 'idle'; this.seconds = 0; this.error = null;
    this.emit();
  }
  fail(code) { this.discard(); this.error = error(code); this.emit(); }
  async start() {
    if (!this.supported || this.phase !== 'idle') return;
    const generation = ++this.generation;
    this.phase = 'requesting'; this.error = null; this.emit();
    try {
      const stream = await this.getUserMedia({ audio: { channelCount: 1 }, video: false });
      if (generation !== this.generation) { for (const track of stream.getTracks()) track.stop(); return; }
      this.stream = stream;
      const recorder = new this.Recorder(stream, { mimeType: this.mimeType, audioBitsPerSecond: 32000 });
      this.recorder = recorder;
      const chunks = []; let bytes = 0;
      recorder.ondataavailable = event => {
        if (generation !== this.generation || !event.data?.size) return;
        bytes += event.data.size;
        if (bytes > MAX_BYTES) { this.fail('audio_too_large'); return; }
        chunks.push(event.data);
      };
      recorder.onerror = () => { if (generation === this.generation) this.fail('recording_failed'); };
      recorder.onstop = () => {
        if (generation !== this.generation) return;
        this.releaseCapture(); this.recorder = null;
        if (!bytes) { this.fail('recording_empty'); return; }
        this.blob = new Blob(chunks, { type: recorder.mimeType || this.mimeType });
        this.previewUrl = this.url.createObjectURL(this.blob); this.key = this.makeKey();
        this.phase = 'ready'; this.emit();
      };
      this.startedAt = this.now(); this.seconds = 0;
      recorder.start(250); this.phase = 'recording'; this.emit();
      this.timer = this.interval(() => {
        if (generation !== this.generation || this.phase !== 'recording') return;
        const elapsed = this.now() - this.startedAt;
        this.seconds = Math.min(59, Math.floor(elapsed / 1000)); this.emit();
        if (elapsed >= RECORD_MS) this.stop();
      }, 250);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.fail(cause?.name === 'NotAllowedError' ? 'microphone_denied' : 'recording_unavailable');
    }
  }
  stop() {
    if (this.phase !== 'recording') return;
    this.phase = 'finishing'; this.emit();
    try { this.recorder.stop(); } catch { this.fail('recording_failed'); }
  }
  beginSend() {
    if (this.phase !== 'ready' || !this.blob) return null;
    this.phase = 'sending'; this.error = null; this.emit();
    return { blob: this.blob, contentType: this.blob.type, key: this.key, generation: this.generation };
  }
  finishSend(intent, failure = null) {
    if (this.phase !== 'sending' || intent.generation !== this.generation || intent.key !== this.key) return false;
    if (!failure) this.discard();
    else { this.phase = 'ready'; this.error = failure; this.emit(); }
    return true;
  }
}

export async function uploadVoice(threadId, intent, { fetcher = fetch, timeoutMs = 40_000 } = {}) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(threadId)) throw error('thread_not_found');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`/api/threads/${threadId}/voice`, {
      method: 'POST', body: intent.blob, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': intent.contentType, 'Idempotency-Key': intent.key },
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(error(result.error || 'request_failed'), { status: response.status });
    return result;
  } catch (cause) { if (controller.signal.aborted) throw error('request_timeout'); throw cause; }
  finally { clearTimeout(timer); }
}
