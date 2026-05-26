/**
 * setupSheets.gs — 全シートをヘッダー付きで一括作成
 *
 * 役割:
 *   - Google Sheets に SPEC.md §4 で定義された14シートを作成する
 *   - 各シートの1行目にヘッダーを書き込む
 *   - Config シートに初期値（SPEC.md §12）を書き込む
 *
 * 使い方:
 *   GAS エディタ（または clasp push 後）でこのスクリプトを開き、
 *   setupAllSheets() を手動実行する（初期セットアップ時に1回だけ実行）。
 *
 * ⚠️ 既存シートは上書きせず、存在しないシートのみ作成する。
 *    ヘッダーが変わった場合は手動で修正するか、シートを削除して再実行。
 */

/**
 * 全14シートを作成し、ヘッダーと Config 初期値を書き込む。
 * GAS エディタから手動実行する。
 */
function setupAllSheets() {
  Logger.log("=== GM_League シートセットアップ開始 ===");

  var sheetDefs = _getSheetDefinitions();
  sheetDefs.forEach(function (def) {
    _createSheetIfNotExists(def.name, def.headers);
  });

  // Config シートの初期値を書き込む
  setupConfig();

  Logger.log("=== セットアップ完了 ===");
}

// ---------------------------------------------------------------------------
// シート定義（SPEC.md §4）
// ---------------------------------------------------------------------------

/**
 * 全シートの名前とヘッダー配列を返す。
 * SPEC.md §4 のデータモデルと1対1で対応する。
 *
 * @returns {Array<{ name: string, headers: string[] }>}
 */
function _getSheetDefinitions() {
  return [
    {
      // §4.1 Users
      name: "Users",
      headers: ["user_id", "email", "display_name", "role", "team_id"],
    },
    {
      // §4.2 Seasons
      name: "Seasons",
      headers: [
        "season_id", "name", "status", "leg_enabled",
        "window1_open_at", "window2_open_at", "created_at",
      ],
    },
    {
      // §4.3 Teams
      name: "Teams",
      headers: ["team_id", "name", "owner_user_id", "kind", "active"],
    },
    {
      // §4.4 Players
      name: "Players",
      headers: ["player_id", "name", "position", "real_club", "eligible"],
    },
    {
      // §4.5 Rosters
      name: "Rosters",
      headers: [
        "roster_id", "season_id", "team_id", "player_id",
        "acquisition_type", "acquired_cost", "acquired_at",
        "expires_season", "status",
      ],
    },
    {
      // §4.6 EntryLists
      name: "EntryLists",
      headers: ["season_id", "team_id", "count", "submitted_at", "status"],
    },
    {
      // §4.7 Transfers
      // ⚠️ cost_to_buyer と payout_to_seller は別カラム（SPEC.md §3 原則4）
      name: "Transfers",
      headers: [
        "transfer_id", "season_id", "window", "player_id",
        "from_team", "to_team", "method",
        "gross_fee", "cost_to_buyer", "payout_to_seller",
        "registered_at", "status",
      ],
    },
    {
      // §4.8 Protections
      name: "Protections",
      headers: [
        "protection_id", "season_id", "window", "team_id",
        "player_id", "tier", "fee", "set_at",
      ],
    },
    {
      // §4.9 BudgetTx
      // ⚠️ 残高カラムは持たない。SUM で算出する（SPEC.md §3 原則3）
      name: "BudgetTx",
      headers: [
        "tx_id", "season_id", "team_id",
        "amount", "reason", "ref", "created_at",
      ],
    },
    {
      // §4.10 Matches
      name: "Matches",
      headers: [
        "match_id", "season_id", "stage", "round",
        "tie_id", "leg",
        "home_team", "away_team",
        "home_score", "away_score",
        "home_pk", "away_pk",
        "status", "reported_by",
      ],
    },
    {
      // §4.11 MatchGoals
      name: "MatchGoals",
      headers: ["match_id", "team_id", "scorer_id", "assist_id"],
    },
    {
      // §4.12 MatchTeamStats
      name: "MatchTeamStats",
      headers: ["match_id", "team_id", "shots", "shots_on_target"],
    },
    {
      // §4.13 MatchGKStats
      name: "MatchGKStats",
      headers: ["match_id", "team_id", "gk_player_id", "saves"],
    },
    {
      // §4.14 Config — key/value 形式
      name: "Config",
      headers: ["key", "value"],
    },
  ];
}

// ---------------------------------------------------------------------------
// Config 初期値（SPEC.md §12）
// ---------------------------------------------------------------------------

/**
 * Config シートに初期値を書き込む。
 * 既にデータが存在する場合はスキップする（上書きしない）。
 */
function setupConfig() {
  var sheet = getSheet("Config");
  var existing = getSheetData("Config");

  // 既存の key をセットに入れる
  var existingKeys = {};
  existing.forEach(function (row) { existingKeys[row.key] = true; });

  // SPEC.md §12 の初期値
  var initialConfig = [
    // 賞金（未定のため仮値 0 ）
    ["season_prize",              0,          "シーズン賞金"],
    ["rank_prize_1",              0,          "順位賞金1位"],
    ["rank_prize_2",              0,          "順位賞金2位"],
    ["top_scorer_prize",          0,          "得点王保持チーム賞金"],
    // 特別ルール固定コスト
    ["special_w1",                250000000,  "特別 第1次市場"],
    ["special_w2",                300000000,  "特別 第2次市場"],
    ["special_w1_discount",       200000000,  "特別 第1次 割引（最終日22:00-23:30）"],
    ["special_w2_discount",       225000000,  "特別 第2次 割引（最終日22:00-23:30）"],
    ["override_w1",               350000000,  "無効化特別 第1次"],
    ["override_w2",               400000000,  "無効化特別 第2次"],
    // 移籍受取率
    ["seller_rate_normal",        0.90,       "通常移籍の売却受取率"],
    ["seller_rate_override",      0.70,       "無効化特別の売却受取率"],
    // プロテクト料
    ["protect_fee_1",             30000000,   "有料プロテクト1枠目"],
    ["protect_fee_2",             40000000,   "有料プロテクト2枠目"],
    ["protect_fee_3",             50000000,   "有料プロテクト3枠目"],
    // 補填率
    ["compensation_rate_transfer", 0.80,      "大会外移籍 補填率"],
    ["compensation_rate_withdrawal", 0.90,    "辞退 補填率"],
    // シーズン終了手数料
    ["season_end_fee_rate",       0.10,       "シーズン終了手数料率"],
    // スカッド制約
    ["squad_min",                 22,         "スカッド最小人数"],
    ["squad_max",                 35,         "スカッド最大人数"],
    ["new_team_entry_count",      28,         "新規チームのエントリー人数"],
    // 割引時間帯
    ["discount_start",            "22:00",    "最終日割引開始時刻"],
    ["discount_end",              "23:30",    "最終日割引終了時刻"],
    // プロテクト枠数
    ["free_protect_count",        2,          "無料プロテクト枠数"],
    ["paid_protect_count",        3,          "有料プロテクト枠数"],
  ];

  var added = 0;
  initialConfig.forEach(function (entry) {
    var key = entry[0];
    if (!existingKeys[key]) {
      sheet.appendRow([key, entry[1]]); // key, value のみ（コメントはシートに書かない）
      added++;
      Logger.log("[setupConfig] 追加: " + key + " = " + entry[1]);
    } else {
      Logger.log("[setupConfig] スキップ（既存）: " + key);
    }
  });

  Logger.log("[setupConfig] " + added + " 件追加しました。");
}

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

/**
 * シートが存在しない場合のみ作成し、1行目にヘッダーを書き込む。
 * 既存シートは触らない。
 *
 * @param {string} name    - シート名
 * @param {string[]} headers - ヘッダー配列
 */
function _createSheetIfNotExists(name, headers) {
  var ss = getSpreadsheet();
  var existing = ss.getSheetByName(name);

  if (existing) {
    Logger.log("[setup] スキップ（既存）: " + name);
    return;
  }

  var sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // ヘッダー行を太字・背景色で見やすくする（任意）
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight("bold");
  headerRange.setBackground("#e8f0fe");

  Logger.log("[setup] 作成: " + name + " (" + headers.join(", ") + ")");
}
