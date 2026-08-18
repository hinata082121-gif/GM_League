/**
 * api_protection.gs — Phase 4: プロテクト の action ハンドラ
 *
 * チームオーナー向け:
 *   getProtectionStatus — 現在のフェーズ・残枠・次の料金・設定可能な選手
 *   setProtection       — プロテクト設定（有料は即時 BudgetTx 計上）
 *
 * 全ロール:
 *   getProtections — プロテクト掲示（誰が誰を守っているか）
 *
 * 期間の設計（SPEC.md §7.3）
 *   無料: 〜 開幕の前々日 23:59:59      枠2・料金0
 *   空白: 前日 00:00 〜 22:59           設定不可
 *   有料: 開幕の前日 23:00 〜 市場最終日の 23:59:59   枠3・料金は Config
 *
 * ⚠️ 設計原則
 *   2. 期限判定はすべて GAS の now()。クライアント時刻は受け取らない。
 *   補助. 枠数・料金・日数はすべて Config 参照。コードに直書きしない。
 *
 * ⚠️ 確定仕様
 *   - 一度設定したら解除・変更できない（行を削除する処理を作らない）
 *   - 放出しても枠は戻らない（消費枠数 = Protections の行数）
 *   - 市場期間中に獲得した選手もプロテクトできる
 */

// =============================================================================
// 定数
// =============================================================================

/** プロテクトのフェーズ */
var PROTECT_PHASE_FREE = "無料";
var PROTECT_PHASE_PAID = "有料";
var PROTECT_PHASE_CLOSED = "受付外";

/** tier の接頭辞 */
var TIER_FREE_PREFIX = "無料";
var TIER_PAID_PREFIX = "有料";

// =============================================================================
// 期間の算出（サーバー時刻のみ・原則2）
// =============================================================================

/**
 * 日付の 23:59:59.999 を返す（その日いっぱい）。
 *
 * @param {Date} d
 * @returns {Date}
 */
function _endOfDay(d) {
  var x = new Date(d.getTime());
  x.setHours(23, 59, 59, 999);
  return x;
}

/**
 * 指定ウィンドウのプロテクト受付期間を算出する。
 *
 * @param {Object} season   Seasons の行
 * @param {number} windowNo 1 または 2
 * @returns {{ open: Date, freeEnd: Date, paidStart: Date, paidEnd: Date }|null}
 */
function _protectionPeriods(season, windowNo) {
  var openRaw = windowNo === 2 ? season.window2_open_at : season.window1_open_at;
  if (!(openRaw instanceof Date)) {
    if (!openRaw) return null;
    openRaw = new Date(openRaw);
    if (isNaN(openRaw.getTime())) return null;
  }

  var freeBefore = getConfigNum("protect_free_before_days", 2);
  var paidBefore = getConfigNum("protect_paid_before_days", 1);
  var marketDays = getConfigNum("market_days", 3);

  // 無料の締切 = 開幕の freeBefore 日前の終わり
  var freeEnd = new Date(openRaw.getTime());
  freeEnd.setDate(freeEnd.getDate() - freeBefore);
  freeEnd = _endOfDay(freeEnd);

  // 有料の開始 = 開幕の paidBefore 日前の指定時刻
  var startHm = _parseHourMinute(getConfig("protect_paid_start", "23:00")) || { h: 23, m: 0 };
  var paidStart = new Date(openRaw.getTime());
  paidStart.setDate(paidStart.getDate() - paidBefore);
  paidStart.setHours(startHm.h, startHm.m, 0, 0);

  // 有料の終了 = 市場最終日の終わり（開幕日を1日目として marketDays 日間）
  var paidEnd = new Date(openRaw.getTime());
  paidEnd.setDate(paidEnd.getDate() + (marketDays - 1));
  paidEnd = _endOfDay(paidEnd);

  return { open: openRaw, freeEnd: freeEnd, paidStart: paidStart, paidEnd: paidEnd };
}

/**
 * 現在時刻からプロテクトの対象ウィンドウとフェーズを判定する。
 *
 * シーズン status では判定できない。無料期・有料期は status をまたぐため
 * （例: 第1次の有料期は「エントリー受付」と「移籍市場1」の両方にまたがる）。
 *
 * @param {Object} season
 * @param {Date} at
 * @returns {{ window: number, phase: string, periods: Object|null }}
 */
function _currentProtectionPhase(season, at) {
  for (var w = 1; w <= 2; w++) {
    var p = _protectionPeriods(season, w);
    if (!p) continue;

    if (at <= p.freeEnd) {
      return { window: w, phase: PROTECT_PHASE_FREE, periods: p };
    }
    if (at >= p.paidStart && at <= p.paidEnd) {
      return { window: w, phase: PROTECT_PHASE_PAID, periods: p };
    }
    // 第1次の期間を過ぎている場合は第2次の判定に進む
    if (at <= p.paidEnd) {
      // 無料の締切と有料の開始の間（空白期間）
      return { window: w, phase: PROTECT_PHASE_CLOSED, periods: p };
    }
  }

  return { window: 0, phase: PROTECT_PHASE_CLOSED, periods: null };
}

// =============================================================================
// 枠と料金
// =============================================================================

/**
 * チームが指定ウィンドウで消費済みの枠数を数える。
 *
 * 解除できない仕様なので、行数がそのまま消費枠数になる。
 * 放出済みの選手の分も残るため「放出しても枠は戻らない」が自動的に成立する。
 *
 * @param {string} seasonId
 * @param {number} windowNo
 * @param {string} teamId
 * @returns {{ free: number, paid: number, rows: Object[] }}
 */
function _protectionUsage(seasonId, windowNo, teamId) {
  var free = 0;
  var paid = 0;
  var rows = [];

  getSheetData("Protections").forEach(function (p) {
    if (_str(p.season_id) !== seasonId) return;
    if (_num(p.window) !== windowNo) return;
    if (_str(p.team_id) !== teamId) return;

    var tier = _str(p.tier);
    if (tier.indexOf(TIER_PAID_PREFIX) === 0) paid++;
    else free++;

    rows.push(p);
  });

  return { free: free, paid: paid, rows: rows };
}

/**
 * 次に割り当てる tier と料金を返す。枠が尽きている場合は null。
 *
 * @param {string} phase
 * @param {{ free: number, paid: number }} usage
 * @returns {{ tier: string, fee: number }|null}
 */
function _nextTier(phase, usage) {
  if (phase === PROTECT_PHASE_FREE) {
    var freeMax = getConfigNum("free_protect_count", 2);
    if (usage.free >= freeMax) return null;
    return { tier: TIER_FREE_PREFIX + (usage.free + 1), fee: 0 };
  }

  if (phase === PROTECT_PHASE_PAID) {
    var paidMax = getConfigNum("paid_protect_count", 3);
    if (usage.paid >= paidMax) return null;
    var n = usage.paid + 1;
    return { tier: TIER_PAID_PREFIX + n, fee: getConfigNum("protect_fee_" + n, 0) };
  }

  return null;
}

// =============================================================================
// 読み取り
// =============================================================================

/**
 * プロテクトの設定状況を返す。
 *
 * payload: { season_id: string, team_id?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getProtectionStatus(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var at = now();
  var ph = _currentProtectionPhase(season, at);

  var data = {
    season_id:   seasonId,
    server_time: _iso(at),
    window:      ph.window,
    phase:       ph.phase,
    can_set:     false,
    free_max:    getConfigNum("free_protect_count", 2),
    paid_max:    getConfigNum("paid_protect_count", 3),
    fees: [
      getConfigNum("protect_fee_1", 0),
      getConfigNum("protect_fee_2", 0),
      getConfigNum("protect_fee_3", 0),
    ],
    periods:   null,
    team_id:   teamId,
    usage:     null,
    next_tier: null,
    protectable: [],
    my_protections: [],
  };

  if (ph.periods) {
    data.periods = {
      open:       _iso(ph.periods.open),
      free_end:   _iso(ph.periods.freeEnd),
      paid_start: _iso(ph.periods.paidStart),
      paid_end:   _iso(ph.periods.paidEnd),
    };
  }

  if (!teamId) return { ok: true, data: data };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  var usage = _protectionUsage(seasonId, ph.window, teamId);
  data.usage = { free: usage.free, paid: usage.paid };

  var next = _nextTier(ph.phase, usage);
  data.next_tier = next;
  data.can_set = !!next;

  // 既に自チームが設定済みの選手
  var playerInfo = {};
  getSheetData("Players").forEach(function (p) {
    playerInfo[_str(p.player_id)] = p;
  });

  var protectedIds = {};
  data.my_protections = usage.rows.map(function (p) {
    var pid = _str(p.player_id);
    protectedIds[pid] = true;
    var info = playerInfo[pid] || {};
    return {
      protection_id: _str(p.protection_id),
      player_id:     pid,
      name:          _str(info.name),
      position:      _str(info.position),
      tier:          _str(p.tier),
      fee:           _num(p.fee),
      set_at:        _iso(p.set_at),
    };
  });

  // 設定できる選手 = 自チームに在籍中かつ未設定
  var list = [];
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.team_id) !== teamId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;

    var pid = _str(r.player_id);
    if (protectedIds[pid]) return;

    var info = playerInfo[pid] || {};
    list.push({
      player_id: pid,
      name:      _str(info.name),
      position:  _str(info.position),
      real_club: _str(info.real_club),
    });
  });

  list.sort(_comparePlayers);
  data.protectable = list;

  return { ok: true, data: data };
}

/**
 * プロテクト掲示。全ロールが閲覧できる。
 *
 * payload: { season_id: string, window?: number }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function getProtections(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var windowNo = _num(payload.window);

  var playerInfo = {};
  getSheetData("Players").forEach(function (p) {
    playerInfo[_str(p.player_id)] = p;
  });

  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  // 現在の在籍チーム（放出済みかどうかの表示に使う）
  var ownerOf = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;
    ownerOf[_str(r.player_id)] = _str(r.team_id);
  });

  var rows = [];
  getSheetData("Protections").forEach(function (p) {
    if (_str(p.season_id) !== seasonId) return;
    if (windowNo && _num(p.window) !== windowNo) return;

    var pid = _str(p.player_id);
    var tid = _str(p.team_id);
    var info = playerInfo[pid] || {};

    rows.push({
      protection_id: _str(p.protection_id),
      window:        _num(p.window),
      team_id:       tid,
      team_name:     teamNames[tid] || tid,
      player_id:     pid,
      name:          _str(info.name),
      position:      _str(info.position),
      tier:          _str(p.tier),
      fee:           _num(p.fee),
      set_at:        _iso(p.set_at),
      // 設定後に放出された場合。枠は戻らないので記録は残る
      still_on_team: ownerOf[pid] === tid,
    });
  });

  rows.sort(function (a, b) {
    if (a.window !== b.window) return a.window - b.window;
    if (a.team_name !== b.team_name) return a.team_name < b.team_name ? -1 : 1;
    return a.tier < b.tier ? -1 : 1;
  });

  return { ok: true, data: rows };
}

// =============================================================================
// 設定
// =============================================================================

/**
 * プロテクトを設定する。
 *
 * tier は現在のフェーズと消費済み枠数から自動で決まる。
 * 有料枠の場合は料金を即時 BudgetTx に計上する（主催者承認を挟まない）。
 *
 * payload: { season_id: string, team_id?: string, player_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setProtection(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);
  var playerId = _str(payload.player_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };
  if (!playerId) return { ok: false, error: "player_id は必須です。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  return withLock(function () {
    var season = findRow("Seasons", "season_id", seasonId);
    if (!season) return { ok: false, error: "シーズンが見つかりません。" };

    var at = now();
    var ph = _currentProtectionPhase(season, at);

    if (ph.phase === PROTECT_PHASE_CLOSED) {
      var msg = "現在はプロテクトの受付期間外です。";
      if (ph.periods) {
        msg +=
          "無料は " + _fmtDateTime(ph.periods.freeEnd) + " まで、" +
          "有料は " + _fmtDateTime(ph.periods.paidStart) + " から受け付けます。";
      }
      return { ok: false, error: msg };
    }

    // 対象選手が自チームに在籍しているか（市場中に獲得した選手もここで通る）
    var onTeam = false;
    getSheetData("Rosters").forEach(function (r) {
      if (_str(r.season_id) !== seasonId) return;
      if (_str(r.team_id) !== teamId) return;
      if (_str(r.player_id) !== playerId) return;
      if (_str(r.status) !== ROSTER_ACTIVE) return;
      onTeam = true;
    });

    if (!onTeam) {
      return { ok: false, error: "この選手は自チームに在籍していません。" };
    }

    var usage = _protectionUsage(seasonId, ph.window, teamId);

    // 同じ選手を二重に設定しない
    for (var i = 0; i < usage.rows.length; i++) {
      if (_str(usage.rows[i].player_id) === playerId) {
        return { ok: false, error: "この選手は既にプロテクト済みです。" };
      }
    }

    var next = _nextTier(ph.phase, usage);
    if (!next) {
      var max = ph.phase === PROTECT_PHASE_FREE
        ? getConfigNum("free_protect_count", 2)
        : getConfigNum("paid_protect_count", 3);
      return {
        ok: false,
        error: ph.phase + "プロテクトの枠（" + max + "）を使い切っています。",
      };
    }

    // 有料枠は予算を確認してから計上する
    if (next.fee > 0) {
      var budget = _teamAvailableBudget(seasonId, teamId);
      if (budget.available < next.fee) {
        return {
          ok: false,
          error:
            "予算が不足しています。必要 " + next.fee.toLocaleString() +
            " / 使える予算 " + budget.available.toLocaleString(),
        };
      }
    }

    var protectionId = generateId("pr_");

    appendRow("Protections", {
      protection_id: protectionId,
      season_id:     seasonId,
      window:        ph.window,
      team_id:       teamId,
      player_id:     playerId,
      tier:          next.tier,
      fee:           next.fee,
      set_at:        at,
    });

    if (next.fee > 0) {
      appendRow("BudgetTx", {
        tx_id:      generateId("tx_"),
        season_id:  seasonId,
        team_id:    teamId,
        amount:     -next.fee,
        reason:     "プロテクト料",
        ref:        protectionId,
        created_at: at,
      });
    }

    return {
      ok: true,
      data: {
        protection_id: protectionId,
        window: ph.window,
        tier:   next.tier,
        fee:    next.fee,
        phase:  ph.phase,
      },
    };
  });
}

/**
 * 日時を「9/1 23:00」形式の短い文字列にする。エラーメッセージ用。
 *
 * @param {Date} d
 * @returns {string}
 */
function _fmtDateTime(d) {
  if (!(d instanceof Date)) return "";
  var mm = d.getMonth() + 1;
  var dd = d.getDate();
  var hh = ("0" + d.getHours()).slice(-2);
  var mi = ("0" + d.getMinutes()).slice(-2);
  return mm + "/" + dd + " " + hh + ":" + mi;
}
