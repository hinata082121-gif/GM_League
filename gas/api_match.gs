/**
 * api_match.gs — Phase 5: 試合集計 の action ハンドラ
 *
 * チームオーナー向け:
 *   getMatchOptions   — 申請フォーム用（チーム・両軍の選手・GK候補）
 *   submitMatchResult — 試合結果の申請
 *
 * 全ロール:
 *   listMatches    — 試合一覧
 *   getMatchDetail — 1試合の明細（得点・シュート・GK）
 *
 * 主催者向け:
 *   approveMatch / rejectMatch / correctMatch
 *
 * ⚠️ 設計原則
 *   1. 書き込みはすべてここを通す
 *   5. 集計は status=承認 のみ。差戻の行と子テーブルは監査のため残す
 *
 * 確定仕様（SPEC.md §7.5）
 *   - Matches の行は申請時にその都度作る（日程表を事前生成しない）
 *   - 同一 season + stage + round で home/away の組み合わせが重複したら拒否
 *   - 得点者の件数はスコアと一致必須
 *   - オウンゴールは scorer_id = OWN_GOAL_ID（ランキングでは除外）
 *   - correctMatch は承認済みも含め全項目を差し替える
 */

// =============================================================================
// 定数
// =============================================================================

/** Matches.status */
var MATCH_PENDING = "申請中";
var MATCH_APPROVED = "承認";
var MATCH_REJECTED = "差戻";

/** stage */
var STAGE_LEAGUE = "league";
var STAGE_TOURNAMENT = "tournament";
var MATCH_STAGES = [STAGE_LEAGUE, STAGE_TOURNAMENT];

/**
 * オウンゴールを表す scorer_id の番兵値。
 * player_id は generateId("p_") で生成されるため衝突しない。
 * ランキング集計時はこの値を除外する（SPEC.md §10.4）。
 */
var OWN_GOAL_ID = "__OG__";

// =============================================================================
// 読み取り
// =============================================================================

/**
 * 試合結果の申請フォームに必要な情報を返す。
 *
 * home_team / away_team を指定すると、その2チームの選手一覧を返す。
 * 得点者・アシスト・GK のプルダウンに使う。
 *
 * payload: { season_id: string, home_team?: string, away_team?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getMatchOptions(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var teams = getSheetData("Teams")
    .filter(function (t) { return _toBool(t.active); })
    .map(function (t) {
      return { team_id: _str(t.team_id), name: _str(t.name) };
    });

  var data = {
    season_id:     seasonId,
    season_status: _str(season.status),
    my_team:       _str(user.team_id),
    is_organizer:  user.role === "organizer",
    teams:         teams,
    home_players:  [],
    away_players:  [],
    own_goal_id:   OWN_GOAL_ID,
  };

  var homeTeam = _str(payload.home_team);
  var awayTeam = _str(payload.away_team);

  if (homeTeam) data.home_players = _seasonPlayersOf(seasonId, homeTeam);
  if (awayTeam) data.away_players = _seasonPlayersOf(seasonId, awayTeam);

  return { ok: true, data: data };
}

/**
 * 指定シーズンに当該チームの Rosters 行がある選手を返す。
 *
 * status は問わない。シーズン途中に移籍した選手について、
 * 移籍前の試合を後から報告できるようにするため（SPEC.md §7.5）。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {Object[]}
 */
function _seasonPlayersOf(seasonId, teamId) {
  var playerInfo = {};
  getSheetData("Players").forEach(function (p) {
    playerInfo[_str(p.player_id)] = p;
  });

  var seen = {};
  var list = [];

  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.team_id) !== teamId) return;

    var pid = _str(r.player_id);
    if (seen[pid]) return;
    seen[pid] = true;

    var info = playerInfo[pid] || {};
    list.push({
      player_id: pid,
      name:      _str(info.name),
      position:  _str(info.position),
      current:   _str(r.status) === ROSTER_ACTIVE,
    });
  });

  list.sort(_comparePlayers);
  return list;
}

/**
 * 試合一覧を返す。
 *
 * payload: { season_id: string, stage?: string, status?: string, pending_only?: boolean }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listMatches(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var stage = _str(payload.stage);
  var status = _str(payload.status);
  var pendingOnly = _toBool(payload.pending_only);

  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  var myTeam = _str(user.team_id);
  var isOrganizer = user.role === "organizer";

  var rows = [];
  getSheetData("Matches").forEach(function (m) {
    if (_str(m.season_id) !== seasonId) return;
    if (stage && _str(m.stage) !== stage) return;
    if (status && _str(m.status) !== status) return;
    if (pendingOnly && _str(m.status) !== MATCH_PENDING) return;

    var home = _str(m.home_team);
    var away = _str(m.away_team);

    rows.push({
      match_id:    _str(m.match_id),
      stage:       _str(m.stage),
      round:       _str(m.round),
      tie_id:      _str(m.tie_id),
      leg:         _str(m.leg),
      home_team:   home,
      home_name:   teamNames[home] || home,
      away_team:   away,
      away_name:   teamNames[away] || away,
      home_score:  _num(m.home_score),
      away_score:  _num(m.away_score),
      home_pk:     _str(m.home_pk) === "" ? null : _num(m.home_pk),
      away_pk:     _str(m.away_pk) === "" ? null : _num(m.away_pk),
      status:      _str(m.status),
      reported_by: _str(m.reported_by),
      // 画面のボタン出し分け用
      can_edit:    _str(m.status) !== MATCH_APPROVED &&
                   (isOrganizer || myTeam === home || myTeam === away),
      can_approve: isOrganizer && _str(m.status) === MATCH_PENDING,
    });
  });

  rows.reverse();
  return { ok: true, data: rows };
}

/**
 * 1試合の明細を返す。得点・シュート・GK をまとめて取得する。
 *
 * payload: { match_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getMatchDetail(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var matchId = _str(payload.match_id);
  if (!matchId) return { ok: false, error: "match_id は必須です。" };

  var m = findRow("Matches", "match_id", matchId);
  if (!m) return { ok: false, error: "試合が見つかりません。" };

  var playerNames = {};
  getSheetData("Players").forEach(function (p) {
    playerNames[_str(p.player_id)] = _str(p.name);
  });

  var nameOf = function (pid) {
    if (pid === OWN_GOAL_ID) return "オウンゴール";
    return playerNames[pid] || pid;
  };

  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  var goals = [];
  getSheetData("MatchGoals").forEach(function (g) {
    if (_str(g.match_id) !== matchId) return;
    var sid = _str(g.scorer_id);
    var aid = _str(g.assist_id);
    goals.push({
      team_id:     _str(g.team_id),
      team_name:   teamNames[_str(g.team_id)] || _str(g.team_id),
      scorer_id:   sid,
      scorer_name: nameOf(sid),
      is_own_goal: sid === OWN_GOAL_ID,
      assist_id:   aid,
      assist_name: aid ? nameOf(aid) : "",
    });
  });

  var teamStats = [];
  getSheetData("MatchTeamStats").forEach(function (s) {
    if (_str(s.match_id) !== matchId) return;
    teamStats.push({
      team_id:         _str(s.team_id),
      team_name:       teamNames[_str(s.team_id)] || _str(s.team_id),
      shots:           _num(s.shots),
      shots_on_target: _num(s.shots_on_target),
    });
  });

  var gkStats = [];
  getSheetData("MatchGKStats").forEach(function (s) {
    if (_str(s.match_id) !== matchId) return;
    gkStats.push({
      team_id:      _str(s.team_id),
      team_name:    teamNames[_str(s.team_id)] || _str(s.team_id),
      gk_player_id: _str(s.gk_player_id),
      gk_name:      nameOf(_str(s.gk_player_id)),
      saves:        _num(s.saves),
    });
  });

  return {
    ok: true,
    data: {
      match: {
        match_id:   matchId,
        season_id:  _str(m.season_id),
        stage:      _str(m.stage),
        round:      _str(m.round),
        tie_id:     _str(m.tie_id),
        leg:        _str(m.leg),
        home_team:  _str(m.home_team),
        home_name:  teamNames[_str(m.home_team)] || _str(m.home_team),
        away_team:  _str(m.away_team),
        away_name:  teamNames[_str(m.away_team)] || _str(m.away_team),
        home_score: _num(m.home_score),
        away_score: _num(m.away_score),
        home_pk:    _str(m.home_pk) === "" ? null : _num(m.home_pk),
        away_pk:    _str(m.away_pk) === "" ? null : _num(m.away_pk),
        status:     _str(m.status),
      },
      goals: goals,
      team_stats: teamStats,
      gk_stats: gkStats,
    },
  };
}

// =============================================================================
// 検証
// =============================================================================

/**
 * 申請内容を検証する。問題があればエラーメッセージを返す。
 *
 * @param {Object} p        正規化済みの申請内容
 * @param {string} [selfId] 訂正時に自分自身を重複判定から除外する match_id
 * @returns {string|null} エラーメッセージ。問題なければ null
 */
function _validateMatchPayload(p, selfId) {
  if (MATCH_STAGES.indexOf(p.stage) === -1) {
    return "stage が不正です: " + p.stage + "（許可: league / tournament）";
  }
  if (!p.round) return "節（round）を入力してください。";
  if (!p.homeTeam || !p.awayTeam) return "対戦チームを選んでください。";
  if (p.homeTeam === p.awayTeam) return "同じチーム同士の試合は登録できません。";

  if (!findRow("Teams", "team_id", p.homeTeam)) return "ホームチームが見つかりません。";
  if (!findRow("Teams", "team_id", p.awayTeam)) return "アウェイチームが見つかりません。";

  if (p.homeScore < 0 || p.awayScore < 0) return "スコアに負の数は入力できません。";

  // 同一カード重複チェック（順不同。差戻は再申請できる）
  //
  // ⚠️ leg も比較に含める。2レグ制のトーナメントでは
  //    1stレグと2ndレグが「同じ節・同じ対戦（home/away 反転）」になるため、
  //    leg を見ないと 2ndレグが重複と誤判定されて登録できなくなる。
  var dup = null;
  getSheetData("Matches").forEach(function (m) {
    if (dup) return;
    if (_str(m.match_id) === selfId) return;
    if (_str(m.season_id) !== p.seasonId) return;
    if (_str(m.stage) !== p.stage) return;
    if (_str(m.round) !== p.round) return;
    if (_normalizeLeg(m.leg) !== _normalizeLeg(p.leg)) return;
    if (_str(m.status) === MATCH_REJECTED) return;

    var h = _str(m.home_team);
    var a = _str(m.away_team);
    var same =
      (h === p.homeTeam && a === p.awayTeam) ||
      (h === p.awayTeam && a === p.homeTeam);
    if (same) dup = m;
  });

  if (dup) {
    return (
      "同じ節・同じ対戦の試合が既に登録されています（状態: " +
      _str(dup.status) + "）。差し戻されたものは再申請できます。" +
      (p.stage === STAGE_TOURNAMENT ? "2レグ制の場合はレグ（1st / 2nd）を指定してください。" : "")
    );
  }

  // 得点者の件数とスコアの一致
  var homeGoals = 0;
  var awayGoals = 0;
  for (var i = 0; i < p.goals.length; i++) {
    var g = p.goals[i];
    if (g.team_id === p.homeTeam) homeGoals++;
    else if (g.team_id === p.awayTeam) awayGoals++;
    else return "得点の team_id が対戦チームのどちらでもありません。";
  }

  if (homeGoals !== p.homeScore) {
    return "ホームの得点者が " + homeGoals + " 件ですが、スコアは " + p.homeScore + " です。一致させてください。";
  }
  if (awayGoals !== p.awayScore) {
    return "アウェイの得点者が " + awayGoals + " 件ですが、スコアは " + p.awayScore + " です。一致させてください。";
  }

  // 得点者・アシストの所属確認
  var rosterOf = _rosterMembership(p.seasonId);

  for (var j = 0; j < p.goals.length; j++) {
    var goal = p.goals[j];

    if (goal.scorer_id === OWN_GOAL_ID) {
      if (goal.assist_id) return "オウンゴールにアシストは付けられません。";
      continue;
    }

    if (!goal.scorer_id) return "得点者を選んでください。";
    if (!rosterOf[goal.team_id + "|" + goal.scorer_id]) {
      return "得点者がそのチームに所属していません。";
    }
    if (goal.assist_id) {
      if (goal.assist_id === goal.scorer_id) {
        return "得点者とアシストが同じ選手になっています。";
      }
      if (goal.assist_id === OWN_GOAL_ID) {
        return "アシストにオウンゴールは指定できません。";
      }
      if (!rosterOf[goal.team_id + "|" + goal.assist_id]) {
        return "アシスト者がそのチームに所属していません。";
      }
    }
  }

  // シュート統計
  for (var k = 0; k < p.teamStats.length; k++) {
    var s = p.teamStats[k];
    if (s.team_id !== p.homeTeam && s.team_id !== p.awayTeam) {
      return "シュート統計の team_id が対戦チームのどちらでもありません。";
    }
    if (s.shots < 0 || s.shots_on_target < 0) {
      return "シュート数に負の数は入力できません。";
    }
    if (s.shots_on_target > s.shots) {
      return "枠内シュートがシュート数を上回っています。";
    }
  }

  // GK 統計（position=GK は必須にしない。特例の手打ち追加を許容するため）
  for (var l = 0; l < p.gkStats.length; l++) {
    var gk = p.gkStats[l];
    if (gk.team_id !== p.homeTeam && gk.team_id !== p.awayTeam) {
      return "GK 統計の team_id が対戦チームのどちらでもありません。";
    }
    if (!gk.gk_player_id) return "起用 GK を選んでください。";
    if (!rosterOf[gk.team_id + "|" + gk.gk_player_id]) {
      return "起用 GK がそのチームに所属していません。";
    }
    if (gk.saves < 0) return "セーブ数に負の数は入力できません。";
  }

  return null;
}

/**
 * leg の表記ゆれを吸収する。
 * 空文字・"-"・未入力はすべて「レグ指定なし」として同一に扱う。
 *
 * @param {*} v
 * @returns {string}
 */
function _normalizeLeg(v) {
  var s = _str(v);
  return s === "-" ? "" : s;
}

/**
 * 「team_id|player_id」をキーに、そのシーズンの在籍履歴を引けるようにする。
 * status は問わない（移籍前の試合を報告できるようにするため）。
 *
 * @param {string} seasonId
 * @returns {Object}
 */
function _rosterMembership(seasonId) {
  var map = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    map[_str(r.team_id) + "|" + _str(r.player_id)] = true;
  });
  return map;
}

/**
 * 申請 payload を正規化する。
 *
 * @param {Object} payload
 * @returns {Object}
 */
function _normalizeMatchPayload(payload) {
  var homeTeam = _str(payload.home_team);
  var awayTeam = _str(payload.away_team);

  var goals = (payload.goals || []).map(function (g) {
    return {
      team_id:   _str(g.team_id),
      scorer_id: _str(g.scorer_id),
      assist_id: _str(g.assist_id),
    };
  });

  var teamStats = (payload.team_stats || []).map(function (s) {
    return {
      team_id:         _str(s.team_id),
      shots:           Math.floor(_num(s.shots)),
      shots_on_target: Math.floor(_num(s.shots_on_target)),
    };
  });

  var gkStats = (payload.gk_stats || []).map(function (s) {
    return {
      team_id:      _str(s.team_id),
      gk_player_id: _str(s.gk_player_id),
      saves:        Math.floor(_num(s.saves)),
    };
  });

  return {
    seasonId:  _str(payload.season_id),
    stage:     _str(payload.stage) || STAGE_LEAGUE,
    round:     _str(payload.round),
    tieId:     _str(payload.tie_id),
    leg:       _str(payload.leg),
    homeTeam:  homeTeam,
    awayTeam:  awayTeam,
    homeScore: Math.floor(_num(payload.home_score)),
    awayScore: Math.floor(_num(payload.away_score)),
    homePk:    _str(payload.home_pk) === "" ? "" : Math.floor(_num(payload.home_pk)),
    awayPk:    _str(payload.away_pk) === "" ? "" : Math.floor(_num(payload.away_pk)),
    goals:     goals,
    teamStats: teamStats,
    gkStats:   gkStats,
  };
}

// =============================================================================
// 申請
// =============================================================================

/**
 * 試合結果を申請する。
 *
 * Matches + MatchGoals + MatchTeamStats + MatchGKStats をまとめて保存する。
 * status は 申請中。集計に載るのは主催者が承認してから。
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function submitMatchResult(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var p = _normalizeMatchPayload(payload);

  if (!p.seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!findRow("Seasons", "season_id", p.seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }

  // 申請できるのは当事者チームのオーナーか主催者
  var isOrganizer = user.role === "organizer";
  var myTeam = _str(user.team_id);
  if (!isOrganizer && myTeam !== p.homeTeam && myTeam !== p.awayTeam) {
    return { ok: false, error: "自チームが出場していない試合は申請できません。" };
  }

  return withLock(function () {
    var err = _validateMatchPayload(p, null);
    if (err) return { ok: false, error: err };

    var matchId = generateId("m_");

    appendRow("Matches", {
      match_id:    matchId,
      season_id:   p.seasonId,
      stage:       p.stage,
      round:       p.round,
      tie_id:      p.tieId,
      leg:         p.leg,
      home_team:   p.homeTeam,
      away_team:   p.awayTeam,
      home_score:  p.homeScore,
      away_score:  p.awayScore,
      home_pk:     p.homePk,
      away_pk:     p.awayPk,
      status:      MATCH_PENDING,
      reported_by: _str(user.user_id),
    });

    _writeMatchChildren(matchId, p);

    return {
      ok: true,
      data: { match_id: matchId, status: MATCH_PENDING },
    };
  });
}

/**
 * 子テーブル（得点・シュート・GK）を書き込む。
 * 呼び出し元で withLock 済みであること。
 *
 * @param {string} matchId
 * @param {Object} p
 */
function _writeMatchChildren(matchId, p) {
  var goalRows = p.goals.map(function (g) {
    return {
      match_id:  matchId,
      team_id:   g.team_id,
      scorer_id: g.scorer_id,
      assist_id: g.assist_id,
    };
  });

  var statRows = p.teamStats.map(function (s) {
    return {
      match_id:        matchId,
      team_id:         s.team_id,
      shots:           s.shots,
      shots_on_target: s.shots_on_target,
    };
  });

  var gkRows = p.gkStats.map(function (s) {
    return {
      match_id:     matchId,
      team_id:      s.team_id,
      gk_player_id: s.gk_player_id,
      saves:        s.saves,
    };
  });

  _appendRowsBatch("MatchGoals", goalRows);
  _appendRowsBatch("MatchTeamStats", statRows);
  _appendRowsBatch("MatchGKStats", gkRows);
}

/**
 * 指定試合の子テーブル行をすべて削除する。訂正時に使う。
 *
 * @param {string} matchId
 * @returns {number} 削除した行数
 */
function _deleteMatchChildren(matchId) {
  var total = 0;
  ["MatchGoals", "MatchTeamStats", "MatchGKStats"].forEach(function (name) {
    var sheet = getSheet(name);
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return;

    var idx = values[0].indexOf("match_id");
    if (idx === -1) return;

    for (var i = values.length - 1; i >= 1; i--) {
      if (String(values[i][idx]) === matchId) {
        sheet.deleteRow(i + 1);
        total++;
      }
    }
  });
  return total;
}

// =============================================================================
// 承認・差戻・訂正（主催者専用）
// =============================================================================

/**
 * 試合を承認する。承認された試合だけが順位表・ランキングに載る。
 *
 * payload: { match_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function approveMatch(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var matchId = _str(payload.match_id);
  if (!matchId) return { ok: false, error: "match_id は必須です。" };

  return withLock(function () {
    var m = findRow("Matches", "match_id", matchId);
    if (!m) return { ok: false, error: "試合が見つかりません。" };
    if (_str(m.status) !== MATCH_PENDING) {
      return { ok: false, error: "申請中の試合のみ承認できます（現在: " + _str(m.status) + "）。" };
    }

    updateRow("Matches", "match_id", matchId, { status: MATCH_APPROVED });
    return { ok: true, data: { match_id: matchId, status: MATCH_APPROVED } };
  });
}

/**
 * 試合を差し戻す。行と子テーブルは監査のため残す。
 *
 * payload: { match_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function rejectMatch(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var matchId = _str(payload.match_id);
  if (!matchId) return { ok: false, error: "match_id は必須です。" };

  return withLock(function () {
    var m = findRow("Matches", "match_id", matchId);
    if (!m) return { ok: false, error: "試合が見つかりません。" };
    if (_str(m.status) === MATCH_REJECTED) {
      return { ok: false, error: "既に差戻済みです。" };
    }

    updateRow("Matches", "match_id", matchId, { status: MATCH_REJECTED });
    return { ok: true, data: { match_id: matchId, status: MATCH_REJECTED } };
  });
}

/**
 * 試合を訂正する。承認済みも含め全項目を差し替える。
 *
 * 子テーブルは一度削除してから入れ直す。
 * status は指定があればそれに、無ければ元の status を維持する。
 *
 * payload: submitMatchResult と同じ + { match_id: string, status?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function correctMatch(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var matchId = _str(payload.match_id);
  if (!matchId) return { ok: false, error: "match_id は必須です。" };

  return withLock(function () {
    var m = findRow("Matches", "match_id", matchId);
    if (!m) return { ok: false, error: "試合が見つかりません。" };

    var p = _normalizeMatchPayload(payload);
    // season_id は元の試合のものを正とする（付け替えは想定しない）
    p.seasonId = _str(m.season_id);

    var err = _validateMatchPayload(p, matchId);
    if (err) return { ok: false, error: err };

    var nextStatus = _str(payload.status) || _str(m.status);
    if ([MATCH_PENDING, MATCH_APPROVED, MATCH_REJECTED].indexOf(nextStatus) === -1) {
      return { ok: false, error: "status が不正です: " + nextStatus };
    }

    updateRow("Matches", "match_id", matchId, {
      stage:      p.stage,
      round:      p.round,
      tie_id:     p.tieId,
      leg:        p.leg,
      home_team:  p.homeTeam,
      away_team:  p.awayTeam,
      home_score: p.homeScore,
      away_score: p.awayScore,
      home_pk:    p.homePk,
      away_pk:    p.awayPk,
      status:     nextStatus,
    });

    var removed = _deleteMatchChildren(matchId);
    _writeMatchChildren(matchId, p);

    return {
      ok: true,
      data: { match_id: matchId, status: nextStatus, replaced_rows: removed },
    };
  });
}
