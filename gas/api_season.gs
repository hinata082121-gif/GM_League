/**
 * api_season.gs — Phase 7: 経済周辺 & シーズン進行
 *
 * 主催者専用:
 *   addPenalty          — 罰金の計上
 *   addCompensation     — 補填金の計上（大会外移籍 80% / 辞退 90%）
 *   applySponsorIncome  — スポンサー収益の反映
 *   advanceSeason       — シーズン status を1つ進める（付随処理あり）
 *   closeSeason         — シーズン終了処理
 *
 * 全ロール:
 *   getSeasonProgress   — 現在の状態・次の遷移・実施済みの経済処理
 *
 * ⚠️ 設計原則
 *   3. 予算残高はカラムを持たず BudgetTx の SUM で算出する
 *   補助. 金額・率はすべて Config 参照
 *
 * 確定仕様（SPEC.md §11）
 *   - 同順位・同点の賞金は該当チーム全てに満額支給（按分しない）
 *   - 次シーズンは主催者が先に作る。closeSeason は next_season_id を受け取るだけ
 *   - 引継ぎ時は acquisition_type と acquired_cost を保持（補填金の母数になるため）
 *   - closeSeason は二重実行できない（シーズン終了手数料の有無で判定）
 */

// =============================================================================
// 定数
// =============================================================================

/** BudgetTx.reason */
var REASON_SEASON_PRIZE = "シーズン賞金";
var REASON_SPONSOR = "スポンサー収益";
var REASON_RANK_PRIZE = "順位賞金";
var REASON_TOP_SCORER = "得点王賞金";
var REASON_COMP_TRANSFER = "補填金_大会外移籍";
var REASON_COMP_WITHDRAW = "補填金_辞退";
var REASON_PENALTY = "罰金";
var REASON_SEASON_FEE = "シーズン終了手数料";
var REASON_CUP_PRIZE = "リーグ杯賞金";
var REASON_SUPERCUP_PRIZE = "スーパーカップ賞金";
var REASON_STREAM_FEE = "配信料";
var REASON_TEAM_RESET = "チーム変更リセット";

/** 補填金の種別 */
var COMPENSATION_KINDS = ["大会外移籍", "辞退"];

/** 半期期限付きが離脱する遷移 */
var HALF_TERM_EXIT_FROM = "シーズン1";

// =============================================================================
// 共通ヘルパ
// =============================================================================

/**
 * BudgetTx に1行足す。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {number} amount   収入は正、支出は負
 * @param {string} reason
 * @param {string} ref
 * @param {Date} at
 * @returns {string} tx_id
 */
function _addBudgetTx(seasonId, teamId, amount, reason, ref, at) {
  var txId = generateId("tx_");
  appendRow("BudgetTx", {
    tx_id:      txId,
    season_id:  seasonId,
    team_id:    teamId,
    amount:     Math.round(amount),
    reason:     reason,
    ref:        ref || "",
    created_at: at || now(),
  });
  return txId;
}

/**
 * 指定シーズンに、その reason の取引が既にあるか。
 * 二重計上の防止に使う。
 *
 * @param {string} seasonId
 * @param {string} reason
 * @returns {boolean}
 */
function _hasBudgetReason(seasonId, reason) {
  var rows = getSheetData("BudgetTx");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].season_id) === seasonId && _str(rows[i].reason) === reason) return true;
  }
  return false;
}

/**
 * アクティブなチームの一覧を返す。
 *
 * @returns {Object[]}
 */
function _activeTeams() {
  return getSheetData("Teams").filter(function (t) { return _toBool(t.active); });
}

// =============================================================================
// 経済操作（都度）
// =============================================================================

/**
 * 罰金を計上する。
 *
 * payload: { season_id, team_id, amount, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function addPenalty(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  var amount = Math.floor(_num(payload.amount));

  if (!seasonId || !teamId) return { ok: false, error: "season_id と team_id は必須です。" };
  if (amount <= 0) return { ok: false, error: "罰金額は1以上で入力してください。" };
  if (!findRow("Teams", "team_id", teamId)) return { ok: false, error: "チームが見つかりません。" };

  return withLock(function () {
    var txId = _addBudgetTx(seasonId, teamId, -amount, REASON_PENALTY, _str(payload.note), now());
    return { ok: true, data: { tx_id: txId, team_id: teamId, amount: -amount } };
  });
}

/**
 * 補填金を計上する。
 *
 * 母数は Rosters の acquired_cost（そのチームが実際に払った額）。
 * オークションで獲得した選手は対象外（SPEC.md §5.1）。
 *
 * payload: { season_id, team_id, player_id, kind: '大会外移籍' | '辞退' }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function addCompensation(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  var playerId = _str(payload.player_id);
  var kind = _str(payload.kind);

  if (!seasonId || !teamId || !playerId) {
    return { ok: false, error: "season_id / team_id / player_id は必須です。" };
  }

  try {
    _assertEnum("kind", kind, COMPENSATION_KINDS);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return withLock(function () {
    // 該当シーズン・チームの在籍履歴を探す（status は問わない）
    var roster = null;
    getSheetData("Rosters").forEach(function (r) {
      if (roster) return;
      if (_str(r.season_id) !== seasonId) return;
      if (_str(r.team_id) !== teamId) return;
      if (_str(r.player_id) !== playerId) return;
      roster = r;
    });

    if (!roster) {
      return { ok: false, error: "このシーズンに該当チームでの在籍記録が見つかりません。" };
    }

    if (_str(roster.acquisition_type) === METHOD_AUCTION) {
      return {
        ok: false,
        error: "オークションで獲得した選手は補填金の対象外です（シーズン終了で自動離脱するため）。",
      };
    }

    var cost = _num(roster.acquired_cost);
    if (cost <= 0) {
      return { ok: false, error: "獲得額が0のため補填金は発生しません。" };
    }

    var rate =
      kind === "大会外移籍"
        ? Number(getConfig("compensation_rate_transfer", 0.8))
        : Number(getConfig("compensation_rate_withdrawal", 0.9));

    var reason = kind === "大会外移籍" ? REASON_COMP_TRANSFER : REASON_COMP_WITHDRAW;
    var amount = Math.round(cost * rate);

    var txId = _addBudgetTx(seasonId, teamId, amount, reason, playerId, now());

    return {
      ok: true,
      data: {
        tx_id: txId, team_id: teamId, player_id: playerId,
        acquired_cost: cost, rate: rate, amount: amount, kind: kind,
      },
    };
  });
}

/**
 * スポンサー収益を反映する。
 *
 * SPEC では Google Form 入力を想定しているが、まずは主催者がチーム別に
 * 金額を入力する形で実装している。Form からの取り込みは後から追加できる。
 *
 * payload: { season_id, entries: [{ team_id, amount }] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function applySponsorIncome(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var entries = (payload.entries || []).filter(function (e) {
    return _str(e.team_id) && _num(e.amount) > 0;
  });

  if (entries.length === 0) {
    return { ok: false, error: "反映する金額がありません。" };
  }

  return withLock(function () {
    var at = now();
    var applied = [];

    for (var i = 0; i < entries.length; i++) {
      var teamId = _str(entries[i].team_id);
      if (!findRow("Teams", "team_id", teamId)) {
        return { ok: false, error: "チームが見つかりません: " + teamId };
      }
      var amount = Math.floor(_num(entries[i].amount));
      _addBudgetTx(seasonId, teamId, amount, REASON_SPONSOR, "", at);
      applied.push({ team_id: teamId, amount: amount });
    }

    return { ok: true, data: { applied: applied, count: applied.length } };
  });
}

// =============================================================================
// シーズン進行
// =============================================================================

/**
 * 現在のシーズン状態と、次に進める先・実施済みの経済処理を返す。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSeasonProgress(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var status = _str(season.status);
  var idx = SEASON_STATUSES.indexOf(status);
  var next = idx >= 0 && idx < SEASON_STATUSES.length - 2 ? SEASON_STATUSES[idx + 1] : "";

  return {
    ok: true,
    data: {
      season_id: seasonId,
      season_name: _str(season.name),
      status: status,
      next_status: next,
      can_advance: !!next,
      can_close: status !== "終了" && !_hasBudgetReason(seasonId, REASON_SEASON_FEE),
      closed: _hasBudgetReason(seasonId, REASON_SEASON_FEE),
      applied: {
        season_prize: _hasBudgetReason(seasonId, REASON_SEASON_PRIZE),
        sponsor:      _hasBudgetReason(seasonId, REASON_SPONSOR),
        rank_prize:   _hasBudgetReason(seasonId, REASON_RANK_PRIZE),
        top_scorer:   _hasBudgetReason(seasonId, REASON_TOP_SCORER),
        season_fee:   _hasBudgetReason(seasonId, REASON_SEASON_FEE),
      },
      statuses: SEASON_STATUSES,
    },
  };
}

/**
 * シーズン status を1つ進める。
 *
 * 準備中 → エントリー受付 のときにシーズン賞金を計上し、
 * シーズン1 → 移籍市場2 のときに半期期限付き選手を離脱させる。
 * 終了 へは進めない（closeSeason を使う）。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function advanceSeason(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  return withLock(function () {
    var season = findRow("Seasons", "season_id", seasonId);
    if (!season) return { ok: false, error: "シーズンが見つかりません。" };

    var status = _str(season.status);
    var idx = SEASON_STATUSES.indexOf(status);

    if (idx === -1) return { ok: false, error: "現在の状態が不正です: " + status };
    if (status === "終了") return { ok: false, error: "既に終了しています。" };

    var next = SEASON_STATUSES[idx + 1];
    if (next === "終了") {
      return {
        ok: false,
        error: "終了へ進めるには closeSeason（シーズン終了処理）を使ってください。",
      };
    }

    var at = now();
    var effects = [];

    // 賞金はすべてシーズン終了時（closeSeason）にまとめて計上する。
    // 途中で配ると「終了手数料の母数」がぶれるため、進行時は状態を進めるだけにしている。

    // シーズン1が終わったら半期期限付きを離脱させる
    if (status === HALF_TERM_EXIT_FROM) {
      var left = _expireRosters(seasonId, [METHOD_HALF]);
      effects.push("半期期限付きの選手 " + left + " 名を離脱");
    }

    updateRow("Seasons", "season_id", seasonId, { status: next });

    return { ok: true, data: { season_id: seasonId, status: next, effects: effects } };
  });
}

/**
 * 指定の acquisition_type の在籍行を離脱させる。
 *
 * @param {string} seasonId
 * @param {string[]} types  空配列なら type で絞らない
 * @param {boolean} [byExpires] true なら expires_season が当該シーズンの行だけを対象にする
 * @returns {number} 離脱させた行数
 */
function _expireRosters(seasonId, types, byExpires) {
  var sheet = getSheet("Rosters");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iType = headers.indexOf("acquisition_type");
  var iExpires = headers.indexOf("expires_season");
  var iStatus = headers.indexOf("status");

  var count = 0;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][iSeason]) !== seasonId) continue;
    if (String(values[i][iStatus]) !== ROSTER_ACTIVE) continue;

    if (byExpires) {
      if (String(values[i][iExpires]) !== seasonId) continue;
    } else if (types && types.length > 0) {
      if (types.indexOf(String(values[i][iType])) === -1) continue;
    }

    sheet.getRange(i + 1, iStatus + 1).setValue(ROSTER_LEFT);
    count++;
  }
  return count;
}

// =============================================================================
// シーズン終了
// =============================================================================

/**
 * シーズン終了処理。
 *
 * 1. 順位賞金（1〜3位。同順位は全チーム満額）
 * 2. 得点王賞金（終了時点の所属チームへ。同点は全チーム満額）
 * 3. 残予算 × season_end_fee_rate を控除
 * 4. expires_season が当該シーズンの在籍行を離脱
 * 5. next_season_id があればアクティブチームのスカッドをコピー
 * 6. status を 終了 に
 *
 * payload: { season_id, next_season_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function closeSeason(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var nextSeasonId = _str(payload.next_season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  return withLock(function () {
    var season = findRow("Seasons", "season_id", seasonId);
    if (!season) return { ok: false, error: "シーズンが見つかりません。" };

    // 二重実行の防止。賞金の二重支給を避ける
    if (_hasBudgetReason(seasonId, REASON_SEASON_FEE)) {
      return { ok: false, error: "このシーズンは既に終了処理が済んでいます。" };
    }

    if (nextSeasonId) {
      if (nextSeasonId === seasonId) {
        return { ok: false, error: "引継ぎ先に同じシーズンは指定できません。" };
      }
      if (!findRow("Seasons", "season_id", nextSeasonId)) {
        return { ok: false, error: "引継ぎ先のシーズンが見つかりません。先に作成してください。" };
      }
    }

    var at = now();
    var report = {
      rank_prizes: [], cup_prizes: [], supercup_prizes: [], stream_fees: [],
      top_scorer_prizes: [], fees: [], expired: 0, carried: 0,
      dropped_ineligible: [], sponsor_results: [],
    };

    // --- 1. リーグ順位賞金（GM1 / GM2）---
    var d = _divisionsOf(seasonId);
    report.two_division = d.twoDivision;
    report.format = d.twoDivision ? "二部制" : "一部制";

    _payLeaguePrizes(token, seasonId, DIVISION_GM1, d.twoDivision, at, report);
    if (d.twoDivision) {
      _payLeaguePrizes(token, seasonId, DIVISION_GM2, d.twoDivision, at, report);
    }

    // --- 2. GMリーグ杯 ---
    _payCupPrizes(token, seasonId, at, report);

    // --- 2b. GMスーパーカップ（賞金と配信料）---
    _paySuperCup(token, seasonId, at, report);

    // --- 2c. 得点王賞金（大会別）---
    _payTopScorers(token, seasonId, d.twoDivision, at, report);

    // --- スポンサーのノルマ判定（未達なら罰金）---
    // 手数料の前に置く。罰金も賞金と同じく手数料の母数に含めるため
    _settleSponsors(token, seasonId, at, report);

    // --- 3. シーズン終了手数料（賞金計上後の残高が母数） ---
    var feeRate = Number(getConfig("season_end_fee_rate", 0.1));
    var balances = {};
    getSheetData("BudgetTx").forEach(function (t) {
      var tid = _str(t.team_id);
      balances[tid] = (balances[tid] || 0) + _num(t.amount);
    });

    _activeTeams().forEach(function (t) {
      var tid = _str(t.team_id);
      var bal = balances[tid] || 0;
      if (bal <= 0) return;
      var fee = Math.round(bal * feeRate);
      if (fee <= 0) return;
      _addBudgetTx(seasonId, tid, -fee, REASON_SEASON_FEE, "", at);
      report.fees.push({ team_id: tid, balance: bal, fee: fee });
    });

    // 手数料が1件も出ない場合でも「終了処理済み」を記録しておく
    if (report.fees.length === 0) {
      _addBudgetTx(seasonId, "", 0, REASON_SEASON_FEE, "no_fee", at);
    }

    // --- 4. 期限切れの選手を離脱 ---
    report.expired = _expireRosters(seasonId, null, true);

    // --- 5. 次シーズンへ引継ぎ ---
    if (nextSeasonId) {
      report.carried = _carryOverRosters(seasonId, nextSeasonId, at, report);
    }

    // --- 6. 終了 ---
    updateRow("Seasons", "season_id", seasonId, { status: "終了" });

    return {
      ok: true,
      data: {
        season_id: seasonId,
        next_season_id: nextSeasonId,
        status: "終了",
        report: report,
      },
    };
  });
}

/**
 * 在籍中の選手を次シーズンの Rosters にコピーする。
 *
 * acquisition_type と acquired_cost は保持する（補填金の母数になるため）。
 * expires_season は空にする（期限切れは既に離脱済み）。
 * 既に次シーズンに同じ選手の行がある場合はスキップする。
 *
 * **eligible=false の選手は引き継がない**（SPEC.md §6.5）。
 * 大会に参加していないクラブへ現実の移籍をした選手は、翌シーズンから使えない。
 * 今シーズンの在籍と試合結果はそのまま残し、コピーの段階で落とす。
 *
 * @param {string} seasonId
 * @param {string} nextSeasonId
 * @param {Date} at
 * @param {Object} [report] dropped_ineligible に落とした選手を記録する
 * @returns {number} コピーした行数
 */
function _carryOverRosters(seasonId, nextSeasonId, at, report) {
  var activeTeamIds = {};
  _activeTeams().forEach(function (t) { activeTeamIds[_str(t.team_id)] = true; });

  // 大会対象外になった選手を引く
  var ineligible = {};
  var playerNames = {};
  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    playerNames[pid] = _str(p.name);
    if (!_toBool(p.eligible)) ineligible[pid] = true;
  });

  var existing = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== nextSeasonId) return;
    existing[_str(r.team_id) + "|" + _str(r.player_id)] = true;
  });

  var rows = [];
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;

    var teamId = _str(r.team_id);
    var playerId = _str(r.player_id);
    if (!activeTeamIds[teamId]) return;
    if (existing[teamId + "|" + playerId]) return;

    // 現実移籍で対象外になった選手はここで落とす
    if (ineligible[playerId]) {
      if (report) {
        report.dropped_ineligible.push({
          team_id: teamId,
          player_id: playerId,
          name: playerNames[playerId] || playerId,
        });
      }
      return;
    }

    existing[teamId + "|" + playerId] = true;

    rows.push({
      roster_id:        generateId("r_"),
      season_id:        nextSeasonId,
      team_id:          teamId,
      player_id:        playerId,
      acquisition_type: _str(r.acquisition_type),
      acquired_cost:    _num(r.acquired_cost),
      acquired_at:      at,
      expires_season:   "",
      status:           ROSTER_ACTIVE,
    });
  });

  _appendRowsBatch("Rosters", rows);

  // 引き継いだチームは次シーズンでは「継続」扱いにする
  Object.keys(activeTeamIds).forEach(function (tid) {
    updateRow("Teams", "team_id", tid, { kind: "継続" });
  });

  return rows.length;
}

// =============================================================================
// シーズンの作成・更新（Phase 8）
// =============================================================================

/**
 * シーズンを作成または更新する。主催者専用。
 *
 * closeSeason の引継ぎ先を用意するには、先に次シーズンを作っておく必要がある。
 * シートを直接編集しなくても済むように用意した。
 *
 * payload: {
 *   season_id?, name, status?, leg_enabled?,
 *   window1_open_at?, window2_open_at?, claim_deadline_at?
 * }
 *
 * 日時は "2026-09-01T12:00" 形式の文字列、または空文字で受け取る。
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertSeason(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var name = _str(payload.name);
  if (!name) return { ok: false, error: "シーズン名は必須です。" };

  var status = _str(payload.status) || "準備中";
  try {
    _assertEnum("status", status, SEASON_STATUSES);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var w1 = _parseDateInput(payload.window1_open_at);
  var w2 = _parseDateInput(payload.window2_open_at);

  if (payload.window1_open_at && !w1) {
    return { ok: false, error: "第1次移籍市場の日時が読み取れません。" };
  }
  if (payload.window2_open_at && !w2) {
    return { ok: false, error: "第2次移籍市場の日時が読み取れません。" };
  }
  if (w1 && w2 && w2 <= w1) {
    return { ok: false, error: "第2次移籍市場は第1次より後の日時にしてください。" };
  }

  var cd = _parseDateInput(payload.claim_deadline_at);
  if (payload.claim_deadline_at && !cd) {
    return { ok: false, error: "補填の選択期限の日時が読み取れません。" };
  }

  var seasonId = _str(payload.season_id);

  return withLock(function () {
    if (seasonId && findRow("Seasons", "season_id", seasonId)) {
      updateRow("Seasons", "season_id", seasonId, {
        name:            name,
        status:          status,
        leg_enabled:     _toBool(payload.leg_enabled),
        window1_open_at: w1 || "",
        window2_open_at: w2 || "",
        claim_deadline_at: cd || "",
      });
      return { ok: true, data: { season_id: seasonId, created: false } };
    }

    if (!seasonId) seasonId = generateId("s_");

    appendRow("Seasons", {
      season_id:       seasonId,
      name:            name,
      status:          status,
      leg_enabled:     _toBool(payload.leg_enabled),
      window1_open_at: w1 || "",
      window2_open_at: w2 || "",
      claim_deadline_at: cd || "",
      created_at:      now(),
    });

    return { ok: true, data: { season_id: seasonId, created: true } };
  });
}

/**
 * 画面から来た日時文字列を Date に変換する。
 * 空・不正な場合は null。
 *
 * @param {*} v
 * @returns {Date|null}
 */
function _parseDateInput(v) {
  if (v instanceof Date) return v;
  var s = _str(v);
  if (!s) return null;

  // "2026-09-01T12:00" / "2026-09-01 12:00" / "2026/09/01 12:00" に対応
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (!m) return null;

  var d = new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    m[4] ? parseInt(m[4], 10) : 0,
    m[5] ? parseInt(m[5], 10) : 0,
    0
  );
  return isNaN(d.getTime()) ? null : d;
}

// =============================================================================
// 過去大会記録（Phase 8）
// =============================================================================

/**
 * 過去シーズンの記録を返す。
 *
 * 各シーズンについて、最終順位・優勝チーム・得点王・試合数をまとめる。
 * 終了していないシーズンも現時点の集計として返す。
 *
 * payload: { include_ongoing?: boolean }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function getHistory(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var includeOngoing = _toBool(payload.include_ongoing);

  var seasons = getSheetData("Seasons").map(function (s) {
    return {
      season_id: _str(s.season_id),
      name:      _str(s.name),
      status:    _str(s.status),
      created_at: _iso(s.created_at),
    };
  });

  var result = [];

  seasons.forEach(function (s) {
    if (!includeOngoing && s.status !== "終了") return;

    var standings = getStandings(token, { season_id: s.season_id });
    var rankings = getRankings(token, { season_id: s.season_id });
    var tournament = getTournament(token, { season_id: s.season_id });

    var table = standings.ok ? standings.data.table : [];
    var champions = table.filter(function (r) { return r.rank === 1 && r.played > 0; });

    var topScorers = [];
    if (rankings.ok && rankings.data.goals.length > 0) {
      topScorers = rankings.data.goals.filter(function (g) { return g.rank === 1; });
    }

    // トーナメントの優勝は「最後のタイの勝者」とみなす
    var tournamentWinner = null;
    if (tournament.ok && tournament.data.ties.length > 0) {
      var last = tournament.data.ties[tournament.data.ties.length - 1];
      if (last.winner) {
        tournamentWinner = { team_id: last.winner, team_name: last.winner_name, round: last.round };
      }
    }

    result.push({
      season_id:   s.season_id,
      name:        s.name,
      status:      s.status,
      match_count: standings.ok ? standings.data.match_count : 0,
      league_champions: champions.map(function (c) {
        return { team_id: c.team_id, team_name: c.team_name, points: c.points, gd: c.gd };
      }),
      top_scorers: topScorers.map(function (g) {
        return { player_id: g.player_id, name: g.name, team_name: g.team_name, goals: g.goals };
      }),
      tournament_winner: tournamentWinner,
      table: table,
    });
  });

  result.reverse();
  return { ok: true, data: result };
}

// =============================================================================
// 賞金の支給（closeSeason から呼ばれる）
// =============================================================================

/**
 * リーグ順位賞金を支給する。
 *
 * 一部制と二部制で GM1 の金額が変わるため、Config キーを切り替えて引く。
 * 同順位は該当チーム全てに満額（按分しない・SPEC.md §5.6）。
 *
 * @param {string} token
 * @param {string} seasonId
 * @param {string} division    DIVISION_GM1 / DIVISION_GM2
 * @param {boolean} twoDivision
 * @param {Date} at
 * @param {Object} report
 */
function _payLeaguePrizes(token, seasonId, division, twoDivision, at, report) {
  var st = getStandings(token, { season_id: seasonId, division: division });
  if (!st.ok) return;

  var prefix;
  if (division === DIVISION_GM2) {
    prefix = "prize_gm2_";
  } else {
    prefix = twoDivision ? "prize_gm1_2div_" : "prize_gm1_1div_";
  }

  var competition = division === DIVISION_GM2 ? COMP_GM2 : COMP_GM1;

  st.data.table.forEach(function (row) {
    // 1試合も消化していないチームは賞金対象にしない
    if (row.played <= 0) return;

    var amount = getConfigNum(prefix + row.rank, 0);
    if (amount <= 0) return;

    _addBudgetTx(seasonId, row.team_id, amount, REASON_RANK_PRIZE,
      competition + " " + row.rank + "位", at);

    report.rank_prizes.push({
      competition: competition, team_id: row.team_id,
      rank: row.rank, amount: amount,
    });
  });
}

/**
 * GMリーグ杯の賞金を支給する。
 *
 * 優勝・準優勝は決勝のタイから、ベスト4は準決勝（決勝の1つ前のラウンド）の
 * 敗者から決める。ベスト4は該当2チームそれぞれに満額。
 *
 * @param {string} token
 * @param {string} seasonId
 * @param {Date} at
 * @param {Object} report
 */
function _payCupPrizes(token, seasonId, at, report) {
  var tr = getTournament(token, { season_id: seasonId, stage: STAGE_TOURNAMENT });
  if (!tr.ok || tr.data.ties.length === 0) return;

  var ties = tr.data.ties;
  var final = ties[ties.length - 1];
  if (!final.winner) return;

  var pay = function (teamId, amount, label) {
    if (!teamId || amount <= 0) return;
    _addBudgetTx(seasonId, teamId, amount, REASON_CUP_PRIZE, label, at);
    report.cup_prizes.push({ team_id: teamId, label: label, amount: amount });
  };

  pay(final.winner, getConfigNum("prize_cup_1", 0), "優勝");

  var runnerUp = final.winner === final.team_a ? final.team_b : final.team_a;
  pay(runnerUp, getConfigNum("prize_cup_2", 0), "準優勝");

  // 準決勝＝決勝の1つ前のラウンド。そのラウンドの敗者がベスト4
  var finalRound = final.round;
  var semiRound = "";
  for (var i = ties.length - 1; i >= 0; i--) {
    if (ties[i].round !== finalRound) { semiRound = ties[i].round; break; }
  }
  if (!semiRound) return;

  var semiPrize = getConfigNum("prize_cup_semi", 0);
  ties.forEach(function (t) {
    if (t.round !== semiRound) return;
    if (!t.winner) return;
    var loser = t.winner === t.team_a ? t.team_b : t.team_a;
    pay(loser, semiPrize, "ベスト4");
  });
}

/**
 * GMスーパーカップの賞金と配信料を支給する。
 *
 * 出場チームは SuperCup シートに主催者が設定したもの。
 * 勝敗は stage=supercup の試合から判定する（1試合のみ）。
 * 配信料は streamed にチェックがある場合だけ、出場2チームそれぞれに満額支給する。
 *
 * @param {string} token
 * @param {string} seasonId
 * @param {Date} at
 * @param {Object} report
 */
function _paySuperCup(token, seasonId, at, report) {
  var row = _superCupRow(seasonId);
  if (!row) return;

  var teamA = _str(row.team_a);
  var teamB = _str(row.team_b);
  if (!teamA || !teamB) return;

  // 配信料は試合結果に関係なく、配信を行っていれば両チームに支給する
  if (_toBool(row.streamed)) {
    var fee = getConfigNum("supercup_stream_fee", 0);
    if (fee > 0) {
      [teamA, teamB].forEach(function (tid) {
        _addBudgetTx(seasonId, tid, fee, REASON_STREAM_FEE, "スーパーカップ配信", at);
        report.stream_fees.push({ team_id: tid, amount: fee });
      });
    }
  }

  // 勝敗は承認済みの supercup 試合から判定する
  var tr = getTournament(token, { season_id: seasonId, stage: STAGE_SUPERCUP });
  if (!tr.ok || tr.data.ties.length === 0) return;

  var tie = tr.data.ties[tr.data.ties.length - 1];
  if (!tie.winner) return;

  var loser = tie.winner === tie.team_a ? tie.team_b : tie.team_a;

  var pay = function (teamId, amount, label) {
    if (!teamId || amount <= 0) return;
    _addBudgetTx(seasonId, teamId, amount, REASON_SUPERCUP_PRIZE, label, at);
    report.supercup_prizes.push({ team_id: teamId, label: label, amount: amount });
  };

  pay(tie.winner, getConfigNum("prize_supercup_1", 0), "優勝");
  pay(loser, getConfigNum("prize_supercup_2", 0), "準優勝");
}

/**
 * 大会別の得点王賞金を支給する。
 *
 * GM1リーグ / GM2リーグ / GMリーグ杯 の3つ。スーパーカップは対象外。
 * 得点1位の選手がシーズン終了時点で所属するチームへ支給し、
 * 同点なら該当チーム全てに満額（按分しない）。
 *
 * @param {string} token
 * @param {string} seasonId
 * @param {boolean} twoDivision
 * @param {Date} at
 * @param {Object} report
 */
function _payTopScorers(token, seasonId, twoDivision, at, report) {
  var targets = [
    { competition: COMP_GM1, key: "top_scorer_gm1" },
    { competition: COMP_CUP, key: "top_scorer_cup" },
  ];
  if (twoDivision) {
    targets.splice(1, 0, { competition: COMP_GM2, key: "top_scorer_gm2" });
  }

  targets.forEach(function (t) {
    var amount = getConfigNum(t.key, 0);
    if (amount <= 0) return;

    var rk = getRankings(token, { season_id: seasonId, competition: t.competition });
    if (!rk.ok || rk.data.goals.length === 0) return;

    var tops = rk.data.goals.filter(function (g) { return g.rank === 1; });
    var paid = {};

    tops.forEach(function (g) {
      var teamId = _currentTeamOf(seasonId, g.player_id) || g.team_id;
      if (!teamId || paid[teamId]) return;
      paid[teamId] = true;

      _addBudgetTx(seasonId, teamId, amount, REASON_TOP_SCORER,
        t.competition + " " + g.player_id, at);

      report.top_scorer_prizes.push({
        competition: t.competition, team_id: teamId,
        player_id: g.player_id, goals: g.goals, amount: amount,
      });
    });
  });
}
