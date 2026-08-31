/**
 * api_realtransfer.gs — 現実の移籍の反映（主催者専用）
 *
 *   getRealTransferTargets — 反映対象にできる選手と、影響を受けるチームの状況
 *   applyRealTransfers     — 大会の外へ出た選手を対象外にし、補填の請求を立てる
 *   releaseToLeagueClub    — 参加クラブ間の移籍。手放させるが選手は大会に残る
 *   restorePlayerEligible  — 誤って外した選手を戻す
 *
 * ▶ 何をする機能か
 *   Jリーグの選手が大会に参加していないクラブへ移籍した場合、その選手は
 *   **翌シーズンから使えなくなる**（SPEC.md §6.5）。
 *   その反映を1件ずつ手作業でやると計上漏れが起きるため、まとめて行う。
 *
 * ▶ 確定仕様
 *   - eligible=false にした時点で**補填の請求（Claims）を立てる**
 *   - 参加者は「払い戻し」か「自クラブの空き選手との入れ替え」を選ぶ
 *   - **入金は選択期限の翌日**。主催者が settleClaims でまとめて精算する
 *   - 離脱は**翌シーズンから**。今シーズンのスカッドと試合結果には手を触れない
 *   - 補填の母数は Rosters.acquired_cost、率は claim_rate_real_transfer（既定80%）
 *   - オークション獲得の選手は補填の対象外（シーズン終了で自動離脱するため）
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
  var rate = Number(getConfig("claim_rate_real_transfer", 0.8));

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
 * 選手をまとめて大会対象外にし、補填の請求を立てる。
 *
 * **入金はここでは行わない。** 参加者が払い戻しか入れ替えかを選び、
 * 期限の翌日に settleClaims でまとめて精算する。
 * 先に入金してしまうと、使い切ってから入れ替えを選ばれて二重取りになるため。
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
    var rate = Number(getConfig("claim_rate_real_transfer", 0.8));
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
        } else {
          // 獲得額が0でも請求は立てる。払い戻す原資は無いが、
          // 入れ替えは認める（移行で入れた「初期」の選手がこれにあたる）。
          // 請求を立てないと、手放しただけで何も受け取れない
          //
          // ここでは入金しない。参加者が払い戻しか入れ替えかを選ぶための請求を立てる
          var claim = _createClaim(
            seasonId, teamId, pid, CLAIM_REASON_TRANSFER, cost, rate, at
          );

          if (claim) {
            entry.amount = claim.refund_amount;
            entry.acquired_cost = cost;
            entry.claim_id = claim.claim_id;
            compensations.push({
              team_id: teamId, player_id: pid, name: entry.name,
              acquired_cost: cost, amount: claim.refund_amount,
              claim_id: claim.claim_id,
            });
          } else {
            entry.reason = "既に補填の請求が立っています";
          }
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
        note:           "補填はまだ入金されていません。参加者の選択後、期限の翌日に精算してください。",
        skipped:        skipped,
        rate:           rate,
      },
    };
  });
}

/**
 * 参加クラブ間の現実移籍を反映する。主催者専用。
 *
 * ▶ applyRealTransfers との違い
 *   あちらは**大会の外へ出た**選手が対象で、eligible=false にする。
 *   こちらは移った先も参加クラブなので、選手は大会に残る。
 *   変わるのは「誰が使えるか」だけ。
 *
 *   例: 三國 ケネディエブスが名古屋からアビスパ福岡へ移り、
 *       その福岡が新しくリーグへ参加した場合。
 *       名古屋は手放すが、福岡のGMは自分のクラブの選手として登録できる。
 *
 * ▶ すること
 *   1. 今の保有チームの在籍を離脱にする（すぐ空く）
 *   2. そのチームに補填の請求を立てる
 *   3. eligible はそのまま。移籍先クラブのGMが登録できる
 *
 * ⚠️ 先に名簿を同期しておくこと。
 *   移籍先が参加クラブかどうかは Players.real_club で判定する。
 *   古いままだと弾かれる。
 *
 * payload: { season_id, player_ids: string[] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function releaseToLeagueClub(token, payload) {
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

  var seen = {};
  ids = ids.filter(function (id) {
    if (seen[id]) return false;
    seen[id] = true;
    return true;
  });

  return withLock(function () {
    var rate = Number(getConfig("claim_rate_real_transfer", 0.8));
    var at = now();
    var teamNames = _teamNameMap();

    // 移った先が参加クラブであることを確かめるための一覧
    var clubToTeam = {};
    _activeTeams().forEach(function (t) {
      clubToTeam[_str(t.name)] = _str(t.team_id);
    });

    var rosterOf = {};
    getSheetData("Rosters").forEach(function (r) {
      if (_str(r.season_id) !== seasonId) return;
      if (_str(r.status) !== ROSTER_ACTIVE) return;
      rosterOf[_str(r.player_id)] = r;
    });

    var released = [];
    var claims = [];
    var skipped = [];

    for (var i = 0; i < ids.length; i++) {
      var pid = ids[i];
      var player = findRow("Players", "player_id", pid);

      if (!player) {
        skipped.push({ player_id: pid, reason: "選手が見つかりません" });
        continue;
      }

      var club = _str(player.real_club);
      var newTeamId = clubToTeam[club];

      if (!newTeamId) {
        skipped.push({
          player_id: pid, name: _str(player.name),
          reason: "現実クラブ「" + (club || "未設定") + "」は参加クラブではありません。" +
                  "大会の外へ出た選手は applyRealTransfers を使ってください。",
        });
        continue;
      }

      var roster = rosterOf[pid];

      if (!roster) {
        // 誰も持っていないなら、そのまま移籍先クラブのGMが登録できる
        skipped.push({
          player_id: pid, name: _str(player.name),
          reason: "どのチームも保有していないため、そのまま登録できます",
        });
        continue;
      }

      var teamId = _str(roster.team_id);

      if (teamId === newTeamId) {
        skipped.push({
          player_id: pid, name: _str(player.name),
          reason: "既に移籍先のチームが保有しています",
        });
        continue;
      }

      updateRow("Rosters", "roster_id", _str(roster.roster_id), {
        status: ROSTER_LEFT,
      });

      released.push({
        player_id: pid,
        name:      _str(player.name),
        position:  _str(player.position),
        from_team: teamId,
        from_name: teamNames[teamId] || teamId,
        to_club:   club,
        to_team:   newTeamId,
      });

      // オークションで預かっていた選手は補填の対象外。
      // どのみちシーズン終了で離脱するため
      if (_str(roster.acquisition_type) === METHOD_AUCTION) continue;

      var cost = _num(roster.acquired_cost);
      var claim = _createClaim(
        seasonId, teamId, pid, CLAIM_REASON_TRANSFER, cost, rate, at
      );

      if (claim) {
        claims.push({
          claim_id:      claim.claim_id,
          team_id:       teamId,
          team_name:     teamNames[teamId] || teamId,
          player_name:   _str(player.name),
          acquired_cost: cost,
          refund_amount: claim.refund_amount,
          swap_only:     claim.refund_amount <= 0,
        });
      }
    }

    return {
      ok: true,
      data: {
        season_id: seasonId,
        released:  released,
        claims:    claims,
        skipped:   skipped,
        rate:      rate,
        note: "補填はまだ入金されていません。獲得額が0円の請求は入れ替えのみ選べます。",
      },
    };
  });
}

/**
 * 誤って対象外にした選手を戻す。
 *
 * **補填の請求は自動では消さない。** 不要になった請求は voidClaim で無効にする。
 * 既に精算まで済んでいる場合は、罰金で相殺する（何が起きたか BudgetTx に残る）。
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
        note: "補填の請求は残っています。不要なら請求一覧から無効にしてください。",
      },
    };
  });
}

// =============================================================================
// 辞退・チーム変更
// =============================================================================

/**
 * 大会から抜けるクラブを処理する。
 *
 * 選手プールは「参加クラブの選手の集合」なので、クラブが抜けると
 * **そのクラブの選手は全員使えなくなる**。現実移籍と同じ扱い。
 *
 * 辞退       — チームを active=false にし、スカッドを離脱させる
 * チーム変更 — **完全にリセットして新規参加者と同じ状態にする**
 *              クラブ名を変え、スカッド全員を手放し、予算を初期値に戻す
 *
 * どちらの場合も、**旧クラブの選手を保有している他チーム**に補填の請求が立つ。
 * 抜ける本人には請求を立てない（自分の意思で抜けるため）。
 *
 * チーム変更を部分的なリセットにしないのは、旧クラブの選手だけ手放して
 * 買い集めた戦力と予算を持ち越せると、クラブを乗り換えるほうが有利になるため。
 * 新規参加者と同じ条件から始めてもらう。
 *
 * payload: { season_id, team_id, kind: '辞退' | 'チーム変更', new_club?, note? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function withdrawTeam(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  var kind = _str(payload.kind);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "team_id は必須です。" };

  try {
    _assertEnum("kind", kind, [CLAIM_REASON_WITHDRAW, CLAIM_REASON_CLUB_CHANGE]);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var newClub = _str(payload.new_club);
  if (kind === CLAIM_REASON_CLUB_CHANGE && !newClub) {
    return { ok: false, error: "変更後のクラブを選んでください。" };
  }

  return withLock(function () {
    var team = findRow("Teams", "team_id", teamId);
    if (!team) return { ok: false, error: "チームが見つかりません。" };

    var oldClub = _str(team.name);
    if (!oldClub) return { ok: false, error: "チーム名が空です。" };

    if (kind === CLAIM_REASON_CLUB_CHANGE) {
      if (newClub === oldClub) {
        return { ok: false, error: "同じクラブへは変更できません。" };
      }

      var clubError = _validateSignupClub(newClub, null);
      if (clubError) return { ok: false, error: clubError };
    }

    var rate = Number(getConfig("claim_rate_withdrawal", 0.9));
    var at = now();

    // 1. 旧クラブの選手を大会対象外にする
    var affectedPlayers = [];
    getSheetData("Players").forEach(function (p) {
      if (_str(p.real_club) !== oldClub) return;
      if (!_toBool(p.eligible)) return;
      affectedPlayers.push(_str(p.player_id));
      updateRow("Players", "player_id", _str(p.player_id), { eligible: false });
    });

    // 2. 他チームが保有している分に請求を立てる
    var claims = [];
    var teamNames = _teamNameMap();

    getSheetData("Rosters").forEach(function (r) {
      if (_str(r.season_id) !== seasonId) return;
      if (_str(r.status) !== ROSTER_ACTIVE) return;

      var holder = _str(r.team_id);
      if (holder === teamId) return;               // 抜ける本人には立てない

      var pid = _str(r.player_id);
      if (affectedPlayers.indexOf(pid) === -1) return;

      if (_str(r.acquisition_type) === METHOD_AUCTION) return;

      var cost = _num(r.acquired_cost);
      if (cost <= 0) return;

      var claim = _createClaim(seasonId, holder, pid, kind, cost, rate, at);
      if (claim) {
        claims.push({
          claim_id: claim.claim_id,
          team_id: holder,
          team_name: teamNames[holder] || holder,
          player_id: pid,
          amount: claim.refund_amount,
        });
      }
    });

    // 3. チーム自体の処理
    var released = _releaseTeamRosters(seasonId, teamId);
    var reset = null;

    if (kind === CLAIM_REASON_WITHDRAW) {
      updateRow("Teams", "team_id", teamId, { active: false });
    } else {
      updateRow("Teams", "team_id", teamId, { name: newClub, kind: "新規" });
      reset = _resetTeamForFreshStart(seasonId, teamId, at);
    }

    var total = 0;
    claims.forEach(function (c) { total += c.amount; });

    return {
      ok: true,
      data: {
        team_id:        teamId,
        kind:           kind,
        old_club:       oldClub,
        new_club:       kind === CLAIM_REASON_CLUB_CHANGE ? newClub : "",
        ineligible:     affectedPlayers.length,
        released:       released,
        claims:         claims,
        claim_total:    total,
        reset:          reset,
        note:           "補填はまだ入金されていません。参加者の選択後、期限の翌日に精算してください。",
      },
    };
  });
}

/**
 * チームを新規参加者と同じ状態に戻す。
 *
 * スカッドは呼び出し側で既に離脱させている前提。ここでは
 *   予算       — 残高を new_team_initial_budget にそろえる
 *   プロテクト — このシーズン分を削除
 *   エントリー — 提出済みの記録を削除（新しいクラブで出し直すため）
 *   移籍申請   — 進行中のものを差戻
 *   補填請求   — 未精算のものを無効化
 * を行う。
 *
 * 予算は「残高カラム」を持たない設計（原則3）なので、
 * **差額のマイナス取引を1行足して**目的の残高にそろえる。
 * 履歴を消さないので、何が起きたか後から追える。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {Date} at
 * @returns {Object} リセットの内訳
 */
function _resetTeamForFreshStart(seasonId, teamId, at) {
  // --- 予算 ---
  var balance = 0;
  getSheetData("BudgetTx").forEach(function (tx) {
    if (_str(tx.team_id) !== teamId) return;
    balance += _num(tx.amount);
  });

  var initial = getConfigNum("new_team_initial_budget", 0);

  if (balance !== initial) {
    _addBudgetTx(
      seasonId, teamId, initial - balance, REASON_TEAM_RESET,
      "チーム変更による初期化", at
    );
  }

  // --- プロテクト ---
  var protections = _deleteRowsForTeam("Protections", seasonId, teamId);

  // --- エントリー ---
  var entries = _deleteRowsForTeam("EntryLists", seasonId, teamId);

  // --- 進行中の移籍申請 ---
  var transfers = 0;
  getSheetData("Transfers").forEach(function (t) {
    if (_str(t.season_id) !== seasonId) return;
    var status = _str(t.status);
    if (status === TX_APPROVED || status === "差戻") return;
    if (_str(t.to_team) !== teamId && _str(t.from_team) !== teamId) return;

    updateRow("Transfers", "transfer_id", _str(t.transfer_id), { status: "差戻" });
    transfers++;
  });

  // --- 未精算の補填請求 ---
  var claims = 0;
  getSheetData("Claims").forEach(function (c) {
    if (_str(c.team_id) !== teamId) return;
    var status = _str(c.status);
    if (status === CLAIM_SETTLED || status === CLAIM_VOID) return;

    updateRow("Claims", "claim_id", _str(c.claim_id), { status: CLAIM_VOID });
    claims++;
  });

  return {
    budget_before: balance,
    budget_after:  initial,
    protections:   protections,
    entries:       entries,
    transfers:     transfers,
    claims:        claims,
  };
}

/**
 * 指定シーズン・チームの行を削除する。
 *
 * @param {string} sheetName
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number} 削除した行数
 */
function _deleteRowsForTeam(sheetName, seasonId, teamId) {
  var sheet = getSheet(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iTeam = headers.indexOf("team_id");
  if (iSeason === -1 || iTeam === -1) return 0;

  var count = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][iSeason]) !== seasonId) continue;
    if (String(values[i][iTeam]) !== teamId) continue;
    sheet.deleteRow(i + 1);
    count++;
  }
  return count;
}

/**
 * チームの在籍行を離脱にする。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {string[]} [onlyPlayerIds] 指定するとその選手だけ離脱させる
 * @returns {number} 離脱させた行数
 */
function _releaseTeamRosters(seasonId, teamId, onlyPlayerIds) {
  var sheet = getSheet("Rosters");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iTeam = headers.indexOf("team_id");
  var iPlayer = headers.indexOf("player_id");
  var iStatus = headers.indexOf("status");

  var count = 0;

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][iSeason]) !== seasonId) continue;
    if (String(values[i][iTeam]) !== teamId) continue;
    if (String(values[i][iStatus]) !== ROSTER_ACTIVE) continue;

    if (onlyPlayerIds && onlyPlayerIds.indexOf(String(values[i][iPlayer])) === -1) continue;

    sheet.getRange(i + 1, iStatus + 1).setValue(ROSTER_LEFT);
    count++;
  }

  return count;
}
