export function planExport(entries, rules) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 4096) throwErr();
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > 4096) throwErr();

  const entryPaths = new Map();
  for (const e of entries) {
    if (!isPlainObject(e)) throwErr();
    const { path, mode } = e;
    if (!isStr(path) || !isStr(mode)) throwErr();
    validatePath(path, false);
    const lower = path.toLowerCase();
    if (entryPaths.has(lower)) throwErr();
    entryPaths.set(lower, { path, mode });
  }

  const sources = new Map();
  const targets = new Map();
  const out = [];

  for (const r of rules) {
    if (!isPlainObject(r)) throwErr();
    const { source, target } = r;
    if (!isStr(source) || !isStr(target)) throwErr();
    validatePath(source, true);
    validatePath(target, true);

    const sl = source.toLowerCase();
    const tl = target.toLowerCase();
    if (sources.has(sl)) throwErr();
    if (targets.has(tl)) throwErr();

    const entry = entryPaths.get(sl);
    if (entry === undefined || entry.path !== source) throwErr();
    if (entry.mode !== '100644' && entry.mode !== '100755') throwErr();

    sources.set(sl, true);
    targets.set(tl, true);
    out.push({ source, target, mode: entry.mode });
  }

  checkCollisions(sources);
  checkCollisions(targets);

  out.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));
  return out.map((x) => ({ source: x.source, target: x.target, mode: x.mode }));
}

function throwErr() {
  const e = new Error('export plan invalid');
  e.code = 'export_plan_invalid';
  throw e;
}

function isPlainObject(o) {
  return o !== null && typeof o === 'object' && Object.getPrototypeOf(o) === Object.prototype;
}

function isStr(s) {
  return typeof s === 'string';
}

function validatePath(p, isRule) {
  if (p.length < 1 || p.length > 240) throwErr();
  if (p.includes('\\') || p.includes(':') || p.includes('%')) throwErr();
  if (/[\s\u0000-\u001F]/.test(p) || /[^\x00-\x7F]/.test(p)) throwErr();
  if (p.startsWith('/') || p.endsWith('/')) throwErr();

  const segs = p.split('/');
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..') throwErr();
    if (!/^[A-Za-z0-9_.-]+$/.test(seg)) throwErr();
    if (seg.toLowerCase() === '.git') throwErr();
    if (isRule && seg.startsWith('.') && p !== '.gitignore') throwErr();
  }
}

function checkCollisions(map) {
  const paths = Array.from(map.keys());
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const a = paths[i];
      const b = paths[j];
      if (a.startsWith(b + '/') || b.startsWith(a + '/')) throwErr();
    }
  }
}
