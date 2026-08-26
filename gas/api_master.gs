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

/** 許可されるポジション（大分類） */
var POSITIONS = ["GK", "DF", "MF", "FW"];

/**
 * 大分類のなかの詳細ポジション。
 *
 * エントリーリストは LSB / CMF / RWG のような細かい表記で届く。
 * 人数制限や集計は大分類で行い、**表示は届いたままの粒度で出す**。
 * 大分類だけにすると、どこの選手なのかが読み取れなくなる。
 */
var POSITION_DETAILS = {
  GK: ["GK"],
  DF: ["LSB", "CB", "RSB"],
  MF: ["DMF", "CMF", "OMF", "LMF", "RMF"],
  FW: ["LWG", "RWG", "ST", "CF"],
};

/**
 * 詳細ポジションから大分類を引く。
 *
 * @param {string} detail
 * @returns {string} 該当が無ければ空文字
 */
function _positionOfDetail(detail) {
  var d = _str(detail).toUpperCase();
  for (var i = 0; i < POSITIONS.length; i++) {
    if (POSITION_DETAILS[POSITIONS[i]].indexOf(d) !== -1) return POSITIONS[i];
  }
  return "";
}

/**
 * ポジションの指定を大分類と詳細のペアに整える。
 *
 * 詳細だけ渡せば大分類は導ける。大分類だけの場合、詳細は空のままにする
 * （GK は1つしかないので埋める）。
 *
 * @param {*} position 大分類。省略可
 * @param {*} detail 詳細。省略可
 * @returns {{ position: string, detail: string, error?: string }}
 */
function _resolvePosition(position, detail) {
  var p = _str(position).toUpperCase();
  var d = _str(detail).toUpperCase();

  if (d) {
    var from = _positionOfDetail(d);
    if (!from) {
      return { position: p, detail: d, error: "詳細ポジションが不正です: " + d };
    }
    if (p && p !== from) {
      return {
        position: p, detail: d,
        error: d + " は " + from + " の詳細です（" + p + " と一致しません）",
      };
    }
    return { position: from, detail: d };
  }

  if (!p) return { position: "", detail: "", error: "ポジションを指定してください。" };
  if (POSITIONS.indexOf(p) === -1) {
    return { position: p, detail: "", error: "ポジションが不正です: " + p };
  }

  return { position: p, detail: p === "GK" ? "GK" : "" };
}

/**
 * 2つの値の組を、連想配列の鍵にする。
 *
 * 「名前とポジションで選手を引く」「チームと選手で在籍を引く」のように、
 * 2つ揃って初めて1件を指すものに使う。
 *
 * 以前は記号で連結していたが、GAS エディタへ貼り付ける途中で
 * その記号が壊れる事故が繰り返し起きた。壊れても構文エラーにならないので、
 * 気づくのは登録がおかしくなった後になる。
 * 配列を JSON にすれば、区切りの記号をソースに書かずに済む。
 *
 * @param {*} a
 * @param {*} b
 * @returns {string}
 */
function _pairKey(a, b) {
  return JSON.stringify([_str(a), _str(b)]);
}

/** 国籍が未入力のときの既定値 */
var NATIONALITY_DEFAULT = "日本";

/**
 * 国籍を整える。
 *
 * 空欄は「日本」とみなす。名簿の大半は日本人で、
 * 外国籍だけが △ で示される書式に合わせている。
 *
 * @param {*} v
 * @returns {string}
 */
function _normalizeNationality(v) {
  return _str(v) || NATIONALITY_DEFAULT;
}

/**
 * 外国籍かどうか。エントリーリストの △ に対応する。
 *
 * 国籍そのものを持っておき、外国籍かどうかは毎回導く。
 * 真偽値のカラムを別に持つと、国籍と食い違ったときにどちらが正か分からなくなる。
 *
 * @param {*} nationality
 * @returns {boolean}
 */
function _isForeign(nationality) {
  return _normalizeNationality(nationality) !== NATIONALITY_DEFAULT;
}

/**
 * 年齢を整える。
 *
 * 未入力は 0。負の数や現実的でない値は弾く。
 * 年齢は登録した時点のもので、時間が経てば実際とずれる。
 * 誕生日を持たない代わりに、名簿を取り込むたびに上書きしていく運用にする。
 *
 * @param {*} v
 * @returns {{ age: number, error?: string }}
 */
function _parseAge(v) {
  if (v === null || v === undefined || _str(v) === "") return { age: 0 };

  var n = Math.round(_num(v));
  if (n < 0 || n > 60) {
    return { age: 0, error: "年齢が不正です: " + _str(v) };
  }
  return { age: n };
}

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
      detail_position: _str(r.detail_position),
      age:         _num(r.age),
      nationality: _normalizeNationality(r.nationality),
      foreign:     _isForeign(r.nationality),
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

  // 同じ大分類のなかは詳細の並び（LSB → CB → RSB など）
  var list = POSITION_DETAILS[a.position] || [];
  var ad = list.indexOf(_str(a.detail_position));
  var bd = list.indexOf(_str(b.detail_position));
  if (ad === -1) ad = list.length;
  if (bd === -1) bd = list.length;
  if (ad !== bd) return ad - bd;

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

  // シーズンを指定しないと全シーズンの在籍が混ざり、
  // 同じ選手が何度も並ぶ。スカッドは必ず1シーズン分で見るものなので、
  // 指定が無ければ最新シーズンに寄せる
  var seasonId = _str(payload.season_id) || _latestSeasonId();

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
      detail_position:  _str(p.detail_position),
      age:              _num(p.age),
      nationality:      _normalizeNationality(p.nationality),
      foreign:          _isForeign(p.nationality),
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
  var foreignCount = 0;
  squad.forEach(function (s) {
    if (counts.hasOwnProperty(s.position)) counts[s.position]++;
    if (s.foreign) foreignCount++;
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
      foreign_count: foreignCount,
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
  var seasonId = _str(payload.season_id) || _latestSeasonId();

  if (!teamId) {
    return {
      ok: true,
      data: { user: user, team: null, squad: null, budget: null },
    };
  }

  var squadRes = getTeamSquad(token, { team_id: teamId, season_id: seasonId });
  if (!squadRes.ok) return squadRes;

  var budgetRes = getTeamBudget(token, { team_id: teamId, season_id: seasonId });
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

  // 予算はシーズン単位。指定が無ければ最新シーズンに寄せる。
  // 全シーズンを合計すると、繰越と元の残高を二重に数えてしまう
  var seasonId = _str(payload.season_id) || _latestSeasonId();

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
 * payload: { player_id?, name, position, detail_position?, age?, nationality?, real_club?, eligible? }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function upsertPlayer(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var name = _str(payload.name);
  if (!name) return { ok: false, error: "name は必須です。" };

  var pos = _resolvePosition(payload.position, payload.detail_position);
  if (pos.error) return { ok: false, error: pos.error };

  var age = _parseAge(payload.age);
  if (age.error) return { ok: false, error: age.error };

  var row = {
    player_id: _str(payload.player_id),
    name:      name,
    position:  pos.position,
    detail_position: pos.detail,
    age:         age.age,
    nationality: _normalizeNationality(payload.nationality),
    real_club: _str(payload.real_club),
    eligible:  payload.eligible === undefined ? true : _toBool(payload.eligible),
  };

  return withLock(function () {
    if (row.player_id && findRow("Players", "player_id", row.player_id)) {
      updateRow("Players", "player_id", row.player_id, {
        name:      row.name,
        position:  row.position,
        detail_position: row.detail_position,
        age:         row.age,
        nationality: row.nationality,
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
 * 想定ヘッダー: name,position,age,nationality,real_club
 * age / nationality / eligible 列があれば読み取る。
 * 無ければ 年齢0・国籍は日本・eligible=true として登録する。
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
  var iDetail = headers.indexOf("detail_position");
  var iAge = headers.indexOf("age");
  var iNat = headers.indexOf("nationality");
  var iClub = headers.indexOf("real_club");
  var iElig = headers.indexOf("eligible");

  if (iName === -1 || iPos === -1) {
    return { ok: false, error: "CSV ヘッダーに name と position が必要です。" };
  }

  return withLock(function () {
    var existing = {};
    getSheetData("Players").forEach(function (p) {
      existing[_pairKey(p.name, p.position)] = true;
    });

    var toAppend = [];
    var skipped = 0;
    var errors = [];

    for (var i = 1; i < table.length; i++) {
      var line = table[i];
      var name = _str(line[iName]);
      if (!name) continue;

      // position 列に LSB や CMF のような詳細が入っていても受ける。
      // エントリーリストの表記をそのまま貼れるようにするため
      var rawPos = iPos >= 0 ? line[iPos] : "";
      var rawDetail = iDetail >= 0 ? line[iDetail] : "";
      var pos = _resolvePosition(
        _positionOfDetail(rawPos) ? "" : rawPos,
        rawDetail || (_positionOfDetail(rawPos) ? rawPos : "")
      );

      var position = pos.position;
      if (pos.error) {
        errors.push((i + 1) + "行目: " + pos.error);
        continue;
      }

      var key = _pairKey(name, position);
      if (existing[key]) {
        skipped++;
        continue;
      }
      existing[key] = true;

      var age = _parseAge(iAge === -1 ? "" : line[iAge]);
      if (age.error) {
        errors.push((i + 1) + "行目: " + age.error);
        continue;
      }

      toAppend.push({
        player_id: generateId("p_"),
        name:      name,
        position:  position,
        detail_position: pos.detail,
        age:         age.age,
        nationality: _normalizeNationality(iNat === -1 ? "" : line[iNat]),
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

// =============================================================================
// 選手名簿の同期
// =============================================================================

/**
 * 照合用に名前を正規化する。
 *
 * 名簿ごとに「小川 航基」「小川航基」「ヴィッセル」「ビッセル」のような
 * 揺れがあるので、空白・中黒・ヴ を吸収してから比べる。
 *
 * **保存する名前は正規化しない。** ここで作った文字列は照合にだけ使う。
 * 表示は届いた表記のままにする。
 *
 * @param {*} v
 * @returns {string}
 */
function _normalizeName(v) {
  // ヴは後ろの小書き文字とセットで1音になる。
  // 先に「ヴィ→ビ」を処理しないと「ラヴィ」が「ラブィ」になって「ラビ」と揃わない
  return _str(v)
    .replace(/[\s　・．.]/g, "")
    .replace(/ヴァ/g, "バ")
    .replace(/ヴィ/g, "ビ")
    .replace(/ヴェ/g, "ベ")
    .replace(/ヴォ/g, "ボ")
    .replace(/ヴ/g, "ブ");
}

/**
 * eFootball に登録されている選手の名簿で、選手マスタを一括更新する。主催者専用。
 *
 * 何のための機能か
 *   補填の入れ替え候補は「同じ現実クラブの選手」で絞る。
 *   つまり real_club が空のままだと、誰も候補に出てこない。
 *   毎シーズン主催者が作る名簿を、そのまま流し込めるようにする。
 *
 * 名前で照合し、**見つかった選手は年齢・国籍・現実クラブを上書き**する。
 * ポジションは上書きしない。マスタ側はエントリーリストで確認済みの値で、
 * 名簿側より信頼できるため。ただし空欄なら埋める。
 *
 * 見つからなかった選手は新しく作る。誰にも保有されていない選手を
 * マスタに置いておかないと、入れ替えの候補にできない。
 *
 * 同姓同名は実際にいる（千葉と長崎のエドゥアルドなど）。
 * 名前が重なっているときはポジションまで見て見分ける。
 * それでも決められない場合だけ、触らずに報告する。
 *
 * payload: {
 *   players: [{ name, position?, age?, nationality?, real_club }],
 *   create_missing?: boolean  既定 true
 * }
 *
 * @param {string} token
 * @param {Object} payload
 * @returns {{ ok: boolean, data?: Object, error?: string }}
 */
function syncPlayerProfiles(token, payload) {
  var auth = _requireOrganizer(token);
  if (!auth.ok) return auth;

  var list = payload.players || [];
  if (list.length === 0) {
    return { ok: false, error: "選手が1人も指定されていません。" };
  }

  var createMissing = payload.create_missing === undefined
    ? true
    : _toBool(payload.create_missing);

  // 先に全件を検証する。1件でも駄目なら何も書かない
  var parsed = [];
  for (var i = 0; i < list.length; i++) {
    var row = _parseProfileRow(list[i], i);
    if (row.error) return { ok: false, error: row.error };
    parsed.push(row);
  }

  // 名簿の中に同じ名前が複数あるか。
  //
  // 同姓同名は実際にいる（千葉のエドゥアルドと長崎のエドゥアルドなど）。
  // 一律に飛ばすと片方が永久に登録できないので、
  // **名前が重なっているものだけ、ポジションまで見て照合する**。
  var countByName = {};
  parsed.forEach(function (r) {
    countByName[r.key] = (countByName[r.key] || 0) + 1;
  });

  var strict = {};
  var dupInList = [];
  parsed.forEach(function (r) {
    if (countByName[r.key] < 2) return;
    strict[r.key] = true;

    // ポジションが無いと区別のしようがない。この場合だけ諦める
    if (!r.detail && dupInList.indexOf(r.name) === -1) dupInList.push(r.name);
  });

  return withLock(function () {
    var sheet = getSheet("Players");
    var values = sheet.getDataRange().getValues();
    if (values.length < 1) return { ok: false, error: "Players シートが空です。" };

    var headers = values[0].map(function (h) { return _str(h); });
    var col = {};
    ["name", "position", "detail_position", "age", "nationality", "real_club"]
      .forEach(function (k) { col[k] = headers.indexOf(k); });

    if (col.name === -1 || col.real_club === -1) {
      return { ok: false, error: "Players シートに name / real_club の列がありません。" };
    }

    // マスタ側を名前で引けるようにする。同名は行番号を貯めておく
    var rowsByKey = {};
    for (var r = 1; r < values.length; r++) {
      var key = _normalizeName(values[r][col.name]);
      if (!key) continue;
      (rowsByKey[key] = rowsByKey[key] || []).push(r);
    }

    var updated = 0;
    var unchanged = 0;
    var ambiguous = [];
    var toCreate = [];
    var touchedKeys = {};

    parsed.forEach(function (p) {
      if (dupInList.indexOf(p.name) !== -1) return;

      touchedKeys[p.key] = true;
      var hits = rowsByKey[p.key] || [];

      // 名前が重なっているときは、ポジションが一致する行だけを相手にする。
      // 同姓同名の別人を取り違えないため
      if (strict[p.key] || hits.length > 1) {
        hits = hits.filter(function (idx) {
          return _str(values[idx][col.detail_position]) === p.detail;
        });
      }

      if (hits.length === 0) {
        if (createMissing) toCreate.push(p);
        return;
      }

      if (hits.length > 1) {
        ambiguous.push(p.name);
        return;
      }

      var idx = hits[0];
      var changed = false;

      // 年齢・国籍・現実クラブは名簿を正とする
      changed = _setCell(values, idx, col.age, p.age) || changed;
      changed = _setCell(values, idx, col.nationality, p.nationality) || changed;
      changed = _setCell(values, idx, col.real_club, p.real_club) || changed;

      // ポジションは空欄のときだけ埋める。
      // マスタ側はエントリーリストで確認済みの値なので上書きしない
      if (p.detail && col.detail_position !== -1 &&
          !_str(values[idx][col.detail_position])) {
        values[idx][col.detail_position] = p.detail;
        if (col.position !== -1 && !_str(values[idx][col.position])) {
          values[idx][col.position] = p.position;
        }
        changed = true;
      }

      if (changed) updated++; else unchanged++;
    });

    // 名簿に載っていないマスタの選手。
    // GM外へ移った人か、eFootball にまだ登録されていない人。
    // real_club を持たないので入れ替えの候補にはならない
    var masterOnly = [];
    for (var m = 1; m < values.length; m++) {
      var mk = _normalizeName(values[m][col.name]);
      if (!mk || touchedKeys[mk]) continue;
      masterOnly.push(_str(values[m][col.name]));
    }

    if (updated > 0) {
      sheet.getRange(1, 1, values.length, headers.length).setValues(values);
    }

    var created = toCreate.map(function (p) {
      return {
        player_id:       generateId("p_"),
        name:            p.name,
        position:        p.position,
        detail_position: p.detail,
        age:             p.age,
        nationality:     p.nationality,
        real_club:       p.real_club,
        eligible:        true,
      };
    });

    _appendRowsBatch("Players", created);

    return {
      ok: true,
      data: {
        received:      parsed.length,
        updated:       updated,
        unchanged:     unchanged,
        created:       created.length,
        created_names: created.map(function (c) { return c.name; }),
        ambiguous:     ambiguous,
        duplicated_in_list: dupInList,
        master_only:   masterOnly,
      },
    };
  });
}

/**
 * セルに値を入れる。既に同じ値なら何もしない。
 *
 * @param {Array[]} values
 * @param {number} row
 * @param {number} col -1 なら列が無いので何もしない
 * @param {*} value 空なら上書きしない
 * @returns {boolean} 書き換えたか
 */
function _setCell(values, row, col, value) {
  if (col === -1) return false;
  if (value === "" || value === 0 || value === null || value === undefined) return false;
  if (String(values[row][col]) === String(value)) return false;

  values[row][col] = value;
  return true;
}

/**
 * 名簿の1行を検証して整える。
 *
 * @param {Object} raw
 * @param {number} index
 * @returns {Object} error があれば失敗
 */
function _parseProfileRow(raw, index) {
  var no = (index + 1) + "件目";
  var name = _str(raw.name);
  if (!name) return { error: no + ": 選手名が空です。" };

  var age = _parseAge(raw.age);
  if (age.error) return { error: no + "（" + name + "）: " + age.error };

  // ポジションは任意。名簿に無ければ空のままにする
  var position = "";
  var detail = "";
  var rawPos = _str(raw.position);

  if (rawPos) {
    var isDetail = !!_positionOfDetail(rawPos);
    var pos = _resolvePosition(isDetail ? "" : rawPos, isDetail ? rawPos : "");
    if (pos.error) return { error: no + "（" + name + "）: " + pos.error };
    position = pos.position;
    detail = pos.detail;
  }

  return {
    name:        name,
    key:         _normalizeName(name),
    position:    position,
    detail:      detail,
    age:         age.age,
    nationality: _str(raw.nationality),
    real_club:   _str(raw.real_club),
  };
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

/**
 * そのシーズンのそのチームの残高。
 *
 * **シーズンをまたいで合計しない。** 前シーズンぶんは終了処理で
 * 「次シーズンへ繰越」として1本にまとめて入る（api_season.gs）。
 * 合計してしまうと繰越と元の残高が二重に数えられる。
 *
 * @param {string} seasonId
 * @param {string} teamId
 * @returns {number}
 */
function _seasonBalance(seasonId, teamId) {
  var sum = 0;
  getSheetData("BudgetTx").forEach(function (t) {
    if (_str(t.team_id) !== teamId) return;
    if (_str(t.season_id) !== seasonId) return;
    sum += _num(t.amount);
  });
  return sum;
}

/**
 * 一番新しいシーズンの ID。Seasons の最終行を使う。
 *
 * シーズンを指定しない呼び出しの既定値にする。
 * 「どのシーズンか」を決めずにスカッドや順位を出すと、
 * 複数シーズンが混ざって意味の無い数字になる。
 *
 * @returns {string} シーズンが1つも無ければ空文字
 */
function _latestSeasonId() {
  var rows;
  try {
    rows = getSheetData("Seasons").filter(function (s) { return _str(s.season_id); });
  } catch (e) {
    return "";
  }
  return rows.length > 0 ? _str(rows[rows.length - 1].season_id) : "";
}
