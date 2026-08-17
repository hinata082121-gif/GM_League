/**
 * seed.gs — テストデータ投入（GAS エディタから手動実行する）
 *
 * ▶ 使い方
 *   GAS エディタの関数選択プルダウンで seedTestData を選び「実行」。
 *   実行ログに投入件数が出る。既に同じデータがある場合はスキップする。
 *
 * ▶ 取り消し
 *   clearTestData を実行すると、このファイルで投入した行だけを削除する。
 *   判定は ID の接頭辞（SEED_PREFIX）で行うため、本番データには触れない。
 *
 * ⚠️ ここに書かれた選手名・所属クラブはあくまで動作確認用の暫定値。
 *    本番の全選手データは importPlayersCsv（CSV一括登録）で投入する。
 *    チーム名は仮名なので、実際の大会チーム名が決まったら差し替えること。
 *
 * ⚠️ 金額は Config シートの seed_initial_budget を参照する。
 *    Config に無ければ SEED_DEFAULT_BUDGET で自動追加してから使う。
 */

// =============================================================================
// 定数
// =============================================================================

/** 投入した行を後から識別するための ID 接頭辞 */
var SEED_PREFIX = "seed_";

/** Config に seed_initial_budget が無い場合に登録する初期値 */
var SEED_DEFAULT_BUDGET = 1000000000;

/** テスト用シーズン ID */
var SEED_SEASON_ID = "seed_s1";

// =============================================================================
// エントリポイント
// =============================================================================

/**
 * テストデータ一式を投入する。
 * シーズン1件・チーム3件・選手15件・スカッド15件・初期予算3件。
 */
function seedTestData() {
  Logger.log("=== seedTestData 開始 ===");

  var budget = _ensureSeedBudgetConfig();
  Logger.log("初期予算（Config: seed_initial_budget）: " + budget);

  var season = _seedSeason();
  var teams = _seedTeams();
  var players = _seedPlayers();
  var rosters = _seedRosters(teams, players);
  var tx = _seedBudget(teams, budget);

  Logger.log("----------------------------------------");
  Logger.log("Seasons  : 追加 " + season.added + " / スキップ " + season.skipped);
  Logger.log("Teams    : 追加 " + teams.added + " / スキップ " + teams.skipped);
  Logger.log("Players  : 追加 " + players.added + " / スキップ " + players.skipped);
  Logger.log("Rosters  : 追加 " + rosters.added + " / スキップ " + rosters.skipped);
  Logger.log("BudgetTx : 追加 " + tx.added + " / スキップ " + tx.skipped);
  Logger.log("=== seedTestData 完了 ===");
}

/**
 * seedTestData で投入した行をすべて削除する。
 * ID が SEED_PREFIX で始まる行のみが対象。
 */
function clearTestData() {
  Logger.log("=== clearTestData 開始 ===");

  var targets = [
    { sheet: "BudgetTx",  pk: "tx_id" },
    { sheet: "Rosters",   pk: "roster_id" },
    { sheet: "Players",   pk: "player_id" },
    { sheet: "Teams",     pk: "team_id" },
    { sheet: "Seasons",   pk: "season_id" },
  ];

  targets.forEach(function (t) {
    var removed = _deleteRowsByPrefix(t.sheet, t.pk, SEED_PREFIX);
    Logger.log(t.sheet + ": " + removed + " 行削除");
  });

  Logger.log("=== clearTestData 完了 ===");
}

// =============================================================================
// 各シートの投入処理
// =============================================================================

/**
 * Config に seed_initial_budget が無ければ追加し、値を返す。
 *
 * @returns {number}
 */
function _ensureSeedBudgetConfig() {
  clearConfigCache();
  var existing = findRow("Config", "key", "seed_initial_budget");
  if (!existing) {
    appendRow("Config", { key: "seed_initial_budget", value: SEED_DEFAULT_BUDGET });
    clearConfigCache();
    Logger.log("Config に seed_initial_budget を追加しました。");
  }
  return getConfigNum("seed_initial_budget", SEED_DEFAULT_BUDGET);
}

/**
 * テスト用シーズンを1件投入する。
 *
 * @returns {{ added: number, skipped: number }}
 */
function _seedSeason() {
  if (findRow("Seasons", "season_id", SEED_SEASON_ID)) {
    return { added: 0, skipped: 1 };
  }

  var base = new Date();
  var w1 = new Date(base.getTime() + 7 * 24 * 60 * 60 * 1000);
  var w2 = new Date(base.getTime() + 28 * 24 * 60 * 60 * 1000);

  appendRow("Seasons", {
    season_id:       SEED_SEASON_ID,
    name:            "テストシーズン1",
    status:          "準備中",
    leg_enabled:     true,
    window1_open_at: w1,
    window2_open_at: w2,
    created_at:      base,
  });

  return { added: 1, skipped: 0 };
}

/**
 * テスト用チームを3件投入する。
 * チーム名は仮名。実際の大会チーム名が決まったら差し替える。
 *
 * @returns {{ added: number, skipped: number, ids: string[] }}
 */
function _seedTeams() {
  var defs = [
    { team_id: SEED_PREFIX + "t1", name: "テストユナイテッド", kind: "新規" },
    { team_id: SEED_PREFIX + "t2", name: "テストローバーズ",   kind: "新規" },
    { team_id: SEED_PREFIX + "t3", name: "テストアスレチック", kind: "新規" },
  ];

  var added = 0;
  var skipped = 0;

  defs.forEach(function (d) {
    if (findRow("Teams", "team_id", d.team_id)) {
      skipped++;
      return;
    }
    appendRow("Teams", {
      team_id:       d.team_id,
      name:          d.name,
      owner_user_id: "",
      kind:          d.kind,
      active:        true,
    });
    added++;
  });

  return {
    added: added,
    skipped: skipped,
    ids: defs.map(function (d) { return d.team_id; }),
  };
}

/**
 * テスト用の選手データ定義を返す。
 * GK2 / DF4 / MF6 / FW3 の計15名。
 *
 * ⚠️ real_club は動作確認用の暫定値。本番投入時は CSV で正しい値に置き換える。
 *
 * @returns {Array<{id: string, name: string, position: string, club: string}>}
 */
function _seedPlayerDefs() {
  return [
    { id: "p01", name: "スベンド・ブローダーセン", position: "GK", club: "川崎フロンターレ" },
    { id: "p02", name: "ペドロ・ホマーノ",         position: "GK", club: "川崎フロンターレ" },

    { id: "p03", name: "三浦颯太",   position: "DF", club: "川崎フロンターレ" },
    { id: "p04", name: "佐々木旭",   position: "DF", club: "川崎フロンターレ" },
    { id: "p05", name: "山原怜音",   position: "DF", club: "川崎フロンターレ" },
    { id: "p06", name: "谷口栄斗",   position: "DF", club: "川崎フロンターレ" },

    { id: "p07", name: "山本悠樹",   position: "MF", club: "川崎フロンターレ" },
    { id: "p08", name: "橘田健人",   position: "MF", club: "川崎フロンターレ" },
    { id: "p09", name: "紺野和也",   position: "MF", club: "川崎フロンターレ" },
    { id: "p10", name: "脇坂泰斗",   position: "MF", club: "川崎フロンターレ" },
    { id: "p11", name: "伊藤達哉",   position: "MF", club: "川崎フロンターレ" },
    { id: "p12", name: "持山匡佑",   position: "MF", club: "川崎フロンターレ" },

    { id: "p13", name: "マルシーニョ",         position: "FW", club: "川崎フロンターレ" },
    { id: "p14", name: "ラザル・ロマニッチ",   position: "FW", club: "川崎フロンターレ" },
    { id: "p15", name: "エリソン",             position: "FW", club: "ジェフユナイテッド千葉" },
  ];
}

/**
 * テスト用選手を投入する。
 *
 * @returns {{ added: number, skipped: number, ids: string[] }}
 */
function _seedPlayers() {
  var defs = _seedPlayerDefs();
  var added = 0;
  var skipped = 0;
  var ids = [];

  defs.forEach(function (d) {
    var pid = SEED_PREFIX + d.id;
    ids.push(pid);

    if (findRow("Players", "player_id", pid)) {
      skipped++;
      return;
    }
    appendRow("Players", {
      player_id: pid,
      name:      d.name,
      position:  d.position,
      real_club: d.club,
      eligible:  true,
    });
    added++;
  });

  return { added: added, skipped: skipped, ids: ids };
}

/**
 * 選手を3チームに5人ずつ割り当てて Rosters に登録する。
 * acquisition_type は「初期」、acquired_cost は 0。
 *
 * @param {{ ids: string[] }} teams
 * @param {{ ids: string[] }} players
 * @returns {{ added: number, skipped: number }}
 */
function _seedRosters(teams, players) {
  var added = 0;
  var skipped = 0;
  var stamp = new Date();

  players.ids.forEach(function (pid, idx) {
    var teamId = teams.ids[idx % teams.ids.length];
    var rosterId = SEED_PREFIX + "r_" + pid.replace(SEED_PREFIX, "");

    if (findRow("Rosters", "roster_id", rosterId)) {
      skipped++;
      return;
    }

    appendRow("Rosters", {
      roster_id:        rosterId,
      season_id:        SEED_SEASON_ID,
      team_id:          teamId,
      player_id:        pid,
      acquisition_type: "初期",
      acquired_cost:    0,
      acquired_at:      stamp,
      expires_season:   "",
      status:           "在籍",
    });
    added++;
  });

  return { added: added, skipped: skipped };
}

/**
 * 各チームに初期予算の BudgetTx を1件ずつ計上する。
 *
 * SPEC.md §3 原則3 に従い、残高カラムは作らず取引として記録する。
 * reason は既存 enum の「スポンサー収益」を流用する。
 *
 * @param {{ ids: string[] }} teams
 * @param {number} amount
 * @returns {{ added: number, skipped: number }}
 */
function _seedBudget(teams, amount) {
  var added = 0;
  var skipped = 0;
  var stamp = new Date();

  teams.ids.forEach(function (teamId) {
    var txId = SEED_PREFIX + "tx_" + teamId.replace(SEED_PREFIX, "");

    if (findRow("BudgetTx", "tx_id", txId)) {
      skipped++;
      return;
    }

    appendRow("BudgetTx", {
      tx_id:      txId,
      season_id:  SEED_SEASON_ID,
      team_id:    teamId,
      amount:     amount,
      reason:     "スポンサー収益",
      ref:        "seedTestData",
      created_at: stamp,
    });
    added++;
  });

  return { added: added, skipped: skipped };
}

// =============================================================================
// 削除ヘルパ
// =============================================================================

/**
 * 指定カラムの値が prefix で始まる行をすべて削除する。
 * 下の行から削除して行番号のズレを避ける。
 *
 * @param {string} sheetName
 * @param {string} pkColumn
 * @param {string} prefix
 * @returns {number} 削除した行数
 */
function _deleteRowsByPrefix(sheetName, pkColumn, prefix) {
  var sheet = getSheet(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var pkIdx = headers.indexOf(pkColumn);
  if (pkIdx === -1) return 0;

  var removed = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    var val = String(values[i][pkIdx] || "");
    if (val.indexOf(prefix) === 0) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }

  return removed;
}
