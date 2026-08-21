/**
 * api_sponsor.gs — スポンサー
 *
 * 参加者:
 *   getSponsorOptions — 選べるスポンサーと自分の契約
 *   chooseSponsor     — スポンサーと契約する
 *
 * 主催者:
 *   listSponsors      — そのシーズンのスポンサー一覧と契約状況
 *   upsertSponsor     — スポンサーの登録・修正
 *   deleteSponsor     — スポンサーの削除
 *   copySponsors      — 前シーズンの設定を複製する
 *   setSponsorOpen    — 受付の開閉
 *   clearTeamSponsor  — 契約の取消
 *
 * ▶ 仕組み
 *   スポンサーには3つの要素がある。
 *
 *     契約金 — 契約した**その場で**チーム予算に入る
 *     ノルマ — リーグ順位、または GMリーグ杯の成績
 *     罰則   — ノルマ未達なら罰金。**シーズン終了時に引かれる**
 *
 *   「今もらえる額」と「達成できなかったときの痛み」を天秤にかけて選ぶ。
 *   契約金が大きいものほどノルマも罰金も重い、という設計を想定している。
 *
 * ▶ 確定仕様
 *   - **1チーム1社。** 契約金を積み上げられると判断が単純になりすぎるため
 *   - **同じスポンサーを何チームでも契約できる。** 枠の取り合いにはしない
 *   - スポンサーは**シーズンごとに設定する**。前シーズンから複製できる
 *   - ノルマの判定は closeSeason で自動。順位表とリーグ杯の結果から決める
 *
 * ⚠️ 設計原則
 *   1. 書き込みは必ず GAS 経由。契約金も罰金もここでしか計上しない
 *   3. 予算は BudgetTx の SUM。契約金と罰金はそれぞれ1行足すだけ
 *   5. 判定は承認済みの試合から導いた順位・結果だけを見る
 */

// =============================================================================
// 定数
// =============================================================================

var SPONSOR_QUOTA_NONE = "なし";
var SPONSOR_QUOTA_RANK = "リーグ順位";
var SPONSOR_QUOTA_CUP = "リーグ杯";
var SPONSOR_QUOTA_TYPES = [SPONSOR_QUOTA_NONE, SPONSOR_QUOTA_RANK, SPONSOR_QUOTA_CUP];

/** リーグ杯のノルマとして選べる値。上にあるほど厳しい */
var SPONSOR_CUP_GOALS = ["優勝", "準優勝以上", "ベスト4以上"];

/** 解放条件の種別 */
var SPONSOR_UNLOCK_NONE = "なし";
var SPONSOR_UNLOCK_RANK = "順位";
var SPONSOR_UNLOCK_LIST = "指定";
var SPONSOR_UNLOCK_TYPES = [SPONSOR_UNLOCK_NONE, SPONSOR_UNLOCK_RANK, SPONSOR_UNLOCK_LIST];

var SPONSOR_RESULT_NONE = "未判定";
var SPONSOR_RESULT_MET = "達成";
var SPONSOR_RESULT_MISS = "未達";

/** BudgetTx.reason */
var REASON_SPONSOR_FEE = "スポンサー契約金";
var REASON_SPONSOR_PENALTY = "スポンサーノルマ未達";

// =============================================================================
// 受付状態
// =============================================================================

/**
 * スポンサーの受付中かどうか。
 *
 * @returns {boolean}
 */
function _isSponsorOpen() {
  return _toBool(getConfig("sponsor_open", false));
}

/**
 * 受付を開閉する。主催者専用。
 *
 * payload: { open }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setSponsorOpen(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var open = _toBool(payload.open);

  return withLock(function () {
    var res = setConfig(token, { key: "sponsor_open", value: open });
    if (!res.ok) return res;
    return { ok: true, data: { open: open } };
  });
}

// =============================================================================
// 参加者向け
// =============================================================================

/**
 * 選べるスポンサーと自分の契約を返す。
 *
 * payload: { season_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getSponsorOptions(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  var teamNames = _teamNameMap();
  var sponsors = _sponsorsOf(seasonId).filter(function (s) { return s.active; });

  // 何チームが契約しているかを添える。埋まって選べなくなることはないが、
  // 「他がどれを選んでいるか」は判断材料になる
  var counts = {};
  _contractsOf(seasonId).forEach(function (c) {
    var sid = _str(c.sponsor_id);
    counts[sid] = (counts[sid] || 0) + 1;
  });

  var mine = _contractOfTeam(seasonId, teamId);
  var rankCache = {};

  return {
    ok: true,
    data: {
      season_id:   seasonId,
      team_id:     teamId,
      team_name:   teamNames[teamId] || teamId,
      open:        _isSponsorOpen(),
      sponsors:    sponsors.map(function (s) {
        var u = _isUnlocked(s, teamId, rankCache);

        return {
          sponsor_id:   s.sponsor_id,
          name:         s.name,
          contract_fee: s.contract_fee,
          quota_type:   s.quota_type,
          quota_value:  s.quota_value,
          quota_type2:  s.quota_type2,
          quota_value2: s.quota_value2,
          quota_label:  _quotaLabel(s),
          penalty:      s.penalty,
          unlock_label: _unlockLabel(s),
          unlocked:     u.unlocked,
          unlock_reason: u.reason,
          note:         s.note,
          contracted:   counts[s.sponsor_id] || 0,
          is_mine:      !!mine && _str(mine.sponsor_id) === s.sponsor_id,
        };
      }),
      my_contract: mine ? _contractView(mine, sponsors) : null,
    },
  };
}

/**
 * ノルマを1行の文にする。
 *
 * @param {Object} s Sponsors の行（整形済み）
 * @returns {string}
 */
function _quotaLabel(s) {
  var parts = [_oneQuotaLabel(s.quota_type, s.quota_value)];

  if (s.quota_type2 && s.quota_type2 !== SPONSOR_QUOTA_NONE) {
    parts.push(_oneQuotaLabel(s.quota_type2, s.quota_value2));
  }

  parts = parts.filter(function (p) { return p; });
  if (parts.length === 0) return "ノルマなし";

  // 2つあるときは「どちらか達成すればよい」ことが一目で分かるようにする
  return parts.join(" または ");
}

/**
 * ノルマ1つぶんの文言。
 *
 * @param {string} type
 * @param {string} value
 * @returns {string}
 */
function _oneQuotaLabel(type, value) {
  if (type === SPONSOR_QUOTA_RANK) return "リーグ戦 " + value + "位以内";
  if (type === SPONSOR_QUOTA_CUP) return "GMリーグ杯 " + value;
  return "";
}

/**
 * 解放条件を1行の文にする。
 *
 * @param {Object} s
 * @returns {string}
 */
function _unlockLabel(s) {
  if (s.unlock_note) return s.unlock_note;

  if (s.unlock_type === SPONSOR_UNLOCK_RANK) {
    return "前シーズン " + s.unlock_value + "位以内";
  }
  if (s.unlock_type === SPONSOR_UNLOCK_LIST) {
    return "主催者が指定したチームのみ";
  }
  return "";
}

// =============================================================================
// 解放条件
// =============================================================================

/**
 * そのチームがこのスポンサーを選べるかを判定する。
 *
 * 「強いスポンサーは実績のあるチームだけ」という制限を表すための仕組み。
 * 契約金が大きいものほど条件を重くしておくと、上位と下位の差が開きすぎない。
 *
 * ▶ 判定できるもの / できないもの
 *   - **順位**: 指定シーズンの順位表から自動で判定する。
 *     そのシーズンがツールに入っている場合だけ使える。
 *   - **指定**: 主催者が選んだチームだけ。過去シーズンの成績が
 *     ツールに入っていない場合（Season13以前など）はこちらを使う。
 *
 * 判定に使うシーズンが見つからないときは**開けない**。
 * 開けてしまうと、条件付きのスポンサーが誰でも選べる状態で気づかれずに進む。
 *
 * @param {Object} sponsor
 * @param {string} teamId
 * @param {Object} rankCache season_id → (team_id → 順位) の使い回し
 * @returns {{ unlocked: boolean, reason: string }}
 */
function _isUnlocked(sponsor, teamId, rankCache) {
  if (sponsor.unlock_type === SPONSOR_UNLOCK_LIST) {
    if (sponsor.unlock_teams.indexOf(teamId) !== -1) {
      return { unlocked: true, reason: "解放済み" };
    }
    return { unlocked: false, reason: "条件を満たしていません" };
  }

  if (sponsor.unlock_type === SPONSOR_UNLOCK_RANK) {
    var sid = sponsor.unlock_season_id;
    if (!sid) {
      return { unlocked: false, reason: "判定するシーズンが設定されていません" };
    }

    if (!rankCache[sid]) rankCache[sid] = _leagueRankMap(PUBLIC_ACCESS, sid);
    var rank = rankCache[sid][teamId];

    if (!rank) {
      return { unlocked: false, reason: "対象シーズンの順位がありません" };
    }

    var target = Math.round(_num(sponsor.unlock_value));
    return {
      unlocked: rank <= target,
      reason: rank + "位（条件: " + target + "位以内）",
    };
  }

  return { unlocked: true, reason: "" };
}

/**
 * スポンサーと契約する。
 *
 * **契約金はその場で予算に入る。** 契約を変える場合は、前の契約金を戻してから
 * 新しい契約金を入れる。差額だけを動かすのではなく、
 * 「返金」と「入金」を別々に記録して履歴を追えるようにする。
 *
 * payload: { season_id, sponsor_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function chooseSponsor(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);
  var sponsorId = _str(payload.sponsor_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };
  if (!sponsorId) return { ok: false, error: "スポンサーを選んでください。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  return withLock(function () {
    // 主催者は締切後でも代理で入力できる
    if (!_isSponsorOpen() && _str(user.role) !== "organizer") {
      return { ok: false, error: "現在はスポンサーの契約を受け付けていません。" };
    }

    var sponsor = _findSponsor(seasonId, sponsorId);
    if (!sponsor) return { ok: false, error: "スポンサーが見つかりません。" };
    if (!sponsor.active) return { ok: false, error: "このスポンサーは現在選べません。" };

    // 解放条件。主催者は代理契約のため通す（画面には理由を出している）
    if (_str(user.role) !== "organizer") {
      var u = _isUnlocked(sponsor, teamId, {});
      if (!u.unlocked) {
        return {
          ok: false,
          error: "このスポンサーの解放条件を満たしていません（" + u.reason + "）。",
        };
      }
    }

    var at = now();
    var existing = _contractOfTeam(seasonId, teamId);

    if (existing && _str(existing.result) !== SPONSOR_RESULT_NONE) {
      return { ok: false, error: "既に判定が済んでいるため変更できません。" };
    }

    var refunded = 0;

    if (existing) {
      if (_str(existing.sponsor_id) === sponsorId) {
        return { ok: false, error: "既にこのスポンサーと契約しています。" };
      }

      // 前の契約金を戻す
      refunded = _num(existing.contract_fee);
      if (refunded > 0) {
        _addBudgetTx(
          seasonId, teamId, -refunded, REASON_SPONSOR_FEE,
          "契約変更による返金 " + _str(existing.sponsor_id), at
        );
      }

      updateRow("TeamSponsors", "contract_id", _str(existing.contract_id), {
        sponsor_id:   sponsorId,
        contract_fee: sponsor.contract_fee,
        chosen_at:    at,
      });
    } else {
      appendRow("TeamSponsors", {
        contract_id:  generateId("sp_"),
        season_id:    seasonId,
        team_id:      teamId,
        sponsor_id:   sponsorId,
        contract_fee: sponsor.contract_fee,
        chosen_at:    at,
        result:       SPONSOR_RESULT_NONE,
        penalty_paid: 0,
        settled_at:   "",
      });
    }

    if (sponsor.contract_fee > 0) {
      _addBudgetTx(
        seasonId, teamId, sponsor.contract_fee, REASON_SPONSOR_FEE,
        sponsor.name, at
      );
    }

    return {
      ok: true,
      data: {
        sponsor_id:   sponsorId,
        name:         sponsor.name,
        contract_fee: sponsor.contract_fee,
        refunded:     refunded,
        quota_label:  _quotaLabel(sponsor),
        penalty:      sponsor.penalty,
      },
    };
  });
}

// =============================================================================
// 主催者向け
// =============================================================================

/**
 * スポンサー一覧と契約状況を返す。主催者専用。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listSponsors(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var teamNames = _teamNameMap();
  var sponsors = _sponsorsOf(seasonId);
  var contracts = _contractsOf(seasonId);

  var byTeam = {};
  contracts.forEach(function (c) { byTeam[_str(c.team_id)] = c; });

  var sponsorNames = {};
  sponsors.forEach(function (s) { sponsorNames[s.sponsor_id] = s.name; });

  return {
    ok: true,
    data: {
      season_id: seasonId,
      open:      _isSponsorOpen(),
      sponsors:  sponsors.map(function (s) {
        var takers = contracts
          .filter(function (c) { return _str(c.sponsor_id) === s.sponsor_id; })
          .map(function (c) { return teamNames[_str(c.team_id)] || _str(c.team_id); });

        return {
          sponsor_id:   s.sponsor_id,
          name:         s.name,
          contract_fee: s.contract_fee,
          quota_type:   s.quota_type,
          quota_value:  s.quota_value,
          quota_type2:  s.quota_type2,
          quota_value2: s.quota_value2,
          quota_label:  _quotaLabel(s),
          penalty:      s.penalty,
          unlock_type:  s.unlock_type,
          unlock_season_id: s.unlock_season_id,
          unlock_value: s.unlock_value,
          unlock_teams: s.unlock_teams,
          unlock_note:  s.unlock_note,
          unlock_label: _unlockLabel(s),
          note:         s.note,
          active:       s.active,
          teams:        takers,
        };
      }),
      contracts: contracts.map(function (c) {
        var v = _contractView(c, sponsors);
        v.team_name = teamNames[v.team_id] || v.team_id;
        v.sponsor_name = sponsorNames[v.sponsor_id] || v.sponsor_id;
        return v;
      }),
      uncontracted: _activeTeams()
        .filter(function (t) { return !byTeam[_str(t.team_id)]; })
        .map(function (t) {
          return { team_id: _str(t.team_id), team_name: _str(t.name) };
        }),
      cup_goals:    SPONSOR_CUP_GOALS,
      quota_types:  SPONSOR_QUOTA_TYPES,
      unlock_types: SPONSOR_UNLOCK_TYPES,
      teams:        _activeTeams().map(function (t) {
        return { team_id: _str(t.team_id), team_name: _str(t.name) };
      }),
    },
  };
}

/**
 * スポンサーを登録・修正する。主催者専用。
 *
 * payload: { sponsor_id?, season_id, name, contract_fee, quota_type, quota_value, penalty, note?, active? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertSponsor(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var name = _str(payload.name).trim();

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!name) return { ok: false, error: "スポンサー名を入力してください。" };

  var q1 = _normalizeQuota(payload.quota_type, payload.quota_value);
  if (q1.error) return { ok: false, error: q1.error };

  var q2 = _normalizeQuota(payload.quota_type2, payload.quota_value2);
  if (q2.error) return { ok: false, error: "2つ目のノルマ: " + q2.error };

  // 1つ目が空で2つ目だけあると、判定はできるが画面の見え方が分かりにくい。
  // 1つ目へ寄せてしまう
  if (q1.type === SPONSOR_QUOTA_NONE && q2.type !== SPONSOR_QUOTA_NONE) {
    q1 = q2;
    q2 = { type: SPONSOR_QUOTA_NONE, value: "" };
  }

  var fee = Math.round(_num(payload.contract_fee));
  var penalty = Math.round(_num(payload.penalty));

  if (fee < 0) return { ok: false, error: "契約金は0以上で入力してください。" };
  if (penalty < 0) return { ok: false, error: "罰金は0以上で入力してください。" };

  if (q1.type === SPONSOR_QUOTA_NONE && penalty > 0) {
    return { ok: false, error: "ノルマなしのスポンサーに罰金は設定できません。" };
  }

  var unlockType = _str(payload.unlock_type) || SPONSOR_UNLOCK_NONE;
  try {
    _assertEnum("unlock_type", unlockType, SPONSOR_UNLOCK_TYPES);
  } catch (e2) {
    return { ok: false, error: e2.message };
  }

  var unlockSeason = _str(payload.unlock_season_id);
  var unlockValue = _str(payload.unlock_value).trim();
  var unlockTeams = _joinIds(payload.unlock_teams);

  if (unlockType === SPONSOR_UNLOCK_RANK) {
    var ur = Math.round(_num(unlockValue));
    if (ur < 1) return { ok: false, error: "解放条件の順位は1以上で入力してください。" };
    unlockValue = String(ur);

    if (!unlockSeason) {
      return { ok: false, error: "順位で解放するときは、判定するシーズンを選んでください。" };
    }
    unlockTeams = "";
  } else if (unlockType === SPONSOR_UNLOCK_LIST) {
    unlockSeason = "";
    unlockValue = "";
  } else {
    unlockSeason = "";
    unlockValue = "";
    unlockTeams = "";
  }

  var sponsorId = _str(payload.sponsor_id);

  return withLock(function () {
    var updates = {
      season_id:    seasonId,
      name:         name,
      contract_fee: fee,
      quota_type:   q1.type,
      quota_value:  q1.value,
      quota_type2:  q2.type,
      quota_value2: q2.value,
      penalty:      penalty,
      unlock_type:  unlockType,
      unlock_season_id: unlockSeason,
      unlock_value: unlockValue,
      unlock_teams: unlockTeams,
      unlock_note:  _str(payload.unlock_note),
      note:         _str(payload.note),
      active:       payload.active === undefined ? true : _toBool(payload.active),
    };

    if (sponsorId && findRow("Sponsors", "sponsor_id", sponsorId)) {
      updateRow("Sponsors", "sponsor_id", sponsorId, updates);
      return { ok: true, data: { sponsor_id: sponsorId, created: false } };
    }

    sponsorId = generateId("sn_");
    updates.sponsor_id = sponsorId;
    appendRow("Sponsors", updates);

    return { ok: true, data: { sponsor_id: sponsorId, created: true } };
  });
}

/**
 * スポンサーを削除する。契約済みのものは消せない。
 *
 * payload: { sponsor_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function deleteSponsor(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var sponsorId = _str(payload.sponsor_id);
  if (!sponsorId) return { ok: false, error: "sponsor_id は必須です。" };

  return withLock(function () {
    var row = findRow("Sponsors", "sponsor_id", sponsorId);
    if (!row) return { ok: false, error: "スポンサーが見つかりません。" };

    var used = _contractsOf(_str(row.season_id)).filter(function (c) {
      return _str(c.sponsor_id) === sponsorId;
    });

    if (used.length > 0) {
      return {
        ok: false,
        error: used.length + " チームが契約中のため削除できません。" +
          "選択肢から外すだけなら「使う」のチェックを外してください。",
      };
    }

    var sheet = getSheet("Sponsors");
    var values = sheet.getDataRange().getValues();
    var iId = values[0].indexOf("sponsor_id");

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iId]) !== sponsorId) continue;
      sheet.deleteRow(i + 1);
      return { ok: true, data: { sponsor_id: sponsorId } };
    }

    return { ok: false, error: "スポンサーが見つかりません。" };
  });
}

/**
 * 別のシーズンのスポンサー設定を複製する。主催者専用。
 *
 * 毎シーズン似た構成にするなら、前シーズンをコピーして金額だけ直すのが早い。
 *
 * payload: { from_season_id, to_season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function copySponsors(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var from = _str(payload.from_season_id);
  var to = _str(payload.to_season_id);

  if (!from || !to) return { ok: false, error: "複製元と複製先のシーズンを選んでください。" };
  if (from === to) return { ok: false, error: "同じシーズンには複製できません。" };
  if (!findRow("Seasons", "season_id", to)) {
    return { ok: false, error: "複製先のシーズンが見つかりません。" };
  }

  return withLock(function () {
    var src = _sponsorsOf(from);
    if (src.length === 0) {
      return { ok: false, error: "複製元にスポンサーがありません。" };
    }

    var existing = {};
    _sponsorsOf(to).forEach(function (s) { existing[s.name] = true; });

    var rows = [];
    src.forEach(function (s) {
      if (existing[s.name]) return;   // 同名は作らない
      rows.push({
        sponsor_id:   generateId("sn_"),
        season_id:    to,
        name:         s.name,
        contract_fee: s.contract_fee,
        quota_type:   s.quota_type,
        quota_value:  s.quota_value,
        quota_type2:  s.quota_type2,
        quota_value2: s.quota_value2,
        penalty:      s.penalty,
        unlock_type:  s.unlock_type,
        // 解放の対象シーズンとチームは引き継がない。
        // 前シーズンの設定をそのまま持ってくると、別のシーズンの順位で
        // 判定してしまう。複製後に選び直す前提にする
        unlock_season_id: "",
        unlock_value: s.unlock_value,
        unlock_teams: "",
        unlock_note:  s.unlock_note,
        note:         s.note,
        active:       s.active,
      });
    });

    _appendRowsBatch("Sponsors", rows);

    return {
      ok: true,
      data: { copied: rows.length, skipped: src.length - rows.length },
    };
  });
}

/**
 * チームの契約を取り消す。契約金も戻す。主催者専用。
 *
 * payload: { contract_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function clearTeamSponsor(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var contractId = _str(payload.contract_id);
  if (!contractId) return { ok: false, error: "contract_id は必須です。" };

  return withLock(function () {
    var row = findRow("TeamSponsors", "contract_id", contractId);
    if (!row) return { ok: false, error: "契約が見つかりません。" };

    var fee = _num(row.contract_fee);
    if (fee > 0) {
      _addBudgetTx(
        _str(row.season_id), _str(row.team_id), -fee, REASON_SPONSOR_FEE,
        "契約取消による返金", now()
      );
    }

    var sheet = getSheet("TeamSponsors");
    var values = sheet.getDataRange().getValues();
    var iId = values[0].indexOf("contract_id");

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iId]) !== contractId) continue;
      sheet.deleteRow(i + 1);
      return { ok: true, data: { contract_id: contractId, refunded: fee } };
    }

    return { ok: false, error: "契約が見つかりません。" };
  });
}

// =============================================================================
// ノルマの判定（closeSeason から呼ぶ）
// =============================================================================

/**
 * スポンサーのノルマを判定し、未達なら罰金を計上する。
 *
 * 賞金をすべて計上した後、シーズン終了手数料の前に呼ぶ。
 * 罰金も手数料の母数に含めたいため（賞金と同じ扱い）。
 *
 * @param {string} token
 * @param {string} seasonId
 * @param {Date} at
 * @param {Object} report sponsor_results に結果を積む
 */
function _settleSponsors(token, seasonId, at, report) {
  var contracts = _contractsOf(seasonId);
  if (contracts.length === 0) return;

  var sponsors = {};
  _sponsorsOf(seasonId).forEach(function (s) { sponsors[s.sponsor_id] = s; });

  var teamNames = _teamNameMap();
  var ranks = _leagueRankMap(token, seasonId);
  var cup = _cupResultMap(token, seasonId);

  contracts.forEach(function (c) {
    var contractId = _str(c.contract_id);
    if (_str(c.result) !== SPONSOR_RESULT_NONE) return;   // 二重判定を防ぐ

    var teamId = _str(c.team_id);
    var sponsor = sponsors[_str(c.sponsor_id)];
    if (!sponsor) return;

    var judged = _judgeQuota(sponsor, teamId, ranks, cup);
    var met = judged.met;
    var penalty = met ? 0 : Math.round(_num(sponsor.penalty));

    if (penalty > 0) {
      _addBudgetTx(
        seasonId, teamId, -penalty, REASON_SPONSOR_PENALTY,
        sponsor.name + " " + _quotaLabel(sponsor), at
      );
    }

    updateRow("TeamSponsors", "contract_id", contractId, {
      result:       met ? SPONSOR_RESULT_MET : SPONSOR_RESULT_MISS,
      penalty_paid: penalty,
      settled_at:   at,
    });

    report.sponsor_results.push({
      team_id:      teamId,
      team_name:    teamNames[teamId] || teamId,
      sponsor_name: sponsor.name,
      quota_label:  _quotaLabel(sponsor),
      actual:       judged.actual,
      met:          met,
      penalty:      penalty,
    });
  });
}

/**
 * ノルマを達成したかどうかを判定する。
 *
 * @param {Object} sponsor
 * @param {string} teamId
 * @param {Object} ranks team_id → 順位
 * @param {Object} cup   team_id → 到達段階
 * @returns {{ met: boolean, actual: string }}
 */
function _judgeQuota(sponsor, teamId, ranks, cup) {
  var conds = [
    { type: sponsor.quota_type, value: sponsor.quota_value },
    { type: sponsor.quota_type2, value: sponsor.quota_value2 },
  ].filter(function (c) { return c.type && c.type !== SPONSOR_QUOTA_NONE; });

  if (conds.length === 0) return { met: true, actual: "ノルマなし" };

  // **どれか1つ達成していればよい。** 2つ設定するのは
  // 「リーグ優勝 または カップ優勝」のような選択式のノルマを表すため。
  var met = false;
  var actuals = [];

  conds.forEach(function (c) {
    var r = _judgeOneQuota(c.type, c.value, teamId, ranks, cup);
    if (r.met) met = true;
    actuals.push(r.actual);
  });

  // 実績は重複を除いて並べる（両方がリーグ順位なら同じ文言が2つ出るため）
  var seen = {};
  var uniq = actuals.filter(function (a) {
    if (seen[a]) return false;
    seen[a] = true;
    return true;
  });

  return { met: met, actual: uniq.join(" / ") };
}

/**
 * ノルマ1つぶんを判定する。
 *
 * @param {string} type
 * @param {string} value
 * @param {string} teamId
 * @param {Object} ranks
 * @param {Object} cup
 * @returns {{ met: boolean, actual: string }}
 */
function _judgeOneQuota(type, value, teamId, ranks, cup) {
  if (type === SPONSOR_QUOTA_RANK) {
    var rank = ranks[teamId];
    if (!rank) {
      // 順位が出ていない（1試合も消化していない等）。達成扱いにはしない
      return { met: false, actual: "順位なし" };
    }
    return { met: rank <= Math.round(_num(value)), actual: rank + "位" };
  }

  var reached = cup[teamId] || "";
  var order = { "優勝": 3, "準優勝以上": 2, "ベスト4以上": 1 };
  var need = order[_str(value)] || 0;
  var got = order[reached] || 0;

  return { met: got >= need, actual: reached || "ベスト4未満" };
}

/**
 * リーグ戦の順位を team_id → 順位 で返す。
 *
 * 二部制なら、そのチームが属するディビジョン内の順位。
 *
 * @param {string} token
 * @param {string} seasonId
 * @returns {Object}
 */
function _leagueRankMap(token, seasonId) {
  var map = {};

  [DIVISION_GM1, DIVISION_GM2].forEach(function (div) {
    var st = getStandings(PUBLIC_ACCESS, { season_id: seasonId, division: div });
    if (!st.ok) return;

    st.data.table.forEach(function (row) {
      if (_num(row.played) <= 0) return;   // 未消化は順位として扱わない
      map[_str(row.team_id)] = _num(row.rank);
    });
  });

  return map;
}

/**
 * GMリーグ杯の到達段階を team_id → 段階 で返す。
 *
 * 「優勝」「準優勝以上」「ベスト4以上」のいずれか。
 * 決勝は最後のタイ、準決勝はその1つ前のラウンドとして判定する
 * （closeSeason のベスト4賞金と同じ考え方）。
 *
 * @param {string} token
 * @param {string} seasonId
 * @returns {Object}
 */
function _cupResultMap(token, seasonId) {
  var map = {};

  var tr = getTournament(PUBLIC_ACCESS, { season_id: seasonId, stage: STAGE_TOURNAMENT });
  if (!tr.ok || tr.data.ties.length === 0) return map;

  var ties = tr.data.ties;
  var finalTie = ties[ties.length - 1];
  var finalRound = _str(finalTie.round);

  // 決勝の1つ前のラウンド = 準決勝
  var semiRound = "";
  for (var i = ties.length - 1; i >= 0; i--) {
    var r = _str(ties[i].round);
    if (r !== finalRound) { semiRound = r; break; }
  }

  ties.forEach(function (t) {
    var round = _str(t.round);

    if (round === semiRound) {
      [t.team_a, t.team_b].forEach(function (tid) {
        if (tid && !map[_str(tid)]) map[_str(tid)] = "ベスト4以上";
      });
    }
  });

  [finalTie.team_a, finalTie.team_b].forEach(function (tid) {
    if (tid) map[_str(tid)] = "準優勝以上";
  });

  if (finalTie.winner) map[_str(finalTie.winner)] = "優勝";

  return map;
}

// =============================================================================
// 共通ヘルパ
// =============================================================================

/**
 * シーズンのスポンサーを返す。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _sponsorsOf(seasonId) {
  var rows;
  try {
    rows = getSheetData("Sponsors");
  } catch (e) {
    Logger.log("[_sponsorsOf] Sponsors 読み取りエラー: " + e.message);
    return [];
  }

  return rows
    .filter(function (s) {
      return _str(s.sponsor_id) && _str(s.season_id) === seasonId;
    })
    .map(function (s) {
      return {
        sponsor_id:   _str(s.sponsor_id),
        season_id:    _str(s.season_id),
        name:         _str(s.name),
        contract_fee: _num(s.contract_fee),
        quota_type:   _str(s.quota_type) || SPONSOR_QUOTA_NONE,
        quota_value:  _str(s.quota_value),
        quota_type2:  _str(s.quota_type2) || SPONSOR_QUOTA_NONE,
        quota_value2: _str(s.quota_value2),
        penalty:      _num(s.penalty),
        unlock_type:  _str(s.unlock_type) || SPONSOR_UNLOCK_NONE,
        unlock_season_id: _str(s.unlock_season_id),
        unlock_value: _str(s.unlock_value),
        unlock_teams: _splitIds(s.unlock_teams),
        unlock_note:  _str(s.unlock_note),
        note:         _str(s.note),
        active:       _toBool(s.active),
      };
    });
}

/**
 * カンマ区切りの ID 文字列を配列にする。
 *
 * @param {*} value
 * @returns {string[]}
 */
function _splitIds(value) {
  return _str(value)
    .split(",")
    .map(function (v) { return v.trim(); })
    .filter(function (v) { return v; });
}

/**
 * sponsor_id から1件引く。
 *
 * @param {string} seasonId
 * @param {string} sponsorId
 * @returns {Object|null}
 */
function _findSponsor(seasonId, sponsorId) {
  var found = null;
  _sponsorsOf(seasonId).forEach(function (s) {
    if (s.sponsor_id === sponsorId) found = s;
  });
  return found;
}

/**
 * シーズンの契約を返す。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _contractsOf(seasonId) {
  try {
    return getSheetData("TeamSponsors").filter(function (c) {
      return _str(c.contract_id) && _str(c.season_id) === seasonId;
    });
  } catch (e) {
    Logger.log("[_contractsOf] TeamSponsors 読み取りエラー: " + e.message);
    return [];
  }
}

/**
 * チームの契約を返す。1チーム1社なので最大1件。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {Object|null}
 */
function _contractOfTeam(seasonId, teamId) {
  var found = null;
  _contractsOf(seasonId).forEach(function (c) {
    if (_str(c.team_id) === teamId) found = c;
  });
  return found;
}

/**
 * 契約1件を画面用に整える。
 *
 * @param {Object} c
 * @param {Object[]} sponsors
 * @returns {Object}
 */
function _contractView(c, sponsors) {
  var sid = _str(c.sponsor_id);
  var sponsor = null;
  sponsors.forEach(function (s) { if (s.sponsor_id === sid) sponsor = s; });

  return {
    contract_id:  _str(c.contract_id),
    season_id:    _str(c.season_id),
    team_id:      _str(c.team_id),
    sponsor_id:   sid,
    sponsor_name: sponsor ? sponsor.name : sid,
    contract_fee: _num(c.contract_fee),
    quota_label:  sponsor ? _quotaLabel(sponsor) : "",
    penalty:      sponsor ? sponsor.penalty : 0,
    result:       _str(c.result) || SPONSOR_RESULT_NONE,
    penalty_paid: _num(c.penalty_paid),
    chosen_at:    _iso(c.chosen_at),
    settled_at:   _iso(c.settled_at),
  };
}

/**
 * ノルマの種別と値を検証して整える。
 *
 * @param {*} type
 * @param {*} value
 * @returns {{ type: string, value: string, error?: string }}
 */
function _normalizeQuota(type, value) {
  var t = _str(type) || SPONSOR_QUOTA_NONE;

  try {
    _assertEnum("quota_type", t, SPONSOR_QUOTA_TYPES);
  } catch (e) {
    return { type: t, value: "", error: e.message };
  }

  var v = _str(value).trim();

  if (t === SPONSOR_QUOTA_RANK) {
    var rank = Math.round(_num(v));
    if (rank < 1) {
      return { type: t, value: v, error: "リーグ順位のノルマは1以上で入力してください。" };
    }
    return { type: t, value: String(rank) };
  }

  if (t === SPONSOR_QUOTA_CUP) {
    if (SPONSOR_CUP_GOALS.indexOf(v) === -1) {
      return {
        type: t, value: v,
        error: "リーグ杯のノルマは " + SPONSOR_CUP_GOALS.join(" / ") + " から選んでください。",
      };
    }
    return { type: t, value: v };
  }

  return { type: SPONSOR_QUOTA_NONE, value: "" };
}

/**
 * team_id の配列（または文字列）をカンマ区切りにする。
 *
 * @param {*} value
 * @returns {string}
 */
function _joinIds(value) {
  if (Object.prototype.toString.call(value) === "[object Array]") {
    return value
      .map(function (v) { return _str(v).trim(); })
      .filter(function (v) { return v; })
      .join(",");
  }
  return _splitIds(value).join(",");
}
