/**
 * api_archive.gs — 終了したシーズンをまとめて振り返る
 *
 *   listArchivedSeasons — status=終了 のシーズン一覧
 *   getSeasonArchive    — 1シーズン分の記録を1回で返す
 *
 * 何のための機能か
 *   シーズンが終わると、順位表もランキングも「その時の記録」になる。
 *   予算とスカッドは翌シーズンへ動いてしまうので、終わった時点の姿は
 *   意図して取りに行かないと二度と見られない。
 *
 * 注意 保存はしない。
 *   設計原則5のとおり、集計はシートに書かず毎回導出する。
 *   Rosters と BudgetTx はシーズンごとに行が残るので、
 *   終了したシーズンを指定すれば当時の姿がそのまま出る。
 *
 * 注意 読み取り専用。
 *   公開エンドポイント（getPublicData）には足さない。
 */

/**
 * 終了したシーズンの一覧を返す。新しい順。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listArchivedSeasons(token) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var rows = getSheetData("Seasons")
    .filter(function (s) { return _str(s.status) === "終了"; })
    .map(function (s) {
      return {
        season_id: _str(s.season_id),
        name:      _str(s.name),
        status:    _str(s.status),
      };
    });

  rows.reverse();
  return { ok: true, data: rows };
}

/**
 * 終了したシーズン1つ分の記録をまとめて返す。
 *
 * 順位表・ランキング・チームスタッツ・各チームの終了時の予算とスカッドを
 * **1回の呼び出しで**返す。画面ごとに何度も往復すると、
 * 13チーム分のスカッドを引くだけで時間がかかりすぎる。
 *
 * 予算は「終了処理の直前」ではなく、そのシーズンに記録された取引の一覧を返す。
 * 手数料や繰越もそこに含まれるので、何がいくら引かれて次へ渡ったかまで追える。
 *
 * payload: { season_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSeasonArchive(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var standings = getStandings(token, { season_id: seasonId });
  if (!standings.ok) return standings;

  var rankings = getRankings(token, { season_id: seasonId });
  if (!rankings.ok) return rankings;

  var teamStats = getTeamStats(token, { season_id: seasonId });
  if (!teamStats.ok) return teamStats;

  return {
    ok: true,
    data: {
      season_id: seasonId,
      name:      _str(season.name),
      status:    _str(season.status),
      standings: standings.data,
      rankings:  rankings.data,
      team_stats: teamStats.data,
      teams:     _archivedTeams(seasonId),
    },
  };
}

/**
 * そのシーズン終了時点の、チームごとの予算とスカッド。
 *
 * シート全体を1度ずつ読んでから振り分ける。
 * チームごとに getTeamSquad を呼ぶと13回シートを読むことになり、
 * 呼び出しが重くなって画面が待たされる。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _archivedTeams(seasonId) {
  var teamNames = _teamNameMap();

  var players = {};
  getSheetData("Players").forEach(function (p) {
    players[_str(p.player_id)] = p;
  });

  // 在籍（そのシーズンに登録されていた選手）
  var squads = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;

    var tid = _str(r.team_id);
    var pid = _str(r.player_id);
    var p = players[pid] || {};

    if (!squads[tid]) squads[tid] = [];
    squads[tid].push({
      player_id:        pid,
      name:             _str(p.name),
      position:         _str(p.position),
      detail_position:  _str(p.detail_position),
      age:              _num(p.age),
      nationality:      _normalizeNationality(p.nationality),
      foreign:          _isForeign(p.nationality),
      real_club:        _str(p.real_club),
      acquisition_type: _str(r.acquisition_type),
      acquired_cost:    _num(r.acquired_cost),
    });
  });

  // 予算（そのシーズンに記録された取引）
  var budgets = {};
  getSheetData("BudgetTx").forEach(function (t) {
    if (_str(t.season_id) !== seasonId) return;
    var tid = _str(t.team_id);
    if (!tid) return;

    if (!budgets[tid]) budgets[tid] = { total: 0, by_reason: {} };
    var amount = _num(t.amount);
    var reason = _str(t.reason);

    budgets[tid].total += amount;
    budgets[tid].by_reason[reason] = (budgets[tid].by_reason[reason] || 0) + amount;
  });

  // 使用監督
  var managers = {};
  try {
    var names = {};
    getSheetData("Managers").forEach(function (m) {
      names[_str(m.manager_id)] = _str(m.name);
    });
    getSheetData("ManagerPicks").forEach(function (p) {
      if (_str(p.season_id) !== seasonId) return;
      if (_str(p.status) !== "確定") return;
      managers[_str(p.team_id)] = names[_str(p.manager_id)] || "";
    });
  } catch (e) {
    // 監督が未設定のシーズンもある。ここで止めない
  }

  var ids = {};
  Object.keys(squads).forEach(function (t) { ids[t] = true; });
  Object.keys(budgets).forEach(function (t) { ids[t] = true; });

  return Object.keys(ids).map(function (tid) {
    var squad = squads[tid] || [];
    squad.sort(_comparePlayers);

    var counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
    var foreign = 0;
    squad.forEach(function (s) {
      if (counts.hasOwnProperty(s.position)) counts[s.position]++;
      if (s.foreign) foreign++;
    });

    var b = budgets[tid] || { total: 0, by_reason: {} };

    return {
      team_id:   tid,
      team_name: teamNames[tid] || tid,
      manager:   managers[tid] || "",
      squad:     squad,
      total:     squad.length,
      position_counts: counts,
      foreign_count:   foreign,
      budget_total:    b.total,
      budget_breakdown: Object.keys(b.by_reason).map(function (reason) {
        return { reason: reason, amount: b.by_reason[reason] };
      }),
    };
  }).sort(function (a, b) {
    return a.team_name < b.team_name ? -1 : (a.team_name > b.team_name ? 1 : 0);
  });
}
