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
function drawMap(el, points, hotel, tripId) {
  if (!window.L || !el) return;
  const map = L.map(el, { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© OpenStreetMap',
  }).addTo(map);
  const pin = (html, cls) => L.divIcon({ className: `pin ${cls || ''}`, html, iconSize: [28, 28], iconAnchor: [14, 14] });
  const line = [];
  if (hasLL(hotel)) {
    L.marker([hotel.lat, hotel.lng], { icon: pin('🛏', 'hotel') }).addTo(map)
      .bindPopup(hotel.id ? `<a href="#/t/${tripId}/h/${esc(hotel.id)}">${esc(hotel.name)}</a>` : esc(hotel.name));
    line.push([hotel.lat, hotel.lng]);
  }
  points.forEach(p => {
    const cls = p.kind === 'fuel' ? 'fuel' : '';
    L.marker([p.lat, p.lng], { icon: pin(p.kind === 'fuel' ? '⛽' : p.num, cls) }).addTo(map)
      .bindPopup(`<a href="#/t/${tripId}/i/${esc(p.id)}">${esc(p.name)}</a>`);
    line.push([p.lat, p.lng]);
  });
  if (hasLL(hotel) && points.length) line.push([hotel.lat, hotel.lng]);
  if (line.length > 1) L.polyline(line, { color: '#0f766e', weight: 3, opacity: .7, dashArray: '6 8' }).addTo(map);
  if (line.length > 1) map.fitBounds(line, { padding: [28, 28] });
  else if (line.length === 1) map.setView(line[0], 12);
  else map.setView([64.9, -18.6], 6);
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
          <div class="muted">📍 ${val(d.region)}${hotel ? ` · 🛏 ${esc(hotel.name)}` : d.stayArea ? ` · 🛏 ${esc(d.stayArea.name)}` : ''}</div>
        </div>
        ${isToday ? '<span class="badge">היום</span>' : ''}
      </a>`;
    }).join('') || '<p class="empty">אין עדיין ימים</p>'}</div>`;
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

function itemCard(t, it, numById) {
  const [icon] = kind(it.kind);
  const n = numById[it.id];
  const meta = [it.time ? `🕒 ${esc(it.time)}` : null, it.durationMinutes ? `⏱ ${fmtMin(it.durationMinutes)}` : null].filter(Boolean).join(' · ');
  return `
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

  app.innerHTML = `
    ${hotel
      ? `<a class="hotel-bar" href="#/t/${esc(t.id)}/h/${esc(hotel.id)}"><span class="ico">🛏</span><div class="grow"><small>לינה הלילה</small><b>${esc(hotel.name)}</b></div><span class="chev">‹</span></a>`
      : day.stayArea
        ? `<div class="hotel-bar"><span class="ico">🛏</span><div class="grow"><small>לינה הלילה · טרם הוזמן</small><b>אזור ${esc(day.stayArea.name)}</b></div></div>`
        : `<div class="hotel-bar"><span class="ico">🛏</span><div class="grow"><small>לינה הלילה</small>${day.index === t.days.length - 1 ? 'יום אחרון, אין לינה' : UNKNOWN}</div></div>`}
    <div id="map" class="map" dir="ltr"></div>
    ${route ? `<a class="btn primary" href="${esc(route)}" target="_blank" rel="noopener">🗺️ מסלול היום בגוגל מפות</a>` : ''}
    ${canEdit() ? `<a class="btn" style="margin-top:8px" href="#/research/${esc(t.id)}/${day.index + 1}">🔎 בקשת בדיקת מידע ליום הזה</a>` : ''}
    ${legs.length ? `<div class="drive-total">🚗 סה״כ נהיגה: ~${km} ק״מ · ${fmtMin(min) || '0 דק׳'}${partial ? ' (חלק מהמקטעים לא ידועים)' : ''}</div>` : ''}
    ${blocks}
    ${last && 'driveToHotel' in last ? `<div class="drive" style="margin-top:6px">🚗 חזרה ללינה: ${esc(fmtDrive(last.driveToHotel))}</div>` : ''}`;

  drawMap($('map'), points, tonight, t.id);
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
      ${links.length ? `<section class="section links"><h3>קישורים</h3><ul>${links.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.url)}</a></li>`).join('')}</ul></section>` : ''}
      ${sources.length || it.checkedAt ? `<section class="section links sources"><h3>📚 מקורות המידע</h3>
        ${sources.length ? `<ul>${sources.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || hostOf(l.url))}</a></li>`).join('')}</ul>` : ''}
        ${it.checkedAt ? `<p class="muted">נבדק ב-${esc(fmtDate(it.checkedAt, { day: 'numeric', month: 'long', year: 'numeric' }))}</p>` : ''}</section>` : ''}
      ${it.editRow ? `<p class="muted edited">✏️ חלק מהמידע נערך ידנית${it.editedAt ? ` (${esc(it.editedAt.slice(0, 10))})` : ''}</p>` : ''}
      ${canEdit() ? itemEditHtml(t, it) : ''}
    </article>`;
  if (hasLL(it)) drawMap($('map'), [{ ...it, num: '•' }], null, t.id);
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
const Sheet = {
  key: () => store.get('trip-key') || '',
  level: () => store.get('trip-level') || 'public',
  data: null,
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
  // latest data from the sheet; falls back to the copy saved on this device (offline)
  async load(force) {
    if (!SHEET_URL) return null;
    if (this.data && !force) return this.data;
    try {
      const j = await this.call({ action: 'read' });
      this.data = j;
      store.set('sheet-cache', JSON.stringify({ key: this.key(), data: j }));
      if (this.key() && j.level !== this.level()) {   // password was changed in the sheet
        if (j.level === 'public') store.set('trip-key', '');
        store.set('trip-level', j.level === 'public' ? '' : j.level);
        updateLoginMenu();
      }
    } catch (e) {
      let c = null;
      try { c = JSON.parse(store.get('sheet-cache') || 'null'); } catch { /* ignore */ }
      if (c && c.key === this.key()) this.data = c.data; else throw e;
    }
    return this.data;
  },
  table(name) { return (this.data && this.data.tables && this.data.tables[name]) || { columns: [], rows: [], hasPrivate: false }; },
  rows(name, t) { return this.table(name).rows.filter(r => !r['טיול'] || r['טיול'] === t.id || r['טיול'] === t.name); },
  locked(name) { return this.table(name).hasPrivate && this.data && this.data.level === 'public'; },
};
const canEdit = () => !!SHEET_URL && Sheet.level() === 'edit';
const sheetError = e => e.code === 'forbidden' ? 'אין הרשאת עריכה. צריך להיכנס עם סיסמת העריכה.'
  : e.name === 'AbortError' || !navigator.onLine ? 'אין חיבור לאינטרנט (או שהוא איטי מדי). אפשר לנסות שוב כשיש קליטה.'
  : `השמירה נכשלה (${e.message}).`;
function resetData() { Sheet.data = null; cache.trip = {}; }

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
    return Sheet.rows('links', t).map(r => ({ id: r['מזהה'], title: r['נושא'], url: r['לינק'] })).filter(l => l.url);
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
    await Sheet.call({ action: 'add', table: 'links', row: { 'טיול': t.id, 'נושא': title, 'לינק': url, 'נוסף': new Date().toISOString() } });
    await Sheet.load(true);
    render(true);
  } catch (err) {
    status.textContent = sheetError(err);
    f.querySelector('button').disabled = false;
  }
});
app.addEventListener('click', async e => {
  const btn = e.target.closest('[data-del]');
  if (!btn || !/^#\/t\/[\w-]+\/links$/.test(location.hash)) return;
  const title = btn.closest('.link-row').querySelector('b').textContent;
  if (!confirm(`למחוק את "${title}"?`)) return;
  btn.disabled = true;
  try {
    await Sheet.call({ action: 'delete', table: 'links', id: btn.dataset.del });
    await Sheet.load(true);
    render(true);
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
    await Sheet.call({ action: 'add', table: f.dataset.table, row });
    resetData();
    await Sheet.load(true);
    render(true);
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
    await Sheet.call({ action: 'delete', table: del.dataset.table, id: del.dataset.delRow });
    resetData();
    await Sheet.load(true);
    render(true);
  } catch (err) { del.disabled = false; alert(sheetError(err)); }
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
    await Sheet.call({ action: 'upsert', table: 'edits', match: ['טיול', 'פריט'], row });
    resetData();
    await Sheet.load(true);
    render(true);
  } catch (err) { status.textContent = sheetError(err); f.querySelector('button[type=submit]').disabled = false; }
});
app.addEventListener('click', async e => {
  if (!e.target.closest('#item-revert')) return;
  const f = $('item-form');
  const t = await loadTrip(f.dataset.trip);
  const it = t.itemById[f.dataset.item];
  if (!confirm('לבטל את העריכה הידנית ולחזור למידע המקורי?')) return;
  try {
    await Sheet.call({ action: 'delete', table: 'edits', id: it.editRow });
    resetData();
    await Sheet.load(true);
    render(true);
  } catch (err) { alert(sheetError(err)); }
});

/* ---------- request an info check (text to paste to Claude) ---------- */
async function viewResearch(tripId, dayNum) {
  setHeader('בקשת בדיקת מידע', tripId ? `#/t/${tripId}${dayNum ? '/d/' + (dayNum - 1) : ''}` : '#/', 'חזרה');
  const trips = await loadTrips();
  const t = await loadTrip(tripId || trips[0].id);
  app.innerHTML = `
    <form id="research-form" class="card link-form" data-trip="${esc(t.id)}">
      <p class="muted">בוחרים ימים, מעתיקים את הבקשה ומדביקים אותה בצ'אט עם Claude. Claude יחפש שעות, מחירים ואיך מגיעים, ויוסיף קישור למקור של כל מידע.</p>
      ${trips.length > 1 ? `<label>טיול<select name="trip">${trips.map(x => `<option value="${esc(x.id)}" ${x.id === t.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
      <fieldset class="nights"><legend>ימים לבדיקה</legend>
        ${t.days.map(d => `<label class="chip"><input type="checkbox" value="${d.index + 1}" ${d.index + 1 === Number(dayNum) ? 'checked' : ''}><span>יום ${d.index + 1}</span></label>`).join('')}
      </fieldset>
      <label>הערה (לא חובה)<textarea name="note" rows="2" placeholder="למשל: לבדוק גם מסעדות באזור"></textarea></label>
      <button class="btn primary" type="submit">📋 העתקת הבקשה</button>
      <p id="research-status" class="muted" role="status"></p>
    </form>`;
  const form = $('research-form');
  form.trip?.addEventListener('change', () => { location.hash = `#/research/${form.trip.value}`; });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const days = [...form.querySelectorAll('.nights input:checked')].map(i => Number(i.value));
    const status = $('research-status');
    if (!days.length) { status.textContent = 'צריך לבחור לפחות יום אחד.'; return; }
    const lines = days.map(n => `- יום ${n}: ${t.days[n - 1].title || ''} (${t.days[n - 1].region || ''})`);
    const note = form.note.value.trim();
    const text = `בדיקת מידע · ${t.name} (${t.id})\n${lines.join('\n')}${note ? `\nהערה: ${note}` : ''}`;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'הועתק. עכשיו להדביק בצ\'אט עם Claude.';
    } catch {
      status.innerHTML = `לא הצלחתי להעתיק אוטומטית. אפשר לסמן ולהעתיק:<textarea rows="4" readonly>${esc(text)}</textarea>`;
    }
  });
}

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
  $('menu-research').hidden = !canEdit();
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
  [/^#\/research(?:\/([\w-]+)(?:\/(\d+))?)?$/, viewResearch],
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
window.addEventListener('hashchange', () => render(false));

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
