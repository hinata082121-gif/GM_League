/**
 * api_entrychange.gs — エントリー変更
 *
 * 参加者:
 *   getEntryChangeStatus — 外せる選手・入れられる選手・受付期間・履歴
 *   swapEntryPlayers     — 複数組をまとめて入れ替える（無償・即時反映）
 *   swapEntryPlayer      — 1組だけ入れ替える
 *   getEntryAddStatus    — エントリー追加（第一次移籍期間の初日だけ・有償）の候補・費用・履歴
 *   addEntryPlayers      — エントリー外の選手をスカッドに足す（予算から引く・即時反映）
 *
 * 主催者:
 *   listEntryChanges     — 全チームの変更履歴
 *
 * ▶ 何をする機能か
 *   エントリー済みの自クラブの選手を1人エントリー外に出し、
 *   代わりに自クラブのエントリー外の選手を1人入れる。**費用はかからない。**
 *   1対1の入れ替えなので、スカッドの人数は変わらない。
 *   **その場で確定し、すぐ反映する。** 補填のような期限後の精算も承認も無い。
 *   1チーム1シーズンで entry_change_max 名まで（既定5）。
 *
 * ▶ 補填とは別物
 *   補填は「選手が使えなくなった」ことへの埋め合わせで、請求ごとに1回だけ。
 *   エントリー変更はGMが自分の判断で行う入れ替えで、上限の人数まで何度でもできる。
 *   補填の請求が立っている選手（大会対象外の選手）はここでは外せない。
 *
 * ▶ 外せる選手
 *   - 自チームの在籍（または申請中）
 *   - 大会対象（eligible）で、補填の請求が立っていない
 *   - 期限付き・オークションで預かっている選手ではない
 *   - プロテクトしていない
 *
 *   完全移籍などで獲得した**他クラブの選手も外せる**。
 *   外した選手は、現実に在籍しているクラブのエントリー外選手に戻る。
 *   そのクラブのGMがエントリー変更や補填で入れられるようになる。
 *
 * ▶ 入れられる選手
 *   - 現実クラブが自クラブで、大会対象（eligible）
 *   - どのチームも保有していない
 *   - 補填の入れ替え先として予約されていない
 *   - スポンサーの罰則でオークション送りになっていない
 *
 * ▶ 受付期間
 *   日程表の「エントリー変更開始」の日の0:00から
 *   「エントリー変更締切」の日の23:59:59まで。**サーバー時刻で判定する**（原則2）。
 *   日程表を動かせば期間も動く。主催者は期間外でも代行できる。
 *
 * ▶ 履歴
 *   EntryChanges シートに1件ずつ残す。シートが無ければ初回に作る。
 */

// =============================================================================
// 定数
// =============================================================================

var ACQ_ENTRY_CHANGE = "エントリー変更";
var EC_LABEL_OPEN = "エントリー変更開始";
var EC_LABEL_CLOSE = "エントリー変更締切";
var EC_SHEET = "EntryChanges";
var EC_HEADERS = [
  "change_id", "season_id", "team_id",
  "out_player_id", "in_player_id", "changed_at", "changed_by",
];

// =============================================================================
// 受付期間
// =============================================================================

/**
 * エントリー変更の受付期間を日程表から求める。
 *
 * @param {string} seasonId
 * @returns {{ open: boolean, start_at: string, end_at: string, reason: string }}
 */
function _entryChangeWindow(seasonId) {
  var start = null;
  var end = null;

  _scheduleRows(seasonId).forEach(function (r) {
    var label = _str(r.label);
    var d = _asDate(r.date);
    if (!d) return;

    if (label.indexOf(EC_LABEL_OPEN) !== -1) {
      if (!start || d.getTime() < start.getTime()) start = d;
    }
    if (label.indexOf(EC_LABEL_CLOSE) !== -1) {
      if (!end || d.getTime() > end.getTime()) end = d;
    }
  });

  if (!start || !end) {
    return {
      open: false, start_at: "", end_at: "",
      reason: "日程表にエントリー変更の期間が入っていません。",
    };
  }

  var endAt = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59);
  var t = now().getTime();

  var reason = "エントリー変更を受け付けています。";
  if (t < start.getTime()) reason = "エントリー変更はまだ始まっていません。";
  if (t > endAt.getTime()) reason = "エントリー変更の期間は終わりました。";

  return {
    open: t >= start.getTime() && t <= endAt.getTime(),
    start_at: _iso(start),
    end_at: _iso(endAt),
    reason: reason,
  };
}

// =============================================================================
// 判定
// =============================================================================

/**
 * 判定に使う表をまとめて読む。1リクエストで何度も読まないため。
 *
 * @param {string} seasonId
 * @returns {Object}
 */
function _entryChangeContext(seasonId) {
  var players = {};
  getSheetData("Players").forEach(function (p) {
    players[_str(p.player_id)] = p;
  });

  var rosters = [];
  var owned = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    var st = _str(r.status);
    if (st !== ROSTER_ACTIVE && st !== ROSTER_PENDING) return;
    rosters.push(r);
    owned[_str(r.player_id)] = _str(r.team_id);
  });

  var claimed = {};
  var reserved = {};
  _claimsOf(seasonId).forEach(function (c) {
    if (_str(c.status) === CLAIM_VOID) return;
    claimed[_str(c.team_id) + "|" + _str(c.player_id)] = true;
    var rid = _str(c.replacement_id);
    if (rid) reserved[rid] = true;
  });

  var protectedSet = {};
  getSheetData("Protections").forEach(function (p) {
    if (_str(p.season_id) !== seasonId) return;
    protectedSet[_str(p.team_id) + "|" + _str(p.player_id)] = true;
  });

  return {
    players: players,
    rosters: rosters,
    owned: owned,
    pooled: _auctionPoolSet(seasonId),
    claimed: claimed,
    reserved: reserved,
    protectedSet: protectedSet,
  };
}

/**
 * 在籍行の選手を外せるか。外せなければ理由を返す。
 *
 * @param {Object} ctx
 * @param {Object} roster
 * @param {string} teamId
 * @param {string} myClub
 * @returns {string} 外せるなら空文字
 */
function _entryChangeOutBlock(ctx, roster, teamId, myClub) {
  var pid = _str(roster.player_id);
  var p = ctx.players[pid];

  if (!p) return "選手マスタに見つかりません。";
  if (!_toBool(p.eligible)) return "大会対象外です（補填で扱います）。";
  if (ctx.claimed[teamId + "|" + pid]) return "補填の請求が立っています。";
  if (EXPIRING_METHODS.indexOf(_str(roster.acquisition_type)) !== -1) {
    return "期限付き・オークションで預かっている選手は外せません。";
  }
  if (ctx.protectedSet[teamId + "|" + pid]) {
    return "プロテクト中の選手は外せません。";
  }
  return "";
}

/**
 * 入れられる選手の一覧。
 *
 * @param {Object} ctx
 * @param {string} myClub
 * @returns {Object[]}
 */
function _entryChangeCandidates(ctx, myClub) {
  var out = [];
  Object.keys(ctx.players).forEach(function (pid) {
    if (!pid) return;
    var p = ctx.players[pid];
    if (!_toBool(p.eligible)) return;
    if (_str(p.real_club) !== myClub) return;
    if (ctx.owned[pid]) return;
    if (ctx.reserved[pid]) return;
    if (ctx.pooled[pid]) return;
    out.push(_entryChangePlayerView(p));
  });
  out.sort(_comparePlayers);
  return out;
}

/**
 * 画面に出す選手情報。
 *
 * @param {Object} p Players の行
 * @returns {Object}
 */
function _entryChangePlayerView(p) {
  return {
    player_id: _str(p.player_id),
    name: _str(p.name),
    position: _str(p.position),
    detail_position: _str(p.detail_position),
    age: _num(p.age),
    nationality: _normalizeNationality(p.nationality),
    foreign: _isForeign(p.nationality),
    real_club: _str(p.real_club),
  };
}

// =============================================================================
// 参加者向け
// =============================================================================

/**
 * エントリー変更の画面に必要なものを返す。
 *
 * payload: { season_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getEntryChangeStatus(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  var team = findRow("Teams", "team_id", teamId);
  if (!team) return { ok: false, error: "チームが見つかりません。" };

  var myClub = _str(team.name);
  var ctx = _entryChangeContext(seasonId);

  var entered = ctx.rosters
    .filter(function (r) { return _str(r.team_id) === teamId; })
    .map(function (r) {
      var p = ctx.players[_str(r.player_id)] || { player_id: r.player_id, name: r.player_id };
      var v = _entryChangePlayerView(p);
      var block = _entryChangeOutBlock(ctx, r, teamId, myClub);
      v.acquisition_type = _str(r.acquisition_type);
      v.swappable = !block;
      v.reason = block;
      return v;
    });
  entered.sort(_comparePlayers);

  var win = _entryChangeWindow(seasonId);
  var max = _entryChangeMax();
  var used = _entryChangeUsed(seasonId, teamId);

  return {
    ok: true,
    data: {
      season_id: seasonId,
      team_id: teamId,
      team_name: myClub,
      window: win,
      max: max,
      used: used,
      remaining: Math.max(0, max - used),
      can_change: (win.open || user.role === "organizer") && used < max,
      entered: entered,
      candidates: _entryChangeCandidates(ctx, myClub),
      history: _entryChangeHistory(seasonId, teamId, ctx.players),
    },
  };
}

/**
 * 1組だけ入れ替える。swapEntryPlayers の1組版。
 *
 * payload: { season_id, team_id?, out_player_id, in_player_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function swapEntryPlayer(token, payload) {
  return swapEntryPlayers(token, {
    season_id: payload.season_id,
    team_id: payload.team_id,
    pairs: [{ out_player_id: payload.out_player_id, in_player_id: payload.in_player_id }],
  });
}

/**
 * 複数組をまとめて入れ替える。**その場で確定し、すぐ反映する。**
 *
 * 補填のように期限後の精算を待たない。承認も要らない。
 * 1組でも通らなければ何も書かない（途中まで入れ替わった状態を残さない）。
 *
 * 1チーム1シーズンで入れ替えられるのは entry_change_max 名まで（既定5）。
 * 数えるのは入れ替えた組の数。戻した場合もそれぞれ1名と数える。
 *
 * payload: { season_id, team_id?, pairs: [{ out_player_id, in_player_id }] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function swapEntryPlayers(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };

  var pairs = (payload.pairs || []).map(function (x) {
    return { out: _str(x && x.out_player_id), in: _str(x && x.in_player_id) };
  });
  if (pairs.length === 0) return { ok: false, error: "入れ替える選手を選んでください。" };

  for (var i = 0; i < pairs.length; i++) {
    if (!pairs[i].out || !pairs[i].in) {
      return { ok: false, error: "外す選手と入れる選手を両方選んでください（" + (i + 1) + "組目）。" };
    }
    if (pairs[i].out === pairs[i].in) return { ok: false, error: "同じ選手は選べません。" };
  }

  var outSeen = {};
  var inSeen = {};
  for (var j = 0; j < pairs.length; j++) {
    if (outSeen[pairs[j].out]) return { ok: false, error: "外す選手が重複しています。" };
    if (inSeen[pairs[j].in]) return { ok: false, error: "入れる選手が重複しています。" };
    outSeen[pairs[j].out] = true;
    inSeen[pairs[j].in] = true;
  }

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }

  if (user.role !== "organizer") {
    var win = _entryChangeWindow(seasonId);
    if (!win.open) return { ok: false, error: win.reason };
  }

  return withLock(function () {
    var team = findRow("Teams", "team_id", teamId);
    if (!team) return { ok: false, error: "チームが見つかりません。" };

    var max = _entryChangeMax();
    var used = _entryChangeUsed(seasonId, teamId);
    if (used + pairs.length > max) {
      return {
        ok: false,
        error: "エントリー変更は1シーズン " + max + " 名までです（使用済み " + used +
               " 名・残り " + Math.max(0, max - used) + " 名）。",
      };
    }

    var myClub = _str(team.name);
    var ctx = _entryChangeContext(seasonId);

    var candidateIds = {};
    _entryChangeCandidates(ctx, myClub).forEach(function (c) {
      candidateIds[c.player_id] = true;
    });

    var plan = [];
    for (var k = 0; k < pairs.length; k++) {
      var pr = pairs[k];
      var outRoster = null;
      ctx.rosters.forEach(function (r) {
        if (_str(r.team_id) === teamId && _str(r.player_id) === pr.out) outRoster = r;
      });

      var outName = ctx.players[pr.out] ? _str(ctx.players[pr.out].name) : pr.out;
      if (!outRoster) {
        return { ok: false, error: outName + " は自チームのエントリーにいません。" };
      }

      var block = _entryChangeOutBlock(ctx, outRoster, teamId, myClub);
      if (block) return { ok: false, error: outName + " は外せません: " + block };

      if (!candidateIds[pr.in]) {
        var inName = ctx.players[pr.in] ? _str(ctx.players[pr.in].name) : pr.in;
        return {
          ok: false,
          error: inName + " は入れられません（自クラブ以外・保有済み・補填で予約済み・大会対象外のいずれか）。",
        };
      }

      plan.push({ roster: outRoster, out: pr.out, in: pr.in });
    }

    var at = now();
    var sheetReady = false;
    var done = [];

    plan.forEach(function (x) {
      updateRow("Rosters", "roster_id", _str(x.roster.roster_id), { status: ROSTER_LEFT });

      appendRow("Rosters", {
        roster_id: generateId("r_"),
        season_id: seasonId,
        team_id: teamId,
        player_id: x.in,
        acquisition_type: ACQ_ENTRY_CHANGE,
        acquired_cost: 0,
        acquired_at: at,
        expires_season: "",
        status: _str(x.roster.status),
      });

      if (!sheetReady) {
        _entryChangeSheet();
        sheetReady = true;
      }

      var changeId = generateId("ec_");
      appendRow(EC_SHEET, {
        change_id: changeId,
        season_id: seasonId,
        team_id: teamId,
        out_player_id: x.out,
        in_player_id: x.in,
        changed_at: at,
        changed_by: _str(user.user_id),
      });

      done.push({
        change_id: changeId,
        out_name: _str(ctx.players[x.out].name),
        in_name: _str(ctx.players[x.in].name),
      });
    });

    return {
      ok: true,
      data: {
        changes: done,
        out_name: done[0].out_name,
        in_name: done[0].in_name,
        used: used + done.length,
        max: max,
        remaining: max - used - done.length,
      },
    };
  });
}

/**
 * 1チーム1シーズンで入れ替えられる人数の上限。Config の entry_change_max（既定5）。
 *
 * ⚠️ getConfigNum は使わない。キーが無いと空文字を Number にかけて 0 を返し、
 *   既定値が効かない。Config にキーを足していない状態で上限0になった。
 *
 * @returns {number}
 */
function _entryChangeMax() {
  var raw = _str(getConfig("entry_change_max", "")).trim();
  if (raw === "") return 5;
  var n = Number(raw);
  if (isNaN(n)) return 5;
  return Math.max(0, Math.round(n));
}

/**
 * そのチームがこのシーズンに入れ替えた人数。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number}
 */
function _entryChangeUsed(seasonId, teamId) {
  var rows;
  try {
    rows = getSheetData(EC_SHEET);
  } catch (e) {
    return 0;
  }
  return rows.filter(function (r) {
    return _str(r.season_id) === seasonId && _str(r.team_id) === teamId;
  }).length;
}

// =============================================================================
// 主催者向け
// =============================================================================

/**
 * 全チームのエントリー変更の履歴。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listEntryChanges(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var players = {};
  getSheetData("Players").forEach(function (p) { players[_str(p.player_id)] = p; });

  return {
    ok: true,
    data: {
      season_id: seasonId,
      window: _entryChangeWindow(seasonId),
      history: _entryChangeHistory(seasonId, "", players),
    },
  };
}

// =============================================================================
// 履歴
// =============================================================================

/**
 * 変更の履歴を新しい順に返す。teamId を空にすると全チーム。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {Object} players player_id → Players の行
 * @returns {Object[]}
 */
function _entryChangeHistory(seasonId, teamId, players) {
  var rows;
  try {
    rows = getSheetData(EC_SHEET);
  } catch (e) {
    return [];
  }

  var teamNames = _teamNameMap();
  var nameOf = function (pid) {
    var p = players[pid];
    return p ? _str(p.name) : pid;
  };

  return rows
    .filter(function (r) {
      if (_str(r.season_id) !== seasonId) return false;
      return !teamId || _str(r.team_id) === teamId;
    })
    .map(function (r) {
      return {
        change_id: _str(r.change_id),
        team_id: _str(r.team_id),
        team_name: teamNames[_str(r.team_id)] || _str(r.team_id),
        out_name: nameOf(_str(r.out_player_id)),
        in_name: nameOf(_str(r.in_player_id)),
        changed_at: _iso(r.changed_at),
        t: _timeValue(r.changed_at),
      };
    })
    .sort(function (a, b) { return b.t - a.t; });
}

/**
 * 履歴シートを返す。無ければ見出し付きで作る。
 *
 * setupAll を流し直さなくても使い始められるようにしている。
 *
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 */
function _entryChangeSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(EC_SHEET);
  if (sheet) return sheet;

  sheet = ss.insertSheet(EC_SHEET);
  sheet.appendRow(EC_HEADERS);
  return sheet;
}

// =============================================================================
// エントリー追加（第一次移籍期間の初日だけ・有償）
// =============================================================================
//
// ▶ 何をする機能か
//   自クラブのエントリー外の選手を、外す選手なしでスカッドに足す。有償で、
//   19歳以上は entry_add_cost_senior（既定5,000万）、
//   18歳以下は entry_add_cost_youth（既定2,500万）。
//   年齢の境目は entry_add_youth_max_age（既定18）。年齢は名簿（Players.age）の値。
//   その場で確定し、予算から引く。承認は無い。
//
// ▶ いつできるか
//   シーズンの状態が「移籍市場1」で、かつ第一次移籍期間の開幕日（window1_open_at の日付）の
//   0:00〜23:59:59 だけ。第二次移籍期間・期間外はできない。サーバー時刻で判定する（原則2）。
//   主催者は代行のため日付に関係なく行える。
//
// ▶ 追加した選手は、そのシーズンの間は他クラブへ移籍できない
//   EntryAdds に記録し、移籍の申請（_createTransfer）で弾く。
//   在籍の acquisition_type では判定しない。引継ぎが種別を翌シーズンへ持ち越すので、
//   それを見ると翌シーズン以降も永久に動かせなくなる。
//
// ▶ 継続参加・新規参加どちらも使える。スカッドの上限（squad_max）と予算の範囲内で何人でも。

var ACQ_ENTRY_ADD = "エントリー追加";
var REASON_ENTRY_ADD = "エントリー追加";
var EA_SHEET = "EntryAdds";
var EA_HEADERS = [
  "add_id", "season_id", "team_id", "player_id", "age", "cost", "added_at", "added_by",
];

/**
 * エントリー追加を受け付けているか。
 *
 * @param {Object} season Seasons の行
 * @param {Date} at
 * @returns {{ open: boolean, reason: string, day_start: string, day_end: string }}
 */
function _entryAddWindow(season, at) {
  var out = { open: false, reason: "", day_start: "", day_end: "" };

  var raw = season.window1_open_at;
  var open = raw instanceof Date ? raw : (raw ? new Date(raw) : null);
  if (open && isNaN(open.getTime())) open = null;

  if (open) {
    var start = new Date(open.getFullYear(), open.getMonth(), open.getDate(), 0, 0, 0);
    var end = new Date(open.getFullYear(), open.getMonth(), open.getDate(), 23, 59, 59);
    out.day_start = _iso(start);
    out.day_end = _iso(end);
  }

  if (_str(season.status) !== "移籍市場1") {
    out.reason = "エントリー追加は第一次移籍期間の初日だけです（現在の状態: " + _str(season.status) + "）。";
    return out;
  }
  if (!open) {
    out.reason = "第一次移籍期間の開幕日時が設定されていないため、初日が決まりません。主催者に確認してください。";
    return out;
  }

  var t = at.getTime();
  if (t < new Date(out.day_start).getTime()) {
    out.reason = "エントリー追加は第一次移籍期間の初日（" + _mdText(open) + "）からです。";
    return out;
  }
  if (t > new Date(out.day_end).getTime()) {
    out.reason = "エントリー追加は第一次移籍期間の初日（" + _mdText(open) + "）だけで、受付は終わりました。";
    return out;
  }

  out.open = true;
  out.reason = "エントリー追加を受け付けています（" + _mdText(open) + " 23:59 まで）。";
  return out;
}

/**
 * 年齢から追加費用を決める。年齢が名簿に無ければ null。
 *
 * @param {*} age
 * @returns {{ cost: number, youth: boolean }|null}
 */
function _entryAddCost(age) {
  var a = _num(age);
  if (!(a > 0)) return null;
  var youthMax = getConfigNumOr("entry_add_youth_max_age", 18);
  var youth = a <= youthMax;
  return {
    cost: youth ? getConfigNumOr("entry_add_cost_youth", 25000000)
                : getConfigNumOr("entry_add_cost_senior", 50000000),
    youth: youth,
  };
}

/**
 * EntryAdds の行。シートが無ければ空。
 *
 * @returns {Object[]}
 */
function _entryAddRows() {
  try {
    return getSheetData(EA_SHEET);
  } catch (e) {
    return [];
  }
}

/**
 * そのシーズンにエントリー追加した選手。player_id → team_id。
 *
 * @param {string} seasonId
 * @returns {Object}
 */
function _entryAddedMap(seasonId) {
  var map = {};
  _entryAddRows().forEach(function (r) {
    if (_str(r.season_id) === seasonId) map[_str(r.player_id)] = _str(r.team_id);
  });
  return map;
}

/**
 * 移籍できない理由（エントリー追加した選手）。移籍できるなら空文字。
 *
 * @param {string} seasonId
 * @param {string} playerId
 * @returns {string}
 */
function _entryAddTransferBlock(seasonId, playerId) {
  return _entryAddedMap(seasonId)[playerId]
    ? "この選手は今シーズン「エントリー追加」で登録したため、今シーズン中は他クラブへ移籍できません。"
    : "";
}

/** EntryAdds シートを用意する（無ければ作る） */
function _entryAddSheet() {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(EA_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(EA_SHEET);
  sheet.appendRow(EA_HEADERS);
  return sheet;
}

/**
 * 追加できる選手。エントリー変更で入れられる選手から、承認待ちの移籍がある選手を除く。
 *
 * @param {Object} ctx _entryChangeContext の結果
 * @param {string} myClub
 * @param {Object[]} pending 申請中の移籍
 * @returns {Object[]}
 */
function _entryAddCandidates(ctx, myClub, pending) {
  var busy = {};
  (pending || []).forEach(function (t) { busy[_str(t.player_id)] = true; });
  return _entryChangeCandidates(ctx, myClub)
    .filter(function (c) { return !busy[c.player_id]; })
    .map(function (c) {
      var price = _entryAddCost(c.age);
      c.cost = price ? price.cost : null;
      c.youth = price ? price.youth : false;
      c.reason = price ? "" : "名簿に年齢が無いため費用が決まりません。";
      return c;
    });
}

/**
 * エントリー追加の画面に必要なものを返す。
 *
 * payload: { season_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getEntryAddStatus(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };
  var team = findRow("Teams", "team_id", teamId);
  if (!team) return { ok: false, error: "チームが見つかりません。" };

  var myClub = _str(team.name);
  var win = _entryAddWindow(season, now());
  var pending = _pendingTransfers(seasonId);
  var ctx = _entryChangeContext(seasonId);

  var history = _entryAddRows()
    .filter(function (r) { return _str(r.season_id) === seasonId && _str(r.team_id) === teamId; })
    .map(function (r) {
      var p = ctx.players[_str(r.player_id)] || {};
      return {
        player_id: _str(r.player_id),
        name: _str(p.name) || _str(r.player_id),
        position: _str(p.position),
        age: _num(r.age),
        cost: _num(r.cost),
        added_at: r.added_at instanceof Date ? _iso(r.added_at) : _str(r.added_at),
      };
    });

  var isOrg = user.role === "organizer";
  return {
    ok: true,
    data: {
      season_id: seasonId,
      team_id: teamId,
      team_name: myClub,
      window: win,
      can_add: win.open || isOrg,
      organizer_override: isOrg && !win.open,
      cost_senior: getConfigNumOr("entry_add_cost_senior", 50000000),
      cost_youth: getConfigNumOr("entry_add_cost_youth", 25000000),
      youth_max_age: getConfigNumOr("entry_add_youth_max_age", 18),
      budget: _teamAvailableBudget(seasonId, teamId, pending),
      squad: _teamSquadCount(seasonId, teamId, pending),
      squad_max: getConfigNum("squad_max", 35),
      candidates: _entryAddCandidates(ctx, myClub, pending),
      history: history,
    },
  };
}

/**
 * 自クラブのエントリー外の選手をスカッドに足す。**その場で確定し、予算から引く。**
 * 1人でも通らなければ何も書かない。
 *
 * payload: { season_id, team_id?, player_ids: string[] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function addEntryPlayers(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };

  var ids = [];
  var seen = {};
  (payload.player_ids || []).forEach(function (x) {
    var id = _str(x);
    if (id && !seen[id]) { seen[id] = true; ids.push(id); }
  });
  if (ids.length === 0) return { ok: false, error: "追加する選手を選んでください。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  return withLock(function () {
    var season = findRow("Seasons", "season_id", seasonId);
    if (!season) return { ok: false, error: "シーズンが見つかりません。" };

    var at = now();
    if (user.role !== "organizer") {
      var win = _entryAddWindow(season, at);
      if (!win.open) return { ok: false, error: win.reason };
    }

    var team = findRow("Teams", "team_id", teamId);
    if (!team) return { ok: false, error: "チームが見つかりません。" };

    var myClub = _str(team.name);
    var pending = _pendingTransfers(seasonId);
    var ctx = _entryChangeContext(seasonId);
    var byId = {};
    _entryAddCandidates(ctx, myClub, pending).forEach(function (c) { byId[c.player_id] = c; });

    var plan = [];
    var total = 0;
    for (var i = 0; i < ids.length; i++) {
      var c = byId[ids[i]];
      var name = ctx.players[ids[i]] ? _str(ctx.players[ids[i]].name) : ids[i];
      if (!c) {
        return {
          ok: false,
          error: name + " は追加できません（自クラブ以外・保有済み・補填で予約済み・承認待ちの移籍あり・大会対象外のいずれか）。",
        };
      }
      if (c.cost === null) return { ok: false, error: name + " は" + c.reason };
      plan.push(c);
      total += c.cost;
    }

    var budget = _teamAvailableBudget(seasonId, teamId, pending);
    if (budget.available < total) {
      return {
        ok: false,
        error: "予算が不足しています。必要 " + total.toLocaleString() +
          " / 使える予算 " + budget.available.toLocaleString() +
          "（残高 " + budget.balance.toLocaleString() +
          " − 承認待ち " + budget.reserved.toLocaleString() + "）",
      };
    }

    var squadMax = getConfigNum("squad_max", 35);
    var squad = _teamSquadCount(seasonId, teamId, pending);
    if (squad.projected + plan.length > squadMax) {
      return {
        ok: false,
        error: "スカッドが上限 " + squadMax + " 名を超えます（承認待ちを含めて今 " +
          squad.projected + " 名、追加 " + plan.length + " 名）。",
      };
    }

    _entryAddSheet();
    var done = [];
    plan.forEach(function (c) {
      appendRow("Rosters", {
        roster_id: generateId("r_"),
        season_id: seasonId,
        team_id: teamId,
        player_id: c.player_id,
        acquisition_type: ACQ_ENTRY_ADD,
        acquired_cost: c.cost,
        acquired_at: at,
        expires_season: "",
        status: ROSTER_ACTIVE,
      });
      _addBudgetTx(seasonId, teamId, -c.cost, REASON_ENTRY_ADD, c.name, at);
      appendRow(EA_SHEET, {
        add_id: generateId("ea_"),
        season_id: seasonId,
        team_id: teamId,
        player_id: c.player_id,
        age: c.age,
        cost: c.cost,
        added_at: at,
        added_by: _str(user.user_id),
      });
      done.push({ player_id: c.player_id, name: c.name, age: c.age, cost: c.cost });
    });

    return {
      ok: true,
      data: { added: done, total: total, available_after: budget.available - total },
    };
  });
}
