const fs = require('fs');
const vm = require('vm');
const path = require('path');

const GAS = path.join(__dirname, '..', 'gas');

function makeSheet(name, headers) {
  return { name, values: [headers.slice()] };
}

function createEnv(sheets, config) {
  const store = {};
  Object.keys(sheets).forEach((n) => { store[n] = makeSheet(n, sheets[n]); });

  const sheetObj = (s) => ({
    getLastColumn: () => s.values[0].length,
    getLastRow: () => s.values.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < (nr || 1); i++) {
          const row = s.values[r - 1 + i] || [];
          out.push(row.slice(c - 1, c - 1 + (nc || 1)));
        }
        return out;
      },
      setValue: (v) => { 
        while (s.values.length < r) s.values.push(new Array(s.values[0].length).fill(''));
        s.values[r - 1][c - 1] = v; 
      },
      setValues: (vals) => {
        vals.forEach((row, i) => {
          while (s.values.length < r + i) s.values.push(new Array(s.values[0].length).fill(''));
          row.forEach((v, j) => { s.values[r - 1 + i][c - 1 + j] = v; });
        });
      },
      setFontWeight: () => {}, setBackground: () => {}, setFontColor: () => {},
      setFontSize: () => {},
    }),
    getDataRange: () => ({
      getValues: () => s.values.map((r) => r.slice()),
    }),
    appendRow: (row) => { s.values.push(row.slice()); },
    autoResizeColumns: () => {}, setFrozenRows: () => {},
    deleteRow: (i) => { s.values.splice(i - 1, 1); },
    deleteRows: (i, n) => { s.values.splice(i - 1, n); },
  });

  const ctx = {
    SPREADSHEET_ID: 'test',
    console,
    Logger: { log: () => {} },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (n) => (store[n] ? sheetObj(store[n]) : null),
        insertSheet: (n) => { store[n] = makeSheet(n, []); return sheetObj(store[n]); },
        getSheets: () => Object.keys(store).map((n) => sheetObj(store[n])),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => 'uuid' + (ctx.__n = (ctx.__n || 0) + 1),
      // 引用符なしの素朴な CSV だけ扱う。テストで使うのはその形だけ
      parseCsv: (s) => String(s)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split(',')),
    },
    UrlFetchApp: { fetch: () => { throw new Error('network in test'); } },
    ContentService: { createTextOutput: (t) => ({ setMimeType: () => t }), MimeType: { JSON: 'json' } },
    __store: store,
    __tokens: {},
  };
  ctx.global = ctx;
  vm.createContext(ctx);

  const load = (f) => vm.runInContext(fs.readFileSync(path.join(GAS, f), 'utf8'), ctx, { filename: f });
  ['lib.gs', 'config.gs', 'auth.gs', 'api_master.gs', 'api_entry.gs', 'api_transfer.gs',
   'api_protection.gs', 'api_match.gs', 'api_stats.gs', 'api_season.gs', 'api_division.gs',
   'api_signup.gs', 'api_public.gs', 'api_realtransfer.gs', 'api_claims.gs',
   'api_schedule.gs', 'api_manager.gs', 'api_sponsor.gs', 'api_import.gs',
   'api_search.gs', 'api_ui.gs',
   'seed.gs', 'Code.gs'].forEach(load);

  // トークン検証を差し替える（ネットワークを使わない）
  vm.runInContext(`
    _verifyToken = function (token) { return __tokens[token] || null; };
    getConfig = function (key, def) {
      var c = ${JSON.stringify(config)};
      return c.hasOwnProperty(key) ? c[key] : def;
    };
    getConfigNum = function (key, def) { var v = getConfig(key, def); return Number(v) || 0; };
  `, ctx);

  ctx.__addRow = (sheet, obj) => {
    const s = store[sheet];
    s.values.push(s.values[0].map((h) => (obj[h] !== undefined ? obj[h] : '')));
  };
  ctx.__rows = (sheet) => store[sheet].values;

  return ctx;
}

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(name + ' → ' + e.message); }
}
function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || '') + ' expected ' + sb + ' got ' + sa);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function report(label) {
  console.log(`${label}: ${pass} passed, ${fail} failed`);
  failures.forEach((f) => console.log('  ✗ ' + f));
  if (fail) process.exit(1);
}
module.exports = { createEnv, t, eq, ok, report };
