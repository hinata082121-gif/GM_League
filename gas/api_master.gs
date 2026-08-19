/**
 * api_master.gs — Phase 1: マスタ & 閲覧 の action ハンドラ
 *
 * 読み取り系（ログイン済みなら誰でも）:
 *   listPlayers / listTeams / listSeasons / getTeamSquad / getTeamBudget
 *
 * 主催者専用（role=organizer）:
 *   listUsers / upsertPlayer / upsertTeam / upsertUser / importPlayersCsv / setConfig
 *
 * 設計原則（SPEC.md §3）:
 *   1. 書き込みはすべてここを通す
 *   3. 予算残高はカラムを持たず BudgetTx の SUM で算出する
 *   補助. 金額・人数・率は Config 参照。コードに直書きしない
 *
 * 注意:
 *   書き込みは必ず withLock() でラップする（lib.gs）。
 */

// =============================================================================
// 認可ヘルパ
// =============================================================================

/**
 * トークンを検証し、ログイン済みユーザーを返す。
 * 失敗時は { ok:false, error } を返すのでそのまま返却できる。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function _requireUser(token) {
  return whoami(token);
}

/**
 * トークンを検証し、role=organizer であることを確認する。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function _requireOrganizer(token) {
  var res = whoami(token);
  if (!res.ok) return res;
  if (res.data.role !== "organizer") {
    return { ok: false, error: "forbidden_organizer_only" };
  }
  return res;
}

// =============================================================================
// 値の正規化・検証ヘルパ
// =============================================================================

/** 許可されるポジション */
var POSITIONS = ["GK", "DF", "MF", "FW"];

/** 許可されるロール */
var ROLES = ["team", "organizer"];

/** 許可されるチーム種別 */
var TEAM_KINDS = ["新規", "継続"];

/**
 * シートの真偽値表現を JS の boolean に正規化する。
 * TRUE / true / 1 / "○" を true とみなす。
 *
 * @param {*} v
 * @returns {boolean}
 */
function _toBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  var s = String(v).trim().toLowerCase();
  return s === "true" || s === "1" || s === "○" || s === "yes";
}

/**
 * 空白を落とした文字列を返す。null / undefined は空文字。
 *
 * @param {*} v
 * @returns {string}
 */
function _str(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

/**
 * 数値に変換する。変換できない場合は 0。
 *
 * @param {*} v
 * @returns {number}
 */
function _num(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

/**
 * 値が許可リストに含まれるか検証する。含まれない場合は例外。
 *
 * @param {string} label
 * @param {*} value
 * @param {string[]} allowed
 */
function _assertEnum(label, value, allowed) {
  if (allowed.indexOf(value) === -1) {
    throw new Error(label + " が不正です: " + value + "（許可: " + allowed.join("/") + "）");
  }
}

// =============================================================================
// 読み取り系
// =============================================================================

/**
 * 選手マスタを返す。
 * payload.eligible_only が true の場合は eligible=true のみ返す。
 * payload.position を指定するとそのポジションのみに絞る。
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listPlayers(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var eligibleOnly = _toBool(payload.eligible_only);
  var position = _str(payload.position);

  var rows = getSheetData("Players").map(function (r) {
    return {
      player_id: _str(r.player_id),
      name:      _str(r.name),
      position:  _str(r.position),
      real_club: _str(r.real_club),
      eligible:  _toBool(r.eligible),
    };
  });

  if (eligibleOnly) {
    rows = rows.filter(function (p) { return p.eligible; });
  }
  if (position) {
    rows = rows.filter(function (p) { return p.position === position; });
  }

  rows.sort(_comparePlayers);
  return { ok: true, data: rows };
}

/**
 * 選手の並び順比較関数。
 * ポジション順（GK→DF→MF→FW）、同ポジション内は名前順。
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {number}
 */
function _comparePlayers(a, b) {
  var ai = POSITIONS.indexOf(a.position);
  var bi = POSITIONS.indexOf(b.position);
  if (ai === -1) ai = POSITIONS.length;
  if (bi === -1) bi = POSITIONS.length;
  if (ai !== bi) return ai - bi;
  return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
}

/**
 * チーム一覧を返す。
 * payload.active_only が true の場合は active=true のみ返す。
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listTeams(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var activeOnly = _toBool(payload.active_only);

  // オーナーの表示名と X ID を添える。
  // 試合連絡や移籍交渉の相手を画面から直接呼び出せるようにするため。
  var owners = {};
  getSheetData("Users").forEach(function (u) {
    owners[_str(u.user_id)] = {
      display_name: _str(u.display_name),
      x_id:         _str(u.x_id),
    };
  });

  var rows = getSheetData("Teams").map(function (r) {
    var owner = owners[_str(r.owner_user_id)] || null;
    return {
      team_id:       _str(r.team_id),
      name:          _str(r.name),
      owner_user_id: _str(r.owner_user_id),
      owner_name:    owner ? owner.display_name : "",
      owner_x_id:    owner ? owner.x_id : "",
      kind:          _str(r.kind),
      active:        _toBool(r.active),
    };
  });

  if (activeOnly) {
    rows = rows.filter(function (t) { return t.active; });
  }

  return { ok: true, data: rows };
}

/**
 * シーズン一覧を返す。作成日の新しい順。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listSeasons(token) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var rows = getSheetData("Seasons").map(function (r) {
    return {
      season_id:       _str(r.season_id),
      name:            _str(r.name),
      status:          _str(r.status),
      leg_enabled:     _toBool(r.leg_enabled),
      window1_open_at: _iso(r.window1_open_at),
      window2_open_at: _iso(r.window2_open_at),
      claim_deadline_at: _iso(r.claim_deadline_at),
      created_at:      _iso(r.created_at),
    };
  });

  rows.reverse();
  return { ok: true, data: rows };
}

/**
 * 現実のJリーグクラブ一覧を Clubs シートから返す。
 * 選手登録画面の「カテゴリー → クラブ」2段プルダウンに使う。
 *
 * カテゴリーごとにまとめた形で返すため、フロント側で分類し直す必要はない。
 * sort_order の昇順で並べる。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listClubs(token) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var rows = getSheetData("Clubs")
    .map(function (r) {
      return {
        category:   _str(r.category),
        club_name:  _str(r.club_name),
        sort_order: _num(r.sort_order),
      };
    })
    .filter(function (r) { return r.club_name; });

  rows.sort(function (a, b) { return a.sort_order - b.sort_order; });

  var categories = [];
  var grouped = {};

  rows.forEach(function (r) {
    if (!grouped[r.category]) {
      grouped[r.category] = [];
      categories.push(r.category);
    }
    grouped[r.category].push(r.club_name);
  });

  return {
    ok: true,
    data: { categories: categories, clubs: grouped, total: rows.length },
  };
}

/**
 * ユーザー一覧を返す。主催者専用。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object[], error?: string }}
 */
function listUsers(token) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var rows = getSheetData("Users").map(function (r) {
    return {
      user_id:      _str(r.user_id),
      email:        _str(r.email),
      display_name: _str(r.display_name),
      role:         _str(r.role),
      team_id:      _str(r.team_id),
      x_id:         _str(r.x_id),
    };
  });

  return { ok: true, data: rows };
}

/**
 * X（旧Twitter）の ID を正規化する。
 *
 * 参加者は「@name」「https://x.com/name」「twitter.com/name?s=20」など
 * 好きな形で貼ってくるため、ID 部分だけを取り出して保存する。
 * 表示側は常に https://x.com/<id> を組み立てればよくなる。
 *
 * @param {*} v
 * @returns {string} 正規化した ID（不正なら空文字）
 */
function normalizeXId(v) {
  var raw = _str(v).trim();
  if (!raw) return "";

  // URL 形式なら最後のパス要素を取り出す
  raw = raw.replace(/^https?:\/\//i, "");
  raw = raw.replace(/^(www\.)?(x|twitter)\.com\//i, "");

  // クエリ・ハッシュ・末尾スラッシュを落とす
  raw = raw.split("?")[0].split("#")[0].replace(/\/+$/, "");

  // 先頭の @ を落とす
  raw = raw.replace(/^@+/, "");

  if (!raw) return "";

  // X の ID は英数字とアンダースコアのみ・15文字以内
  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) return "";

  return raw;
}

/**
 * 本人が自分のプロフィール（表示名・X ID）を更新する。
 *
 * 主催者を経由せず参加者自身が直せるようにする。
 * role や team_id はここでは変更できない（権限昇格を防ぐため）。
 *
 * payload: { display_name?, x_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function updateMyProfile(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var updates = {};

  if (payload.display_name !== undefined) {
    var name = _str(payload.display_name).trim();
    if (!name) return { ok: false, error: "表示名を空にはできません。" };
    if (name.length > 40) return { ok: false, error: "表示名は40文字以内で入力してください。" };
    updates.display_name = name;
  }

  if (payload.x_id !== undefined) {
    var raw = _str(payload.x_id).trim();
    var xid = normalizeXId(raw);
    if (raw && !xid) {
      return {
        ok: false,
        error: "X の ID として認識できません。英数字とアンダースコア15文字以内で入力してください（@やURLのままでも構いません）。",
      };
    }
    updates.x_id = xid;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, error: "更新する項目がありません。" };
  }

  var user = auth.data;

  return withLock(function () {
    updateRow("Users", "user_id", _str(user.user_id), updates);
    return {
      ok: true,
      data: {
        user_id:      _str(user.user_id),
        display_name: updates.display_name === undefined
          ? _str(user.display_name) : updates.display_name,
        x_id: updates.x_id === undefined ? _str(user.x_id) : updates.x_id,
      },
    };
  });
}

/**
 * 日付を ISO 文字列に変換する。Date でない場合はそのまま文字列化。
 *
 * @param {*} v
 * @returns {string}
 */
function _iso(v) {
  if (v instanceof Date) return v.toISOString();
  return _str(v);
}

/**
 * 指定チームのスカッドを返す。
 * Rosters の status=在籍 のみを対象とし、Players の情報を結合する。
 * ポジション順（GK→DF→MF→FW）で並べる。
 *
 * payload: { team_id: string, season_id: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getTeamSquad(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var teamId = _str(payload.team_id);
  var seasonId = _str(payload.season_id);
  if (!teamId) return { ok: false, error: "team_id は必須です。" };

  var playerMap = {};
  getSheetData("Players").forEach(function (p) {
    playerMap[_str(p.player_id)] = p;
  });

  var squad = [];
  getSheetData("Rosters").forEach(function (r) {
    if (_str(r.team_id) !== teamId) return;
    if (_str(r.status) !== "在籍") return;
    if (seasonId && _str(r.season_id) !== seasonId) return;

    var pid = _str(r.player_id);
    var p = playerMap[pid] || {};

    squad.push({
      roster_id:        _str(r.roster_id),
      season_id:        _str(r.season_id),
      player_id:        pid,
      name:             _str(p.name),
      position:         _str(p.position),
      real_club:        _str(p.real_club),
      eligible:         _toBool(p.eligible),
      acquisition_type: _str(r.acquisition_type),
      acquired_cost:    _num(r.acquired_cost),
      acquired_at:      _iso(r.acquired_at),
      expires_season:   _str(r.expires_season),
    });
  });

  squad.sort(_comparePlayers);

  var counts = { GK: 0, DF: 0, MF: 0, FW: 0 };
  squad.forEach(function (s) {
    if (counts.hasOwnProperty(s.position)) counts[s.position]++;
  });

  var team = findRow("Teams", "team_id", teamId);

  return {
    ok: true,
    data: {
      team_id: teamId,
      team_name: team ? _str(team.name) : "",
      season_id: seasonId,
      total: squad.length,
      position_counts: counts,
      squad: squad,
    },
  };
}

/**
 * ログイン中ユーザーの自チーム概要を返す。
 * ダッシュボード用にスカッドと予算をまとめて返す。
 *
 * role=organizer の場合は team_id が無いため payload.team_id を使う。
 * 指定が無ければ team なし扱いで返す。
 *
 * payload: { season_id?: string, team_id?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getMyTeam(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var user = auth.data;
  var teamId = _str(user.team_id) || _str(payload.team_id);
  var seasonId = _str(payload.season_id);

  if (!teamId) {
    return {
      ok: true,
      data: { user: user, team: null, squad: null, budget: null },
    };
  }

  var squadRes = getTeamSquad(token, { team_id: teamId, season_id: seasonId });
  if (!squadRes.ok) return squadRes;

  var budgetRes = getTeamBudget(token, { team_id: teamId, season_id: "" });
  if (!budgetRes.ok) return budgetRes;

  var team = findRow("Teams", "team_id", teamId);

  return {
    ok: true,
    data: {
      user: user,
      team: team
        ? {
            team_id:       _str(team.team_id),
            name:          _str(team.name),
            owner_user_id: _str(team.owner_user_id),
            kind:          _str(team.kind),
            active:        _toBool(team.active),
          }
        : null,
      squad: squadRes.data,
      budget: budgetRes.data,
    },
  };
}

/**
 * 指定チームの現保有予算を返す。
 *
 * SPEC.md §3 原則3:
 *   残高カラムは持たない。BudgetTx の amount 合計で常に算出する。
 *
 * season_id を指定した場合はそのシーズンの取引のみを合計する。
 * 省略した場合は全期間の合計（＝現在の保有額）を返す。
 *
 * payload: { team_id: string, season_id?: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function getTeamBudget(token, payload) {
  var auth = _requireUser(token);
  if (!auth.ok) return auth;

  var teamId = _str(payload.team_id);
  var seasonId = _str(payload.season_id);
  if (!teamId) return { ok: false, error: "team_id は必須です。" };

  var balance = 0;
  var byReason = {};
  var txList = [];

  getSheetData("BudgetTx").forEach(function (t) {
    if (_str(t.team_id) !== teamId) return;
    if (seasonId && _str(t.season_id) !== seasonId) return;

    var amount = _num(t.amount);
    var reason = _str(t.reason);

    balance += amount;
    byReason[reason] = (byReason[reason] || 0) + amount;

    txList.push({
      tx_id:      _str(t.tx_id),
      season_id:  _str(t.season_id),
      amount:     amount,
      reason:     reason,
      ref:        _str(t.ref),
      created_at: _iso(t.created_at),
    });
  });

  var breakdown = Object.keys(byReason).map(function (reason) {
    return { reason: reason, amount: byReason[reason] };
  });

  return {
    ok: true,
    data: {
      team_id: teamId,
      season_id: seasonId,
      balance: balance,
      breakdown: breakdown,
      tx_count: txList.length,
      tx: txList,
    },
  };
}

// =============================================================================
// 書き込み系（主催者専用）
// =============================================================================

/**
 * 選手を新規登録または更新する。
 * player_id が指定され既存行がある場合は更新、それ以外は新規採番して追加。
 *
 * payload: { player_id?, name, position, real_club?, eligible? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertPlayer(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var name = _str(payload.name);
  var position = _str(payload.position).toUpperCase();
  if (!name) return { ok: false, error: "name は必須です。" };

  try {
    _assertEnum("position", position, POSITIONS);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var row = {
    player_id: _str(payload.player_id),
    name:      name,
    position:  position,
    real_club: _str(payload.real_club),
    eligible:  payload.eligible === undefined ? true : _toBool(payload.eligible),
  };

  return withLock(function () {
    if (row.player_id && findRow("Players", "player_id", row.player_id)) {
      updateRow("Players", "player_id", row.player_id, {
        name:      row.name,
        position:  row.position,
        real_club: row.real_club,
        eligible:  row.eligible,
      });
      return { ok: true, data: { player_id: row.player_id, created: false } };
    }

    if (!row.player_id) row.player_id = generateId("p_");
    appendRow("Players", row);
    return { ok: true, data: { player_id: row.player_id, created: true } };
  });
}

/**
 * チームを新規登録または更新する。
 *
 * payload: { team_id?, name, owner_user_id?, kind?, active? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertTeam(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var name = _str(payload.name);
  if (!name) return { ok: false, error: "name は必須です。" };

  var kind = _str(payload.kind) || "新規";
  try {
    _assertEnum("kind", kind, TEAM_KINDS);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var row = {
    team_id:       _str(payload.team_id),
    name:          name,
    owner_user_id: _str(payload.owner_user_id),
    kind:          kind,
    active:        payload.active === undefined ? true : _toBool(payload.active),
  };

  return withLock(function () {
    if (row.team_id && findRow("Teams", "team_id", row.team_id)) {
      updateRow("Teams", "team_id", row.team_id, {
        name:          row.name,
        owner_user_id: row.owner_user_id,
        kind:          row.kind,
        active:        row.active,
      });
      return { ok: true, data: { team_id: row.team_id, created: false } };
    }

    if (!row.team_id) row.team_id = generateId("t_");
    appendRow("Teams", row);
    return { ok: true, data: { team_id: row.team_id, created: true } };
  });
}

/**
 * ユーザーを新規登録または更新する。
 * email は一意。既存 email があればその行を更新する。
 *
 * payload: { user_id?, email, display_name?, role?, team_id? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertUser(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var email = _str(payload.email).toLowerCase();
  if (!email) return { ok: false, error: "email は必須です。" };

  var role = _str(payload.role) || "team";
  try {
    _assertEnum("role", role, ROLES);
  } catch (e) {
    return { ok: false, error: e.message };
  }

  var row = {
    user_id:      _str(payload.user_id),
    email:        email,
    display_name: _str(payload.display_name) || email,
    role:         role,
    team_id:      role === "organizer" ? "" : _str(payload.team_id),
    x_id:         normalizeXId(payload.x_id),
  };

  return withLock(function () {
    var existing = _findUserRowByEmail(email);
    if (existing) {
      updateRow("Users", "user_id", _str(existing.user_id), {
        email:        row.email,
        display_name: row.display_name,
        role:         row.role,
        team_id:      row.team_id,
        x_id:         row.x_id,
      });
      return { ok: true, data: { user_id: _str(existing.user_id), created: false } };
    }

    if (!row.user_id) row.user_id = generateId("u_");
    appendRow("Users", row);
    return { ok: true, data: { user_id: row.user_id, created: true } };
  });
}

/**
 * Users シートから email で行を探す（大文字小文字を無視）。
 *
 * @param {string} email
 * @returns {Object|null}
 */
function _findUserRowByEmail(email) {
  var rows = getSheetData("Users");
  for (var i = 0; i < rows.length; i++) {
    if (_str(rows[i].email).toLowerCase() === email.toLowerCase()) return rows[i];
  }
  return null;
}

/**
 * CSV 文字列から Players を一括登録する。
 *
 * 想定ヘッダー: name,position,real_club
 * eligible 列があれば読み取り、なければ true として登録する。
 * 同名かつ同ポジションの選手が既にいる場合はスキップする。
 *
 * payload: { csv: string }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function importPlayersCsv(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var csv = _str(payload.csv);
  if (!csv) return { ok: false, error: "csv は必須です。" };

  var table;
  try {
    table = Utilities.parseCsv(csv);
  } catch (e) {
    return { ok: false, error: "CSV の解析に失敗しました: " + e.message };
  }
  if (!table || table.length < 2) {
    return { ok: false, error: "CSV にデータ行がありません。" };
  }

  var headers = table[0].map(function (h) { return _str(h).toLowerCase(); });
  var iName = headers.indexOf("name");
  var iPos = headers.indexOf("position");
  var iClub = headers.indexOf("real_club");
  var iElig = headers.indexOf("eligible");

  if (iName === -1 || iPos === -1) {
    return { ok: false, error: "CSV ヘッダーに name と position が必要です。" };
  }

  return withLock(function () {
    var existing = {};
    getSheetData("Players").forEach(function (p) {
      existing[_str(p.name) + "|" + _str(p.position)] = true;
    });

    var toAppend = [];
    var skipped = 0;
    var errors = [];

    for (var i = 1; i < table.length; i++) {
      var line = table[i];
      var name = _str(line[iName]);
      if (!name) continue;

      var position = _str(line[iPos]).toUpperCase();
      if (POSITIONS.indexOf(position) === -1) {
        errors.push((i + 1) + "行目: position が不正 (" + position + ")");
        continue;
      }

      var key = name + "|" + position;
      if (existing[key]) {
        skipped++;
        continue;
      }
      existing[key] = true;

      toAppend.push({
        player_id: generateId("p_"),
        name:      name,
        position:  position,
        real_club: iClub === -1 ? "" : _str(line[iClub]),
        eligible:  iElig === -1 ? true : _toBool(line[iElig]),
      });
    }

    _appendRowsBatch("Players", toAppend);

    return {
      ok: true,
      data: { added: toAppend.length, skipped: skipped, errors: errors },
    };
  });
}

/**
 * 複数行をまとめて追記する。
 * appendRow を繰り返すより API 呼び出し回数が少なく済む。
 *
 * 呼び出し元は withLock() 内から呼ぶこと。
 *
 * @param {string} sheetName
 * @param {Object[]} rowObjs
 */
function _appendRowsBatch(sheetName, rowObjs) {
  if (!rowObjs || rowObjs.length === 0) return;

  var sheet = getSheet(sheetName);
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  var matrix = rowObjs.map(function (obj) {
    return headers.map(function (h) {
      return obj[h] !== undefined ? obj[h] : "";
    });
  });

  sheet
    .getRange(sheet.getLastRow() + 1, 1, matrix.length, headers.length)
    .setValues(matrix);
}

/**
 * Config シートの値を更新または追加する。
 * 主催者専用。更新後はキャッシュをクリアする。
 *
 * payload: { key: string, value: string|number }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function setConfig(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var key = _str(payload.key);
  if (!key) return { ok: false, error: "key は必須です。" };
  var value = payload.value === undefined ? "" : payload.value;

  return withLock(function () {
    var updated = updateRow("Config", "key", key, { value: value });
    if (!updated) {
      appendRow("Config", { key: key, value: value });
    }
    clearConfigCache();
    return { ok: true, data: { key: key, value: value, created: !updated } };
  });
}

/**
 * Config 全件を返す。主催者専用。
 *
 * @param {string} token
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function listConfig(token) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;
  return { ok: true, data: getAllConfig() };
}
