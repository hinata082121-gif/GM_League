/**
 * api_realtransfer.gs — 現実の移籍の反映（主催者専用）
 *
 *   getRealTransferTargets — 反映対象にできる選手と、影響を受けるチームの状況
 *   applyRealTransfers     — 選手を大会対象外にし、補填金をその場で計上する
 *   restorePlayerEligible  — 誤って外した選手を戻す
 *
 * ▶ 何をする機能か
 *   Jリーグの選手が大会に参加していないクラブへ移籍した場合、その選手は
 *   **翌シーズンから使えなくなる**（SPEC.md §6.5）。
 *   その反映を1件ずつ手作業でやると計上漏れが起きるため、まとめて行う。
 *
 * ▶ 確定仕様
 *   - eligible=false にした**その場で**補填金を計上する
 *   - 離脱は**翌シーズンから**。今シーズンのスカッドと試合結果には手を触れない
 *   - 補填金は Rosters.acquired_cost × compensation_rate_transfer（既定80%）
 *   - オークション獲得の選手は補填金の対象外（シーズン終了で自動離脱するため）
 *
 * ⚠️ 設計原則
 *   1. 書き込みは必ず GAS 経由
 *   3. 予算は BudgetTx の SUM。補填金もここに1行足すだけ
 *   5. 承認前のデータは触らない（在籍中の Rosters のみ対象）
 */

// =============================================================================
// 対象の抽出
// =============================================================================

/**
 * 現実移籍の反映対象になりうる選手を返す。
 *
 * 「今どこかのチームが保有している選手」と「保有されていない選手」を分けて返す。
 * 保有されている選手は、外すと補填金が発生し、そのチームの翌シーズンの
 * 人数が減るため、金額と人数を先に見せる。
 *
 * payload: { season_id, keyword?, only_owned? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getRealTransferTargets(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var keyword = _str(payload.keyword).trim().toLowerCase();
  var onlyOwned = _toBool(payload.only_owned);

  var teamNames = _teamNameMap();
  var rate = Number(getConfig("compensation_rate_transfer", 0.8));

  // このシーズンで在籍中の行を player_id で引けるようにする
  var rosterOf = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;
    rosterOf[_str(r.player_id)] = r;
  });

  var players = [];

  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;

    var name = _str(p.name);
    var club = _str(p.real_club);

    if (keyword) {
      var hay = (name + " " + club).toLowerCase();
      if (hay.indexOf(keyword) === -1) return;
    }

    var roster = rosterOf[pid] || null;
    if (onlyOwned && !roster) return;

    var owned = !!roster;
    var acqType = owned ? _str(roster.acquisition_type) : "";
    var cost = owned ? _num(roster.acquired_cost) : 0;

    // オークション獲得は補填の対象外
    var payable = owned && acqType !== METHOD_AUCTION && cost > 0;

    players.push({
      player_id:      pid,
      name:           name,
      position:       _str(p.position),
      real_club:      club,
      eligible:       _toBool(p.eligible),
      owned:          owned,
      team_id:        owned ? _str(roster.team_id) : "",
      team_name:      owned ? (teamNames[_str(roster.team_id)] || "") : "",
      acquisition_type: acqType,
      acquired_cost:  cost,
      compensation:   payable ? Math.round(cost * rate) : 0,
      compensable:    payable,
    });
  });

  players.sort(_comparePlayers);

  return {
    ok: true,
    data: {
      season_id:      seasonId,
      rate:           rate,
      squad_min:      getConfigNum("squad_min", 22),
      players:        players,
      teams:          _squadSizeByTeam(seasonId),
    },
  };
}

/**
 * シーズン内の在籍人数をチームごとに数える。
 *
 * 反映前に「このチームは何人になるのか」を見せるために使う。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _squadSizeByTeam(seasonId) {
  var counts = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.status) !== ROSTER_ACTIVE) return;
    var tid = _str(r.team_id);
    counts[tid] = (counts[tid] || 0) + 1;
  });

  var teamNames = _teamNameMap();

  return _activeTeams().map(function (t) {
    var tid = _str(t.team_id);
    return {
      team_id:   tid,
      team_name: teamNames[tid] || tid,
      squad:     counts[tid] || 0,
    };
  });
}

// =============================================================================
// 反映
// =============================================================================

/**
 * 選手をまとめて大会対象外にし、補填金をその場で計上する。
 *
 * 今シーズンのスカッドと試合結果は変えない。
 * eligible=false になった選手は closeSeason の引継ぎで離脱するため、
 * 実際に使えなくなるのは翌シーズンから。
 *
 * payload: { season_id, player_ids: string[], note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function applyRealTransfers(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!findRow("Seasons", "season_id", seasonId)) {
    return { ok: false, error: "シーズンが見つかりません。" };
  }

  var ids = (payload.player_ids || [])
    .map(function (v) { return _str(v); })
    .filter(function (v) { return v; });

  if (ids.length === 0) return { ok: false, error: "対象の選手を選んでください。" };

  // 同じ選手が2回入っていても1回だけ処理する
  var seen = {};
  ids = ids.filter(function (id) {
    if (seen[id]) return false;
    seen[id] = true;
    return true;
  });

  var note = _str(payload.note);

  return withLock(function () {
    var rate = Number(getConfig("compensation_rate_transfer", 0.8));
    var at = now();

    // このシーズンの在籍行
    var rosterOf = {};
    getSheetData("Rosters").forEach(function (r) {
      if (_str(r.season_id) !== seasonId) return;
      if (_str(r.status) !== ROSTER_ACTIVE) return;
      rosterOf[_str(r.player_id)] = r;
    });

    var applied = [];
    var compensations = [];
    var skipped = [];

    for (var i = 0; i < ids.length; i++) {
      var pid = ids[i];
      var player = findRow("Players", "player_id", pid);

      if (!player) {
        skipped.push({ player_id: pid, reason: "選手が見つかりません" });
        continue;
      }

      if (!_toBool(player.eligible)) {
        skipped.push({
          player_id: pid, name: _str(player.name), reason: "既に対象外です",
        });
        continue;
      }

      updateRow("Players", "player_id", pid, { eligible: false });

      var entry = {
        player_id: pid,
        name:      _str(player.name),
        position:  _str(player.position),
        team_id:   "",
        team_name: "",
        amount:    0,
      };

      var roster = rosterOf[pid];

      if (roster) {
        var teamId = _str(roster.team_id);
        entry.team_id = teamId;

        var acqType = _str(roster.acquisition_type);
        var cost = _num(roster.acquired_cost);

        if (acqType === METHOD_AUCTION) {
          entry.reason = "オークション獲得のため補填なし";
        } else if (cost <= 0) {
          entry.reason = "獲得額が0のため補填なし";
        } else {
          var amount = Math.round(cost * rate);
          _addBudgetTx(
            seasonId, teamId, amount, REASON_COMP_TRANSFER,
            pid + (note ? " " + note : ""), at
          );
          entry.amount = amount;
          entry.acquired_cost = cost;
          compensations.push({
            team_id: teamId, player_id: pid, name: entry.name,
            acquired_cost: cost, amount: amount,
          });
        }
      } else {
        entry.reason = "どのチームも保有していないため補填なし";
      }

      applied.push(entry);
    }

    // チーム名は最後にまとめて解決する（ループ内で毎回引かない）
    var teamNames = _teamNameMap();
    applied.forEach(function (a) {
      if (a.team_id) a.team_name = teamNames[a.team_id] || a.team_id;
    });
    compensations.forEach(function (c) {
      c.team_name = teamNames[c.team_id] || c.team_id;
    });

    var total = 0;
    compensations.forEach(function (c) { total += c.amount; });

    return {
      ok: true,
      data: {
        season_id:      seasonId,
        applied:        applied,
        applied_count:  applied.length,
        compensations:  compensations,
        total_amount:   total,
        skipped:        skipped,
        rate:           rate,
      },
    };
  });
}

/**
 * 誤って対象外にした選手を戻す。
 *
 * **補填金は自動では取り消さない。** 予算の増減は履歴として残す方針のため、
 * 打ち消すなら主催者が罰金で相殺する（何が起きたか BudgetTx に残る）。
 *
 * payload: { player_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function restorePlayerEligible(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var pid = _str(payload.player_id);
  if (!pid) return { ok: false, error: "player_id は必須です。" };

  return withLock(function () {
    var player = findRow("Players", "player_id", pid);
    if (!player) return { ok: false, error: "選手が見つかりません。" };

    if (_toBool(player.eligible)) {
      return { ok: false, error: "この選手は既に大会対象です。" };
    }

    updateRow("Players", "player_id", pid, { eligible: true });

    return {
      ok: true,
      data: {
        player_id: pid,
        name: _str(player.name),
        note: "補填金は取り消していません。必要なら罰金で相殺してください。",
      },
    };
  });
}
