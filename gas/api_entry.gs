/**
 * api_entry.gs — Phase 2: エントリー提出 の action ハンドラ
 *
 * チームオーナー向け:
 *   getEntryStatus  — 自チームの提出状況＋選択可能な選手一覧
 *   submitEntryList — エントリーリスト提出
 *
 * 主催者向け:
 *   listEntryLists    — 全チームの提出状況
 *   approveEntryList  — 承認（Rosters を 在籍 に）
 *   rejectEntryList   — 差戻（申請中の Rosters を削除）
 *
 * 検証ルールは SPEC.md §7.1.5。要点:
 *   - シーズン status が エントリー受付 であること
 *   - 新規チームは new_team_entry_count（=28）ちょうど
 *   - 継続チームは squad_min〜squad_max の範囲
 *   - eligible=false の選手は不可
 *   - リスト内の重複不可
 *   - 他チームが同シーズンで確保済み（申請中/在籍）の選手は不可
 *
 * ⚠️ 人数はすべて Config 参照。コードに直書きしない（SPEC.md §3 補助原則）。
 * ⚠️ 時刻は GAS の now() を使う。クライアント時刻は受け取らない（原則2）。
 */

// =============================================================================
// 定数
// =============================================================================

/** Rosters.status の取りうる値 */
var ROSTER_PENDING = "申請中";
var ROSTER_ACTIVE = "在籍";
var ROSTER_LEFT = "離脱";

/** EntryLists.status の取りうる値 */
var ENTRY_NONE = "未提出";
var ENTRY_SUBMITTED = "提出済";
var ENTRY_APPROVED = "承認";
var ENTRY_REJECTED = "差戻";

/** エントリー提出を受け付けるシーズン status */
var SEASON_ENTRY_OPEN = "エントリー受付";

// =============================================================================
// 読み取り
// =============================================================================

/**
 * 自チーム（または指定チーム）のエントリー状況を返す。
 *
 * 返す内容:
 *   - シーズン情報と提出可否
 *   - 現在の提出状態（未提出 / 提出済 / 承認 / 差戻）
 *   - 必要人数（新規=28 / 継続=引継ぎ人数）
 *   - 選択可能な選手一覧（eligible=true かつ他チーム未確保）
 *   - 既に自チームが選んでいる選手 ID
 *
 * payload: { season_id: string, team_id?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getEntryStatus(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "team_id は必須です。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  var season = findRow("Seasons", "season_id", seasonId);
  if (!season) return { ok: false, error: "シーズンが見つかりません: " + seasonId };

  var team = findRow("Teams", "team_id", teamId);
  if (!team) return { ok: false, error: "チームが見つかりません: " + teamId };

  var kind = _str(team.kind) || "新規";
  var seasonStatus = _str(season.status);

  // 同シーズンで他チームが確保済みの選手を集める
  var claimed = _collectClaimedPlayers(seasonId);

  // 自チームが現在保持している行
  var mine = [];
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.team_id) !== teamId) return;
    if (_str(r.status) === ROSTER_LEFT) return;
    mine.push({ player_id: _str(r.player_id), status: _str(r.status) });
  });

  var myIds = {};
  mine.forEach(function (m) { myIds[m.player_id] = true; });

  // 選択可能な選手 = 自クラブの実在選手 かつ eligible かつ（他チーム未確保 or 自チーム保持中）
  //
  // チーム名は実在の J クラブ名そのもの。エントリーは自分のクラブの選手からだけ選ぶ。
  // 大会の選手プールが「参加クラブの選手の集合」になるので、
  // クラブが大会から抜けたときの扱いを現実移籍と同じ理屈で書ける（SPEC.md §6.5）。
  var myClub = _str(team.name);

  var available = [];
  getSheetData("Players").forEach(function (p) {
    var pid = _str(p.player_id);
    if (!pid) return;
    if (!_toBool(p.eligible)) return;
    if (_str(p.real_club) !== myClub) return;

    var owner = claimed[pid];
    if (owner && owner !== teamId) return;

    available.push({
      player_id: pid,
      name:      _str(p.name),
      position:  _str(p.position),
      real_club: _str(p.real_club),
    });
  });

  available.sort(_comparePlayers);

  var entry = _findEntryList(seasonId, teamId);
  var entryStatus = entry ? _str(entry.status) : ENTRY_NONE;

  var required = _requiredCount(kind, mine.length);

  // 自クラブの選手が足りないと 28 名を選べない。先に気づけるようにする
  var clubShortage = kind === "新規" && available.length < required
    ? myClub + " の選択可能な選手が " + available.length + " 名しかいません（必要 " +
      required + " 名）。主催者に選手マスタの確認を依頼してください。"
    : "";

  return {
    ok: true,
    data: {
      season_id:      seasonId,
      season_name:    _str(season.name),
      season_status:  seasonStatus,
      team_id:        teamId,
      team_name:      _str(team.name),
      team_kind:      kind,
      entry_status:   entryStatus,
      submitted_at:   entry ? _iso(entry.submitted_at) : "",
      can_submit:     seasonStatus === SEASON_ENTRY_OPEN && entryStatus !== ENTRY_APPROVED,
      required:       required,
      selected_ids:   Object.keys(myIds),
      selected_count: mine.length,
      available:      available,
      available_count: available.length,
      my_club:        myClub,
      club_shortage:  clubShortage,
    },
  };
}

/**
 * 提出に必要な人数の下限・上限・目安を返す。
 *
 * 新規チーム: new_team_entry_count ちょうど
 * 継続チーム: squad_min 〜 squad_max
 *
 * @param {string} kind        新規 / 継続
 * @param {number} inheritedN  継続チームの引継ぎ人数
 * @returns {{ min: number, max: number, exact: number|null, label: string }}
 */
function _requiredCount(kind, inheritedN) {
  var squadMin = getConfigNum("squad_min", 22);
  var squadMax = getConfigNum("squad_max", 35);

  if (kind === "継続") {
    return {
      min: squadMin,
      max: squadMax,
      exact: null,
      label: squadMin + "〜" + squadMax + "名（引継ぎ " + inheritedN + " 名）",
    };
  }

  var exact = getConfigNum("new_team_entry_count", 28);
  return {
    min: exact,
    max: exact,
    exact: exact,
    label: exact + "名ちょうど",
  };
}

/**
 * 指定シーズンで既に確保されている選手を { player_id: team_id } で返す。
 * 申請中・在籍のみを対象とし、離脱は含めない。
 *
 * @param {string} seasonId
 * @returns {Object}
 */
function _collectClaimedPlayers(seasonId) {
  var claimed = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    var status = _str(r.status);
    if (status !== ROSTER_PENDING && status !== ROSTER_ACTIVE) return;
    claimed[_str(r.player_id)] = _str(r.team_id);
  });
  return claimed;
}

/**
 * EntryLists から該当シーズン・チームの行を探す。
 * EntryLists には単一主キーが無いため、2カラムで突き合わせる。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {Object|null}
 */
function _findEntryList(seasonId, teamId) {
  var rows = getSheetData("EntryLists");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].season_id) === seasonId && _str(rows[i].team_id) === teamId) {
      return rows[i];
    }
  }
  return null;
}

/**
 * 対象チームを操作する権限があるか確認する。
 * organizer は全チーム可。team ロールは自チームのみ。
 *
 * @param {Object} user
 * @param {string} teamId
 * @returns {{ ok: boolean, error?: string }}
 */
function _checkTeamAccess(user, teamId) {
  if (user.role === "organizer") return { ok: true };
  if (_str(user.team_id) === teamId) return { ok: true };
  return { ok: false, error: "forbidden_other_team" };
}

/**
 * 全チームのエントリー提出状況を返す。主催者専用。
 *
 * payload: { season_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listEntryLists(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  // シーズン内の Rosters をチーム別に数える
  var counts = {};
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    var status = _str(r.status);
    if (status !== ROSTER_PENDING && status !== ROSTER_ACTIVE) return;

    var tid = _str(r.team_id);
    if (!counts[tid]) counts[tid] = { pending: 0, active: 0 };
    if (status === ROSTER_PENDING) counts[tid].pending++;
    else counts[tid].active++;
  });

  var entries = {};
  getSheetData("EntryLists").forEach(function (e) {
    if (_str(e.season_id) !== seasonId) return;
    entries[_str(e.team_id)] = e;
  });

  var rows = getSheetData("Teams")
    .filter(function (t) { return _toBool(t.active); })
    .map(function (t) {
      var tid = _str(t.team_id);
      var e = entries[tid];
      var c = counts[tid] || { pending: 0, active: 0 };

      return {
        team_id:      tid,
        team_name:    _str(t.name),
        kind:         _str(t.kind),
        status:       e ? _str(e.status) : ENTRY_NONE,
        count:        e ? _num(e.count) : 0,
        submitted_at: e ? _iso(e.submitted_at) : "",
        pending:      c.pending,
        active:       c.active,
      };
    });

  return { ok: true, data: rows };
}

// =============================================================================
// 提出
// =============================================================================

/**
 * エントリーリストを提出する。
 *
 * 新規チーム: player_ids を受け取り、検証して Rosters に status=申請中 で保存。
 * 継続チーム: player_ids は無視し、引継ぎ済みの在籍スカッドの人数だけ検証する。
 *
 * payload: { season_id: string, team_id?: string, player_ids: string[] }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function submitEntryList(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id) || _str(user.team_id);
  var playerIds = payload.player_ids || [];

  if (!seasonId) return { ok: false, error: "season_id は必須です。" };
  if (!teamId) return { ok: false, error: "team_id は必須です。" };

  var access = _checkTeamAccess(user, teamId);
  if (!access.ok) return access;

  return withLock(function () {
    var season = findRow("Seasons", "season_id", seasonId);
    if (!season) return { ok: false, error: "シーズンが見つかりません。" };

    if (_str(season.status) !== SEASON_ENTRY_OPEN) {
      return {
        ok: false,
        error: "現在このシーズンはエントリー受付中ではありません（状態: " + _str(season.status) + "）。",
      };
    }

    var team = findRow("Teams", "team_id", teamId);
    if (!team) return { ok: false, error: "チームが見つかりません。" };

    var kind = _str(team.kind) || "新規";

    var entry = _findEntryList(seasonId, teamId);
    if (entry && _str(entry.status) === ENTRY_APPROVED) {
      return { ok: false, error: "既に承認済みのため再提出できません。" };
    }

    if (kind === "継続") {
      return _submitContinuingTeam(seasonId, teamId, entry);
    }
    return _submitNewTeam(seasonId, teamId, playerIds, entry);
  });
}

/**
 * 新規チームのエントリー提出。
 * 検証をすべて通ったら、既存の申請中行を消してから新しく書き込む。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {string[]} playerIds
 * @param {Object|null} entry
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function _submitNewTeam(seasonId, teamId, playerIds, entry) {
  var exact = getConfigNum("new_team_entry_count", 28);

  var ids = [];
  var seen = {};
  var dupInList = [];

  for (var i = 0; i < playerIds.length; i++) {
    var pid = _str(playerIds[i]);
    if (!pid) continue;
    if (seen[pid]) {
      dupInList.push(pid);
      continue;
    }
    seen[pid] = true;
    ids.push(pid);
  }

  if (dupInList.length > 0) {
    return { ok: false, error: "リスト内に同じ選手が重複しています。" };
  }

  if (ids.length !== exact) {
    return {
      ok: false,
      error: "登録人数が " + exact + " 名ちょうどである必要があります（現在 " + ids.length + " 名）。",
    };
  }

  // 選手マスタを引いて実在・eligible を確認
  var playerMap = {};
  getSheetData("Players").forEach(function (p) {
    playerMap[_str(p.player_id)] = p;
  });

  var notFound = [];
  var notEligible = [];

  ids.forEach(function (pid) {
    var p = playerMap[pid];
    if (!p) {
      notFound.push(pid);
    } else if (!_toBool(p.eligible)) {
      notEligible.push(_str(p.name));
    }
  });

  if (notFound.length > 0) {
    return { ok: false, error: "存在しない選手が含まれています: " + notFound.join(", ") };
  }
  if (notEligible.length > 0) {
    return {
      ok: false,
      error: "エントリー対象外（eligible=false）の選手が含まれています: " + notEligible.join(", "),
    };
  }

  // 自クラブの選手だけを選べる。画面のプルダウンに頼らずここでも確認する
  var myTeam = findRow("Teams", "team_id", teamId);
  var myClub = myTeam ? _str(myTeam.name) : "";
  var otherClub = [];
  ids.forEach(function (pid) {
    var p = playerMap[pid];
    if (p && _str(p.real_club) !== myClub) {
      otherClub.push(_str(p.name) + "（" + _str(p.real_club) + "）");
    }
  });

  if (otherClub.length > 0) {
    return {
      ok: false,
      error: "エントリーは " + myClub + " の選手からのみ選べます。対象外: " + otherClub.join(", "),
    };
  }

  // 他チームが確保済みの選手が含まれていないか
  var claimed = _collectClaimedPlayers(seasonId);
  var teamNames = {};
  getSheetData("Teams").forEach(function (t) {
    teamNames[_str(t.team_id)] = _str(t.name);
  });

  var conflicts = [];
  ids.forEach(function (pid) {
    var owner = claimed[pid];
    if (owner && owner !== teamId) {
      var pname = playerMap[pid] ? _str(playerMap[pid].name) : pid;
      conflicts.push(pname + "（" + (teamNames[owner] || owner) + "）");
    }
  });

  if (conflicts.length > 0) {
    return {
      ok: false,
      error: "他チームが既に確保している選手が含まれています: " + conflicts.join(" / "),
    };
  }

  // ここまで通ったら書き込み。
  // 新規チームのエントリーリストはスカッド全体を定義するものなので、
  // 申請中だけでなく在籍行も含めて総入れ替えする（離脱の履歴は残す）。
  _deleteEntryRosters(seasonId, teamId);

  var stamp = now();
  var rows = ids.map(function (pid) {
    return {
      roster_id:        generateId("r_"),
      season_id:        seasonId,
      team_id:          teamId,
      player_id:        pid,
      acquisition_type: "初期",
      acquired_cost:    0,
      acquired_at:      stamp,
      expires_season:   "",
      status:           ROSTER_PENDING,
    };
  });

  _appendRowsBatch("Rosters", rows);
  _upsertEntryList(seasonId, teamId, ids.length, ENTRY_SUBMITTED, stamp, entry);

  return {
    ok: true,
    data: { team_id: teamId, count: ids.length, status: ENTRY_SUBMITTED },
  };
}

/**
 * 継続チームのエントリー提出。
 * 引継ぎ済みの在籍スカッドの人数が範囲内かだけを確認する。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {Object|null} entry
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function _submitContinuingTeam(seasonId, teamId, entry) {
  var squadMin = getConfigNum("squad_min", 22);
  var squadMax = getConfigNum("squad_max", 35);

  var count = 0;
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.season_id) !== seasonId) return;
    if (_str(r.team_id) !== teamId) return;
    var st = _str(r.status);
    if (st === ROSTER_PENDING || st === ROSTER_ACTIVE) count++;
  });

  if (count < squadMin || count > squadMax) {
    return {
      ok: false,
      error:
        "引継ぎスカッドが " + squadMin + "〜" + squadMax +
        " 名の範囲外です（現在 " + count + " 名）。主催者に連絡してください。",
    };
  }

  var stamp = now();
  _upsertEntryList(seasonId, teamId, count, ENTRY_SUBMITTED, stamp, entry);

  return { ok: true, data: { team_id: teamId, count: count, status: ENTRY_SUBMITTED } };
}

/**
 * EntryLists の行を追加または更新する。
 * EntryLists には単一主キーが無いため、行番号を特定して直接書き換える。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {number} count
 * @param {string} status
 * @param {Date} stamp
 * @param {Object|null} existing
 */
function _upsertEntryList(seasonId, teamId, count, status, stamp, existing) {
  if (!existing) {
    appendRow("EntryLists", {
      season_id:    seasonId,
      team_id:      teamId,
      count:        count,
      submitted_at: stamp,
      status:       status,
    });
    return;
  }

  var sheet = getSheet("EntryLists");
  var values = sheet.getDataRange().getValues();
  var headers = values[0];

  var iSeason = headers.indexOf("season_id");
  var iTeam = headers.indexOf("team_id");
  var iCount = headers.indexOf("count");
  var iAt = headers.indexOf("submitted_at");
  var iStatus = headers.indexOf("status");

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][iSeason]) === seasonId && String(values[i][iTeam]) === teamId) {
      sheet.getRange(i + 1, iCount + 1).setValue(count);
      sheet.getRange(i + 1, iAt + 1).setValue(stamp);
      sheet.getRange(i + 1, iStatus + 1).setValue(status);
      return;
    }
  }
}

/**
 * 指定シーズン・チームの「申請中」Rosters 行をすべて削除する。
 * 差戻で使う（承認済みの在籍行には触れない）。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number} 削除した行数
 */
function _deletePendingRosters(seasonId, teamId) {
  return _deleteRostersByStatus(seasonId, teamId, [ROSTER_PENDING]);
}

/**
 * 新規チームのエントリー提出前に、そのチームの既存スカッドを一掃する。
 * 申請中・在籍の両方が対象。離脱は履歴として残す。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number} 削除した行数
 */
function _deleteEntryRosters(seasonId, teamId) {
  return _deleteRostersByStatus(seasonId, teamId, [ROSTER_PENDING, ROSTER_ACTIVE]);
}

/**
 * 指定シーズン・チームで、status が対象に含まれる Rosters 行を削除する。
 * 下の行から消して行番号のズレを避ける。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @param {string[]} statuses
 * @returns {number} 削除した行数
 */
function _deleteRostersByStatus(seasonId, teamId, statuses) {
  var sheet = getSheet("Rosters");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iTeam = headers.indexOf("team_id");
  var iStatus = headers.indexOf("status");

  var removed = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (
      String(values[i][iSeason]) === seasonId &&
      String(values[i][iTeam]) === teamId &&
      statuses.indexOf(String(values[i][iStatus])) !== -1
    ) {
      sheet.deleteRow(i + 1);
      removed++;
    }
  }
  return removed;
}

// =============================================================================
// シーズン進行（暫定・Phase 7 の advanceSeason で置き換える）
// =============================================================================

/**
 * シーズンの status を変更する。主催者専用。
 *
 * SPEC.md §11 の遷移を正としつつ、運用中に前後へ戻す必要が出るため
 * ここでは任意の値へ切り替えられるようにしている。
 * Phase 7 で advanceSeason（順方向の遷移＋付随処理）を実装したら、
 * こちらは「巻き戻し用」の位置づけになる。
 *
 * payload: { season_id: string, status: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setSeasonStatus(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var status = _str(payload.status);
  if (!seasonId) return { ok: false, error: "season_id は必須です。" };

  try {
    _assertEnum("status", status, SEASON_STATUSES);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  return withLock(function () {
    var updated = updateRow("Seasons", "season_id", seasonId, { status: status });
    if (!updated) return { ok: false, error: "シーズンが見つかりません: " + seasonId };
    return { ok: true, data: { season_id: seasonId, status: status } };
  });
}

/**
 * シーズン status の取りうる値（SPEC.md §4.2 / §11）。
 * 画面のプルダウンにもこの順序で使う。
 */
var SEASON_STATUSES = [
  "準備中",
  "エントリー受付",
  "移籍市場1",
  "シーズン1",
  "移籍市場2",
  "シーズン2",
  "トーナメント",
  "終了",
];

/**
 * シーズン status の選択肢を返す。画面のプルダウン用。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: string[], error?: string }}
 */
function listSeasonStatuses(token) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;
  return { ok: true, data: SEASON_STATUSES };
}

// =============================================================================
// 承認・差戻（主催者専用）
// =============================================================================

/**
 * エントリーを承認する。
 * 申請中の Rosters を在籍に変え、EntryLists を承認にする。
 *
 * payload: { season_id: string, team_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function approveEntryList(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  if (!seasonId || !teamId) {
    return { ok: false, error: "season_id と team_id は必須です。" };
  }

  return withLock(function () {
    var entry = _findEntryList(seasonId, teamId);
    if (!entry) return { ok: false, error: "提出記録が見つかりません。" };
    if (_str(entry.status) !== ENTRY_SUBMITTED) {
      return { ok: false, error: "提出済のエントリーのみ承認できます（現在: " + _str(entry.status) + "）。" };
    }

    var changed = _setPendingRostersActive(seasonId, teamId);
    _upsertEntryList(seasonId, teamId, _num(entry.count), ENTRY_APPROVED, now(), entry);

    return { ok: true, data: { team_id: teamId, activated: changed, status: ENTRY_APPROVED } };
  });
}

/**
 * エントリーを差し戻す。
 * 申請中の Rosters を削除し、EntryLists を差戻にする。
 *
 * payload: { season_id: string, team_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function rejectEntryList(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var seasonId = _str(payload.season_id);
  var teamId = _str(payload.team_id);
  if (!seasonId || !teamId) {
    return { ok: false, error: "season_id と team_id は必須です。" };
  }

  return withLock(function () {
    var entry = _findEntryList(seasonId, teamId);
    if (!entry) return { ok: false, error: "提出記録が見つかりません。" };
    if (_str(entry.status) !== ENTRY_SUBMITTED) {
      return { ok: false, error: "提出済のエントリーのみ差し戻せます（現在: " + _str(entry.status) + "）。" };
    }

    var removed = _deletePendingRosters(seasonId, teamId);
    _upsertEntryList(seasonId, teamId, 0, ENTRY_REJECTED, now(), entry);

    return { ok: true, data: { team_id: teamId, removed: removed, status: ENTRY_REJECTED } };
  });
}

/**
 * 指定シーズン・チームの「申請中」Rosters を「在籍」に一括変更する。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number} 変更した行数
 */
function _setPendingRostersActive(seasonId, teamId) {
  var sheet = getSheet("Rosters");
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var iSeason = headers.indexOf("season_id");
  var iTeam = headers.indexOf("team_id");
  var iStatus = headers.indexOf("status");

  var changed = 0;
  for (var i = 1; i < values.length; i++) {
    if (
      String(values[i][iSeason]) === seasonId &&
      String(values[i][iTeam]) === teamId &&
      String(values[i][iStatus]) === ROSTER_PENDING
    ) {
      sheet.getRange(i + 1, iStatus + 1).setValue(ROSTER_ACTIVE);
      changed++;
    }
  }
  return changed;
}
