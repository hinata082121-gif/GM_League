/**
 * setupSheets.gs — 全シートをヘッダー付きで一括作成・Config 初期値投入
 *
 * ▶ 使い方（初期セットアップ時に1回だけ実行）
 *   1. clasp push でこのファイルを GAS プロジェクトにアップロード
 *   2. GAS エディタで関数選択プルダウンから「setupAll」を選んで「実行」
 *   3. 権限承認ダイアログが出たら「許可」→「Googleアカウントを選択」→「許可」
 *   詳細な手順は README.md の「GAS セットアップ手順」を参照。
 *
 * ⚠️ 既存シートは破壊しない。同名シートがある場合はスキップしてログに記録する。
 *    ヘッダーを変更したい場合はシートを手動削除してから再実行すること。
 *
 * スプレッドシート ID：lib.gs の SPREADSHEET_ID 定数を参照。
 * GAS の全 .gs ファイルはスコープを共有するため、ここで再定義は不要。
 */

// =============================================================================
// エントリポイント（GAS エディタから手動実行する関数）
// =============================================================================

/**
 * 全14シートを作成し、Config 初期値を投入する。
 * GAS エディタで「setupAll」を選択して実行する。
 */
function setupAll() {
  Logger.log("╔══════════════════════════════════════╗");
  Logger.log("║  GM_League シートセットアップ開始    ║");
  Logger.log("╚══════════════════════════════════════╝");
  Logger.log("spreadsheetId: " + SPREADSHEET_ID);

  var results = { created: [], skipped: [], errors: [] };

  // --- シート作成 ---
  var defs = _getSheetDefinitions();
  defs.forEach(function (def) {
    try {
      var created = _createSheetIfNotExists(def.name, def.headers);
      if (created) {
        results.created.push(def.name);
      } else {
        results.skipped.push(def.name);
      }
    } catch (e) {
      results.errors.push(def.name + ": " + e.message);
      Logger.log("[ERROR] " + def.name + ": " + e.message);
    }
  });

  // --- Config 初期値投入 ---
  var configResult = _setupConfig();

  // --- サマリー表示 ---
  Logger.log("────────────────────────────────────────");
  Logger.log("【作成】 " + results.created.length + " シート: " + (results.created.join(", ") || "なし"));
  Logger.log("【スキップ】 " + results.skipped.length + " シート: " + (results.skipped.join(", ") || "なし"));
  Logger.log("【Config】 追加 " + configResult.added + " 件 / スキップ " + configResult.skipped + " 件");
  if (results.errors.length > 0) {
    Logger.log("【エラー】 " + results.errors.join(" / "));
  }
  Logger.log("════════════════════════════════════════");
  Logger.log("セットアップ完了。ログを確認してエラーがないことを確認してください。");
}

// =============================================================================
// シート定義（SPEC.md §4 のデータモデルと1対1対応）
// =============================================================================

/**
 * 全14シートの名前・ヘッダー配列・SPEC参照を返す。
 *
 * カラム名は SPEC.md §4 の表の「カラム」列と完全一致させる。
 * ここを変更した場合は lib.gs の getSheetData / appendRow も影響を受ける。
 *
 * @returns {Array<{name: string, headers: string[], spec: string}>}
 */
function _getSheetDefinitions() {
  return [
    {
      // §4.1 Users ─ ユーザー情報・ロール管理
      name: "Users",
      spec: "SPEC.md §4.1",
      headers: [
        "user_id",       // string  主キー
        "email",         // string  Google アカウント email
        "display_name",  // string  表示名
        "role",          // enum    team / organizer
        "team_id",       // string  role=team の場合の所属チーム
      ],
    },
    {
      // §4.2 Seasons ─ シーズン情報・移籍市場日程
      name: "Seasons",
      spec: "SPEC.md §4.2",
      headers: [
        "season_id",        // string    主キー
        "name",             // string    シーズン名
        "status",           // enum      準備中/エントリー受付/移籍市場1/シーズン1/移籍市場2/シーズン2/トーナメント/終了
        "leg_enabled",      // bool      トーナメント2ndレグ制を使うか
        "window1_open_at",  // datetime  第1次移籍市場 開幕日時
        "window2_open_at",  // datetime  第2次移籍市場 開幕日時
        "created_at",       // datetime
      ],
    },
    {
      // §4.3 Teams ─ チーム情報
      name: "Teams",
      spec: "SPEC.md §4.3",
      headers: [
        "team_id",        // string  主キー
        "name",           // string  チーム名
        "owner_user_id",  // string  オーナーの user_id
        "kind",           // enum    新規 / 継続
        "active",         // bool    大会参加中か
      ],
    },
    {
      // §4.4 Players ─ 選手マスタ（Jリーグ選手）
      name: "Players",
      spec: "SPEC.md §4.4",
      headers: [
        "player_id",  // string  主キー
        "name",       // string  選手名
        "position",   // enum    GK / DF / MF / FW
        "real_club",  // string  現実の所属クラブ（大会外移籍で eligible=false 判定）
        "eligible",   // bool    大会エントリー可否
      ],
    },
    {
      // §4.5 Rosters ─ スカッド在籍履歴
      name: "Rosters",
      spec: "SPEC.md §4.5",
      headers: [
        "roster_id",        // string    主キー
        "season_id",        // string
        "team_id",          // string
        "player_id",        // string
        "acquisition_type", // enum      初期/完全移籍/半期期限付き/全期期限付き/特別/無効化特別/オークション
        "acquired_cost",    // number    獲得時支払額（補填金計算の母数）
        "acquired_at",      // datetime
        "expires_season",   // string    期限切れシーズンID（オークション=当該、半期=期限季、永続は空）
        "status",           // enum      在籍 / 離脱
      ],
    },
    {
      // §4.6 EntryLists ─ エントリーリスト提出状況
      name: "EntryLists",
      spec: "SPEC.md §4.6",
      headers: [
        "season_id",    // string
        "team_id",      // string
        "count",        // number    登録人数（新規=28 / 継続=引継ぎ人数）
        "submitted_at", // datetime
        "status",       // enum      下書き / 提出済 / 承認
      ],
    },
    {
      // §4.7 Transfers ─ 移籍申請・承認履歴
      // ⚠️ SPEC.md §3 原則4：cost_to_buyer と payout_to_seller は必ず別カラム
      //    特別ルール「買い手3億・売り手0円」を1カラムでは表現できないため
      name: "Transfers",
      spec: "SPEC.md §4.7",
      headers: [
        "transfer_id",      // string    主キー
        "season_id",        // string
        "window",           // enum      1 / 2
        "player_id",        // string
        "from_team",        // string    売却側（オークション/初期は空）
        "to_team",          // string    獲得側
        "method",           // enum      完全移籍/半期期限付き/全期期限付き/特別/無効化特別/オークション
        "gross_fee",        // number    交渉額・落札額・固定コスト
        "cost_to_buyer",    // number    獲得側の実支払（§5.4 で算出）
        "payout_to_seller", // number    売却側の受取（§5.4 で算出）
        "registered_at",    // datetime  サーバー時刻（割引時間帯判定に使用）
        "status",           // enum      申請中 / 承認 / 差戻
      ],
    },
    {
      // §4.8 Protections ─ プロテクト設定
      name: "Protections",
      spec: "SPEC.md §4.8",
      headers: [
        "protection_id",  // string    主キー
        "season_id",      // string
        "window",         // enum      1 / 2
        "team_id",        // string
        "player_id",      // string
        "tier",           // enum      無料1 / 無料2 / 有料1 / 有料2 / 有料3
        "fee",            // number    有料時の料金（§5.5）
        "set_at",         // datetime  サーバー時刻（期限ゲート判定に使用）
      ],
    },
    {
      // §4.9 BudgetTx ─ 予算取引履歴
      // ⚠️ SPEC.md §3 原則3：残高カラムは持たない。現保有額は amount の SUM で算出。
      name: "BudgetTx",
      spec: "SPEC.md §4.9",
      headers: [
        "tx_id",      // string    主キー
        "season_id",  // string
        "team_id",    // string
        "amount",     // number    ±（収入は+、支出/減額は−）
        "reason",     // enum      シーズン賞金/スポンサー収益/順位賞金/得点王賞金/
                      //           補填金_大会外移籍/補填金_辞退/移籍金収入/移籍金支出/
                      //           プロテクト料/罰金/シーズン終了手数料
        "ref",        // string    関連 transfer_id / protection_id 等
        "created_at", // datetime
      ],
    },
    {
      // §4.10 Matches ─ 試合記録（申請・承認）
      name: "Matches",
      spec: "SPEC.md §4.10",
      headers: [
        "match_id",    // string    主キー
        "season_id",   // string
        "stage",       // enum      league / tournament
        "round",       // string    節 / ラウンド名
        "tie_id",      // string    2レグを束ねるID（リーグ・単発は空）
        "leg",         // enum      1 / 2 / -
        "home_team",   // string    チームID
        "away_team",   // string    チームID
        "home_score",  // number
        "away_score",  // number
        "home_pk",     // number    PK戦（任意）
        "away_pk",     // number    PK戦（任意）
        "status",      // enum      申請中 / 承認 / 差戻
        "reported_by", // string    申請ユーザーID
      ],
    },
    {
      // §4.11 MatchGoals ─ 得点・アシスト記録
      name: "MatchGoals",
      spec: "SPEC.md §4.11",
      headers: [
        "match_id",   // string  （Matches への FK）
        "team_id",    // string  得点したチーム
        "scorer_id",  // string  得点者 player_id
        "assist_id",  // string  アシスト者 player_id（無ければ空）
      ],
    },
    {
      // §4.12 MatchTeamStats ─ チーム別シュート統計
      name: "MatchTeamStats",
      spec: "SPEC.md §4.12",
      headers: [
        "match_id",        // string
        "team_id",         // string
        "shots",           // number  シュート数
        "shots_on_target", // number  枠内シュート数（GKセーブ率計算の分母）
      ],
    },
    {
      // §4.13 MatchGKStats ─ GK 別セーブ統計
      name: "MatchGKStats",
      spec: "SPEC.md §4.13",
      headers: [
        "match_id",    // string
        "team_id",     // string
        "gk_player_id",// string  起用GK（特例の手打ち追加も可）
        "saves",       // number  セーブ数
      ],
    },
    {
      // §4.14 Config ─ 可変値の一元管理（key/value 2カラム）
      // 金額・人数・率・時刻はすべてここから取得。コードへの直書き禁止（SPEC.md §3 補助原則）
      name: "Config",
      spec: "SPEC.md §4.14",
      headers: [
        "key",   // string  設定キー
        "value", // string  設定値（数値も文字列として格納）
      ],
    },
  ];
}

// =============================================================================
// Config 初期値（SPEC.md §12）
// =============================================================================

/**
 * Config シートに SPEC.md §12 の初期値を投入する。
 * 既に存在する key はスキップ（上書きしない）。
 * 新規追加分はバッチでまとめて appendRows し API 呼び出し回数を最小化する。
 *
 * @returns {{ added: number, skipped: number }}
 */
function _setupConfig() {
  var sheet = getSheet("Config"); // lib.gs

  // 既存 key を収集
  var existingData = getSheetData("Config"); // lib.gs
  var existingKeys = {};
  existingData.forEach(function (row) {
    if (row.key) existingKeys[row.key] = true;
  });

  // SPEC.md §12 の初期値定義
  // [key, value, 備考（ログ表示用）]
  var initialConfig = [
    // ── 賞金（未定のため仮値 0）─────────────────────────────────────────
    ["season_prize",                0,           "シーズン賞金（未定）"],
    ["rank_prize_1",                0,           "順位賞金1位（未定）"],
    ["rank_prize_2",                0,           "順位賞金2位（未定）"],
    ["top_scorer_prize",            0,           "得点王保持チーム賞金（未定）"],

    // ── 特別ルール固定コスト（§5.3）───────────────────────────────────
    ["special_w1",                  250000000,   "特別ルール 第1次市場 2.5億"],
    ["special_w2",                  300000000,   "特別ルール 第2次市場 3億"],
    ["special_w1_discount",         200000000,   "特別ルール 第1次 最終日割引 2億（22:00-23:30）"],
    ["special_w2_discount",         225000000,   "特別ルール 第2次 最終日割引 2.25億（22:00-23:30）"],
    ["override_w1",                 350000000,   "無効化特別ルール 第1次市場 3.5億"],
    ["override_w2",                 400000000,   "無効化特別ルール 第2次市場 4億"],

    // ── 移籍金の売却受取率（§5.4）─────────────────────────────────────
    ["seller_rate_normal",          0.90,        "通常移籍（完全/半期/全期）の売却受取率 90%"],
    ["seller_rate_override",        0.70,        "無効化特別ルールの売却受取率 70%"],

    // ── プロテクト料（§5.5）───────────────────────────────────────────
    ["protect_fee_1",               30000000,    "有料プロテクト1枠目 3000万"],
    ["protect_fee_2",               40000000,    "有料プロテクト2枠目 4000万"],
    ["protect_fee_3",               50000000,    "有料プロテクト3枠目 5000万"],

    // ── 補填率（§5.1）────────────────────────────────────────────────
    ["compensation_rate_transfer",  0.80,        "大会外移籍 補填率 80% (acquired_cost × 80%)"],
    ["compensation_rate_withdrawal",0.90,        "辞退 補填率 90% (acquired_cost × 90%)"],

    // ── シーズン終了手数料（§5.2）─────────────────────────────────────
    ["season_end_fee_rate",         0.10,        "シーズン終了手数料率 10%（残予算×10%を控除）"],

    // ── スカッド人数制約（§6.4）───────────────────────────────────────
    ["squad_min",                   22,          "スカッド最小人数"],
    ["squad_max",                   35,          "スカッド最大人数"],
    ["new_team_entry_count",        28,          "新規チームのエントリー人数"],

    // ── 割引時間帯（§5.3 / §7.4）─────────────────────────────────────
    // GAS 側で "HH:mm" 形式と比較して判定する。クライアント時計は使わない。
    ["discount_start",              "22:00",     "最終日割引 開始時刻（特別ルールのみ）"],
    ["discount_end",                "23:30",     "最終日割引 終了時刻（特別ルールのみ）"],

    // ── プロテクト枠数（§6.2）─────────────────────────────────────────
    ["free_protect_count",          2,           "無料プロテクト枠数（移籍市場開幕 前々日まで）"],
    ["paid_protect_count",          3,           "有料プロテクト枠数（移籍市場開幕 前日23時以降）"],
  ];

  // 新規追加分のみを収集してバッチ書き込み（API 呼び出し1回）
  var newRows = [];
  var skippedCount = 0;

  initialConfig.forEach(function (entry) {
    var key   = entry[0];
    var value = entry[1];
    var note  = entry[2];

    if (existingKeys[key]) {
      Logger.log("  [Config] スキップ（既存）: " + key);
      skippedCount++;
    } else {
      newRows.push([key, value]);
      Logger.log("  [Config] 追加予定: " + key + " = " + value + "  // " + note);
    }
  });

  // バッチ書き込み
  if (newRows.length > 0) {
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow + 1, 1, newRows.length, 2).setValues(newRows);
    Logger.log("[Config] " + newRows.length + " 件をバッチ書き込みしました。");
  }

  return { added: newRows.length, skipped: skippedCount };
}

// =============================================================================
// 内部ユーティリティ
// =============================================================================

/**
 * 同名シートが存在しない場合のみ新規作成し、1行目にヘッダーを書き込む。
 * 既存シートは一切変更しない（破壊的操作なし）。
 *
 * @param {string}   name    シート名
 * @param {string[]} headers ヘッダー配列（SPEC.md §4 のカラム順）
 * @returns {boolean} true=作成した / false=スキップ（既存）
 */
function _createSheetIfNotExists(name, headers) {
  var ss = getSpreadsheet(); // lib.gs — SPREADSHEET_ID を使う

  if (ss.getSheetByName(name)) {
    Logger.log("  [sheet] スキップ（既存）: " + name);
    return false;
  }

  var sheet = ss.insertSheet(name);

  // ヘッダー行を書き込む
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  // ヘッダー行の書式設定（視認性向上）
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setFontWeight("bold");
  headerRange.setBackground("#e8f0fe");   // 薄い青
  headerRange.setFontColor("#1a1a1a");
  headerRange.setFontSize(10);

  // 列幅を自動調整
  sheet.autoResizeColumns(1, headers.length);

  // 先頭行を固定（スクロール時にヘッダーが見える）
  sheet.setFrozenRows(1);

  Logger.log("  [sheet] 作成: " + name + "（" + headers.length + " 列）");
  return true;
}
