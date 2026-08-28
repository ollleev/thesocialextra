const MAX = 253402300799999;
const DURATIONS = new Set([30, 60, 120, 240]);

function isSafeInt(value) {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function normalizePostDeadline(value) {
  if (value === undefined) return { ok: true };
  if (isSafeInt(value) && value >= 0 && value <= MAX) {
    return { ok: true, notAfter: value };
  }
  return { ok: false, code: 'invalid_post_deadline' };
}

export function resolvePostExpiry(durationMinutes, notAfter, now) {
  if (!DURATIONS.has(durationMinutes)) {
    return { ok: false, code: 'invalid_duration' };
  }
  if (!isSafeInt(now) || now < 0 || now > MAX) {
    return { ok: false, code: 'invalid_post_time' };
  }
  const deadline = normalizePostDeadline(notAfter);
  if (!deadline.ok) {
    return { ok: false, code: 'invalid_post_deadline' };
  }
  if (deadline.notAfter !== undefined && deadline.notAfter <= now) {
    return { ok: false, code: 'post_deadline_elapsed' };
  }
  const uncapped = now + durationMinutes * 60000;
  const expiresAt = deadline.notAfter !== undefined
    ? Math.min(uncapped, deadline.notAfter)
    : uncapped;
  if (!isSafeInt(expiresAt) || expiresAt < 0 || expiresAt > MAX) {
    return { ok: false, code: 'invalid_post_time' };
  }
  return { ok: true, expiresAt };
}
