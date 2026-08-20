/**
 * api_manager.gs — 使用監督の申告
 *
 * 参加者:
 *   getManagerStatus  — 選べる監督・自分の申告・現在の受付状態
 *   declareManager    — 使用監督を申告する
 *
 * 主催者:
 *   setManagerRound   — 受付状態を切り替える（停止 / 第一次 / 第二次）
 *   listManagerPicks  — 申告の一覧
 *   drawManagers      — 第一次の抽選を実行する
 *   assignManager     — 手動で割り当てる
 *   clearManagerPick  — 申告・確定を取り消す
 *   upsertManager     — 監督マスタの編集
 *
 * ▶ 監督の範囲
 *   **新規募集終了日時点で現実の J1・J2 クラブを率いている監督**に限る。
 *   eFootball の収録には依存しない。毎シーズン変わるので、
 *   主催者が Managers シートの名前欄を入れ直す。
 *
 * ▶ 二段階の受付（毎シーズン全員が申告し直す）
 *
 *   第一次（round=1）— **締切まで他人の申告は見えない**。
 *                      締切後に主催者が抽選し、重複した監督だけ当選者を決める。
 *   第二次（round=2）— **先着順**。申告した瞬間に確定する。
 *                      第一次で落選した人が、空いている監督から選ぶ。
 *
 *   第一次を伏せるのは、先に申告した人の内容が見えると
 *   「誰も狙っていない監督」を選ぶだけの読み合いになってしまうため。
 *   第二次を先着にするのは、残り物を早く埋めたいから。
 *
 * ⚠️ 設計原則
 *   1. 書き込みは必ず GAS 経由。抽選もサーバー側で行い、結果を記録する
 *   2. 受付中かどうかの判定はサーバー側
 */

// =============================================================================
// 定数
// =============================================================================

var MG_ROUND_CLOSED = 0;
var MG_ROUND_FIRST = 1;
var MG_ROUND_SECOND = 2;

var MG_DECLARED = "申告中";
var MG_WON = "当選";
var MG_LOST = "落選";
var MG_FIXED = "確定";

// =============================================================================
// 受付状態
// =============================================================================

/**
 * 現在の受付ラウンドを返す。
 *
 * @returns {number} 0 / 1 / 2
 */
function _managerRound() {
  var v = Math.round(_num(getConfig("manager_round", 0)));
  if (v === MG_ROUND_FIRST || v === MG_ROUND_SECOND) return v;
  return MG_ROUND_CLOSED;
}

/**
 * 受付状態を切り替える。主催者専用。
 *
 * payload: { round }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setManagerRound(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var round = Math.round(_num(payload.round));
  if ([MG_ROUND_CLOSED, MG_ROUND_FIRST, MG_ROUND_SECOND].indexOf(round) === -1) {
    return { ok: false, error: "受付状態は 0 / 1 / 2 のいずれかです。" };
  }

  return withLock(function () {
    var res = setConfig(token, { key: "manager_round", value: round });
    if (!res.ok) return res;
    return { ok: true, data: { round: round, label: _roundLabel(round) } };
  });
}

/**
 * ラウンドの表示名。
 *
 * @param {number} round
 * @returns {string}
 */
function _roundLabel(round) {
  if (round === MG_ROUND_FIRST) return "第一次（抽選）";
  if (round === MG_ROUND_SECOND) return "第二次（先着）";
  return "停止中";
}

// =============================================================================
// 参加者向け
// =============================================================================

/**
 * 選べる監督と自分の申告状況を返す。
 *
 * **他チームの「申告中」は返さない。** 第一次を伏せて行うため。
 * 返すのは既に確定した監督（＝もう選べない）だけ。
 *
 * payload: { season_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getManagerStatus(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  var round = _managerRound();
  var picks = _picksOf(seasonId);
  var takenBy = _fixedManagerMap(picks);
  var teamNames = _teamNameMap();

  // 自分の申告（最新のもの）
  var mine = null;
  picks.forEach(function (p) {
    if (_str(p.team_id) !== teamId) return;
    var st = _str(p.status);
    if (st === MG_LOST) return;
    mine = p;
  });

  var managers = _managerRows().map(function (m) {
    var holder = takenBy[m.manager_id] || "";
    return {
      manager_id: m.manager_id,
      name:       m.name,
      club:       m.club,
      category:   m.category,
      taken:      !!holder,
      taken_by:   holder ? (teamNames[holder] || holder) : "",
      is_mine:    holder === teamId,
    };
  });

  var categories = [];
  var grouped = {};
  managers.forEach(function (m) {
    if (!grouped[m.category]) {
      grouped[m.category] = [];
      categories.push(m.category);
    }
    grouped[m.category].push(m);
  });

  return {
    ok: true,
    data: {
      season_id:   seasonId,
      team_id:     teamId,
      team_name:   teamNames[teamId] || teamId,
      round:       round,
      round_label: _roundLabel(round),
      open:        round !== MG_ROUND_CLOSED,
      first_come:  round === MG_ROUND_SECOND,
      my_pick:     mine ? _pickView(mine) : null,
      categories:  categories,
      managers:    grouped,
      available:   managers.filter(function (m) { return !m.taken; }).length,
      total:       managers.length,
    },
  };
}

/**
 * 使用監督を申告する。
 *
 * 第一次 — 「申告中」として記録するだけ。締切まで何度でも変更できる
 * 第二次 — 先着で「確定」まで進む。既に埋まっていれば拒否
 *
 * payload: { season_id, manager_id, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function declareManager(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);
  var managerId = _str(payload.manager_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "チームが特定できません。" };
  if (!managerId) return { ok: false, error: "監督を選んでください。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  return withLock(function () {
    var round = _managerRound();
    if (round === MG_ROUND_CLOSED) {
      return { ok: false, error: "現在は使用監督の申告を受け付けていません。" };
    }

    var manager = _findManager(managerId);
    if (!manager) return { ok: false, error: "監督が見つかりません。" };

    var picks = _picksOf(seasonId);
    var takenBy = _fixedManagerMap(picks);

    if (takenBy[managerId] && takenBy[managerId] !== teamId) {
      return {
        ok: false,
        error: manager.name + " は既に他のチームで確定しています。別の監督を選んでください。",
      };
    }

    // 自分の既存の申告（落選は除く）
    var mine = null;
    picks.forEach(function (p) {
      if (_str(p.team_id) !== teamId) return;
      if (_str(p.status) === MG_LOST) return;
      mine = p;
    });

    if (mine && _str(mine.status) !== MG_DECLARED) {
      return {
        ok: false,
        error: "既に使用監督が確定しています。変更が必要な場合は主催者に連絡してください。",
      };
    }

    var at = now();

    // 第二次は先着なので、その場で確定させる
    var status = round === MG_ROUND_SECOND ? MG_FIXED : MG_DECLARED;

    if (mine) {
      updateRow("ManagerPicks", "pick_id", _str(mine.pick_id), {
        round:      round,
        manager_id: managerId,
        status:     status,
        created_at: at,
        decided_at: status === MG_FIXED ? at : "",
      });

      return {
        ok: true,
        data: {
          pick_id: _str(mine.pick_id), manager_id: managerId,
          manager_name: manager.name, status: status, updated: true,
        },
      };
    }

    var pickId = generateId("mp_");
    appendRow("ManagerPicks", {
      pick_id:    pickId,
      season_id:  seasonId,
      team_id:    teamId,
      round:      round,
      manager_id: managerId,
      status:     status,
      created_at: at,
      decided_at: status === MG_FIXED ? at : "",
    });

    return {
      ok: true,
      data: {
        pick_id: pickId, manager_id: managerId,
        manager_name: manager.name, status: status, updated: false,
      },
    };
  });
}

// =============================================================================
// 主催者向け
// =============================================================================

/**
 * 申告の一覧を返す。主催者専用。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listManagerPicks(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  var picks = _picksOf(seasonId);
  var teamNames = _teamNameMap();
  var managerNames = {};
  _managerRows().forEach(function (m) { managerNames[m.manager_id] = m; });

  var rows = picks.map(function (p) {
    var v = _pickView(p);
    v.team_name = teamNames[v.team_id] || v.team_id;
    var m = managerNames[v.manager_id];
    v.manager_name = m ? m.name : v.manager_id;
    v.club = m ? m.club : "";
    return v;
  });

  rows.sort(function (a, b) {
    if (a.round !== b.round) return a.round - b.round;
    return String(a.created_at).localeCompare(String(b.created_at));
  });

  // 第一次で重複している監督（抽選の対象）
  var dupes = _duplicatesInRound(picks, MG_ROUND_FIRST);

  return {
    ok: true,
    data: {
      season_id:   seasonId,
      round:       _managerRound(),
      round_label: _roundLabel(_managerRound()),
      picks:       rows,
      declared:    rows.filter(function (r) { return r.status === MG_DECLARED; }).length,
      fixed:       rows.filter(function (r) { return r.status === MG_FIXED; }).length,
      duplicates:  Object.keys(dupes).map(function (mid) {
        var m = managerNames[mid];
        return {
          manager_id: mid,
          manager_name: m ? m.name : mid,
          teams: dupes[mid].map(function (tid) { return teamNames[tid] || tid; }),
        };
      }),
      undeclared:  _undeclaredTeams(picks, teamNames),
    },
  };
}

/**
 * まだ申告していないアクティブチーム。
 *
 * @param {Object[]} picks
 * @param {Object} teamNames
 * @returns {Object[]}
 */
function _undeclaredTeams(picks, teamNames) {
  var declared = {};
  picks.forEach(function (p) {
    if (_str(p.status) === MG_LOST) return;
    declared[_str(p.team_id)] = true;
  });

  return _activeTeams()
    .filter(function (t) { return !declared[_str(t.team_id)]; })
    .map(function (t) {
      return { team_id: _str(t.team_id), team_name: teamNames[_str(t.team_id)] || _str(t.team_id) };
    });
}

/**
 * 第一次の抽選を実行する。主催者専用。
 *
 * 重複していない申告はそのまま確定。
 * 重複している監督だけ、申告したチームから1つを無作為に選ぶ。
 * 外れたチームは「落選」になり、第二次で選び直す。
 *
 * **抽選はサーバー側で行い、結果を記録する。** 誰がいつ実行したかが残るので、
 * 後から「本当に無作為だったのか」という話にならずに済む。
 *
 * payload: { season_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function drawManagers(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  return withLock(function () {
    var picks = _picksOf(seasonId).filter(function (p) {
      return _str(p.status) === MG_DECLARED && _num(p.round) === MG_ROUND_FIRST;
    });

    if (picks.length === 0) {
      return { ok: false, error: "抽選する申告がありません。" };
    }

    var at = now();
    var teamNames = _teamNameMap();
    var managerNames = {};
    _managerRows().forEach(function (m) { managerNames[m.manager_id] = m.name; });

    // 監督ごとに申告をまとめる
    var byManager = {};
    picks.forEach(function (p) {
      var mid = _str(p.manager_id);
      if (!byManager[mid]) byManager[mid] = [];
      byManager[mid].push(p);
    });

    var fixed = [];
    var lotteries = [];

    Object.keys(byManager).forEach(function (mid) {
      var group = byManager[mid];
      var name = managerNames[mid] || mid;

      if (group.length === 1) {
        updateRow("ManagerPicks", "pick_id", _str(group[0].pick_id), {
          status: MG_FIXED, decided_at: at,
        });
        fixed.push({
          team_name: teamNames[_str(group[0].team_id)] || _str(group[0].team_id),
          manager_name: name,
          by_lottery: false,
        });
        return;
      }

      // 重複したので抽選
      var winIndex = Math.floor(Math.random() * group.length);

      group.forEach(function (p, i) {
        var won = i === winIndex;
        updateRow("ManagerPicks", "pick_id", _str(p.pick_id), {
          status: won ? MG_FIXED : MG_LOST,
          decided_at: at,
        });

        if (won) {
          fixed.push({
            team_name: teamNames[_str(p.team_id)] || _str(p.team_id),
            manager_name: name,
            by_lottery: true,
          });
        }
      });

      lotteries.push({
        manager_name: name,
        entries: group.map(function (p) {
          return teamNames[_str(p.team_id)] || _str(p.team_id);
        }),
        winner: teamNames[_str(group[winIndex].team_id)] || _str(group[winIndex].team_id),
        losers: group
          .filter(function (p, i) { return i !== winIndex; })
          .map(function (p) { return teamNames[_str(p.team_id)] || _str(p.team_id); }),
      });
    });

    return {
      ok: true,
      data: {
        season_id:    seasonId,
        fixed:        fixed,
        fixed_count:  fixed.length,
        lotteries:    lotteries,
        lost_count:   lotteries.reduce(function (n, l) { return n + l.losers.length; }, 0),
        note:         "落選したチームは第二次（先着）で選び直します。",
      },
    };
  });
}

/**
 * 主催者が手動で監督を割り当てる。
 *
 * payload: { season_id, team_id, manager_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function assignManager(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  var managerId = _str(payload.manager_id);

  if (!seasonId || !teamId || !managerId) {
    return { ok: false, error: "season_id / team_id / manager_id は必須です。" };
  }

  return withLock(function () {
    var manager = _findManager(managerId);
    if (!manager) return { ok: false, error: "監督が見つかりません。" };

    var picks = _picksOf(seasonId);
    var takenBy = _fixedManagerMap(picks);

    if (takenBy[managerId] && takenBy[managerId] !== teamId) {
      return { ok: false, error: manager.name + " は既に他のチームで確定しています。" };
    }

    var at = now();

    var mine = null;
    picks.forEach(function (p) {
      if (_str(p.team_id) !== teamId) return;
      if (_str(p.status) === MG_LOST) return;
      mine = p;
    });

    if (mine) {
      updateRow("ManagerPicks", "pick_id", _str(mine.pick_id), {
        manager_id: managerId, status: MG_FIXED, decided_at: at,
      });
      return { ok: true, data: { pick_id: _str(mine.pick_id), manager_name: manager.name } };
    }

    var pickId = generateId("mp_");
    appendRow("ManagerPicks", {
      pick_id: pickId, season_id: seasonId, team_id: teamId,
      round: _managerRound() || MG_ROUND_SECOND, manager_id: managerId,
      status: MG_FIXED, created_at: at, decided_at: at,
    });

    return { ok: true, data: { pick_id: pickId, manager_name: manager.name } };
  });
}

/**
 * 申告・確定を取り消す。主催者専用。
 *
 * payload: { pick_id }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function clearManagerPick(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var pickId = _str(payload.pick_id);
  if (!pickId) return { ok: false, error: "pick_id は必須です。" };

  return withLock(function () {
    var sheet = getSheet("ManagerPicks");
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return { ok: false, error: "申告が見つかりません。" };

    var iId = values[0].indexOf("pick_id");

    for (var i = 1; i < values.length; i++) {
      if (String(values[i][iId]) !== pickId) continue;
      sheet.deleteRow(i + 1);
      return { ok: true, data: { pick_id: pickId } };
    }

    return { ok: false, error: "申告が見つかりません。" };
  });
}

/**
 * 監督マスタを1件追加・更新する。主催者専用。
 *
 * payload: { manager_id?, name, club, category, active? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertManager(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var name = _str(payload.name).trim();
  var club = _str(payload.club).trim();
  var category = _str(payload.category).trim();

  if (!name) return { ok: false, error: "監督名を入力してください。" };
  if (!club) return { ok: false, error: "クラブを選んでください。" };

  try {
    _assertEnum("category", category, ["J1", "J2", "J3"]);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var managerId = _str(payload.manager_id);

  return withLock(function () {
    var updates = {
      name: name, club: club, category: category,
      active: payload.active === undefined ? true : _toBool(payload.active),
    };

    if (managerId && findRow("Managers", "manager_id", managerId)) {
      updateRow("Managers", "manager_id", managerId, updates);
      return { ok: true, data: { manager_id: managerId, created: false } };
    }

    managerId = managerId || generateId("mg_");
    updates.manager_id = managerId;
    appendRow("Managers", updates);

    return { ok: true, data: { manager_id: managerId, created: true } };
  });
}

/**
 * 監督マスタを返す。主催者専用（名前が空の行も見せる）。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listManagers(token) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var rows;
  try {
    rows = getSheetData("Managers");
  } catch (e) {
    return { ok: false, error: "Managers シートを読み取れません: " + e.message };
  }

  var all = rows
    .filter(function (m) { return _str(m.manager_id); })
    .map(function (m) {
      return {
        manager_id: _str(m.manager_id),
        name:       _str(m.name),
        club:       _str(m.club),
        category:   _str(m.category),
        active:     _toBool(m.active),
      };
    });

  return {
    ok: true,
    data: {
      managers: all,
      total:    all.length,
      unnamed:  all.filter(function (m) { return !m.name; }).length,
    },
  };
}

// =============================================================================
// 共通ヘルパ
// =============================================================================

/**
 * 選択肢に出せる監督（名前が入っていて active なもの）。
 *
 * 名前が空の行を除くのは、主催者がまだ埋めていない枠を
 * 参加者に見せても選びようがないため。
 *
 * @returns {Object[]}
 */
function _managerRows() {
  var rows;
  try {
    rows = getSheetData("Managers");
  } catch (e) {
    Logger.log("[_managerRows] Managers 読み取りエラー: " + e.message);
    return [];
  }

  return rows
    .filter(function (m) {
      return _str(m.manager_id) && _str(m.name) && _toBool(m.active);
    })
    .map(function (m) {
      return {
        manager_id: _str(m.manager_id),
        name:       _str(m.name),
        club:       _str(m.club),
        category:   _str(m.category),
      };
    });
}

/**
 * manager_id から1件引く。
 *
 * @param {string} managerId
 * @returns {Object|null}
 */
function _findManager(managerId) {
  var found = null;
  _managerRows().forEach(function (m) {
    if (m.manager_id === managerId) found = m;
  });
  return found;
}

/**
 * 指定シーズンの申告を返す。
 *
 * @param {string} seasonId
 * @returns {Object[]}
 */
function _picksOf(seasonId) {
  try {
    return getSheetData("ManagerPicks").filter(function (p) {
      return _str(p.pick_id) && _str(p.season_id) === seasonId;
    });
  } catch (e) {
    Logger.log("[_picksOf] ManagerPicks 読み取りエラー: " + e.message);
    return [];
  }
}

/**
 * 確定している監督の manager_id → team_id。
 *
 * **申告中は含めない。** 第一次を伏せて行うため、
 * 「誰が何を申告したか」が漏れないようにする。
 *
 * @param {Object[]} picks
 * @returns {Object}
 */
function _fixedManagerMap(picks) {
  var map = {};
  picks.forEach(function (p) {
    if (_str(p.status) !== MG_FIXED) return;
    map[_str(p.manager_id)] = _str(p.team_id);
  });
  return map;
}

/**
 * 指定ラウンドで重複している監督を返す。
 *
 * @param {Object[]} picks
 * @param {number} round
 * @returns {Object} manager_id → team_id[]
 */
function _duplicatesInRound(picks, round) {
  var byManager = {};
  picks.forEach(function (p) {
    if (_num(p.round) !== round) return;
    if (_str(p.status) !== MG_DECLARED) return;
    var mid = _str(p.manager_id);
    if (!byManager[mid]) byManager[mid] = [];
    byManager[mid].push(_str(p.team_id));
  });

  var dupes = {};
  Object.keys(byManager).forEach(function (mid) {
    if (byManager[mid].length > 1) dupes[mid] = byManager[mid];
  });
  return dupes;
}

/**
 * 申告1件を画面用に整える。
 *
 * @param {Object} p
 * @returns {Object}
 */
function _pickView(p) {
  return {
    pick_id:    _str(p.pick_id),
    season_id:  _str(p.season_id),
    team_id:    _str(p.team_id),
    round:      _num(p.round),
    manager_id: _str(p.manager_id),
    status:     _str(p.status),
    created_at: _iso(p.created_at),
    decided_at: _iso(p.decided_at),
  };
}
