import { ApiError } from './domain.mjs';
import { VOICE_LIMITS } from './audio-processing.mjs';

const TYPES = /^audio\/(webm|ogg|mp4)(?:\s*;\s*codecs=(?:"[a-zA-Z0-9., -]+"|[a-zA-Z0-9.,-]+))?$/i;

// Called only after account, conversation, origin, rate and admission checks.
// No filenames, URLs or operator options are accepted from an upload.
export async function readVoiceBody(req, timeoutMs = 10_000) {
  const type = req.headers['content-type'];
  if (typeof type !== 'string' || type.length > 120 || /[\0\r\n]/.test(type) || !TYPES.test(type)) throw new ApiError(415, 'unsupported_audio_type');
  if (req.headers['content-encoding'] !== undefined) throw new ApiError(415, 'unsupported_audio_encoding');
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > VOICE_LIMITS.inputBytes)) throw new ApiError(413, 'audio_too_large');
  const chunks = []; let size = 0;
  const timer = setTimeout(() => req.destroy(), timeoutMs);
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > VOICE_LIMITS.inputBytes) throw new ApiError(413, 'audio_too_large');
      chunks.push(chunk);
    }
    if (!size) throw new ApiError(400, 'invalid_audio');
    return { bytes: Buffer.concat(chunks, size), contentType: type.split(';')[0].trim().toLowerCase() };
  } finally { clearTimeout(timer); }
}

export function sendVoice(res, output) {
  res.writeHead(200, {
    'Content-Type': output.contentType,
    'Content-Length': output.bytes.length,
    'Content-Disposition': 'inline; filename="voice.ogg"',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Accept-Ranges': 'none',
  });
  res.end(output.bytes);
}
