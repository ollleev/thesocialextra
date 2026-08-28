import { preserveLiveFocus } from './live-focus.js';

// Viewport-only OSM tile rendering. Browser cache is preserved; no prefetch or offline download.
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const HOME = { lat: 48.8689, lng: 2.3598 };
export function project(lat, lng, zoom) {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return { x: (lng + 180) / 360 * size, y: (.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size };
}
export function unproject(x, y, zoom) {
  const size = 256 * 2 ** zoom;
  return { lng: x / size * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI };
}
function bounded(center) {
  return {lat:Math.max(-85.05,Math.min(85.05,center.lat)),lng:((center.lng+540)%360)-180};
}
export function zoomViewAt(view, amount, point, size) {
  const zoom=Math.max(2,Math.min(16,view.zoom+amount)),before=project(view.center.lat,view.center.lng,view.zoom);
  const ratio=2**(zoom-view.zoom),dx=point.x-size.width/2,dy=point.y-size.height/2;
  return {zoom,center:bounded(unproject((before.x+dx)*ratio-dx,(before.y+dy)*ratio-dy,zoom))};
}
/** One finger pans; two fingers keep the geographic point under their midpoint.
 * Fractional zoom is rendered from integer OSM tiles, with no tile prefetch. */
export function gestureView(start, points, size) {
  const middle=list=>({x:list.reduce((sum,p)=>sum+p.x,0)/list.length,y:list.reduce((sum,p)=>sum+p.y,0)/list.length});
  const before=middle(start.points),after=middle(points),origin=project(start.center.lat,start.center.lng,start.zoom);
  let zoom=start.zoom;
  if(start.points.length===2&&points.length===2) {
    const distance=list=>Math.hypot(list[1].x-list[0].x,list[1].y-list[0].y);
    if(distance(start.points)>=12&&distance(points)>=12)zoom=Math.max(2,Math.min(16,start.zoom+Math.log2(distance(points)/distance(start.points))));
  }
  const ratio=2**(zoom-start.zoom);
  return {zoom,center:bounded(unproject((origin.x+before.x-size.width/2)*ratio-after.x+size.width/2,(origin.y+before.y-size.height/2)*ratio-after.y+size.height/2,zoom))};
}
export class LocalMap {
  constructor(element, { pinHTML, onSelect, onOverflow, onViewChange }) {
    this.element = element; this.tiles = element.querySelector('#map-tiles'); this.pins = element.querySelector('#map-pins');
    this.center = { ...HOME }; this.zoom = element.clientWidth < 420 ? 12 : 13; this.posts = []; this.selected = null; this.pinHTML = pinHTML; this.onSelect = onSelect;
    this.onOverflow = onOverflow; this.onViewChange=onViewChange; this.images = new Map(); this.errors = 0; this.seen = new Set(); this.fresh = new Map(); this.initialized = false;
    this.home={...this.center};this.homeZoom=this.zoom;this.pointers=new Map();this.frame=null;this.ignoreClickUntil=0;
    this.resizeObserver = new ResizeObserver(() => this.render()); this.resizeObserver.observe(element);
    const size=()=>({width:element.clientWidth,height:element.clientHeight});
    const point=event=>{const rect=element.getBoundingClientRect();return {x:event.clientX-rect.left,y:event.clientY-rect.top};};
    const restart=()=>{this.gesture=this.pointers.size?{center:{...this.center},zoom:this.zoom,points:[...this.pointers.values()]}:null;};
    element.addEventListener('pointerdown', event => {
      if ((event.pointerType==='mouse'&&event.button!==0)||this.pointers.size>=2||event.target.closest('a,button')) return;
      if(!this.pointers.size)this.ignoreClickUntil=0;
      this.pointers.set(event.pointerId,point(event));restart();
      element.setPointerCapture(event.pointerId); element.classList.add('dragging');
    });
    element.addEventListener('pointermove', event => {
      if(!this.pointers.has(event.pointerId)||!this.gesture)return;
      this.pointers.set(event.pointerId,point(event));
      const points=[...this.pointers.values()];
      if(points.length===2||points.some((p,i)=>Math.hypot(p.x-this.gesture.points[i].x,p.y-this.gesture.points[i].y)>5))this.ignoreClickUntil=Date.now()+400;
      Object.assign(this,gestureView(this.gesture,points,size()));this.scheduleRender();
    });
    const end = event => {
      if(!this.pointers.delete(event.pointerId))return;
      if(element.hasPointerCapture?.(event.pointerId))element.releasePointerCapture(event.pointerId);
      restart();if(!this.pointers.size)element.classList.remove('dragging');this.scheduleRender();
    };
    element.addEventListener('pointerup', end); element.addEventListener('pointercancel', end);element.addEventListener('lostpointercapture',end);
    element.addEventListener('click',event=>{if(Date.now()<this.ignoreClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
    element.addEventListener('dblclick',event=>{if(event.target.closest('button,a'))return;event.preventDefault();Object.assign(this,zoomViewAt(this,1,point(event),size()));this.render();});
    element.addEventListener('wheel',event=>{
      // Normal scrolling still scrolls the page. Trackpad pinch / Ctrl+wheel is
      // consumed only inside the map; browser zoom elsewhere is unchanged.
      if(!event.ctrlKey||!Number.isFinite(event.deltaY))return;
      event.preventDefault();Object.assign(this,zoomViewAt(this,Math.max(-.5,Math.min(.5,-event.deltaY*.01)),point(event),size()));this.scheduleRender();
    },{passive:false});
    element.addEventListener('keydown', event => {
      if (event.target !== element) return;
      const keys = { ArrowUp: [0, -80], ArrowDown: [0, 80], ArrowLeft: [-80, 0], ArrowRight: [80, 0] };
      if (keys[event.key]) { event.preventDefault(); const p = project(this.center.lat, this.center.lng, this.zoom); this.center = unproject(p.x + keys[event.key][0], p.y + keys[event.key][1], this.zoom); this.render(); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this.changeZoom(1); }
      if (event.key === '-') { event.preventDefault(); this.changeZoom(-1); }
      if (event.key === 'Home') {event.preventDefault();this.center={...this.home};this.zoom=this.homeZoom;this.render();}
    });
    this.pins.addEventListener('click', event => { const pin = event.target.closest('[data-post]'); if (pin) this.onSelect(pin.dataset.post); });
  }
  scheduleRender(){if(this.frame!==null)return;this.frame=requestAnimationFrame(()=>{this.frame=null;this.render();});}
  update(posts, selected) { for (const p of posts) { if (this.initialized && !this.seen.has(p.id) && !p.demo && Date.now() - p.createdAt < 8000) this.fresh.set(p.id, Date.now() + 8000); this.seen.add(p.id); } this.initialized = true; this.posts = posts; this.selected = selected; this.renderPins(); }
  changeZoom(amount) { this.zoom = Math.max(2, Math.min(16, this.zoom + amount)); this.render(); }
  recenter(zone) { this.center = zone ? { lat: zone.lat, lng: zone.lng } : { ...HOME }; this.zoom = zone?.id && !zone.country ? 14 : this.element.clientWidth < 420 ? 12 : 13;this.home={...this.center};this.homeZoom=this.zoom;this.gesture=null;this.pointers.clear();this.element.classList.remove('dragging');this.render(); }
  render() {
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!width || !height) return;
    this.center.lat = Math.max(-85.05, Math.min(85.05, this.center.lat));
    this.center.lng = ((this.center.lng + 540) % 360) - 180;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    const left = center.x - width / 2, top = center.y - height / 2;
    const tileZoom=Math.round(this.zoom),scale=2**(this.zoom-tileZoom),tileSize=256*scale;
    const visible = new Set();
    for (let x = Math.floor(left / tileSize); x <= Math.floor((left + width) / tileSize); x++) {
      for (let y = Math.floor(top / tileSize); y <= Math.floor((top + height) / tileSize); y++) {
        const total = 2 ** tileZoom; if (y < 0 || y >= total) continue;
        const wrappedX = ((x % total) + total) % total;
        const key = `${tileZoom}/${x}/${y}`; visible.add(key);
        let image = this.images.get(key);
        if (!image) {
          image = new Image(256, 256); image.alt = ''; image.draggable = false;
          image.src = TILE_URL.replace('{z}', tileZoom).replace('{x}', wrappedX).replace('{y}', y);
          image.addEventListener('error', () => { this.errors++; if (this.errors >= 3) document.querySelector('#map-error').hidden = false; });
          image.addEventListener('load', () => { this.errors = 0; document.querySelector('#map-error').hidden = true; });
          this.images.set(key, image); this.tiles.append(image);
        }
        const tileLeft=Math.round(x*tileSize-left),tileTop=Math.round(y*tileSize-top);
        image.style.left = `${tileLeft}px`; image.style.top = `${tileTop}px`;
        image.style.width=`${Math.round((x+1)*tileSize-left)-tileLeft}px`;image.style.height=`${Math.round((y+1)*tileSize-top)-tileTop}px`;
      }
    }
    for (const [key, image] of this.images) if (!visible.has(key)) { image.remove(); this.images.delete(key); }
    const home=project(this.home.lat,this.home.lng,10),current=project(this.center.lat,this.center.lng,10),world=256*2**10;
    const dx=((current.x-home.x+world*1.5)%world)-world/2;
    this.onViewChange?.({center:{...this.center},zoom:this.zoom,moved:Math.hypot(dx,current.y-home.y)>4});
    this.renderPins();
  }
  renderPins() {
    return preserveLiveFocus(this.pins, () => {
    const width = this.element.clientWidth, height = this.element.clientHeight;
    if (!width || !height) return;
    const center = project(this.center.lat, this.center.lng, this.zoom);
    let overflow = 0;
    this.pins.replaceChildren();
    // Measure the largest possible overflow button before placing pins. The
    // reserved corner stays clear even when the final count needs this button.
    const more = document.createElement('button'); more.className = 'map-overflow'; more.dataset.focusKey = 'more-posts';
    more.textContent = `+ ${this.posts.length} annonces · voir le fil`; more.style.visibility = 'hidden';
    more.addEventListener('click', () => this.onOverflow?.()); this.pins.append(more);
    const occupied = reservedMapAreas(this.element);
    for (const post of this.posts) {
      const point = project(post.lat, post.lng, this.zoom);
      const world = 256 * 2 ** this.zoom;
      const dx = ((point.x - center.x + world * 1.5) % world) - world / 2;
      const x = dx + width / 2, y = point.y - center.y + height / 2;
      if (x < -80 || x > width + 80 || y < 20 || y > height - 15) continue;
      const button = document.createElement('button');
      button.className = `map-pin ${(this.fresh.get(post.id) || 0) > Date.now() ? 'fresh' : ''} ${post.kind === 'need' ? 'need' : ''} ${post.status === 'full' ? 'full' : ''} ${post.id === this.selected ? 'selected' : ''}`;
      button.dataset.post = post.id; button.dataset.focusKey = `post-${post.id}`;
      button.setAttribute('aria-label', `${post.role}, ${post.zoneLabel}, ${post.status === 'full' ? 'clôturé' : post.kind === 'available' ? 'disponible' : `${post.places} place${post.places > 1 ? 's' : ''}`}${post.demo ? ', exemple' : ''}`);
      button.setAttribute('aria-pressed', String(post.id === this.selected));
      button.innerHTML = this.pinHTML(post); this.pins.append(button);
      const w = button.offsetWidth, h = button.offsetHeight;
      const candidates = [];
      for (const dy of [0, -42, 42, -84, 84, -126, 126, -168, 168]) {
        for (const dx of [0, -110, 110, -220, 220]) candidates.push({ x: Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, x + dx)), y: Math.max(85, Math.min(height - 70, y + dy)) });
      }
      candidates.sort((a,b) => (a.x-x)**2+(a.y-y)**2 - ((b.x-x)**2+(b.y-y)**2));
      const fit = candidates.find(p => p.x-w/2>=0 && p.x+w/2<=width && p.y-h/2>=0 && p.y+h/2<=height && !occupied.some(r => Math.abs(p.x-r.x) < (w+r.w)/2+8 && Math.abs(p.y-r.y) < (h+r.h)/2+10));
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
    if (overflow) { more.textContent = `+ ${overflow} annonce${overflow>1?'s':''} · voir le fil`; more.style.visibility = ''; }
    else more.remove();
    }, this.element);
  }
}

export function reservedMapAreas(element) {
  const panel=element.closest?.('.map-panel');
  if(!panel)return [];
  const origin=element.getBoundingClientRect();
  return [...panel.querySelectorAll('.map-location,.map-legend,.map-tools,.map-explore,.map-selection,.map-gesture-help,.map-bottom,.map-error,.map-overflow')]
    .filter(node=>node.getClientRects().length)
    .map(node=>{const r=node.getBoundingClientRect();return {x:r.left-origin.left+r.width/2,y:r.top-origin.top+r.height/2,w:r.width,h:r.height};});
}
