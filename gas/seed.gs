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
 * seedTestData で投入した行と、テスト中に生まれた派生行をすべて削除する。
 *
 * 判定は2段階:
 *   1. ID が SEED_PREFIX で始まる行（seed が直接作った行）
 *   2. season_id が SEED_SEASON_ID の行（エントリー提出や承認で生まれた行）
 *
 * 2 を入れないと、承認で在籍化した Rosters（ID が r_xxxx）や
 * EntryLists の提出記録が残り、再テスト時に前回の状態を引きずる。
 */
function clearTestData() {
  Logger.log("=== clearTestData 開始 ===");

  // ID の接頭辞で消すもの
  var byPrefix = [
    { sheet: "BudgetTx", pk: "tx_id" },
    { sheet: "Rosters",  pk: "roster_id" },
    { sheet: "Players",  pk: "player_id" },
    { sheet: "Teams",    pk: "team_id" },
    { sheet: "Seasons",  pk: "season_id" },
  ];

  // テスト用シーズンに紐づく行をまとめて消すもの
  var bySeason = ["Rosters", "EntryLists", "BudgetTx", "Transfers", "Protections"];

  bySeason.forEach(function (name) {
    var removed = _deleteRowsByColumn(name, "season_id", SEED_SEASON_ID);
    Logger.log(name + "（season 一致）: " + removed + " 行削除");
  });

  byPrefix.forEach(function (t) {
    var removed = _deleteRowsByPrefix(t.sheet, t.pk, SEED_PREFIX);
    Logger.log(t.sheet + "（ID 接頭辞）: " + removed + " 行削除");
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
  return _deleteRowsWhere(sheetName, pkColumn, function (val) {
    return val.indexOf(prefix) === 0;
  });
}

/**
 * 指定カラムの値が target と完全一致する行をすべて削除する。
 *
 * @param {string} sheetName
 * @param {string} column
 * @param {string} target
 * @returns {number} 削除した行数
 */
function _deleteRowsByColumn(sheetName, column, target) {
  return _deleteRowsWhere(sheetName, column, function (val) {
    return val === target;
  });
}

/**
 * 指定カラムの値が条件を満たす行をすべて削除する。
 * 下の行から削除して行番号のズレを避ける。
 * 対象カラムが無いシートは何もしない。
 *
 * @param {string} sheetName
 * @param {string} column
 * @param {function(string): boolean} predicate
 * @returns {number} 削除した行数
 */
function _deleteRowsWhere(sheetName, column, predicate) {
  var sheet = getSheet(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var idx = values[0].indexOf(column);
  if (idx === -1) return 0;

  var removed = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (predicate(String(values[i][idx] || ""))) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }

  return removed;
}

// =============================================================================
// 本番投入前のリセット
// =============================================================================

/**
 * resetAllTournamentData を実行してよいかどうかのフラグ。
 *
 * GAS エディタの「実行」プルダウンには全関数が並ぶため、
 * 取り消せない削除を誤って走らせないよう二重の鍵にしている。
 * 実行するときだけ true にして、終わったら false に戻すこと。
 */
var RESET_CONFIRMED = false;

/**
 * リセット対象のシート。
 *
 * Players / Clubs / Config / Users は残す。
 * 選手マスタとクラブ一覧、設定、主催者アカウントは作り直す必要がないため。
 */
var RESET_SHEETS = [
  "Seasons", "Teams", "Rosters", "EntryLists", "Transfers", "Protections",
  "BudgetTx", "Matches", "MatchGoals", "MatchTeamStats", "MatchGKStats",
  "SeasonTeams", "SuperCup", "Signups",
];

/**
 * 何が消えるかをログに出すだけ。**削除はしない。**
 *
 * resetAllTournamentData を走らせる前に必ずこれで確認する。
 */
function previewReset() {
  Logger.log("=== previewReset（削除はしません）===");

  var total = 0;
  RESET_SHEETS.forEach(function (name) {
    var count = _dataRowCount(name);
    total += count;
    Logger.log("  " + name + ": " + count + " 行");
  });

  Logger.log("--- 削除される合計: " + total + " 行 ---");

  var keepUsers = [];
  var dropUsers = [];
  getSheetData("Users").forEach(function (u) {
    if (_str(u.role) === "organizer") keepUsers.push(_str(u.email));
    else dropUsers.push(_str(u.email) + "（" + _str(u.team_id) + "）");
  });

  Logger.log("残す主催者: " + (keepUsers.join(", ") || "なし"));
  Logger.log("消す参加者: " + (dropUsers.join(", ") || "なし"));

  Logger.log("残すもの: Players " + _dataRowCount("Players") +
    " 行 / Clubs " + _dataRowCount("Clubs") +
    " 行 / Config " + _dataRowCount("Config") + " 行");

  if (keepUsers.length === 0) {
    Logger.log("⚠ 主催者が1人もいません。このまま実行すると誰もログインできなくなります。");
  }

  Logger.log("=== 実行するには RESET_CONFIRMED を true にして resetAllTournamentData を走らせる ===");
}

/**
 * 大会データを全消しして、本番シーズンを始められる状態に戻す。
 *
 * 消すもの: シーズン・チーム・スカッド・移籍・プロテクト・予算・試合・参加申請、
 *           および role=team のユーザー
 * 残すもの: 選手マスタ・クラブ一覧・Config・主催者ユーザー
 *
 * ⚠️ **取り消せない。** 先に previewReset で内容を確認すること。
 * ⚠️ 主催者が1人もいない状態では実行しない（誰もログインできなくなるため）。
 */
function resetAllTournamentData() {
  if (!RESET_CONFIRMED) {
    Logger.log("RESET_CONFIRMED が false のため中止しました。");
    Logger.log("previewReset で内容を確認してから、seed.gs の RESET_CONFIRMED を true にしてください。");
    return;
  }

  var organizers = getSheetData("Users").filter(function (u) {
    return _str(u.role) === "organizer";
  });

  if (organizers.length === 0) {
    Logger.log("中止: 主催者が1人もいません。先に Users へ主催者を登録してください。");
    return;
  }

  Logger.log("=== resetAllTournamentData 開始 ===");

  RESET_SHEETS.forEach(function (name) {
    var removed = _clearSheetRows(name);
    Logger.log("  " + name + ": " + removed + " 行削除");
  });

  // 参加者ユーザーだけ消す。主催者は残す
  var dropped = _deleteRowsWhere("Users", "role", function (v) {
    return v !== "organizer";
  });
  Logger.log("  Users（参加者）: " + dropped + " 行削除");

  Logger.log("残った主催者: " + organizers.map(function (u) {
    return _str(u.email);
  }).join(", "));

  Logger.log("=== 完了。RESET_CONFIRMED を false に戻してください ===");
}

/**
 * ヘッダー行を残して、データ行をすべて消す。
 *
 * @param {string} sheetName
 * @returns {number} 削除した行数
 */
function _clearSheetRows(sheetName) {
  var sheet = getSheet(sheetName);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var count = last - 1;
  sheet.deleteRows(2, count);
  return count;
}

/**
 * ヘッダーを除いたデータ行数を返す。
 *
 * @param {string} sheetName
 * @returns {number}
 */
function _dataRowCount(sheetName) {
  try {
    var last = getSheet(sheetName).getLastRow();
    return last < 2 ? 0 : last - 1;
  } catch (e) {
    return 0;
  }
}
