/**
 * api_claims.gs — 補填の請求（払い戻し / 入れ替え）
 *
 * 参加者:
 *   getMyClaims  — 自分の請求と、入れ替え候補の一覧
 *   chooseClaim  — 払い戻しか入れ替えかを選ぶ
 *
 * 主催者:
 *   listClaims     — 全チームの請求一覧
 *   overrideClaim  — 参加者に代わって決める
 *   settleClaims   — 期限後にまとめて精算する（入金・選手の受け渡し）
 *   voidClaim      — 誤って立てた請求を無効にする
 *
 * ▶ どういうときに請求が立つか
 *   参加クラブでなくなったクラブの選手は使えなくなる（SPEC.md §6.5）。
 *   その選手を保有していたチームに1件ずつ請求が立つ。
 *     現実移籍   — 参加クラブ外へ移籍した   補填率 80%
 *     辞退       — その人のクラブが抜けた   補填率 90%
 *     チーム変更 — 変更前のクラブが抜けた   補填率 90%
 *
 * ▶ 参加者が選べる2択
 *   払い戻し — 獲得額 × 補填率を受け取る
 *   入れ替え — **自分の使用クラブ**の選手で、誰も保有していない人と交換する
 *              受け取った選手の獲得額は 0 として記録する
 *
 *   **獲得額が0円の選手は入れ替えしか選べない。**
 *   移行で入れた「初期」の選手など、一度も移籍で獲っていない選手には
 *   払い戻す原資が無い。0円を受け取る選択肢を出しても意味がないうえ、
 *   選んだ本人は補填を受けたつもりになってしまう。
 *
 * ▶ いつ入金されるか
 *   Seasons.claim_deadline_at が選択の期限。**期限の翌日に主催者が精算**し、
 *   新シーズンの移籍市場が開く前に入金が終わっている状態にする。
 *   期限までに選ばれなかった請求は Config の claim_default_choice を適用する。
 *
 * ⚠️ 設計原則
 *   1. 書き込みは必ず GAS 経由。金額の計算もここでしか行わない
 *   2. 期限の判定はサーバー側の new Date() で行う
 *   3. 予算は BudgetTx の SUM。精算時に1行足す
 */

// =============================================================================
// 定数
// =============================================================================

var CLAIM_REASON_TRANSFER = "大会外移籍";
var CLAIM_REASON_WITHDRAW = "辞退";
var CLAIM_REASON_CLUB_CHANGE = "チーム変更";
var CLAIM_REASONS = [CLAIM_REASON_TRANSFER, CLAIM_REASON_WITHDRAW, CLAIM_REASON_CLUB_CHANGE];

var CLAIM_CHOICE_NONE = "未選択";
var CLAIM_CHOICE_REFUND = "払い戻し";
var CLAIM_CHOICE_SWAP = "入れ替え";
var CLAIM_CHOICES = [CLAIM_CHOICE_REFUND, CLAIM_CHOICE_SWAP];

/**
 * 払い戻す原資が無い請求かどうか。
 *
 * 獲得額が0円なら、補填率を掛けても0円にしかならない。
 * 入れ替えだけを認める。
 *
 * @param {Object} claim
 * @returns {boolean}
 */
function _isSwapOnly(claim) {
  return _num(claim.refund_amount) <= 0;
}

var CLAIM_WAITING = "選択待ち";
var CLAIM_FIXED = "確定";
var CLAIM_SETTLED = "精算済";
var CLAIM_VOID = "無効";

/** BudgetTx.reason */
var REASON_CLAIM_REFUND = "補填金_払い戻し";

// =============================================================================
// 請求の生成（他のファイルから呼ぶ）
// =============================================================================

/**
 * 保有チームに補填の請求を1件立てる。
 *
 * 既に同じシーズン・チーム・選手の請求があれば作らない（二重計上の防止）。
 * **ここでは入金しない。** 精算は settleClaims で行う。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {string} playerId
 * @param {string} reason CLAIM_REASONS のいずれか
 * @param {number} baseCost 補填の母数
 * @param {number} rate 補填率
 * @param {Date} at
 * @returns {Object|null} 作った請求。作らなかった場合は null
 */
function _createClaim(seasonId, teamId, playerId, reason, baseCost, rate, at) {
  if (!seasonId || !teamId || !playerId) return null;

  var exists = false;
  getSheetData("Claims").forEach(function (c) {
    if (exists) return;
    if (_str(c.season_id) !== seasonId) return;
    if (_str(c.team_id) !== teamId) return;
    if (_str(c.player_id) !== playerId) return;
    if (_str(c.status) === CLAIM_VOID) return;
    exists = true;
  });

  if (exists) return null;

  var amount = Math.round(_num(baseCost) * _num(rate));

  var row = {
    claim_id:       generateId("cl_"),
    season_id:      seasonId,
    team_id:        teamId,
    player_id:      playerId,
    reason:         reason,
    base_cost:      Math.round(_num(baseCost)),
    rate:           rate,
    refund_amount:  amount,
    choice:         CLAIM_CHOICE_NONE,
    replacement_id: "",
    status:         CLAIM_WAITING,
    created_at:     at || now(),
    chosen_at:      "",
    chosen_by:      "",
    settled_at:     "",
  };

  appendRow("Claims", row);
  return row;
}

// =============================================================================
// 参加者向け
// =============================================================================

/**
 * 自分の請求と、入れ替えに使える選手を返す。
 *
 * payload: { season_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getMyClaims(token, payload) {
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

  var playerNames = _playerInfoMap();

  var claims = _claimsOf(seasonId)
    .filter(function (c) { return _str(c.team_id) === teamId; })
    .map(function (c) { return _claimView(c, playerNames); });

  var deadline = season.claim_deadline_at || "";
  var open = _isClaimWindowOpen(season);

  return {
    ok: true,
    data: {
      season_id:     seasonId,
      team_id:       teamId,
      team_name:     _str(team.name),
      claims:        claims,
      pending_count: claims.filter(function (c) { return c.status === CLAIM_WAITING; }).length,
      deadline:      _iso(deadline),
      window_open:   open,
      server_time:   _iso(now()),
      candidates:    _replacementCandidates(seasonId, teamId, _str(team.name)),
      default_choice: _str(getConfig("claim_default_choice", CLAIM_CHOICE_REFUND)),
    },
  };
}

/**
 * 選択の受付中かどうか。期限はサーバー時計で判定する（設計原則2）。
 *
 * 期限が未設定なら「まだ締め切っていない」とみなす。
 *
 * @param {Object} season
 * @returns {boolean}
 */
function _isClaimWindowOpen(season) {
  var deadline = season.claim_deadline_at;
  if (!deadline) return true;

  var d = deadline instanceof Date ? deadline : new Date(deadline);
  if (isNaN(d.getTime())) return true;

  return now().getTime() <= d.getTime();
}

/**
 * 入れ替えに使える選手を返す。
 *
 * **自分の使用クラブの選手**で、eligible かつ誰も保有していない人だけ。
 * 既に他の請求で入れ替え先として予約されている選手も除く。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {string} clubName
 * @returns {Object[]}
 */
function _replacementCandidates(seasonId, teamId, clubName) {
  var claimed = _collectClaimedPlayers(seasonId);

  // 他の請求で予約済みの選手
  var reserved = {};
  _claimsOf(seasonId).forEach(function (c) {
    var rid = _str(c.replacement_id);
    if (rid && _str(c.status) !== CLAIM_VOID) reserved[rid] = true;
  });

  var out = [];

  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;
    if (!_toBool(p.eligible)) return;
    if (_str(p.real_club) !== clubName) return;
    if (claimed[pid]) return;
    if (reserved[pid]) return;

    out.push({
      player_id: pid,
      name:      _str(p.name),
      position:  _str(p.position),
      detail_position: _str(p.detail_position),
      age:         _num(p.age),
      nationality: _normalizeNationality(p.nationality),
      foreign:     _isForeign(p.nationality),
      real_club: _str(p.real_club),
    });
  });

  out.sort(_comparePlayers);
  return out;
}

/**
 * 払い戻しか入れ替えかを選ぶ。
 *
 * payload: { claim_id, choice, replacement_player_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function chooseClaim(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var claimId = _str(payload.claim_id);
  var choice = _str(payload.choice);

  if (!claimId) return { ok: false, error: "claim_id は必須です。" };

  try {
    _assertEnum("choice", choice, CLAIM_CHOICES);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return withLock(function () {
    var claim = findRow("Claims", "claim_id", claimId);
    if (!claim) return { ok: false, error: "請求が見つかりません。" };

    var teamId = _str(claim.team_id);
    var access = _checkTeamAccess(user, teamId);
    if (!access.ok) return access;

    if (_str(claim.status) === CLAIM_SETTLED) {
      return { ok: false, error: "この請求は既に精算済みです。" };
    }
    if (_str(claim.status) === CLAIM_VOID) {
      return { ok: false, error: "この請求は無効になっています。" };
    }

    var seasonId = _str(claim.season_id);
    var season = findRow("Seasons", "season_id", seasonId);
    if (!season) return { ok: false, error: "シーズンが見つかりません。" };

    // 主催者は期限後でも代行できる（overrideClaim と同じ扱い）
    if (user.role !== "organizer" && !_isClaimWindowOpen(season)) {
      return {
        ok: false,
        error: "選択の期限を過ぎています。主催者に連絡してください。",
      };
    }

    return _applyChoice(claim, choice, _str(payload.replacement_player_id), user);
  });
}

/**
 * 選択内容を Claims に書き込む。chooseClaim と overrideClaim の共通処理。
 *
 * @param {Object} claim
 * @param {string} choice
 * @param {string} replacementId
 * @param {Object} user
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function _applyChoice(claim, choice, replacementId, user) {
  var claimId = _str(claim.claim_id);
  var seasonId = _str(claim.season_id);
  var teamId = _str(claim.team_id);

  // 獲得額0円の選手は払い戻す原資が無い。入れ替えだけを通す
  if (choice === CLAIM_CHOICE_REFUND && _isSwapOnly(claim)) {
    return {
      ok: false,
      error: "この選手は獲得額が0円のため払い戻しはできません。入れ替えを選んでください。",
    };
  }

  var updates = {
    choice:    choice,
    status:    CLAIM_FIXED,
    chosen_at: now(),
    chosen_by: _str(user.user_id),
  };

  if (choice === CLAIM_CHOICE_SWAP) {
    if (!replacementId) {
      return { ok: false, error: "入れ替える選手を選んでください。" };
    }

    var team = findRow("Teams", "team_id", teamId);
    if (!team) return { ok: false, error: "チームが見つかりません。" };

    var ok = false;
    _replacementCandidates(seasonId, teamId, _str(team.name)).forEach(function (c) {
      if (c.player_id === replacementId) ok = true;
    });

    if (!ok) {
      return {
        ok: false,
        error: "その選手は入れ替えに使えません（自クラブ以外・保有済み・他の請求で予約済みのいずれか）。",
      };
    }

    updates.replacement_id = replacementId;

  } else {
    // 払い戻しに切り替えたら予約を解放する
    updates.replacement_id = "";
  }

  updateRow("Claims", "claim_id", claimId, updates);

  return {
    ok: true,
    data: {
      claim_id: claimId,
      choice: choice,
      replacement_id: updates.replacement_id || "",
      refund_amount: choice === CLAIM_CHOICE_REFUND ? _num(claim.refund_amount) : 0,
      note: "精算は選択期限の翌日に主催者が行います。予算に反映されるのはそのときです。",
    },
  };
}

// =============================================================================
// 主催者向け
// =============================================================================

/**
 * 請求の一覧を返す。
 *
 * payload: { season_id, status? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listClaims(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  var wantStatus = _str(payload.status);
  var playerNames = _playerInfoMap();
  var teamNames = _teamNameMap();

  var rows = _claimsOf(seasonId)
    .filter(function (c) { return !wantStatus || _str(c.status) === wantStatus; })
    .map(function (c) {
      var v = _claimView(c, playerNames);
      v.team_name = teamNames[v.team_id] || v.team_id;
      return v;
    });

  // 選択待ちを先に、その中は古い順（放置されているものが上に来る）
  rows.sort(function (a, b) {
    var pa = a.status === CLAIM_WAITING ? 0 : 1;
    var pb = b.status === CLAIM_WAITING ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return String(a.created_at).localeCompare(String(b.created_at));
  });

  var waiting = rows.filter(function (r) { return r.status === CLAIM_WAITING; }).length;
  var fixed = rows.filter(function (r) { return r.status === CLAIM_FIXED; }).length;
  var settled = rows.filter(function (r) { return r.status === CLAIM_SETTLED; }).length;

  return {
    ok: true,
    data: {
      season_id:    seasonId,
      claims:       rows,
      waiting:      waiting,
      fixed:        fixed,
      settled:      settled,
      deadline:     _iso(season.claim_deadline_at || ""),
      window_open:  _isClaimWindowOpen(season),
      can_settle:   (waiting + fixed) > 0,
      server_time:  _iso(now()),
      default_choice: _str(getConfig("claim_default_choice", CLAIM_CHOICE_REFUND)),
    },
  };
}

/**
 * 参加者に代わって主催者が決める。
 *
 * X で本人に確認した内容を入力する用途。期限後でも使える。
 *
 * payload: { claim_id, choice, replacement_player_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function overrideClaim(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var claimId = _str(payload.claim_id);
  var choice = _str(payload.choice);

  if (!claimId) return { ok: false, error: "claim_id は必須です。" };

  try {
    _assertEnum("choice", choice, CLAIM_CHOICES);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return withLock(function () {
    var claim = findRow("Claims", "claim_id", claimId);
    if (!claim) return { ok: false, error: "請求が見つかりません。" };

    if (_str(claim.status) === CLAIM_SETTLED) {
      return { ok: false, error: "この請求は既に精算済みです。" };
    }
    if (_str(claim.status) === CLAIM_VOID) {
      return { ok: false, error: "この請求は無効になっています。" };
    }

    return _applyChoice(claim, choice, _str(payload.replacement_player_id), auth.data);
  });
}

/**
 * 請求を無効にする。誤って立てた場合に使う。
 *
 * payload: { claim_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function voidClaim(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var claimId = _str(payload.claim_id);
  if (!claimId) return { ok: false, error: "claim_id は必須です。" };

  return withLock(function () {
    var claim = findRow("Claims", "claim_id", claimId);
    if (!claim) return { ok: false, error: "請求が見つかりません。" };

    if (_str(claim.status) === CLAIM_SETTLED) {
      return { ok: false, error: "精算済みの請求は無効にできません。" };
    }

    updateRow("Claims", "claim_id", claimId, { status: CLAIM_VOID });
    return { ok: true, data: { claim_id: claimId, status: CLAIM_VOID } };
  });
}

// =============================================================================
// 精算
// =============================================================================

/**
 * 期限後にまとめて精算する。
 *
 *   払い戻し — BudgetTx に補填金を1行足す
 *   入れ替え — 交換先の選手を Rosters に在籍で追加する（獲得額0）
 *
 * 未選択のまま残っている請求には Config の claim_default_choice を適用する。
 * 既定は払い戻しで、これは「何も選ばなかった人が損をしない」ようにするため。
 *
 * 精算は**期限を過ぎてから**しか実行できない。
 * まだ選べる時間が残っているうちに締めてしまう事故を防ぐ。
 *
 * payload: { season_id, force? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function settleClaims(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません。" };

  if (_isClaimWindowOpen(season) && !_toBool(payload.force)) {
    return {
      ok: false,
      error: "まだ選択期限内です（期限: " + (_iso(season.claim_deadline_at) || "未設定") +
        "）。期限を過ぎてから精算してください。",
    };
  }

  return withLock(function () {
    var at = now();
    var defaultChoice = _str(getConfig("claim_default_choice", CLAIM_CHOICE_REFUND));

    var refunds = [];
    var swaps = [];
    var failed = [];
    var newRosters = [];

    var teamNames = _teamNameMap();
    var playerNames = _playerInfoMap();

    // 精算中に増えた在籍を見落とさないよう、予約済みの選手をここで押さえる
    var claimedNow = _collectClaimedPlayers(seasonId);

    _claimsOf(seasonId).forEach(function (c) {
      var status = _str(c.status);
      if (status === CLAIM_SETTLED || status === CLAIM_VOID) return;

      var claimId = _str(c.claim_id);
      var teamId = _str(c.team_id);
      var choice = _str(c.choice);

      // 獲得額0円の請求は入れ替えしか道が無い。既定が払い戻しでも倒さない
      var swapOnly = _isSwapOnly(c);

      if (choice !== CLAIM_CHOICE_REFUND && choice !== CLAIM_CHOICE_SWAP) {
        choice = swapOnly ? CLAIM_CHOICE_SWAP : defaultChoice;
      }
      if (choice === CLAIM_CHOICE_REFUND && swapOnly) {
        choice = CLAIM_CHOICE_SWAP;
      }

      if (choice === CLAIM_CHOICE_SWAP) {
        var rid = _str(c.replacement_id);

        // 入れ替え先が無い／既に埋まっている場合は払い戻しに倒す。
        // 精算を止めるより、金額で補償して先に進めるほうが運用が回る。
        //
        // ただし獲得額0円の請求は倒せない。倒すと0円で精算済みになり、
        // 補填を受けたことになって請求が消える。主催者が入れ替え先を
        // 決められるよう、未精算のまま残して報告する
        if (!rid || claimedNow[rid]) {
          if (swapOnly) {
            failed.push({
              claim_id: claimId,
              team_name: teamNames[teamId] || teamId,
              reason: rid
                ? "入れ替え先が既に保有されています（獲得額0円のため払い戻しにできません）"
                : "入れ替え先が未指定です（獲得額0円のため払い戻しにできません）",
              unsettled: true,
            });
            return;
          }

          failed.push({
            claim_id: claimId,
            team_name: teamNames[teamId] || teamId,
            reason: rid ? "入れ替え先が既に保有されていたため払い戻しに変更" : "入れ替え先が未指定のため払い戻しに変更",
          });
          choice = CLAIM_CHOICE_REFUND;
        } else {
          claimedNow[rid] = teamId;

          newRosters.push({
            roster_id:        generateId("r_"),
            season_id:        seasonId,
            team_id:          teamId,
            player_id:        rid,
            acquisition_type: "補填入れ替え",
            acquired_cost:    0,
            acquired_at:      at,
            expires_season:   "",
            status:           ROSTER_ACTIVE,
          });

          swaps.push({
            claim_id: claimId,
            team_id: teamId,
            team_name: teamNames[teamId] || teamId,
            lost_player: (playerNames[_str(c.player_id)] || {}).name || _str(c.player_id),
            got_player: (playerNames[rid] || {}).name || rid,
          });

          updateRow("Claims", "claim_id", claimId, {
            choice: CLAIM_CHOICE_SWAP,
            status: CLAIM_SETTLED,
            settled_at: at,
          });
          return;
        }
      }

      // 払い戻し
      var amount = Math.round(_num(c.refund_amount));

      if (amount > 0) {
        _addBudgetTx(seasonId, teamId, amount, REASON_CLAIM_REFUND, claimId, at);
      }

      refunds.push({
        claim_id: claimId,
        team_id: teamId,
        team_name: teamNames[teamId] || teamId,
        player_name: (playerNames[_str(c.player_id)] || {}).name || _str(c.player_id),
        amount: amount,
      });

      updateRow("Claims", "claim_id", claimId, {
        choice: CLAIM_CHOICE_REFUND,
        replacement_id: "",
        status: CLAIM_SETTLED,
        settled_at: at,
      });
    });

    _appendRowsBatch("Rosters", newRosters);

    var total = 0;
    refunds.forEach(function (r) { total += r.amount; });

    return {
      ok: true,
      data: {
        season_id:     seasonId,
        refunds:       refunds,
        refund_total:  total,
        swaps:         swaps,
        failed:        failed,
        settled_count: refunds.length + swaps.length,
      },
    };
  });
}

// =============================================================================
// 共通ヘルパ
// =============================================================================

/**
 * 指定シーズンの請求を返す。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _claimsOf(seasonId) {
  try {
    return getSheetData("Claims").filter(function (c) {
      return _str(c.claim_id) && _str(c.season_id) === seasonId;
    });
  } catch (e) {
    Logger.log("[_claimsOf] Claims シート読み取りエラー: " + e.message);
    return [];
  }
}

/**
 * 請求1件を画面用に整える。
 *
 * @param {Object} c
 * @param {Object} playerNames _playerInfoMap の結果
 * @returns {Object}
 */
function _claimView(c, playerNames) {
  var pid = _str(c.player_id);
  var rid = _str(c.replacement_id);
  var p = playerNames[pid] || { name: pid, position: "" };
  var r = rid ? (playerNames[rid] || { name: rid, position: "" }) : null;

  return {
    claim_id:        _str(c.claim_id),
    season_id:       _str(c.season_id),
    team_id:         _str(c.team_id),
    player_id:       pid,
    player_name:     p.name,
    position:        p.position,
    reason:          _str(c.reason),
    base_cost:       _num(c.base_cost),
    rate:            _num(c.rate),
    refund_amount:   _num(c.refund_amount),
    choice:          _str(c.choice) || CLAIM_CHOICE_NONE,
    // 獲得額0円なら払い戻す原資が無いので、画面で払い戻しを出さない
    swap_only:       _isSwapOnly(c),
    replacement_id:  rid,
    replacement_name: r ? r.name : "",
    status:          _str(c.status),
    created_at:      _iso(c.created_at),
    chosen_at:       _iso(c.chosen_at),
    settled_at:      _iso(c.settled_at),
  };
}
