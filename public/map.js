// Viewport-only OSM tile rendering. Browser cache is preserved; no prefetch or offline download.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const HOME = { lat: 48.8689, lng: 2.3598 };
function project(lat, lng, zoom) {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return { x: (lng + 180) / 360 * size, y: (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}
function unproject(x, y, zoom) {
  const size = 256 * 2 ** zoom;
  return { lng: x / size * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI };
}
export class LocalMap {
  constructor(element, { pinHTML, onSelect, onOverflow }) {
    this.element = element; this.tiles = element.querySelector('#map-tiles'); this.pins = element.querySelector('#map-pins');
    this.center = { ...HOME }; this.zoom = element.clientWidth < 420 ? 12 : 13; this.posts = []; this.selected = null; this.pinHTML = pinHTML; this.onSelect = onSelect;
    this.onOverflow = onOverflow; this.images = new Map(); this.errors = 0; this.seen = new Set(); this.fresh = new Map(); this.initialized = false;
    this.resizeObserver = new ResizeObserver(() => this.render()); this.resizeObserver.observe(element);
    let drag = null;
    element.addEventListener('pointerdown', event => {
      if (event.target.closest('button')) return;
      drag = { x: event.clientX, y: event.clientY, center: project(this.center.lat, this.center.lng, this.zoom) };
      element.setPointerCapture(event.pointerId); element.classList.add('dragging');
    });
    element.addEventListener('pointermove', event => {
      if (!drag) return;
      this.center = unproject(drag.center.x - event.clientX + drag.x, drag.center.y - event.clientY + drag.y, this.zoom);
      this.center.lat = Math.max(-85.05, Math.min(85.05, this.center.lat));
      this.center.lng = ((this.center.lng + 540) % 360) - 180;
      this.render();
    });
    const end = () => { drag = null; element.classList.remove('dragging'); };
    element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end);
    element.addEventListener('keydown', event => {
      if (event.target !== element) return;
      const keys = { ArrowUp: [0, -80], ArrowDown: [0, 80], ArrowLeft: [-80, 0], ArrowRight: [80, 0] };
      if (keys[event.key]) { event.preventDefault(); const p = project(this.center.lat, this.center.lng, this.zoom); this.center = unproject(p.x + keys[event.key][0], p.y + keys[event.key][1], this.zoom); this.render(); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this.changeZoom(1); }
      if (event.key === '-') { event.preventDefault(); this.changeZoom(-1); }
    });
    this.pins.addEventListener('click', event => { const pin = event.target.closest('[data-post]'); if (pin) this.onSelect(pin.dataset.post); });
  }
  update(posts, selected) { for (const p of posts) { if (this.initialized && !this.seen.has(p.id) && !p.demo && Date.now() - p.createdAt < 8000) this.fresh.set(p.id, Date.now() + 8000); this.seen.add(p.id); } this.initialized = true; this.posts = posts; this.selected = selected; this.renderPins(); }
  changeZoom(amount) { this.zoom = Math.max(2, Math.min(16, this.zoom + amount)); this.render(); }
  recenter(zone) { this.center = zone ? { lat: zone.lat, lng: zone.lng } : { ...HOME }; this.zoom = zone?.id && !zone.country ? 14 : this.element.clientWidth < 420 ? 12 : 13; this.render(); }
  render() {
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!width || !height) return;
    this.center.lat = Math.max(-85.05, Math.min(85.05, this.center.lat));
    this.center.lng = ((this.center.lng + 540) % 360) - 180;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    const left = center.x - width / 2, top = center.y - height / 2;
    const visible = new Set();
    for (let x = Math.floor(left / 256); x <= Math.floor((left + width) / 256); x++) {
      for (let y = Math.floor(top / 256); y <= Math.floor((top + height) / 256); y++) {
        const total = 2 ** this.zoom; if (y < 0 || y >= total) continue;
        const wrappedX = ((x % total) + total) % total;
        const key = `${this.zoom}/${x}/${y}`; visible.add(key);
        let image = this.images.get(key);
        if (!image) {
          image = new Image(256, 256); image.alt = ''; image.draggable = false;
          image.src = TILE_URL.replace('{z}', this.zoom).replace('{x}', wrappedX).replace('{y}', y);
          image.addEventListener('error', () => { this.errors++; if (this.errors >= 3) document.querySelector('#map-error').hidden = false; });
          image.addEventListener('load', () => { this.errors = 0; document.querySelector('#map-error').hidden = true; });
          this.images.set(key, image); this.tiles.append(image);
        }
        image.style.left = `${Math.round(x * 256 - left)}px`; image.style.top = `${Math.round(y * 256 - top)}px`;
      }
    }
    for (const [key, image] of this.images) if (!visible.has(key)) { image.remove(); this.images.delete(key); }
    this.renderPins();
  }
  renderPins() {
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!width || !height) return;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    const occupied = []; let overflow = 0;
    this.pins.replaceChildren();
    for (const post of this.posts) {
      const point = project(post.lat, post.lng, this.zoom);
      const world = 256 * 2 ** this.zoom;
      const dx = ((point.x - center.x + world * 1.5) % world) - world / 2;
      const x = dx + width / 2, y = point.y - center.y + height / 2;
      if (x < -80 || x > width + 80 || y < 20 || y > height - 15) continue;
      const button = document.createElement('button');
      button.className = `map-pin ${(this.fresh.get(post.id) || 0) > Date.now() ? 'fresh' : ''} ${post.kind === 'need' ? 'need' : ''} ${post.status === 'full' ? 'full' : ''} ${post.id === this.selected ? 'selected' : ''}`;
      button.dataset.post = post.id;
      button.setAttribute('aria-label', `${post.role}, ${post.zoneLabel}, ${post.status === 'full' ? 'clôturé' : post.kind === 'available' ? 'disponible' : `${post.places} place${post.places > 1 ? 's' : ''}`}${post.demo ? ', exemple' : ''}`);
      button.setAttribute('aria-pressed', String(post.id === this.selected));
      button.innerHTML = this.pinHTML(post); this.pins.append(button);
      const w = button.offsetWidth, h = button.offsetHeight;
      const candidates = [];
      for (const dy of [0, -42, 42, -84, 84, -126, 126, -168, 168]) {
        for (const dx of [0, -110, 110, -220, 220]) candidates.push({ x: Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, x + dx)), y: Math.max(85, Math.min(height - 70, y + dy)) });
      }
      candidates.sort((a,b) => (a.x-x)**2+(a.y-y)**2 - ((b.x-x)**2+(b.y-y)**2));
      const fit = candidates.find(p => !occupied.some(r => Math.abs(p.x-r.x) < (w+r.w)/2+8 && Math.abs(p.y-r.y) < (h+r.h)/2+10));
      if (!fit) { button.remove(); overflow++; continue; }
      occupied.push({ ...fit, w, h });
      button.style.left = `${fit.x}px`; button.style.top = `${fit.y}px`;
      if (Math.hypot(fit.x-x, fit.y-y) > 18) {
        const anchor = document.createElement('span'), leader = document.createElement('span');
        anchor.className = 'map-anchor'; anchor.style.left = `${x}px`; anchor.style.top = `${y}px`;
        leader.className = 'map-leader'; leader.style.left = `${x}px`; leader.style.top = `${y}px`;
        leader.style.width = `${Math.hypot(fit.x-x, fit.y-y)}px`;
        leader.style.transform = `rotate(${Math.atan2(fit.y-y,fit.x-x)}rad)`;
        anchor.setAttribute('aria-hidden','true'); leader.setAttribute('aria-hidden','true');
        this.pins.prepend(anchor,leader);
      }
    }
    if (overflow) { const more = document.createElement('button'); more.className = 'map-overflow'; more.textContent = `+ ${overflow} annonces · voir le fil`; more.addEventListener('click', () => this.onOverflow?.()); this.pins.append(more); }
  }
}
