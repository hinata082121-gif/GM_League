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

    // シーズン開始時にシーズン賞金を配る
    if (next === "エントリー受付" && !_hasBudgetReason(seasonId, REASON_SEASON_PRIZE)) {
      var prize = getConfigNum("season_prize", 0);
      if (prize > 0) {
        var teams = _activeTeams();
        teams.forEach(function (t) {
          _addBudgetTx(seasonId, _str(t.team_id), prize, REASON_SEASON_PRIZE, "", at);
        });
        effects.push("シーズン賞金 " + prize + " を " + teams.length + " チームに計上");
      } else {
        effects.push("シーズン賞金は Config が 0 のため計上なし");
      }
    }

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
    var report = { rank_prizes: [], top_scorer_prizes: [], fees: [], expired: 0, carried: 0 };

    // --- 1. 順位賞金 ---
    var standings = getStandings(token, { season_id: seasonId });
    if (standings.ok) {
      standings.data.table.forEach(function (row) {
        var amount = getConfigNum("rank_prize_" + row.rank, 0);
        if (amount > 0) {
          _addBudgetTx(seasonId, row.team_id, amount, REASON_RANK_PRIZE, String(row.rank) + "位", at);
          report.rank_prizes.push({ team_id: row.team_id, rank: row.rank, amount: amount });
        }
      });
    }

    // --- 2. 得点王賞金 ---
    var topPrize = getConfigNum("top_scorer_prize", 0);
    if (topPrize > 0) {
      var rankings = getRankings(token, { season_id: seasonId });
      if (rankings.ok && rankings.data.goals.length > 0) {
        var tops = rankings.data.goals.filter(function (g) { return g.rank === 1; });

        // 終了時点の所属チームを引く。移籍している場合は現在の在籍先
        var paid = {};
        tops.forEach(function (g) {
          var teamId = _currentTeamOf(seasonId, g.player_id) || g.team_id;
          if (!teamId || paid[teamId]) return;
          paid[teamId] = true;
          _addBudgetTx(seasonId, teamId, topPrize, REASON_TOP_SCORER, g.player_id, at);
          report.top_scorer_prizes.push({
            team_id: teamId, player_id: g.player_id, goals: g.goals, amount: topPrize,
          });
        });
      }
    }

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
      report.carried = _carryOverRosters(seasonId, nextSeasonId, at);
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
 * @param {string} seasonId
 * @param {string} nextSeasonId
 * @param {Date} at
 * @returns {number} コピーした行数
 */
function _carryOverRosters(seasonId, nextSeasonId, at) {
  var activeTeamIds = {};
  _activeTeams().forEach(function (t) { activeTeamIds[_str(t.team_id)] = true; });

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
