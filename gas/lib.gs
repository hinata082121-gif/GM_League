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
 * シート名からシートオブジェクトを返す。
 * 存在しない場合は例外を投げる。
 *
 * @param {string} name - シート名（例: "Users", "Transfers"）
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function getSheet(name) {
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
  var sheet = getSheet(sheetName);
  var values = sheet.getDataRange().getValues();

  if (values.length < 2) return []; // データ行なし

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

  return rows;
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
