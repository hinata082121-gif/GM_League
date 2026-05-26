/**
 * config.gs — Config シート読み取りヘルパ
 *
 * 役割:
 *   - Google Sheets の Config シート（key/value 形式）を読み取る
 *   - GAS 内の各ハンドラから呼び出して金額・率・人数等を取得する
 *
 * ⚠️ SPEC.md §3 補助原則：
 *    金額・人数・率・時刻はすべてここ経由で取得する。コードへの直書き禁止。
 *
 * Config シートの構造（SPEC.md §4.14 / §12）:
 *   A列: key (string)
 *   B列: value (string or number)
 *
 * 初期値は setupSheets.gs の setupConfig() で書き込まれる。
 */

/** Config をメモリキャッシュ。GAS の実行は短命なので1リクエスト内で使い回す。 */
var _configCache = null;

/**
 * Config シートの全データをオブジェクトとして返す。
 * 1リクエスト内でキャッシュし、2回目以降はシートを叩かない。
 *
 * @returns {Object.<string, string>} { key: value, ... }
 */
function getAllConfig() {
  if (_configCache) return _configCache;

  var data = getSheetData("Config"); // lib.gs
  var cfg = {};
  data.forEach(function (row) {
    if (row.key) cfg[row.key] = row.value;
  });

  _configCache = cfg;
  return cfg;
}

/**
 * 指定した key の値を文字列で返す。
 * key が存在しない場合は defaultValue を返す。
 *
 * @param {string} key
 * @param {string} [defaultValue=""]
 * @returns {string}
 */
function getConfig(key, defaultValue) {
  var cfg = getAllConfig();
  return cfg.hasOwnProperty(key) ? cfg[key] : (defaultValue !== undefined ? defaultValue : "");
}

/**
 * 指定した key の値を数値（Number）で返す。
 * パースに失敗した場合は defaultValue を返す。
 *
 * @param {string} key
 * @param {number} [defaultValue=0]
 * @returns {number}
 */
function getConfigNum(key, defaultValue) {
  var val = getConfig(key);
  var num = Number(val);
  return isNaN(num) ? (defaultValue !== undefined ? defaultValue : 0) : num;
}

/**
 * キャッシュをクリアする。
 * setConfig action 実行後に呼び出して次回再読み込みさせる。
 */
function clearConfigCache() {
  _configCache = null;
}
