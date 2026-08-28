const DURATIONS = [30, 60, 120, 240];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;
const safeMs = v => Number.isSafeInteger(v) && v >= 0 && v <= 253402300799999;
const civil = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return false;
  const [date, time] = v.split('T');
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
};
const zone = v => {
  if (!str(v, 128) || /^[+-]/.test(v)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: v }); return true; }
  catch { return false; }
};
const bad = code => ({ ok: false, code });

export function prepareEventPost(plan, needId, options) {
  try {
    if (!obj(plan) || !str(plan.id, 128) || !Number.isSafeInteger(plan.revision) || plan.revision < 1 ||
        !str(plan.cityId, 32) || !civil(plan.startLocal) || !civil(plan.endLocal) || !safeMs(plan.startsAt) ||
        !safeMs(plan.endsAt) || plan.endsAt <= plan.startsAt || !zone(plan.timezone) || !Array.isArray(plan.needs))
      return bad('event_draft_invalid');
    if (!str(needId, 128) || !obj(options) || !safeMs(options.now) ||
        !Array.isArray(options.roles) || options.roles.length === 0 ||
        options.roles.some(r => typeof r !== 'string' || r.length === 0)) return bad('event_draft_invalid');
    const matches = plan.needs.filter(n => obj(n) && n.id === needId);
    if (matches.length !== 1) return bad('event_draft_invalid');
    const need = matches[0];
    if (!str(need.id, 128) || typeof need.role !== 'string' || !Number.isInteger(need.quantity) ||
        need.quantity < 1 || need.quantity > 50 || !Number.isInteger(need.confirmed) || need.confirmed < 0 ||
        need.confirmed > need.quantity || !obj(need.languages) ||
        !['none', 'preferred', 'required'].includes(need.languages.fr) ||
        !['none', 'preferred', 'required'].includes(need.languages.en) || !options.roles.includes(need.role))
      return bad('event_draft_invalid');
    if (options.now >= plan.endsAt) return bad('event_finished');
    const remaining = need.quantity - need.confirmed;
    if (remaining === 0) return bad('event_need_full');
    let places;
    if (has(options, 'places')) {
      if (!Number.isInteger(options.places) || options.places < 1 || options.places > 8 || options.places > remaining)
        return bad('event_places_invalid');
      places = options.places;
    } else {
      if (remaining > 8) return bad('event_places_required');
      places = remaining;
    }
    const allowedDurations = DURATIONS.filter(m => options.now + m * 60000 <= plan.endsAt);
    if (allowedDurations.length === 0) return bad('event_window_too_short');
    let durationMinutes;
    if (has(options, 'durationMinutes')) {
      if (!allowedDurations.includes(options.durationMinutes)) return bad('event_duration_invalid');
      durationMinutes = options.durationMinutes;
    } else {
      durationMinutes = allowedDurations.filter(m => m <= 60).pop();
      if (durationMinutes === undefined) return bad('event_duration_invalid');
    }
    let extra = '';
    if (has(options, 'extraNote')) {
      if (typeof options.extraNote !== 'string' || /[\u0000-\u0008\u000B-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(options.extraNote))
        return bad('event_note_invalid');
      extra = options.extraNote.trim().replace(/\s+/gu, ' ');
    }
    const [sd, st] = plan.startLocal.split('T');
    const [ed, et] = plan.endLocal.split('T');
    const fmt = d => d.split('-').reverse().join('/');
    let note = `Mission : ${fmt(sd)} ${st} → ${fmt(ed)} ${et} (${plan.timezone}).`;
    if (need.languages.fr === 'required') note += ' Français requis.';
    else if (need.languages.fr === 'preferred') note += ' Français souhaité.';
    if (need.languages.en === 'required') note += ' Anglais requis.';
    else if (need.languages.en === 'preferred') note += ' Anglais souhaité.';
    if (extra) note += ` ${extra}`;
    if (note.length > 180) return bad('event_note_too_long');
    return { ok: true, draft: { kind: 'need', role: need.role, cityId: plan.cityId, english: need.languages.en === 'required', vehicle: false, durationMinutes, notAfter: plan.endsAt, places, note }, source: { planId: plan.id, revision: plan.revision, needId: need.id }, remaining, allowedDurations };
  } catch { return bad('event_draft_invalid'); }
}
