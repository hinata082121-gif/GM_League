/**
 * setupSheets.gs — 全シートをヘッダー付きで一括作成・Config / Clubs 初期値投入
 *
 * ▶ 使い方
 *   1. GAS エディタで関数選択プルダウンから「setupAll」を選んで「実行」
 *   2. 権限承認ダイアログが出たら「許可」→「Googleアカウントを選択」→「許可」
 *   詳細な手順は README.md の「セットアップ手順」を参照。
 *
 * 冪等なので、シートやクラブを追加したいときは何度実行してもよい。
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
 * 全17シートを作成し、Config と Clubs の初期値を投入する。
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

  // --- 既存シートに不足カラムを追加（x_id など後から増えた列）---
  var headerResult = _ensureHeaders(defs);

  // --- Config 初期値投入 ---
  var configResult = _setupConfig();

  // --- Clubs 初期値投入 ---
  var clubResult = _setupClubs();

  // --- 日程表のひな型 投入 ---
  var scheduleResult = _setupScheduleTemplate();

  // --- サマリー表示 ---
  Logger.log("────────────────────────────────────────");
  Logger.log("【作成】 " + results.created.length + " シート: " + (results.created.join(", ") || "なし"));
  Logger.log("【スキップ】 " + results.skipped.length + " シート: " + (results.skipped.join(", ") || "なし"));
  Logger.log("【列追加】 " + (headerResult.added.length ? headerResult.added.join(" / ") : "なし"));
  Logger.log("【Config】 追加 " + configResult.added + " 件 / スキップ " + configResult.skipped + " 件");
  Logger.log("【Clubs】 追加 " + clubResult.added + " 件 / スキップ " + clubResult.skipped + " 件");
  Logger.log("【日程ひな型】 追加 " + scheduleResult.added + " 件 / スキップ " + scheduleResult.skipped + " 件");
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
 * 全21シートの名前・ヘッダー配列・SPEC参照を返す。
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
        "x_id",          // string  X（旧Twitter）のID。@ は付けない
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
        "claim_deadline_at",// datetime  補填の選択期限。翌日に精算する
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
    {
      // §4.16 SeasonTeams ─ シーズンごとのチーム所属ディビジョン
      // 参加チーム数で一部制/二部制が変わるため、Teams ではなくシーズン単位で持つ
      name: "SeasonTeams",
      spec: "SPEC.md §4.16",
      headers: [
        "season_id",  // string
        "team_id",    // string
        "division",   // enum  GM1 / GM2
      ],
    },
    {
      // §4.17 SuperCup ─ スーパーカップの出場チームと配信有無
      // 1シーズンにつき1行。配信料は streamed=true のときだけ支給する
      name: "SuperCup",
      spec: "SPEC.md §4.17",
      headers: [
        "season_id",  // string  主キー
        "team_a",     // string  出場チーム1
        "team_b",     // string  出場チーム2
        "streamed",   // bool    配信を行ったか
        "note",       // string  備考
      ],
    },
    {
      // §4.20 ScheduleTemplate ─ 日程表のひな型（毎シーズン使い回す）
      name: "ScheduleTemplate",
      spec: "SPEC.md §4.20",
      headers: [
        "sort_order",  // number  表示順
        "day_offset",  // number  リーグ戦開幕日を0とした相対日数（開幕前は負）
        "label",       // string  予定の名前
        "note",        // string  補足
      ],
    },
    {
      // §4.21 SeasonSchedule ─ シーズンごとに確定した日程
      name: "SeasonSchedule",
      spec: "SPEC.md §4.21",
      headers: [
        "schedule_id", // string    主キー
        "season_id",   // string
        "date",        // date      実際の日付
        "label",       // string    予定の名前
        "note",        // string    補足
        "sort_order",  // number    同じ日の中での表示順
        "done",        // bool      消化済みか（主催者がチェック）
      ],
    },
    {
      // §4.19 Claims ─ 補填の請求（払い戻し / 入れ替え）
      name: "Claims",
      spec: "SPEC.md §4.19",
      headers: [
        "claim_id",       // string  主キー
        "season_id",      // string  この請求が属するシーズン
        "team_id",        // string  補填を受けるチーム
        "player_id",      // string  使えなくなった選手
        "reason",         // enum    大会外移籍 / 辞退 / チーム変更
        "base_cost",      // number  補填の母数（Rosters.acquired_cost）
        "rate",           // number  補填率（0.8 / 0.9）
        "refund_amount",  // number  払い戻しを選んだ場合の金額
        "choice",         // enum    未選択 / 払い戻し / 入れ替え
        "replacement_id", // string  入れ替えで受け取る選手
        "status",         // enum    選択待ち / 確定 / 精算済 / 無効
        "created_at",     // datetime
        "chosen_at",      // datetime  参加者が選んだ日時
        "chosen_by",      // string    選んだ user_id（主催者代行もありうる）
        "settled_at",     // datetime  精算した日時
      ],
    },
    {
      // §4.18 Signups ─ 参加登録の申請
      name: "Signups",
      spec: "SPEC.md §4.18",
      headers: [
        "signup_id",    // string    主キー
        "email",        // string    Google アカウント email（トークンから取得）
        "display_name", // string    表示名
        "team_name",    // string    希望するチーム名
        "x_id",         // string    X の ID
        "note",         // string    自由記述
        "status",       // enum      申請中 / 承認 / 却下
        "created_at",   // datetime
        "decided_at",   // datetime
        "decided_by",   // string    承認/却下した主催者の user_id
        "team_id",      // string    承認時に作られたチームの team_id
      ],
    },
    {
      // §4.15 Clubs ─ 現実のJリーグクラブ一覧
      // 選手登録画面の「カテゴリー→クラブ」2段プルダウンの元データ。
      // 毎シーズンの昇降格はこのシートを直接編集して反映する。
      name: "Clubs",
      spec: "SPEC.md §4.15",
      headers: [
        "category",   // enum    J1 / J2 / J3
        "club_name",  // string  クラブ名（Players.real_club と一致させる）
        "sort_order", // number  表示順
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
    ["signup_code",                 "",          "参加登録の合言葉（空のままだと登録を受け付けない）"],
    ["signup_open",                 false,       "参加登録の受付中フラグ"],
    ["signup_club_categories",      "J1,J2",     "参加登録で選べるクラブのカテゴリ（Clubs には J3 も残す）"],
    ["claim_rate_real_transfer",    0.80,        "補填率（現実移籍）獲得額×80%"],
    ["claim_rate_withdrawal",       0.90,        "補填率（辞退・チーム変更）獲得額×90%"],
    ["claim_default_choice",        "払い戻し",  "期限までに選ばれなかった請求の既定"],
    ["new_team_initial_budget",     0,           "新規参加チームの初期予算。チーム変更のリセット後もこの額になる"],

    ["two_division_min_teams",      15,          "二部制にできる最小チーム数"],

    ["prize_gm1_1div_1",            150000000,   "一部制 GM1リーグ 1位 1.5億"],
    ["prize_gm1_1div_2",            100000000,   "一部制 GM1リーグ 2位 1億"],
    ["prize_gm1_1div_3",            80000000,    "一部制 GM1リーグ 3位 8000万"],
    ["prize_gm1_1div_4",            50000000,    "一部制 GM1リーグ 4位 5000万"],

    ["prize_gm1_2div_1",            200000000,   "二部制 GM1リーグ 1位 2億"],
    ["prize_gm1_2div_2",            150000000,   "二部制 GM1リーグ 2位 1.5億"],
    ["prize_gm1_2div_3",            100000000,   "二部制 GM1リーグ 3位 1億"],
    ["prize_gm1_2div_4",            80000000,    "二部制 GM1リーグ 4位 8000万"],
    ["prize_gm1_2div_5",            50000000,    "二部制 GM1リーグ 5位 5000万"],

    ["prize_gm2_1",                 75000000,    "GM2リーグ 1位 7500万"],
    ["prize_gm2_2",                 55000000,    "GM2リーグ 2位 5500万"],
    ["prize_gm2_3",                 40000000,    "GM2リーグ 3位 4000万"],

    ["prize_cup_1",                 120000000,   "GMリーグ杯 優勝 1.2億"],
    ["prize_cup_2",                 90000000,    "GMリーグ杯 準優勝 9000万"],
    ["prize_cup_semi",              70000000,    "GMリーグ杯 ベスト4 7000万（準決勝敗退の各チームに満額）"],

    ["prize_supercup_1",            30000000,    "GMスーパーカップ 優勝 3000万"],
    ["prize_supercup_2",            20000000,    "GMスーパーカップ 準優勝 2000万"],
    ["supercup_stream_fee",         15000000,    "GMスーパーカップ 配信料 1500万（出場2チームに各額）"],

    ["top_scorer_gm1",              25000000,    "得点王賞金 GM1リーグ 2500万"],
    ["top_scorer_gm2",              15000000,    "得点王賞金 GM2リーグ 1500万"],
    ["top_scorer_cup",              20000000,    "得点王賞金 GMリーグ杯 2000万"],

    // ── 特別ルール固定コスト（§5.3）───────────────────────────────────
    ["special_w1",                  250000000,   "特別ルール 第1次市場 2.5億"],
    ["special_w2",                  300000000,   "特別ルール 第2次市場 3億"],
    ["special_w1_discount",         200000000,   "特別ルール 第1次 最終日割引 2億（22:00-23:00）"],
    ["special_w2_discount",         225000000,   "特別ルール 第2次 最終日割引 2.25億（22:00-23:00）"],
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
    ["discount_end",                "23:00",     "最終日割引 終了時刻（特別ルールのみ）"],

    // ── プロテクト枠数（§6.2）─────────────────────────────────────────
    ["free_protect_count",          2,           "無料プロテクト枠数（移籍市場開幕 前々日まで）"],
    ["paid_protect_count",          3,           "有料プロテクト枠数（移籍市場開幕 前日23時以降）"],
    ["protect_free_before_days",    2,           "無料プロテクトの締切（開幕の何日前の終わりまで）"],
    ["protect_paid_before_days",    1,           "有料プロテクトの開始（開幕の何日前から）"],
    ["protect_paid_start",          "23:00",     "有料プロテクトの開始時刻"],
    ["market_days",                 3,           "移籍市場の日数（有料プロテクトの終了判定に使用）"],
    ["win_points",                  3,           "勝利の勝点"],
    ["draw_points",                 1,           "引き分けの勝点"],
    ["min_matches_for_save_rate",   2,           "シュートセーブ率ランキングの最低出場試合数"],
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

/**
 * 既存シートのヘッダーに不足している列を右端に追加する。
 *
 * _createSheetIfNotExists は既存シートを触らないため、後から列が増えた場合
 * （Users.x_id など）に追随できない。setupAll を再実行するだけで
 * 列が揃うようにするための補助。
 *
 * 列の削除・並べ替えは行わない。既存データは動かさない。
 *
 * @param {Array<{name: string, headers: string[]}>} defs
 * @returns {{ added: string[] }}
 */
function _ensureHeaders(defs) {
  var ss = getSpreadsheet();
  var added = [];

  defs.forEach(function (def) {
    var sheet = ss.getSheetByName(def.name);
    if (!sheet) return;

    var lastCol = sheet.getLastColumn();
    if (lastCol === 0) {
      sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
      added.push(def.name + ": ヘッダー新規");
      return;
    }

    var current = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) {
      return String(v).trim();
    });

    var missing = def.headers.filter(function (h) {
      return current.indexOf(h) === -1;
    });

    if (missing.length === 0) return;

    sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);

    var range = sheet.getRange(1, lastCol + 1, 1, missing.length);
    range.setFontWeight("bold");
    range.setBackground("#e8f0fe");
    range.setFontColor("#1a1a1a");
    range.setFontSize(10);

    added.push(def.name + ": " + missing.join(", "));
    Logger.log("  [header] 列追加 " + def.name + " → " + missing.join(", "));
  });

  return { added: added };
}

// =============================================================================
// Clubs 初期値（2026/27 シーズンの J1・J2・J3 各20クラブ／計60）
// =============================================================================

/**
 * Clubs シートに現実のJリーグ全60クラブを投入する。
 * 既に同じクラブ名がある場合はスキップ（上書きしない）。
 *
 * ⚠️ 昇降格やクラブ名変更があった場合は、このコードを直さず
 *    スプレッドシートの Clubs シートを直接編集して反映すること。
 *
 * @returns {{ added: number, skipped: number }}
 */
function _setupClubs() {
  var sheet = getSheet("Clubs");

  var existing = {};
  getSheetData("Clubs").forEach(function (row) {
    if (row.club_name) existing[String(row.club_name)] = true;
  });

  var defs = _getClubDefinitions();
  var rows = [];
  var skipped = 0;

  defs.forEach(function (d, idx) {
    if (existing[d[1]]) {
      skipped++;
      return;
    }
    rows.push([d[0], d[1], idx + 1]);
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
    Logger.log("  [Clubs] " + rows.length + " 件を書き込みました。");
  }

  return { added: rows.length, skipped: skipped };
}

/**
 * 2026/27 シーズンの全60クラブ定義を返す。
 * 形式は [category, club_name] の配列。
 *
 * @returns {Array<string[]>}
 */
function _getClubDefinitions() {
  return [
    ["J1", "鹿島アントラーズ"],
    ["J1", "水戸ホーリーホック"],
    ["J1", "浦和レッズ"],
    ["J1", "ジェフユナイテッド千葉"],
    ["J1", "柏レイソル"],
    ["J1", "FC東京"],
    ["J1", "東京ヴェルディ"],
    ["J1", "FC町田ゼルビア"],
    ["J1", "川崎フロンターレ"],
    ["J1", "横浜F・マリノス"],
    ["J1", "清水エスパルス"],
    ["J1", "名古屋グランパス"],
    ["J1", "京都サンガF.C."],
    ["J1", "ガンバ大阪"],
    ["J1", "セレッソ大阪"],
    ["J1", "ヴィッセル神戸"],
    ["J1", "ファジアーノ岡山"],
    ["J1", "サンフレッチェ広島"],
    ["J1", "アビスパ福岡"],
    ["J1", "V・ファーレン長崎"],

    ["J2", "北海道コンサドーレ札幌"],
    ["J2", "ヴァンラーレ八戸"],
    ["J2", "ベガルタ仙台"],
    ["J2", "ブラウブリッツ秋田"],
    ["J2", "モンテディオ山形"],
    ["J2", "いわきFC"],
    ["J2", "栃木シティ"],
    ["J2", "RB大宮アルディージャ"],
    ["J2", "横浜FC"],
    ["J2", "湘南ベルマーレ"],
    ["J2", "ヴァンフォーレ甲府"],
    ["J2", "アルビレックス新潟"],
    ["J2", "カターレ富山"],
    ["J2", "ジュビロ磐田"],
    ["J2", "藤枝MYFC"],
    ["J2", "徳島ヴォルティス"],
    ["J2", "FC今治"],
    ["J2", "サガン鳥栖"],
    ["J2", "大分トリニータ"],
    ["J2", "テゲバジャーロ宮崎"],

    ["J3", "福島ユナイテッドFC"],
    ["J3", "栃木SC"],
    ["J3", "ザスパ群馬"],
    ["J3", "SC相模原"],
    ["J3", "松本山雅FC"],
    ["J3", "AC長野パルセイロ"],
    ["J3", "ツエーゲン金沢"],
    ["J3", "FC岐阜"],
    ["J3", "レイラック滋賀FC"],
    ["J3", "FC大阪"],
    ["J3", "奈良クラブ"],
    ["J3", "ガイナーレ鳥取"],
    ["J3", "レノファ山口FC"],
    ["J3", "カマタマーレ讃岐"],
    ["J3", "愛媛FC"],
    ["J3", "高知ユナイテッドSC"],
    ["J3", "ギラヴァンツ北九州"],
    ["J3", "ロアッソ熊本"],
    ["J3", "鹿児島ユナイテッドFC"],
    ["J3", "FC琉球"],
  ];
}

// =============================================================================
// 日程表のひな型（SPEC.md §4.20）
// =============================================================================

/**
 * ScheduleTemplate に既定のひな型を投入する。
 *
 * 既に1件でも行があれば何もしない（主催者が編集した内容を壊さないため）。
 *
 * day_offset は**リーグ戦開幕日を 0** とした相対日数。
 * 開幕前の準備期間は負の数になる。開幕日を決めれば全部の日付が決まる。
 *
 * ⚠️ ここは前シーズンの日程表をそのまま写したもの。
 *    運用しながら「運営・進行 → 日程表のひな型」で調整してよい。
 *    このコードを書き換えても、既に行があるシートには反映されない。
 *
 * ⚠️ 「継続参加者の募集期限」の day_offset だけ仮の値。
 *    実際に何日前に締め切っているかに合わせて画面から直すこと。
 *    他は前シーズン（6/1開幕）の日付から逆算した実績値。
 *
 * @returns {{ added: number, skipped: number }}
 */
function _setupScheduleTemplate() {
  var sheet = getSheet("ScheduleTemplate");

  if (sheet.getLastRow() >= 2) {
    Logger.log("  [日程ひな型] スキップ（既に行があります）");
    return { added: 0, skipped: 1 };
  }

  // [day_offset, label, note]
  // 開幕 = 0。逆算して並べている
  var defs = [
    [-19, "継続参加者の募集期限", "日付は仮。継続の意思確認。返答が無ければ辞退として扱う"],
    [-18, "新規募集終了", "X での募集を締め切る。登録リンクは応募者へ個別に送る"],
    [-17, "使用監督申告開始", ""],
    [-17, "エントリー変更開始", ""],
    [-16, "無料プロテクト開始", ""],
    [-15, "使用監督申告締切＆抽選", "重複した場合は抽選で決める"],
    [-14, "第二次使用監督申告開始", ""],
    [-14, "エントリー変更締切", ""],
    [-13, "第二次使用監督申告締切", ""],
    [-13, "スポンサー申告締切日", ""],
    [-13, "無料プロテクト締切", ""],
    [-12, "無料プロテクト掲示", ""],
    [-11, "開幕前EL提出日", ""],
    [-10, "移籍期間開幕［始］", ""],
    [-10, "エントリー追加選手申告開始", ""],
    [-9,  "エントリー追加選手申告締切", ""],
    [-8,  "移籍期間［終］", ""],
    [-8,  "オークション選手掲示", ""],
    [-7,  "（空き日）", "予備日。処理が重なったときの調整に使う"],
    [-6,  "オークション開始", ""],
    [-5,  "オークション終了", ""],
    [-4,  "EL最終提出日", ""],
    [-3,  "GMスーパーカップ", ""],
    [-2,  "GMスーパーカップ（続き）", ""],
    [-2,  "リーグ戦日程・対戦表 発表日", ""],
    [-1,  "GMスーパーカップ（続き）", ""],
    [0,   "リーグ戦開幕", ""],
  ];

  var rows = defs.map(function (d, i) {
    return [i + 1, d[0], d[1], d[2]];
  });

  sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  Logger.log("  [日程ひな型] " + rows.length + " 件を投入しました。");

  return { added: rows.length, skipped: 0 };
}
