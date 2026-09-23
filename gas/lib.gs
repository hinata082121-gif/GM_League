/**
 * lib.gs — Sheets 読み書き共通ヘルパ・LockService ラッパ
 *
 * 役割:
 *   - Google Sheets の読み書きを共通化する
 *   - 1行目をヘッダーとして扱い、オブジェクトの配列で返す
 *   - LockService による書き込みの直列化（同時申請対策）
 *
 * ⚠️ SPEC.md §3 補助原則：
 *    Sheets への書き込みは withLock() でラップして直列化すること。
 *
 * 使用する Spreadsheet ID は GAS プロジェクトのスクリプトプロパティか
 * ハードコーディングで設定する。
 * （フロントの config.js とは別管理。GAS 側の秘密情報はプロパティで持つ方が望ましい）
 */

/** スプレッドシート ID（フロントの config.js と同じ値） */
var SPREADSHEET_ID = "1pi8-gYlKfc_fe_F4iY1idp3fD6lJMzMhW2HbLdQ42aM";

/** スプレッドシートオブジェクトのキャッシュ（1リクエスト内で使い回す） */
var _ss = null;

// ---------------------------------------------------------------------------
// Spreadsheet アクセス
// ---------------------------------------------------------------------------

/**
 * スプレッドシートオブジェクトを返す（キャッシュあり）。
 * @returns {GoogleAppsScript.Spreadsheet.Spreadsheet}
 */
function getSpreadsheet() {
  if (!_ss) {
    _ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  }
  return _ss;
}

/**
 * 1リクエストのあいだ読み取り結果を持っておく入れ物。
 *
 * 同じシートを何度も読み直しているのが表示の遅さの主因だった。
 * 1つの action で Players を5回、Rosters を4回読むような処理が普通にあり、
 * そのたびに Sheets へ往復していた。
 *
 * GAS の実行は1リクエストで終わるので、この変数も毎回空から始まる。
 * シーズンをまたいで古い値が残ることはない。
 */
var _sheetDataCache = {};

/**
 * シート名からシートオブジェクトを返す。存在しない場合は例外。
 *
 * **この関数を呼んだ時点で、そのシートの読み取りキャッシュを捨てる。**
 * 書き込みは必ずここを通ってシートを取るので、
 * 各所の setValues や deleteRow を個別に直さなくても
 * 「書いた直後に読む」処理が古い値を掴まずに済む。
 *
 * 読み取りだけの用途で呼んだ場合はキャッシュが効かなくなるが、
 * 取り違えて壊すよりは無駄に読むほうが安全。
 *
 * @param {string} name - シート名（例: "Users", "Transfers"）
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(name) {
  delete _sheetDataCache[name];
  _sharedCacheBump(name);
  _touchedSheets[name] = true;
  return _sheetHandle(name);
}

// ---------------------------------------------------------------------------
// リクエストをまたぐ読み取りキャッシュ（CacheService）
// ---------------------------------------------------------------------------

/**
 * リクエストをまたいで使い回すシート。
 *
 * **GAS は同時に動ける数に上限があり、1回が遅いと後ろが詰まる。**
 * エントリー変更の期間に参加者が一斉に使い、1回の通信に20〜40秒かかった。
 * 何もしない action ですら18秒待たされたので、処理そのものより順番待ちが主因。
 * 1回あたりの時間を削ると順番待ちも減る。
 *
 * ここに入れるのは**ほぼ全ての通信で読み、めったに書かないもの**だけ。
 * 在籍・予算・移籍・請求のようにお金と保有に関わる表は入れない。
 * 古い値を一瞬でも返すと、二重獲得や残高の誤りにつながるため。
 *
 * ツール経由の書き込みは getSheet を通るので、その場で捨てる。
 * スプレッドシートを直接編集した場合だけ、最大 SHARED_CACHE_TTL 秒古い値が見える。
 */
var SHARED_CACHE_SHEETS = [
  "Users", "Config", "Teams", "Seasons", "Players", "Clubs", "SeasonTeams", "SeasonSchedule",
];
var SHARED_CACHE_TTL = 60;
var SHARED_CACHE_CHUNK = 90000;

/** このリクエストで書き込み用に取ったシート。ロックを外すときにもう一度捨てる */
var _touchedSheets = {};

function _sharedCache() {
  if (typeof CacheService === "undefined") return null;
  try {
    return CacheService.getScriptCache();
  } catch (e) {
    return null;
  }
}

function _isSharedCacheSheet(name) {
  return SHARED_CACHE_SHEETS.indexOf(name) !== -1;
}

/**
 * そのシートのキャッシュを無効にする。版を進めて、古い版の値を使わせない。
 *
 * 版を持つのは、読み手が古い値を読んでいる最中に書き込みが入ったとき、
 * 読み終わった読み手が古い値をキャッシュに戻してしまうのを防ぐため。
 *
 * @param {string} name
 */
function _sharedCacheBump(name) {
  if (!_isSharedCacheSheet(name)) return;
  var cache = _sharedCache();
  if (!cache) return;
  try {
    cache.put("v:" + name, String(new Date().getTime()) + Math.random(), 21600);
  } catch (e) {
    Logger.log("[_sharedCacheBump] " + e.message);
  }
}

/**
 * キャッシュから表の値を取り出す。無い・版が違う・壊れているときは null。
 *
 * @param {string} name
 * @returns {{ version: string, values: Array[]|null }}
 */
function _sharedCacheGet(name) {
  var cache = _sharedCache();
  if (!cache || !_isSharedCacheSheet(name)) return { version: "", values: null };

  try {
    var version = cache.get("v:" + name) || "0";
    var head = cache.get("sd:" + name);
    if (!head) return { version: version, values: null };

    var meta = JSON.parse(head);
    if (meta.v !== version) return { version: version, values: null };

    var keys = [];
    for (var i = 0; i < meta.n; i++) keys.push("sd:" + name + ":" + i);
    var parts = cache.getAll(keys);
    var text = "";
    for (var j = 0; j < keys.length; j++) {
      if (parts[keys[j]] === undefined || parts[keys[j]] === null) {
        return { version: version, values: null };
      }
      text += parts[keys[j]];
    }

    return { version: version, values: _decodeCells(JSON.parse(text)) };
  } catch (e) {
    Logger.log("[_sharedCacheGet] " + e.message);
    return { version: "", values: null };
  }
}

/**
 * 表の値をキャッシュに置く。読み始めから版が変わっていたら置かない。
 *
 * @param {string} name
 * @param {string} version 読み始めたときの版
 * @param {Array[]} values
 */
function _sharedCachePut(name, version, values) {
  var cache = _sharedCache();
  if (!cache || !_isSharedCacheSheet(name) || !version) return;

  try {
    if ((cache.get("v:" + name) || "0") !== version) return;

    var text = JSON.stringify(_encodeCells(values));
    var entries = {};
    var n = 0;
    for (var i = 0; i < text.length; i += SHARED_CACHE_CHUNK) {
      entries["sd:" + name + ":" + n] = text.slice(i, i + SHARED_CACHE_CHUNK);
      n++;
    }
    entries["sd:" + name] = JSON.stringify({ v: version, n: n });
    cache.putAll(entries, SHARED_CACHE_TTL);
  } catch (e) {
    Logger.log("[_sharedCachePut] " + e.message);
  }
}

/**
 * 任意の値を JSON でキャッシュに置く。100KB を超えても分けて置ける。
 *
 * @param {string} key
 * @param {*} value
 * @param {number} ttl 秒
 */
function cachePutJson(key, value, ttl) {
  var cache = _sharedCache();
  if (!cache) return;
  try {
    var text = JSON.stringify(value);
    var entries = {};
    var n = 0;
    for (var i = 0; i < text.length; i += SHARED_CACHE_CHUNK) {
      entries[key + ":" + n] = text.slice(i, i + SHARED_CACHE_CHUNK);
      n++;
    }
    entries[key] = String(n);
    cache.putAll(entries, ttl);
  } catch (e) {
    Logger.log("[cachePutJson] " + e.message);
  }
}

/**
 * cachePutJson で置いた値を取り出す。無ければ null。
 *
 * @param {string} key
 * @returns {*}
 */
function cacheGetJson(key) {
  var cache = _sharedCache();
  if (!cache) return null;
  try {
    var n = parseInt(cache.get(key), 10);
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(key + ":" + i);
    var parts = cache.getAll(keys);
    var text = "";
    for (var j = 0; j < keys.length; j++) {
      if (parts[keys[j]] === undefined || parts[keys[j]] === null) return null;
      text += parts[keys[j]];
    }
    return JSON.parse(text);
  } catch (e) {
    Logger.log("[cacheGetJson] " + e.message);
    return null;
  }
}

/**
 * 日付は JSON にすると文字列になってしまうので、印を付けて保存する。
 * 取り出したときに Date に戻す。呼び出し側の instanceof Date が効くように。
 */
function _encodeCells(values) {
  return values.map(function (row) {
    return row.map(function (v) {
      return v instanceof Date ? { $d: v.getTime() } : v;
    });
  });
}

function _decodeCells(values) {
  return values.map(function (row) {
    return row.map(function (v) {
      return (v && typeof v === "object" && v.$d !== undefined) ? new Date(v.$d) : v;
    });
  });
}

/**
 * シートオブジェクトをキャッシュに触れずに返す。読み取り専用の内部用。
 *
 * @param {string} name
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _sheetHandle(name) {
  var sheet = getSpreadsheet().getSheetByName(name);
  if (!sheet) {
    throw new Error("シートが見つかりません: " + name);
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// 読み取り
// ---------------------------------------------------------------------------

/**
 * シートの全データを「ヘッダーをキーとするオブジェクト配列」で返す。
 * 1行目 = ヘッダー行、2行目以降 = データ行。
 * 空行（全カラムが空文字）はスキップする。
 *
 * @param {string} sheetName
 * @returns {Object[]}
 *
 * @example
 *   // Users シートなら
 *   // [{ user_id: "u1", email: "a@b.com", ... }, ...]
 *   var users = getSheetData("Users");
 */
function getSheetData(sheetName) {
  if (_sheetDataCache.hasOwnProperty(sheetName)) {
    // 配列は複製して渡す。呼び出し側が sort などで並べ替えても
    // 次に読む人へ影響しないようにするため
    return _sheetDataCache[sheetName].slice();
  }

  var shared = _sharedCacheGet(sheetName);
  var values = shared.values;

  if (!values) {
    values = _sheetHandle(sheetName).getDataRange().getValues();
    _sharedCachePut(sheetName, shared.version, values);
  }

  if (values.length < 2) {
    _sheetDataCache[sheetName] = [];
    return []; // データ行なし
  }

  var headers = values[0]; // 1行目がヘッダー
  var rows = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    // 全カラムが空の行はスキップ
    if (row.every(function (v) { return v === "" || v === null || v === undefined; })) continue;

    var obj = {};
    headers.forEach(function (h, idx) {
      obj[h] = row[idx] !== undefined ? row[idx] : "";
    });
    rows.push(obj);
  }

  _sheetDataCache[sheetName] = rows;
  return rows.slice();
}

/**
 * シートから特定カラムの値で行を検索する。
 * 最初にマッチした行のオブジェクトを返す。見つからない場合は null。
 *
 * @param {string} sheetName
 * @param {string} column  - 検索するカラム名（例: "user_id"）
 * @param {*}      value   - 検索値
 * @returns {Object|null}
 */
function findRow(sheetName, column, value) {
  var rows = getSheetData(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][column] == value) return rows[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// 書き込み
// ---------------------------------------------------------------------------

/**
 * シートの末尾に1行追加する。
 * ヘッダー順にカラムを並べて appendRow する。
 *
 * ⚠️ 呼び出し元は必ず withLock() でラップすること（同時書き込み対策）。
 *
 * @param {string} sheetName
 * @param {Object} rowObj - { カラム名: 値, ... } 形式
 */
function appendRow(sheetName, rowObj) {
  var sheet = getSheet(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  var row = headers.map(function (h) {
    var val = rowObj[h];
    return val !== undefined ? val : "";
  });

  sheet.appendRow(row);
}

/**
 * 特定カラムの値が一致する行のオブジェクトを更新する。
 * ヘッダー順に値を書き込む。
 *
 * ⚠️ 呼び出し元は必ず withLock() でラップすること。
 *
 * @param {string} sheetName
 * @param {string} pkColumn  - 検索するカラム名（例: "transfer_id"）
 * @param {*}      pkValue   - 検索値
 * @param {Object} updates   - 更新するカラムと値の辞書（{ status: "承認" } など）
 * @returns {boolean} 更新できた場合 true
 */
function updateRow(sheetName, pkColumn, pkValue, updates) {
  var sheet = getSheet(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;

  var headers = values[0];
  var pkIdx = headers.indexOf(pkColumn);
  if (pkIdx === -1) throw new Error("カラムが見つかりません: " + pkColumn + " in " + sheetName);

  for (var i = 1; i < values.length; i++) {
    if (values[i][pkIdx] == pkValue) {
      Object.keys(updates).forEach(function (key) {
        var colIdx = headers.indexOf(key);
        if (colIdx !== -1) {
          sheet.getRange(i + 1, colIdx + 1).setValue(updates[key]);
        }
      });
      return true;
    }
  }
  return false; // 対象行なし
}

// ---------------------------------------------------------------------------
// LockService ラッパ
// ---------------------------------------------------------------------------

/**
 * スクリプトロック（同一プロジェクト内でのみ有効）を取得し、
 * fn を実行してからロックを解放する。
 *
 * タイムアウトは30秒（GAS の実行時間制限に合わせた設定）。
 * ロック取得に失敗した場合は例外を投げる。
 *
 * ⚠️ SPEC.md §3 補助原則：Sheets への書き込みはここで直列化すること。
 *
 * @param {Function} fn - ロック中に実行する関数
 * @returns {*} fn の戻り値
 *
 * @example
 *   return withLock(function() {
 *     appendRow("Transfers", transferObj);
 *     appendRow("BudgetTx", txObj);
 *     return { ok: true, data: transferObj };
 *   });
 */
function withLock(fn) {
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(30000); // 30秒待つ

  if (!acquired) {
    throw new Error("他のリクエストが処理中です。しばらく待ってから再試行してください。");
  }

  try {
    return fn();
  } finally {
    // 書き込んだ表のキャッシュをもう一度捨てる。書き込みの最中に別の通信が
    // 古い値を読んでキャッシュへ戻していても、ここで無効になる
    Object.keys(_touchedSheets).forEach(_sharedCacheBump);
    _touchedSheets = {};
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// ID 生成ヘルパ
// ---------------------------------------------------------------------------

/**
 * ユニーク ID を生成する。
 * prefix + タイムスタンプ + ランダム文字列の組み合わせ。
 *
 * @param {string} [prefix=""] - 例: "tx", "tr", "pr"
 * @returns {string}
 */
function generateId(prefix) {
  var ts = new Date().getTime().toString(36);
  var rand = Math.random().toString(36).slice(2, 7);
  return (prefix || "") + ts + rand;
}

// ---------------------------------------------------------------------------
// サーバー時刻取得（SPEC.md §3 原則2）
// ---------------------------------------------------------------------------

/**
 * サーバー現在時刻を返す。
 * 時刻判定（プロテクト期限・割引時間帯）はここで取得した値を使う。
 * クライアントから送られた時刻は使わない。
 *
 * @returns {Date}
 */
function now() {
  return new Date();
}
