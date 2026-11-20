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
