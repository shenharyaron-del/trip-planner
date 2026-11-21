/**
 * trip-planner: Google Sheets backend.
 * Paste into the spreadsheet: Extensions → Apps Script. Run setup() once, then deploy as a web app.
 * The spreadsheet itself stays private; the app reads/writes only through this script.
 */

const TABLES = { links: 'קישורים', hotels: 'מלונות', cars: 'רכב', flights: 'טיסות' };
const HEADERS = {
  links: ['מזהה', 'טיול', 'נושא', 'לינק', 'נוסף'],
  hotels: ['מזהה', 'טיול', 'שם', 'כתובת', 'טלפון', "צ'ק-אין", "צ'ק-אאוט", 'לילות', 'מחיר', 'ביטול עד',
           'לינק להזמנה', 'קואורדינטות', 'הערות', '🔒 מספר הזמנה'],
  cars: ['מזהה', 'טיול', 'חברה', 'איסוף', 'החזרה', 'ביטוח', 'טלפון', 'לינק', 'הערות', '🔒 מספר הזמנה'],
  flights: ['מזהה', 'טיול', 'תאריך', 'מספר טיסה', 'מ-', 'ל-', 'המראה', 'נחיתה', 'הערות', '🔒 קוד הזמנה'],
};
const SETTINGS = 'הגדרות';
const PRIVATE = '🔒';

/** Run once from the editor: creates the tabs, headers and the settings tab. Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABLES).forEach(k => {
    const sh = ss.getSheetByName(TABLES[k]) || ss.insertSheet(TABLES[k]);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[k].length).setValues([HEADERS[k]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
    sh.getRange(1, 1, sh.getMaxRows(), HEADERS[k].length).setNumberFormat('@'); // keep phones/dates as typed
    sh.setRightToLeft(true);
  });
  const st = ss.getSheetByName(SETTINGS) || ss.insertSheet(SETTINGS);
  if (st.getLastRow() === 0) {
    st.getRange(1, 1, 2, 2).setValues([['סיסמת טיול', 'לשנות-אותי-1'], ['סיסמת עריכה', 'לשנות-אותי-2']]);
    st.getRange('A:A').setFontWeight('bold');
  }
  st.setRightToLeft(true);
  const links = ss.getSheetByName(TABLES.links);
  if (links.getLastRow() === 1) {
    links.appendRow([newId(), 'iceland', 'השכרת רכב', 'https://www.icelandil.com/driving', new Date().toISOString()]);
  }
  ['Sheet1', 'גיליון1'].forEach(n => {
    const def = ss.getSheetByName(n);
    if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse((e.postData && e.postData.contents) || '{}'); } catch (err) { /* empty */ }
  try { return json(handle(req)); } catch (err) { return json({ ok: false, error: String(err.message || err) }); }
}

/** Opening the web-app URL in a browser shows the public data (handy to test the deployment). */
function doGet() {
  return json(handle({ action: 'read' }));
}

function handle(req) {
  const level = levelFor(req.key);
  const action = req.action || 'read';
  if (action === 'check') return { ok: true, level };
  if (action === 'read') return { ok: true, level, tables: readAll(level !== 'public') };
  if (level !== 'edit') return { ok: false, error: 'forbidden' };
  if (action === 'fromEmail') return Object.assign({ ok: true }, fromEmail(req.table, req.subject));
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (action === 'add') return { ok: true, row: addRow(req.table, req.row || {}) };
    if (action === 'delete') return { ok: true, deleted: deleteRow(req.table, req.id) };
  } finally {
    lock.releaseLock();
  }
  return { ok: false, error: 'unknown action' };
}

function settings() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SETTINGS);
  const out = {};
  if (sh) sh.getDataRange().getDisplayValues().forEach(r => { out[String(r[0]).trim()] = String(r[1]).trim(); });
  return out;
}

function levelFor(key) {
  if (!key) return 'public';
  const s = settings();
  if (s['סיסמת עריכה'] && key === s['סיסמת עריכה']) return 'edit';
  if (s['סיסמת טיול'] && key === s['סיסמת טיול']) return 'trip';
  return 'public';
}

function sheetFor(table) {
  if (!TABLES[table]) throw new Error('unknown table');
  const sh = SpreadsheetApp.getActive().getSheetByName(TABLES[table]);
  if (!sh) throw new Error('missing tab: ' + TABLES[table]);
  return sh;
}

function readAll(showPrivate) {
  const out = {};
  Object.keys(TABLES).forEach(k => {
    const sh = SpreadsheetApp.getActive().getSheetByName(TABLES[k]);
    if (!sh) { out[k] = { columns: [], rows: [], hasPrivate: false }; return; }
    const values = sh.getDataRange().getDisplayValues();
    const headers = (values.shift() || []).map(h => String(h).trim());
    ensureIds(sh, headers, values);
    const keep = headers.map(h => h && (showPrivate || h.indexOf(PRIVATE) !== 0));
    out[k] = {
      columns: headers.filter((h, i) => keep[i]),
      hasPrivate: headers.some(h => h.indexOf(PRIVATE) === 0),
      rows: values
        .filter(r => r.some(c => c !== ''))
        .map(r => {
          const o = {};
          headers.forEach((h, i) => { if (keep[i]) o[h] = r[i]; });
          return o;
        }),
    };
  });
  return out;
}

// rows typed by hand get an id, so the app can delete them
function ensureIds(sh, headers, values) {
  const c = headers.indexOf('מזהה');
  if (c < 0) return;
  values.forEach((r, i) => {
    if (r.some(x => x !== '') && !r[c]) {
      r[c] = newId();
      sh.getRange(i + 2, c + 1).setValue(r[c]);
    }
  });
}

function addRow(table, row) {
  const sh = sheetFor(table);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(h => String(h).trim());
  row['מזהה'] = newId();
  // a leading = + - @ would turn the text into a formula
  const values = headers.map(h => {
    const v = row[h] == null ? '' : String(row[h]).slice(0, 2000);
    return /^[=+\-@]/.test(v) ? "'" + v : v;
  });
  sh.appendRow(values);
  return row;
}

function deleteRow(table, id) {
  if (!id) return false;
  const sh = sheetFor(table);
  const values = sh.getDataRange().getDisplayValues();
  const c = values[0].map(h => String(h).trim()).indexOf('מזהה');
  for (let i = values.length - 1; i >= 1; i--) {
    if (values[i][c] === id) { sh.deleteRow(i + 1); return true; }
  }
  return false;
}

function newId() {
  return Utilities.getUuid().slice(0, 8);
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- fill a row from a confirmation email (edit password only) ---------- */
// Returns only the extracted fields, never the email body. The app shows them in the form for review.

/** Run once from the editor after pasting this version, to approve reading Gmail. */
function authorizeGmail() {
  GmailApp.search('in:inbox', 0, 1);
}

function fromEmail(table, subject) {
  if (!PARSERS[table]) throw new Error('unknown table');
  subject = String(subject || '').replace(/["\\]/g, ' ').trim();
  if (subject.length < 4) throw new Error('subject too short');
  const threads = GmailApp.search('subject:"' + subject + '"', 0, 5);
  let msg = null;
  threads.forEach(t => t.getMessages().forEach(m => { if (!msg || m.getDate() > msg.getDate()) msg = m; }));
  if (!msg) return { found: false };
  const text = (msg.getPlainBody() || '').replace(/\r/g, '').replace(/[ \t\u00a0\u200f\u200e]+/g, ' ');
  const info = {
    subject: msg.getSubject(),
    from: msg.getFrom(),
    date: Utilities.formatDate(msg.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd'),
  };
  const raw = PARSERS[table](text, info);
  const fields = {};
  Object.keys(raw).forEach(k => { const v = String(raw[k] || '').trim(); if (v) fields[k] = v.slice(0, 200); });
  return { found: true, email: info, fields: fields };
}

// value after "Label:" (same line), or on the line after a label that stands alone
function after(text, labels) {
  for (let i = 0; i < labels.length; i++) {
    const m = text.match(new RegExp('(?:' + labels[i] + ')\\s*[:：]\\s*([^\\n]+)', 'i'));
    if (m && m[1].trim()) return m[1].trim();
  }
  for (let i = 0; i < labels.length; i++) {
    const m = text.match(new RegExp('(?:^|\\n)\\s*(?:' + labels[i] + ')\\s*\\n\\s*([^\\n]+)', 'i'));
    if (m && m[1].trim()) return m[1].trim();
  }
  return '';
}
function first(text, re, group) { const m = text.match(re); return m ? (m[group || 1] || '').trim() : ''; }
function phoneIn(s) { return first(s || '', /(\+?\d[\d\s().-]{6,}\d)/); }
function senderName(from) { return String(from || '').replace(/<[^>]*>/, '').replace(/["']/g, '').trim(); }
const CONF = '(?:booking number|booking reference|booking code|confirmation number|confirmation code|reservation number|reservation code|record locator|PNR|מספר (?:ה)?הזמנה|מספר אישור|קוד (?:ה)?הזמנה)';
const DATE = '(\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[./]\\d{1,2}[./]\\d{2,4}|\\d{1,2} [A-Za-z\\u0590-\\u05FF]{3,9}\\.? \\d{4}|[A-Za-z]{3,9}\\.? \\d{1,2},? \\d{4})';

const PARSERS = {
  hotels: (t, info) => ({
    'שם': first(info.subject, /(?:confirmed at|reservation at|booking at|stay at)\s+(.+?)(?:[.!]|$)/i)
      || first(info.subject, /(?:במלון |ב-?)(.+?)\s+(?:אושרה|מאושרת|אושר)/)
      || after(t, ['Property', 'Hotel name', 'Hotel', 'שם המלון', 'מקום האירוח']),
    'כתובת': after(t, ['Address', 'Location', 'כתובת']),
    'טלפון': phoneIn(after(t, ['Phone', 'Telephone', 'Tel', 'טלפון'])),
    "צ'ק-אין": after(t, ['Check-in', 'Check in', 'Arrival', 'צ׳ק-אין', "צ'ק-אין", 'צ׳ק אין', 'הגעה']),
    "צ'ק-אאוט": after(t, ['Check-out', 'Check out', 'Departure', 'צ׳ק-אאוט', "צ'ק-אאוט", 'צ׳ק אאוט', 'עזיבה']),
    'מחיר': after(t, ['Total price', 'Total amount', 'Price', 'מחיר כולל', 'סה"כ', 'סך הכל', 'מחיר']),
    'ביטול עד': after(t, ['Free cancellation until', 'Free cancellation before', 'cancel for free until', 'ביטול ללא תשלום עד', 'ביטול חינם עד'])
      || first(t, /(?:free cancellation|cancel for free)\s+(?:until|before)\s+([^\n]+)/i)
      || first(t, /ביטול (?:ללא תשלום|חינם)\s+עד\s+([^\n]+)/),
    '🔒 מספר הזמנה': first(t, new RegExp(CONF + '\\s*[:：]?\\s*([A-Z0-9][A-Z0-9.\\-]{4,19})', 'i')),
  }),
  flights: (t, info) => {
    const route = t.match(/\b([A-Z]{3})\s*(?:-|–|→|>|to)\s*([A-Z]{3})\b/) || [];
    const codes = (t.match(/\(([A-Z]{3})\)/g) || []).map(c => c.slice(1, 4));
    const times = t.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/g) || [];
    return {
      'תאריך': first(t, new RegExp(DATE)),
      'מספר טיסה': first(t, /(?:flight|טיסה)\s*(?:no\.?|number|מספר|#)?\s*[:：]?\s*([A-Z0-9]{2} ?\d{2,4})\b/i)
        || first(t, /\b([A-Z]{2} ?\d{3,4})\b/),
      'מ-': route[1] || codes[0] || '',
      'ל-': route[2] || codes.filter(c => c !== codes[0])[0] || '',
      'המראה': times[0] || '',
      'נחיתה': times[1] || '',
      '🔒 קוד הזמנה': first(t, new RegExp(CONF + '\\s*[:：]?\\s*([A-Z0-9]{5,8})\\b', 'i')),
    };
  },
  cars: (t, info) => ({
    'חברה': senderName(info.from),
    'איסוף': after(t, ['Pick-up', 'Pickup', 'Pick up', 'איסוף']),
    'החזרה': after(t, ['Drop-off', 'Dropoff', 'Drop off', 'Return', 'החזרה']),
    'ביטוח': after(t, ['Insurance', 'Coverage', 'ביטוח']),
    'טלפון': phoneIn(after(t, ['Phone', 'Telephone', 'Tel', 'טלפון'])),
    '🔒 מספר הזמנה': first(t, new RegExp(CONF + '\\s*[:：]?\\s*([A-Z0-9][A-Z0-9.\\-]{4,19})', 'i')),
  }),
};
