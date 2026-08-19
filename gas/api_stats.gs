/**
 * api_stats.gs — Phase 6: 集計表示 の action ハンドラ
 *
 * 全ロールが閲覧できる読み取り専用の集計。
 *   getStandings  — リーグ順位表
 *   getTournament — トーナメント表（tie_id で2レグを束ねる）
 *   getRankings   — 得点 / アシスト / セーブ数 / シュートセーブ率
 *
 * ⚠️ 設計原則5
 *   集計対象は status=承認 の試合のみ。順位表・ランキングはシートに保存せず毎回導出する。
 *
 * 確定仕様（SPEC.md §10）
 *   - リーグ順位表はシーズン1・シーズン2を合算した1つの表
 *   - タイブレーク: 勝点 → 得失点差 → 総得点 → 直接対決（同点チーム間のミニリーグ）
 *     それでも並ぶ場合は同順位として表示する
 *   - トーナメントはアウェイゴールを採用せず合計スコアのみ。同点は PK
 *   - 得点ランキングはオウンゴール（scorer_id = OWN_GOAL_ID）を除外
 *   - シュートセーブ率は最低出場試合数（Config）を満たす GK のみ
 */

// =============================================================================
// 共通
// =============================================================================

/**
 * 指定シーズンの承認済み試合を返す。
 *
 * @param {string} seasonId
 * @param {string} [stage] 指定すると stage で絞る
 * @returns {Object[]}
 */
function _approvedMatches(seasonId, stage) {
  return getSheetData("Matches").filter(function (m) {
    if (_str(m.season_id) !== seasonId) return false;
    if (_str(m.status) !== MATCH_APPROVED) return false;
    if (stage && _str(m.stage) !== stage) return false;
    return true;
  });
}

/**
 * team_id → チーム名 の対応表を返す。
 *
 * @returns {Object}
 */
function _teamNameMap() {
  var map = {};
  getSheetData("Teams").forEach(function (t) {
    map[_str(t.team_id)] = _str(t.name);
  });
  return map;
}

/**
 * player_id → { name, position } の対応表を返す。
 *
 * @returns {Object}
 */
function _playerInfoMap() {
  var map = {};
  getSheetData("Players").forEach(function (p) {
    map[_str(p.player_id)] = { name: _str(p.name), position: _str(p.position) };
  });
  return map;
}

// =============================================================================
// 順位表
// =============================================================================

/**
 * リーグ順位表を返す。
 *
 * シーズン1・シーズン2を区別せず、承認済みのリーグ戦をすべて合算する。
 *
 * payload: { season_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getStandings(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var winPts = getConfigNum("win_points", 3);
  var drawPts = getConfigNum("draw_points", 1);

  var teamNames = _teamNameMap();
  var d = _divisionsOf(seasonId);

  // division を指定するとそのリーグだけを集計する。
  // 一部制のシーズンでは全チームが GM1 なので、指定しなくても結果は同じ。
  var division = _str(payload.division);
  var inDivision = function (teamId) {
    if (!division) return true;
    return _divisionOf(d.map, teamId) === division;
  };

  var matches = _approvedMatches(seasonId, STAGE_LEAGUE).filter(function (m) {
    return inDivision(_str(m.home_team)) && inDivision(_str(m.away_team));
  });

  // 参加チーム（active なチームは0試合でも表に出す）
  var rows = {};
  var ensure = function (tid) {
    if (!rows[tid]) {
      rows[tid] = {
        team_id: tid,
        team_name: teamNames[tid] || tid,
        played: 0, won: 0, drawn: 0, lost: 0,
        gf: 0, ga: 0, gd: 0, points: 0,
      };
    }
    return rows[tid];
  };

  getSheetData("Teams").forEach(function (t) {
    var tid = _str(t.team_id);
    if (_toBool(t.active) && inDivision(tid)) ensure(tid);
  });

  matches.forEach(function (m) {
    var home = _str(m.home_team);
    var away = _str(m.away_team);
    var hs = _num(m.home_score);
    var as = _num(m.away_score);

    var h = ensure(home);
    var a = ensure(away);

    h.played++; a.played++;
    h.gf += hs; h.ga += as;
    a.gf += as; a.ga += hs;

    if (hs > as) {
      h.won++; a.lost++;
      h.points += winPts;
    } else if (hs < as) {
      a.won++; h.lost++;
      a.points += winPts;
    } else {
      h.drawn++; a.drawn++;
      h.points += drawPts;
      a.points += drawPts;
    }
  });

  var list = Object.keys(rows).map(function (k) {
    var r = rows[k];
    r.gd = r.gf - r.ga;
    return r;
  });

  _assignStandingRanks(list, matches, winPts, drawPts);

  return {
    ok: true,
    data: {
      season_id: seasonId,
      division: division || (d.twoDivision ? "" : DIVISION_GM1),
      two_division: d.twoDivision,
      format: d.twoDivision ? "二部制" : "一部制",
      match_count: matches.length,
      win_points: winPts,
      draw_points: drawPts,
      table: list,
    },
  };
}

/**
 * 順位表を並べ替えて rank を振る。
 *
 * 比較順:
 *   1. 勝点
 *   2. 得失点差
 *   3. 総得点
 *   4. 直接対決（同点チーム同士のミニリーグ: 勝点 → 得失点差 → 総得点）
 *
 * 4段階すべて並んだ場合は同順位にする（次の順位はその分飛ぶ）。
 *
 * @param {Object[]} list    順位表の行（破壊的に並べ替える）
 * @param {Object[]} matches 承認済みリーグ戦
 * @param {number} winPts
 * @param {number} drawPts
 */
function _assignStandingRanks(list, matches, winPts, drawPts) {
  // まず上位3条件で並べる
  list.sort(function (a, b) {
    if (b.points !== a.points) return b.points - a.points;
    if (b.gd !== a.gd) return b.gd - a.gd;
    return b.gf - a.gf;
  });

  // 上位3条件が同じチームをグループにまとめ、その中を直接対決で並べ替える
  var i = 0;
  while (i < list.length) {
    var j = i + 1;
    while (
      j < list.length &&
      list[j].points === list[i].points &&
      list[j].gd === list[i].gd &&
      list[j].gf === list[i].gf
    ) {
      j++;
    }

    if (j - i > 1) {
      var group = list.slice(i, j);
      var h2h = _headToHead(group, matches, winPts, drawPts);

      group.sort(function (a, b) {
        var x = h2h[a.team_id];
        var y = h2h[b.team_id];
        if (y.points !== x.points) return y.points - x.points;
        if (y.gd !== x.gd) return y.gd - x.gd;
        return y.gf - x.gf;
      });

      group.forEach(function (g) {
        g.h2h = h2h[g.team_id];
      });

      for (var k = 0; k < group.length; k++) list[i + k] = group[k];
    }

    i = j;
  }

  // rank を振る。4条件すべて同じなら同順位
  var rank = 0;
  for (var n = 0; n < list.length; n++) {
    var same =
      n > 0 &&
      list[n].points === list[n - 1].points &&
      list[n].gd === list[n - 1].gd &&
      list[n].gf === list[n - 1].gf &&
      _sameH2H(list[n].h2h, list[n - 1].h2h);

    if (!same) rank = n + 1;
    list[n].rank = rank;
    list[n].tied = same || (n + 1 < list.length && false);
  }

  // 同順位フラグを両側に立て直す
  for (var p = 0; p < list.length; p++) {
    list[p].tied = list.filter(function (x) { return x.rank === list[p].rank; }).length > 1;
  }
}

/**
 * 直接対決の成績が同じかどうか。どちらも未算出なら同じとみなす。
 *
 * @param {Object|undefined} a
 * @param {Object|undefined} b
 * @returns {boolean}
 */
function _sameH2H(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.points === b.points && a.gd === b.gd && a.gf === b.gf;
}

/**
 * 指定チーム群の中だけで行われた試合を集計する（ミニリーグ）。
 *
 * @param {Object[]} group
 * @param {Object[]} matches
 * @param {number} winPts
 * @param {number} drawPts
 * @returns {Object} team_id → { points, gd, gf, played }
 */
function _headToHead(group, matches, winPts, drawPts) {
  var inGroup = {};
  group.forEach(function (g) { inGroup[g.team_id] = true; });

  var acc = {};
  group.forEach(function (g) {
    acc[g.team_id] = { points: 0, gf: 0, ga: 0, gd: 0, played: 0 };
  });

  matches.forEach(function (m) {
    var home = _str(m.home_team);
    var away = _str(m.away_team);
    if (!inGroup[home] || !inGroup[away]) return;

    var hs = _num(m.home_score);
    var as = _num(m.away_score);

    acc[home].played++; acc[away].played++;
    acc[home].gf += hs; acc[home].ga += as;
    acc[away].gf += as; acc[away].ga += hs;

    if (hs > as) acc[home].points += winPts;
    else if (hs < as) acc[away].points += winPts;
    else { acc[home].points += drawPts; acc[away].points += drawPts; }
  });

  Object.keys(acc).forEach(function (k) {
    acc[k].gd = acc[k].gf - acc[k].ga;
  });

  return acc;
}

// =============================================================================
// トーナメント
// =============================================================================

/**
 * トーナメント表を返す。
 *
 * tie_id が同じ試合を1つのタイとして束ね、合計スコアで勝ち上がりを判定する。
 * アウェイゴールは採用しない。合計が並んだ場合は PK で決める。
 * tie_id が空の試合は単発として1試合＝1タイ扱いにする。
 *
 * payload: { season_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getTournament(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var teamNames = _teamNameMap();

  // stage を指定できるようにする。既定は GMリーグ杯（tournament）。
  // スーパーカップは1試合なので stage=supercup で別に取得する。
  var stage = _str(payload.stage) || STAGE_TOURNAMENT;
  var matches = _approvedMatches(seasonId, stage);

  var ties = {};
  var order = [];

  matches.forEach(function (m) {
    var key = _str(m.tie_id) || "single_" + _str(m.match_id);
    if (!ties[key]) {
      ties[key] = { tie_id: _str(m.tie_id), round: _str(m.round), legs: [] };
      order.push(key);
    }
    ties[key].legs.push(m);
  });

  var result = order.map(function (key) {
    var tie = ties[key];

    // レグ順に並べる（1st → 2nd）。leg が無ければ入力順
    tie.legs.sort(function (a, b) {
      var la = _num(a.leg) || 0;
      var lb = _num(b.leg) || 0;
      return la - lb;
    });

    var first = tie.legs[0];
    // 合計は「1stレグのホーム側」を基準にする
    var teamA = _str(first.home_team);
    var teamB = _str(first.away_team);

    var aggA = 0;
    var aggB = 0;
    var pkA = null;
    var pkB = null;

    var legs = tie.legs.map(function (m) {
      var home = _str(m.home_team);
      var away = _str(m.away_team);
      var hs = _num(m.home_score);
      var as = _num(m.away_score);

      if (home === teamA) { aggA += hs; aggB += as; }
      else { aggA += as; aggB += hs; }

      // PK は入力されている試合のもの（通常は最終レグ）を採用
      if (_str(m.home_pk) !== "" && _str(m.away_pk) !== "") {
        if (home === teamA) { pkA = _num(m.home_pk); pkB = _num(m.away_pk); }
        else { pkA = _num(m.away_pk); pkB = _num(m.home_pk); }
      }

      return {
        match_id:   _str(m.match_id),
        leg:        _str(m.leg),
        round:      _str(m.round),
        home_team:  home,
        home_name:  teamNames[home] || home,
        away_team:  away,
        away_name:  teamNames[away] || away,
        home_score: hs,
        away_score: as,
        home_pk:    _str(m.home_pk) === "" ? null : _num(m.home_pk),
        away_pk:    _str(m.away_pk) === "" ? null : _num(m.away_pk),
      };
    });

    // 勝者判定（合計 → PK）
    var winner = "";
    var decided_by = "";

    if (aggA > aggB) { winner = teamA; decided_by = "合計スコア"; }
    else if (aggB > aggA) { winner = teamB; decided_by = "合計スコア"; }
    else if (pkA !== null && pkB !== null && pkA !== pkB) {
      winner = pkA > pkB ? teamA : teamB;
      decided_by = "PK戦";
    } else {
      decided_by = "未決着";
    }

    return {
      tie_id:      tie.tie_id,
      round:       tie.round,
      team_a:      teamA,
      team_a_name: teamNames[teamA] || teamA,
      team_b:      teamB,
      team_b_name: teamNames[teamB] || teamB,
      agg_a:       aggA,
      agg_b:       aggB,
      pk_a:        pkA,
      pk_b:        pkB,
      leg_count:   legs.length,
      winner:      winner,
      winner_name: winner ? (teamNames[winner] || winner) : "",
      decided_by:  decided_by,
      legs:        legs,
    };
  });

  return {
    ok: true,
    data: { season_id: seasonId, stage: stage, match_count: matches.length, ties: result },
  };
}


/**
 * 大会（competition）で承認済み試合を絞り込む。
 *
 * competition を省略するとシーズンの全試合を返す。
 * リーグ戦は出場チームのディビジョンで GM1 / GM2 を判定する。
 *
 * @param {string} seasonId
 * @param {string} [competition] COMP_GM1 / COMP_GM2 / COMP_CUP / COMP_SUPERCUP
 * @returns {Object[]}
 */
function _matchesOfCompetition(seasonId, competition) {
  if (!competition) return _approvedMatches(seasonId);

  if (competition === COMP_CUP) return _approvedMatches(seasonId, STAGE_TOURNAMENT);
  if (competition === COMP_SUPERCUP) return _approvedMatches(seasonId, STAGE_SUPERCUP);

  var wantDivision = competition === COMP_GM2 ? DIVISION_GM2 : DIVISION_GM1;
  var d = _divisionsOf(seasonId);

  return _approvedMatches(seasonId, STAGE_LEAGUE).filter(function (m) {
    return (
      _divisionOf(d.map, _str(m.home_team)) === wantDivision &&
      _divisionOf(d.map, _str(m.away_team)) === wantDivision
    );
  });
}

// =============================================================================
// ランキング
// =============================================================================

/**
 * 4種のランキングをまとめて返す。
 *
 * payload: { season_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getRankings(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  // competition を指定すると、その大会の試合だけを集計する。
  // 得点王賞金が大会別（GM1リーグ / GM2リーグ / GMリーグ杯）なので、
  // 大会ごとの得点1位を出せるようにしている。
  var competition = _str(payload.competition);
  var matches = _matchesOfCompetition(seasonId, competition);

  var approvedIds = {};
  var matchById = {};
  matches.forEach(function (m) {
    var id = _str(m.match_id);
    approvedIds[id] = true;
    matchById[id] = m;
  });

  var players = _playerInfoMap();
  var teamNames = _teamNameMap();

  var scorers = {};
  var assists = {};

  getSheetData("MatchGoals").forEach(function (g) {
    if (!approvedIds[_str(g.match_id)]) return;

    var teamId = _str(g.team_id);
    var sid = _str(g.scorer_id);
    var aid = _str(g.assist_id);

    // オウンゴールは得点ランキングに載せない（SPEC.md §10.4）
    if (sid && sid !== OWN_GOAL_ID) {
      _bumpCount(scorers, sid, teamId);
    }
    if (aid && aid !== OWN_GOAL_ID) {
      _bumpCount(assists, aid, teamId);
    }
  });

  // GK 統計
  var gkSaves = {};
  var gkFaced = {};
  var gkMatches = {};

  // 試合ごとの枠内シュート数（チーム別）
  var sotByMatch = {};
  getSheetData("MatchTeamStats").forEach(function (s) {
    var mid = _str(s.match_id);
    if (!approvedIds[mid]) return;
    if (!sotByMatch[mid]) sotByMatch[mid] = {};
    sotByMatch[mid][_str(s.team_id)] = _num(s.shots_on_target);
  });

  getSheetData("MatchGKStats").forEach(function (s) {
    var mid = _str(s.match_id);
    if (!approvedIds[mid]) return;

    var pid = _str(s.gk_player_id);
    var teamId = _str(s.team_id);
    if (!pid) return;

    var m = matchById[mid];
    var opponent = _str(m.home_team) === teamId ? _str(m.away_team) : _str(m.home_team);
    var faced = (sotByMatch[mid] || {})[opponent] || 0;

    if (!gkSaves[pid]) {
      gkSaves[pid] = { player_id: pid, team_id: teamId, saves: 0 };
      gkFaced[pid] = 0;
      gkMatches[pid] = 0;
    }
    gkSaves[pid].saves += _num(s.saves);
    gkFaced[pid] += faced;
    gkMatches[pid]++;
  });

  var decorate = function (obj, valueKey) {
    return Object.keys(obj).map(function (pid) {
      var e = obj[pid];
      var info = players[pid] || {};
      var row = {
        player_id: pid,
        name:      info.name || pid,
        position:  info.position || "",
        team_id:   e.team_id,
        team_name: teamNames[e.team_id] || e.team_id,
      };
      row[valueKey] = e.count !== undefined ? e.count : e.saves;
      return row;
    });
  };

  var goalRank = decorate(scorers, "goals");
  var assistRank = decorate(assists, "assists");
  var saveRank = decorate(gkSaves, "saves");

  goalRank.sort(function (a, b) { return b.goals - a.goals; });
  assistRank.sort(function (a, b) { return b.assists - a.assists; });
  saveRank.sort(function (a, b) { return b.saves - a.saves; });

  _assignSimpleRank(goalRank, "goals");
  _assignSimpleRank(assistRank, "assists");
  _assignSimpleRank(saveRank, "saves");

  // シュートセーブ率
  var minMatches = getConfigNum("min_matches_for_save_rate", 2);
  var rateRank = [];

  Object.keys(gkSaves).forEach(function (pid) {
    var faced = gkFaced[pid];
    var played = gkMatches[pid];
    if (played < minMatches) return;
    if (faced <= 0) return;

    var info = players[pid] || {};
    rateRank.push({
      player_id: pid,
      name:      info.name || pid,
      position:  info.position || "",
      team_id:   gkSaves[pid].team_id,
      team_name: teamNames[gkSaves[pid].team_id] || gkSaves[pid].team_id,
      saves:     gkSaves[pid].saves,
      faced:     faced,
      matches:   played,
      rate:      Math.round((gkSaves[pid].saves / faced) * 1000) / 10,
    });
  });

  rateRank.sort(function (a, b) {
    if (b.rate !== a.rate) return b.rate - a.rate;
    return b.faced - a.faced;
  });
  _assignSimpleRank(rateRank, "rate");

  return {
    ok: true,
    data: {
      season_id:   seasonId,
      competition: competition || "",
      match_count: matches.length,
      min_matches_for_save_rate: minMatches,
      goals:       goalRank,
      assists:     assistRank,
      saves:       saveRank,
      save_rate:   rateRank,
    },
  };
}

/**
 * カウント用のアキュムレータを1つ進める。
 *
 * @param {Object} acc
 * @param {string} playerId
 * @param {string} teamId
 */
function _bumpCount(acc, playerId, teamId) {
  if (!acc[playerId]) acc[playerId] = { count: 0, team_id: teamId };
  acc[playerId].count++;
}

/**
 * 値が同じなら同順位として rank を振る。
 *
 * @param {Object[]} list  ソート済みの配列
 * @param {string} key     比較に使うキー
 */
function _assignSimpleRank(list, key) {
  var rank = 0;
  for (var i = 0; i < list.length; i++) {
    if (i === 0 || list[i][key] !== list[i - 1][key]) rank = i + 1;
    list[i].rank = rank;
  }
  for (var j = 0; j < list.length; j++) {
    list[j].tied = list.filter(function (x) { return x.rank === list[j].rank; }).length > 1;
  }
}
