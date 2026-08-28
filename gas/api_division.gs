/**
 * api_division.gs — ディビジョン管理とスーパーカップ
 *
 * 主催者専用:
 *   setSeasonDivisions — シーズンごとにチームを GM1 / GM2 へ割り当てる
 *   setSuperCup        — スーパーカップの出場2チームと配信有無を設定
 *
 * 全ロール:
 *   getSeasonDivisions — 割り当て状況と一部制/二部制の判定
 *   getSuperCup        — スーパーカップの設定内容
 *
 * 確定仕様（SPEC.md §4.16 / §4.17 / §5.6）
 *   - 参加チームが two_division_min_teams（既定15）以上のときだけ二部制にできる
 *   - 一部制では全チームが GM1
 *   - 二部制かどうかは「GM2 の行が1つでもあるか」で判定する
 *   - スーパーカップの出場チームは主催者が手動で指定する
 *   - 配信料は streamed にチェックが入ったシーズンだけ支給する
 */

// =============================================================================
// 定数
// =============================================================================

/** ディビジョン */
var DIVISION_GM1 = "GM1";
var DIVISION_GM2 = "GM2";
var DIVISIONS = [DIVISION_GM1, DIVISION_GM2];

/** 大会の識別子。得点王賞金と順位賞金の出し分けに使う */
var COMP_GM1 = "GM1リーグ";
var COMP_GM2 = "GM2リーグ";
var COMP_CUP = "GMリーグ杯";
var COMP_SUPERCUP = "GMスーパーカップ";

// =============================================================================
// ディビジョン
// =============================================================================

/**
 * シーズンのディビジョン割り当てを取得する。
 *
 * 未設定のチームは GM1 として扱う。一部制のシーズンでは全チームが GM1 になるので、
 * 割り当てを一切しなくても一部制として成立する。
 *
 * 行が1つでもあれば、それが**そのシーズンの参加チーム名簿**でもある。
 * 呼ぶ側は roster を見て「出ていたチームだけ」を並べられる。
 * 行が無いシーズンは名簿が無いという意味で、その場合は
 * 今 active なチームで代用する（従来どおり）。
 *
 * @param {string} seasonId
 * @returns {{ map: Object, memo: Object, roster: string[], twoDivision: boolean }}
 */
function _divisionsOf(seasonId) {
  var map = {};
  var memo = {};
  var roster = [];
  var twoDivision = false;

  getSheetData("SeasonTeams").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    var tid = _str(r.team_id);
    if (!tid) return;

    var div = _str(r.division) === DIVISION_GM2 ? DIVISION_GM2 : DIVISION_GM1;
    if (!map.hasOwnProperty(tid)) roster.push(tid);
    map[tid] = div;
    memo[tid] = _str(r.owner_memo);
    if (div === DIVISION_GM2) twoDivision = true;
  });

  return { map: map, memo: memo, roster: roster, twoDivision: twoDivision };
}

/**
 * チームの所属ディビジョンを返す。未設定なら GM1。
 *
 * @param {Object} divMap
 * @param {string} teamId
 * @returns {string}
 */
function _divisionOf(divMap, teamId) {
  return divMap[teamId] === DIVISION_GM2 ? DIVISION_GM2 : DIVISION_GM1;
}

/**
 * ディビジョンの割り当て状況を返す。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSeasonDivisions(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var teams = _activeTeams();
  var d = _divisionsOf(seasonId);
  var minTeams = getConfigNum("two_division_min_teams", 15);

  var rows = teams.map(function (t) {
    var tid = _str(t.team_id);
    return {
      team_id:   tid,
      team_name: _str(t.name),
      division:  _divisionOf(d.map, tid),
      assigned:  d.map.hasOwnProperty(tid),
    };
  });

  var counts = { GM1: 0, GM2: 0 };
  rows.forEach(function (r) { counts[r.division]++; });

  return {
    ok: true,
    data: {
      season_id:        seasonId,
      team_count:       teams.length,
      min_teams:        minTeams,
      can_two_division: teams.length >= minTeams,
      two_division:     d.twoDivision,
      format:           d.twoDivision ? "二部制" : "一部制",
      counts:           counts,
      teams:            rows,
    },
  };
}

/**
 * ディビジョンを割り当てる。主催者専用。
 *
 * 15チーム未満のシーズンで GM2 を指定した場合は拒否する。
 * 二部制の要件を満たさないのに片方のリーグだけ賞金が出てしまう事故を防ぐため。
 *
 * payload: { season_id, assignments: [{ team_id, division }] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setSeasonDivisions(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }

  var assignments = payload.assignments || [];
  if (assignments.length === 0) {
    return { ok: false, error: "割り当てが空です。" };
  }

  var teams = _activeTeams();
  var minTeams = getConfigNum("two_division_min_teams", 15);

  var normalized = [];
  var wantsGm2 = false;

  for (var i = 0; i < assignments.length; i++) {
    var tid = _str(assignments[i].team_id);
    var div = _str(assignments[i].division) || DIVISION_GM1;

    if (!findRow("Teams", "team_id", tid)) {
      return { ok: false, error: "チームが見つかりません: " + tid };
    }
    try {
      _assertEnum("division", div, DIVISIONS);
    } catch (e) {
      return { ok: false, error: e.message };
    }

    if (div === DIVISION_GM2) wantsGm2 = true;
    normalized.push({ team_id: tid, division: div });
  }

  if (wantsGm2 && teams.length < minTeams) {
    return {
      ok: false,
      error:
        "二部制にするには " + minTeams + " チーム以上の参加が必要です（現在 " +
        teams.length + " チーム）。全チームを GM1 にしてください。",
    };
  }

  return withLock(function () {
    // 当時のGM名は割り当てとは無関係なので、消さずに持ち越す
    var memo = _divisionsOf(seasonId).memo;

    _deleteSeasonTeamRows(seasonId);

    var rows = normalized.map(function (a) {
      return {
        season_id:  seasonId,
        team_id:    a.team_id,
        division:   a.division,
        owner_memo: memo[a.team_id] || "",
      };
    });
    _appendRowsBatch("SeasonTeams", rows);

    var counts = { GM1: 0, GM2: 0 };
    rows.forEach(function (r) { counts[r.division]++; });

    return {
      ok: true,
      data: {
        season_id: seasonId,
        counts: counts,
        two_division: counts.GM2 > 0,
        format: counts.GM2 > 0 ? "二部制" : "一部制",
      },
    };
  });
}

/**
 * 指定シーズンの SeasonTeams 行を削除する。割り当ての置き換えに使う。
 *
 * @param {string} seasonId
 * @returns {number}
 */
function _deleteSeasonTeamRows(seasonId) {
  var sheet = getSheet("SeasonTeams");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var idx = values[0].indexOf("season_id");
  if (idx === -1) return 0;

  var removed = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][idx]) === seasonId) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  return removed;
}

// =============================================================================
// スーパーカップ
// =============================================================================

/**
 * スーパーカップの設定を取得する。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSuperCup(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var row = _superCupRow(seasonId);
  var teamNames = _teamNameMap();

  // 前シーズンの王者を候補として提示する（選ぶのは主催者）
  var suggestion = _superCupSuggestion(token, seasonId);

  return {
    ok: true,
    data: {
      season_id:   seasonId,
      configured:  !!row,
      team_a:      row ? _str(row.team_a) : "",
      team_a_name: row ? (teamNames[_str(row.team_a)] || "") : "",
      team_b:      row ? _str(row.team_b) : "",
      team_b_name: row ? (teamNames[_str(row.team_b)] || "") : "",
      streamed:    row ? _toBool(row.streamed) : false,
      note:        row ? _str(row.note) : "",
      stream_fee:  getConfigNum("supercup_stream_fee", 0),
      prize_1:     getConfigNum("prize_supercup_1", 0),
      prize_2:     getConfigNum("prize_supercup_2", 0),
      suggestion:  suggestion,
    },
  };
}

/**
 * 前シーズンの GM1 王者と GMリーグ杯 王者を候補として返す。
 *
 * あくまで参考表示。同一チームが両方の王者になることもあるため、
 * 実際の出場チームは主催者が選ぶ。
 *
 * @param {string} token
 * @param {string} seasonId
 * @returns {Object|null}
 */
function _superCupSuggestion(token, seasonId) {
  var seasons = getSheetData("Seasons");
  var idx = -1;
  for (var i = 0; i < seasons.length; i++) {
    if (_str(seasons[i].season_id) === seasonId) { idx = i; break; }
  }
  if (idx <= 0) return null;

  var prev = _str(seasons[idx - 1].season_id);
  var teamNames = _teamNameMap();

  var leagueChampion = null;
  var st = getStandings(token, { season_id: prev, division: DIVISION_GM1 });
  if (st.ok) {
    var top = st.data.table.filter(function (r) { return r.rank === 1 && r.played > 0; });
    if (top.length > 0) {
      leagueChampion = { team_id: top[0].team_id, team_name: top[0].team_name };
    }
  }

  var cupChampion = null;
  var tr = getTournament(token, { season_id: prev, stage: STAGE_TOURNAMENT });
  if (tr.ok && tr.data.ties.length > 0) {
    var last = tr.data.ties[tr.data.ties.length - 1];
    if (last.winner) {
      cupChampion = { team_id: last.winner, team_name: last.winner_name };
    }
  }

  return {
    prev_season_id: prev,
    prev_season_name: _str(seasons[idx - 1].name),
    league_champion: leagueChampion,
    cup_champion: cupChampion,
    same_team: !!(leagueChampion && cupChampion && leagueChampion.team_id === cupChampion.team_id),
  };
}

/**
 * SuperCup シートから該当シーズンの行を返す。
 *
 * @param {string} seasonId
 * @returns {Object|null}
 */
function _superCupRow(seasonId) {
  var rows = getSheetData("SuperCup");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].season_id) === seasonId) return rows[i];
  }
  return null;
}

/**
 * スーパーカップの出場チームと配信有無を設定する。主催者専用。
 *
 * 配信料は streamed=true のときだけ、シーズン終了時に出場2チームへ支給される。
 *
 * payload: { season_id, team_a, team_b, streamed?, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setSuperCup(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamA = _str(payload.team_a);
  var teamB = _str(payload.team_b);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }
  if (!teamA || !teamB) return { ok: false, error: "出場チームを2つとも選んでください。" };
  if (teamA === teamB) return { ok: false, error: "同じチーム同士は対戦できません。" };
  if (!findRow("Teams", "team_id", teamA)) return { ok: false, error: "出場チーム1が見つかりません。" };
  if (!findRow("Teams", "team_id", teamB)) return { ok: false, error: "出場チーム2が見つかりません。" };

  var streamed = _toBool(payload.streamed);
  var note = _str(payload.note);

  return withLock(function () {
    var existing = _superCupRow(seasonId);

    if (existing) {
      _updateSuperCupRow(seasonId, {
        team_a: teamA, team_b: teamB, streamed: streamed, note: note,
      });
    } else {
      appendRow("SuperCup", {
        season_id: seasonId, team_a: teamA, team_b: teamB,
        streamed: streamed, note: note,
      });
    }

    return {
      ok: true,
      data: {
        season_id: seasonId, team_a: teamA, team_b: teamB,
        streamed: streamed,
        stream_fee_each: streamed ? getConfigNum("supercup_stream_fee", 0) : 0,
      },
    };
  });
}

/**
 * SuperCup の行を更新する。season_id が主キー。
 *
 * @param {string} seasonId
 * @param {Object} updates
 * @returns {boolean}
 */
function _updateSuperCupRow(seasonId, updates) {
  var sheet = getSheet("SuperCup");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return false;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][iSeason]) !== seasonId) continue;

    Object.keys(updates).forEach(function (k) {
      var col = headers.indexOf(k);
      if (col !== -1) sheet.getRange(i + 1, col + 1).setValue(updates[k]);
    });
    return true;
  }
  return false;
}
