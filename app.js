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
  const price = isNil(p.amount) ? UNKNOWN : `${esc(Number(p.amount).toLocaleString('he-IL'))} ${esc(p.currency || '')} ${esc(p.note || '')}`;
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
        </dl>
      </section>
      ${h.notes ? `<section class="section"><h3>הערות</h3><p>${esc(h.notes)}</p></section>` : ''}
      ${nights.length ? `<section class="section links"><h3>לילות כאן</h3><ul>${nights.map(d => `<li><a href="#/t/${esc(t.id)}/d/${d.index}">יום ${d.index + 1}${d.date ? ' · ' + esc(fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })) : ''}</a></li>`).join('')}</ul></section>` : ''}
    </article>`;
  if (hasLL(h)) drawMap($('map'), [], h, t.id);
}

/* ---------- router ---------- */
const routes = [
  [/^#\/t\/([\w-]+)\/d\/(\d+)$/, viewDay],
  [/^#\/t\/([\w-]+)\/i\/([\w-]+)$/, viewItem],
  [/^#\/t\/([\w-]+)\/h\/([\w-]+)$/, viewHotel],
  [/^#\/t\/([\w-]+)$/, viewDays],
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
// ?v= busts WhatsApp's cached link preview; bump it after changing the preview tags
const SHARE_URL = new URL('./?v=2', location.href).href;
$('share-wa').href = 'https://wa.me/?text=' + encodeURIComponent(`הצטרף לאפליקציית הטיולים 🧳\n${SHARE_URL}`);
$('share-wa').addEventListener('click', () => setMenu(false));

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
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.error));
}

render(false);
