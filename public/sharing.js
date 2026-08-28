const KINDS = new Set(['all', 'available', 'need']);
const cityIdIsValid = value => typeof value === 'string' && value.length >= 1 && value.length <= 12 && value[0] !== '0' && !/[^0-9]/.test(value);
const postIdIsValid = value => typeof value === 'string' && value.length >= 1 && value.length <= 80 && !/[^a-zA-Z0-9-]/.test(value);
const empty = invalid => ({ postId: null, scope: null, invalid });

/** Read only an allowlist. Location IDs must still be resolved by the catalog API. */
export function parseFeedLink(value, roles = []) {
  let url;
  try { if (String(value).length > 4096) return empty(true); url = new URL(value); }
  catch { return empty(true); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return empty(true);
  const params = url.searchParams;
  // Existing post links have priority; never combine their destination with feed filters.
  if (params.has('post')) {
    const postId = params.get('post');
    return params.getAll('post').length === 1 && postIdIsValid(postId)
      ? { postId, scope: null, invalid: false } : empty(true);
  }
  let invalid = [...params.keys()].some(key => !['city', 'role', 'kind'].includes(key));
  if (!params.has('city')) return empty(invalid || params.has('role') || params.has('kind'));
  const cityId = params.get('city');
  if (params.getAll('city').length !== 1 || !cityIdIsValid(cityId)) return empty(true);
  let role = params.get('role') ?? 'all', kind = params.get('kind') ?? 'all';
  if (params.getAll('role').length > 1 || (role !== 'all' && !roles.includes(role))) { role = 'all'; invalid = true; }
  if (params.getAll('kind').length > 1 || !KINDS.has(kind)) { kind = 'all'; invalid = true; }
  return { postId: null, scope: { cityId, role, kind }, invalid };
}

/** Rebuild from scratch: never copy GPS, account, capability, UTM or hash state. */
export function makeFeedShare({ origin, city, role = 'all', kind = 'all' }, roles = []) {
  let source;
  try { source = new URL(origin); } catch { throw new TypeError('invalid_share_origin'); }
  if (!['http:', 'https:'].includes(source.protocol) || source.username || source.password) throw new TypeError('invalid_share_origin');
  if (!city || !cityIdIsValid(city.id)
    || typeof city.name !== 'string' || !city.name.trim() || city.name.length > 200 || /[\u0000-\u001f\u007f]/.test(city.name)) throw new TypeError('invalid_share_city');
  if ((role !== 'all' && !roles.includes(role)) || !KINDS.has(kind)) throw new TypeError('invalid_share_scope');
  const url = new URL('/', source.origin);
  url.searchParams.set('city', city.id);
  url.searchParams.set('role', role);
  url.searchParams.set('kind', kind);
  const type = { all: 'Les dernières annonces', available: 'Les personnes disponibles', need: 'Les missions à pourvoir' }[kind];
  const text = `${type} à ${city.name} · ${role === 'all' ? 'Tous les métiers' : role} sur thesocialextra. Gratuit, en direct.`;
  return { url: url.href, text, clipboardText: `${text}\n${url.href}` };
}
