'use strict';

/* ---------- data source (swap here for Google Sheets later) ---------- */
const DataSource = {
  trips: () => getJSON('data/trips.json').then(d => d.trips || []),
  trip: meta => getJSON(meta.file),
};
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

const cache = { trips: null, trip: {} };
async function loadTrips() {
  if (!cache.trips) cache.trips = await DataSource.trips();
  return cache.trips;
}
async function loadTrip(id) {
  if (cache.trip[id]) return cache.trip[id];
  const meta = (await loadTrips()).find(t => t.id === id);
  if (!meta) throw new Error('הטיול לא נמצא');
  const trip = normalize({ ...meta, ...(await DataSource.trip(meta)) });
  try { await Sheet.load(); applySheetHotels(trip); applySheetEdits(trip); } catch { /* offline with no saved copy */ }
  cache.trip[id] = trip;
  return trip;
}
function normalize(t) {
  t.hotels = t.hotels || [];
  t.days = t.days || [];
  t.hotelById = Object.fromEntries(t.hotels.map(h => [h.id, h]));
  t.itemById = {};
  const visit = (items, dayIndex) => (items || []).forEach(it => {
    if (it.kind === 'choice') (it.options || []).forEach(o => visit(o.items, dayIndex));
    else if (it.id) { it.dayIndex = dayIndex; t.itemById[it.id] = it; }
  });
  t.days.forEach((d, i) => {
    d.index = i;
    d.blocks = d.blocks || [];
    if (!d.date && t.startDate) d.date = addDays(t.startDate, i);
    d.blocks.forEach(b => visit(b.items, i));
  });
  return t;
}

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const app = $('app');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UNKNOWN = '<span class="unknown">לא ידוע</span>';
const isNil = v => v === null || v === undefined || v === '';
const val = v => (isNil(v) ? UNKNOWN : esc(v));
const hasLL = p => !!p && typeof p.lat === 'number' && typeof p.lng === 'number';

const parseDate = s => new Date(s + 'T12:00:00Z');
const addDays = (s, n) => new Date(parseDate(s).getTime() + n * 864e5).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.round((parseDate(b) - parseDate(a)) / 864e5);
const fmtDate = (s, opts) => new Intl.DateTimeFormat('he-IL', { timeZone: 'UTC', ...opts }).format(parseDate(s));
const todayIn = tz => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
  catch { return new Date().toISOString().slice(0, 10); }
};
const fmtMin = m => {
  if (isNil(m)) return null;
  if (m < 60) return `${m} דק׳`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} ש׳ ${r} דק׳` : `${h} ש׳`;
};
const fmtDrive = d => {
  if (!d || (isNil(d.km) && isNil(d.minutes))) return 'נהיגה: לא ידוע';
  return [isNil(d.km) ? null : `~${d.km} ק״מ`, fmtMin(d.minutes)].filter(Boolean).join(' · ');
};
const mapsPointUrl = (p, region) => {
  const q = hasLL(p) ? `${p.lat},${p.lng}` : [p.name, p.address || region].filter(Boolean).join(', ');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const KIND = {
  sight: ['📍', 'אטרקציה'], activity: ['🎟️', 'פעילות'], food: ['🍽️', 'אוכל'],
  fuel: ['⛽', 'תחנת דלק'], hike: ['🥾', 'מסלול הליכה'], town: ['🏘️', 'עיירה'],
  ferry: ['⛴️', 'מעבורת'], airport: ['✈️', 'שדה תעופה'], other: ['•', 'אחר'],
};
const kind = k => KIND[k] || KIND.other;
const SLOT = { morning: '☀️ בוקר', noon: '🌤️ צהריים', evening: '🌙 ערב', day: '🗺️ כל היום' };
// where we sleep: booked hotel, else the planned stay area
const lodging = (t, day) => {
  if (!day) return null;
  const h = t.hotelById[day.hotelId];
  if (hasLL(h)) return h;
  return hasLL(day.stayArea) ? day.stayArea : null;
};
// name of where we sleep (booked hotel, else planned area) and whether it differs from last night
const stayName = (t, day) => { const h = day && t.hotelById[day.hotelId]; return h ? h.name : day && day.stayArea ? day.stayArea.name : null; };
// booked = a hotel from the sheet is assigned to this night (not just a planned area)
const isBooked = (t, day) => !!(day && t.hotelById[day.hotelId]);
const stayIcon = (icon, booked) => booked ? `<span class="booked-icon" title="מלון מוזמן">${icon}<i>✓</i></span>` : icon;
// suitcase days: arriving at the first lodging, moving to a new one, or leaving the last one
const prevStay = (t, day) => (day.index > 0 ? stayName(t, t.days[day.index - 1]) : null);
const changesHotel = (t, day) => (stayName(t, day) || prevStay(t, day)) && stayName(t, day) !== prevStay(t, day);
// "drive" key absent = no driving leg (walk, ferry, start point); null = unknown
const hasLeg = it => 'drive' in it;

function tripStatus(t) {
  if (!t.startDate || !t.endDate) return { text: t.datesNote ? `${t.datesNote} · תאריכים עוד לא נקבעו` : 'התאריכים עוד לא נקבעו' };
  const today = todayIn(t.timezone);
  const total = dayDiff(t.startDate, t.endDate) + 1;
  const until = dayDiff(today, t.startDate);
  if (until > 1) return { text: `עוד ${until} ימים לטיול ✈️` };
  if (until === 1) return { text: 'מחר יוצאים! ✈️' };
  const n = dayDiff(t.startDate, today) + 1;
  if (n <= total) return { text: `יום ${n} מתוך ${total}`, live: true };
  return { text: 'הטיול הסתיים' };
}

/* ---------- choices ("או זה או זה") ---------- */
const choiceKey = (tripId, d, b, i) => `choice:${tripId}:${d}:${b}:${i}`;
function getChoice(key, n) {
  const v = Number(store.get(key));
  return Number.isInteger(v) && v >= 0 && v < n ? v : 0;
}
// items of the day in order, using the selected option of each choice
function effectiveItems(trip, day) {
  const out = [];
  day.blocks.forEach((b, bi) => (b.items || []).forEach((it, ii) => {
    if (it.kind === 'choice') {
      const opts = it.options || [];
      const o = opts[getChoice(choiceKey(trip.id, day.index, bi, ii), opts.length)];
      if (o) out.push(...(o.items || []));
    } else out.push(it);
  }));
  return out;
}

function dayRouteUrl(points, startHotel, endHotel) {
  const ll = p => `${p.lat},${p.lng}`;
  const stops = points.filter(hasLL).map(ll);
  const origin = hasLL(startHotel) ? ll(startHotel) : stops.shift();
  const destination = hasLL(endHotel) ? ll(endHotel) : stops.pop() || origin;
  if (!origin) return null;
  const u = new URL('https://www.google.com/maps/dir/');
  u.searchParams.set('api', '1');
  u.searchParams.set('origin', origin);
  u.searchParams.set('destination', destination);
  if (stops.length) u.searchParams.set('waypoints', stops.join('|'));
  u.searchParams.set('travelmode', 'driving');
  return u.toString();
}

/* ---------- map ---------- */
let currentMaps = [];
function clearMaps() { currentMaps.forEach(m => m.remove()); currentMaps = []; }
// opts.start: where the day starts (last night's lodging); opts.toHotel: drive to the lodging, from the place opts.toHotelFrom.
// Each leg with a known drive gets a label (distance · time) at its middle.
function drawMap(el, points, hotel, tripId, opts = {}) {
  if (!window.L || !el) return;
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  const pin = (html, cls) => L.divIcon({ className: `pin ${cls || ''}`, html, iconSize: [28, 28], iconAnchor: [14, 14] });
  const hotelPopup = h => h.id ? `<a href="#/t/${tripId}/h/${esc(h.id)}">${esc(h.name)}</a>` : esc(h.name);
  const ll = p => [p.lat, p.lng];
  const sameSpot = (a, b) => a && b && a.lat === b.lat && a.lng === b.lng;
  const start = hasLL(opts.start) ? opts.start : hasLL(hotel) ? hotel : null;
  const line = [], legs = [];
  let pendingToHotel = null;
  if (start) {
    if (!sameSpot(start, hotel)) L.marker(ll(start), { icon: pin('🛏', 'hotel start') }).addTo(map).bindPopup(`יציאה: ${hotelPopup(start)}`);
    line.push(start);
  }
  if (hasLL(hotel)) L.marker(ll(hotel), { icon: pin('🛏', 'hotel') }).addTo(map).bindPopup(hotelPopup(hotel));
  points.forEach(p => {
    const cls = p.kind === 'fuel' ? 'fuel' : '';
    L.marker(ll(p), { icon: pin(p.kind === 'fuel' ? '⛽' : p.num, cls) }).addTo(map)
      .bindPopup(`<a href="#/t/${tripId}/i/${esc(p.id)}">${esc(p.name)}</a>`);
    if (line.length && p.drive) legs.push([line[line.length - 1], p, p.drive]);
    else if (line.length && pendingToHotel) legs.push([line[line.length - 1], p, pendingToHotel]);  // e.g. into town where we sleep
    pendingToHotel = null;
    line.push(p);
    if (p.id === opts.toHotelFrom) pendingToHotel = opts.toHotel;
  });
  if (hasLL(hotel) && points.length) {
    if (pendingToHotel) legs.push([line[line.length - 1], hotel, pendingToHotel]);
    line.push(hotel);
  }
  if (line.length > 1) L.polyline(line.map(ll), { color: '#0f766e', weight: 3, opacity: .7, dashArray: '6 8' }).addTo(map);
  legs.forEach(([a, b, d]) => {
    if (isNil(d.km) && isNil(d.minutes)) return;
    // short label (time; distance only if time is unknown) so more of them fit
    const m = d.minutes;
    const text = !isNil(m) ? (m < 60 ? `${m} ד׳` : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} ש׳`) : `${d.km} ק״מ`;
    // nudge the label off the line, perpendicular to the leg (direction does not change with zoom)
    const pa = map.project([a.lat, a.lng], 10), pb = map.project([b.lat, b.lng], 10);
    const dx = pb.x - pa.x, dy = pb.y - pa.y, len = Math.hypot(dx, dy) || 1;
    let ox = -dy / len, oy = dx / len;
    if (oy > 0) { ox = -ox; oy = -oy; }   // prefer above the line
    const shift = `transform: translate(calc(-50% + ${(ox * 16).toFixed(1)}px), calc(-50% + ${(oy * 16).toFixed(1)}px))`;
    L.marker([(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], {
      icon: L.divIcon({ className: 'seg-label', html: `<span style="${shift}" title="${esc(fmtDrive(d))}">${esc(text)}</span>`, iconSize: null }),
      interactive: false, keyboard: false, zIndexOffset: -500,
    }).addTo(map);
  });
  if (line.length > 1) map.fitBounds(line.map(ll), { padding: [28, 28] });
  else if (line.length === 1) map.setView(ll(line[0]), 12);
  else map.setView([64.9, -18.6], 6);
  // hide labels that would cover a pin or another label; zooming in reveals them
  const declutter = () => {
    const taken = [...el.querySelectorAll('.leaflet-marker-icon.pin')].map(n => n.getBoundingClientRect());
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    el.querySelectorAll('.seg-label span').forEach(span => {
      span.style.visibility = 'visible';
      const r = span.getBoundingClientRect();
      if (taken.some(t => hit(r, t))) span.style.visibility = 'hidden';
      else taken.push(r);
    });
    const hint = el.nextElementSibling && el.nextElementSibling.classList.contains('map-hint') ? el.nextElementSibling : null;
    if (hint && !userZoomed) hint.hidden = !el.querySelector('.seg-label span[style*="hidden"]');
  };
  let userZoomed = false;
  map.on('zoomstart', () => {
    if (!fitted) return;
    userZoomed = true;
    const hint = el.nextElementSibling;
    if (hint && hint.classList.contains('map-hint')) hint.hidden = true;
  });
  map.on('zoomend moveend', declutter);
  let fitted = false;
  setTimeout(() => { declutter(); fitted = true; }, 0);
  currentMaps.push(map);
}

// whole trip on one map: main places of every day (colored by day) and the line between the nights
const DAY_COLORS = ['#0f766e', '#1d4ed8', '#ea580c', '#7c3aed', '#db2777', '#65a30d', '#92400e', '#0ea5e9', '#dc2626', '#475569'];
const dayColor = i => DAY_COLORS[i % DAY_COLORS.length];
function drawTripMap(el, t) {
  if (!window.L || !el) return;
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const all = [], nights = [];
  t.days.forEach(day => {
    const color = dayColor(day.index);
    effectiveItems(t, day).filter(it => hasLL(it) && it.kind !== 'fuel').forEach(it => {
      L.marker([it.lat, it.lng], { icon: L.divIcon({ className: 'day-pin-wrap', html: `<span class="pin day-pin" style="background:${color}">${day.index + 1}</span>`, iconSize: [24, 24], iconAnchor: [12, 12] }) })
        .addTo(map)
        .bindPopup(`<a href="#/t/${esc(t.id)}/i/${esc(it.id)}">${esc(it.name)}</a><br><a href="#/t/${esc(t.id)}/d/${day.index}">יום ${day.index + 1}${day.region ? ' · ' + esc(day.region) : ''}</a>`);
      all.push([it.lat, it.lng]);
    });
    const stay = lodging(t, day);
    if (stay) nights.push({ stay, day });
  });
  // route between the nights, in order
  if (nights.length > 1) L.polyline(nights.map(n => [n.stay.lat, n.stay.lng]), { color: '#334155', weight: 2, opacity: .6, dashArray: '4 6' }).addTo(map);
  const seen = new Map();
  nights.forEach(({ stay, day }) => {
    const k = `${stay.lat},${stay.lng}`;
    seen.set(k, [...(seen.get(k) || []), day.index + 1]);
  });
  seen.forEach((daysHere, k) => {
    const [lat, lng] = k.split(',').map(Number);
    const n = nights.find(x => x.stay.lat === lat && x.stay.lng === lng);
    L.marker([lat, lng], { icon: L.divIcon({ className: 'pin hotel', html: '🛏', iconSize: [24, 24], iconAnchor: [12, 12] }), zIndexOffset: -100 })
      .addTo(map).bindPopup(`🛏 ${esc(n.stay.name)}<br>לילות: ${daysHere.map(d => 'יום ' + d).join(', ')}`);
    all.push([lat, lng]);
  });
  if (all.length) map.fitBounds(all, { padding: [20, 20] }); else map.setView([64.9, -18.6], 6);
  currentMaps.push(map);
}

/* ---------- chrome ---------- */
function setHeader(title, back, backLabel) {
  $('title').textContent = title;
  const mb = $('menu-back');
  mb.hidden = !back;
  if (back) { mb.href = back; $('menu-back-label').textContent = backLabel || 'חזרה'; }
  document.title = title === 'מתכנן טיולים' ? title : `${title} · מתכנן טיולים`;
}

/* ---------- views ---------- */
async function viewTrips() {
  setHeader('מתכנן טיולים', null);
  const trips = await loadTrips();
  if (!trips.length) { app.innerHTML = '<p class="empty">אין עדיין טיולים</p>'; return; }
  app.innerHTML = `<div class="stack">${trips.map(t => `
    <a class="card trip-card" href="#/t/${esc(t.id)}">
      <span class="trip-emoji">${esc(t.emoji || '🧳')}</span>
      <div>
        <div class="trip-name">${esc(t.name)}</div>
        <div class="muted">${t.startDate && t.endDate
          ? `${fmtDate(t.startDate, { day: 'numeric', month: 'short' })} – ${fmtDate(t.endDate, { day: 'numeric', month: 'short', year: 'numeric' })}`
          : esc(t.datesNote || 'תאריכים: לא ידוע')}</div>
        ${t.startDate && t.endDate ? `<div class="muted">${esc(tripStatus(t).text)}</div>` : ''}
      </div>
    </a>`).join('')}</div>`;
}

async function viewDays(id) {
  const t = await loadTrip(id);
  setHeader(t.name, '#/', 'חזרה לרשימת הטיולים');
  const st = tripStatus(t);
  const today = todayIn(t.timezone);
  const updated = t.updatedAt
    ? new Intl.DateTimeFormat('he-IL', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(t.updatedAt))
    : 'לא ידוע';
  app.innerHTML = `
    <div class="banner ${st.live ? 'live' : ''}">${esc(st.text)}</div>
    <div class="stamp">עודכן לאחרונה: ${esc(updated)}</div>
    <div class="quick">
      <a class="card links-card" href="#/t/${esc(t.id)}/links"><span>🔗 קישורים</span><span class="muted">${(await loadLinks(t)).length || ''}</span></a>
      ${SHEET_URL ? Object.entries(SHEET_VIEWS).map(([k, v]) => `<a class="card links-card" href="#/t/${esc(t.id)}/s/${k}"><span>${v.icon} ${esc(v.title)}</span><span class="muted">${Sheet.rows(k, t).length || ''}</span></a>`).join('') : ''}
    </div>
    ${(t.notes || []).length ? `<details class="card notes"><summary>💡 טיפים לטיול</summary><ul>${t.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <div class="stack">${t.days.map(d => {
      const isToday = d.date === today;
      const hotel = t.hotelById[d.hotelId];
      return `
      <a class="card day-card ${isToday ? 'today' : ''}" href="#/t/${esc(t.id)}/d/${d.index}" data-day="${d.index}" ${isToday ? 'id="today"' : ''}>
        <div class="day-num">יום<b>${d.index + 1}</b></div>
        <div class="day-main">
          <div class="day-date">${d.date ? esc(fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })) : 'תאריך: לא ידוע'}</div>
          <div class="day-title">${val(d.title)}</div>
          <div class="muted">📍 ${val(d.region)}${changesHotel(t, d)
            ? ` · <span class="move" title="מעבר מלון">${stayIcon('🧳', isBooked(t, d))} ${esc(stayName(t, d) || 'עזיבה')}</span>`
            : stayName(t, d) ? ` · ${stayIcon('🛏', isBooked(t, d))} ${esc(stayName(t, d))}` : ''}</div>
        </div>
        ${isToday ? '<span class="badge">היום</span>' : ''}
      </a>`;
    }).join('') || '<p class="empty">אין עדיין ימים</p>'}</div>
    ${t.days.length ? `
    <section class="trip-map-section">
      <h3>🗺️ מפת הטיול</h3>
      <div id="trip-map" class="map trip-map" dir="ltr"></div>
      <div class="map-legend">${t.days.map(d => `<a href="#/t/${esc(t.id)}/d/${d.index}"><span class="dot" style="background:${dayColor(d.index)}"></span>יום ${d.index + 1}</a>`).join('')}</div>
    </section>` : ''}`;
  drawTripMap($('trip-map'), t);
  // back from a day: scroll to the day we left; otherwise to today
  const from = lastDay[t.id];
  const target = (from !== undefined && app.querySelector(`[data-day="${from}"]`)) || $('today');
  if (!target) return false;
  target.scrollIntoView({ block: 'center' });
  if (from !== undefined) {
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  }
  return true;
}

/* ---------- notes: per day and per place (sheet tab "הערות"); everyone sees, editors write ---------- */
let notesMode = false;
// A place note belongs to the place (any day), a day note to the day's stable id.
// Older day notes saved with the day number are still found (and moved to the id on the next save).
const dayKey = (t, dayIdx) => (t.days[dayIdx] && t.days[dayIdx].id) || String(dayIdx + 1);
const noteRow = (t, dayIdx, itemId) => Sheet.rows('notes', t).find(r => itemId
  ? r['פריט'] === itemId
  : !r['פריט'] && (r['יום'] === dayKey(t, dayIdx) || r['יום'] === String(dayIdx + 1)));
const noteText = (t, dayIdx, itemId) => ((noteRow(t, dayIdx, itemId) || {})['הערה'] || '').trim();
function noteHtml(t, dayIdx, itemId) {
  const r = noteRow(t, dayIdx, itemId), text = ((r || {})['הערה'] || '').trim();
  if (notesMode && canEdit()) {
    return `<div class="note-wrap"><textarea class="note-edit" rows="2" placeholder="${itemId ? 'הערה למקום הזה…' : 'הערה ליום הזה…'}"
      data-trip="${esc(t.id)}" data-day="${esc(dayKey(t, dayIdx))}" data-num="${dayIdx + 1}" data-item="${esc(itemId)}" data-orig="${esc(text)}">${esc(text)}</textarea>
      <span class="note-status muted" aria-live="polite"></span></div>`;
  }
  return text ? `<div class="note-show">📝 ${esc(text)}</div>` : '';
}
// Notes go through the outbox: shown at once, sent in order (now, or when there is signal again).
function saveNote(el) {
  const { trip, day, item } = el.dataset;
  const text = el.value.trim();
  if (text === el.dataset.orig) return Promise.resolve();
  el.dataset.orig = text;
  const status = el.parentElement && el.parentElement.querySelector('.note-status');
  if (status) status.textContent = 'שומר…';
  const match = item ? ['טיול', 'פריט'] : ['טיול', 'יום', 'פריט'];
  const row = { 'טיול': trip, 'יום': day, 'פריט': item, 'הערה': text, 'עודכן': new Date().toISOString() };
  // a day note saved under the old day number: remove that row too
  const legacy = !item && el.dataset.num !== day
    && Sheet.rows('notes', { id: trip, name: trip }).some(r => !r['פריט'] && r['יום'] === el.dataset.num);
  if (legacy) Sheet.write({ action: 'deleteMatch', table: 'notes', match, row: { ...row, 'יום': el.dataset.num } });
  return Sheet.write(text ? { action: 'upsert', table: 'notes', match, row } : { action: 'deleteMatch', table: 'notes', match, row })
    .then(res => {
      const msg = res.error ? sheetError(res.error) : res.queued ? 'נשמר בטלפון, יישלח כשתהיה קליטה' : 'נשמר ✓';
      if (status && status.isConnected) status.textContent = msg;
      else if (res.queued) toast('אין קליטה: ההערות נשמרו בטלפון ויישלחו אוטומטית.', 'info');
    });
}
function toast(msg, kind) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'alert'); document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('info', kind === 'info');
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, 6000);
}
app.addEventListener('change', e => { if (e.target.classList.contains('note-edit')) saveNote(e.target); });
// toggle on touch-down, before the keyboard closes and the page jumps
async function toggleNotes() {
  if (notesMode) app.querySelectorAll('.note-edit').forEach(saveNote);
  notesMode = !notesMode;
  // the page above the toggle grows/shrinks: keep the toggle where the finger is
  const before = ($('notes-toggle') || {}).getBoundingClientRect?.().top;
  await render(true);
  const btn = $('notes-toggle');
  if (btn && before !== undefined) window.scrollBy(0, btn.getBoundingClientRect().top - before);
}
// the click that follows a touch-down toggle must not land on whatever is now under the finger
function swallowNextClick() {
  const stop = ev => { ev.preventDefault(); ev.stopPropagation(); };
  document.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', stop, { capture: true }), 800);
}
let lastToggle = 0;
app.addEventListener('pointerdown', e => {
  if (!e.target.closest('#notes-toggle')) return;
  e.preventDefault();          // keep focus: no blur, no keyboard jump
  lastToggle = Date.now();
  swallowNextClick();
  toggleNotes();
});
app.addEventListener('click', e => {
  if (!e.target.closest('#notes-toggle')) return;
  if (Date.now() - lastToggle < 800) return;   // already handled on pointerdown
  toggleNotes();               // keyboard (Enter / Space)
});

function itemCard(t, it, numById) {
  const [icon] = kind(it.kind);
  const n = numById[it.id];
  const meta = [it.time ? `🕒 ${esc(it.time)}` : null, it.durationMinutes ? `⏱ ${fmtMin(it.durationMinutes)}` : null].filter(Boolean).join(' · ');
  return `
    ${noteHtml(t, it.dayIndex, it.id)}
    ${hasLeg(it) ? `<div class="drive">🚗 ${esc(fmtDrive(it.drive))}</div>` : '<div class="gap"></div>'}
    <a class="card item ${it.kind === 'fuel' ? 'fuel' : ''}" href="#/t/${esc(t.id)}/i/${esc(it.id)}">
      <span class="num ${n ? '' : 'plain'}">${it.kind === 'fuel' ? '⛽' : (n || icon)}</span>
      <div class="grow">
        <div class="item-name">${n ? icon + ' ' : ''}${esc(it.name)}</div>
        ${it.summary ? `<div class="item-sub">${esc(it.summary)}</div>` : ''}
        ${meta ? `<div class="item-meta">${meta}</div>` : ''}
      </div>
      <span class="chev">‹</span>
    </a>`;
}

// last day opened per trip, to return to it in the day list
const lastDay = {};

async function viewDay(id, dayIdx) {
  const t = await loadTrip(id);
  const day = t.days[Number(dayIdx)];
  if (day) lastDay[t.id] = day.index;
  if (!day) throw new Error('היום לא נמצא');
  const title = `יום ${day.index + 1}${day.region ? ' · ' + day.region : ''}`;
  setHeader(title, `#/t/${t.id}`, 'חזרה לרשימת הימים');

  const hotel = t.hotelById[day.hotelId];
  const tonight = lodging(t, day);
  const lastNight = day.index > 0 ? lodging(t, t.days[day.index - 1]) : null;
  const items = effectiveItems(t, day);
  const numById = {};
  const points = [];
  items.filter(hasLL).forEach(it => {
    if (it.kind !== 'fuel') numById[it.id] = points.filter(p => p.kind !== 'fuel').length + 1;
    points.push({ ...it, num: numById[it.id] });
  });
  const route = dayRouteUrl(points, lastNight, tonight);

  // return-to-lodging leg: last item that defines driveToHotel (later items may be in town, on foot)
  const last = [...items].reverse().find(it => 'driveToHotel' in it);
  const legs = items.filter(it => hasLeg(it) && (it.kind !== 'fuel' || it.drive)).map(it => it.drive);
  if (last && 'driveToHotel' in last) legs.push(last.driveToHotel);
  const km = legs.reduce((s, d) => s + (d?.km || 0), 0);
  const min = legs.reduce((s, d) => s + (d?.minutes || 0), 0);
  const partial = legs.some(d => !d || isNil(d.km) || isNil(d.minutes));

  const blocks = day.blocks.map((b, bi) => `
    <section class="slot">
      <div class="slot-title">${esc(SLOT[b.slot] || b.slot || '')}</div>
      ${(b.items || []).map((it, ii) => {
        if (it.kind !== 'choice') return itemCard(t, it, numById);
        const key = choiceKey(t.id, day.index, bi, ii);
        const opts = it.options || [];
        const sel = getChoice(key, opts.length);
        return `
          <div class="choice">
            <div class="choice-label">או זה או זה:</div>
            <div class="tabs" role="tablist">${opts.map((o, k) => `
              <button class="tab" role="tab" type="button" aria-selected="${k === sel}" data-choice="${esc(key)}" data-idx="${k}">${esc(o.label || `אפשרות ${k + 1}`)}</button>`).join('')}
            </div>
            ${(opts[sel]?.items || []).map(x => itemCard(t, x, numById)).join('')}
          </div>`;
      }).join('')}
    </section>`).join('');

  const from = prevStay(t, day), to = stayName(t, day);
  const move = !changesHotel(t, day) ? ''
    : `<div class="move-bar">${stayIcon('🧳', isBooked(t, day))} ${!from ? 'צ׳ק-אין בלינה הראשונה' : !to ? `יום עזיבה · צ׳ק-אאוט מ${esc(from)}` : `מעבר מלון היום · יוצאים מ${esc(from)}`}</div>`;
  app.innerHTML = `
    ${move}
    ${hotel
      ? `<a class="hotel-bar" href="#/t/${esc(t.id)}/h/${esc(hotel.id)}"><span class="ico">🛏</span><div class="grow"><small>לינה הלילה</small><b>${esc(hotel.name)}</b></div><span class="chev">‹</span></a>`
      : day.stayArea
        ? `<div class="hotel-bar"><span class="ico">🛏</span><div class="grow"><small>לינה הלילה · טרם הוזמן</small><b>אזור ${esc(day.stayArea.name)}</b></div></div>`
        : `<div class="hotel-bar"><span class="ico">🛏</span><div class="grow"><small>לינה הלילה</small>${day.index === t.days.length - 1 ? 'יום אחרון, אין לינה' : UNKNOWN}</div></div>`}
    <div id="map" class="map" dir="ltr"></div>
    <p class="map-hint muted" hidden>🔍 הגדילו את המפה כדי לראות את כל זמני הנסיעה</p>
    ${route ? `<a class="btn primary" href="${esc(route)}" target="_blank" rel="noopener">🗺️ מסלול היום בגוגל מפות</a>` : ''}
    ${legs.length ? `<div class="drive-total">🚗 סה״כ נהיגה: ~${km} ק״מ · ${fmtMin(min) || '0 דק׳'}${partial ? ' (חלק מהמקטעים לא ידועים)' : ''}</div>` : ''}
    ${notesMode || noteText(t, day.index, '') ? `<div class="note-label">הערה ליום</div>${noteHtml(t, day.index, '')}` : ''}
    ${blocks}
    ${last && 'driveToHotel' in last ? `<div class="drive" style="margin-top:6px">🚗 חזרה ללינה: ${esc(fmtDrive(last.driveToHotel))}</div>` : ''}
    ${canEdit() ? `<button class="notes-toggle ${notesMode ? 'on' : ''}" type="button" id="notes-toggle" aria-pressed="${notesMode}"><span>📝 מצב הערות</span><span class="switch"></span></button>` : ''}`;

  drawMap($('map'), points, tonight, t.id, { start: lastNight, toHotelFrom: last && last.id, toHotel: last && last.driveToHotel });
}

async function viewItem(id, itemId) {
  const t = await loadTrip(id);
  const it = t.itemById[itemId];
  if (!it) throw new Error('הפעילות לא נמצאה');
  const [icon, label] = kind(it.kind);
  setHeader(it.name, `#/t/${t.id}/d/${it.dayIndex}`, `חזרה ליום ${it.dayIndex + 1}`);
  const tips = (it.tips || []).filter(Boolean);
  const links = (it.links || []).filter(l => l && l.url);
  const sources = (it.sources || []).filter(l => l && l.url);
  app.innerHTML = `
    <article class="detail">
      ${it.wiki ? '<div id="gallery" class="gallery" hidden></div>' : ''}
      <span class="kind-chip">${icon} ${esc(label)}</span>
      <h2>${esc(it.name)}</h2>
      ${it.summary ? `<p class="lead">${esc(it.summary)}</p>` : ''}
      ${hasLL(it) ? '<div id="map" class="map small" dir="ltr"></div>' : ''}
      <a class="btn primary" href="${esc(mapsPointUrl(it, t.days[it.dayIndex]?.region))}" target="_blank" rel="noopener" ${hasLL(it) ? '' : 'style="margin-top:14px"'}>📍 פתח בגוגל מפות</a>
      <section class="section"><h3>מה זה</h3><p>${val(it.description)}</p></section>
      <section class="section">
        <dl class="facts">
          <dt>שעות</dt><dd>${val(it.hours)}</dd>
          <dt>מחיר</dt><dd>${val(it.price)}</dd>
          <dt>משך מומלץ</dt><dd>${it.durationMinutes ? esc(fmtMin(it.durationMinutes)) : UNKNOWN}</dd>
          <dt>איך מגיעים</dt><dd>${val(it.howToGet)}</dd>
          ${hasLeg(it) ? `<dt>נהיגה מהנקודה הקודמת</dt><dd>${it.drive ? esc(fmtDrive(it.drive)) : UNKNOWN}</dd>` : ''}
        </dl>
      </section>
      ${tips.length ? `<section class="section tips"><h3>💡 טיפים</h3><ul>${tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
      ${placeLinksHtml(t, it, links)}
      ${sources.length || it.checkedAt ? `<section class="section links sources"><h3>📚 מקורות המידע</h3>
        ${sources.length ? `<ul>${sources.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || hostOf(l.url))}</a></li>`).join('')}</ul>` : ''}
        ${it.checkedAt ? `<p class="muted">נבדק ב-${esc(fmtDate(it.checkedAt, { day: 'numeric', month: 'long', year: 'numeric' }))}</p>` : ''}</section>` : ''}
      ${it.editRow ? `<p class="muted edited">✏️ חלק מהמידע נערך ידנית${it.editedAt ? ` (${esc(it.editedAt.slice(0, 10))})` : ''}</p>` : ''}
      ${canEdit() ? researchHtml(t, it) + itemEditHtml(t, it) : ''}
    </article>`;
  if (hasLL(it)) drawMap($('map'), [{ ...it, num: '•' }], null, t.id);
  if (it.wiki) showGallery(it.wiki);
}

async function viewHotel(id, hotelId) {
  const t = await loadTrip(id);
  const h = t.hotelById[hotelId];
  if (!h) throw new Error('הלינה לא נמצאה');
  const nights = t.days.filter(d => d.hotelId === h.id);
  setHeader(h.name, nights.length ? `#/t/${t.id}/d/${nights[0].index}` : `#/t/${t.id}`, nights.length ? `חזרה ליום ${nights[0].index + 1}` : 'חזרה לרשימת הימים');
  const p = h.price || {};
  const price = typeof h.price === 'string' ? esc(h.price)
    : isNil(p.amount) ? UNKNOWN : `${esc(Number(p.amount).toLocaleString('he-IL'))} ${esc(p.currency || '')} ${esc(p.note || '')}`;
  const ref = h.bookingRef ? `<dt>🔒 מספר הזמנה</dt><dd class="ltr">${esc(h.bookingRef)}</dd>`
    : h.fromSheet && Sheet.locked('hotels') ? '<dt>🔒 מספר הזמנה</dt><dd><a href="#/login">כניסה עם סיסמת הטיול</a></dd>' : '';
  const cancel = h.cancelBy ? esc(/^\d{4}-\d{2}-\d{2}$/.test(h.cancelBy) ? fmtDate(h.cancelBy, { day: 'numeric', month: 'long', year: 'numeric' }) : h.cancelBy) : UNKNOWN;
  app.innerHTML = `
    <article class="detail">
      <span class="kind-chip">🛏 לינה</span>
      <h2>${esc(h.name)}</h2>
      ${hasLL(h) ? '<div id="map" class="map small" dir="ltr"></div>' : ''}
      <div class="btn-row" ${hasLL(h) ? '' : 'style="margin-top:14px"'}>
        <a class="btn primary" href="${esc(mapsPointUrl(h))}" target="_blank" rel="noopener">📍 ניווט</a>
        ${h.phone ? `<a class="btn" href="tel:${esc(h.phone.replace(/[^\d+]/g, ''))}">📞 חיוג</a>` : ''}
      </div>
      ${h.bookingUrl ? `<a class="btn" style="margin-top:8px" href="${esc(h.bookingUrl)}" target="_blank" rel="noopener">🔗 להזמנה</a>` : ''}
      <section class="section">
        <dl class="facts">
          <dt>כתובת</dt><dd>${val(h.address)}</dd>
          <dt>טלפון</dt><dd>${h.phone ? `<span class="ltr">${esc(h.phone)}</span>` : UNKNOWN}</dd>
          <dt>מחיר</dt><dd>${price}</dd>
          <dt>צ׳ק-אין</dt><dd>${val(h.checkIn)}</dd>
          <dt>צ׳ק-אאוט</dt><dd>${val(h.checkOut)}</dd>
          <dt>ביטול חינם עד</dt><dd>${cancel}</dd>
          ${ref}
        </dl>
      </section>
      ${h.notes ? `<section class="section"><h3>הערות</h3><p>${esc(h.notes)}</p></section>` : ''}
      ${nights.length ? `<section class="section links"><h3>לילות כאן</h3><ul>${nights.map(d => `<li><a href="#/t/${esc(t.id)}/d/${d.index}">יום ${d.index + 1}${d.date ? ' · ' + esc(fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })) : ''}</a></li>`).join('')}</ul></section>` : ''}
    </article>`;
  if (hasLL(h)) drawMap($('map'), [], h, t.id);
}

/* ---------- Google Sheets backend (apps-script/Code.gs) ---------- */
// Web-app URL of the deployed Apps Script (…/exec). Empty = not connected yet.
const SHEET_URL = 'https://script.google.com/macros/s/AKfycbwau09MYJrEnD-g1ty0_K5eIjtu8AVWsDpRVpAkj-yA8T6Rw6e9vkXZBxvVgVooKKS-Kw/exec';
// Offline-friendly: reads show the copy saved on this device at once and refresh in the background;
// writes go to an outbox (localStorage) that is sent in order whenever there is a connection.
const sameRow = (op, r) => (op.match || []).every(m => (r[m] || '') === (op.row[m] || ''));
function applyOp(data, op, id) {
  const tb = data && data.tables && data.tables[op.table];
  if (!tb) return;
  if (op.action === 'add') tb.rows.push({ ...op.row, 'מזהה': id || op.tmpId });
  else if (op.action === 'upsert') { tb.rows = tb.rows.filter(r => !sameRow(op, r)); tb.rows.push({ ...op.row, 'מזהה': id || op.tmpId }); }
  else if (op.action === 'delete') tb.rows = tb.rows.filter(r => r['מזהה'] !== op.id && r['מזהה'] !== id);
  else if (op.action === 'deleteMatch') tb.rows = tb.rows.filter(r => !sameRow(op, r));
}
const isNetErr = e => !navigator.onLine || e.name === 'AbortError' || e.name === 'TypeError' || e.name === 'SyntaxError';
const Outbox = {
  all() { try { return JSON.parse(store.get('outbox') || '[]'); } catch { return []; } },
  save(list) { store.set('outbox', JSON.stringify(list)); updatePending(); },
};
const Sheet = {
  key: () => store.get('trip-key') || '',
  level: () => store.get('trip-level') || 'public',
  base: null,      // last data received from the sheet
  data: null,      // base + changes still waiting in the outbox (what the screens show)
  realIds: {},     // temporary id of a row added offline -> id given by the sheet
  async call(body, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // text/plain keeps it a "simple" request (Apps Script does not answer CORS preflight)
      const r = await fetch(SHEET_URL, {
        method: 'POST', cache: 'no-store', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ key: this.key(), ...body }),
      });
      const j = await r.json();
      if (!j.ok) { const e = new Error(j.error || 'error'); e.code = j.error; throw e; }
      return j;
    } finally { clearTimeout(timer); }
  },
  setBase(j) {
    this.base = j;
    const d = JSON.parse(JSON.stringify(j));
    Outbox.all().forEach(op => applyOp(d, op));
    this.data = d;
  },
  cached() {
    try { const c = JSON.parse(store.get('sheet-cache') || 'null'); return c && c.key === this.key() ? c.data : null; } catch { return null; }
  },
  async fetchFresh() {
    const j = await this.call({ action: 'read' });
    store.set('sheet-cache', JSON.stringify({ key: this.key(), data: j }));
    if (this.key() && j.level !== this.level()) {   // password was changed in the sheet
      if (j.level === 'public') store.set('trip-key', '');
      store.set('trip-level', j.level === 'public' ? '' : j.level);
      updateLoginMenu();
    }
    const changed = !this.base || JSON.stringify(this.base) !== JSON.stringify(j);
    this.setBase(j);
    return changed;
  },
  // update in the background; redraw only if something changed and the user is not in the middle of typing
  refresh() {
    if (this._refreshing || !SHEET_URL) return this._refreshing;
    this._refreshing = this.fetchFresh()
      .then(changed => {
        if (!changed) return;
        cache.trip = {};
        const busy = notesMode || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') || app.querySelector('details[open]');
        if (!busy) render(true);
      })
      .catch(() => { /* weak or no signal: keep the saved copy */ })
      .finally(() => { this._refreshing = null; });
    return this._refreshing;
  },
  async load(force) {
    if (!SHEET_URL) return null;
    if (this.data && !force) return this.data;
    if (!this.data && !force) {
      const c = this.cached();
      if (c) { this.setBase(c); this.refresh(); return this.data; }
    }
    try { await this.fetchFresh(); }
    catch (e) { const c = this.cached(); if (c) this.setBase(c); else throw e; }
    return this.data;
  },
  // save a change: shown at once, sent now or later. Returns { queued } or { error }.
  async write(op) {
    op = { ...op, tmpId: 'tmp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
    if (op.action === 'delete' && String(op.id).startsWith('tmp-') && !this.realIds[op.id]) {
      // the row was added offline and not sent yet: just drop that add
      Outbox.save(Outbox.all().filter(o => o.tmpId !== op.id));
      if (this.base) this.setBase(this.base);
      return { queued: false };
    }
    Outbox.save([...Outbox.all(), op]);
    if (this.data) applyOp(this.data, op);
    const failed = await this.flush();
    if (failed[op.tmpId]) return { error: failed[op.tmpId] };
    return { queued: Outbox.all().some(o => o.tmpId === op.tmpId) };
  },
  flush() {
    if (this._flushing) return this._flushing;
    this._flushing = (async () => {
      const failed = {};
      let changed = false;
      for (let op = Outbox.all()[0]; op; op = Outbox.all()[0]) {
        let body;
        if (op.action === 'deleteMatch') {
          const row = ((this.base && this.base.tables[op.table] && this.base.tables[op.table].rows) || []).find(r => sameRow(op, r));
          if (!row) { Outbox.save(Outbox.all().slice(1)); changed = true; continue; }   // nothing to delete
          body = { action: 'delete', table: op.table, id: row['מזהה'] };
        } else if (op.action === 'delete') {
          body = { action: 'delete', table: op.table, id: this.realIds[op.id] || op.id };
        } else {
          body = { action: op.action, table: op.table, row: op.row, match: op.match };
        }
        try {
          const j = await this.call(body);
          const id = j.row && j.row['מזהה'];
          if (id) this.realIds[op.tmpId] = id;
          if (this.base) applyOp(this.base, op, id || body.id);
        } catch (e) {
          if (isNetErr(e)) break;                      // no signal: try again later
          failed[op.tmpId] = e;                        // refused by the sheet: drop it
          toast(`שינוי לא נשמר: ${sheetError(e)}`);
        }
        Outbox.save(Outbox.all().slice(1));
        changed = true;
      }
      if (changed && this.base) {
        store.set('sheet-cache', JSON.stringify({ key: this.key(), data: this.base }));
        this.setBase(this.base);
        cache.trip = {};
      }
      return failed;
    })().finally(() => { this._flushing = null; });
    return this._flushing;
  },
  table(name) { return (this.data && this.data.tables && this.data.tables[name]) || { columns: [], rows: [], hasPrivate: false }; },
  rows(name, t) { return this.table(name).rows.filter(r => !r['טיול'] || r['טיול'] === t.id || r['טיול'] === t.name); },
  locked(name) { return this.table(name).hasPrivate && this.data && this.data.level === 'public'; },
};
function updatePending() {
  const n = Outbox.all().length, el = $('pending');
  if (!el) return;
  el.hidden = !n;
  el.textContent = `⏳ ${n}`;
  el.title = `${n} שינויים ממתינים לשליחה`;
}
// after a write: redraw from the local copy; tell the user if it waits for a connection
function afterWrite(res) {
  cache.trip = {};
  render(true);
  if (res.queued) toast('אין קליטה: השינוי נשמר בטלפון ויישלח אוטומטית כשתחזור.', 'info');
}
window.addEventListener('online', () => { Sheet.flush().then(() => Sheet.refresh()); });
setInterval(() => { if (Outbox.all().length && navigator.onLine) Sheet.flush().then(f => { if (!Outbox.all().length) render(true); }); }, 30000);
const canEdit = () => !!SHEET_URL && Sheet.level() === 'edit';
const sheetError = e => e.code === 'forbidden' ? 'אין הרשאת עריכה. צריך להיכנס עם סיסמת העריכה.'
  : e.name === 'AbortError' || !navigator.onLine ? 'אין חיבור לאינטרנט (או שהוא איטי מדי). אפשר לנסות שוב כשיש קליטה.'
  : `השמירה נכשלה (${e.message}).`;
function resetData() { Sheet.data = null; Sheet.base = null; cache.trip = {}; }

// "לילות" like "1,2" or "3-5" → [1,2] / [3,4,5]
function parseNights(s) {
  const out = [];
  String(s || '').split(/[,،;\s]+/).forEach(p => {
    const m = p.match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) for (let i = +m[1]; i <= +m[2]; i++) out.push(i);
    else if (/^\d+$/.test(p)) out.push(+p);
  });
  return out;
}
function applySheetHotels(t) {
  Sheet.rows('hotels', t).forEach(r => {
    const id = 'sh-' + (r['מזהה'] || r['שם']);
    const ll = String(r['קואורדינטות'] || '').split(',').map(x => parseFloat(x));
    const h = {
      id, name: r['שם'] || 'מלון', address: r['כתובת'] || null, phone: r['טלפון'] || null,
      checkIn: r["צ'ק-אין"] || null, checkOut: r["צ'ק-אאוט"] || null, price: r['מחיר'] || null,
      cancelBy: r['ביטול עד'] || null, bookingUrl: r['לינק להזמנה'] || null, notes: r['הערות'] || null,
      bookingRef: r['🔒 מספר הזמנה'], fromSheet: true,
    };
    if (ll.length === 2 && ll.every(Number.isFinite)) { h.lat = ll[0]; h.lng = ll[1]; }
    t.hotels.push(h);
    t.hotelById[id] = h;
    parseNights(r['לילות']).forEach(n => { if (t.days[n - 1]) t.days[n - 1].hotelId = id; });
  });
}

// manual edits from the "עריכות" tab override the researched data of a place
const EDIT_FIELDS = [['summary', 'סיכום'], ['description', 'תיאור'], ['hours', 'שעות'], ['price', 'מחיר'], ['howToGet', 'איך מגיעים'], ['tips', 'טיפים']];
function applySheetEdits(t) {
  Sheet.rows('edits', t).forEach(r => {
    const it = t.itemById[r['פריט']];
    if (!it) return;
    EDIT_FIELDS.forEach(([k, col]) => {
      const v = (r[col] || '').trim();
      if (!v) return;
      it[k] = k === 'tips' ? v.split('\n').map(x => x.trim()).filter(Boolean) : v;
    });
    it.editRow = r['מזהה'];
    it.editedAt = r['עודכן'] || '';
  });
}

/* ---------- useful links per trip ---------- */
const linksPath = t => t.linksFile || `data/${t.id}-links.json`;
async function loadLinks(t) {
  if (SHEET_URL) {
    try { await Sheet.load(); } catch { return []; }
    return Sheet.rows('links', t).filter(r => !r['פריט']).map(r => ({ id: r['מזהה'], title: r['נושא'], url: r['לינק'] })).filter(l => l.url);
  }
  try { return (await getJSON(linksPath(t))).links || []; } catch { return []; }
}
const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|mibextid|sfnsn|ref_src|_ga|_gl|si)$/i;
function cleanUrl(raw) {
  let u;
  const s = raw.trim();
  try { u = new URL(s); } catch { try { u = new URL('https://' + s); } catch { return null; } }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  [...u.searchParams.keys()].forEach(k => { if (TRACKING.test(k)) u.searchParams.delete(k); });
  return u.toString();
}
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

async function viewLinks(id) {
  const t = await loadTrip(id);
  setHeader(`קישורים · ${t.name}`, `#/t/${t.id}`, 'חזרה לרשימת הימים');
  const links = await loadLinks(t);
  const edit = canEdit();
  app.innerHTML = `
    <div class="stack">${links.map(l => `
      <div class="card link-row">
        <a class="grow" href="${esc(l.url)}" target="_blank" rel="noopener">
          <b>${esc(l.title || hostOf(l.url))}</b>
          <span class="muted ltr">${esc(hostOf(l.url))}</span>
        </a>
        ${edit ? `<button class="del-btn" type="button" data-del="${esc(l.id)}" aria-label="מחיקת ${esc(l.title || '')}">🗑️</button>` : '<span class="chev">‹</span>'}
      </div>`).join('') || '<p class="empty">אין עדיין קישורים</p>'}
    </div>
    ${edit ? `
    <form id="link-form" class="card link-form" data-trip="${esc(t.id)}">
      <b>הוספת קישור</b>
      <label>נושא<input name="title" required maxlength="80" placeholder="למשל: השכרת רכב" autocomplete="off"></label>
      <label>לינק<input name="url" required inputmode="url" dir="ltr" placeholder="https://…" autocomplete="off"></label>
      <button class="btn primary" type="submit">הוספה</button>
      <p id="link-status" class="muted" role="status"></p>
    </form>` : ''}`;
}

app.addEventListener('submit', async e => {
  if (e.target.id !== 'link-form') return;
  e.preventDefault();
  const f = e.target, status = $('link-status');
  const title = f.title.value.trim(), url = cleanUrl(f.url.value);
  if (!url) { status.textContent = 'הלינק לא נראה תקין.'; return; }
  const t = await loadTrip(f.dataset.trip);
  f.querySelector('button').disabled = true;
  status.textContent = 'שומר…';
  try {
    const row = { 'טיול': t.id, 'נושא': title, 'לינק': url, 'נוסף': new Date().toISOString() };
    if (f.dataset.item) row['פריט'] = f.dataset.item;
    const res = await Sheet.write({ action: 'add', table: 'links', row });
    if (res.error) throw res.error;
    afterWrite(res);
  } catch (err) {
    status.textContent = sheetError(err);
    f.querySelector('button').disabled = false;
  }
});
app.addEventListener('click', async e => {
  const btn = e.target.closest('[data-del]');
  if (!btn || !/^#\/t\/[\w-]+\/(links|i\/[\w-]+)$/.test(location.hash)) return;
  const row = btn.closest('.link-row, .plink');
  const title = (row.querySelector('b') || row.querySelector('a')).textContent;
  if (!confirm(`למחוק את "${title}"?`)) return;
  btn.disabled = true;
  try {
    const res = await Sheet.write({ action: 'delete', table: 'links', id: btn.dataset.del });
    if (res.error) throw res.error;
    afterWrite(res);
  } catch (err) { btn.disabled = false; alert(sheetError(err)); }
});

/* ---------- flights / car rental (generic rows from the sheet) ---------- */
const nightsLabel = v => { const n = parseNights(v); return n.length ? `לילות: ${n.map(x => 'יום ' + x).join(', ')}` : ''; };
const SHEET_VIEWS = {
  hotels: { title: 'מלונות', icon: '🛏', addLabel: 'הוספת מלון', empty: 'אין עדיין מלונות',
    head: r => [`🛏 ${r['שם'] || 'מלון'}`, nightsLabel(r['לילות'])], skip: ['שם'], required: 'שם',
    subjectHint: 'למשל: Your booking is confirmed at …' },
  flights: { title: 'טיסות', icon: '✈️', addLabel: 'הוספת טיסה', empty: 'אין עדיין טיסות',
    head: r => [`✈️ ${r['מספר טיסה'] || 'טיסה'}`, [r['מ-'], r['ל-']].filter(Boolean).join(' ← ')],
    skip: ['מספר טיסה', 'מ-', 'ל-'], required: 'מספר טיסה', subjectHint: 'למשל: Your e-ticket receipt' },
  cars: { title: 'רכב', icon: '🚗', addLabel: 'הוספת השכרת רכב', empty: 'אין עדיין פרטי השכרה',
    head: r => [`🚗 ${r['חברה'] || 'השכרת רכב'}`, ''], skip: ['חברה'], required: 'חברה',
    subjectHint: 'למשל: Reservation confirmed' },
};
const factValue = (k, v) => /טלפון/.test(k) ? `<a class="ltr" href="tel:${esc(v.replace(/[^\d+]/g, ''))}">${esc(v)}</a>`
  : /^https?:\/\//.test(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">פתיחה ↗</a>`
  : esc(v);
const lockedNote = () => `<p class="muted lock-note">🔒 פרטי הזמנה מוסתרים. <a href="#/login">כניסה עם סיסמת הטיול</a></p>`;

async function viewSheetTable(id, name) {
  const t = await loadTrip(id);
  const cfg = SHEET_VIEWS[name];
  setHeader(`${cfg.title} · ${t.name}`, `#/t/${t.id}`, 'חזרה לרשימת הימים');
  if (!SHEET_URL) { app.innerHTML = '<p class="empty">עוד לא מחובר לגיליון</p>'; return; }
  try { await Sheet.load(); } catch { app.innerHTML = '<p class="empty">לא הצלחנו לטעון. צריך חיבור לאינטרנט בפעם הראשונה.</p>'; return; }
  const tb = Sheet.table(name);
  if (!cfg) throw new Error('המסך לא נמצא');
  const rows = Sheet.rows(name, t);
  app.innerHTML = `
    ${Sheet.locked(name) && rows.length ? lockedNote() : ''}
    <div class="stack">${rows.map(r => {
      const [title, sub] = cfg.head(r);
      const facts = tb.columns.filter(c => !['מזהה', 'טיול', ...cfg.skip].includes(c) && r[c]);
      return `
      <article class="card">
        ${canEdit() && r['מזהה'] ? `<button class="del-btn row-del" type="button" data-del-row="${esc(r['מזהה'])}" data-table="${name}" aria-label="מחיקה">🗑️</button>` : ''}
        <b class="row-title">${esc(title)}</b>
        ${sub ? `<div class="muted">${esc(sub)}</div>` : ''}
        ${facts.length ? `<dl class="facts" style="margin-top:10px">${facts.map(c => `<dt>${esc(c)}</dt><dd>${factValue(c, r[c])}</dd>`).join('')}</dl>` : ''}
      </article>`;
    }).join('') || `<p class="empty">${cfg.empty}</p>`}</div>
    ${canEdit() ? addFormHtml(name, t, cfg) : `<p class="muted" style="margin-top:14px">${Sheet.key() ? 'הוספה מהאפליקציה: עם סיסמת העריכה.' : 'העריכה: בגיליון, או באפליקציה עם סיסמת העריכה.'}</p>`}`;
}

function addFormHtml(name, t, cfg) {
  const cols = Sheet.table(name).columns.filter(c => c !== 'מזהה' && c !== 'טיול');
  const field = c => c === 'לילות' ? `
      <fieldset class="nights"><legend>לילות (בוחרים את הימים במסלול)</legend>
        ${t.days.map(d => `<label class="chip"><input type="checkbox" value="${d.index + 1}"><span>יום ${d.index + 1}</span></label>`).join('')}
      </fieldset>`
    : `<label>${esc(c)}<input name="${esc(c)}" ${c === cfg.required ? 'required' : ''} autocomplete="off"
        ${/טלפון/.test(c) ? 'inputmode="tel" dir="ltr"' : /לינק/.test(c) ? 'inputmode="url" dir="ltr"' : /קואורדינטות|🔒/.test(c) ? 'dir="ltr"' : ''}
        ${c === 'קואורדינטות' ? 'placeholder="64.14, -21.94"' : ''}></label>`;
  return `
    <details class="card add-box" id="add-box">
      <summary>➕ ${esc(cfg.addLabel)}</summary>
      <div class="mail-fill">
        <label>📧 מילוי אוטומטי מהמייל: כותרת מייל האישור
          <input id="mail-subject" placeholder="${esc(cfg.subjectHint)}" autocomplete="off">
        </label>
        <button class="btn" type="button" id="mail-btn" data-table="${name}">חיפוש במייל</button>
        <p id="mail-status" class="muted" role="status"></p>
      </div>
      <form id="row-form" class="link-form" data-table="${name}" data-trip="${esc(t.id)}">
        ${cols.map(field).join('')}
        <button class="btn primary" type="submit">שמירה</button>
        <p id="row-status" class="muted" role="status"></p>
      </form>
    </details>`;
}

app.addEventListener('submit', async e => {
  if (e.target.id !== 'row-form') return;
  e.preventDefault();
  const f = e.target, status = $('row-status');
  const row = { 'טיול': f.dataset.trip };
  f.querySelectorAll('input[name]').forEach(i => { if (i.value.trim()) row[i.name] = i.value.trim(); });
  const nights = [...f.querySelectorAll('.nights input:checked')].map(i => i.value);
  if (nights.length) row['לילות'] = nights.join(',');
  if (row['לינק להזמנה']) row['לינק להזמנה'] = cleanUrl(row['לינק להזמנה']) || row['לינק להזמנה'];
  if (row['לינק']) row['לינק'] = cleanUrl(row['לינק']) || row['לינק'];
  f.querySelector('button[type=submit]').disabled = true;
  status.textContent = 'שומר…';
  try {
    const res = await Sheet.write({ action: 'add', table: f.dataset.table, row });
    if (res.error) throw res.error;
    afterWrite(res);
  } catch (err) {
    status.textContent = sheetError(err);
    f.querySelector('button[type=submit]').disabled = false;
  }
});

app.addEventListener('click', async e => {
  const mail = e.target.closest('#mail-btn');
  if (mail) {
    const subject = $('mail-subject').value.trim(), status = $('mail-status'), f = $('row-form');
    if (subject.length < 4) { status.textContent = 'צריך להקליד את כותרת המייל (לפחות 4 תווים).'; return; }
    mail.disabled = true;
    status.textContent = 'מחפש במייל…';
    try {
      const j = await Sheet.call({ action: 'fromEmail', table: mail.dataset.table, subject }, 30000);
      if (!j.found) { status.textContent = 'לא נמצא מייל עם הכותרת הזו. אפשר להעתיק את הכותרת בדיוק מהמייל.'; return; }
      let n = 0;
      Object.entries(j.fields || {}).forEach(([k, v]) => {
        const input = [...f.querySelectorAll('input[name]')].find(i => i.name === k);
        if (input) { input.value = v; n++; }
      });
      status.textContent = n
        ? `נמצא: "${j.email.subject}" (${j.email.date}). מולאו ${n} שדות. כדאי לעבור עליהם ולהשלים לפני שמירה.`
        : `נמצא: "${j.email.subject}", אבל לא הצלחתי לחלץ ממנו פרטים. אפשר למלא ידנית.`;
    } catch (err) {
      status.textContent = /permission|authoriz|הרשא/i.test(err.message)
        ? 'לסקריפט בגיליון עוד אין הרשאה לקרוא מייל. צריך להריץ פעם אחת את authorizeGmail (ראו הוראות).'
        : sheetError(err);
    } finally { mail.disabled = false; }
    return;
  }
  const del = e.target.closest('[data-del-row]');
  if (!del) return;
  const title = del.closest('.card').querySelector('.row-title').textContent;
  if (!confirm(`למחוק את "${title}"?`)) return;
  del.disabled = true;
  try {
    const res = await Sheet.write({ action: 'delete', table: del.dataset.table, id: del.dataset.delRow });
    if (res.error) throw res.error;
    afterWrite(res);
  } catch (err) { del.disabled = false; alert(sheetError(err)); }
});

/* ---------- place links: from the data, YouTube, and added by the editor (sheet) ---------- */
function placeLinksHtml(t, it, dataLinks) {
  const yt = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${it.wiki || it.name} ${t.name === 'איסלנד' ? 'Iceland' : t.name}`)}`;
  const own = Sheet.rows('links', t).filter(r => r['פריט'] === it.id && r['לינק']);
  const edit = canEdit();
  const li = (url, title, del) => `<li class="plink"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(title || hostOf(url))}</a>
      <span class="muted ltr">${esc(hostOf(url))}</span>${del ? `<button class="del-btn small" type="button" data-del="${esc(del)}" aria-label="מחיקה">🗑️</button>` : ''}</li>`;
  return `
    <section class="section links place-links"><h3>🔗 קישורים</h3>
      <ul>
        ${dataLinks.map(l => li(l.url, l.label)).join('')}
        ${own.map(r => li(r['לינק'], r['נושא'], edit && r['מזהה'])).join('')}
        <li class="plink"><a href="${esc(yt)}" target="_blank" rel="noopener">▶️ סרטונים ביוטיוב</a><span class="muted ltr">youtube.com</span></li>
      </ul>
      ${edit ? `
      <details class="add-inline"><summary>➕ הוספת קישור</summary>
        <form id="link-form" class="link-form" data-trip="${esc(t.id)}" data-item="${esc(it.id)}">
          <label>נושא<input name="title" required maxlength="80" placeholder="למשל: אתר רשמי" autocomplete="off"></label>
          <label>לינק<input name="url" required inputmode="url" dir="ltr" placeholder="https://…" autocomplete="off"></label>
          <button class="btn primary" type="submit">הוספה</button>
          <p id="link-status" class="muted" role="status"></p>
        </form>
      </details>` : ''}
    </section>`;
}

/* ---------- photos from the place's Wikipedia article (Wikimedia Commons, with credit) ---------- */
const SKIP_IMG = /map|logo|flag|locator|icon|diagram|coat[_ ]of|symbol|location|chart|plan\b|sign\b/i;
async function loadPhotos(title) {
  const key = 'photos:' + title;
  try {
    const c = JSON.parse(store.get(key) || 'null');
    if (c && Date.now() - c.at < 30 * 864e5) return c.photos;
  } catch { /* ignore */ }
  const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1'
    + '&generator=images&gimlimit=40&prop=imageinfo&iiprop=url|extmetadata|mime&iiurlwidth=900&titles=' + encodeURIComponent(title);
  const r = await fetch(api);
  const j = await r.json();
  const text = html => { const d = document.createElement('div'); d.innerHTML = html || ''; return d.textContent.trim(); };
  const photos = Object.values((j.query && j.query.pages) || {})
    .filter(pg => pg.imageinfo && pg.imageinfo[0].mime === 'image/jpeg' && !SKIP_IMG.test(pg.title))
    .slice(0, 6)
    .map(pg => {
      const ii = pg.imageinfo[0], m = ii.extmetadata || {};
      return { src: ii.thumburl || ii.url, page: ii.descriptionurl,
        artist: text(m.Artist && m.Artist.value).slice(0, 60), license: text(m.LicenseShortName && m.LicenseShortName.value) };
    });
  store.set(key, JSON.stringify({ at: Date.now(), photos }));
  return photos;
}
async function showGallery(title) {
  const el = $('gallery');
  if (!el) return;
  let photos = [];
  try { photos = await loadPhotos(title); } catch { return; }   // offline or blocked: no gallery
  if (!photos.length || !document.body.contains(el)) return;
  el.innerHTML = photos.map(p => `
    <figure><img src="${esc(p.src)}" alt="" loading="lazy" decoding="async">
      <figcaption><a href="${esc(p.page)}" target="_blank" rel="noopener">📷 ${esc(p.artist || 'Wikimedia Commons')}${p.license ? ' · ' + esc(p.license) : ''}</a></figcaption>
    </figure>`).join('');
  el.hidden = false;
}

// request an info check for this place: text the editor pastes to Claude (the app cannot reach Claude itself)
function researchHtml(t, it) {
  return `
    <details class="card add-box" id="research-box">
      <summary>🔎 בקשת בדיקת מידע</summary>
      <form id="research-form" class="link-form" data-trip="${esc(t.id)}" data-item="${esc(it.id)}">
        <p class="muted">מעתיקים את הבקשה ומדביקים בצ'אט עם Claude. Claude יחפש שעות, מחיר ואיך מגיעים, ויוסיף קישור למקור.</p>
        <label>הערה (לא חובה)<textarea name="note" rows="2" placeholder="למשל: לבדוק גם חניה"></textarea></label>
        <button class="btn primary" type="submit">📋 העתקת הבקשה</button>
        <p id="research-status" class="muted" role="status"></p>
      </form>
    </details>`;
}
app.addEventListener('submit', async e => {
  if (e.target.id !== 'research-form') return;
  e.preventDefault();
  const f = e.target, status = $('research-status');
  const t = await loadTrip(f.dataset.trip);
  const it = t.itemById[f.dataset.item];
  const note = f.note.value.trim();
  const text = `בדיקת מידע · ${t.name} (${t.id})\n- יום ${it.dayIndex + 1} · ${it.name} (${it.id})${note ? `\nהערה: ${note}` : ''}`;
  try {
    await navigator.clipboard.writeText(text);
    status.textContent = 'הועתק. עכשיו להדביק בצ\'אט עם Claude.';
  } catch {
    status.innerHTML = `לא הצלחתי להעתיק אוטומטית. אפשר לסמן ולהעתיק:<textarea rows="3" readonly>${esc(text)}</textarea>`;
  }
});

function itemEditHtml(t, it) {
  const v = k => k === 'tips' ? (it.tips || []).join('\n') : (it[k] || '');
  return `
    <details class="card add-box">
      <summary>✏️ עריכת המידע</summary>
      <form id="item-form" class="link-form" data-trip="${esc(t.id)}" data-item="${esc(it.id)}">
        ${EDIT_FIELDS.map(([k, col]) => `<label>${esc(col)}${k === 'tips' ? ' (טיפ בכל שורה)' : ''}
          <textarea name="${k}" rows="${k === 'description' || k === 'tips' ? 4 : 2}">${esc(v(k))}</textarea></label>`).join('')}
        <button class="btn primary" type="submit">שמירה</button>
        ${it.editRow ? '<button class="btn" type="button" id="item-revert">ביטול העריכה הידנית</button>' : ''}
        <p id="item-status" class="muted" role="status"></p>
      </form>
    </details>`;
}
app.addEventListener('submit', async e => {
  if (e.target.id !== 'item-form') return;
  e.preventDefault();
  const f = e.target, status = $('item-status');
  const t = await loadTrip(f.dataset.trip);
  const it = t.itemById[f.dataset.item];
  const row = { 'טיול': t.id, 'פריט': it.id, 'עודכן': new Date().toISOString() };
  // save only fields that differ from what is shown now, so later research still fills the rest
  EDIT_FIELDS.forEach(([k, col]) => {
    const now = k === 'tips' ? (it.tips || []).join('\n') : (it[k] || '');
    const val = f.elements[k].value.trim();
    if (val && (val !== now || it.editRow)) row[col] = val;
  });
  f.querySelector('button[type=submit]').disabled = true;
  status.textContent = 'שומר…';
  try {
    const res = await Sheet.write({ action: 'upsert', table: 'edits', match: ['טיול', 'פריט'], row });
    if (res.error) throw res.error;
    afterWrite(res);
  } catch (err) { status.textContent = sheetError(err); f.querySelector('button[type=submit]').disabled = false; }
});
app.addEventListener('click', async e => {
  if (!e.target.closest('#item-revert')) return;
  const f = $('item-form');
  const t = await loadTrip(f.dataset.trip);
  const it = t.itemById[f.dataset.item];
  if (!confirm('לבטל את העריכה הידנית ולחזור למידע המקורי?')) return;
  try {
    const res = await Sheet.write({ action: 'delete', table: 'edits', id: it.editRow });
    if (res.error) throw res.error;
    afterWrite(res);
  } catch (err) { alert(sheetError(err)); }
});

/* ---------- sign-in with the trip / edit password ---------- */
async function viewLogin() {
  setHeader('כניסה עם סיסמה', '#/', 'חזרה לדף הראשי');
  if (!SHEET_URL) { app.innerHTML = '<p class="empty">עוד לא מחובר לגיליון</p>'; return; }
  const lvl = Sheet.level();
  app.innerHTML = Sheet.key() ? `
    <div class="card stack">
      <b>✅ ${lvl === 'edit' ? 'מחובר עם סיסמת עריכה' : 'מחובר עם סיסמת הטיול'}</b>
      <p class="muted">${lvl === 'edit' ? 'רואים את כל הפרטים, ואפשר להוסיף ולמחוק קישורים.' : 'רואים את כל הפרטים, כולל מספרי הזמנה.'}</p>
      <button id="logout" class="btn" type="button">יציאה</button>
    </div>` : `
    <form id="login-form" class="card stack">
      <b>כניסה</b>
      <p class="muted">סיסמת הטיול מציגה גם מספרי הזמנה. סיסמת העריכה מאפשרת גם להוסיף ולמחוק.</p>
      <input name="key" type="password" required autocomplete="current-password" placeholder="סיסמה">
      <button class="btn primary" type="submit">כניסה</button>
      <p id="login-status" class="muted" role="status"></p>
    </form>`;
  $('logout')?.addEventListener('click', () => {
    const n = Outbox.all().length;
    if (n && !confirm(`יש ${n} שינויים שעוד לא נשלחו. ביציאה הם יימחקו. לצאת?`)) return;
    Outbox.save([]);
    store.set('trip-key', ''); store.set('trip-level', ''); store.set('sheet-cache', '');
    resetData(); updateLoginMenu(); render(true);
  });
  $('login-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const key = e.target.key.value, status = $('login-status');
    status.textContent = 'בודק…';
    try {
      const j = await Sheet.call({ action: 'check', key });
      if (j.level === 'public') { status.textContent = 'הסיסמה לא נכונה.'; return; }
      store.set('trip-key', key); store.set('trip-level', j.level);
      resetData(); updateLoginMenu(); render(true);
    } catch (err) { status.textContent = sheetError(err); }
  });
}
function updateLoginMenu() {
  const k = Sheet.key(), l = Sheet.level();
  $('menu-editor').hidden = !SHEET_URL;
  $('menu-editor-label').textContent = !k ? 'כניסה עם סיסמה' : l === 'edit' ? 'מחובר · עריכה' : 'מחובר · צפייה מלאה';
}

/* ---------- router ---------- */
const routes = [
  [/^#\/t\/([\w-]+)\/d\/(\d+)$/, viewDay],
  [/^#\/t\/([\w-]+)\/i\/([\w-]+)$/, viewItem],
  [/^#\/t\/([\w-]+)\/h\/([\w-]+)$/, viewHotel],
  [/^#\/t\/([\w-]+)\/links$/, viewLinks],
  [/^#\/t\/([\w-]+)$/, viewDays],
  [/^#\/t\/([\w-]+)\/s\/(hotels|flights|cars)$/, viewSheetTable],
  [/^#\/login$/, viewLogin],
];
async function render(keepScroll) {
  const y = window.scrollY;
  clearMaps();
  const hash = location.hash;
  let handledScroll = false;
  const match = routes.map(([re, fn]) => [hash.match(re), fn]).find(([m]) => m);
  try {
    if (match) handledScroll = await match[1](...match[0].slice(1).map(decodeURIComponent));
    else await viewTrips();
  } catch (e) {
    console.error(e);
    setHeader('שגיאה', '#/', 'חזרה לדף הראשי');
    app.innerHTML = `<div class="card"><b>לא הצלחנו לטעון את הנתונים.</b><p class="muted">${esc(e.message)}</p><button class="btn" type="button" onclick="location.reload()">לנסות שוב</button></div>`;
  }
  if (keepScroll) window.scrollTo(0, y);
  else if (handledScroll !== true) window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => { notesMode = false; render(false); });

app.addEventListener('click', e => {
  const tab = e.target.closest('[data-choice]');
  if (!tab) return;
  store.set(tab.dataset.choice, tab.dataset.idx);
  render(true);
});

/* ---------- side menu ---------- */
const drawer = $('drawer'), overlay = $('overlay'), menuBtn = $('menu-btn');
function setMenu(open) {
  drawer.classList.toggle('open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  menuBtn.setAttribute('aria-expanded', String(open));
  overlay.hidden = !open;
}
menuBtn.addEventListener('click', () => setMenu(!drawer.classList.contains('open')));
overlay.addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });
window.addEventListener('hashchange', () => setMenu(false));
// public link to share; replace with a short/custom URL when there is one
// public link to share (add ?v=N temporarily to refresh WhatsApp's cached preview)
const SHARE_URL = new URL('./', location.href).href;
$('share-wa').href = 'https://wa.me/?text=' + encodeURIComponent(`הצטרף לאפליקציית הטיולים 🧳\n${SHARE_URL}`);
$('share-wa').addEventListener('click', () => setMenu(false));
updateLoginMenu();
updatePending();
if (SHEET_URL && Outbox.all().length) Sheet.flush();

/* ---------- theme + offline ---------- */
const THEMES = [null, 'dark', 'light'];
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || null;
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
  store.set('theme', next || '');
});
const updateOnline = () => { $('offline').hidden = navigator.onLine; };
window.addEventListener('online', updateOnline);
window.addEventListener('offline', updateOnline);
updateOnline();

if ('serviceWorker' in navigator) {
  // when a new version takes over, reload once so it shows right away
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(console.error));
}

render(false);
